// Translate (ShelfState, BuiltQuery, QueryResult) into an ECharts option.
import type { EChartsOption, SeriesOption } from 'echarts'
import type { ColorRule, FieldRef, QueryResult, ReferenceLine, ShelfState, TableCalcSpec } from '@shared/types'
import { TABLE_CALC_LABELS } from '@shared/types'
import { CHART_TYPES, chartTypeApplicable, collectRefs, type BuiltQuery } from '@shared/sqlBuilder'

export const PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#86bcb6', '#d37295', '#fabfd2', '#b6992d', '#499894'
]

const TEXT = '#c9cdd6'
const AXIS_LINE = '#3a3d46'

function fmtDimValue(ref: FieldRef | undefined, v: unknown): string {
  if (v === null || v === undefined) return '(null)'
  const s = String(v)
  if (ref?.dateBin) {
    switch (ref.dateBin) {
      case 'year':
        return s.slice(0, 4)
      case 'quarter': {
        const m = Number(s.slice(5, 7))
        return `${s.slice(0, 4)}-Q${Math.floor((m - 1) / 3) + 1}`
      }
      case 'month':
        return s.slice(0, 7)
      case 'week':
      case 'day':
        return s.slice(0, 10)
      case 'hour':
        return s.slice(0, 13).replace('T', ' ') + 'h'
      case 'minute':
        return s.slice(0, 16).replace('T', ' ')
    }
  }
  return s
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// Math.max(seed, ...arr)/Math.min spreads `arr` as call arguments, which
// throws "Maximum call stack size exceeded" once a result has tens of
// thousands of rows (routine here — the adaptive shelf limit alone is 50k).
// reduce() walks the array without growing the call stack.
function maxOf(seed: number, arr: number[]): number {
  return arr.reduce((a, b) => Math.max(a, b), seed)
}
function minOf(seed: number, arr: number[]): number {
  return arr.reduce((a, b) => Math.min(a, b), seed)
}

/**
 * Table calculation: transforms a plotted series' values in category/axis
 * order (Tableau's "table calculation" concept), computed client-side over
 * the already-aggregated result — no SQL involved.
 */
function applyTableCalc(data: number[], spec: TableCalcSpec): number[] {
  switch (spec.kind) {
    case 'runningTotal': {
      let acc = 0
      return data.map((v) => (acc += v))
    }
    case 'movingAvg': {
      const w = Math.max(1, Math.floor(spec.window ?? 3))
      return data.map((_, i) => {
        const slice = data.slice(Math.max(0, i - w + 1), i + 1)
        return slice.reduce((a, b) => a + b, 0) / slice.length
      })
    }
    case 'percentOfTotal': {
      const total = data.reduce((a, b) => a + b, 0)
      return data.map((v) => (total ? (v / total) * 100 : 0))
    }
    case 'difference':
      return data.map((v, i) => (i === 0 ? 0 : v - data[i - 1]))
    case 'rank': {
      // "1224" competition ranking (ties share a rank, next rank skips ahead)
      const desc = spec.direction !== 'asc'
      const order = data.map((_, i) => i).sort((a, b) => (desc ? data[b] - data[a] : data[a] - data[b]))
      const ranks = new Array(data.length).fill(0)
      let rank = 0
      let prevVal: number | undefined
      order.forEach((idx, pos) => {
        if (prevVal === undefined || data[idx] !== prevVal) rank = pos + 1
        ranks[idx] = rank
        prevVal = data[idx]
      })
      return ranks
    }
  }
}

/** First matching rule wins; rules are pre-filtered to the target measure by the caller. */
function resolveColorRule(rules: ColorRule[], v: number): string | undefined {
  for (const r of rules) {
    const hit =
      r.op === '>' ? v > r.value :
      r.op === '>=' ? v >= r.value :
      r.op === '<' ? v < r.value :
      r.op === '<=' ? v <= r.value :
      r.op === '=' ? v === r.value :
      v !== r.value
    if (hit) return r.color
  }
  return undefined
}

function computeRefValue(kind: 'average' | 'median' | 'min' | 'max', values: number[]): number {
  if (!values.length) return 0
  switch (kind) {
    case 'average':
      return values.reduce((a, b) => a + b, 0) / values.length
    case 'median': {
      const s = [...values].sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
    }
    case 'min':
      return minOf(values[0], values)
    case 'max':
      return maxOf(values[0], values)
  }
}

function refLineLabel(rl: ReferenceLine): string {
  if (rl.label) return rl.label
  switch (rl.kind) {
    case 'average':
      return 'Average'
    case 'median':
      return 'Median'
    case 'min':
      return 'Min'
    case 'max':
      return 'Max'
    case 'constant':
      return `Reference (${rl.value ?? 0})`
  }
}

/** An invisible line series carrying only a markLine — the ECharts idiom for a chart-wide reference line. */
function makeRefLineSeries(rl: ReferenceLine, value: number, horizontal: boolean): SeriesOption {
  const name = refLineLabel(rl)
  return {
    name,
    type: 'line',
    data: [],
    silent: true,
    tooltip: { show: false },
    markLine: {
      symbol: 'none',
      lineStyle: { color: rl.color ?? '#e15759', type: 'dashed', width: 1.5 },
      label: { formatter: `${name}: {c}`, color: TEXT },
      data: [horizontal ? { xAxis: value } : { yAxis: value }]
    }
  } as unknown as SeriesOption
}

/** "2024-05-17…" — the only shape the calendar/time coordinates accept. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/

/**
 * Graceful in-chart notice (title-only option). Used instead of letting an
 * unsatisfiable shelf reach ECharts, where e.g. an invalid calendar range
 * throws deep inside layout and takes the whole renderer down.
 */
function messageOption(text: string, sub?: string): EChartsOption {
  return {
    backgroundColor: 'transparent',
    title: {
      text,
      subtext: sub,
      left: 'center',
      top: 'middle',
      itemGap: 10,
      textStyle: { color: TEXT, fontSize: 14, fontWeight: 500 },
      subtextStyle: { color: '#8b8f9a', fontSize: 12 }
    },
    tooltip: { show: false }
  }
}

/** Compact value-axis labels: 12 345 678 → "12.3M". */
const axisNum = (v: number): string => (Math.abs(v) >= 10_000 ? compactNum(v) : v.toLocaleString())

/** Standard value axis with compact number labels. */
function valueAxis(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'value',
    axisLabel: { color: TEXT, formatter: axisNum },
    splitLine: { lineStyle: { color: AXIS_LINE } },
    ...extra
  }
}

interface Ctx {
  shelf: ShelfState
  built: BuiltQuery
  rows: Array<Record<string, unknown>>
  dims: FieldRef[]
  meas: FieldRef[]
  /** index into dims of the color-shelf dimension, or -1 */
  colorIdx: number
}

function baseOption(): EChartsOption {
  return {
    color: PALETTE,
    backgroundColor: 'transparent',
    textStyle: { color: TEXT },
    animationDuration: 400,
    animationDurationUpdate: 300,
    tooltip: { trigger: 'item', backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' } },
    legend: { textStyle: { color: TEXT }, type: 'scroll', bottom: 0 }
  }
}

function dimKey(ctx: Ctx, row: Record<string, unknown>, indices: number[]): string {
  return indices.map((i) => fmtDimValue(ctx.dims[i], row[ctx.built.dimAliases[i]])).join(' / ')
}

/** Category list in first-appearance order over the given dim indices. */
function extractCategories(
  ctx: Ctx,
  axisDimIdx: number[]
): { categories: string[]; catIndex: Map<string, number> } {
  const categories: string[] = []
  const catIndex = new Map<string, number>()
  for (const row of ctx.rows) {
    const key = axisDimIdx.length ? dimKey(ctx, row, axisDimIdx) : ''
    if (!catIndex.has(key)) {
      catIndex.set(key, categories.length)
      categories.push(key)
    }
  }
  return { categories, catIndex }
}

function buildCartesian(ctx: Ctx): EChartsOption {
  const { shelf, built, rows } = ctx
  const t = shelf.chartType
  const horizontal = t === 'barh' || t === 'stackedBarH' || t === 'percentBarH'
  const stacked =
    t === 'stackedBar' || t === 'stackedBarH' || t === 'percentBar' || t === 'percentBarH' ||
    t === 'stackedArea'
  const percent = t === 'percentBar' || t === 'percentBarH'
  const isLine = t === 'line' || t === 'area' || t === 'stackedArea' || t === 'stepLine' || t === 'smoothLine'
  const seriesType: 'bar' | 'line' = isLine ? 'line' : 'bar'
  const step = t === 'stepLine' ? ('middle' as const) : undefined
  const smooth = t === 'smoothLine' ? true : undefined
  const areaStyle = t === 'area' || t === 'stackedArea' ? {} : undefined

  const axisDimIdx = ctx.dims.map((_, i) => i).filter((i) => i !== ctx.colorIdx)
  const { categories, catIndex } = extractCategories(ctx, axisDimIdx)

  const multiMeas = built.measureAliases.length > 1
  const series: SeriesOption[] = []
  // parallel to `series`: which shelf measure (ctx.meas index) each series plots,
  // so per-measure table calcs / color rules / reference lines can find their data
  const seriesMeasureIdx: number[] = []
  const mkSeries = (name: string, stackKey: string | undefined, data: number[]): SeriesOption =>
    ({
      name,
      type: seriesType,
      stack: stackKey,
      areaStyle,
      step,
      smooth,
      emphasis: { focus: 'series' },
      data
    }) as SeriesOption
  const pushSeries = (mi: number, s: SeriesOption): void => {
    series.push(s)
    seriesMeasureIdx.push(mi)
  }

  if (ctx.colorIdx >= 0) {
    // one series per (color value × measure); with several measures each
    // measure forms its own stack so bars group by measure, segment by color
    built.measureAliases.forEach((alias, mi) => {
      const groups = new Map<string, number[]>()
      for (const row of rows) {
        const cval = fmtDimValue(ctx.dims[ctx.colorIdx], row[built.dimAliases[ctx.colorIdx]])
        if (!groups.has(cval)) groups.set(cval, new Array(categories.length).fill(0))
        const key = axisDimIdx.length ? dimKey(ctx, row, axisDimIdx) : ''
        groups.get(cval)![catIndex.get(key)!] += num(row[alias])
      }
      for (const [cval, data] of groups) {
        pushSeries(
          mi,
          mkSeries(
            multiMeas ? `${cval} · ${built.measureLabels[mi]}` : cval,
            stacked ? (multiMeas ? `m${mi}` : 'total') : undefined,
            data
          )
        )
      }
    })
  } else {
    // one series per measure (Tableau's "Measure Names" behavior)
    built.measureAliases.forEach((alias, mi) => {
      const data = new Array(categories.length).fill(0)
      for (const row of rows) {
        const key = axisDimIdx.length ? dimKey(ctx, row, axisDimIdx) : ''
        data[catIndex.get(key)!] += num(row[alias])
      }
      pushSeries(mi, mkSeries(built.measureLabels[mi], stacked ? 'total' : undefined, data))
    })
  }

  // reference lines are computed from the untransformed per-measure values,
  // before percent-normalization or a table calc mutates series.data below
  const refLineSeries: SeriesOption[] = (shelf.referenceLines ?? []).map((rl) => {
    const mi = rl.measureIdx ?? 0
    const values = series
      .filter((_, i) => seriesMeasureIdx[i] === mi)
      .flatMap((s) => (s.data as number[]) ?? [])
    const value = rl.kind === 'constant' ? (rl.value ?? 0) : computeRefValue(rl.kind, values)
    return makeRefLineSeries(rl, value, horizontal)
  })

  if (percent) {
    // normalize inside each stack group, so measure-grouped stacks each sum to 100%
    const byStack = new Map<string | undefined, SeriesOption[]>()
    for (const s of series) {
      const key = (s as { stack?: string }).stack
      if (!byStack.has(key)) byStack.set(key, [])
      byStack.get(key)!.push(s)
    }
    for (const group of byStack.values()) {
      const totals = new Array(categories.length).fill(0)
      for (const s of group)
        for (let i = 0; i < categories.length; i++) totals[i] += (s.data as number[])[i]
      for (const s of group)
        s.data = (s.data as number[]).map((v, i) => (totals[i] ? +((v / totals[i]) * 100).toFixed(2) : 0))
    }
  }

  // per-measure table calculations, applied per plotted series in category
  // order so a color-grouped series gets its own running total/rank/etc.
  // rather than one shared across every color
  for (const [i, s] of (series as Array<Record<string, unknown>>).entries()) {
    const spec = ctx.meas[seriesMeasureIdx[i]]?.tableCalc
    if (!spec) continue
    s.data = applyTableCalc(s.data as number[], spec)
    s.name = `${s.name as string} (${TABLE_CALC_LABELS[spec.kind]})`
  }

  // conditional formatting: value-based mark colors, evaluated against the
  // final (post-table-calc) value so a rule can target what's actually shown
  if (shelf.colorRules?.length) {
    series.forEach((s, i) => {
      const rules = shelf.colorRules!.filter((r) => r.measureIdx === seriesMeasureIdx[i])
      if (!rules.length) return
      s.data = (s.data as number[]).map((v) => {
        const color = resolveColorRule(rules, v)
        return color ? { value: v, itemStyle: { color } } : v
      }) as unknown as number[]
    })
  }

  series.push(...refLineSeries)

  // large-data rendering (P6): chunked drawing + LTTB sampling for lines
  for (const s of series as Array<Record<string, unknown>>) {
    if (isLine && categories.length > 5000) {
      s.sampling = 'lttb'
      s.progressive = 2000
      s.progressiveThreshold = 5000
    } else if (!isLine && categories.length > 2000) {
      s.progressive = 500
      s.progressiveThreshold = 2000
    }
  }

  // bars keep a sane width on sparse categories
  if (!isLine) for (const s of series as Array<Record<string, unknown>>) s.barMaxWidth = 48

  const catAxis = {
    type: 'category' as const,
    data: categories,
    axisLabel: {
      color: TEXT,
      rotate: categories.length > 12 && !horizontal ? 35 : 0,
      width: 110,
      overflow: 'truncate' as const,
      hideOverlap: true
    },
    axisLine: { lineStyle: { color: AXIS_LINE } }
  }
  const valAxis = {
    type: 'value' as const,
    axisLabel: { color: TEXT, formatter: percent ? '{value}%' : axisNum },
    splitLine: { lineStyle: { color: AXIS_LINE } },
    max: percent ? 100 : undefined
  }
  // zoom controls once the category axis gets crowded
  const manyCats = categories.length > 40
  const dataZoom = manyCats
    ? horizontal
      ? [
          { type: 'inside' as const, yAxisIndex: 0 },
          { type: 'slider' as const, yAxisIndex: 0, width: 16, right: 4, brushSelect: false }
        ]
      : [
          { type: 'inside' as const, xAxisIndex: 0 },
          { type: 'slider' as const, xAxisIndex: 0, height: 16, bottom: series.length > 1 ? 28 : 8, brushSelect: false }
        ]
    : undefined
  return {
    ...baseOption(),
    legend:
      series.length > 1
        ? { textStyle: { color: TEXT }, type: 'scroll', bottom: 0 }
        : { show: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: isLine ? 'line' : 'shadow' },
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      valueFormatter: (v) =>
        typeof v === 'number' ? v.toLocaleString() + (percent ? '%' : '') : String(v ?? '')
    },
    grid: {
      left: 60,
      right: manyCats && horizontal ? 40 : 24,
      top: 24,
      bottom: series.length > 1 || (manyCats && !horizontal) ? 64 : 44,
      containLabel: true
    },
    ...(dataZoom ? { dataZoom } : {}),
    xAxis: horizontal ? valAxis : catAxis,
    yAxis: horizontal ? catAxis : valAxis,
    series
  }
}

function buildScatter(ctx: Ctx): EChartsOption {
  const { built, rows, shelf } = ctx
  const isBubble = shelf.chartType === 'bubble'
  const scatterType = shelf.chartType === 'effectScatter' ? 'effectScatter' : 'scatter'
  const [xA, yA, sA] = built.measureAliases
  const sizeVals = isBubble && sA ? rows.map((r) => num(r[sA])) : []
  const maxSize = maxOf(1, sizeVals)

  const series: SeriesOption[] = []
  if (ctx.colorIdx >= 0) {
    const groups = new Map<string, Array<[number, number, number, string]>>()
    for (const row of rows) {
      const cval = fmtDimValue(ctx.dims[ctx.colorIdx], row[built.dimAliases[ctx.colorIdx]])
      const labelIdx = ctx.dims.map((_, i) => i).filter((i) => i !== ctx.colorIdx)
      const label = labelIdx.length ? dimKey(ctx, row, labelIdx) : cval
      if (!groups.has(cval)) groups.set(cval, [])
      groups.get(cval)!.push([num(row[xA]), num(row[yA]), sA ? num(row[sA]) : 0, label])
    }
    for (const [name, data] of groups)
      series.push({
        name,
        type: scatterType,
        symbolSize: isBubble ? (d: number[]): number => 8 + (d[2] / maxSize) * 42 : 12,
        emphasis: { focus: 'series' },
        data
      } as SeriesOption)
  } else {
    const data = rows.map((row) => {
      const label = ctx.dims.length ? dimKey(ctx, row, ctx.dims.map((_, i) => i)) : ''
      return [num(row[xA]), num(row[yA]), sA ? num(row[sA]) : 0, label]
    })
    series.push({
      type: scatterType,
      symbolSize: isBubble ? (d: number[]): number => 8 + (d[2] / maxSize) * 42 : 12,
      data
    } as SeriesOption)
  }
  // large mode (P6): GPU-friendly path for big point clouds; hover per point is
  // disabled by ECharts in this mode — acceptable at this density
  if (scatterType === 'scatter' && !isBubble) {
    for (const s of series as Array<Record<string, unknown>>) {
      const len = Array.isArray(s.data) ? (s.data as unknown[]).length : 0
      if (len > 2000) {
        s.large = true
        s.largeThreshold = 2000
      }
    }
  }
  return {
    ...baseOption(),
    tooltip: {
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      formatter: (params) => {
        const p = Array.isArray(params) ? params[0] : params
        const d = (p.data ?? []) as [number, number, number, string]
        return `${d[3] ? d[3] + '<br/>' : ''}${built.measureLabels[0]}: ${d[0]}<br/>${built.measureLabels[1]}: ${d[1]}${isBubble ? `<br/>${built.measureLabels[2]}: ${d[2]}` : ''}`
      }
    },
    grid: { left: 60, right: 24, top: 24, bottom: 64, containLabel: true },
    xAxis: valueAxis({ name: built.measureLabels[0] }),
    yAxis: valueAxis({ name: built.measureLabels[1] }),
    series
  }
}

function buildPie(ctx: Ctx): EChartsOption {
  const { shelf, built, rows } = ctx
  const t = shelf.chartType
  const half = t === 'halfDonut'
  const colorRules = shelf.colorRules?.filter((r) => r.measureIdx === 0) ?? []
  const data = rows.map((row) => {
    const value = num(row[built.measureAliases[0]])
    const color = colorRules.length ? resolveColorRule(colorRules, value) : undefined
    return {
      name: fmtDimValue(ctx.dims[0], row[built.dimAliases[0]]),
      value,
      ...(color ? { itemStyle: { color } } : {})
    }
  })
  const radius: string | [string, string] =
    t === 'donut' ? ['42%', '68%'] : half ? ['52%', '84%'] : t === 'rose' ? ['12%', '72%'] : '68%'
  const total = data.reduce((a, d) => a + Math.abs(d.value), 0)
  return {
    ...baseOption(),
    tooltip: {
      trigger: 'item',
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      formatter: (p) => {
        const it = (Array.isArray(p) ? p[0] : p) as { name?: string; value?: number; percent?: number }
        const v = typeof it.value === 'number' ? it.value.toLocaleString() : String(it.value ?? '')
        return `${it.name}: ${v}${it.percent !== undefined ? ` (${it.percent}%)` : ''}`
      }
    },
    series: [
      {
        type: 'pie',
        radius,
        ...(half ? { center: ['50%', '72%'], startAngle: 180, endAngle: 360 } : {}),
        roseType: t === 'rose' ? 'radius' : undefined,
        minShowLabelAngle: 2,
        label: {
          color: TEXT,
          formatter: total > 0 ? '{b}: {d}%' : '{b}',
          overflow: 'truncate' as const,
          width: 130
        },
        itemStyle: { borderColor: '#1e1f24', borderWidth: 1 },
        data
      } as SeriesOption
    ]
  }
}

function buildHeatmap(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const xs: string[] = []
  const ys: string[] = []
  const xi = new Map<string, number>()
  const yi = new Map<string, number>()
  const data: Array<[number, number, number]> = []
  let min = Infinity
  let max = -Infinity
  for (const row of rows) {
    const x = fmtDimValue(ctx.dims[0], row[built.dimAliases[0]])
    const y = fmtDimValue(ctx.dims[1], row[built.dimAliases[1]])
    if (!xi.has(x)) {
      xi.set(x, xs.length)
      xs.push(x)
    }
    if (!yi.has(y)) {
      yi.set(y, ys.length)
      ys.push(y)
    }
    const v = num(row[built.measureAliases[0]])
    min = Math.min(min, v)
    max = Math.max(max, v)
    data.push([xi.get(x)!, yi.get(y)!, v])
  }
  return {
    ...baseOption(),
    grid: { left: 80, right: 24, top: 24, bottom: 90, containLabel: true },
    xAxis: { type: 'category', data: xs, axisLabel: { color: TEXT, rotate: xs.length > 12 ? 35 : 0 } },
    yAxis: { type: 'category', data: ys, axisLabel: { color: TEXT } },
    visualMap: {
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 1,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      textStyle: { color: TEXT },
      inRange: { color: ['#274b6d', '#4e79a7', '#a0cbe8', '#ffbe7d', '#f28e2b', '#e15759'] }
    },
    series: [
      {
        type: 'heatmap',
        data,
        label: { show: data.length <= 200, color: '#fff' },
        ...(data.length > 3000 ? { progressive: 1000, progressiveThreshold: 3000 } : {})
      } as SeriesOption
    ]
  }
}

interface TreeNode {
  name: string
  value?: number
  children?: TreeNode[]
}

function nestRows(ctx: Ctx): TreeNode[] {
  const { built, rows } = ctx
  const root: TreeNode[] = []
  // O(n × depth) lookup keyed by the full path — a per-level name map would
  // wrongly merge equal names under different parents
  const byPath = new Map<string, TreeNode>()
  const last = ctx.dims.length - 1
  for (const row of rows) {
    let path = ''
    let level = root
    for (let i = 0; i <= last; i++) {
      const name = fmtDimValue(ctx.dims[i], row[built.dimAliases[i]])
      path += '\u0000' + name
      let node = byPath.get(path)
      if (!node) {
        node = i === last ? { name } : { name, children: [] }
        byPath.set(path, node)
        level.push(node)
      }
      if (i === last) node.value = (node.value ?? 0) + num(row[built.measureAliases[0]])
      else level = node.children!
    }
  }
  // roll up parent values
  const sum = (nodes: TreeNode[]): number =>
    nodes.reduce((acc, n) => {
      if (n.children) n.value = sum(n.children)
      return acc + (n.value ?? 0)
    }, 0)
  sum(root)
  return root
}

function buildTreemap(ctx: Ctx): EChartsOption {
  return {
    ...baseOption(),
    series: [
      {
        type: 'treemap',
        data: nestRows(ctx),
        leafDepth: ctx.dims.length > 1 ? 1 : undefined,
        label: { color: '#fff' },
        itemStyle: { borderColor: '#1e1f24' },
        breadcrumb: { show: true, bottom: 0 }
      } as SeriesOption
    ]
  }
}

function buildSunburst(ctx: Ctx): EChartsOption {
  return {
    ...baseOption(),
    series: [
      {
        type: 'sunburst',
        data: nestRows(ctx),
        radius: ['8%', '85%'],
        label: { color: '#fff', minAngle: 8 },
        itemStyle: { borderColor: '#1e1f24', borderWidth: 1 }
      } as SeriesOption
    ]
  }
}

function buildSankey(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const nodes = new Set<string>()
  const linkMap = new Map<string, number>()
  for (const row of rows) {
    for (let i = 0; i < ctx.dims.length - 1; i++) {
      const a = `${i}·${fmtDimValue(ctx.dims[i], row[built.dimAliases[i]])}`
      const b = `${i + 1}·${fmtDimValue(ctx.dims[i + 1], row[built.dimAliases[i + 1]])}`
      nodes.add(a)
      nodes.add(b)
      const key = `${a}→${b}`
      linkMap.set(key, (linkMap.get(key) ?? 0) + num(row[built.measureAliases[0]]))
    }
  }
  return {
    ...baseOption(),
    series: [
      {
        type: 'sankey',
        emphasis: { focus: 'adjacency' },
        data: [...nodes].map((n) => ({ name: n })),
        links: [...linkMap.entries()].map(([k, value]) => {
          const [source, target] = k.split('→')
          return { source, target, value }
        }),
        label: { color: TEXT, formatter: (p: { name: string }) => p.name.split('·')[1] },
        lineStyle: { color: 'gradient', curveness: 0.5 }
      } as SeriesOption
    ]
  }
}

function buildFunnel(ctx: Ctx): EChartsOption {
  const { built, rows, shelf } = ctx
  const pyramid = shelf.chartType === 'pyramid'
  const data = rows
    .map((row) => ({
      name: fmtDimValue(ctx.dims[0], row[built.dimAliases[0]]),
      value: num(row[built.measureAliases[0]])
    }))
    .sort((a, b) => b.value - a.value)
  return {
    ...baseOption(),
    series: [
      {
        type: 'funnel',
        sort: pyramid ? 'ascending' : 'descending',
        data,
        label: { color: TEXT },
        gap: 2,
        itemStyle: { borderColor: '#1e1f24' }
      } as SeriesOption
    ]
  }
}

function buildGauge(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  // up to 3 measures become pointers on the same dial
  const values = built.measureAliases.slice(0, 3).map((a) => (rows.length ? num(rows[0][a]) : 0))
  const max = Math.max(...values.map((v) => Math.abs(v) * 1.4), 1)
  const multi = values.length > 1
  return {
    ...baseOption(),
    series: [
      {
        type: 'gauge',
        min: 0,
        max: +max.toPrecision(2),
        progress: { show: !multi },
        detail: multi
          ? { color: TEXT, fontSize: 13, formatter: (v: number) => v.toLocaleString() }
          : { color: TEXT, fontSize: 22, formatter: (v: number) => v.toLocaleString() },
        axisLabel: { color: TEXT },
        title: { color: TEXT },
        data: values.map((v, i) => ({
          value: +v.toFixed(2),
          name: built.measureLabels[i],
          title: multi ? { offsetCenter: ['0%', `${52 + i * 17}%`] } : undefined,
          detail: multi ? { offsetCenter: ['0%', `${62 + i * 17}%`] } : undefined
        }))
      } as SeriesOption
    ]
  }
}

function buildRadar(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const indicators = rows.map((row) => fmtDimValue(ctx.dims[0], row[built.dimAliases[0]]))
  const series = built.measureAliases.map((alias, mi) => ({
    name: built.measureLabels[mi],
    value: rows.map((row) => num(row[alias]))
  }))
  const maxVal = maxOf(1, series.flatMap((s) => s.value))
  return {
    ...baseOption(),
    radar: {
      indicator: indicators.map((name) => ({ name, max: maxVal * 1.1 })),
      axisName: { color: TEXT },
      splitLine: { lineStyle: { color: AXIS_LINE } },
      splitArea: { show: false }
    },
    series: [
      {
        type: 'radar',
        data: series.map((s) => ({ name: s.name, value: s.value, areaStyle: { opacity: 0.15 } }))
      } as SeriesOption
    ]
  }
}

function buildBoxplot(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const categories = rows.map((row) =>
    ctx.dims.length ? dimKey(ctx, row, ctx.dims.map((_, i) => i)) : ''
  )
  const data = rows.map((row) => built.measureAliases.map((a) => num(row[a])))
  return {
    ...baseOption(),
    grid: { left: 60, right: 24, top: 24, bottom: 64, containLabel: true },
    xAxis: { type: 'category', data: categories, axisLabel: { color: TEXT, rotate: categories.length > 10 ? 35 : 0 } },
    yAxis: valueAxis(),
    series: [{ type: 'boxplot', data, itemStyle: { color: '#31445c', borderColor: '#76b7b2' } } as SeriesOption]
  }
}

/** Years drawn at once — more than this and the layout becomes unreadable. */
const CALENDAR_MAX_YEARS = 5

function buildCalendar(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  // Only ISO dates can feed the calendar coordinate: anything else makes
  // ECharts log "Invalid date range." and then crash during layout
  // ("Cannot read properties of undefined (reading 'slice')").
  const data: Array<[string, number]> = []
  for (const row of rows) {
    const s = String(row[built.dimAliases[0]] ?? '')
    if (ISO_DATE_RE.test(s)) data.push([s.slice(0, 10), num(row[built.measureAliases[0]])])
  }
  if (!data.length) {
    return messageOption(
      'Calendar needs day-level dates',
      'Drop a date field (Day bin) as the dimension — the current values are not dates.'
    )
  }
  const allYears = [...new Set(data.map(([d]) => d.slice(0, 4)))].sort()
  const years = allYears.slice(-CALENDAR_MAX_YEARS)
  const shownYears = new Set(years)
  const shown = data.filter(([d]) => shownYears.has(d.slice(0, 4)))
  const values = shown.map(([, v]) => v)
  return {
    ...baseOption(),
    ...(allYears.length > years.length
      ? {
          title: {
            text: `Showing last ${years.length} of ${allYears.length} years`,
            right: 10,
            top: 4,
            textStyle: { color: '#8b8f9a', fontSize: 11, fontWeight: 400 }
          }
        }
      : {}),
    visualMap: {
      min: minOf(0, values),
      max: maxOf(1, values),
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      textStyle: { color: TEXT },
      inRange: { color: ['#22303f', '#4e79a7', '#a0cbe8', '#f28e2b'] }
    },
    calendar: years.map((y, i) => ({
      range: y,
      top: 40 + i * 160,
      cellSize: ['auto', 14],
      dayLabel: { color: TEXT },
      monthLabel: { color: TEXT },
      yearLabel: { color: TEXT },
      itemStyle: { color: '#26282f', borderColor: '#1e1f24' }
    })),
    series: years.map((_, i) => ({
      type: 'heatmap',
      coordinateSystem: 'calendar',
      calendarIndex: i,
      data: shown
    })) as SeriesOption[]
  }
}

function buildCandlestick(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const categories = rows.map((row) => fmtDimValue(ctx.dims[0], row[built.dimAliases[0]]))
  const data = rows.map((row) => built.measureAliases.slice(0, 4).map((a) => num(row[a])))
  return {
    ...baseOption(),
    grid: { left: 60, right: 24, top: 24, bottom: 64, containLabel: true },
    xAxis: { type: 'category', data: categories, axisLabel: { color: TEXT } },
    yAxis: valueAxis({ scale: true }),
    series: [{ type: 'candlestick', data } as SeriesOption]
  }
}

function buildWaterfall(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const categories = rows.map((row) => fmtDimValue(ctx.dims[0], row[built.dimAliases[0]]))
  const values = rows.map((row) => num(row[built.measureAliases[0]]))
  const base: number[] = []
  const rising: Array<number | null> = []
  const falling: Array<number | null> = []
  let cum = 0
  for (const v of values) {
    if (v >= 0) {
      base.push(cum)
      rising.push(v)
      falling.push(null)
    } else {
      base.push(cum + v)
      rising.push(null)
      falling.push(-v)
    }
    cum += v
  }
  categories.push('Total')
  base.push(0)
  if (cum >= 0) {
    rising.push(cum)
    falling.push(null)
  } else {
    rising.push(null)
    falling.push(-cum)
  }
  return {
    ...baseOption(),
    tooltip: {
      trigger: 'axis', backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      formatter: (params) => {
        const ps = Array.isArray(params) ? params : [params]
        const idx = (ps[0] as { dataIndex: number }).dataIndex
        const v = idx < values.length ? values[idx] : cum
        return `${categories[idx]}: ${v.toLocaleString()}`
      }
    },
    grid: { left: 60, right: 24, top: 24, bottom: 64, containLabel: true },
    xAxis: { type: 'category', data: categories, axisLabel: { color: TEXT, rotate: categories.length > 12 ? 35 : 0 } },
    yAxis: valueAxis(),
    series: [
      { type: 'bar', stack: 'wf', itemStyle: { color: 'transparent' }, emphasis: { itemStyle: { color: 'transparent' } }, tooltip: { show: false }, data: base },
      { name: 'Increase', type: 'bar', stack: 'wf', itemStyle: { color: '#59a14f' }, data: rising },
      { name: 'Decrease', type: 'bar', stack: 'wf', itemStyle: { color: '#e15759' }, data: falling }
    ] as SeriesOption[]
  }
}

function buildPareto(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const sorted = [...rows].sort(
    (a, b) => num(b[built.measureAliases[0]]) - num(a[built.measureAliases[0]])
  )
  const categories = sorted.map((row) => fmtDimValue(ctx.dims[0], row[built.dimAliases[0]]))
  const values = sorted.map((row) => num(row[built.measureAliases[0]]))
  const total = values.reduce((a, b) => a + b, 0) || 1
  let cum = 0
  const cumPct = values.map((v) => {
    cum += v
    return +((cum / total) * 100).toFixed(1)
  })
  return {
    ...baseOption(),
    tooltip: { trigger: 'axis', backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' } },
    grid: { left: 60, right: 56, top: 24, bottom: 64, containLabel: true },
    xAxis: { type: 'category', data: categories, axisLabel: { color: TEXT, rotate: categories.length > 12 ? 35 : 0 } },
    yAxis: [
      valueAxis(),
      { type: 'value', max: 100, axisLabel: { color: TEXT, formatter: '{value}%' }, splitLine: { show: false } }
    ],
    series: [
      { name: built.measureLabels[0], type: 'bar', data: values },
      { name: 'Cumulative %', type: 'line', yAxisIndex: 1, symbol: 'circle', itemStyle: { color: '#f28e2b' }, data: cumPct }
    ] as SeriesOption[]
  }
}

function buildThemeRiver(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  // pick the date-ish dim for the time axis, the other becomes the stream
  const timeIdx = ctx.dims.findIndex((d) => d.dateBin) >= 0 ? ctx.dims.findIndex((d) => d.dateBin) : 0
  const catIdx = timeIdx === 0 ? 1 : 0
  // the single time axis chokes on non-dates — keep only parseable rows
  const data: Array<[string, number, string]> = []
  for (const row of rows) {
    const s = String(row[built.dimAliases[timeIdx]] ?? '')
    if (!ISO_DATE_RE.test(s)) continue
    data.push([
      s.slice(0, 10),
      num(row[built.measureAliases[0]]),
      fmtDimValue(ctx.dims[catIdx], row[built.dimAliases[catIdx]])
    ])
  }
  if (!data.length) {
    return messageOption(
      'Theme River needs a date dimension',
      'One of the two dimensions must be a date (use a Day/Month bin).'
    )
  }
  return {
    ...baseOption(),
    singleAxis: { type: 'time', axisLabel: { color: TEXT }, bottom: 50, top: 40 },
    series: [
      { type: 'themeRiver', emphasis: { focus: 'series' }, label: { color: TEXT }, data } as SeriesOption
    ]
  }
}

function buildParallel(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const axes = built.measureAliases.map((alias, i) => ({
    dim: i,
    name: built.measureLabels[i],
    nameTextStyle: { color: TEXT },
    axisLabel: { color: TEXT }
  }))
  const data = rows.map((row) => ({
    name: ctx.dims.length ? dimKey(ctx, row, ctx.dims.map((_, i) => i)) : '',
    value: built.measureAliases.map((a) => num(row[a]))
  }))
  return {
    ...baseOption(),
    parallelAxis: axes,
    parallel: { left: 60, right: 60, top: 40, bottom: 40 },
    tooltip: {
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      formatter: (p) => {
        const item = Array.isArray(p) ? p[0] : p
        const it = item as { name?: string; value?: number[] }
        const lines = (it.value ?? []).map((v, i) => `${built.measureLabels[i]}: ${v.toLocaleString()}`)
        return `${it.name ? it.name + '<br/>' : ''}${lines.join('<br/>')}`
      }
    },
    series: [
      { type: 'parallel', lineStyle: { width: 1.5, opacity: 0.55 }, emphasis: { lineStyle: { width: 3, opacity: 1 } }, data } as SeriesOption
    ]
  }
}

function buildGraph(ctx: Ctx): EChartsOption {
  const { built, rows, shelf } = ctx
  const circular = shelf.chartType === 'graphCircular'
  const weight = new Map<string, number>()
  const links: Array<{ source: string; target: string; value: number }> = []
  for (const row of rows) {
    const a = fmtDimValue(ctx.dims[0], row[built.dimAliases[0]])
    const b = fmtDimValue(ctx.dims[1], row[built.dimAliases[1]])
    const v = num(row[built.measureAliases[0]])
    weight.set(a, (weight.get(a) ?? 0) + v)
    weight.set(b, (weight.get(b) ?? 0) + v)
    links.push({ source: a, target: b, value: v })
  }
  const maxW = maxOf(1, [...weight.values()])
  const nodes = [...weight.entries()].map(([name, w]) => ({
    name,
    value: w,
    symbolSize: 12 + (w / maxW) * 38
  }))
  return {
    ...baseOption(),
    series: [
      {
        type: 'graph',
        layout: circular ? 'circular' : 'force',
        circular: circular ? { rotateLabel: true } : undefined,
        roam: true,
        data: nodes,
        links,
        force: circular ? undefined : { repulsion: 260, edgeLength: [60, 160] },
        label: { show: true, color: TEXT, position: 'right' },
        lineStyle: { color: '#5a5d68', curveness: circular ? 0.3 : 0.15 },
        emphasis: { focus: 'adjacency' }
      } as SeriesOption
    ]
  }
}

function buildTree(ctx: Ctx): EChartsOption {
  const radial = ctx.shelf.chartType === 'treeRadial'
  return {
    ...baseOption(),
    series: [
      {
        type: 'tree',
        data: [{ name: 'All', children: nestRows(ctx) }],
        layout: radial ? 'radial' : 'orthogonal',
        orient: radial ? undefined : 'LR',
        symbolSize: 9,
        initialTreeDepth: 2,
        label: radial
          ? { color: TEXT }
          : { color: TEXT, position: 'left', verticalAlign: 'middle', align: 'right' },
        leaves: radial ? undefined : { label: { position: 'right', align: 'left' } },
        lineStyle: { color: '#5a5d68' },
        expandAndCollapse: true,
        left: radial ? 40 : 80,
        right: radial ? 40 : 140
      } as SeriesOption
    ]
  }
}

// Words placed at once — the layout engine scans the canvas per word, so a
// huge vocabulary is both unreadable and slow; sorting first keeps the most
// significant words when a query returns more than this.
const WORDCLOUD_MAX_WORDS = 300

function buildWordcloud(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const all = rows
    .map((row) => ({
      name: fmtDimValue(ctx.dims[0], row[built.dimAliases[0]]),
      value: num(row[built.measureAliases[0]])
    }))
    .sort((a, b) => b.value - a.value)
  const data = all.slice(0, WORDCLOUD_MAX_WORDS).map((d, i) => ({
    ...d,
    textStyle: { color: PALETTE[i % PALETTE.length] }
  }))
  return {
    ...baseOption(),
    ...(all.length > data.length
      ? {
          title: {
            text: `Showing top ${data.length} of ${all.length} words`,
            right: 10,
            top: 4,
            textStyle: { color: '#8b8f9a', fontSize: 11, fontWeight: 400 }
          }
        }
      : {}),
    series: [
      {
        // provided by the echarts-wordcloud plugin
        type: 'wordCloud',
        shape: 'circle',
        sizeRange: [12, 60],
        rotationRange: [0, 0],
        gridSize: 6,
        drawOutOfBound: false,
        // The plugin's own defaultOption omits this key, so ECharts'
        // `seriesModel.get('layoutAnimation')` returns undefined. The
        // plugin's internal option merge (`if (key in settings)`) then
        // overwrites its *own* `layoutAnimation: true` default with that
        // undefined, which flips it onto a fully-synchronous code path:
        // each word is placed via direct recursion (loop -> loop -> ...)
        // instead of yielding through setTimeout/setImmediate between
        // words. With more than a couple thousand words that recursion
        // overflows the call stack ("Maximum call stack size exceeded"),
        // and it's an *uncaught* throw from inside that deferred callback
        // — outside the try/catch around EChart's setOption call. Setting
        // it explicitly forces the yielding path regardless of word count.
        layoutAnimation: true,
        data
      } as unknown as SeriesOption
    ]
  }
}

function buildMap(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const data = rows.map((row) => ({
    name: fmtDimValue(ctx.dims[0], row[built.dimAliases[0]]),
    value: num(row[built.measureAliases[0]])
  }))
  const values = data.map((d) => d.value)
  return {
    ...baseOption(),
    tooltip: {
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      formatter: (p) => {
        const it = (Array.isArray(p) ? p[0] : p) as { name?: string; value?: number }
        const v = typeof it.value === 'number' && !Number.isNaN(it.value) ? it.value.toLocaleString() : 'no data'
        return `${it.name}: ${v}`
      }
    },
    visualMap: {
      min: minOf(0, values),
      max: maxOf(1, values),
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      textStyle: { color: TEXT },
      inRange: { color: ['#22303f', '#4e79a7', '#a0cbe8', '#f28e2b', '#e15759'] }
    },
    series: [
      {
        // requires echarts.registerMap('world', ...) done at module init
        type: 'map',
        map: 'world',
        roam: true,
        emphasis: { label: { show: true, color: '#fff' } },
        itemStyle: { areaColor: '#2a2c33', borderColor: '#3a3d46' },
        data
      } as SeriesOption
    ]
  }
}

function buildCombo(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const categories: string[] = []
  const catIndex = new Map<string, number>()
  const axisIdx = ctx.dims.map((_, i) => i)
  for (const row of rows) {
    const key = axisIdx.length ? dimKey(ctx, row, axisIdx) : ''
    if (!catIndex.has(key)) {
      catIndex.set(key, categories.length)
      categories.push(key)
    }
  }
  // dual axis is configurable per measure (defaults preserve the original
  // "first measure = bars on axis 1, rest = lines on axis 2" behavior)
  const axisOf = (mi: number): 1 | 2 => ctx.meas[mi]?.axis ?? (mi === 0 ? 1 : 2)
  const typeOf = (mi: number): 'bar' | 'line' => ctx.meas[mi]?.seriesType ?? (mi === 0 ? 'bar' : 'line')
  const series: SeriesOption[] = built.measureAliases.map((alias, mi) => {
    const data = new Array(categories.length).fill(0)
    for (const row of rows) {
      const key = axisIdx.length ? dimKey(ctx, row, axisIdx) : ''
      data[catIndex.get(key)!] += num(row[alias])
    }
    const spec = ctx.meas[mi]?.tableCalc
    const name = spec ? `${built.measureLabels[mi]} (${TABLE_CALC_LABELS[spec.kind]})` : built.measureLabels[mi]
    return {
      name,
      type: typeOf(mi),
      yAxisIndex: axisOf(mi) - 1,
      symbol: 'circle',
      emphasis: { focus: 'series' },
      data: spec ? applyTableCalc(data, spec) : data
    } as SeriesOption
  })
  const axis1Label = built.measureAliases
    .map((_, i) => i)
    .find((i) => axisOf(i) === 1)
  const axis2Label = built.measureAliases
    .map((_, i) => i)
    .find((i) => axisOf(i) === 2)
  return {
    ...baseOption(),
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      valueFormatter: (v) => (typeof v === 'number' ? v.toLocaleString() : String(v ?? ''))
    },
    grid: { left: 60, right: 60, top: 24, bottom: 64, containLabel: true },
    xAxis: { type: 'category', data: categories, axisLabel: { color: TEXT, rotate: categories.length > 12 ? 35 : 0 } },
    yAxis: [
      valueAxis({ name: axis1Label !== undefined ? built.measureLabels[axis1Label] : '' }),
      { type: 'value', name: axis2Label !== undefined ? built.measureLabels[axis2Label] : '', axisLabel: { color: TEXT, formatter: axisNum }, splitLine: { show: false } }
    ],
    series
  }
}

function buildPolarBar(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const categories = rows.map((row) => fmtDimValue(ctx.dims[0], row[built.dimAliases[0]]))
  const values = rows.map((row) => num(row[built.measureAliases[0]]))
  return {
    ...baseOption(),
    polar: { radius: ['16%', '84%'] },
    radiusAxis: { type: 'category', data: categories, axisLabel: { color: TEXT }, axisLine: { lineStyle: { color: AXIS_LINE } } },
    angleAxis: { type: 'value', axisLabel: { color: TEXT, formatter: axisNum }, splitLine: { lineStyle: { color: AXIS_LINE } } },
    tooltip: {
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      formatter: (p) => {
        const it = (Array.isArray(p) ? p[0] : p) as { name?: string; value?: number }
        return `${it.name}: ${typeof it.value === 'number' ? it.value.toLocaleString() : it.value}`
      }
    },
    series: [
      {
        type: 'bar',
        coordinateSystem: 'polar',
        data: values.map((v, i) => ({ name: categories[i], value: v })),
        colorBy: 'data',
        itemStyle: { borderRadius: 3, borderColor: '#1e1f24' },
        label: { show: categories.length <= 14, position: 'start', color: TEXT, formatter: '{b}' }
      } as SeriesOption
    ]
  }
}

function buildLollipop(ctx: Ctx): EChartsOption {
  const { built } = ctx
  const axisDimIdx = ctx.dims.map((_, i) => i)
  const { categories, catIndex } = extractCategories(ctx, axisDimIdx)
  const data = new Array(categories.length).fill(0)
  for (const row of ctx.rows) {
    const key = axisDimIdx.length ? dimKey(ctx, row, axisDimIdx) : ''
    data[catIndex.get(key)!] += num(row[built.measureAliases[0]])
  }
  return {
    ...baseOption(),
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      valueFormatter: (v) => (typeof v === 'number' ? v.toLocaleString() : String(v ?? ''))
    },
    grid: { left: 60, right: 24, top: 24, bottom: 64, containLabel: true },
    xAxis: { type: 'category', data: categories, axisLabel: { color: TEXT, rotate: categories.length > 12 ? 35 : 0 }, axisLine: { lineStyle: { color: AXIS_LINE } } },
    yAxis: valueAxis(),
    series: [
      { name: built.measureLabels[0], type: 'bar', barWidth: 3, itemStyle: { color: '#4e79a7' }, data },
      { name: built.measureLabels[0], type: 'scatter', symbolSize: 13, itemStyle: { color: '#f28e2b' }, tooltip: { show: false }, data }
    ] as SeriesOption[]
  }
}

function buildRangeBar(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const categories = rows.map((row) => dimKey(ctx, row, ctx.dims.map((_, i) => i)))
  const lows = rows.map((row) =>
    Math.min(num(row[built.measureAliases[0]]), num(row[built.measureAliases[1]]))
  )
  const highs = rows.map((row) =>
    Math.max(num(row[built.measureAliases[0]]), num(row[built.measureAliases[1]]))
  )
  const spans = highs.map((h, i) => h - lows[i])
  return {
    ...baseOption(),
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      formatter: (params) => {
        const ps = Array.isArray(params) ? params : [params]
        const idx = (ps[0] as { dataIndex: number }).dataIndex
        return `${categories[idx]}: ${lows[idx].toLocaleString()} → ${highs[idx].toLocaleString()}`
      }
    },
    grid: { left: 60, right: 24, top: 24, bottom: 64, containLabel: true },
    xAxis: { type: 'category', data: categories, axisLabel: { color: TEXT, rotate: categories.length > 12 ? 35 : 0 }, axisLine: { lineStyle: { color: AXIS_LINE } } },
    yAxis: valueAxis({ scale: true }),
    series: [
      { type: 'bar', stack: 'range', itemStyle: { color: 'transparent' }, emphasis: { itemStyle: { color: 'transparent' } }, tooltip: { show: false }, data: lows },
      { name: `${built.measureLabels[0]} → ${built.measureLabels[1]}`, type: 'bar', stack: 'range', itemStyle: { color: '#76b7b2', borderRadius: 3 }, data: spans }
    ] as SeriesOption[]
  }
}

function buildBullet(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const categories = rows.map((row) => fmtDimValue(ctx.dims[0], row[built.dimAliases[0]]))
  const values = rows.map((row) => num(row[built.measureAliases[0]]))
  const targets = rows.map((row) => num(row[built.measureAliases[1]]))
  const hasRange = built.measureAliases.length > 2
  const ranges = hasRange
    ? rows.map((row) => num(row[built.measureAliases[2]]))
    : values.map((v, i) => Math.max(v, targets[i]) * 1.25)
  return {
    ...baseOption(),
    tooltip: {
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      formatter: (p) => {
        const it = (Array.isArray(p) ? p[0] : p) as { dataIndex?: number }
        const i = it.dataIndex ?? 0
        return `${categories[i]}<br/>${built.measureLabels[0]}: ${values[i].toLocaleString()}<br/>${built.measureLabels[1]} (target): ${targets[i].toLocaleString()}`
      }
    },
    grid: { left: 90, right: 30, top: 24, bottom: 40, containLabel: true },
    xAxis: valueAxis(),
    yAxis: { type: 'category', data: categories, axisLabel: { color: TEXT }, axisLine: { lineStyle: { color: AXIS_LINE } } },
    series: [
      { name: 'Range', type: 'bar', barWidth: 18, itemStyle: { color: '#26282f', borderRadius: 3 }, tooltip: { show: false }, data: ranges },
      { name: built.measureLabels[0], type: 'bar', barWidth: 8, barGap: '-72%', itemStyle: { color: '#4e79a7', borderRadius: 3 }, z: 3, data: values },
      { name: built.measureLabels[1], type: 'scatter', symbol: 'rect', symbolSize: [3, 22], itemStyle: { color: '#e15759' }, z: 4, tooltip: { show: false }, data: targets }
    ] as SeriesOption[]
  }
}

/** Human-scale number for KPI cards: 12 345 678 → "12.3M". */
function compactNum(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B'
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M'
  if (a >= 1e4) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K'
  return a >= 100 || Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)
}

function buildKpi(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const values = built.measureAliases.map((a) => (rows.length ? num(rows[0][a]) : 0))
  const n = values.length
  const cols = n <= 2 ? n : n <= 4 ? 2 : 3
  const rowsN = Math.ceil(n / cols)
  return {
    ...baseOption(),
    // title components as big-number cards: plain data, serializes into exports
    title: values.map((v, i) => ({
      text: compactNum(v),
      subtext: built.measureLabels[i],
      left: `${(((i % cols) + 0.5) / cols) * 100}%`,
      top: `${((Math.floor(i / cols) + 0.32) / rowsN) * 100}%`,
      textAlign: 'center' as const,
      textStyle: { color: '#4e79a7', fontSize: n === 1 ? 54 : n <= 4 ? 38 : 30, fontWeight: 700 as const },
      subtextStyle: { color: TEXT, fontSize: n === 1 ? 15 : 12 }
    })),
    tooltip: { show: false }
  }
}

function buildPictorial(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const categories = rows.map((row) => fmtDimValue(ctx.dims[0], row[built.dimAliases[0]]))
  const values = rows.map((row) => num(row[built.measureAliases[0]]))
  return {
    ...baseOption(),
    tooltip: {
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      formatter: (p) => {
        const it = (Array.isArray(p) ? p[0] : p) as { name?: string; value?: number }
        return `${it.name}: ${typeof it.value === 'number' ? it.value.toLocaleString() : it.value}`
      }
    },
    grid: { left: 60, right: 24, top: 24, bottom: 64, containLabel: true },
    xAxis: { type: 'category', data: categories, axisLabel: { color: TEXT, rotate: categories.length > 12 ? 35 : 0 }, axisLine: { lineStyle: { color: AXIS_LINE } } },
    yAxis: valueAxis(),
    series: [
      {
        type: 'pictorialBar',
        symbol: 'roundRect',
        symbolRepeat: true,
        symbolSize: ['62%', 6],
        symbolMargin: 2,
        colorBy: 'data',
        data: values.map((v, i) => ({ name: categories[i], value: v }))
      } as unknown as SeriesOption
    ]
  }
}

/** Shared world-geo base for the coordinate-driven map charts. */
function geoBase(): EChartsOption['geo'] {
  return {
    map: 'world',
    roam: true,
    itemStyle: { areaColor: '#2a2c33', borderColor: '#3a3d46' },
    emphasis: { disabled: true }
  }
}

function buildMapPoints(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const [lngA, latA, sizeA] = built.measureAliases
  const sizes = sizeA ? rows.map((r) => num(r[sizeA])) : []
  const maxSize = maxOf(1, sizes.map(Math.abs))
  const data = rows.map((row) => ({
    name: ctx.dims.length ? dimKey(ctx, row, ctx.dims.map((_, i) => i)) : '',
    value: [num(row[lngA]), num(row[latA]), sizeA ? num(row[sizeA]) : 1]
  }))
  return {
    ...baseOption(),
    geo: geoBase(),
    tooltip: {
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      formatter: (p) => {
        const it = (Array.isArray(p) ? p[0] : p) as { name?: string; value?: number[] }
        const v = it.value ?? []
        const size = sizeA ? `<br/>${built.measureLabels[2]}: ${Number(v[2]).toLocaleString()}` : ''
        return `${it.name ? it.name + '<br/>' : ''}lng ${v[0]}, lat ${v[1]}${size}`
      }
    },
    series: [
      {
        type: 'scatter',
        coordinateSystem: 'geo',
        symbolSize: sizeA
          ? (val: number[]): number => 6 + (Math.abs(val[2]) / maxSize) * 26
          : 9,
        itemStyle: { color: '#f28e2b', opacity: 0.85 },
        label: { show: false },
        data
      } as SeriesOption
    ]
  }
}

function buildMapFlow(ctx: Ctx): EChartsOption {
  const { built, rows } = ctx
  const [lng1, lat1, lng2, lat2, widthA] = built.measureAliases
  const widths = widthA ? rows.map((r) => num(r[widthA])) : []
  const maxW = maxOf(1, widths.map(Math.abs))
  const data = rows.map((row, i) => ({
    name: ctx.dims.length ? dimKey(ctx, row, ctx.dims.map((_, di) => di)) : '',
    coords: [
      [num(row[lng1]), num(row[lat1])],
      [num(row[lng2]), num(row[lat2])]
    ],
    lineStyle: widthA ? { width: 1 + (Math.abs(widths[i]) / maxW) * 5 } : undefined,
    value: widthA ? widths[i] : undefined
  }))
  return {
    ...baseOption(),
    geo: geoBase(),
    tooltip: {
      backgroundColor: '#2a2c33', borderColor: '#444', textStyle: { color: '#eee' },
      formatter: (p) => {
        const it = (Array.isArray(p) ? p[0] : p) as { name?: string; value?: number }
        const v = widthA && typeof it.value === 'number' ? `: ${it.value.toLocaleString()}` : ''
        return `${it.name || 'flow'}${v}`
      }
    },
    series: [
      {
        type: 'lines',
        coordinateSystem: 'geo',
        effect: { show: rows.length <= 500, period: 5, trailLength: 0.25, symbol: 'arrow', symbolSize: 6 },
        lineStyle: { color: '#f28e2b', width: 1.5, opacity: 0.55, curveness: 0.25 },
        data
      } as SeriesOption
    ]
  }
}

function colorDimIndex(shelf: ShelfState, dims: FieldRef[]): number {
  const colorRef = shelf.color
  if (!colorRef || colorRef.role !== 'dimension') return -1
  return dims.findIndex(
    (d) =>
      d.field === colorRef.field &&
      d.dateBin === colorRef.dateBin &&
      d.numBin?.size === colorRef.numBin?.size
  )
}

/** Minimal shape of an ECharts click event that we rely on. */
export interface ChartClickParams {
  name?: string
  seriesName?: string
  dataIndex?: number
  value?: unknown
  treePathInfo?: Array<{ name: string }>
}

/**
 * Map a chart click back to (dimension, raw value) pairs for drill-through.
 * Returns null when the clicked mark cannot be traced to source dimensions.
 */
export function clickToPairs(
  shelf: ShelfState,
  built: BuiltQuery,
  result: QueryResult,
  params: ChartClickParams
): Array<{ ref: FieldRef; value: unknown }> | null {
  const { dims, meas } = collectRefs(shelf)
  if (!dims.length) return null
  const colorIdx = colorDimIndex(shelf, dims)
  const ctx: Ctx = { shelf, built, rows: result.rows, dims, meas, colorIdx }
  const rows = result.rows
  const pairsFromRow = (row: Record<string, unknown>, dimIndices: number[]): Array<{ ref: FieldRef; value: unknown }> =>
    dimIndices.map((i) => ({ ref: dims[i], value: row[built.dimAliases[i]] }))
  const allDims = dims.map((_, i) => i)
  const t = shelf.chartType

  // 1:1 row mapping — datum index is the result row index
  if (
    t === 'heatmap' || t === 'calendar' || t === 'boxplot' || t === 'candlestick' ||
    t === 'mapPoints' || t === 'mapFlow' || t === 'polarBar' || t === 'rangeBar' ||
    t === 'bullet' || t === 'pictorial'
  ) {
    const row = params.dataIndex !== undefined ? rows[params.dataIndex] : undefined
    return row ? pairsFromRow(row, allDims) : null
  }
  if ((t === 'scatter' || t === 'bubble' || t === 'effectScatter') && colorIdx < 0) {
    const row = params.dataIndex !== undefined ? rows[params.dataIndex] : undefined
    return row ? pairsFromRow(row, allDims) : null
  }

  // hierarchy path (treemap/sunburst/tree): match formatted names level by level
  if (t === 'treemap' || t === 'sunburst' || t === 'tree' || t === 'treeRadial') {
    const path = (params.treePathInfo ?? [])
      .map((p) => p.name)
      .filter((n, i) => !(i === 0) && n !== 'All') // drop the series/synthetic root
    if (!path.length) return null
    const depth = Math.min(path.length, dims.length)
    const row = rows.find((r) => {
      for (let i = 0; i < depth; i++) {
        if (fmtDimValue(dims[i], r[built.dimAliases[i]]) !== path[i]) return false
      }
      return true
    })
    return row ? pairsFromRow(row, allDims.slice(0, depth)) : null
  }

  // single-dim name match (pie family, funnel, wordcloud, map)
  if (
    t === 'pie' || t === 'donut' || t === 'halfDonut' || t === 'rose' ||
    t === 'funnel' || t === 'pyramid' || t === 'wordcloud' || t === 'map'
  ) {
    if (params.name === undefined) return null
    const row = rows.find((r) => fmtDimValue(dims[0], r[built.dimAliases[0]]) === params.name)
    return row ? pairsFromRow(row, [0]) : null
  }

  // cartesian family: category label (+ series name when colored)
  const cartesian =
    t === 'bar' || t === 'barh' || t === 'stackedBar' || t === 'stackedBarH' ||
    t === 'percentBar' || t === 'percentBarH' ||
    t === 'line' || t === 'smoothLine' || t === 'area' || t === 'stackedArea' || t === 'stepLine' ||
    t === 'combo' || t === 'pareto' || t === 'waterfall' || t === 'lollipop'
  const colorScatter = (t === 'scatter' || t === 'bubble' || t === 'effectScatter') && colorIdx >= 0
  if (cartesian || colorScatter) {
    // scatter datum labels live in the 4th slot of the value array
    const catName =
      colorScatter && Array.isArray(params.value)
        ? String((params.value as unknown[])[3] ?? '')
        : params.name
    if (catName === undefined && !colorScatter) return null
    const axisIdx = t === 'combo' ? allDims : allDims.filter((i) => i !== colorIdx)
    // multi-measure color series are named "<color> · <measure>" — strip the suffix
    let seriesColor = params.seriesName
    if (seriesColor !== undefined) {
      for (const ml of built.measureLabels) {
        const suffix = ` · ${ml}`
        if (seriesColor.endsWith(suffix)) {
          seriesColor = seriesColor.slice(0, -suffix.length)
          break
        }
      }
    }
    const row = rows.find((r) => {
      const axisOk =
        catName === undefined ||
        (axisIdx.length ? dimKey(ctx, r, axisIdx) === catName : true)
      const colorOk =
        colorIdx < 0 ||
        seriesColor === undefined ||
        fmtDimValue(dims[colorIdx], r[built.dimAliases[colorIdx]]) === seriesColor
      return axisOk && colorOk
    })
    if (!row) return null
    const determined = colorIdx >= 0 && params.seriesName !== undefined ? allDims : axisIdx
    return pairsFromRow(row, determined)
  }

  return null
}

export function buildChartOption(
  shelf: ShelfState,
  built: BuiltQuery,
  result: QueryResult
): EChartsOption | null {
  const { dims, meas } = collectRefs(shelf)
  const colorIdx = colorDimIndex(shelf, dims)
  const ctx: Ctx = { shelf, built, rows: result.rows, dims, meas, colorIdx }

  // A shelf can drift out of a chart's requirements (e.g. the date pill of a
  // calendar is removed): show what is missing instead of feeding builders an
  // impossible state — several ECharts layouts crash rather than degrade.
  if (shelf.chartType !== 'table') {
    const info = CHART_TYPES.find((c) => c.type === shelf.chartType)
    // dims-only shelves get an implicit count(*) measure from buildQuery, and
    // boxplot expands one measure into 5 stats (extra measures are ignored)
    const effMeas = meas.length || Math.min(1, built.measureAliases.length)
    const nMeas = shelf.chartType === 'boxplot' ? Math.min(effMeas, 1) : effMeas
    if (info && !chartTypeApplicable(info, dims.length, nMeas)) {
      return messageOption(
        `${info.label} needs: ${info.hint}`,
        `Current shelf: ${dims.length} dimension(s), ${meas.length} measure(s).`
      )
    }
    if (!result.rows.length) {
      return messageOption('No data', 'The query returned zero rows — check the filters.')
    }
  }

  switch (shelf.chartType) {
    case 'table':
      return null
    case 'bar':
    case 'barh':
    case 'stackedBar':
    case 'stackedBarH':
    case 'percentBar':
    case 'percentBarH':
    case 'line':
    case 'smoothLine':
    case 'area':
    case 'stackedArea':
    case 'stepLine':
      return buildCartesian(ctx)
    case 'scatter':
    case 'bubble':
    case 'effectScatter':
      return buildScatter(ctx)
    case 'pie':
    case 'donut':
    case 'halfDonut':
    case 'rose':
      return buildPie(ctx)
    case 'polarBar':
      return buildPolarBar(ctx)
    case 'lollipop':
      return buildLollipop(ctx)
    case 'rangeBar':
      return buildRangeBar(ctx)
    case 'bullet':
      return buildBullet(ctx)
    case 'kpi':
      return buildKpi(ctx)
    case 'pictorial':
      return buildPictorial(ctx)
    case 'heatmap':
      return buildHeatmap(ctx)
    case 'treemap':
      return buildTreemap(ctx)
    case 'sunburst':
      return buildSunburst(ctx)
    case 'sankey':
      return buildSankey(ctx)
    case 'funnel':
    case 'pyramid':
      return buildFunnel(ctx)
    case 'gauge':
      return buildGauge(ctx)
    case 'radar':
      return buildRadar(ctx)
    case 'boxplot':
      return buildBoxplot(ctx)
    case 'calendar':
      return buildCalendar(ctx)
    case 'candlestick':
      return buildCandlestick(ctx)
    case 'waterfall':
      return buildWaterfall(ctx)
    case 'pareto':
      return buildPareto(ctx)
    case 'themeriver':
      return buildThemeRiver(ctx)
    case 'parallel':
      return buildParallel(ctx)
    case 'graph':
    case 'graphCircular':
      return buildGraph(ctx)
    case 'tree':
    case 'treeRadial':
      return buildTree(ctx)
    case 'wordcloud':
      return buildWordcloud(ctx)
    case 'map':
      return buildMap(ctx)
    case 'mapPoints':
      return buildMapPoints(ctx)
    case 'mapFlow':
      return buildMapFlow(ctx)
    case 'combo':
      return buildCombo(ctx)
  }
}

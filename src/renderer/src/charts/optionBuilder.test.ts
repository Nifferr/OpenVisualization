import { describe, expect, it } from 'vitest'
import { buildChartOption } from './optionBuilder'
import { buildQuery, CHART_TYPES, type BuiltQuery } from '@shared/sqlBuilder'
import type { FieldRef, QueryResult, ShelfState } from '@shared/types'

function shelfFor(
  chartType: ShelfState['chartType'],
  dims: FieldRef[],
  meas: FieldRef[],
  color?: FieldRef
): ShelfState {
  return {
    dataSourceId: 't',
    columns: dims,
    rows: meas,
    color,
    tooltip: [],
    filters: [],
    chartType
  }
}

/** Synthetic result rows keyed by the aliases buildQuery emitted. */
function fakeResult(built: BuiltQuery, dims: FieldRef[], n = 6): QueryResult {
  const rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < n; i++) {
    const row: Record<string, unknown> = {}
    dims.forEach((d, di) => {
      row[built.dimAliases[di]] = d.dateBin
        ? `2024-0${(i % 6) + 1}-0${(i % 8) + 1} 00:00:00`
        : `V${di}_${i % 3}`
    })
    built.measureAliases.forEach((a, mi) => {
      row[a] = (i + 1) * (mi + 1) * 10
    })
    rows.push(row)
  }
  return { columns: [], rows, rowCount: rows.length, sql: '', elapsedMs: 0 }
}

const dim = (i: number, extra: Partial<FieldRef> = {}): FieldRef => ({
  field: `dim${i}`,
  role: 'dimension',
  ...extra
})
const mea = (i: number): FieldRef => ({ field: `val${i}`, role: 'measure', agg: 'sum' })

describe('buildChartOption covers every chart type', () => {
  for (const info of CHART_TYPES) {
    it(`builds a valid option for ${info.type}`, () => {
      const needsDate = info.type === 'calendar' || info.type === 'themeriver'
      const dims = Array.from({ length: info.minDims }, (_, i) =>
        dim(i, needsDate && i === 0 ? { dateBin: 'day' } : {})
      )
      const meas = Array.from({ length: Math.max(info.minMeas, 0) }, (_, i) => mea(i))
      const shelf = shelfFor(info.type, dims, meas)
      const built = buildQuery(shelf, [], 'ds_t')
      const result = fakeResult(built, dims)
      const option = buildChartOption(shelf, built, result)
      if (info.type === 'table') {
        expect(option).toBeNull()
        return
      }
      expect(option, `${info.type} returned null`).not.toBeNull()
      // must serialize cleanly — exports embed the option as JSON
      expect(() => JSON.stringify(option)).not.toThrow()
      if (info.type === 'kpi') {
        expect(Array.isArray(option!.title)).toBe(true)
        expect((option!.title as unknown[]).length).toBe(meas.length)
      } else {
        const series = option!.series
        const list = Array.isArray(series) ? series : [series]
        expect(list.length, `${info.type} has no series`).toBeGreaterThan(0)
      }
    })
  }
})

describe('multi-measure cartesian', () => {
  it('renders one series per measure when no color dimension is set', () => {
    const dims = [dim(0)]
    const meas = [mea(0), mea(1), mea(2)]
    const shelf = shelfFor('bar', dims, meas)
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, fakeResult(built, dims))!
    const series = option.series as Array<{ name: string }>
    expect(series.map((s) => s.name)).toEqual(['SUM(val0)', 'SUM(val1)', 'SUM(val2)'])
  })

  it('crosses color values with measures ("<color> · <measure>") and stacks per measure', () => {
    const color = dim(1)
    const dims = [dim(0)]
    const meas = [mea(0), mea(1)]
    const shelf = shelfFor('stackedBar', dims, meas, color)
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, fakeResult(built, [...dims, color]))!
    const series = option.series as Array<{ name: string; stack?: string }>
    // 3 color values (V1_0..V1_2) × 2 measures
    expect(series).toHaveLength(6)
    expect(series.every((s) => s.name.includes(' · '))).toBe(true)
    expect(new Set(series.map((s) => s.stack))).toEqual(new Set(['m0', 'm1']))
  })

  it('normalizes percent bars within each stack group', () => {
    const color = dim(1)
    const dims = [dim(0)]
    const meas = [mea(0), mea(1)]
    const shelf = shelfFor('percentBar', dims, meas, color)
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, fakeResult(built, [...dims, color], 9))!
    const series = option.series as Array<{ stack?: string; data: number[] }>
    const byStack = new Map<string, number[][]>()
    for (const s of series) {
      if (!byStack.has(s.stack!)) byStack.set(s.stack!, [])
      byStack.get(s.stack!)!.push(s.data)
    }
    for (const dataArrays of byStack.values()) {
      const catCount = dataArrays[0].length
      for (let i = 0; i < catCount; i++) {
        const total = dataArrays.reduce((acc, d) => acc + d[i], 0)
        expect(Math.round(total)).toBeOneOf([100, 0]) // empty categories stay 0
      }
    }
  })

  it('single measure + color keeps plain color-named series (legacy behavior)', () => {
    const color = dim(1)
    const dims = [dim(0)]
    const shelf = shelfFor('bar', dims, [mea(0)], color)
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, fakeResult(built, [...dims, color]))!
    const series = option.series as Array<{ name: string }>
    expect(series.every((s) => !s.name.includes(' · '))).toBe(true)
  })
})

describe('degenerate shelves degrade to a message instead of crashing', () => {
  const titleText = (option: NonNullable<ReturnType<typeof buildChartOption>>): string => {
    const t = option.title
    const first = Array.isArray(t) ? t[0] : t
    return String((first as { text?: string } | undefined)?.text ?? '')
  }

  it('calendar with a non-date dimension returns a notice (was: ECharts crash)', () => {
    const dims = [dim(0)] // plain string values, no dateBin
    const shelf = shelfFor('calendar', dims, [mea(0)])
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, fakeResult(built, dims))!
    expect(option).not.toBeNull()
    // no calendar coordinate may be emitted for garbage ranges
    expect(option.calendar ?? []).toEqual([])
    expect(titleText(option)).toMatch(/date/i)
  })

  it('calendar with valid ISO dates still renders calendars + series', () => {
    const dims = [dim(0, { dateBin: 'day' })]
    const shelf = shelfFor('calendar', dims, [mea(0)])
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, fakeResult(built, dims))!
    expect(Array.isArray(option.calendar)).toBe(true)
    expect((option.calendar as unknown[]).length).toBeGreaterThan(0)
  })

  it('themeriver without parseable dates returns a notice', () => {
    const dims = [dim(0), dim(1)] // neither is a date
    const shelf = shelfFor('themeriver', dims, [mea(0)])
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, fakeResult(built, dims))!
    expect(titleText(option)).toMatch(/date/i)
  })

  it('chart type whose requirements are no longer met explains what is missing', () => {
    // scatter needs 2 measures; leave none (e.g. user removed the pills)
    const dims = [dim(0)]
    const shelf = shelfFor('scatter', dims, [])
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, fakeResult(built, dims))!
    expect(titleText(option)).toMatch(/scatter needs/i)
  })

  it('dims-only bar keeps rendering the implicit count(*) measure', () => {
    const dims = [dim(0)]
    const shelf = shelfFor('bar', dims, [])
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, fakeResult(built, dims))!
    const series = option.series as unknown[]
    expect(Array.isArray(series) ? series.length : 1).toBeGreaterThan(0)
  })

  it('empty result set returns a "no data" notice for non-table charts', () => {
    const dims = [dim(0)]
    const shelf = shelfFor('bar', dims, [mea(0)])
    const built = buildQuery(shelf, [], 'ds_t')
    const empty = { columns: [], rows: [], rowCount: 0, sql: '', elapsedMs: 0 }
    const option = buildChartOption(shelf, built, empty)!
    expect(titleText(option)).toMatch(/no data/i)
  })
})

/** 3 categories (A, B, C) with distinct known measure values, in row order. */
function threeCatResult(built: BuiltQuery, values: number[]): QueryResult {
  const rows = ['A', 'B', 'C'].map((name, i) => ({
    [built.dimAliases[0]]: name,
    [built.measureAliases[0]]: values[i]
  }))
  return { columns: [], rows, rowCount: rows.length, sql: '', elapsedMs: 0 }
}

describe('table calculations', () => {
  it('running total accumulates in category order', () => {
    const dims = [dim(0)]
    const meas = [{ ...mea(0), tableCalc: { kind: 'runningTotal' as const } }]
    const shelf = shelfFor('bar', dims, meas)
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, threeCatResult(built, [10, 20, 30]))!
    const series = option.series as Array<{ data: number[]; name: string }>
    expect(series[0].data).toEqual([10, 30, 60])
    expect(series[0].name).toMatch(/Running Total/)
  })

  it('moving average uses a trailing window', () => {
    const dims = [dim(0)]
    const meas = [{ ...mea(0), tableCalc: { kind: 'movingAvg' as const, window: 2 } }]
    const shelf = shelfFor('bar', dims, meas)
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, threeCatResult(built, [10, 20, 30]))!
    const series = option.series as Array<{ data: number[] }>
    expect(series[0].data).toEqual([10, 15, 25])
  })

  it('percent of total normalizes across the whole series', () => {
    const dims = [dim(0)]
    const meas = [{ ...mea(0), tableCalc: { kind: 'percentOfTotal' as const } }]
    const shelf = shelfFor('bar', dims, meas)
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, threeCatResult(built, [10, 30, 10]))!
    const series = option.series as Array<{ data: number[] }>
    expect(series[0].data).toEqual([20, 60, 20])
  })

  it('difference is the delta from the previous category (0 for the first)', () => {
    const dims = [dim(0)]
    const meas = [{ ...mea(0), tableCalc: { kind: 'difference' as const } }]
    const shelf = shelfFor('bar', dims, meas)
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, threeCatResult(built, [10, 30, 20]))!
    const series = option.series as Array<{ data: number[] }>
    expect(series[0].data).toEqual([0, 20, -10])
  })

  it('rank uses competition ranking, descending by default (highest = 1)', () => {
    const dims = [dim(0)]
    const meas = [{ ...mea(0), tableCalc: { kind: 'rank' as const } }]
    const shelf = shelfFor('bar', dims, meas)
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, threeCatResult(built, [10, 30, 20]))!
    const series = option.series as Array<{ data: number[] }>
    expect(series[0].data).toEqual([3, 1, 2])
  })

  it('rank ascending ranks the lowest value 1', () => {
    const dims = [dim(0)]
    const meas = [{ ...mea(0), tableCalc: { kind: 'rank' as const, direction: 'asc' as const } }]
    const shelf = shelfFor('bar', dims, meas)
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, threeCatResult(built, [10, 30, 20]))!
    const series = option.series as Array<{ data: number[] }>
    expect(series[0].data).toEqual([1, 3, 2])
  })

  it('ties share a rank and the next rank skips ahead (1224 competition ranking)', () => {
    const dims = [dim(0)]
    const meas = [{ ...mea(0), tableCalc: { kind: 'rank' as const } }]
    const shelf = shelfFor('bar', dims, meas)
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, threeCatResult(built, [20, 20, 10]))!
    const series = option.series as Array<{ data: number[] }>
    expect(series[0].data).toEqual([1, 1, 3])
  })
})

describe('reference lines', () => {
  it('adds an average markLine series computed from the raw (untransformed) values', () => {
    const dims = [dim(0)]
    const shelf = shelfFor('bar', dims, [mea(0)])
    shelf.referenceLines = [{ kind: 'average' }]
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, threeCatResult(built, [10, 30, 20]))!
    const series = option.series as Array<{
      name: string
      markLine?: { data: Array<{ yAxis?: number; xAxis?: number }> }
    }>
    const ref = series.find((s) => s.name === 'Average')
    expect(ref).toBeDefined()
    expect(ref!.markLine!.data[0].yAxis).toBe(20)
  })

  it('a constant reference line ignores the underlying data', () => {
    const dims = [dim(0)]
    const shelf = shelfFor('bar', dims, [mea(0)])
    shelf.referenceLines = [{ kind: 'constant', value: 99, label: 'Target' }]
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, threeCatResult(built, [10, 30, 20]))!
    const series = option.series as Array<{ name: string; markLine?: { data: Array<{ yAxis?: number }> } }>
    const ref = series.find((s) => s.name === 'Target')
    expect(ref!.markLine!.data[0].yAxis).toBe(99)
  })

  it('reference lines use the x axis on horizontal bar charts', () => {
    const dims = [dim(0)]
    const shelf = shelfFor('barh', dims, [mea(0)])
    shelf.referenceLines = [{ kind: 'max' }]
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, threeCatResult(built, [10, 30, 20]))!
    const series = option.series as Array<{ name: string; markLine?: { data: Array<{ xAxis?: number }> } }>
    const ref = series.find((s) => s.name === 'Max')
    expect(ref!.markLine!.data[0].xAxis).toBe(30)
  })
})

describe('conditional formatting (color rules)', () => {
  it('colors only the points matching the rule, leaving others as plain numbers', () => {
    const dims = [dim(0)]
    const shelf = shelfFor('bar', dims, [mea(0)])
    shelf.colorRules = [{ measureIdx: 0, op: '>', value: 15, color: '#e15759' }]
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, threeCatResult(built, [10, 30, 20]))!
    const series = option.series as Array<{ data: Array<number | { value: number; itemStyle: { color: string } }> }>
    expect(series[0].data[0]).toBe(10)
    expect(series[0].data[1]).toEqual({ value: 30, itemStyle: { color: '#e15759' } })
    expect(series[0].data[2]).toEqual({ value: 20, itemStyle: { color: '#e15759' } })
  })

  it('colors pie slices individually', () => {
    const dims = [dim(0)]
    const shelf = shelfFor('pie', dims, [mea(0)])
    shelf.colorRules = [{ measureIdx: 0, op: '<', value: 15, color: '#59a14f' }]
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, threeCatResult(built, [10, 30, 20]))!
    const series = option.series as Array<{ data: Array<{ name: string; value: number; itemStyle?: { color: string } }> }>
    expect(series[0].data[0].itemStyle?.color).toBe('#59a14f')
    expect(series[0].data[1].itemStyle).toBeUndefined()
  })
})

describe('combo dual axis (configurable per measure)', () => {
  it('defaults to the legacy first-measure-bars/rest-lines/2-axis split', () => {
    const dims = [dim(0)]
    const shelf = shelfFor('combo', dims, [mea(0), mea(1)])
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, fakeResult(built, dims))!
    const series = option.series as Array<{ type: string; yAxisIndex: number }>
    expect(series[0]).toMatchObject({ type: 'bar', yAxisIndex: 0 })
    expect(series[1]).toMatchObject({ type: 'line', yAxisIndex: 1 })
  })

  it('honors per-measure axis/seriesType overrides', () => {
    const dims = [dim(0)]
    const meas = [
      { ...mea(0), seriesType: 'line' as const, axis: 2 as const },
      { ...mea(1), seriesType: 'line' as const, axis: 2 as const }
    ]
    const shelf = shelfFor('combo', dims, meas)
    const built = buildQuery(shelf, [], 'ds_t')
    const option = buildChartOption(shelf, built, fakeResult(built, dims))!
    const series = option.series as Array<{ type: string; yAxisIndex: number }>
    expect(series[0]).toMatchObject({ type: 'line', yAxisIndex: 1 })
    expect(series[1]).toMatchObject({ type: 'line', yAxisIndex: 1 })
    const yAxis = option.yAxis as Array<{ name?: string }>
    expect(yAxis[0].name).toBe('') // nothing assigned to axis 1
  })
})

describe('large result sets do not overflow the call stack', () => {
  // Math.max(seed, ...arr) spreads `arr` as call arguments; V8 throws
  // "Maximum call stack size exceeded" somewhere past ~65k elements. The
  // adaptive shelf limit alone is 50k rows, and the hard cap is 250k, so
  // any per-row min/max scan must walk the array instead of spreading it.
  const N = 200_000

  it('bubble chart (per-row size scaling)', () => {
    const dims = [dim(0)]
    const meas = [mea(0), mea(1), mea(2)]
    const shelf = shelfFor('bubble', dims, meas)
    const built = buildQuery(shelf, [], 'ds_t')
    expect(() => buildChartOption(shelf, built, fakeResult(built, dims, N))).not.toThrow()
  })

  it('calendar heatmap (per-row visualMap min/max)', () => {
    const dims = [dim(0, { dateBin: 'day' })]
    const shelf = shelfFor('calendar', dims, [mea(0)])
    const built = buildQuery(shelf, [], 'ds_t')
    expect(() => buildChartOption(shelf, built, fakeResult(built, dims, N))).not.toThrow()
  })

  it('choropleth map (per-row visualMap min/max)', () => {
    const dims = [dim(0)]
    const shelf = shelfFor('map', dims, [mea(0)])
    const built = buildQuery(shelf, [], 'ds_t')
    expect(() => buildChartOption(shelf, built, fakeResult(built, dims, N))).not.toThrow()
  })

  it('geo point map (per-row size scaling)', () => {
    const dims = [dim(0)]
    const meas = [mea(0), mea(1), mea(2)]
    const shelf = shelfFor('mapPoints', dims, meas)
    const built = buildQuery(shelf, [], 'ds_t')
    expect(() => buildChartOption(shelf, built, fakeResult(built, dims, N))).not.toThrow()
  })

  it('network graph (unique-node weight map, not spread from rows)', () => {
    const dims = [dim(0), dim(1)]
    const shelf = shelfFor('graph', dims, [mea(0)])
    const built = buildQuery(shelf, [], 'ds_t')
    // high-cardinality node names: fakeResult only cycles 3 distinct values,
    // which would never stress a Map keyed by unique name — build it directly.
    const rows: Array<Record<string, unknown>> = []
    for (let i = 0; i < N; i++) {
      rows.push({
        [built.dimAliases[0]]: `node_a_${i}`,
        [built.dimAliases[1]]: `node_b_${i}`,
        [built.measureAliases[0]]: i + 1
      })
    }
    const result = { columns: [], rows, rowCount: rows.length, sql: '', elapsedMs: 0 }
    expect(() => buildChartOption(shelf, built, result)).not.toThrow()
  })

  it('radar chart (per-row × per-measure value spread)', () => {
    const dims = [dim(0)]
    const meas = [mea(0), mea(1)]
    const shelf = shelfFor('radar', dims, meas)
    const built = buildQuery(shelf, [], 'ds_t')
    expect(() => buildChartOption(shelf, built, fakeResult(built, dims, N))).not.toThrow()
  })

  it('word cloud (caps + sorts a huge vocabulary, forces layoutAnimation on)', () => {
    const dims = [dim(0)]
    const shelf = shelfFor('wordcloud', dims, [mea(0)])
    const built = buildQuery(shelf, [], 'ds_t')
    // distinct word + distinct count per row: fakeResult's 3-value cycle
    // wouldn't stress cardinality or let us check "kept the biggest".
    const rows: Array<Record<string, unknown>> = []
    for (let i = 0; i < N; i++) {
      rows.push({ [built.dimAliases[0]]: `word_${i}`, [built.measureAliases[0]]: i + 1 })
    }
    const result = { columns: [], rows, rowCount: rows.length, sql: '', elapsedMs: 0 }
    const option = buildChartOption(shelf, built, result)
    const series = (
      option!.series as Array<{ layoutAnimation?: boolean; data: Array<{ name: string }> }>
    )[0]
    // Must be explicit true: echarts-wordcloud's own internal default is
    // silently overwritten by `undefined` (from ECharts' seriesModel.get())
    // unless the series sets it itself, which flips the plugin onto a
    // fully-synchronous per-word recursion — see buildWordcloud for why.
    expect(series.layoutAnimation).toBe(true)
    expect(series.data.length).toBeGreaterThan(0)
    expect(series.data.length).toBeLessThan(N)
    expect(series.data[0].name).toBe(`word_${N - 1}`) // highest count kept, not an arbitrary slice
  })
})

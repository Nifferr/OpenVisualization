// Client-side filter + re-aggregation engine for the standalone HTML export.
//
// The exported page has no DuckDB, so charts embed their result at a FINER
// grain than displayed: the shelf's own dimensions PLUS every filter-card
// field on the same data source (appended as tooltip dims at export time).
// When the user changes a filter card in the exported file, this module
// filters those detail rows, re-groups them back to the display grain and
// re-aggregates each measure — then the REAL buildChartOption (bundled into
// the page) rebuilds the ECharts option, so all chart types behave exactly
// like the app.
//
// Only decomposable aggregations survive re-aggregation: sum/count re-sum
// their partials, min/max re-min/max, avg is exported as a hidden sum+count
// pair. Charts using median/quantiles/count-distinct/stddev/variance (or
// boxplot, which expands to quantiles) are exported static instead.
//
// Pure TypeScript (shared module): unit-testable in vitest and bundled into
// the export runtime IIFE.

import type { DashFilterCard, FieldRef, QueryColumn, QueryResult, ShelfState } from './types'
import { collectRefs, refKey, type BuiltQuery } from './sqlBuilder'

/** How one display-grain measure column is rebuilt from detail rows. */
export type ReAgg =
  | { how: 'sum' | 'min' | 'max'; alias: string; src: string }
  | { how: 'avg'; alias: string; sumSrc: string; cntSrc: string }

/** Binds a filter card to the detail-result column carrying its field. */
export interface ExportFilterBinding {
  cardId: string
  alias: string
  mode: 'in' | 'range' | 'dateRange'
}

export interface ChartDetailPayload {
  shelf: ShelfState
  /** aliases/labels of the DISPLAY grain — what buildChartOption consumes */
  built: BuiltQuery
  /** column metadata of the rebuilt result (display-grain aliases) */
  columns: QueryColumn[]
  /** display-grain dim aliases as they appear in the detail rows */
  dimAliases: string[]
  /** detail rows: display dims + filter fields + partial measure columns */
  rows: Array<Record<string, unknown>>
  reaggs: ReAgg[]
  filters: ExportFilterBinding[]
}

/** A filter card's live selection inside the exported page. */
export interface ExportCardState {
  mode: 'in' | 'range' | 'dateRange'
  values?: string[]
  min?: number
  max?: number
  from?: string
  to?: string
}

/** Aggregations that survive client-side re-aggregation (avg via sum+count). */
const DECOMPOSABLE: ReadonlySet<string> = new Set(['sum', 'min', 'max', 'count', 'avg'])

export interface DetailPlan {
  /** display shelf + filter fields as extra tooltip dims + avg helper measures */
  detailShelf: ShelfState
  dimAliases: string[]
  filters: ExportFilterBinding[]
  reaggs: ReAgg[]
}

const measKey = (r: FieldRef): string => `${r.field}|${r.agg ?? 'sum'}`

/**
 * Pure planning half of the detail export: derives the finer-grain shelf and
 * the alias mappings (all of which depend only on shelf structure, never on
 * data). Returns null when the chart cannot be re-filtered client-side —
 * non-decomposable aggregation or boxplot (expands to quantiles).
 */
export function planChartDetail(
  shelf: ShelfState,
  built: BuiltQuery,
  cards: Array<{ cardId: string; card: DashFilterCard }>
): DetailPlan | null {
  if (!cards.length) return null
  if (shelf.chartType === 'boxplot') return null
  const orig = collectRefs(shelf)
  for (const m of orig.meas) {
    const agg = m.field === '*' ? 'count' : (m.agg ?? 'sum')
    if (!DECOMPOSABLE.has(agg)) return null
  }

  const cardRefs: FieldRef[] = cards.map(({ card }) => ({ field: card.field, role: 'dimension' }))
  const avgHelpers: FieldRef[] = []
  for (const m of orig.meas) {
    if (m.field !== '*' && (m.agg ?? 'sum') === 'avg') {
      avgHelpers.push({ field: m.field, role: 'measure', agg: 'sum' })
      avgHelpers.push({ field: m.field, role: 'measure', agg: 'count' })
    }
  }
  const detailShelf: ShelfState = {
    ...shelf,
    tooltip: [...shelf.tooltip, ...cardRefs, ...avgHelpers],
    limit: undefined
  }
  const detail = collectRefs(detailShelf)

  // display dims keep their positions (detail shelf only appends), but map
  // defensively by ref identity
  const dimAliases: string[] = []
  for (const d of orig.dims) {
    const idx = detail.dims.findIndex((x) => refKey(x) === refKey(d))
    if (idx < 0) return null
    dimAliases.push(`d${idx}`)
  }

  const filters: ExportFilterBinding[] = []
  for (const { cardId, card } of cards) {
    const idx = detail.dims.findIndex((x) => x.field === card.field && !x.dateBin && !x.numBin)
    if (idx < 0) continue
    filters.push({ cardId, alias: `d${idx}`, mode: card.mode })
  }
  if (!filters.length) return null

  const reaggs: ReAgg[] = []
  if (orig.meas.length === 0) {
    // dims-only shelves get an implicit count(*) m0 at both grains
    reaggs.push({ how: 'sum', alias: 'm0', src: 'm0' })
  } else {
    for (let i = 0; i < orig.meas.length; i++) {
      const m = orig.meas[i]
      const alias = built.measureAliases[i]
      const agg = m.field === '*' ? 'count' : (m.agg ?? 'sum')
      if (agg === 'avg') {
        const sumIdx = detail.meas.findIndex((x) => measKey(x) === `${m.field}|sum`)
        const cntIdx = detail.meas.findIndex((x) => measKey(x) === `${m.field}|count`)
        if (sumIdx < 0 || cntIdx < 0) return null
        reaggs.push({ how: 'avg', alias, sumSrc: `m${sumIdx}`, cntSrc: `m${cntIdx}` })
      } else {
        const idx = detail.meas.findIndex((x) => measKey(x) === measKey(m))
        if (idx < 0) return null
        // partial counts and partial sums both re-sum; min/max re-min/max
        const how = agg === 'min' || agg === 'max' ? agg : 'sum'
        reaggs.push({ how, alias, src: `m${idx}` })
      }
    }
  }

  return { detailShelf, dimAliases, filters, reaggs }
}

const blankOf = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

function rowPasses(
  row: Record<string, unknown>,
  bindings: ExportFilterBinding[],
  cards: Record<string, ExportCardState>
): boolean {
  for (const b of bindings) {
    const card = cards[b.cardId]
    if (!card) continue
    const v = row[b.alias]
    if (card.mode === 'in') {
      if (!card.values || !card.values.length) continue
      if (!card.values.includes(blankOf(v))) return false
    } else if (card.mode === 'range') {
      const active = card.min !== undefined || card.max !== undefined
      if (!active) continue
      const n = Number(v)
      // SQL comparisons drop NULL/non-numeric rows once a bound is set
      if (v === null || v === undefined || Number.isNaN(n)) return false
      if (card.min !== undefined && n < card.min) return false
      if (card.max !== undefined && n > card.max) return false
    } else {
      if (!card.from && !card.to) continue
      if (v === null || v === undefined) return false
      // ISO-ish timestamps compare correctly as strings at day precision
      const day = String(v).slice(0, 10)
      if (card.from && day < card.from) return false
      if (card.to && day > card.to) return false
    }
  }
  return true
}

interface Acc {
  dims: Record<string, unknown>
  sums: Record<string, number>
  mins: Record<string, number>
  maxs: Record<string, number>
  has: Record<string, boolean>
}

/**
 * Filter the detail rows by the cards' current state and rebuild the
 * display-grain QueryResult that buildChartOption expects.
 */
export function computeFilteredResult(
  payload: ChartDetailPayload,
  cards: Record<string, ExportCardState>
): QueryResult {
  const groups = new Map<string, Acc>()
  for (const row of payload.rows) {
    if (!rowPasses(row, payload.filters, cards)) continue
    const key = JSON.stringify(
      payload.dimAliases.map((a) => (row[a] === null || row[a] === undefined ? null : String(row[a])))
    )
    let acc = groups.get(key)
    if (!acc) {
      const dims: Record<string, unknown> = {}
      for (const a of payload.dimAliases) dims[a] = row[a] ?? null
      acc = { dims, sums: {}, mins: {}, maxs: {}, has: {} }
      groups.set(key, acc)
    }
    for (const r of payload.reaggs) {
      const srcs = r.how === 'avg' ? [r.sumSrc, r.cntSrc] : [r.src]
      for (const src of srcs) {
        const raw = row[src]
        if (raw === null || raw === undefined) continue
        const n = Number(raw)
        if (Number.isNaN(n)) continue
        acc.has[src] = true
        acc.sums[src] = (acc.sums[src] ?? 0) + n
        acc.mins[src] = acc.mins[src] === undefined ? n : Math.min(acc.mins[src], n)
        acc.maxs[src] = acc.maxs[src] === undefined ? n : Math.max(acc.maxs[src], n)
      }
    }
  }

  let rows = [...groups.values()].map((acc) => {
    const out: Record<string, unknown> = { ...acc.dims }
    for (const r of payload.reaggs) {
      if (r.how === 'avg') {
        const cnt = acc.has[r.cntSrc] ? acc.sums[r.cntSrc] : 0
        out[r.alias] = cnt > 0 && acc.has[r.sumSrc] ? acc.sums[r.sumSrc] / cnt : null
      } else if (r.how === 'sum') {
        out[r.alias] = acc.has[r.src] ? acc.sums[r.src] : null
      } else if (r.how === 'min') {
        out[r.alias] = acc.has[r.src] ? acc.mins[r.src] : null
      } else {
        out[r.alias] = acc.has[r.src] ? acc.maxs[r.src] : null
      }
    }
    return out
  })

  // detail rows arrive in the detail query's ORDER BY (display dims first),
  // and first-seen grouping preserves it — only explicit value sorts need a
  // client-side re-sort, because the detail query sorted by the WRONG grain.
  const { dims } = collectRefs(payload.shelf)
  const sortedDim = dims.find((d) => d.sort)
  if (
    (sortedDim?.sort === 'valueAsc' || sortedDim?.sort === 'valueDesc') &&
    payload.built.measureAliases.length
  ) {
    const m = payload.built.measureAliases[0]
    const dir = sortedDim.sort === 'valueAsc' ? 1 : -1
    rows.sort((a, b) => (Number(a[m] ?? 0) - Number(b[m] ?? 0)) * dir)
  }

  if (payload.shelf.limit && rows.length > payload.shelf.limit) {
    rows = rows.slice(0, payload.shelf.limit)
  }

  return {
    columns: payload.columns,
    rows,
    rowCount: rows.length,
    sql: '',
    elapsedMs: 0
  }
}

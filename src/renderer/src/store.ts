import { create } from 'zustand'
import type {
  CalcField,
  DashFilterCard,
  DataSourceDef,
  FieldInfo,
  Filter,
  OpProgress,
  QueryResult,
  ShelfState,
  Workbook,
  Worksheet,
  Dashboard
} from '@shared/types'
import { emptyWorkbook, migrateWorkbook } from '@shared/types'
import {
  buildQuery,
  calcFieldKind,
  dashFiltersFor,
  getAdaptiveLimit,
  type BuiltQuery
} from '@shared/sqlBuilder'
import { api } from './api'

export type PageRef =
  | { kind: 'start' }
  | { kind: 'datasource'; id: string }
  | { kind: 'worksheet'; id: string }
  | { kind: 'dashboard'; id: string }

let idCounter = 0
export function nextId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`
}

export function emptyShelf(dataSourceId: string): ShelfState {
  return {
    dataSourceId,
    rows: [],
    columns: [],
    tooltip: [],
    filters: [],
    chartType: 'bar'
  }
}

interface AppState {
  workbook: Workbook
  workbookPath: string | null
  dirty: boolean
  page: PageRef
  /** field metadata per data source id */
  fields: Record<string, FieldInfo[]>
  rowCounts: Record<string, number>
  /** query results per worksheet id */
  results: Record<string, { result: QueryResult; built: BuiltQuery } | undefined>
  errors: Record<string, string | undefined>
  loading: Record<string, boolean>
  /** live main-process progress per OpProgress.key (entity extraction, email ingest/export) */
  progress: Record<string, OpProgress | undefined>
  status: string
  canUndo: boolean
  canRedo: boolean

  setPage: (page: PageRef) => void
  undo: () => Promise<void>
  redo: () => Promise<void>
  setStatus: (s: string) => void
  addDataSource: (def: DataSourceDef, fields: FieldInfo[], rowCount: number) => void
  /** replace an existing source's def + field list after re-registration (e.g. withRowId) */
  updateDataSource: (def: DataSourceDef, fields: FieldInfo[]) => void
  removeDataSource: (id: string) => Promise<void>
  setFieldRole: (dsId: string, field: string, role: FieldInfo['role']) => void
  addCalcField: (dsId: string, cf: CalcField) => void
  removeCalcField: (dsId: string, name: string) => void
  setCalcFieldKind: (
    dsId: string,
    name: string,
    kind: FieldInfo['kind'] | undefined,
    dateFormat?: string
  ) => void
  setSourceFilters: (dsId: string, filters: Filter[]) => void
  addWorksheet: (dataSourceId: string) => string
  duplicateWorksheet: (id: string) => string
  renameSheet: (id: string, name: string) => void
  removeWorksheet: (id: string) => void
  updateShelf: (worksheetId: string, update: (shelf: ShelfState) => ShelfState) => void
  runWorksheet: (worksheetId: string) => Promise<void>
  addDashboard: () => string
  updateDashboard: (id: string, update: (d: Dashboard) => Dashboard) => void
  removeDashboard: (id: string) => void
  /** re-run every worksheet tile with the dashboard's active filter cards applied */
  runDashboard: (dashId: string) => void
  /** patch a filter card's selection and (debounced) re-run the dashboard */
  setTileFilter: (dashId: string, tileId: string, patch: Partial<DashFilterCard>) => void
  newWorkbook: () => void
  markSaved: (path: string) => void
  loadWorkbook: (wb: Workbook, path: string) => Promise<void>
}

const runTokens: Record<string, number> = {}

// debounce timers per worksheet: rapid shelf edits coalesce into one query (P4)
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const DEBOUNCE_MS = 200

// debounce timers per dashboard: filter-card checkbox bursts coalesce
const dashRunTimers = new Map<string, ReturnType<typeof setTimeout>>()
const DASH_DEBOUNCE_MS = 250

/**
 * `results` key for a worksheet rendered inside a dashboard with active
 * filter cards. Tiles read this key first and fall back to the worksheet's
 * own key, so dashboard filters never leak into the worksheet page.
 */
export function dashResultKey(dashId: string, worksheetId: string): string {
  return `${worksheetId}@dash:${dashId}`
}

// LRU cache of query results keyed by SQL text (P11);
// cleared whenever a data source is (re)registered or removed.
// Budgeted by cells (rows × columns), not entry count: twenty 50k-row results
// used to pin hundreds of MB of the renderer heap and contribute to OOM.
const queryCache = new Map<string, QueryResult>()
const CACHE_MAX_ENTRIES = 30
const CACHE_MAX_CELLS = 2_000_000
let cacheCells = 0

const resultCells = (r: QueryResult): number => r.rowCount * Math.max(1, r.columns.length)

function cacheClear(): void {
  queryCache.clear()
  cacheCells = 0
}

function cacheGet(sql: string): QueryResult | undefined {
  const hit = queryCache.get(sql)
  if (hit) {
    queryCache.delete(sql)
    queryCache.set(sql, hit) // move to most-recent position
  }
  return hit
}

function cachePut(sql: string, result: QueryResult): void {
  const cells = resultCells(result)
  if (cells > CACHE_MAX_CELLS / 2) return // huge results are cheaper to re-run than to pin
  const prev = queryCache.get(sql)
  if (prev) {
    queryCache.delete(sql)
    cacheCells -= resultCells(prev)
  }
  queryCache.set(sql, result)
  cacheCells += cells
  while (queryCache.size > CACHE_MAX_ENTRIES || cacheCells > CACHE_MAX_CELLS) {
    const oldest = queryCache.keys().next().value
    if (oldest === undefined) break
    cacheCells -= resultCells(queryCache.get(oldest)!)
    queryCache.delete(oldest)
  }
}

// ---- undo/redo (Ctrl+Z / Ctrl+Y): snapshot stacks over the persistent slice ----
// Every store mutation is an immutable spread, so a snapshot is just a bundle
// of references (structural sharing) — pushing one is O(1), no deep clone.
interface Snapshot {
  workbook: Workbook
  fields: Record<string, FieldInfo[]>
  rowCounts: Record<string, number>
  page: PageRef
}
const UNDO_LIMIT = 100
// same-tag mutations within this window collapse into one undo step
// (dashboard tile drag/resize emits one updateDashboard per mousemove)
const UNDO_COALESCE_MS = 800
let undoPast: Snapshot[] = []
let undoFuture: Snapshot[] = []
let lastUndoTag = ''
let lastUndoAt = 0
let restoring = false

function takeSnapshot(): Snapshot {
  const s = useApp.getState()
  return { workbook: s.workbook, fields: s.fields, rowCounts: s.rowCounts, page: s.page }
}

/** Record the current (pre-mutation) state as an undo step. Call before mutating. */
function pushUndo(tag: string, coalesce = false): void {
  const now = Date.now()
  if (coalesce && tag === lastUndoTag && now - lastUndoAt < UNDO_COALESCE_MS && undoPast.length) {
    lastUndoAt = now
    return
  }
  lastUndoTag = tag
  lastUndoAt = now
  undoPast.push(takeSnapshot())
  if (undoPast.length > UNDO_LIMIT) undoPast.shift()
  undoFuture = []
  useApp.setState({ canUndo: true, canRedo: false })
}

function clearUndo(): void {
  undoPast = []
  undoFuture = []
  lastUndoTag = ''
  useApp.setState({ canUndo: false, canRedo: false })
}

/** Other data source ids a derived source (join, wordcloud, entities) reads from. */
function dependencyIds(d: DataSourceDef): string[] {
  if (d.kind === 'join') return [d.leftId, d.rightId]
  if (d.kind === 'wordcloud' || d.kind === 'entities') return [d.sourceId]
  return []
}

/**
 * Group data sources into waves safe to register together: a source enters a
 * wave once every dependency is either already placed in an earlier wave or
 * isn't part of this batch at all (already registered elsewhere). Each wave
 * can run in parallel; waves must run in order. Falls back to dumping any
 * leftover sources in one final wave on a cycle (shouldn't happen in practice).
 */
function registrationWaves<T extends DataSourceDef>(defs: T[]): T[][] {
  const waves: T[][] = []
  const placed = new Set<string>()
  let remaining = defs
  while (remaining.length) {
    const ready = remaining.filter((d) =>
      dependencyIds(d).every((id) => placed.has(id) || !remaining.some((r) => r.id === id))
    )
    if (!ready.length) {
      waves.push(remaining)
      break
    }
    for (const d of ready) placed.add(d.id)
    waves.push(ready)
    remaining = remaining.filter((d) => !ready.includes(d))
  }
  return waves
}

/** Sync state back to a snapshot, re-create/drop DuckDB views to match, re-run changed sheets. */
async function restoreSnapshot(snap: Snapshot): Promise<void> {
  const cur = useApp.getState()
  // sheets whose SQL inputs changed need a re-run; unchanged ones keep their results
  const sqlInputs = (wb: Workbook, w: Worksheet): string =>
    JSON.stringify([
      w.shelf,
      wb.calculatedFields[w.shelf.dataSourceId] ?? [],
      wb.sourceFilters[w.shelf.dataSourceId] ?? []
    ])
  const affected = snap.workbook.worksheets.filter((tw) => {
    const cw = cur.workbook.worksheets.find((w) => w.id === tw.id)
    return !cw || sqlInputs(cur.workbook, cw) !== sqlInputs(snap.workbook, tw)
  })
  useApp.setState({
    workbook: snap.workbook,
    fields: snap.fields,
    rowCounts: snap.rowCounts,
    page: snap.page,
    dirty: true,
    canUndo: undoPast.length > 0,
    canRedo: undoFuture.length > 0
  })
  // reconcile DuckDB views: sources only in the snapshot come back, extras go
  const curIds = new Set(cur.workbook.dataSources.map((d) => d.id))
  const snapIds = new Set(snap.workbook.dataSources.map((d) => d.id))
  const toAdd = snap.workbook.dataSources.filter((d) => !curIds.has(d.id))
  const broken: string[] = []
  for (const d of cur.workbook.dataSources.filter((x) => !snapIds.has(x.id))) {
    try {
      await api.removeDataSource(d.id)
    } catch {
      // view already gone — nothing to drop
    }
  }
  // derived sources (joins, wordclouds) select from base views, so bases must register first
  for (const d of registrationWaves(toAdd).flat()) {
    try {
      await api.registerDataSource(d)
    } catch (e) {
      broken.push(`${d.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (broken.length) useApp.setState({ status: `Broken sources: ${broken.join(' | ')}` })
  for (const ws of affected) void useApp.getState().runWorksheet(ws.id)
}

/**
 * Build + run one worksheet's shelf query and store it under `resultKey`.
 * `resultKey === worksheetId` is the plain worksheet run; a dashResultKey
 * carries extra dashboard filter-card clauses merged into the source filters.
 */
async function executeShelfQuery(
  resultKey: string,
  worksheetId: string,
  extraFilters: Filter[]
): Promise<void> {
  const s = useApp.getState()
  const set = useApp.setState
  const sheet = s.workbook.worksheets.find((w) => w.id === worksheetId)
  if (!sheet) return
  const shelf = sheet.shelf
  const hasFields =
    shelf.rows.length ||
    shelf.columns.length ||
    shelf.color ||
    shelf.size ||
    shelf.label ||
    shelf.tooltip.length
  if (!hasFields) {
    set((st) => ({
      results: { ...st.results, [resultKey]: undefined },
      errors: { ...st.errors, [resultKey]: undefined }
    }))
    return
  }
  const calcFields = s.workbook.calculatedFields[shelf.dataSourceId] ?? []
  const fieldKinds: Record<string, FieldInfo['kind']> = {}
  for (const f of s.fields[shelf.dataSourceId] ?? []) fieldKinds[f.name] = f.kind
  for (const c of calcFields) fieldKinds[c.name] = calcFieldKind(c)
  const token = (runTokens[resultKey] ?? 0) + 1
  runTokens[resultKey] = token
  try {
    const sourceFilters = [
      ...(s.workbook.sourceFilters[shelf.dataSourceId] ?? []),
      ...extraFilters
    ]
    const built = buildQuery(shelf, calcFields, `ds_${shelf.dataSourceId}`, {
      defaultLimit: getAdaptiveLimit(s.rowCounts[shelf.dataSourceId] ?? 0),
      sourceFilters,
      fieldKinds
    })
    const cached = cacheGet(built.sql)
    if (cached) {
      set((st) => ({
        results: { ...st.results, [resultKey]: { result: cached, built } },
        errors: { ...st.errors, [resultKey]: undefined },
        loading: { ...st.loading, [resultKey]: false },
        status: `${cached.rowCount.toLocaleString()} rows · cached`
      }))
      return
    }
    set((st) => ({ loading: { ...st.loading, [resultKey]: true } }))
    const result = await api.runQuery(built.sql)
    if (runTokens[resultKey] !== token) return
    cachePut(built.sql, result)
    set((st) => ({
      results: { ...st.results, [resultKey]: { result, built } },
      errors: { ...st.errors, [resultKey]: undefined },
      loading: { ...st.loading, [resultKey]: false },
      status: `${result.rowCount.toLocaleString()} rows · ${result.elapsedMs} ms${result.truncated ? ' · truncated at row cap' : ''}`
    }))
  } catch (e) {
    if (runTokens[resultKey] !== token) return
    set((st) => ({
      errors: {
        ...st.errors,
        [resultKey]: friendlyDbError(e instanceof Error ? e.message : String(e))
      },
      loading: { ...st.loading, [resultKey]: false }
    }))
  }
}

/**
 * Run one worksheet within a dashboard's filter context. With no active
 * cards for its data source, the override entry is dropped so tiles fall
 * back to the worksheet's own result.
 */
async function runDashWorksheet(dashId: string, worksheetId: string): Promise<void> {
  const s = useApp.getState()
  const dash = s.workbook.dashboards.find((d) => d.id === dashId)
  const sheet = s.workbook.worksheets.find((w) => w.id === worksheetId)
  if (!dash || !sheet) return
  const key = dashResultKey(dashId, worksheetId)
  const extra = dashFiltersFor(dash.tiles, sheet.shelf.dataSourceId)
  if (!extra.length) {
    useApp.setState((st) => {
      const results = { ...st.results }
      const errors = { ...st.errors }
      const loading = { ...st.loading }
      delete results[key]
      delete errors[key]
      delete loading[key]
      return { results, errors, loading }
    })
    return
  }
  await executeShelfQuery(key, worksheetId, extra)
}

/** Map raw DuckDB errors to actionable messages; full error goes to the console. */
export function friendlyDbError(raw: string): string {
  // never echo credentials (a failed ATTACH repeats the connString verbatim)
  raw = raw.replace(/\b(password|passwd|pwd)=[^\s'"]+/gi, '$1=***')
  console.error('[query error]', raw)
  let m = raw.match(/No function matches the given name and argument types '(\w+)\((\w+)/i)
  if (m) {
    const [, fn, type] = m
    const t = type.toUpperCase() === 'VARCHAR' ? 'Text' : type
    return `The aggregation ${fn.toUpperCase()} cannot be applied to a ${t} field. Change the field's role or pick a compatible aggregation (Count, Count Distinct, Min, Max) — or create a calculated field that converts it to a number.`
  }
  m = raw.match(/Could not convert string ['"](.{0,60}?)['"] to (\w+)/i)
  if (m) {
    return `The value "${m[1]}" could not be converted to ${m[2]}. The column mixes types — adjust the field type or clean the data with a dataset filter.`
  }
  m = raw.match(/Referenced column "(.+?)" not found/i)
  if (m) {
    return `The field "${m[1]}" no longer exists in this data source. Remove it from the shelves, filters or calculated fields.`
  }
  m = raw.match(/(?:Binder Error|Conversion Error|Invalid Input Error|Parser Error):\s*([\s\S]+)/)
  if (m) return m[1].split('\n')[0]
  return raw
}

export const useApp = create<AppState>((set, get) => ({
  workbook: emptyWorkbook(),
  workbookPath: null,
  dirty: false,
  page: { kind: 'start' },
  fields: {},
  rowCounts: {},
  results: {},
  errors: {},
  loading: {},
  progress: {},
  status: 'Ready',
  canUndo: false,
  canRedo: false,

  setPage: (page) => set({ page }),
  setStatus: (status) => set({ status }),

  undo: async () => {
    if (restoring) return
    const snap = undoPast.pop()
    if (!snap) return
    undoFuture.push(takeSnapshot())
    lastUndoTag = ''
    restoring = true
    try {
      await restoreSnapshot(snap)
    } finally {
      restoring = false
    }
  },

  redo: async () => {
    if (restoring) return
    const snap = undoFuture.pop()
    if (!snap) return
    undoPast.push(takeSnapshot())
    lastUndoTag = ''
    restoring = true
    try {
      await restoreSnapshot(snap)
    } finally {
      restoring = false
    }
  },

  addDataSource: (def, fields, rowCount) => {
    pushUndo('ds:add')
    set((s) => ({
      workbook: { ...s.workbook, dataSources: [...s.workbook.dataSources, def] },
      fields: { ...s.fields, [def.id]: fields },
      rowCounts: { ...s.rowCounts, [def.id]: rowCount },
      dirty: true,
      page: { kind: 'datasource', id: def.id }
    }))
  },

  updateDataSource: (def, fields) => {
    pushUndo('ds:update')
    set((s) => {
      // keep roles the user already flipped on surviving fields
      const prevRoles = new Map((s.fields[def.id] ?? []).map((f) => [f.name, f.role]))
      return {
        workbook: {
          ...s.workbook,
          dataSources: s.workbook.dataSources.map((d) => (d.id === def.id ? def : d))
        },
        fields: {
          ...s.fields,
          [def.id]: fields.map((f) => {
            const role = prevRoles.get(f.name)
            return role && role !== f.role ? { ...f, role } : f
          })
        },
        dirty: true
      }
    })
  },

  removeDataSource: async (id) => {
    pushUndo('ds:remove')
    // cascade: joins/wordclouds built on top of this source go too
    const all = get().workbook.dataSources
    const doomed = new Set([id])
    let grew = true
    while (grew) {
      grew = false
      for (const d of all) {
        if (doomed.has(d.id)) continue
        const dependsOnDoomed = dependencyIds(d).some((depId) => doomed.has(depId))
        if (dependsOnDoomed) {
          doomed.add(d.id)
          grew = true
        }
      }
    }
    for (const dsId of doomed) await api.removeDataSource(dsId)
    cacheClear()
    set((s) => {
      const fields = { ...s.fields }
      const rowCounts = { ...s.rowCounts }
      const sourceFilters = { ...s.workbook.sourceFilters }
      for (const dsId of doomed) {
        delete fields[dsId]
        delete rowCounts[dsId]
        delete sourceFilters[dsId]
      }
      return {
        workbook: {
          ...s.workbook,
          dataSources: s.workbook.dataSources.filter((d) => !doomed.has(d.id)),
          worksheets: s.workbook.worksheets.filter((w) => !doomed.has(w.shelf.dataSourceId)),
          sourceFilters
        },
        fields,
        rowCounts,
        dirty: true,
        page: { kind: 'start' }
      }
    })
  },

  setFieldRole: (dsId, field, role) => {
    pushUndo('role')
    set((s) => ({
      fields: {
        ...s.fields,
        [dsId]: (s.fields[dsId] ?? []).map((f) => (f.name === field ? { ...f, role } : f))
      },
      workbook: {
        ...s.workbook,
        fieldOverrides: {
          ...s.workbook.fieldOverrides,
          [dsId]: { ...(s.workbook.fieldOverrides[dsId] ?? {}), [field]: { role } }
        }
      },
      dirty: true
    }))
  },

  addCalcField: (dsId, cf) => {
    // coalesce: the derived-date generator adds many fields in one gesture
    pushUndo('calc:add', true)
    set((s) => ({
      workbook: {
        ...s.workbook,
        calculatedFields: {
          ...s.workbook.calculatedFields,
          [dsId]: [...(s.workbook.calculatedFields[dsId] ?? []).filter((c) => c.name !== cf.name), cf]
        }
      },
      dirty: true
    }))
  },

  removeCalcField: (dsId, name) => {
    pushUndo('calc')
    set((s) => ({
      workbook: {
        ...s.workbook,
        calculatedFields: {
          ...s.workbook.calculatedFields,
          [dsId]: (s.workbook.calculatedFields[dsId] ?? []).filter((c) => c.name !== name)
        }
      },
      dirty: true
    }))
  },

  setCalcFieldKind: (dsId, name, kind, dateFormat) => {
    pushUndo('calc:kind')
    set((s) => ({
      workbook: {
        ...s.workbook,
        calculatedFields: {
          ...s.workbook.calculatedFields,
          [dsId]: (s.workbook.calculatedFields[dsId] ?? []).map((c) => {
            if (c.name !== name) return c
            // always start from a clean slate: a kind switch away from 'date'
            // (or back to it) must not resurrect a stale format string
            const { kind: _k, dateFormat: _f, ...bare } = c
            if (kind === undefined) return bare
            return kind === 'date' && dateFormat ? { ...bare, kind, dateFormat } : { ...bare, kind }
          })
        }
      },
      dirty: true
    }))
    // the field's SQL cast changed — every worksheet on this source must re-query
    for (const ws of get().workbook.worksheets) {
      if (ws.shelf.dataSourceId === dsId) void get().runWorksheet(ws.id)
    }
  },

  setSourceFilters: (dsId, filters) => {
    pushUndo('srcfilter')
    set((s) => ({
      workbook: {
        ...s.workbook,
        sourceFilters: { ...s.workbook.sourceFilters, [dsId]: filters }
      },
      dirty: true
    }))
    // filters change the generated SQL for every worksheet on this source
    for (const ws of get().workbook.worksheets) {
      if (ws.shelf.dataSourceId === dsId) void get().runWorksheet(ws.id)
    }
  },

  addWorksheet: (dataSourceId) => {
    pushUndo('ws:add')
    const id = nextId('ws_')
    const n = get().workbook.worksheets.length + 1
    const sheet: Worksheet = { id, name: `Sheet ${n}`, shelf: emptyShelf(dataSourceId) }
    set((s) => ({
      workbook: { ...s.workbook, worksheets: [...s.workbook.worksheets, sheet] },
      dirty: true,
      page: { kind: 'worksheet', id }
    }))
    return id
  },

  duplicateWorksheet: (id) => {
    const src = get().workbook.worksheets.find((w) => w.id === id)
    if (!src) return ''
    pushUndo('ws:dup')
    const newId = nextId('ws_')
    const copy: Worksheet = {
      ...src,
      id: newId,
      name: `${src.name} (copy)`,
      shelf: JSON.parse(JSON.stringify(src.shelf)) as ShelfState
    }
    set((s) => ({
      workbook: { ...s.workbook, worksheets: [...s.workbook.worksheets, copy] },
      dirty: true,
      page: { kind: 'worksheet', id: newId }
    }))
    void get().runWorksheet(newId)
    return newId
  },

  renameSheet: (id, name) => {
    // coalesce: Enter + blur both commit the rename box
    pushUndo('rename', true)
    set((s) => ({
      workbook: {
        ...s.workbook,
        worksheets: s.workbook.worksheets.map((w) => (w.id === id ? { ...w, name } : w)),
        dashboards: s.workbook.dashboards.map((d) => (d.id === id ? { ...d, name } : d))
      },
      dirty: true
    }))
  },

  removeWorksheet: (id) => {
    pushUndo('ws:remove')
    set((s) => ({
      workbook: {
        ...s.workbook,
        worksheets: s.workbook.worksheets.filter((w) => w.id !== id),
        dashboards: s.workbook.dashboards.map((d) => ({
          ...d,
          tiles: d.tiles.filter((t) => t.worksheetId !== id)
        }))
      },
      dirty: true,
      page: { kind: 'start' }
    }))
  },

  updateShelf: (worksheetId, update) => {
    pushUndo(`shelf:${worksheetId}`)
    set((s) => ({
      workbook: {
        ...s.workbook,
        worksheets: s.workbook.worksheets.map((w) =>
          w.id === worksheetId ? { ...w, shelf: update(w.shelf) } : w
        )
      },
      dirty: true
    }))
    // debounce: rapid consecutive shelf edits (drag, multi-pill drops) run once
    const existing = debounceTimers.get(worksheetId)
    if (existing) clearTimeout(existing)
    debounceTimers.set(
      worksheetId,
      setTimeout(() => {
        debounceTimers.delete(worksheetId)
        void get().runWorksheet(worksheetId)
      }, DEBOUNCE_MS)
    )
  },

  runWorksheet: async (worksheetId) => {
    // direct calls flush any pending debounced run
    const pending = debounceTimers.get(worksheetId)
    if (pending) {
      clearTimeout(pending)
      debounceTimers.delete(worksheetId)
    }
    await executeShelfQuery(worksheetId, worksheetId, [])
  },

  addDashboard: () => {
    pushUndo('db:add')
    const id = nextId('db_')
    const n = get().workbook.dashboards.length + 1
    set((s) => ({
      workbook: {
        ...s.workbook,
        dashboards: [...s.workbook.dashboards, { id, name: `Dashboard ${n}`, tiles: [] }]
      },
      dirty: true,
      page: { kind: 'dashboard', id }
    }))
    return id
  },

  updateDashboard: (id, update) => {
    // coalesce: tile drag/resize fires one update per mousemove
    pushUndo(`dash:${id}`, true)
    set((s) => ({
      workbook: {
        ...s.workbook,
        dashboards: s.workbook.dashboards.map((d) => (d.id === id ? update(d) : d))
      },
      dirty: true
    }))
  },

  removeDashboard: (id) => {
    pushUndo('db:remove')
    set((s) => ({
      workbook: { ...s.workbook, dashboards: s.workbook.dashboards.filter((d) => d.id !== id) },
      dirty: true,
      page: { kind: 'start' }
    }))
  },

  runDashboard: (dashId) => {
    const dash = get().workbook.dashboards.find((d) => d.id === dashId)
    if (!dash) return
    const wsIds = new Set(
      dash.tiles.map((t) => t.worksheetId).filter((id): id is string => !!id)
    )
    for (const wsId of wsIds) void runDashWorksheet(dashId, wsId)
  },

  setTileFilter: (dashId, tileId, patch) => {
    get().updateDashboard(dashId, (d) => ({
      ...d,
      tiles: d.tiles.map((t) =>
        t.id === tileId && t.filter ? { ...t, filter: { ...t.filter, ...patch } } : t
      )
    }))
    const existing = dashRunTimers.get(dashId)
    if (existing) clearTimeout(existing)
    dashRunTimers.set(
      dashId,
      setTimeout(() => {
        dashRunTimers.delete(dashId)
        get().runDashboard(dashId)
      }, DASH_DEBOUNCE_MS)
    )
  },

  newWorkbook: () => {
    cacheClear()
    clearUndo()
    set({
      workbook: emptyWorkbook(),
      workbookPath: null,
      dirty: false,
      page: { kind: 'start' },
      fields: {},
      rowCounts: {},
      results: {},
      errors: {},
      loading: {}
    })
  },

  markSaved: (path) =>
    set((s) => ({
      workbookPath: path,
      dirty: false,
      workbook: { ...s.workbook, meta: { ...s.workbook.meta, modifiedAt: new Date().toISOString() } }
    })),

  loadWorkbook: async (wbRaw, path) => {
    const wb = migrateWorkbook(wbRaw)
    cacheClear()
    clearUndo()
    // re-register every data source so DuckDB views exist again
    const fields: Record<string, FieldInfo[]> = {}
    const rowCounts: Record<string, number> = {}
    const broken: string[] = []
    const registerOne = async (def: DataSourceDef): Promise<void> => {
      try {
        const desc = await api.registerDataSource(def)
        const overrides = wb.fieldOverrides[def.id] ?? {}
        fields[def.id] = desc.fields.map((f) =>
          overrides[f.name]?.role ? { ...f, role: overrides[f.name].role! } : f
        )
        rowCounts[def.id] = desc.rowCount
      } catch (e) {
        broken.push(`${def.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // independent sources load in parallel per wave; derived sources wait for their dependencies
    for (const wave of registrationWaves(wb.dataSources)) await Promise.all(wave.map(registerOne))
    set({
      workbook: wb,
      workbookPath: path,
      dirty: false,
      fields,
      rowCounts,
      results: {},
      errors: {},
      loading: {},
      page: wb.worksheets.length
        ? { kind: 'worksheet', id: wb.worksheets[0].id }
        : { kind: 'start' },
      status: broken.length ? `Broken sources: ${broken.join(' | ')}` : 'Workbook loaded'
    })
    for (const ws of wb.worksheets) void useApp.getState().runWorksheet(ws.id)
  }
}))

// Main-process progress pushes (entity extraction, e-mail ingest/export) land
// in `progress` keyed by OpProgress.key. Module-level subscription: exactly
// one listener for the app's lifetime (guarded for vitest, where there is no
// preload bridge).
if (typeof window !== 'undefined' && (window as { api?: { onProgress?: unknown } }).api?.onProgress) {
  api.onProgress((p) => {
    useApp.setState((s) => {
      const progress = { ...s.progress }
      if (p.done) delete progress[p.key]
      else progress[p.key] = p
      return { progress }
    })
  })
}

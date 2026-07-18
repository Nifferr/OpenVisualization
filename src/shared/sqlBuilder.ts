// Pure translation of ShelfState -> DuckDB SQL. No side effects, no I/O.

import type {
  Agg,
  CalcField,
  ChartType,
  DashFilterCard,
  DataSourceDef,
  FieldInfo,
  FieldRef,
  Filter,
  ShelfState
} from './types'
import {
  emailCategoryExpr,
  emailDomainExpr,
  emailLocationExpr,
  emailOrgExpr,
  emailOrgTypeExpr,
  emailTLDOf,
  emailUserExpr
} from './emailEnrichment'

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

export function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

function aggExpr(agg: Agg, inner: string): string {
  switch (agg) {
    case 'sum':
      return `sum(${inner})`
    case 'avg':
      return `avg(${inner})`
    case 'min':
      return `min(${inner})`
    case 'max':
      return `max(${inner})`
    case 'count':
      return inner === '*' ? 'count(*)' : `count(${inner})`
    case 'count_distinct':
      return `count(DISTINCT ${inner})`
    case 'median':
      return `median(${inner})`
    case 'p10':
      return `quantile_cont(${inner}, 0.10)`
    case 'p25':
      return `quantile_cont(${inner}, 0.25)`
    case 'p75':
      return `quantile_cont(${inner}, 0.75)`
    case 'p90':
      return `quantile_cont(${inner}, 0.90)`
    case 'p95':
      return `quantile_cont(${inner}, 0.95)`
    case 'stddev':
      return `stddev_samp(${inner})`
    case 'variance':
      return `var_samp(${inner})`
  }
}

function dimExpr(ref: FieldRef, kinds?: Record<string, FieldInfo['kind']>): string {
  let expr = ref.field === '*' ? '*' : quoteIdent(ref.field)
  if (ref.dateBin) {
    // TRY_CAST: one unparseable value becomes a NULL group instead of failing the query
    expr = `date_trunc('${ref.dateBin}', TRY_CAST(${expr} AS TIMESTAMP))`
  } else if (ref.numBin && ref.numBin.size > 0) {
    const kind = kinds?.[ref.field]
    if (kind !== undefined && kind !== 'number') expr = `TRY_CAST(${expr} AS DOUBLE)`
    expr = `floor(${expr} / ${ref.numBin.size}) * ${ref.numBin.size}`
  }
  return expr
}

/** Aggregations that only make sense over numeric input. */
export const NUMERIC_AGGS: ReadonlySet<Agg> = new Set([
  'sum', 'avg', 'median', 'p10', 'p25', 'p75', 'p90', 'p95', 'stddev', 'variance'
])

/** DuckDB cast target for each user-selectable calc-field kind override. */
const CALC_KIND_SQL_TYPE: Partial<Record<FieldInfo['kind'], string>> = {
  string: 'VARCHAR',
  number: 'DOUBLE',
  date: 'TIMESTAMP',
  bool: 'BOOLEAN'
}

/** Resolved kind for a calc field: an explicit override, else the legacy role-based default. */
export function calcFieldKind(c: CalcField): FieldInfo['kind'] {
  return c.kind ?? (c.role === 'measure' ? 'number' : 'string')
}

/**
 * SQL for a calc field's column in the `src` CTE. An explicit `kind`
 * reinterprets the expression's result via TRY_CAST (e.g. a text column
 * parsed as TIMESTAMP) — one unparseable row becomes NULL rather than
 * failing the query, the same guard every other TRY_CAST in this file uses.
 * No override (legacy fields) runs the expression exactly as before.
 *
 * A plain TRY_CAST to TIMESTAMP only understands DuckDB's default ISO-ish
 * text form ('2024-01-15', ...) — it does NOT parse locale formats like
 * dd/mm/yyyy, so every row would silently become NULL. When `dateFormat` is
 * set, `try_strptime` (itself NULL-safe, same as textImport.ts's import-wizard
 * date columns) parses against that explicit format instead.
 */
export function calcFieldSql(c: CalcField): string {
  if (c.kind === 'date' && c.dateFormat) {
    return `CAST(try_strptime(CAST((${c.expr}) AS VARCHAR), ${quoteLiteral(c.dateFormat)}) AS TIMESTAMP)`
  }
  const sqlType = c.kind ? CALC_KIND_SQL_TYPE[c.kind] : undefined
  return sqlType ? `TRY_CAST((${c.expr}) AS ${sqlType})` : `(${c.expr})`
}

/**
 * Inner expression for an aggregation. When the column is known to be
 * non-numeric and the aggregation is numeric, TRY_CAST guards against
 * Binder Errors like sum(VARCHAR); unparseable values become NULL.
 */
function aggInner(field: string, agg: Agg, kinds?: Record<string, FieldInfo['kind']>): string {
  if (field === '*') return '*'
  const base = quoteIdent(field)
  const kind = kinds?.[field]
  if (NUMERIC_AGGS.has(agg) && kind !== undefined && kind !== 'number') {
    return `TRY_CAST(${base} AS DOUBLE)`
  }
  return base
}

function measureExpr(ref: FieldRef, kinds?: Record<string, FieldInfo['kind']>): string {
  // "Number of Records" (*) only supports count, whatever the pill says
  if (ref.field === '*') return 'count(*)'
  const agg = ref.agg ?? 'sum'
  return aggExpr(agg, aggInner(ref.field, agg, kinds))
}

function filterClause(f: Filter): string | null {
  switch (f.kind) {
    case 'in': {
      if (f.values.length === 0) return null
      const list = f.values.map(quoteLiteral).join(', ')
      const col = `CAST(${quoteIdent(f.field)} AS VARCHAR)`
      // '' stands for blank (empty string or NULL — distinctValues merges both).
      // IN/NOT IN never match a NULL row by themselves, so NULL rows must
      // follow what the user did with the blank entry:
      //  - include + blank selected: keep NULL rows too
      //  - exclude + blank NOT selected: blank was not excluded, keep NULL rows
      const hasBlank = f.values.includes('')
      if (f.exclude) {
        return hasBlank
          ? `${col} NOT IN (${list})`
          : `(${col} NOT IN (${list}) OR ${quoteIdent(f.field)} IS NULL)`
      }
      return hasBlank
        ? `(${col} IN (${list}) OR ${quoteIdent(f.field)} IS NULL)`
        : `${col} IN (${list})`
    }
    case 'range': {
      const parts: string[] = []
      if (f.min !== undefined && f.min !== null) parts.push(`${quoteIdent(f.field)} >= ${f.min}`)
      if (f.max !== undefined && f.max !== null) parts.push(`${quoteIdent(f.field)} <= ${f.max}`)
      return parts.length ? parts.join(' AND ') : null
    }
    case 'dateRange': {
      const parts: string[] = []
      const col = `TRY_CAST(${quoteIdent(f.field)} AS TIMESTAMP)`
      if (f.from) parts.push(`${col} >= TIMESTAMP ${quoteLiteral(f.from + ' 00:00:00')}`)
      if (f.to) parts.push(`${col} <= TIMESTAMP ${quoteLiteral(f.to + ' 23:59:59')}`)
      return parts.length ? parts.join(' AND ') : null
    }
    case 'expr':
      return f.expr.trim() ? `(${f.expr})` : null
  }
}

/** Translate a list of filters into WHERE clauses (nulls out empty ones). */
export function filtersToWhere(filters: Filter[]): string[] {
  return filters.map(filterClause).filter((c): c is string => c !== null)
}

/**
 * Blank out single-quoted string literals (DuckDB doubles '' to escape a quote,
 * no backslash escaping) so validation only inspects actual SQL code, not
 * literal text. An unterminated literal has no closing quote to match, so it
 * is left as-is and still scanned — ambiguous input fails closed.
 */
function stripStringLiterals(expr: string): string {
  return expr.replace(/'(?:[^']|'')*'/g, "''")
}

/** Reject statements hidden inside calculated-field / filter expressions. */
export function validateExpression(expr: string): string | null {
  const code = stripStringLiterals(expr)
  if (code.includes(';')) return 'Expressions cannot contain ";"'
  const forbidden = /\b(insert|update|delete|copy|attach|detach|pragma|create|drop|alter|install|load|export|import)\b/i
  const m = code.match(forbidden)
  if (m) return `Expressions cannot contain the keyword "${m[0].toUpperCase()}"`
  return null
}

export interface BuiltQuery {
  sql: string
  /** aliases of dimension output columns, in order */
  dimAliases: string[]
  /** aliases of measure output columns, in order */
  measureAliases: string[]
  /** display names for dims/measures, parallel to the alias arrays */
  dimLabels: string[]
  measureLabels: string[]
}

export function fieldLabel(ref: FieldRef): string {
  if (ref.role === 'measure') {
    if (ref.field === '*') return 'Count of Records'
    const agg = ref.agg ?? 'sum'
    return `${agg.toUpperCase()}(${ref.field})`
  }
  if (ref.dateBin) return `${ref.dateBin.toUpperCase()}(${ref.field})`
  if (ref.numBin) return `${ref.field} (bin ${ref.numBin.size})`
  return ref.field
}

/**
 * Collect dims and measures from every shelf, in a stable order:
 * columns, rows, color, size, label, tooltip.
 */
export function collectRefs(shelf: ShelfState): { dims: FieldRef[]; meas: FieldRef[] } {
  const all: FieldRef[] = [
    ...shelf.columns,
    ...shelf.rows,
    ...(shelf.color ? [shelf.color] : []),
    ...(shelf.size ? [shelf.size] : []),
    ...(shelf.label ? [shelf.label] : []),
    ...shelf.tooltip
  ]
  const dims: FieldRef[] = []
  const meas: FieldRef[] = []
  const seenDim = new Set<string>()
  const seenMeas = new Set<string>()
  for (const ref of all) {
    if (ref.role === 'dimension') {
      const key = `${ref.field}|${ref.dateBin ?? ''}|${ref.numBin?.size ?? ''}`
      if (!seenDim.has(key)) {
        seenDim.add(key)
        dims.push(ref)
      }
    } else {
      const key = `${ref.field}|${ref.agg ?? 'sum'}`
      if (!seenMeas.has(key)) {
        seenMeas.add(key)
        meas.push(ref)
      }
    }
  }
  return { dims, meas }
}

export interface BuildQueryOptions {
  /** LIMIT applied when shelf.limit is unset (adaptive to source size) */
  defaultLimit?: number
  /** dataset-level filters applied inside the src CTE, before everything else */
  sourceFilters?: Filter[]
  /** column kinds; enables TRY_CAST guards for numeric aggregations over text */
  fieldKinds?: Record<string, FieldInfo['kind']>
}

/** Adaptive default LIMIT: huge sources get fewer aggregated rows back. */
export function getAdaptiveLimit(rowCount: number): number {
  if (rowCount < 1_000_000) return 50000
  if (rowCount < 10_000_000) return 10000
  if (rowCount < 100_000_000) return 5000
  return 1000
}

/** Stable identity for a dimension ref (field + binning). */
export function refKey(r: FieldRef): string {
  return `${r.field}|${r.dateBin ?? ''}|${r.numBin?.size ?? ''}`
}

interface Scaffold {
  ctes: string[]
  /** shelf filter clauses (source filters are already inside the src CTE) */
  where: string[]
  dims: FieldRef[]
  meas: FieldRef[]
  topNDims: FieldRef[]
  /** final select expression for a dim, including the top-N "Others" CASE */
  dimSelectExpr: (d: FieldRef) => string
  /** IN (SELECT v FROM top_i) clauses for top-N dims without "Others" */
  topNWhere: string[]
}

/**
 * Resolve calc field expression dependencies by inlining upstream calc
 * field names with their full expressions. SQL does not allow referencing
 * a column alias within the same SELECT list — when calc field B's expr
 * contains `"A"` (a reference to calc field A), DuckDB cannot resolve it
 * because both are defined side by side in the `src` CTE. This function
 * replaces each such reference with A's (resolved) expression, turning
 * cross-references into self-contained SQL.
 *
 * Resolution is order-independent: deleting and recreating a field moves
 * it to the end of the array, so dependencies can appear AFTER their
 * dependents. Each reference is resolved recursively on demand. Circular
 * references keep their raw expression — they will fail with a DuckDB
 * binder error, which is correct.
 */
export function resolveCalcExprs(calcFields: CalcField[]): Map<string, string> {
  const byName = new Map(calcFields.map((c) => [c.name, c.expr]))
  const resolved = new Map<string, string>()
  const visiting = new Set<string>()
  const resolve = (name: string): string => {
    const cached = resolved.get(name)
    if (cached !== undefined) return cached
    let expr = byName.get(name) ?? ''
    if (visiting.has(name)) return expr // cycle: leave the raw expression
    visiting.add(name)
    for (const other of byName.keys()) {
      if (other === name) continue
      const quoted = quoteIdent(other)
      if (expr.includes(quoted)) {
        expr = expr.replaceAll(quoted, `(${resolve(other)})`)
      }
    }
    visiting.delete(name)
    resolved.set(name, expr)
    return expr
  }
  for (const c of calcFields) resolve(c.name)
  // preserve array order in the returned map (src CTE column order)
  const ordered = new Map<string, string>()
  for (const c of calcFields) ordered.set(c.name, resolved.get(c.name) ?? c.expr)
  return ordered
}

/**
 * Inline every reference to a calc field inside an arbitrary SQL expression
 * (a filter expr, a validation query, a template being built on top of a
 * calc field) so the result only references real columns of `ds_<id>`.
 */
export function resolveExprWith(expr: string, calcFields: CalcField[]): string {
  if (!calcFields.length) return expr
  const resolved = resolveCalcExprs(calcFields)
  for (const [name, rExpr] of resolved) {
    const quoted = quoteIdent(name)
    if (expr.includes(quoted)) expr = expr.replaceAll(quoted, `(${rExpr})`)
  }
  return expr
}

/**
 * Standalone SQL for one calc field (dependencies inlined, kind cast applied)
 * for use OUTSIDE the src CTE — e.g. `distinctValues`/`fieldRange`, which run
 * directly against the raw `ds_<id>` view. Undefined when `name` is not a
 * calculated field.
 */
export function resolvedCalcSql(calcFields: CalcField[], name: string): string | undefined {
  const c = calcFields.find((f) => f.name === name)
  if (!c) return undefined
  const resolved = resolveCalcExprs(calcFields)
  return calcFieldSql({ ...c, expr: resolved.get(c.name) ?? c.expr })
}

/** Shared query scaffolding: src CTE (+calc fields, +source filters) and top-N CTEs. */
function buildScaffold(
  shelf: ShelfState,
  calcFields: CalcField[],
  viewName: string,
  opts: BuildQueryOptions
): Scaffold {
  const { dims, meas } = collectRefs(shelf)

  // source CTE with calculated fields materialized as extra columns;
  // dataset-level filters go here so every downstream query sees them
  const resolvedExprs = resolveCalcExprs(calcFields)
  const calcCols = calcFields
    .map((c) => `${calcFieldSql({ ...c, expr: resolvedExprs.get(c.name) ?? c.expr })} AS ${quoteIdent(c.name)}`)
    .join(', ')
  const srcSelect = calcCols ? `SELECT *, ${calcCols}` : 'SELECT *'
  const srcWhere = filtersToWhere(opts.sourceFilters ?? [])
  const srcWhereSql = srcWhere.length ? ` WHERE ${srcWhere.join(' AND ')}` : ''
  const ctes: string[] = [`src AS (${srcSelect} FROM ${quoteIdent(viewName)}${srcWhereSql})`]

  const where = filtersToWhere(shelf.filters)
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''

  // top-N CTEs: for each dim with topN, rank its values by an aggregate
  const topNDims = dims.filter((d) => d.topN)
  topNDims.forEach((d, i) => {
    const t = d.topN!
    const dir = t.direction === 'bottom' ? 'ASC' : 'DESC'
    // '*' only supports count, whatever agg the spec carries
    const rankMeasure =
      t.byField === '*' ? 'count(*)' : aggExpr(t.byAgg, aggInner(t.byField, t.byAgg, opts.fieldKinds))
    if (t.mode === 'percent') {
      const pct = Math.min(100, Math.max(0.01, t.n))
      ctes.push(
        `top_${i} AS (SELECT v FROM (SELECT ${dimExpr(d, opts.fieldKinds)} AS v, row_number() OVER (ORDER BY ${rankMeasure} ${dir}) AS rn, count(*) OVER () AS tot FROM src${whereSql} GROUP BY 1) ranked WHERE rn <= greatest(1, CAST(ceil(tot * ${pct} / 100.0) AS BIGINT)))`
      )
    } else {
      ctes.push(
        `top_${i} AS (SELECT ${dimExpr(d, opts.fieldKinds)} AS v FROM src${whereSql} GROUP BY 1 ORDER BY ${rankMeasure} ${dir} LIMIT ${Math.max(1, Math.floor(t.n))})`
      )
    }
  })

  const dimSelectExpr = (d: FieldRef): string => {
    let expr = dimExpr(d, opts.fieldKinds)
    const topIdx = topNDims.findIndex((x) => refKey(x) === refKey(d))
    if (topIdx >= 0 && topNDims[topIdx].topN!.others) {
      expr = `CASE WHEN ${expr} IN (SELECT v FROM top_${topIdx}) THEN CAST(${expr} AS VARCHAR) ELSE 'Others' END`
    }
    return expr
  }

  const topNWhere: string[] = []
  topNDims.forEach((d, i) => {
    if (!d.topN!.others) topNWhere.push(`${dimExpr(d, opts.fieldKinds)} IN (SELECT v FROM top_${i})`)
  })

  return { ctes, where, dims, meas, topNDims, dimSelectExpr, topNWhere }
}

/**
 * Build the aggregation SQL for a shelf state against view `ds_<id>`.
 * Boxplot expands the first measure into min/q1/median/q3/max.
 */
export function buildQuery(
  shelf: ShelfState,
  calcFields: CalcField[],
  viewName: string,
  opts: BuildQueryOptions = {}
): BuiltQuery {
  const { ctes, where, dims, meas, dimSelectExpr, topNWhere } = buildScaffold(
    shelf, calcFields, viewName, opts
  )

  const dimAliases: string[] = []
  const measureAliases: string[] = []
  const selectParts: string[] = []

  dims.forEach((d, i) => {
    const alias = `d${i}`
    dimAliases.push(alias)
    selectParts.push(`${dimSelectExpr(d)} AS ${quoteIdent(alias)}`)
  })

  const isBoxplot = shelf.chartType === 'boxplot' && meas.length > 0 && meas[0].field !== '*'
  if (isBoxplot) {
    const inner = aggInner(meas[0].field, 'median', opts.fieldKinds)
    const stats: Array<[string, string]> = [
      ['m0', `min(${inner})`],
      ['m1', `quantile_cont(${inner}, 0.25)`],
      ['m2', `median(${inner})`],
      ['m3', `quantile_cont(${inner}, 0.75)`],
      ['m4', `max(${inner})`]
    ]
    for (const [alias, expr] of stats) {
      measureAliases.push(alias)
      selectParts.push(`${expr} AS ${quoteIdent(alias)}`)
    }
  } else {
    meas.forEach((m, i) => {
      const alias = `m${i}`
      measureAliases.push(alias)
      selectParts.push(`${measureExpr(m, opts.fieldKinds)} AS ${quoteIdent(alias)}`)
    })
  }

  // dims-only views still need a value column for tables and charts
  if (measureAliases.length === 0) {
    measureAliases.push('m0')
    selectParts.push('count(*) AS "m0"')
  }

  const extraWhere: string[] = [...where, ...topNWhere]
  const finalWhere = extraWhere.length ? ` WHERE ${extraWhere.join(' AND ')}` : ''

  const groupBy = dimAliases.length
    ? ` GROUP BY ${dimAliases.map((_, i) => i + 1).join(', ')}`
    : ''

  // ordering: explicit value sort on any ref wins, otherwise dims ascending
  let orderBy = ''
  const sortedDim = dims.find((d) => d.sort)
  if (sortedDim?.sort === 'valueAsc' || sortedDim?.sort === 'valueDesc') {
    const dir = sortedDim.sort === 'valueAsc' ? 'ASC' : 'DESC'
    if (measureAliases.length) orderBy = ` ORDER BY ${quoteIdent(measureAliases[0])} ${dir}`
  } else if (sortedDim?.sort === 'desc') {
    orderBy = ` ORDER BY ${quoteIdent(dimAliases[dims.indexOf(sortedDim)])} DESC`
  } else if (dimAliases.length) {
    orderBy = ` ORDER BY ${dimAliases.map((a) => quoteIdent(a)).join(', ')}`
  }

  const limit = ` LIMIT ${shelf.limit ?? opts.defaultLimit ?? 50000}`

  const sql =
    `WITH ${ctes.join(',\n     ')}\n` +
    `SELECT ${selectParts.join(', ')}\nFROM src${finalWhere}${groupBy}${orderBy}${limit}`

  const isBox = isBoxplot
  return {
    sql,
    dimAliases,
    measureAliases,
    dimLabels: dims.map(fieldLabel),
    measureLabels: isBox
      ? ['Min', 'Q1', 'Median', 'Q3', 'Max']
      : meas.length
        ? meas.map(fieldLabel)
        : ['Count of Records']
  }
}

// ---------- Drill through / View Data ----------

/** A clicked datum: the dimension ref plus the raw (pre-format) value from the result row. */
export interface DrillPair {
  ref: FieldRef
  value: unknown
}

export interface DetailQueryOptions extends BuildQueryOptions {
  /** free-text search ILIKEd across these columns */
  search?: { columns: string[]; text: string }
  orderBy?: { field: string; dir: 'ASC' | 'DESC' }
  limit: number
  offset: number
}

export interface DetailQuery {
  sql: string
  countSql: string
  /** same query without pagination, for exports */
  exportSql: string
}

/**
 * Build a SELECT * over the underlying records that produced a chart datum:
 * source filters + shelf filters + top-N restrictions + dim = value predicates.
 */
export function buildDetailQuery(
  shelf: ShelfState,
  calcFields: CalcField[],
  viewName: string,
  pairs: DrillPair[],
  opts: DetailQueryOptions
): DetailQuery {
  const { ctes, where, dimSelectExpr, topNWhere } = buildScaffold(shelf, calcFields, viewName, opts)

  const predicates: string[] = [...where, ...topNWhere]
  for (const { ref, value } of pairs) {
    const expr = dimSelectExpr(ref)
    if (value === null || value === undefined || value === '(null)') {
      predicates.push(`(${expr}) IS NULL`)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      predicates.push(`${expr} = ${value}`)
    } else {
      predicates.push(`CAST(${expr} AS VARCHAR) = ${quoteLiteral(String(value))}`)
    }
  }

  if (opts.search && opts.search.text.trim() && opts.search.columns.length) {
    const pat = '%' + opts.search.text.trim().replace(/([\\%_])/g, '\\$1') + '%'
    const ors = opts.search.columns.map(
      (c) => `CAST(${quoteIdent(c)} AS VARCHAR) ILIKE ${quoteLiteral(pat)} ESCAPE '\\'`
    )
    predicates.push(`(${ors.join(' OR ')})`)
  }

  const whereSql = predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''
  const orderSql = opts.orderBy
    ? ` ORDER BY ${quoteIdent(opts.orderBy.field)} ${opts.orderBy.dir}`
    : ''
  const withSql = `WITH ${ctes.join(',\n     ')}\n`
  const bodySql = `SELECT *\nFROM src${whereSql}${orderSql}`

  return {
    sql: `${withSql}${bodySql} LIMIT ${opts.limit} OFFSET ${opts.offset}`,
    countSql: `${withSql}SELECT count(*) AS n FROM src${whereSql}`,
    exportSql: `${withSql}${bodySql}`
  }
}

/** Chart-type metadata used by the Show Me panel. */
export interface ChartTypeInfo {
  type: ChartType
  label: string
  minDims: number
  maxDims: number
  minMeas: number
  maxMeas: number
  hint: string
}

export const CHART_TYPES: ChartTypeInfo[] = [
  { type: 'table', label: 'Table', minDims: 0, maxDims: 99, minMeas: 0, maxMeas: 99, hint: 'Any fields' },
  { type: 'kpi', label: 'KPI Card', minDims: 0, maxDims: 0, minMeas: 1, maxMeas: 8, hint: '1-8 measures, no dimensions — big-number cards' },
  { type: 'bar', label: 'Bar', minDims: 1, maxDims: 3, minMeas: 1, maxMeas: 8, hint: '1+ dimension, 1+ measure' },
  { type: 'barh', label: 'Horizontal Bar', minDims: 1, maxDims: 3, minMeas: 1, maxMeas: 8, hint: '1+ dimension, 1+ measure' },
  { type: 'lollipop', label: 'Lollipop', minDims: 1, maxDims: 2, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure — stem + dot' },
  { type: 'pictorial', label: 'Pictorial Bar', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure — segmented symbol bars' },
  { type: 'stackedBar', label: 'Stacked Bar', minDims: 1, maxDims: 3, minMeas: 1, maxMeas: 8, hint: '1-2 dimensions, 1+ measures — color dimension or extra measures stack' },
  { type: 'stackedBarH', label: 'Stacked Bar (H)', minDims: 1, maxDims: 3, minMeas: 1, maxMeas: 8, hint: 'Horizontal stacked bar — same requirements as Stacked Bar' },
  { type: 'percentBar', label: '100% Stacked Bar', minDims: 1, maxDims: 3, minMeas: 1, maxMeas: 8, hint: '1-2 dimensions, 1+ measures — normalized to 100%' },
  { type: 'percentBarH', label: '100% Bar (H)', minDims: 1, maxDims: 3, minMeas: 1, maxMeas: 8, hint: 'Horizontal 100% stacked bar' },
  { type: 'rangeBar', label: 'Range Bar', minDims: 1, maxDims: 2, minMeas: 2, maxMeas: 2, hint: '1 dimension, 2 measures — floating bar from low to high' },
  { type: 'bullet', label: 'Bullet', minDims: 1, maxDims: 1, minMeas: 2, maxMeas: 3, hint: '1 dimension, 2-3 measures (value, target, optional range) — KPI vs target' },
  { type: 'line', label: 'Line', minDims: 1, maxDims: 2, minMeas: 1, maxMeas: 8, hint: '1 dimension (often a date), 1+ measure' },
  { type: 'smoothLine', label: 'Smooth Line', minDims: 1, maxDims: 2, minMeas: 1, maxMeas: 8, hint: '1 dimension, 1+ measures — spline-interpolated line' },
  { type: 'stepLine', label: 'Step Line', minDims: 1, maxDims: 2, minMeas: 1, maxMeas: 8, hint: '1 dimension, 1+ measures' },
  { type: 'area', label: 'Area', minDims: 1, maxDims: 2, minMeas: 1, maxMeas: 8, hint: '1 dimension, 1+ measure' },
  { type: 'stackedArea', label: 'Stacked Area', minDims: 1, maxDims: 2, minMeas: 1, maxMeas: 8, hint: '1-2 dimensions, 1+ measures — color dimension or extra measures stack' },
  { type: 'scatter', label: 'Scatter', minDims: 0, maxDims: 2, minMeas: 2, maxMeas: 2, hint: '2 measures, optional dimension' },
  { type: 'effectScatter', label: 'Effect Scatter', minDims: 0, maxDims: 2, minMeas: 2, maxMeas: 2, hint: '2 measures, optional dimension — animated ripple points' },
  { type: 'bubble', label: 'Bubble', minDims: 1, maxDims: 2, minMeas: 3, maxMeas: 3, hint: '1 dimension, 3 measures (x, y, size)' },
  { type: 'pie', label: 'Pie', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure' },
  { type: 'donut', label: 'Donut', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure' },
  { type: 'halfDonut', label: 'Half Donut', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure — semicircle gauge-style donut' },
  { type: 'rose', label: 'Nightingale Rose', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure' },
  { type: 'polarBar', label: 'Radial Bar', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure — bars on circular arcs' },
  { type: 'heatmap', label: 'Heatmap', minDims: 2, maxDims: 2, minMeas: 1, maxMeas: 1, hint: '2 dimensions, 1 measure' },
  { type: 'treemap', label: 'Treemap', minDims: 1, maxDims: 3, minMeas: 1, maxMeas: 1, hint: '1-3 dimensions, 1 measure' },
  { type: 'sunburst', label: 'Sunburst', minDims: 1, maxDims: 3, minMeas: 1, maxMeas: 1, hint: '1-3 dimensions, 1 measure' },
  { type: 'sankey', label: 'Sankey', minDims: 2, maxDims: 4, minMeas: 1, maxMeas: 1, hint: '2+ dimensions, 1 measure' },
  { type: 'funnel', label: 'Funnel', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure' },
  { type: 'pyramid', label: 'Pyramid', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure — ascending funnel' },
  { type: 'gauge', label: 'Gauge', minDims: 0, maxDims: 0, minMeas: 1, maxMeas: 3, hint: '1-3 measures, no dimensions' },
  { type: 'radar', label: 'Radar', minDims: 1, maxDims: 2, minMeas: 1, maxMeas: 8, hint: '1 dimension, 1+ measures' },
  { type: 'boxplot', label: 'Box Plot', minDims: 1, maxDims: 2, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure (auto quartiles)' },
  { type: 'calendar', label: 'Calendar Heatmap', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 date dimension (day), 1 measure' },
  { type: 'candlestick', label: 'Candlestick', minDims: 1, maxDims: 1, minMeas: 4, maxMeas: 4, hint: '1 dimension, 4 measures (open, close, low, high)' },
  { type: 'waterfall', label: 'Waterfall', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure — running total with a final Total bar' },
  { type: 'pareto', label: 'Pareto', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure — bars + cumulative % line' },
  { type: 'themeriver', label: 'Theme River', minDims: 2, maxDims: 2, minMeas: 1, maxMeas: 1, hint: '1 date dimension + 1 category, 1 measure' },
  { type: 'parallel', label: 'Parallel Coords', minDims: 0, maxDims: 1, minMeas: 3, maxMeas: 12, hint: '3+ measures, optional dimension' },
  { type: 'graph', label: 'Network Graph', minDims: 2, maxDims: 2, minMeas: 1, maxMeas: 1, hint: '2 dimensions (source → target), 1 measure' },
  { type: 'graphCircular', label: 'Circular Graph', minDims: 2, maxDims: 2, minMeas: 1, maxMeas: 1, hint: '2 dimensions (source → target), 1 measure — chord-style ring layout' },
  { type: 'tree', label: 'Tree', minDims: 1, maxDims: 3, minMeas: 0, maxMeas: 1, hint: '1-3 dimensions as hierarchy levels' },
  { type: 'treeRadial', label: 'Radial Tree', minDims: 1, maxDims: 3, minMeas: 0, maxMeas: 1, hint: '1-3 dimensions as hierarchy levels — circular layout' },
  { type: 'wordcloud', label: 'Word Cloud', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 dimension, 1 measure for word size' },
  { type: 'map', label: 'World Map', minDims: 1, maxDims: 1, minMeas: 1, maxMeas: 1, hint: '1 dimension with country names in English, 1 measure' },
  { type: 'mapPoints', label: 'Symbol Map', minDims: 0, maxDims: 2, minMeas: 2, maxMeas: 3, hint: '2-3 measures (longitude, latitude, optional size), optional label dimension' },
  { type: 'mapFlow', label: 'Flow Map', minDims: 0, maxDims: 1, minMeas: 4, maxMeas: 5, hint: '4-5 measures (from lng, from lat, to lng, to lat, optional width), optional label dimension' },
  { type: 'combo', label: 'Bar + Line Combo', minDims: 1, maxDims: 2, minMeas: 2, maxMeas: 8, hint: '1 dimension, 2+ measures — first is bars, rest are lines (2nd axis)' }
]

export function chartTypeApplicable(info: ChartTypeInfo, nDims: number, nMeas: number): boolean {
  return nDims >= info.minDims && nDims <= info.maxDims && nMeas >= info.minMeas && nMeas <= info.maxMeas
}

// ---------- word cloud extraction ----------

export interface WordcloudSpec {
  field: string
  /** 'regex' splits with string_split_regex (RE2); 'literal' splits with string_split (verbatim) */
  delimiterMode: 'regex' | 'literal'
  delimiter: string
  /** lowercase the field before splitting */
  caseFold: boolean
  /** drop tokens shorter than this many characters */
  minLength: number
  /** drop common English/Portuguese stopwords */
  stopwords: boolean
}

/** Common English + Portuguese stopwords, lowercased; compared against lower(word) regardless of caseFold. */
const WORDCLOUD_STOPWORDS = [
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'to', 'in', 'on', 'at', 'by',
  'with', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those', 'it',
  'its', 'from', 'into', 'not', 'no', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'do', 'does',
  'did', 'have', 'has', 'had', 'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'his', 'her', 'our',
  'their',
  'o', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos',
  'nas', 'para', 'por', 'com', 'sem', 'sobre', 'entre', 'e', 'ou', 'mas', 'se', 'que', 'é', 'são', 'foi',
  'ser', 'estar', 'está', 'não', 'sim', 'ao', 'aos', 'à', 'às', 'este', 'esta', 'isso', 'isto', 'aquele',
  'aquela', 'eu', 'você', 'ele', 'ela', 'nós', 'eles', 'elas', 'meu', 'minha', 'seu', 'sua', 'nosso',
  'nossa', 'já', 'também', 'mais', 'muito', 'pelo', 'pela'
]
const WORDCLOUD_STOPWORDS_SQL = [...new Set(WORDCLOUD_STOPWORDS)].map(quoteLiteral).join(', ')

/**
 * Tokenizing SELECT that turns one row per source record into one row per
 * word occurrence (column `word`). `base` is a FROM-ready source (a quoted
 * view/table name). Shared by the main-process view registration and the
 * wizard's live preview so both always compile to identical SQL.
 */
export function wordcloudTokenSql(base: string, spec: WordcloudSpec): string {
  const textExpr = spec.caseFold
    ? `lower(CAST(${quoteIdent(spec.field)} AS VARCHAR))`
    : `CAST(${quoteIdent(spec.field)} AS VARCHAR)`
  const splitFn = spec.delimiterMode === 'regex' ? 'string_split_regex' : 'string_split'
  const splitExpr = `${splitFn}(${textExpr}, ${quoteLiteral(spec.delimiter)})`
  const minLen = Math.max(1, Math.floor(spec.minLength) || 1)
  const stopClause = spec.stopwords ? ` AND lower(word) NOT IN (${WORDCLOUD_STOPWORDS_SQL})` : ''
  return (
    `SELECT word FROM (SELECT trim(w) AS word FROM ${base}, UNNEST(${splitExpr}) AS t(w)) tok ` +
    `WHERE word <> '' AND length(word) >= ${minLen}${stopClause}`
  )
}

// ---------- entity extraction ----------

/**
 * Canonicalization per pattern id (EXTRACT_PATTERNS in FieldTools.tsx):
 * formatted and unformatted variants of the same identifier must group as one
 * entity. Unknown/custom pattern ids fall back to lowercase.
 * - digits: keep digits only (123.456.789-09 ≡ 12345678909)
 * - lower:  case-insensitive identifiers (e-mail, hashes, UUID keys)
 * - upper:  identifiers conventionally uppercase (placa, passaporte, IBAN)
 * - none:   case-significant values (URL paths, Bitcoin base58)
 */
export const ENTITY_NORMALIZERS: Record<string, 'digits' | 'lower' | 'upper' | 'none'> = {
  cpf: 'digits',
  cnpj: 'digits',
  cep: 'digits',
  telefone: 'digits',
  cartao: 'digits',
  rg: 'digits',
  email: 'lower',
  pixUuid: 'lower',
  md5: 'lower',
  sha256: 'lower',
  eth: 'lower',
  placa: 'upper',
  passaporte: 'upper',
  iban: 'upper',
  url: 'none',
  btc: 'none',
  ipv4: 'none',
  dataBr: 'none',
  brl: 'none'
}

function entityNormalizeSql(inner: string, patternId: string): string {
  const how = ENTITY_NORMALIZERS[patternId] ?? 'lower'
  switch (how) {
    case 'digits':
      return `regexp_replace(${inner}, '[^0-9]', '', 'g')`
    case 'lower':
      return `lower(${inner})`
    case 'upper':
      return `upper(${inner})`
    case 'none':
      return inner
  }
}

export type EntitiesSpec = Pick<
  Extract<DataSourceDef, { kind: 'entities' }>,
  'fields' | 'patterns' | 'normalize' | 'fieldExprs' | 'idField' | 'sourceTable'
>

const ENTITY_BASE_COLS = 'source_id, source_table, entity, entity_raw, entity_type, source_field'

/**
 * Extraction SELECT that turns one row per source record into one row per
 * entity occurrence, across every (field × pattern) combination:
 * columns `entity_id` (unique row id of the entity table itself), `source_id`
 * (back-reference to the origin row — `spec.idField` when set, else a
 * row_number over the base), `source_table` (origin source name),
 * `entity` (canonical form when spec.normalize), `entity_raw` (the
 * exact match), `entity_type` (the pattern label) and `source_field`.
 * `base` is a FROM-ready quoted view name. Shared by the main-process
 * registration and the wizard's live preview so both compile identical SQL.
 *
 * Calculated fields in `spec.fields` don't exist as columns on the base
 * view; their resolved SQL travels in `spec.fieldExprs` and is inlined.
 *
 * When the spec extracts e-mails, each e-mail row also gets structured
 * enrichment columns (email_user, email_domain, email_category, email_org,
 * email_org_type, email_location — '' on non-email rows). The big org/TLD
 * CASE lookups only run once because entity sources are MATERIALIZED as
 * tables at registration (datasources.ts), not re-evaluated per query.
 */
export function entityTokenSql(base: string, spec: EntitiesSpec): string {
  if (!spec.fields.length || !spec.patterns.length) {
    return (
      'SELECT CAST(NULL AS BIGINT) AS entity_id, CAST(NULL AS BIGINT) AS source_id, ' +
      'CAST(NULL AS VARCHAR) AS source_table, ' +
      'CAST(NULL AS VARCHAR) AS entity, CAST(NULL AS VARCHAR) AS entity_raw, ' +
      'CAST(NULL AS VARCHAR) AS entity_type, CAST(NULL AS VARCHAR) AS source_field WHERE 1 = 0'
    )
  }
  // source_id keeps its NATIVE type (no cast) so a join back to the origin
  // column compares equal types. Without an idField, a synthetic row number
  // is computed over the base once per branch — deterministic for file-backed
  // sources (DuckDB preserves insertion order).
  const idExpr = spec.idField ? quoteIdent(spec.idField) : '__row_id'
  const scanBase = spec.idField
    ? base
    : `(SELECT row_number() OVER () AS __row_id, * FROM ${base})`
  const sourceTable = quoteLiteral(spec.sourceTable ?? '')
  const parts: string[] = []
  for (const field of spec.fields) {
    for (const p of spec.patterns) {
      const fieldExpr = spec.fieldExprs?.[field]
      const col = fieldExpr
        ? `CAST((${fieldExpr}) AS VARCHAR)`
        : `CAST(${quoteIdent(field)} AS VARCHAR)`
      const raw = 'trim(e)'
      const entity = spec.normalize ? entityNormalizeSql(raw, p.id) : raw
      parts.push(
        `SELECT ${idExpr} AS source_id, ${sourceTable} AS source_table, ` +
          `${entity} AS entity, ${raw} AS entity_raw, ` +
          `${quoteLiteral(p.label)} AS entity_type, ${quoteLiteral(field)} AS source_field ` +
          `FROM ${scanBase}, UNNEST(regexp_extract_all(${col}, ${quoteLiteral(p.pattern)})) AS t(e)`
      )
    }
  }
  const inner = `SELECT ${ENTITY_BASE_COLS} FROM (${parts.join(' UNION ALL ')}) ext WHERE entity <> ''`
  const withEntityId = (sql: string): string =>
    `SELECT row_number() OVER () AS entity_id, * FROM (${sql}) fin`

  const emailPattern = spec.patterns.find((p) => p.id === 'email')
  if (!emailPattern) return withEntityId(inner)

  // email enrichment: user/domain first, then domain-derived lookups so the
  // huge org/category/TLD CASEs reference the already-computed email_domain
  const isEmail = `entity_type = ${quoteLiteral(emailPattern.label)}`
  const mid =
    `SELECT ${ENTITY_BASE_COLS}, ` +
    `CASE WHEN ${isEmail} THEN ${emailUserExpr('entity')} ELSE '' END AS email_user, ` +
    `CASE WHEN ${isEmail} THEN ${emailDomainExpr('entity')} ELSE '' END AS email_domain ` +
    `FROM (${inner}) eml`
  return withEntityId(
    `SELECT ${ENTITY_BASE_COLS}, email_user, email_domain, ` +
      `CASE WHEN email_domain <> '' THEN ${emailCategoryExpr('email_domain')} ELSE '' END AS email_category, ` +
      `CASE WHEN email_domain <> '' THEN ${emailOrgExpr('email_domain')} ELSE '' END AS email_org, ` +
      `CASE WHEN email_domain <> '' THEN ${emailOrgTypeExpr('email_domain')} ELSE '' END AS email_org_type, ` +
      `CASE WHEN email_domain <> '' THEN ${emailLocationExpr(emailTLDOf('email_domain'))} ELSE '' END AS email_location ` +
      `FROM (${mid}) enr`
  )
}

// ---------- dashboard filter cards ----------

/** Compile a filter card's current selection into a Filter (null = not filtering). */
export function dashFilterToFilter(card: DashFilterCard): Filter | null {
  if (card.mode === 'in') {
    return card.values && card.values.length
      ? { kind: 'in', field: card.field, values: card.values }
      : null
  }
  if (card.mode === 'range') {
    return card.min !== undefined || card.max !== undefined
      ? { kind: 'range', field: card.field, min: card.min, max: card.max }
      : null
  }
  return card.from || card.to
    ? { kind: 'dateRange', field: card.field, from: card.from, to: card.to }
    : null
}

/** Active filters a dashboard's cards impose on one data source. */
export function dashFiltersFor(
  tiles: Array<{ filter?: DashFilterCard }>,
  dsId: string
): Filter[] {
  const out: Filter[] = []
  for (const t of tiles) {
    if (!t.filter || t.filter.dsId !== dsId) continue
    const f = dashFilterToFilter(t.filter)
    if (f) out.push(f)
  }
  return out
}

// Data source registry: every source becomes a DuckDB view named ds_<id>.
import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec, execWithProgress, ensureExtension, runQuery, sqlPath } from './duck'
import { emitProgress } from './progress'
import { ingestEmailArchive } from './emailImport'
import { entityTokenSql, quoteIdent, quoteLiteral, wordcloudTokenSql } from '../shared/sqlBuilder'
import type {
  DataSourceDef,
  DbDriver,
  DbTableInfo,
  DescribeResult,
  DistinctValuesOptions,
  DistinctValuesResult,
  FieldInfo,
  OpProgress,
  QueryResult
} from '../shared/types'

const registry = new Map<string, DataSourceDef>()
let dbCounter = 0

/** SheetJS, CJS behind an ESM dynamic import (same pattern as exceljs). */
async function loadSheetJs(): Promise<typeof import('xlsx')> {
  const mod = (await import('xlsx')) as typeof import('xlsx') & { default?: typeof import('xlsx') }
  return mod.default ?? mod
}

/**
 * Legacy Excel (.xls/.xlsm) is unreadable by DuckDB's excel extension, so the
 * chosen sheet is materialized as a temp CSV once per (file mtime, sheet) and
 * the view reads that. Re-registering after the file changes re-converts.
 */
async function xlsToCsv(path: string, sheet?: string): Promise<string> {
  const st = await stat(path)
  const key = createHash('sha1').update(`${path}|${sheet ?? ''}|${st.mtimeMs}`).digest('hex')
  const dir = join(tmpdir(), 'openvisualization-xls')
  await mkdir(dir, { recursive: true })
  const out = join(dir, `${key}.csv`)
  const cached = await stat(out).catch(() => null)
  if (cached && cached.size > 0) return out
  const XLSX = await loadSheetJs()
  const wb = XLSX.readFile(path, { cellDates: true })
  const name = sheet && wb.SheetNames.includes(sheet) ? sheet : wb.SheetNames[0]
  if (!name) throw new Error('The Excel file has no sheets')
  const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false })
  await writeFile(out, csv, 'utf-8')
  return out
}

export function viewName(id: string): string {
  return `ds_${id}`
}

export function getDef(id: string): DataSourceDef | undefined {
  return registry.get(id)
}

function fromClause(def: DataSourceDef): Promise<string> {
  return (async () => {
    switch (def.kind) {
      case 'file':
        switch (def.format) {
          case 'csv':
            return `read_csv(${sqlPath(def.path)})`
          case 'json':
            return `read_json_auto(${sqlPath(def.path)})`
          case 'parquet':
            return `read_parquet(${sqlPath(def.path)})`
          case 'xlsx': {
            await ensureExtension('excel')
            const sheet = def.sheet ? `, sheet = ${quoteLiteral(def.sheet)}` : ''
            return `read_xlsx(${sqlPath(def.path)}${sheet})`
          }
          case 'xls': {
            const csv = await xlsToCsv(def.path, def.sheet)
            return `read_csv(${sqlPath(csv)})`
          }
        }
        break
      case 'url': {
        await ensureExtension('httpfs')
        const u = quoteLiteral(def.url)
        if (def.format === 'json') return `read_json_auto(${u})`
        if (def.format === 'parquet') return `read_parquet(${u})`
        return `read_csv(${u})`
      }
      case 'db': {
        // native .duckdb files attach without any extension
        if (def.driver !== 'duckdb') await ensureExtension(def.driver)
        const alias = `att_${def.id}`
        const attachType = def.driver.toUpperCase()
        await exec(
          `ATTACH IF NOT EXISTS ${quoteLiteral(def.connString)} AS ${quoteIdent(alias)} (TYPE ${attachType}, READ_ONLY)`
        )
        const schemaPart = def.schema ? `${quoteIdent(def.schema)}.` : ''
        return `${quoteIdent(alias)}.${schemaPart}${quoteIdent(def.table)}`
      }
      case 'treated':
        return `read_parquet(${sqlPath(def.parquetPath)})`
      case 'emails': {
        // parquet produced at import time; if it is gone (new machine, cleared
        // userData) re-ingest the original archive into the same path
        const exists = await stat(def.parquetPath).catch(() => null)
        if (!exists) await ingestEmailArchive(def.path, def.parquetPath)
        return `read_parquet(${sqlPath(def.parquetPath)})`
      }
      case 'join':
        throw new Error('join sources are handled by registerDataSource directly')
      case 'wordcloud':
        throw new Error('wordcloud sources are handled by registerDataSource directly')
      case 'entities':
        throw new Error('entities sources are handled by registerDataSource directly')
    }
    throw new Error('Unknown data source kind')
  })()
}

/** Column names and DuckDB types of an already-registered view. */
async function viewColumns(id: string): Promise<Array<{ name: string; type: string }>> {
  const desc = await runQuery(`DESCRIBE SELECT * FROM ${quoteIdent(viewName(id))}`)
  return desc.rows.map((r) => ({
    name: String(r['column_name']),
    type: String(r['column_type'])
  }))
}

async function createJoinView(def: Extract<DataSourceDef, { kind: 'join' }>): Promise<void> {
  if (!registry.has(def.leftId) || !registry.has(def.rightId)) {
    throw new Error('Both source tables must be registered before joining')
  }
  const rightName = registry.get(def.rightId)!.name
  const leftCols = await viewColumns(def.leftId)
  const rightCols = await viewColumns(def.rightId)
  const rightKeys = new Set(def.keys.map((k) => k.right))
  const taken = new Set(leftCols.map((c) => c.name))

  const selects: string[] = leftCols.map((c) => `l.${quoteIdent(c.name)} AS ${quoteIdent(c.name)}`)
  for (const c of rightCols) {
    if (rightKeys.has(c.name)) continue // key columns duplicate the left side
    const alias = taken.has(c.name) ? `${c.name} (${rightName})` : c.name
    taken.add(alias)
    selects.push(`r.${quoteIdent(c.name)} AS ${quoteIdent(alias)}`)
  }

  const leftTypes = new Map(leftCols.map((c) => [c.name, c.type]))
  const rightTypes = new Map(rightCols.map((c) => [c.name, c.type]))
  const keyExpr = (k: { left: string; right: string }): string => {
    // mismatched key types (e.g. BIGINT vs DATE) have no direct cast in DuckDB;
    // compare both sides as text so the join never fails to build
    if (leftTypes.get(k.left) !== rightTypes.get(k.right)) {
      return `CAST(l.${quoteIdent(k.left)} AS VARCHAR) = CAST(r.${quoteIdent(k.right)} AS VARCHAR)`
    }
    return `l.${quoteIdent(k.left)} = r.${quoteIdent(k.right)}`
  }

  const joinKw = { inner: 'INNER JOIN', left: 'LEFT JOIN', right: 'RIGHT JOIN', full: 'FULL OUTER JOIN', cross: 'CROSS JOIN' }[def.joinType]
  const on = def.joinType === 'cross' ? '' : ` ON ${def.keys.map(keyExpr).join(' AND ')}`
  if (def.joinType !== 'cross' && def.keys.length === 0) {
    throw new Error('At least one key pair is required (except for cross join)')
  }
  await exec(
    `CREATE OR REPLACE VIEW ${quoteIdent(viewName(def.id))} AS ` +
      `SELECT ${selects.join(', ')} FROM ${quoteIdent(viewName(def.leftId))} l ${joinKw} ${quoteIdent(viewName(def.rightId))} r${on}`
  )
}

async function createWordcloudView(def: Extract<DataSourceDef, { kind: 'wordcloud' }>): Promise<void> {
  if (!registry.has(def.sourceId)) {
    throw new Error('The source data must be registered before extracting words')
  }
  if (!def.delimiter) throw new Error('A delimiter is required')
  await exec(
    `CREATE OR REPLACE VIEW ${quoteIdent(viewName(def.id))} AS ` +
      wordcloudTokenSql(quoteIdent(viewName(def.sourceId)), def)
  )
}

/**
 * Entity sources are MATERIALIZED as tables, not views: the regex scan
 * (fields × patterns × UNNEST) plus the e-mail enrichment CASE lookups are
 * far too expensive to re-run on every worksheet query. The cost is paid
 * once here (registration / workbook load); everything downstream reads
 * plain columns. `ds_<id>` naming is unchanged, so all shelf SQL still works.
 */
async function createEntitiesTable(def: Extract<DataSourceDef, { kind: 'entities' }>): Promise<void> {
  if (!registry.has(def.sourceId)) {
    throw new Error('The source data must be registered before extracting entities')
  }
  if (!def.fields.length) throw new Error('Pick at least one text field to scan')
  if (!def.patterns.length) throw new Error('Pick at least one entity pattern')
  if (def.patterns.some((p) => !p.pattern.trim())) throw new Error('A pattern is empty')
  // same name may exist as a view from an older session's workbook
  await dropSourceObject(def.id)
  const progress: OpProgress = {
    key: `ds:${def.id}`,
    label: `Extracting entities — ${def.name}`,
    pct: null
  }
  emitProgress(progress)
  try {
    await execWithProgress(
      `CREATE TABLE ${quoteIdent(viewName(def.id))} AS ` +
        entityTokenSql(quoteIdent(viewName(def.sourceId)), def),
      (pct) => emitProgress({ ...progress, pct })
    )
  } finally {
    emitProgress({ ...progress, pct: 1, done: true })
  }
}

/**
 * Drop ds_<id> whether it exists as a view or a table. DuckDB's
 * `DROP VIEW IF EXISTS` errors when the name belongs to a TABLE (and vice
 * versa) instead of being a no-op, so each statement tolerates that error.
 */
async function dropSourceObject(id: string): Promise<void> {
  await exec(`DROP VIEW IF EXISTS ${quoteIdent(viewName(id))}`).catch(() => {})
  await exec(`DROP TABLE IF EXISTS ${quoteIdent(viewName(id))}`).catch(() => {})
}

export async function registerDataSource(def: DataSourceDef): Promise<DescribeResult> {
  if (def.kind === 'join') {
    await createJoinView(def)
    registry.set(def.id, def)
    return describeDataSource(def.id)
  }
  if (def.kind === 'wordcloud') {
    await createWordcloudView(def)
    registry.set(def.id, def)
    return describeDataSource(def.id)
  }
  if (def.kind === 'entities') {
    await createEntitiesTable(def)
    registry.set(def.id, def)
    return describeDataSource(def.id)
  }

  const create = async (csvOpts?: string): Promise<DescribeResult> => {
    let from = await fromClause(def)
    if (csvOpts && from.startsWith('read_csv(')) {
      from = from.replace(/\)$/, `, ${csvOpts})`)
    }
    // withRowId: synthetic row_id so entity tables can join back to the exact
    // source row (stable for file readers — DuckDB preserves insertion order)
    const cols = def.withRowId ? 'row_number() OVER () AS row_id, *' : '*'
    await exec(`CREATE OR REPLACE VIEW ${quoteIdent(viewName(def.id))} AS SELECT ${cols} FROM ${from}`)
    registry.set(def.id, def)
    return describeDataSource(def.id)
  }

  const isCsv =
    (def.kind === 'file' && def.format === 'csv') || (def.kind === 'url' && def.format === 'csv')
  if (!isCsv) return create()

  // CSV type sniffing uses a sample; a later row can break the inferred type
  // ("Could not convert string 'GET' to INT64"). Retry with progressively
  // safer options: full-file sniff, then everything-as-text.
  try {
    return await create()
  } catch {
    try {
      return await create('sample_size = -1')
    } catch {
      return await create('all_varchar = true, ignore_errors = true')
    }
  }
}

export async function removeDataSource(id: string): Promise<void> {
  await dropSourceObject(id)
  registry.delete(id)
}

function inferRole(dbType: string, name: string): FieldInfo['role'] {
  const t = dbType.toUpperCase()
  const numeric = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|FLOAT|DOUBLE|DECIMAL|UTINYINT|USMALLINT|UINTEGER|UBIGINT)/.test(t)
  if (!numeric) return 'dimension'
  if (/(^|_)(id|code|key|year|zip|cep)s?$/i.test(name)) return 'dimension'
  return 'measure'
}

function kindOf(dbType: string): FieldInfo['kind'] {
  const t = dbType.toUpperCase()
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|FLOAT|DOUBLE|DECIMAL|UTINYINT|USMALLINT|UINTEGER|UBIGINT)/.test(t)) return 'number'
  if (/^(DATE|TIMESTAMP|TIME)/.test(t)) return 'date'
  if (t === 'BOOLEAN') return 'bool'
  if (t === 'VARCHAR' || t.startsWith('ENUM')) return 'string'
  return 'other'
}

export async function describeDataSource(id: string): Promise<DescribeResult> {
  const v = quoteIdent(viewName(id))
  const desc = await runQuery(`DESCRIBE SELECT * FROM ${v}`)
  const fields: FieldInfo[] = desc.rows.map((r) => {
    const name = String(r['column_name'])
    const dbType = String(r['column_type'])
    return { name, dbType, kind: kindOf(dbType), role: inferRole(dbType, name) }
  })
  const cnt = await runQuery(`SELECT count(*) AS c FROM ${v}`)
  return { fields, rowCount: Number(cnt.rows[0]?.['c'] ?? 0) }
}

export async function previewDataSource(
  id: string,
  offset: number,
  limit: number
): Promise<QueryResult> {
  return runQuery(
    `SELECT * FROM ${quoteIdent(viewName(id))} LIMIT ${Math.min(limit, 1000)} OFFSET ${Math.max(0, offset)}`
  )
}

/**
 * `field` is normally a real column on the `ds_<id>` view. Calculated fields
 * only exist as SQL expressions substituted at shelf-query time (see
 * `buildScaffold` in sqlBuilder.ts), so callers offering a calc field must
 * pass its `expr` too — otherwise this throws Binder Error (column not found).
 *
 * Search runs server-side over the FULL distinct domain (not just one page),
 * NULL and '' are merged into a single blank ('') entry, and `total` reports
 * how many distinct values match the search so callers can page past any
 * single-page limit.
 */
export async function distinctValues(
  id: string,
  field: string,
  opts: DistinctValuesOptions = {}
): Promise<DistinctValuesResult> {
  const col = opts.expr ? `(${opts.expr})` : quoteIdent(field)
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 1000)), 10000)
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const search = (opts.search ?? '').trim()
  // same LIKE-metachar escaping as FilterDialog's textOpExpr patterns
  const pattern = '%' + search.replace(/([\\%_])/g, '\\$1') + '%'
  const where = search ? ` WHERE v ILIKE ${quoteLiteral(pattern)} ESCAPE '\\'` : ''
  const order = opts.orderBy === 'count' ? 'n DESC, v' : 'v'
  const res = await runQuery(
    `WITH d AS (SELECT coalesce(CAST(${col} AS VARCHAR), '') AS v, count(*) AS n FROM ${quoteIdent(viewName(id))} GROUP BY 1)
     SELECT v, n, count(*) OVER () AS total FROM d${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`
  )
  return {
    values: res.rows.map((r) => ({ v: String(r['v'] ?? ''), n: Number(r['n'] ?? 0) })),
    total: Number(res.rows[0]?.['total'] ?? 0)
  }
}

export async function fieldRange(
  id: string,
  field: string,
  expr?: string
): Promise<{ min: unknown; max: unknown }> {
  const col = expr ? `(${expr})` : quoteIdent(field)
  const res = await runQuery(
    `SELECT min(${col}) AS mn, max(${col}) AS mx FROM ${quoteIdent(viewName(id))}`
  )
  return { min: res.rows[0]?.['mn'], max: res.rows[0]?.['mx'] }
}

/** List tables of an external database without registering a source. */
export async function listDbTables(
  driver: DbDriver,
  connString: string
): Promise<DbTableInfo[]> {
  if (driver !== 'duckdb') await ensureExtension(driver)
  const alias = `probe_${++dbCounter}`
  await exec(
    `ATTACH ${quoteLiteral(connString)} AS ${quoteIdent(alias)} (TYPE ${driver.toUpperCase()}, READ_ONLY)`
  )
  try {
    const res = await runQuery(
      `SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_catalog = ${quoteLiteral(alias)} ORDER BY 1, 2`
    )
    return res.rows.map((r) => ({ schema: String(r['s']), table: String(r['t']) }))
  } finally {
    await exec(`DETACH ${quoteIdent(alias)}`).catch(() => {})
  }
}

export async function listXlsxSheets(path: string): Promise<string[]> {
  // SheetJS with bookSheets reads only the sheet directory (no cell data)
  // and understands both modern .xlsx/.xlsm and legacy .xls
  const XLSX = await loadSheetJs()
  const wb = XLSX.readFile(path, { bookSheets: true })
  return wb.SheetNames
}

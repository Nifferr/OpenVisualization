// DuckDB engine singleton for the main process.
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueryColumn, QueryResult } from '../shared/types'

let instance: DuckDBInstance | null = null
let connection: DuckDBConnection | null = null
const loadedExtensions = new Set<string>()

/**
 * Hard ceiling on rows materialized into JS per query. Shelf queries are
 * LIMITed far below this (adaptive ≤ 50k), so the cap only bites pathological
 * or unbounded SQL — which then degrades to a truncated result instead of
 * exhausting the V8 heap ("Reached heap limit" main-process crash).
 */
export const MAX_RESULT_ROWS = 250_000

export async function getConnection(): Promise<DuckDBConnection> {
  if (!connection) {
    instance = await DuckDBInstance.create(':memory:')
    connection = await instance.connect()
    // spill temp data of large sorts/joins/aggregations to disk instead of RAM
    const tmp = join(tmpdir(), 'openvisualization-duckdb')
    await mkdir(tmp, { recursive: true }).catch(() => {})
    await connection.run(`SET temp_directory = ${sqlPath(tmp)}`).catch(() => {})
    // track query progress (read via connection.progress by execWithProgress);
    // _print=false keeps DuckDB's own terminal bar out of the main-process log
    await connection.run('SET enable_progress_bar = true').catch(() => {})
    await connection.run('SET enable_progress_bar_print = false').catch(() => {})
  }
  return connection
}

/**
 * One statement at a time. DuckDB serializes statements per connection anyway
 * (parallelism lives inside a query), but our streaming reads would be
 * invalidated by another statement starting mid-read — the queue makes each
 * read-until drain completely before the next statement touches the connection.
 */
let statementQueue: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = statementQueue.then(fn, fn)
  statementQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

export async function ensureExtension(name: string): Promise<void> {
  if (loadedExtensions.has(name)) return
  await exec(`INSTALL ${name}; LOAD ${name};`)
  loadedExtensions.add(name)
}

function typeKind(dbType: string): QueryColumn['kind'] {
  const t = dbType.toUpperCase()
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL)/.test(t)) return 'number'
  if (/^(DATE|TIMESTAMP|TIME)/.test(t)) return 'date'
  if (t === 'BOOLEAN') return 'bool'
  if (t === 'VARCHAR' || t.startsWith('ENUM')) return 'string'
  return 'other'
}

export function runQuery(sql: string, maxRows = MAX_RESULT_ROWS): Promise<QueryResult> {
  return enqueue(() => runQueryNow(sql, maxRows))
}

async function runQueryNow(sql: string, maxRows: number): Promise<QueryResult> {
  const conn = await getConnection()
  const start = Date.now()
  // Streaming read-until: materializes at most ~maxRows rows (chunk granularity)
  // instead of the entire result set, so runaway queries cannot OOM the process.
  const reader = await conn.streamAndReadUntil(sql, maxRows + 1)
  const names = reader.columnNames()
  const types = reader.columnTypes()
  const columns: QueryColumn[] = names.map((name, i) => ({
    name,
    kind: typeKind(String(types[i]))
  }))
  // JSON conversion happens in the native binding (single pass, IPC-safe values).
  // BIGINT/HUGEINT/DECIMAL arrive as strings; restore JS numbers where lossless.
  let rows = reader.getRowObjectsJson() as Array<Record<string, unknown>>
  const truncated = rows.length > maxRows
  if (truncated) rows = rows.slice(0, maxRows)
  const numericCols = names.filter((_, i) => columns[i].kind === 'number')
  if (numericCols.length) {
    for (const row of rows) {
      for (const name of numericCols) {
        const v = row[name]
        if (typeof v === 'string') {
          const n = Number(v)
          // keep integer strings beyond 2^53 as strings to preserve precision
          if (Number.isFinite(n) && (Number.isSafeInteger(n) || !Number.isInteger(n))) row[name] = n
        }
      }
    }
  }
  return {
    columns,
    rows,
    rowCount: rows.length,
    sql,
    elapsedMs: Date.now() - start,
    ...(truncated ? { truncated: true } : {})
  }
}

/** Run a statement where no result rows are needed. */
export function exec(sql: string): Promise<void> {
  return enqueue(async () => {
    const conn = await getConnection()
    await conn.run(sql)
  })
}

/**
 * Like exec, but samples DuckDB's query progress while the statement runs.
 * conn.run executes on a libuv worker thread, so a JS-side interval can read
 * connection.progress concurrently (duckdb_query_progress is made for
 * cross-thread reads). Reports a 0..1 fraction; DuckDB returns -1 when it
 * cannot estimate — those samples are skipped.
 */
export function execWithProgress(sql: string, onProgress: (pct: number) => void): Promise<void> {
  return enqueue(async () => {
    const conn = await getConnection()
    const timer = setInterval(() => {
      try {
        const p = conn.progress
        if (p && p.percentage >= 0) onProgress(Math.min(1, p.percentage / 100))
      } catch {
        // no statement running yet / progress unavailable — skip this sample
      }
    }, 250)
    try {
      await conn.run(sql)
    } finally {
      clearInterval(timer)
    }
  })
}

/** Escape a Windows path for use inside a single-quoted SQL literal. */
export function sqlPath(p: string): string {
  return "'" + p.replace(/\\/g, '/').replace(/'/g, "''") + "'"
}

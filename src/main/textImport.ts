// Backend for the unstructured text import wizard.
// sample -> preview (parse sample lines) -> commit (write treated Parquet copy)
import { createReadStream } from 'node:fs'
import { open, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { exec, runQuery, sqlPath } from './duck'
import { quoteIdent, quoteLiteral } from '../shared/sqlBuilder'
import type {
  ImportColumnDef,
  ImportPreview,
  ImportRecipe,
  ImportSample
} from '../shared/types'

const SAMPLE_BYTES = 64 * 1024
const SAMPLE_LINES = 200

export async function sampleFile(path: string): Promise<ImportSample> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(SAMPLE_BYTES)
    const { bytesRead } = await fh.read(buf, 0, SAMPLE_BYTES, 0)
    let encoding: BufferEncoding = 'utf-8'
    let start = 0
    if (bytesRead >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3
    let text = buf.subarray(start, bytesRead).toString(encoding)
    if (text.includes('�')) {
      encoding = 'latin1'
      text = buf.subarray(start, bytesRead).toString(encoding)
    }
    const lines = text.split(/\r?\n/).slice(0, SAMPLE_LINES)
    // drop a possibly truncated last line
    if (bytesRead === SAMPLE_BYTES && lines.length > 1) lines.pop()

    let sniff: ImportSample['sniff']
    try {
      const res = await runQuery(`SELECT * FROM sniff_csv(${sqlPath(path)})`)
      const r = res.rows[0]
      if (r) {
        const colsRaw = String(r['Columns'] ?? '')
        const columns = [...colsRaw.matchAll(/'name'\s*:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
        sniff = {
          delimiter: String(r['Delimiter'] ?? ','),
          quote: String(r['Quote'] ?? '"'),
          hasHeader: String(r['HasHeader'] ?? 'true') === 'true',
          columns
        }
      }
    } catch {
      // not sniffable as CSV; wizard falls back to manual configuration
    }
    return { lines, encoding, sniff }
  } finally {
    await fh.close()
  }
}

function parseDelimitedLine(line: string, delimiter: string, quote: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === quote) {
        if (line[i + 1] === quote) {
          cur += quote
          i++
        } else inQuote = false
      } else cur += ch
    } else if (ch === quote) {
      inQuote = true
    } else if (ch === delimiter) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

function parseLine(recipe: ImportRecipe, line: string): string[] | null {
  switch (recipe.mode) {
    case 'delimited': {
      const delim = recipe.delimiter || ','
      const quote = recipe.quote.slice(0, 1)
      // multi-char delimiter or no quoting: plain split
      if (delim.length > 1 || quote === '') return line.split(delim)
      return parseDelimitedLine(line, delim, quote)
    }
    case 'fixed':
      return recipe.slices.map((s) => line.slice(s.start, s.end).trim())
    case 'regex': {
      try {
        const re = new RegExp(recipe.pattern)
        const m = line.match(re)
        if (!m) return null
        return m.slice(1).map((g) => g ?? '')
      } catch {
        return null
      }
    }
  }
}

/** Infer a column type from sample string values. */
function inferType(values: string[]): ImportColumnDef['type'] {
  const nonEmpty = values.filter((v) => v.trim() !== '')
  if (nonEmpty.length === 0) return 'VARCHAR'
  const ratio = (pred: (v: string) => boolean): number =>
    nonEmpty.filter(pred).length / nonEmpty.length
  if (ratio((v) => /^-?\d+$/.test(v.trim())) >= 0.98) return 'BIGINT'
  if (ratio((v) => /^-?\d*[.,]?\d+([eE][+-]?\d+)?$/.test(v.trim())) >= 0.98) return 'DOUBLE'
  if (ratio((v) => /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) >= 0.98) return 'DATE'
  if (ratio((v) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v.trim())) >= 0.98) return 'TIMESTAMP'
  if (ratio((v) => /^(true|false|0|1|yes|no)$/i.test(v.trim())) >= 0.98) return 'BOOLEAN'
  return 'VARCHAR'
}

export async function previewImport(recipe: ImportRecipe): Promise<ImportPreview> {
  const sample = await sampleFile(recipe.sourcePath)
  let lines = sample.lines.slice(recipe.skipRows)
  let headerNames: string[] | null = null
  if (recipe.mode === 'delimited' && recipe.hasHeader && lines.length) {
    headerNames = parseDelimitedLine(lines[0], recipe.delimiter || ',', recipe.quote || '"')
    lines = lines.slice(1)
  }
  lines = lines.filter((l) => l.trim() !== '')

  const parsed: string[][] = []
  let unmatched = 0
  for (const line of lines) {
    const row = parseLine(recipe, line)
    if (row === null) unmatched++
    else parsed.push(row)
  }
  const nCols = Math.max(0, ...parsed.map((r) => r.length))
  const columns: ImportColumnDef[] = []
  for (let i = 0; i < nCols; i++) {
    const existing = recipe.columns[i]
    const colValues = parsed.map((r) => r[i] ?? '')
    columns.push({
      name:
        existing?.name ??
        (headerNames?.[i]?.trim() || `column_${i + 1}`),
      type: existing?.type ?? inferType(colValues),
      dateFormat: existing?.dateFormat
    })
  }
  return {
    columns,
    rows: parsed.slice(0, 50),
    matchedLines: parsed.length,
    unmatchedLines: unmatched
  }
}

function castExpr(col: ImportColumnDef, raw: string): string {
  switch (col.type) {
    case 'VARCHAR':
      return raw
    case 'DATE':
    case 'TIMESTAMP':
      if (col.dateFormat)
        return `CAST(try_strptime(${raw}, ${quoteLiteral(col.dateFormat)}) AS ${col.type})`
      return `TRY_CAST(${raw} AS ${col.type})`
    default:
      return `TRY_CAST(${raw} AS ${col.type})`
  }
}

export interface CommitResult {
  parquetPath: string
  rowCount: number
}

/** Write the treated copy as Parquet and return its path. */
export async function commitImport(recipe: ImportRecipe): Promise<CommitResult> {
  const dir = join(app.getPath('userData'), 'imports')
  await mkdir(dir, { recursive: true })
  const parquetPath = join(dir, `${randomUUID()}.parquet`)

  if (recipe.mode === 'delimited') {
    // Read positionally (header=false + skip) so wizard renames never break the
    // mapping: DuckDB names positional columns column0..columnN.
    const skip = recipe.skipRows + (recipe.hasHeader ? 1 : 0)
    const opts = [
      `delim = ${quoteLiteral((recipe.delimiter || ',').slice(0, 4))}`,
      `quote = ${quoteLiteral(recipe.quote.slice(0, 1))}`,
      'header = false',
      `skip = ${skip}`,
      'all_varchar = true',
      'ignore_errors = true',
      'null_padding = true'
    ].join(', ')
    const selects = recipe.columns
      .map((c, i) => `${castExpr(c, `"column${i}"`)} AS ${quoteIdent(c.name)}`)
      .join(', ')
    await exec(
      `COPY (SELECT ${selects} FROM read_csv(${sqlPath(recipe.sourcePath)}, ${opts})) TO ${sqlPath(parquetPath)} (FORMAT parquet)`
    )
  } else {
    // fixed-width / regex: stream line by line into a temp table
    const tmp = `import_tmp_${randomUUID().replace(/-/g, '')}`
    const colDefs = recipe.columns.map((c) => `${quoteIdent(c.name)} VARCHAR`).join(', ')
    await exec(`CREATE TEMP TABLE ${tmp} (${colDefs})`)
    const rl = createInterface({
      input: createReadStream(recipe.sourcePath),
      crlfDelay: Infinity
    })
    let skipped = 0
    let batch: string[] = []
    const flush = async (): Promise<void> => {
      if (!batch.length) return
      await exec(`INSERT INTO ${tmp} VALUES ${batch.join(', ')}`)
      batch = []
    }
    for await (const line of rl) {
      if (skipped < recipe.skipRows) {
        skipped++
        continue
      }
      if (line.trim() === '') continue
      const row = parseLine(recipe, line)
      if (!row) continue
      const padded = recipe.columns.map((_c, i) => quoteLiteral(row[i] ?? ''))
      batch.push(`(${padded.join(', ')})`)
      if (batch.length >= 500) await flush()
    }
    await flush()
    const selects = recipe.columns
      .map((c) => `${castExpr(c, quoteIdent(c.name))} AS ${quoteIdent(c.name)}`)
      .join(', ')
    await exec(`COPY (SELECT ${selects} FROM ${tmp}) TO ${sqlPath(parquetPath)} (FORMAT parquet)`)
    await exec(`DROP TABLE ${tmp}`)
  }

  const cnt = await runQuery(`SELECT count(*) AS c FROM read_parquet(${sqlPath(parquetPath)})`)
  return { parquetPath, rowCount: Number(cnt.rows[0]?.['c'] ?? 0) }
}

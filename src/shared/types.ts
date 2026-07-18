// Shared model types used by main, preload and renderer.
// This module must stay pure TypeScript: no Electron, no Node imports.

import { fixLegacyEmailUserExpr } from './emailEnrichment'

// ---------- Data sources ----------

/**
 * 'xls' covers legacy Excel (.xls/.xlsm): the main process converts the chosen
 * sheet to a temp CSV via SheetJS at registration time (DuckDB's excel
 * extension and exceljs only read modern .xlsx).
 */
export type FileFormat = 'csv' | 'json' | 'parquet' | 'xlsx' | 'xls'

/** duckdb attaches native .duckdb files; the others go through DuckDB extensions */
export type DbDriver = 'postgres' | 'mysql' | 'sqlite' | 'duckdb'

export type DataSourceDef =
  | {
      kind: 'file'
      id: string
      name: string
      path: string
      format: FileFormat
      sheet?: string
      /**
       * Expose a synthetic `row_id` column (row_number over the reader) on the
       * registered view, so derived entity tables can join back to the exact
       * source row. Stable for file readers (DuckDB preserves insertion
       * order); DB-backed sources should prefer a real key column.
       */
      withRowId?: boolean
    }
  | {
      kind: 'db'
      id: string
      name: string
      driver: DbDriver
      /** libpq-style string for postgres/mysql, file path for sqlite/duckdb */
      connString: string
      schema?: string
      table: string
      withRowId?: boolean
    }
  | {
      kind: 'url'
      id: string
      name: string
      url: string
      format: 'csv' | 'json' | 'parquet'
      withRowId?: boolean
    }
  | {
      kind: 'treated'
      id: string
      name: string
      /** parquet file produced by the text import wizard */
      parquetPath: string
      recipe: ImportRecipe
      withRowId?: boolean
    }
  | {
      kind: 'join'
      id: string
      name: string
      leftId: string
      rightId: string
      joinType: 'inner' | 'left' | 'right' | 'full' | 'cross'
      /** field pairs; empty for cross join */
      keys: Array<{ left: string; right: string }>
    }
  | {
      kind: 'wordcloud'
      id: string
      name: string
      /** data source the text field is tokenized from */
      sourceId: string
      field: string
      /** 'regex' treats delimiter as a RE2 pattern (string_split_regex); 'literal' splits on it verbatim (string_split) */
      delimiterMode: 'regex' | 'literal'
      delimiter: string
      /** lowercase the field before splitting */
      caseFold: boolean
      /** drop tokens shorter than this many characters */
      minLength: number
      /** drop common English/Portuguese stopwords (a, the, de, para, …) */
      stopwords: boolean
    }
  | {
      kind: 'entities'
      id: string
      name: string
      /** data source whose text columns are scanned */
      sourceId: string
      /** text columns to extract entities from */
      fields: string[]
      /** extraction patterns; `label` doubles as the entity_type value, `id` selects the normalizer */
      patterns: Array<{ id: string; label: string; pattern: string }>
      /**
       * Canonicalize each match per pattern type so variants group together
       * (digits-only for CPF/CNPJ/telefone…, lowercase for e-mail/hashes,
       * uppercase for placa/IBAN). The raw match is kept in `entity_raw`.
       */
      normalize: boolean
      /**
       * Resolved SQL expression per scanned field that is a CALCULATED field
       * (not a real column of the source view). The main process inlines
       * these when building the extraction SQL. Absent for raw columns.
       */
      fieldExprs?: Record<string, string>
      /**
       * Source column carried into every entity row as `source_id` (the
       * back-reference for joining entities to their original row) — either a
       * real key column or the synthetic `row_id` added via `withRowId`.
       * Absent: `source_id` falls back to a row_number computed only inside
       * the extraction (rows are still grouped per source row, but an in-app
       * join back is not possible).
       */
      idField?: string
      /** display name of the origin source at extraction time → constant `source_table` column */
      sourceTable?: string
    }
  | {
      kind: 'emails'
      id: string
      name: string
      /** original mail archive (.pst/.ost/.nsf/.zdb/.bak) */
      path: string
      /**
       * Parquet with one row per message, produced by ingestEmailArchive in
       * the main process (emailImport.ts). The registered view reads this;
       * if the file is missing at registration the archive is re-ingested.
       */
      parquetPath: string
      /**
       * How the archive was read: 'pst' = structured MAPI walk (Outlook
       * PST/OST via pst-extractor), 'carved' = raw RFC-822 byte carving
       * (NSF/ZDB/BAK and corrupted files).
       */
      format: 'pst' | 'carved'
      withRowId?: boolean
    }

export type FieldRole = 'dimension' | 'measure'

export interface FieldInfo {
  name: string
  /** DuckDB logical type, e.g. VARCHAR, BIGINT, TIMESTAMP */
  dbType: string
  kind: 'string' | 'number' | 'date' | 'bool' | 'other'
  role: FieldRole
}

// ---------- Text import wizard ----------

export interface ImportColumnDef {
  name: string
  /** target DuckDB type */
  type: 'VARCHAR' | 'BIGINT' | 'DOUBLE' | 'DATE' | 'TIMESTAMP' | 'BOOLEAN'
  /** strptime format for DATE/TIMESTAMP parsed from text */
  dateFormat?: string
}

export type ImportRecipe =
  | {
      mode: 'delimited'
      sourcePath: string
      delimiter: string
      quote: string
      hasHeader: boolean
      skipRows: number
      columns: ImportColumnDef[]
    }
  | {
      mode: 'fixed'
      sourcePath: string
      skipRows: number
      /** [start, end) character slices */
      slices: Array<{ start: number; end: number }>
      columns: ImportColumnDef[]
    }
  | {
      mode: 'regex'
      sourcePath: string
      skipRows: number
      /** pattern with capture groups; one column per group */
      pattern: string
      columns: ImportColumnDef[]
    }

// ---------- Shelf model ----------

export type Agg =
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'count'
  | 'count_distinct'
  | 'median'
  | 'p10'
  | 'p25'
  | 'p75'
  | 'p90'
  | 'p95'
  | 'stddev'
  | 'variance'

export type DateBin = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute'

export interface TopNSpec {
  n: number
  byField: string
  byAgg: Agg
  others: boolean
  /** default 'top' */
  direction?: 'top' | 'bottom'
  /** 'count' keeps N values, 'percent' keeps the top n% of values; default 'count' */
  mode?: 'count' | 'percent'
}

/**
 * Post-aggregation transform applied to a measure's plotted series, in the
 * order the categories/marks are drawn (Tableau's "table calculation"
 * concept). Computed client-side over the already-aggregated result — see
 * `applyTableCalc` in optionBuilder.ts.
 */
export type TableCalcKind = 'runningTotal' | 'movingAvg' | 'rank' | 'percentOfTotal' | 'difference'

export interface TableCalcSpec {
  kind: TableCalcKind
  /** window size for movingAvg (default 3); ignored otherwise */
  window?: number
  /** rank direction: 'desc' (default, highest value = rank 1) or 'asc' */
  direction?: 'asc' | 'desc'
}

export interface FieldRef {
  /** column name, calc field name, or '*' for Number of Records */
  field: string
  role: FieldRole
  agg?: Agg
  dateBin?: DateBin
  numBin?: { size: number }
  topN?: TopNSpec
  sort?: 'asc' | 'desc' | 'valueAsc' | 'valueDesc'
  /** measure-only: running total / moving avg / rank / % of total / difference */
  tableCalc?: TableCalcSpec
  /** measure-only, 'combo' chart type: which y-axis this measure plots against (default: 1st measure -> 1, rest -> 2) */
  axis?: 1 | 2
  /** measure-only, 'combo' chart type: mark type for this measure (default: 1st measure -> bar, rest -> line) */
  seriesType?: 'bar' | 'line'
}

export type Filter =
  | { kind: 'in'; field: string; values: string[]; exclude?: boolean }
  | { kind: 'range'; field: string; min?: number; max?: number }
  | { kind: 'dateRange'; field: string; from?: string; to?: string }
  | { kind: 'expr'; expr: string }

export type ChartType =
  | 'table'
  | 'bar'
  | 'barh'
  | 'stackedBar'
  | 'percentBar'
  | 'line'
  | 'area'
  | 'stackedArea'
  | 'scatter'
  | 'bubble'
  | 'pie'
  | 'donut'
  | 'rose'
  | 'heatmap'
  | 'treemap'
  | 'sunburst'
  | 'sankey'
  | 'funnel'
  | 'gauge'
  | 'radar'
  | 'boxplot'
  | 'calendar'
  | 'candlestick'
  | 'waterfall'
  | 'pareto'
  | 'themeriver'
  | 'parallel'
  | 'graph'
  | 'tree'
  | 'wordcloud'
  | 'map'
  | 'combo'
  | 'stepLine'
  | 'effectScatter'
  | 'stackedBarH'
  | 'percentBarH'
  | 'smoothLine'
  | 'polarBar'
  | 'lollipop'
  | 'rangeBar'
  | 'bullet'
  | 'kpi'
  | 'pictorial'
  | 'pyramid'
  | 'halfDonut'
  | 'mapPoints'
  | 'mapFlow'
  | 'graphCircular'
  | 'treeRadial'

export interface CalcField {
  name: string
  /** DuckDB SQL expression over base columns */
  expr: string
  role: FieldRole
  /**
   * Explicit output type override (e.g. reinterpret a text expression as
   * TIMESTAMP). Unset (legacy fields, or a field before the user picks a
   * type) falls back to the role default: measure -> number, dimension ->
   * string. See `calcFieldKind`/`calcFieldSql` in sqlBuilder.ts.
   */
  kind?: FieldInfo['kind']
  /**
   * strptime format used when `kind` is 'date' and the text isn't in
   * DuckDB's default ISO-ish parseable form (e.g. '%d/%m/%Y' for dd/mm/yyyy).
   * Ignored for every other kind. Unset falls back to a plain TRY_CAST, which
   * only understands ISO-like text.
   */
  dateFormat?: string
}

/** A horizontal reference/trend line drawn across a cartesian chart. */
export interface ReferenceLine {
  /** index into the shelf's measures (collectRefs order); default 0 */
  measureIdx?: number
  kind: 'average' | 'median' | 'min' | 'max' | 'constant'
  /** only used when kind === 'constant' */
  value?: number
  label?: string
  color?: string
}

/** Value-based mark coloring (Tableau-style conditional formatting). First matching rule wins. */
export interface ColorRule {
  /** index into the shelf's measures (collectRefs order) this rule tests */
  measureIdx: number
  op: '>' | '>=' | '<' | '<=' | '=' | '!='
  value: number
  color: string
}

export interface ShelfState {
  dataSourceId: string
  rows: FieldRef[]
  columns: FieldRef[]
  color?: FieldRef
  size?: FieldRef
  label?: FieldRef
  tooltip: FieldRef[]
  filters: Filter[]
  chartType: ChartType
  limit?: number
  referenceLines?: ReferenceLine[]
  colorRules?: ColorRule[]
}

// ---------- Query results ----------

export interface QueryColumn {
  name: string
  kind: 'string' | 'number' | 'date' | 'bool' | 'other'
}

export interface QueryResult {
  columns: QueryColumn[]
  rows: Array<Record<string, unknown>>
  rowCount: number
  sql: string
  elapsedMs: number
  /** true when the engine cut the result at the hard row cap (safety net) */
  truncated?: boolean
}

// ---------- Workbook ----------

export interface Worksheet {
  id: string
  name: string
  shelf: ShelfState
  title?: string
}

/**
 * Interactive filter card pinned to a dashboard. The current selection is
 * applied to every worksheet tile on the same data source (injected like a
 * dataset filter, but scoped to this dashboard only) and travels with the
 * standalone HTML export, where it stays interactive.
 */
export interface DashFilterCard {
  /** data source the filter applies to */
  dsId: string
  field: string
  /** control shape: 'in' = value checklist, 'range' = numeric min/max, 'dateRange' = date pickers */
  mode: 'in' | 'range' | 'dateRange'
  /** display label; defaults to the field name */
  label?: string
  /** 'in' mode: selected values ('' = blank); empty/unset = not filtering */
  values?: string[]
  /** 'range' mode */
  min?: number
  max?: number
  /** 'dateRange' mode (yyyy-mm-dd) */
  from?: string
  to?: string
}

export interface DashboardTile {
  id: string
  worksheetId?: string
  /** markdown-ish text tile when no worksheetId/filter */
  text?: string
  /** interactive filter card when set */
  filter?: DashFilterCard
  /** header title override (defaults to the worksheet name) */
  title?: string
  /** hide the header bar so the chart fills the whole tile */
  hideHead?: boolean
  /** accent color drawn as the tile's header bar edge */
  accent?: string
  x: number
  y: number
  w: number
  h: number
}

export interface Dashboard {
  id: string
  name: string
  tiles: DashboardTile[]
}

export interface Workbook {
  opvxVersion: 2
  meta: { title: string; createdAt: string; modifiedAt: string }
  dataSources: DataSourceDef[]
  fieldOverrides: Record<string, Record<string, { role?: FieldRole; label?: string }>>
  calculatedFields: Record<string, CalcField[]>
  /** dataset-level filters per data source id, applied to every query on that source (v2) */
  sourceFilters: Record<string, Filter[]>
  worksheets: Worksheet[]
  dashboards: Dashboard[]
}

export function emptyWorkbook(): Workbook {
  const now = new Date().toISOString()
  return {
    opvxVersion: 2,
    meta: { title: 'Untitled Workbook', createdAt: now, modifiedAt: now },
    dataSources: [],
    fieldOverrides: {},
    calculatedFields: {},
    sourceFilters: {},
    worksheets: [],
    dashboards: []
  }
}

/**
 * Upgrade older documents to the current schema. v1 → v2 adds sourceFilters.
 * Legacy `.otwb` files carry the version in `otwbVersion`; it is accepted and
 * rewritten to `opvxVersion` so re-saving produces a current `.opvx` document.
 */
export function migrateWorkbook(wbRaw: Workbook): Workbook {
  const { otwbVersion, ...wb } = wbRaw as Workbook & { otwbVersion?: number }
  const version = (wb.opvxVersion as number | undefined) ?? otwbVersion ?? 0
  if (version > 2) throw new Error(`Workbook version ${version} is newer than this app supports`)
  // v0.10.0 saved calc fields with a correlated-unnest expression DuckDB
  // rejects; rewrite them to the current scalar list form on open
  const calculatedFields: Workbook['calculatedFields'] = {}
  for (const [dsId, list] of Object.entries(wb.calculatedFields ?? {})) {
    calculatedFields[dsId] = list.map((c) => ({ ...c, expr: fixLegacyEmailUserExpr(c.expr) }))
  }
  return { ...wb, opvxVersion: 2, calculatedFields, sourceFilters: wb.sourceFilters ?? {} }
}

// ---------- Export payloads ----------

/** One dashboard tile serialized for the standalone HTML export (24-col grid units). */
export type ExportTile =
  | {
      kind: 'chart'
      title: string
      option: string
      x: number
      y: number
      w: number
      h: number
      hideHead?: boolean
      accent?: string
      /** JSON ChartDetailPayload (exportInteractive.ts); present = re-filterable client-side */
      detail?: string
    }
  | { kind: 'text'; text: string; x: number; y: number; w: number; h: number; accent?: string }
  | {
      kind: 'table'
      title: string
      columns: string[]
      rows: string[][]
      x: number
      y: number
      w: number
      h: number
      hideHead?: boolean
      accent?: string
      /** JSON ChartDetailPayload; present = table body re-filterable client-side */
      detail?: string
      /** row cap applied when the table is rebuilt client-side */
      maxRows?: number
    }
  | {
      kind: 'filter'
      /** id the chart payloads' filter bindings reference */
      cardId: string
      label: string
      mode: 'in' | 'range' | 'dateRange'
      x: number
      y: number
      w: number
      h: number
      accent?: string
      /** 'in': the selectable values with their row counts (top slice by count) */
      values?: Array<{ v: string; n: number }>
      /** 'in': initially selected values */
      selected?: string[]
      /** 'range'/'dateRange': initial bounds */
      min?: number
      max?: number
      from?: string
      to?: string
      /** 'range': data extent used as input placeholders */
      rangeLo?: number
      rangeHi?: number
    }

/** One block of a PDF export: a rendered chart image, a text note or a data table. */
export interface PdfSection {
  title?: string
  /** PNG data URL (light-themed render) */
  png?: string
  text?: string
  table?: { columns: string[]; rows: string[][] }
}

// ---------- IPC payloads ----------

export interface DescribeResult {
  fields: FieldInfo[]
  rowCount: number
}

/**
 * Long-running-operation progress pushed main → renderer over the
 * `op:progress` channel (the only push channel; everything else is
 * invoke/handle). Consumers key bars by `key` and drop them on `done`.
 * Keys in use: `ds:<id>` (entity table materialization),
 * `emails:<path>` (mail archive ingestion), `eml:<dsId>` (EML export).
 */
export interface OpProgress {
  key: string
  /** human label, e.g. 'Extracting entities — Tickets' */
  label: string
  /** 0..1 fraction; null = indeterminate (bar animates without a fill %) */
  pct: number | null
  /** optional counter text, e.g. '1,200 of 5,000 messages' */
  detail?: string
  /** final event for this key — remove the bar */
  done?: boolean
}

export interface EmailIngestResult {
  parquetPath: string
  /** 'pst' = structured MAPI walk; 'carved' = raw RFC-822 recovery scan */
  format: 'pst' | 'carved'
  rowCount: number
  /** non-fatal problems (corrupted folders, unreadable items, fallbacks) */
  warnings: string[]
}

export interface EmlExportResult {
  folder: string
  written: number
  failed: number
}

export interface ImportSample {
  lines: string[]
  encoding: string
  sniff?: { delimiter: string; quote: string; hasHeader: boolean; columns: string[] }
}

export interface ImportPreview {
  columns: ImportColumnDef[]
  rows: string[][]
  matchedLines: number
  unmatchedLines: number
}

export interface DbTableInfo {
  schema: string
  table: string
}

export interface DistinctValuesOptions {
  /** SQL expression backing a calculated field (not a real view column) */
  expr?: string
  /** substring match (case-insensitive) applied server-side over ALL distinct values */
  search?: string
  offset?: number
  /** page size; the server clamps this to a sane maximum */
  limit?: number
  orderBy?: 'value' | 'count'
}

export interface DistinctValue {
  /** the value as text; '' stands for blank (empty string or NULL) */
  v: string
  /** number of source rows carrying this value */
  n: number
}

export interface DistinctValuesResult {
  values: DistinctValue[]
  /** total distinct values matching the search (not just this page) */
  total: number
}

export const AGG_LABELS: Record<Agg, string> = {
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  count: 'Count',
  count_distinct: 'Count Distinct',
  median: 'Median',
  p10: 'Percentile 10',
  p25: 'Percentile 25',
  p75: 'Percentile 75',
  p90: 'Percentile 90',
  p95: 'Percentile 95',
  stddev: 'Std Dev',
  variance: 'Variance'
}

export const TABLE_CALC_LABELS: Record<TableCalcKind, string> = {
  runningTotal: 'Running Total',
  movingAvg: 'Moving Average',
  rank: 'Rank',
  percentOfTotal: '% of Total',
  difference: 'Difference'
}

export const DATE_BIN_LABELS: Record<DateBin, string> = {
  year: 'Year',
  quarter: 'Quarter',
  month: 'Month',
  week: 'Week',
  day: 'Day',
  hour: 'Hour',
  minute: 'Minute'
}

/** Kinds a calculated field's type can be explicitly set to ('other' is an inferred-only catch-all, not user-facing). */
export type CalcKind = 'string' | 'number' | 'date' | 'bool'

export const FIELD_KIND_LABELS: Record<CalcKind, string> = {
  string: 'Text',
  number: 'Number',
  date: 'Date/Time',
  bool: 'Boolean'
}

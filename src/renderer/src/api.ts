// Typed wrapper over the preload bridge.
import type {
  DataSourceDef,
  DbTableInfo,
  DescribeResult,
  DistinctValuesOptions,
  DistinctValuesResult,
  EmailIngestResult,
  EmlExportResult,
  ExportTile,
  ImportPreview,
  ImportRecipe,
  ImportSample,
  OpProgress,
  PdfSection,
  QueryResult
} from '@shared/types'

interface RawApi {
  runQuery(sql: string): Promise<QueryResult>
  registerDataSource(def: DataSourceDef): Promise<DescribeResult>
  removeDataSource(id: string): Promise<void>
  describeDataSource(id: string): Promise<DescribeResult>
  previewDataSource(id: string, offset: number, limit: number): Promise<QueryResult>
  distinctValues(id: string, field: string, opts?: DistinctValuesOptions): Promise<DistinctValuesResult>
  fieldRange(id: string, field: string, expr?: string): Promise<{ min: unknown; max: unknown }>
  listDbTables(driver: string, connString: string): Promise<DbTableInfo[]>
  listXlsxSheets(path: string): Promise<string[]>
  importSample(path: string): Promise<ImportSample>
  importPreview(recipe: ImportRecipe): Promise<ImportPreview>
  importCommit(recipe: ImportRecipe): Promise<{ parquetPath: string; rowCount: number }>
  /** parse a mail archive (PST/OST/NSF/ZDB/BAK) into a Parquet of messages */
  ingestEmails(path: string): Promise<EmailIngestResult>
  /** write the (optionally filtered) messages of an emails source as .eml files */
  exportEml(dsId: string, whereSql: string): Promise<EmlExportResult | null>
  exportData(sql: string, format: string, name: string): Promise<string | null>
  exportImage(data: string, format: string, name: string): Promise<string | null>
  exportPdf(title: string, sections: PdfSection[], name: string): Promise<string | null>
  exportHtml(
    title: string,
    tiles: ExportTile[],
    name: string,
    worldMapJson?: string
  ): Promise<string | null>
  pickFile(
    filters: Array<{ name: string; extensions: string[] }>
  ): Promise<{ path: string; name: string; ext: string } | null>
  saveWorkbook(json: string, existingPath: string | null): Promise<string | null>
  openWorkbook(): Promise<{ path: string; json: string } | null>
  pathForFile(file: File): string
  /** subscribe to long-running-op progress pushed from main; returns unsubscribe */
  onProgress(cb: (p: OpProgress) => void): () => void
}

export const api = (window as unknown as { api: RawApi }).api

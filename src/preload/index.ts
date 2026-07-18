import { contextBridge, ipcRenderer, webUtils } from 'electron'

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke(channel, ...args)

const api = {
  runQuery: (sql: string) => invoke('query:run', sql),
  registerDataSource: (def: unknown) => invoke('ds:register', def),
  removeDataSource: (id: string) => invoke('ds:remove', id),
  describeDataSource: (id: string) => invoke('ds:describe', id),
  previewDataSource: (id: string, offset: number, limit: number) =>
    invoke('ds:preview', id, offset, limit),
  distinctValues: (id: string, field: string, opts?: unknown) => invoke('ds:distinct', id, field, opts),
  fieldRange: (id: string, field: string, expr?: string) => invoke('ds:range', id, field, expr),
  listDbTables: (driver: string, connString: string) => invoke('db:listTables', driver, connString),
  listXlsxSheets: (path: string) => invoke('xlsx:sheets', path),
  importSample: (path: string) => invoke('import:sample', path),
  importPreview: (recipe: unknown) => invoke('import:preview', recipe),
  importCommit: (recipe: unknown) => invoke('import:commit', recipe),
  ingestEmails: (path: string) => invoke('emails:ingest', path),
  exportEml: (dsId: string, whereSql: string) => invoke('export:eml', dsId, whereSql),
  exportData: (sql: string, format: string, name: string) => invoke('export:data', sql, format, name),
  exportImage: (data: string, format: string, name: string) => invoke('export:image', data, format, name),
  exportPdf: (title: string, sections: unknown, name: string) => invoke('export:pdf', title, sections, name),
  exportHtml: (title: string, tiles: unknown, name: string, worldMapJson?: string) =>
    invoke('export:html', title, tiles, name, worldMapJson),
  pickFile: (filters: Array<{ name: string; extensions: string[] }>) => invoke('file:pick', filters),
  saveWorkbook: (json: string, existingPath: string | null) =>
    invoke('workbook:save', json, existingPath),
  openWorkbook: () => invoke('workbook:open'),
  /** resolve the real filesystem path of a File dropped onto the window */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  /** subscribe to main-process progress pushes (op:progress); returns unsubscribe */
  onProgress: (cb: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown): void => cb(p)
    ipcRenderer.on('op:progress', listener)
    return () => {
      ipcRenderer.removeListener('op:progress', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type PreloadApi = typeof api

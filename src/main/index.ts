import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { join, basename, extname } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { setFlagsFromString } from 'node:v8'

// BI result sets are legitimately large: raise the V8 old-space ceiling from
// the ~2 GB default in both processes before any allocation-heavy work runs.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096')
setFlagsFromString('--max-old-space-size=4096')

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason)
})
import { runQuery } from './duck'
import {
  describeDataSource,
  distinctValues,
  fieldRange,
  listDbTables,
  listXlsxSheets,
  previewDataSource,
  registerDataSource,
  removeDataSource
} from './datasources'
import { commitImport, previewImport, sampleFile } from './textImport'
import { ingestEmailArchive } from './emailImport'
import { exportData, exportEml, exportHtml, exportImage, exportPdf, type DataExportFormat } from './exports'
import type {
  DataSourceDef,
  DbDriver,
  DistinctValuesOptions,
  ExportTile,
  ImportRecipe,
  PdfSection
} from '../shared/types'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'OpenVisualization',
    backgroundColor: '#1e1f24',
    icon: join(__dirname, '../../resources/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  // Renderer console errors reach the terminal, so a white screen is diagnosable
  // from the dev/server logs instead of requiring devtools.
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') {
      const loc = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : ''
      console.error(`[renderer]${loc}`, details.message)
    }
  })
  // Renderer crash (OOM, GPU, native fault): offer a reload instead of leaving
  // a dead window. Data sources re-register when the workbook is reopened.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    console.error('[main] renderer gone:', details.reason)
    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: 'OpenVisualization',
        message: `The window crashed (${details.reason}).`,
        detail: 'Reload to continue. Unsaved workbook changes are lost — reopen your workbook file after reloading.',
        buttons: ['Reload', 'Quit'],
        defaultId: 0
      })
      .then(({ response }) => {
        if (response === 0) win.webContents.reload()
        else app.quit()
      })
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const ENC_PREFIX = 'enc:v1:'

/**
 * Encrypts/decrypts `connString` of db sources inside the workbook JSON so
 * passwords never hit disk in plain text. Uses the OS keychain (DPAPI on
 * Windows) via safeStorage; the envelope is `enc:v1:<base64>`. Legacy files
 * with plain connStrings pass through decrypt untouched, and if the OS
 * keychain is unavailable or the ciphertext came from another machine the
 * original value is kept rather than failing the save/open.
 */
function transformConnStrings(json: string, mode: 'encrypt' | 'decrypt'): string {
  try {
    const wb = JSON.parse(json)
    if (!Array.isArray(wb?.dataSources)) return json
    for (const ds of wb.dataSources) {
      if (ds?.kind !== 'db' || typeof ds.connString !== 'string') continue
      if (mode === 'encrypt') {
        if (ds.connString.startsWith(ENC_PREFIX) || !safeStorage.isEncryptionAvailable()) continue
        ds.connString = ENC_PREFIX + safeStorage.encryptString(ds.connString).toString('base64')
      } else if (ds.connString.startsWith(ENC_PREFIX)) {
        try {
          ds.connString = safeStorage.decryptString(
            Buffer.from(ds.connString.slice(ENC_PREFIX.length), 'base64')
          )
        } catch {
          // Ciphertext from another machine/user profile: keep the envelope;
          // the source will fail to connect and can be re-added.
        }
      }
    }
    return JSON.stringify(wb, null, 2)
  } catch {
    return json
  }
}

function wrap<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>
): (event: Electron.IpcMainInvokeEvent, ...args: T) => Promise<R> {
  return async (_event, ...args) => fn(...args)
}

app.whenReady().then(() => {
  ipcMain.handle('query:run', wrap(async (sql: string) => runQuery(sql)))

  ipcMain.handle('ds:register', wrap(async (def: DataSourceDef) => registerDataSource(def)))
  ipcMain.handle('ds:remove', wrap(async (id: string) => removeDataSource(id)))
  ipcMain.handle('ds:describe', wrap(async (id: string) => describeDataSource(id)))
  ipcMain.handle(
    'ds:preview',
    wrap(async (id: string, offset: number, limit: number) => previewDataSource(id, offset, limit))
  )
  ipcMain.handle(
    'ds:distinct',
    wrap(async (id: string, field: string, opts?: DistinctValuesOptions) =>
      distinctValues(id, field, opts)
    )
  )
  ipcMain.handle(
    'ds:range',
    wrap(async (id: string, field: string, expr?: string) => fieldRange(id, field, expr))
  )
  ipcMain.handle(
    'db:listTables',
    wrap(async (driver: DbDriver, connString: string) => listDbTables(driver, connString))
  )
  ipcMain.handle('xlsx:sheets', wrap(async (path: string) => listXlsxSheets(path)))

  ipcMain.handle('import:sample', wrap(async (path: string) => sampleFile(path)))
  ipcMain.handle('import:preview', wrap(async (recipe: ImportRecipe) => previewImport(recipe)))
  ipcMain.handle('import:commit', wrap(async (recipe: ImportRecipe) => commitImport(recipe)))

  ipcMain.handle('emails:ingest', wrap(async (path: string) => ingestEmailArchive(path)))
  ipcMain.handle(
    'export:eml',
    wrap(async (dsId: string, whereSql: string) => exportEml(dsId, whereSql))
  )

  ipcMain.handle(
    'export:data',
    wrap(async (sql: string, format: DataExportFormat, name: string) => exportData(sql, format, name))
  )
  ipcMain.handle(
    'export:image',
    wrap(async (data: string, format: 'png' | 'svg', name: string) => exportImage(data, format, name))
  )
  ipcMain.handle(
    'export:pdf',
    wrap(async (title: string, sections: PdfSection[], name: string) => exportPdf(title, sections, name))
  )
  ipcMain.handle(
    'export:html',
    wrap(
      async (title: string, tiles: ExportTile[], name: string, worldMapJson?: string) =>
        exportHtml(title, tiles, name, worldMapJson)
    )
  )

  ipcMain.handle('file:pick', async (event, filters: Electron.FileFilter[]) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
    if (res.canceled || res.filePaths.length === 0) return null
    const p = res.filePaths[0]
    return { path: p, name: basename(p, extname(p)), ext: extname(p).toLowerCase() }
  })

  ipcMain.handle('workbook:save', async (event, json: string, existingPath: string | null) => {
    let path = existingPath
    if (!path) {
      const win = BrowserWindow.fromWebContents(event.sender)!
      const res = await dialog.showSaveDialog(win, {
        defaultPath: 'workbook.opvx',
        filters: [{ name: 'OpenVisualization Workbook', extensions: ['opvx'] }]
      })
      if (res.canceled || !res.filePath) return null
      path = res.filePath
    }
    await writeFile(path, transformConnStrings(json, 'encrypt'), 'utf-8')
    return path
  })

  ipcMain.handle('workbook:open', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'OpenVisualization Workbook', extensions: ['opvx', 'otwb'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    const json = await readFile(res.filePaths[0], 'utf-8')
    return { path: res.filePaths[0], json: transformConnStrings(json, 'decrypt') }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

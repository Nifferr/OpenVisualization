import { useCallback, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, nextId } from './store'
import { api } from './api'
import { StartPage, DbDialog } from './components/StartPage'
import { DataSourcePage } from './components/DataSourcePage'
import { WorksheetPage } from './components/WorksheetPage'
import { DashboardPage } from './components/DashboardPage'
import { ImportWizard } from './components/ImportWizard'
import { ExcelImportDialog } from './components/ExcelImportDialog'
import { EmailImportDialog } from './components/EmailImportDialog'
import { ProgressBar } from './components/ProgressBar'
import type { DataSourceDef, DbDriver, FileFormat, Workbook } from '@shared/types'

const STRUCTURED_EXT: Record<string, FileFormat> = {
  '.csv': 'csv',
  '.tsv': 'csv',
  '.json': 'json',
  '.ndjson': 'json',
  '.parquet': 'parquet'
}

/** Excel files get a sheet picker; legacy formats convert via SheetJS in main. */
const EXCEL_EXT: Record<string, 'xlsx' | 'xls'> = {
  '.xlsx': 'xlsx',
  '.xls': 'xls',
  '.xlsm': 'xls'
}

/** Database files open the connection dialog pre-filled with a table picker. */
const DB_EXT: Record<string, DbDriver> = {
  '.db': 'sqlite',
  '.sqlite': 'sqlite',
  '.sqlite3': 'sqlite',
  '.s3db': 'sqlite',
  '.duckdb': 'duckdb',
  '.ddb': 'duckdb'
}

/**
 * Mail archives open the e-mail import dialog (MAPI walk for PST/OST,
 * raw RFC-822 carving for the rest — including corrupted files).
 * .bak is routed here deliberately: in practice it is almost always a
 * renamed mail store, and the importer falls back to carving anyway.
 */
const EMAIL_EXT = new Set(['.pst', '.ost', '.nsf', '.zdb', '.bak'])

export interface ExcelDrop {
  path: string
  name: string
  format: 'xlsx' | 'xls'
}

export function App(): React.JSX.Element {
  // narrow subscription: status churn (every query) must not re-render the
  // whole page tree — the status bar subscribes to it separately below
  const { page, dirty, workbookPath, canUndo, canRedo } = useApp(
    useShallow((s) => ({
      page: s.page,
      dirty: s.dirty,
      workbookPath: s.workbookPath,
      canUndo: s.canUndo,
      canRedo: s.canRedo
    }))
  )
  const [wizardPath, setWizardPath] = useState<string | null>(null)
  const [excelDrop, setExcelDrop] = useState<ExcelDrop | null>(null)
  const [dbDrop, setDbDrop] = useState<{ driver: DbDriver; connString: string } | null>(null)
  const [emailDrop, setEmailDrop] = useState<{ path: string; name: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)

  /**
   * Route a file to the right intake by extension: structured formats register
   * directly, Excel opens a sheet picker (single-sheet files skip it), database
   * files open the pre-filled table picker, everything else goes to the text
   * import wizard.
   */
  const addFileSource = useCallback(async (path: string, name: string, ext: string) => {
    const s = useApp.getState()
    const excel = EXCEL_EXT[ext]
    if (excel) {
      try {
        s.setStatus(`Reading sheets of ${name}…`)
        const sheets = await api.listXlsxSheets(path)
        if (sheets.length > 1) {
          s.setStatus(`${name}: ${sheets.length} sheets`)
          setExcelDrop({ path, name, format: excel })
          return
        }
        const def: DataSourceDef = {
          kind: 'file', id: nextId('f'), name, path, format: excel, sheet: sheets[0]
        }
        const desc = await api.registerDataSource(def)
        s.addDataSource(def, desc.fields, desc.rowCount)
        s.setStatus(`Loaded ${name} (${desc.rowCount.toLocaleString()} rows)`)
      } catch (e) {
        s.setStatus(`Failed to read ${name}: ${e instanceof Error ? e.message : e}`)
      }
      return
    }
    const dbDriver = DB_EXT[ext]
    if (dbDriver) {
      setDbDrop({ driver: dbDriver, connString: path })
      return
    }
    if (EMAIL_EXT.has(ext)) {
      setEmailDrop({ path, name })
      return
    }
    const format = STRUCTURED_EXT[ext]
    if (!format) {
      setWizardPath(path)
      return
    }
    try {
      s.setStatus(`Loading ${name}...`)
      const def: DataSourceDef = { kind: 'file', id: nextId('f'), name, path, format }
      const desc = await api.registerDataSource(def)
      s.addDataSource(def, desc.fields, desc.rowCount)
      s.setStatus(`Loaded ${name} (${desc.rowCount.toLocaleString()} rows)`)
    } catch (e) {
      s.setStatus(`Failed to load ${name}: ${e instanceof Error ? e.message : e}`)
    }
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      for (const file of Array.from(e.dataTransfer.files)) {
        const path = api.pathForFile(file)
        const dot = path.lastIndexOf('.')
        const ext = dot >= 0 ? path.slice(dot).toLowerCase() : ''
        const base = path.replace(/\\/g, '/').split('/').pop() ?? 'file'
        const name = dot >= 0 ? base.slice(0, base.lastIndexOf('.')) : base
        void addFileSource(path, name, ext)
      }
    },
    [addFileSource]
  )

  const saveWorkbook = useCallback(async (as: boolean) => {
    const s = useApp.getState()
    const wb: Workbook = {
      ...s.workbook,
      meta: { ...s.workbook.meta, modifiedAt: new Date().toISOString() }
    }
    const path = await api.saveWorkbook(JSON.stringify(wb, null, 2), as ? null : s.workbookPath)
    if (path) {
      s.markSaved(path)
      s.setStatus(`Saved ${path}`)
    }
  }, [])

  const openWorkbook = useCallback(async () => {
    const res = await api.openWorkbook()
    if (!res) return
    try {
      const wb = JSON.parse(res.json) as Workbook
      const version = (wb.opvxVersion ??
        (wb as Workbook & { otwbVersion?: number }).otwbVersion) as number
      if (version !== 1 && version !== 2) throw new Error('Unsupported workbook version')
      await useApp.getState().loadWorkbook(wb, res.path)
    } catch (e) {
      useApp.getState().setStatus(`Failed to open workbook: ${e instanceof Error ? e.message : e}`)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const t = e.target as HTMLElement | null
      const inEditor =
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      const key = e.key.toLowerCase()
      if (key === 'z' && !inEditor) {
        e.preventDefault()
        void (e.shiftKey ? useApp.getState().redo() : useApp.getState().undo())
      } else if (key === 'y' && !inEditor) {
        e.preventDefault()
        void useApp.getState().redo()
      } else if (key === 's') {
        e.preventDefault()
        void saveWorkbook(e.shiftKey)
      } else if (key === 'o') {
        e.preventDefault()
        void openWorkbook()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveWorkbook, openWorkbook])

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={dragOver ? { outline: '2px dashed var(--accent)', outlineOffset: -2 } : undefined}
    >
      <div className="toolbar">
        <span className="title">OpenVisualization</span>
        <button onClick={() => useApp.getState().newWorkbook()}>New</button>
        <button onClick={openWorkbook}>Open…</button>
        <button onClick={() => void saveWorkbook(false)}>
          Save{dirty ? ' •' : ''}
        </button>
        <button onClick={() => void saveWorkbook(true)}>Save As…</button>
        <button onClick={() => void useApp.getState().undo()} disabled={!canUndo} title="Undo (Ctrl+Z)">
          ↶ Undo
        </button>
        <button onClick={() => void useApp.getState().redo()} disabled={!canRedo} title="Redo (Ctrl+Y)">
          ↷ Redo
        </button>
        <span className="spacer" />
        <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>
          {workbookPath ?? 'Unsaved workbook'}
        </span>
      </div>

      <div className="main">
        {page.kind === 'start' && (
          <StartPage
            onAddFile={addFileSource}
            onOpenWizard={setWizardPath}
            onAddEmail={(path, name) => setEmailDrop({ path, name })}
          />
        )}
        {page.kind === 'datasource' && <DataSourcePage key={page.id} id={page.id} />}
        {page.kind === 'worksheet' && <WorksheetPage key={page.id} id={page.id} />}
        {page.kind === 'dashboard' && <DashboardPage key={page.id} id={page.id} />}
      </div>

      <TabStrip />
      <StatusBar />

      {wizardPath && <ImportWizard path={wizardPath} onClose={() => setWizardPath(null)} />}
      {excelDrop && <ExcelImportDialog {...excelDrop} onClose={() => setExcelDrop(null)} />}
      {dbDrop && <DbDialog initial={dbDrop} onClose={() => setDbDrop(null)} />}
      {emailDrop && <EmailImportDialog {...emailDrop} onClose={() => setEmailDrop(null)} />}
    </div>
  )
}

function StatusBar(): React.JSX.Element {
  const status = useApp((s) => s.status)
  const progress = useApp((s) => s.progress)
  // any in-flight main-process operation shows its bar in the status strip
  // (covers workbook-open re-materialization, where no dialog is on screen)
  const active = Object.values(progress).filter((p): p is NonNullable<typeof p> => !!p)
  return (
    <div className="statusbar" style={active.length ? { display: 'flex', gap: 16, alignItems: 'center' } : undefined}>
      <span style={{ flexShrink: 0 }}>{status}</span>
      {active.slice(0, 2).map((p) => (
        <span key={p.key} style={{ flex: 1, maxWidth: 420, minWidth: 160 }}>
          <ProgressBar p={p} />
        </span>
      ))}
    </div>
  )
}

function TabStrip(): React.JSX.Element {
  const workbook = useApp((s) => s.workbook)
  const page = useApp((s) => s.page)
  const setPage = useApp((s) => s.setPage)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')

  const commitRename = (id: string): void => {
    if (renameVal.trim()) useApp.getState().renameSheet(id, renameVal.trim())
    setRenaming(null)
  }

  return (
    <div className="tabstrip">
      <div
        className={`tab ${page.kind === 'start' ? 'active' : ''}`}
        onClick={() => setPage({ kind: 'start' })}
      >
        ⌂ Home
      </div>
      {workbook.dataSources.map((ds) => (
        <div
          key={ds.id}
          className={`tab ${page.kind === 'datasource' && page.id === ds.id ? 'active' : ''}`}
          onClick={() => setPage({ kind: 'datasource', id: ds.id })}
          title={ds.name}
        >
          🗄 {ds.name}
        </div>
      ))}
      {workbook.worksheets.map((ws) => (
        <div
          key={ws.id}
          className={`tab ${page.kind === 'worksheet' && page.id === ws.id ? 'active' : ''}`}
          onClick={() => setPage({ kind: 'worksheet', id: ws.id })}
          onDoubleClick={() => {
            setRenaming(ws.id)
            setRenameVal(ws.name)
          }}
        >
          {renaming === ws.id ? (
            <input
              autoFocus
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onBlur={() => commitRename(ws.id)}
              onKeyDown={(e) => e.key === 'Enter' && commitRename(ws.id)}
              style={{ width: 90 }}
            />
          ) : (
            <>📊 {ws.name}</>
          )}
          <span
            className="close"
            title="Duplicate"
            onClick={(e) => {
              e.stopPropagation()
              useApp.getState().duplicateWorksheet(ws.id)
            }}
          >
            ⧉
          </span>
          <span
            className="close"
            onClick={(e) => {
              e.stopPropagation()
              useApp.getState().removeWorksheet(ws.id)
            }}
          >
            ×
          </span>
        </div>
      ))}
      {workbook.dashboards.map((d) => (
        <div
          key={d.id}
          className={`tab ${page.kind === 'dashboard' && page.id === d.id ? 'active' : ''}`}
          onClick={() => setPage({ kind: 'dashboard', id: d.id })}
        >
          ▦ {d.name}
          <span
            className="close"
            onClick={(e) => {
              e.stopPropagation()
              useApp.getState().removeDashboard(d.id)
            }}
          >
            ×
          </span>
        </div>
      ))}
      <div
        className="tab add"
        title="New worksheet"
        onClick={() => {
          const s = useApp.getState()
          const ds = s.workbook.dataSources[0]
          if (ds) s.addWorksheet(ds.id)
          else s.setStatus('Connect to a data source first')
        }}
      >
        + Sheet
      </div>
      <div className="tab add" title="New dashboard" onClick={() => useApp.getState().addDashboard()}>
        + Dashboard
      </div>
    </div>
  )
}

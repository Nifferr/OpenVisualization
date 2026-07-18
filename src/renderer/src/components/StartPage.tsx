import { useEffect, useState } from 'react'
import { api } from '../api'
import { nextId, useApp } from '../store'
import type { DataSourceDef, DbDriver, DbTableInfo } from '@shared/types'

interface Props {
  onAddFile: (path: string, name: string, ext: string) => Promise<void>
  onOpenWizard: (path: string) => void
  /** open the e-mail archive import dialog regardless of the picked extension */
  onAddEmail: (path: string, name: string) => void
}

export function StartPage({ onAddFile, onOpenWizard, onAddEmail }: Props): React.JSX.Element {
  const [dialog, setDialog] = useState<'db' | 'url' | 'join' | null>(null)
  const nSources = useApp((s) => s.workbook.dataSources.length)

  const pickStructured = async (): Promise<void> => {
    const f = await api.pickFile([
      {
        name: 'Data files',
        extensions: ['csv', 'tsv', 'json', 'ndjson', 'parquet', 'xlsx', 'xls', 'xlsm']
      },
      { name: 'Database files', extensions: ['db', 'sqlite', 'sqlite3', 'duckdb'] },
      { name: 'All files', extensions: ['*'] }
    ])
    if (f) await onAddFile(f.path, f.name, f.ext)
  }

  const pickText = async (): Promise<void> => {
    const f = await api.pickFile([
      { name: 'Text files', extensions: ['txt', 'log', 'dat', 'out', '*'] }
    ])
    if (f) onOpenWizard(f.path)
  }

  const pickEmail = async (): Promise<void> => {
    const f = await api.pickFile([
      { name: 'Mail archives', extensions: ['pst', 'ost', 'nsf', 'zdb', 'bak'] },
      { name: 'All files', extensions: ['*'] }
    ])
    if (f) onAddEmail(f.path, f.name)
  }

  return (
    <div className="start">
      <h1>OpenVisualization</h1>
      <div className="drop-hint">Drop a file anywhere, or connect below</div>
      <div className="connectors">
        <div className="connector-card" onClick={() => void pickStructured()}>
          <div className="icon">📄</div>
          <div>File</div>
          <div className="drop-hint">CSV · Excel (xlsx/xls) · JSON · Parquet · SQLite</div>
        </div>
        <div className="connector-card" onClick={() => void pickText()}>
          <div className="icon">🪄</div>
          <div>Text Import Wizard</div>
          <div className="drop-hint">TXT · logs · fixed width · regex</div>
        </div>
        <div className="connector-card" onClick={() => void pickEmail()}>
          <div className="icon">✉️</div>
          <div>Emails</div>
          <div className="drop-hint">PST · OST · NSF · ZDB · BAK — even corrupted</div>
        </div>
        <div className="connector-card" onClick={() => setDialog('db')}>
          <div className="icon">🛢</div>
          <div>Database</div>
          <div className="drop-hint">PostgreSQL · MySQL · SQLite · DuckDB</div>
        </div>
        <div className="connector-card" onClick={() => setDialog('url')}>
          <div className="icon">🌐</div>
          <div>Web URL</div>
          <div className="drop-hint">Remote CSV · JSON · Parquet</div>
        </div>
        <div
          className="connector-card"
          style={nSources < 2 ? { opacity: 0.45 } : undefined}
          title={nSources < 2 ? 'Connect at least two sources first' : 'Combine two sources'}
          onClick={() => nSources >= 2 && setDialog('join')}
        >
          <div className="icon">⋈</div>
          <div>Join Sources</div>
          <div className="drop-hint">Cross data from two sources</div>
        </div>
      </div>
      {dialog === 'db' && <DbDialog onClose={() => setDialog(null)} />}
      {dialog === 'url' && <UrlDialog onClose={() => setDialog(null)} />}
      {dialog === 'join' && <JoinDialog onClose={() => setDialog(null)} />}
    </div>
  )
}

export function DbDialog({
  onClose,
  initial
}: {
  onClose: () => void
  /** pre-filled connection (e.g. a dropped .db/.sqlite/.duckdb file) — connects on open */
  initial?: { driver: DbDriver; connString: string }
}): React.JSX.Element {
  const [driver, setDriver] = useState<DbDriver>(initial?.driver ?? 'postgres')
  const [connString, setConnString] = useState(initial?.connString ?? '')
  const [tables, setTables] = useState<DbTableInfo[] | null>(null)
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isFileDb = driver === 'sqlite' || driver === 'duckdb'
  const placeholder = isFileDb
    ? 'C:\\path\\to\\database.db'
    : driver === 'postgres'
      ? 'host=localhost port=5432 dbname=mydb user=me password=secret'
      : 'host=localhost port=3306 database=mydb user=me password=secret'

  const connect = async (driverArg = driver, connArg = connString): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const t = await api.listDbTables(driverArg, connArg)
      setTables(t)
      if (t.length) setSelected(`${t[0].schema}.${t[0].table}`)
      else setError('No tables found in this database.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (initial) void connect(initial.driver, initial.connString)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const add = async (): Promise<void> => {
    const [schema, table] = selected.split('.')
    setBusy(true)
    setError('')
    try {
      const def: DataSourceDef = {
        kind: 'db',
        id: nextId('db'),
        name: table,
        driver,
        connString,
        schema,
        table
      }
      const desc = await api.registerDataSource(def)
      useApp.getState().addDataSource(def, desc.fields, desc.rowCount)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <header>Connect to Database</header>
        <div className="body">
          <div className="form-row">
            <label>Driver</label>
            <select value={driver} onChange={(e) => setDriver(e.target.value as DbDriver)}>
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL</option>
              <option value="sqlite">SQLite</option>
              <option value="duckdb">DuckDB file</option>
            </select>
          </div>
          <div className="form-row">
            <label>{isFileDb ? 'File path' : 'Connection'}</label>
            <input
              value={connString}
              placeholder={placeholder}
              onChange={(e) => setConnString(e.target.value)}
            />
          </div>
          {tables && (
            <div className="form-row">
              <label>Table</label>
              <select value={selected} onChange={(e) => setSelected(e.target.value)}>
                {tables.map((t) => (
                  <option key={`${t.schema}.${t.table}`} value={`${t.schema}.${t.table}`}>
                    {t.schema}.{t.table}
                  </option>
                ))}
              </select>
            </div>
          )}
          {error && <div style={{ color: 'var(--red)', fontSize: 12, whiteSpace: 'pre-wrap' }}>{error}</div>}
          {busy && (
            <div style={{ color: 'var(--text-dim)' }}>
              Working…{driver !== 'duckdb' ? ` (first use downloads the DuckDB ${driver} extension)` : ''}
            </div>
          )}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          {!tables ? (
            <button className="primary" disabled={!connString || busy} onClick={() => void connect()}>
              Connect
            </button>
          ) : (
            <button className="primary" disabled={!selected || busy} onClick={() => void add()}>
              Add Table
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

function JoinDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const sources = useApp((s) => s.workbook.dataSources)
  const fields = useApp((s) => s.fields)
  const [leftId, setLeftId] = useState(sources[0]?.id ?? '')
  const [rightId, setRightId] = useState(sources[1]?.id ?? '')
  const [joinType, setJoinType] = useState<'inner' | 'left' | 'right' | 'full' | 'cross'>('inner')
  const [keys, setKeys] = useState<Array<{ left: string; right: string }>>([{ left: '', right: '' }])
  const [name, setName] = useState('Joined data')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const leftFields = fields[leftId] ?? []
  const rightFields = fields[rightId] ?? []

  // pre-select fields with matching names as a convenience
  const autoMatch = (): void => {
    const rightNames = new Set(rightFields.map((f) => f.name))
    const matches = leftFields.filter((f) => rightNames.has(f.name)).map((f) => ({ left: f.name, right: f.name }))
    if (matches.length) setKeys(matches)
  }

  const add = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const validKeys = keys.filter((k) => k.left && k.right)
      const def: DataSourceDef = {
        kind: 'join',
        id: nextId('j'),
        name,
        leftId,
        rightId,
        joinType,
        keys: joinType === 'cross' ? [] : validKeys
      }
      const desc = await api.registerDataSource(def)
      useApp.getState().addDataSource(def, desc.fields, desc.rowCount)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const canAdd = leftId && rightId && leftId !== rightId && (joinType === 'cross' || keys.some((k) => k.left && k.right))

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 560 }}>
        <header>Join Sources</header>
        <div className="body">
          <div className="form-row">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="form-row">
            <label>Left source</label>
            <select value={leftId} onChange={(e) => setLeftId(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>Right source</label>
            <select value={rightId} onChange={(e) => setRightId(e.target.value)}>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>Join type</label>
            <select value={joinType} onChange={(e) => setJoinType(e.target.value as typeof joinType)}>
              <option value="inner">Inner — only matching rows</option>
              <option value="left">Left — all left rows</option>
              <option value="right">Right — all right rows</option>
              <option value="full">Full outer — all rows</option>
              <option value="cross">Cross — every combination</option>
            </select>
          </div>
          {joinType !== 'cross' && (
            <>
              <div className="form-row">
                <label>Keys</label>
                <button onClick={autoMatch}>Auto-match by name</button>
                <button onClick={() => setKeys((k) => [...k, { left: '', right: '' }])}>+ Pair</button>
              </div>
              {keys.map((k, i) => (
                <div className="form-row" key={i}>
                  <label />
                  <select value={k.left} onChange={(e) => setKeys((ks) => ks.map((x, j) => (j === i ? { ...x, left: e.target.value } : x)))}>
                    <option value="">— left field —</option>
                    {leftFields.map((f) => (
                      <option key={f.name} value={f.name}>{f.name}</option>
                    ))}
                  </select>
                  <span>=</span>
                  <select value={k.right} onChange={(e) => setKeys((ks) => ks.map((x, j) => (j === i ? { ...x, right: e.target.value } : x)))}>
                    <option value="">— right field —</option>
                    {rightFields.map((f) => (
                      <option key={f.name} value={f.name}>{f.name}</option>
                    ))}
                  </select>
                  <span className="x" style={{ cursor: 'pointer' }} onClick={() => setKeys((ks) => ks.filter((_x, j) => j !== i))}>×</span>
                </div>
              ))}
            </>
          )}
          {leftId === rightId && <div style={{ color: 'var(--accent2)', fontSize: 12 }}>Pick two different sources.</div>}
          {error && <div style={{ color: 'var(--red)', fontSize: 12, whiteSpace: 'pre-wrap' }}>{error}</div>}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!canAdd || busy} onClick={() => void add()}>
            Create Joined Source
          </button>
        </footer>
      </div>
    </div>
  )
}

function UrlDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [format, setFormat] = useState<'csv' | 'json' | 'parquet'>('csv')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const add = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const name = url.split('/').pop()?.split('?')[0] || 'remote'
      const def: DataSourceDef = { kind: 'url', id: nextId('u'), name, url, format }
      const desc = await api.registerDataSource(def)
      useApp.getState().addDataSource(def, desc.fields, desc.rowCount)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <header>Load from URL</header>
        <div className="body">
          <div className="form-row">
            <label>URL</label>
            <input
              value={url}
              placeholder="https://example.com/data.csv"
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label>Format</label>
            <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
              <option value="parquet">Parquet</option>
            </select>
          </div>
          {error && <div style={{ color: 'var(--red)', fontSize: 12, whiteSpace: 'pre-wrap' }}>{error}</div>}
          {busy && <div style={{ color: 'var(--text-dim)' }}>Loading… (first use downloads the httpfs extension)</div>}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!/^https?:\/\//.test(url) || busy} onClick={() => void add()}>
            Load
          </button>
        </footer>
      </div>
    </div>
  )
}

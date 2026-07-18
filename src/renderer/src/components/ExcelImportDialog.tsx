import { useEffect, useState } from 'react'
import { api } from '../api'
import { nextId, useApp } from '../store'
import type { DataSourceDef } from '@shared/types'

/**
 * Sheet picker for dropped/opened Excel workbooks with more than one sheet.
 * Each selected sheet becomes its own data source; legacy .xls/.xlsm files
 * ('xls' format) are converted per sheet by the main process.
 */
export function ExcelImportDialog({
  path, name, format, onClose
}: {
  path: string
  name: string
  format: 'xlsx' | 'xls'
  onClose: () => void
}): React.JSX.Element {
  const [sheets, setSheets] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api
      .listXlsxSheets(path)
      .then((s) => {
        setSheets(s)
        setSelected(new Set(s.slice(0, 1)))
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [path])

  const toggle = (sheet: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sheet)) next.delete(sheet)
      else next.add(sheet)
      return next
    })
  }

  const add = async (): Promise<void> => {
    if (!sheets) return
    setBusy(true)
    setError('')
    const chosen = sheets.filter((s) => selected.has(s)) // keep workbook order
    const failures: string[] = []
    let rows = 0
    for (const sheet of chosen) {
      try {
        const def: DataSourceDef = {
          kind: 'file',
          id: nextId('f'),
          name: chosen.length > 1 ? `${name} (${sheet})` : name,
          path,
          format,
          sheet
        }
        const desc = await api.registerDataSource(def)
        useApp.getState().addDataSource(def, desc.fields, desc.rowCount)
        rows += desc.rowCount
      } catch (e) {
        failures.push(`${sheet}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setBusy(false)
    if (failures.length) {
      setError(failures.join('\n'))
      return
    }
    useApp.getState().setStatus(
      `Loaded ${chosen.length} sheet(s) from ${name} (${rows.toLocaleString()} rows)`
    )
    onClose()
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 460 }}>
        <header>Excel Import — {name}</header>
        <div className="body">
          <div className="drop-hint">
            {format === 'xls'
              ? 'Legacy Excel file: each sheet is converted to a treated copy on load.'
              : 'Pick the sheet(s) to load. Each sheet becomes a separate data source.'}
          </div>
          {!sheets && !error && <div className="drop-hint"><span className="spinner" /> Reading sheets…</div>}
          {sheets && (
            <>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setSelected(new Set(sheets))}>All</button>
                <button onClick={() => setSelected(new Set())}>None</button>
              </div>
              <div className="checklist" style={{ maxHeight: 260 }}>
                {sheets.map((s) => (
                  <label key={s}>
                    <input type="checkbox" checked={selected.has(s)} onChange={() => toggle(s)} />
                    {s}
                  </label>
                ))}
              </div>
            </>
          )}
          {error && <div style={{ color: 'var(--red)', fontSize: 12, whiteSpace: 'pre-wrap' }}>{error}</div>}
          {busy && <div className="drop-hint"><span className="spinner" /> Loading selected sheets…</div>}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || selected.size === 0} onClick={() => void add()}>
            Add {selected.size} source{selected.size === 1 ? '' : 's'}
          </button>
        </footer>
      </div>
    </div>
  )
}

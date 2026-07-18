import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { nextId, useApp } from '../store'
import type {
  DataSourceDef,
  ImportColumnDef,
  ImportPreview,
  ImportRecipe,
  ImportSample
} from '@shared/types'

type Mode = 'delimited' | 'fixed' | 'regex'

const TYPES: ImportColumnDef['type'][] = ['VARCHAR', 'BIGINT', 'DOUBLE', 'DATE', 'TIMESTAMP', 'BOOLEAN']

export function ImportWizard({ path, onClose }: { path: string; onClose: () => void }): React.JSX.Element {
  const [sample, setSample] = useState<ImportSample | null>(null)
  const [mode, setMode] = useState<Mode>('delimited')
  const [delimiter, setDelimiter] = useState(',')
  const [quote, setQuote] = useState('"')
  const [hasHeader, setHasHeader] = useState(true)
  const [skipRows, setSkipRows] = useState(0)
  const [slices, setSlices] = useState<Array<{ start: number; end: number }>>([])
  const [pattern, setPattern] = useState('')
  const [columns, setColumns] = useState<ImportColumnDef[]>([])
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState(() => {
    const base = path.replace(/\\/g, '/').split('/').pop() ?? 'import'
    return base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base
  })
  const colsTouched = useRef(false)

  useEffect(() => {
    api
      .importSample(path)
      .then((s) => {
        setSample(s)
        if (s.sniff) {
          setDelimiter(s.sniff.delimiter === '\\t' ? '\t' : s.sniff.delimiter)
          setQuote(s.sniff.quote || '"')
          setHasHeader(s.sniff.hasHeader)
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [path])

  const recipe: ImportRecipe = useMemo(() => {
    const base = { sourcePath: path, skipRows, columns }
    if (mode === 'delimited') return { mode, ...base, delimiter, quote, hasHeader }
    if (mode === 'fixed') return { mode, ...base, slices }
    return { mode, ...base, pattern }
  }, [mode, path, skipRows, columns, delimiter, quote, hasHeader, slices, pattern])

  // live re-parse of the sample whenever the recipe changes
  useEffect(() => {
    if (!sample) return
    if (mode === 'fixed' && slices.length === 0) {
      setPreview(null)
      return
    }
    if (mode === 'regex' && !pattern) {
      setPreview(null)
      return
    }
    const t = setTimeout(() => {
      api
        .importPreview(recipe)
        .then((p) => {
          setPreview(p)
          setError('')
          if (!colsTouched.current) setColumns(p.columns)
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample, mode, delimiter, quote, hasHeader, skipRows, JSON.stringify(slices), pattern])

  const updateColumn = (i: number, patch: Partial<ImportColumnDef>): void => {
    colsTouched.current = true
    setColumns((cols) => cols.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  }

  // fixed-width ruler: click a character position to toggle a boundary
  const toggleBoundary = useCallback((pos: number) => {
    colsTouched.current = false
    setSlices((prev) => {
      const bounds = new Set<number>()
      for (const s of prev) {
        bounds.add(s.start)
        bounds.add(s.end)
      }
      bounds.delete(0)
      if (bounds.has(pos)) bounds.delete(pos)
      else if (pos > 0) bounds.add(pos)
      const sorted = [0, ...[...bounds].sort((a, b) => a - b), 9999]
      const out: Array<{ start: number; end: number }> = []
      for (let i = 0; i < sorted.length - 1; i++) out.push({ start: sorted[i], end: sorted[i + 1] })
      return out
    })
  }, [])

  const commit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const finalRecipe: ImportRecipe = { ...recipe, columns }
      const res = await api.importCommit(finalRecipe)
      const def: DataSourceDef = {
        kind: 'treated',
        id: nextId('t'),
        name,
        parquetPath: res.parquetPath,
        recipe: finalRecipe
      }
      const desc = await api.registerDataSource(def)
      useApp.getState().addDataSource(def, desc.fields, desc.rowCount)
      useApp.getState().setStatus(`Imported ${res.rowCount.toLocaleString()} rows → treated Parquet copy`)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const rulerLine = sample?.lines[skipRows] ?? sample?.lines[0] ?? ''

  return (
    <div className="overlay">
      <div className="dialog" style={{ width: 860 }}>
        <header>Text Import Wizard — {path}</header>
        <div className="body">
          <div className="form-row">
            <label>Source name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
            <label style={{ width: 'auto' }}>Skip rows</label>
            <input
              type="number"
              min={0}
              value={skipRows}
              onChange={(e) => setSkipRows(Math.max(0, Number(e.target.value)))}
              style={{ width: 70 }}
            />
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            {(['delimited', 'fixed', 'regex'] as Mode[]).map((m) => (
              <button
                key={m}
                className={mode === m ? 'primary' : ''}
                onClick={() => {
                  colsTouched.current = false
                  setMode(m)
                }}
              >
                {m === 'delimited' ? 'Delimited' : m === 'fixed' ? 'Fixed width' : 'Regex'}
              </button>
            ))}
          </div>

          {mode === 'delimited' && (
            <div className="form-row">
              <label>Delimiter</label>
              <select
                value={delimiter === '\t' ? 'TAB' : delimiter}
                onChange={(e) => {
                  colsTouched.current = false
                  setDelimiter(e.target.value === 'TAB' ? '\t' : e.target.value)
                }}
                style={{ width: 90 }}
              >
                <option value=",">, comma</option>
                <option value=";">; semicolon</option>
                <option value="TAB">tab</option>
                <option value="|">| pipe</option>
                <option value=" ">space</option>
              </select>
              <label style={{ width: 'auto' }}>Quote</label>
              <input value={quote} onChange={(e) => setQuote(e.target.value)} style={{ width: 40 }} />
              <label style={{ width: 'auto', display: 'flex', gap: 4 }}>
                <input
                  type="checkbox"
                  checked={hasHeader}
                  onChange={(e) => {
                    colsTouched.current = false
                    setHasHeader(e.target.checked)
                  }}
                />
                First row is header
              </label>
            </div>
          )}

          {mode === 'fixed' && (
            <div>
              <div className="drop-hint">Click character positions to toggle column boundaries:</div>
              <div className="wizard-sample" style={{ cursor: 'text', maxHeight: 90 }}>
                <div>
                  {rulerLine.split('').map((ch, i) => {
                    const isBound = slices.some((s) => s.start === i && i > 0)
                    return (
                      <span
                        key={i}
                        onClick={() => toggleBoundary(i)}
                        style={{
                          borderLeft: isBound ? '2px solid var(--accent2)' : '1px solid transparent',
                          cursor: 'pointer'
                        }}
                      >
                        {ch === ' ' ? ' ' : ch}
                      </span>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {mode === 'regex' && (
            <div className="form-row">
              <label>Pattern</label>
              <input
                value={pattern}
                placeholder="e.g. ^(\S+) (\S+) \[(.+?)\] &quot;(\w+) (.+?)&quot; (\d+)$"
                onChange={(e) => {
                  colsTouched.current = false
                  setPattern(e.target.value)
                }}
                style={{ fontFamily: 'Consolas, monospace' }}
              />
            </div>
          )}

          {sample && (
            <>
              <div className="drop-hint">File sample ({sample.encoding}):</div>
              <div className="wizard-sample">{sample.lines.slice(0, 8).join('\n')}</div>
            </>
          )}

          {preview && (
            <>
              <div className="drop-hint">
                Parsed preview — {preview.matchedLines} matched, {preview.unmatchedLines} unmatched sample lines
              </div>
              <div style={{ overflow: 'auto', maxHeight: 220, border: '1px solid var(--border)', borderRadius: 4 }}>
                <table className="grid">
                  <thead>
                    <tr>
                      {columns.map((c, i) => (
                        <th key={i} style={{ minWidth: 120 }}>
                          <input
                            value={c.name}
                            onChange={(e) => updateColumn(i, { name: e.target.value })}
                            style={{ width: '100%', marginBottom: 2 }}
                          />
                          <select
                            value={c.type}
                            onChange={(e) => updateColumn(i, { type: e.target.value as ImportColumnDef['type'] })}
                            style={{ width: '100%' }}
                          >
                            {TYPES.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                          {(c.type === 'DATE' || c.type === 'TIMESTAMP') && (
                            <input
                              placeholder="format e.g. %d/%m/%Y"
                              value={c.dateFormat ?? ''}
                              onChange={(e) => updateColumn(i, { dateFormat: e.target.value || undefined })}
                              style={{ width: '100%', marginTop: 2 }}
                            />
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.slice(0, 12).map((row, ri) => (
                      <tr key={ri}>
                        {columns.map((_c, ci) => (
                          <td key={ci}>{row[ci] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {error && <div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap' }}>{error}</div>}
          {busy && <div style={{ color: 'var(--text-dim)' }}>Importing full file…</div>}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={busy || !preview || columns.length === 0}
            onClick={() => void commit()}
          >
            Import → save treated copy
          </button>
        </footer>
      </div>
    </div>
  )
}

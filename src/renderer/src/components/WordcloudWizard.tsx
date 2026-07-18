import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { nextId, useApp } from '../store'
import type { DataSourceDef } from '@shared/types'
import { quoteIdent, wordcloudTokenSql, type WordcloudSpec } from '@shared/sqlBuilder'

type PresetId = 'words' | 'whitespace' | 'comma' | 'semicolon' | 'pipe' | 'customRegex' | 'customLiteral'

const PRESETS: Array<{ id: PresetId; label: string; mode: WordcloudSpec['delimiterMode']; delimiter: string }> = [
  { id: 'words', label: 'Words (letters & numbers)', mode: 'regex', delimiter: '[^\\p{L}\\p{N}]+' },
  { id: 'whitespace', label: 'Whitespace only', mode: 'regex', delimiter: '\\s+' },
  { id: 'comma', label: 'Comma ( , )', mode: 'literal', delimiter: ',' },
  { id: 'semicolon', label: 'Semicolon ( ; )', mode: 'literal', delimiter: ';' },
  { id: 'pipe', label: 'Pipe ( | )', mode: 'literal', delimiter: '|' },
  { id: 'customRegex', label: 'Custom regex…', mode: 'regex', delimiter: '' },
  { id: 'customLiteral', label: 'Custom delimiter…', mode: 'literal', delimiter: '' }
]

const PREVIEW_LIMIT = 24
const PREVIEW_DEBOUNCE_MS = 300

/**
 * Dataset-level wizard: picks a text field + delimiter, registers a new
 * derived data source that tokenizes it into one row per word (see
 * wordcloudTokenSql), then creates a worksheet pre-wired as a Word Cloud
 * (word dimension + Number of Records measure) pointed at it.
 */
export function WordcloudWizardDialog({ dsId, onClose }: { dsId: string; onClose: () => void }): React.JSX.Element {
  const rawFields = useApp((s) => s.fields[dsId])
  const sourceName = useApp((s) => s.workbook.dataSources.find((d) => d.id === dsId)?.name ?? '')
  const fields = useMemo(() => rawFields ?? [], [rawFields])
  const textFields = useMemo(() => fields.filter((f) => f.kind === 'string' || f.kind === 'other'), [fields])
  const [field, setField] = useState(textFields[0]?.name ?? '')
  const [presetId, setPresetId] = useState<PresetId>('words')
  const [customDelimiter, setCustomDelimiter] = useState('')
  const [caseFold, setCaseFold] = useState(true)
  const [minLength, setMinLength] = useState(2)
  const [stopwords, setStopwords] = useState(true)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<Array<{ word: string; n: number }> | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!field && textFields[0]) setField(textFields[0].name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textFields])

  const preset = PRESETS.find((p) => p.id === presetId)!
  const isCustom = presetId === 'customRegex' || presetId === 'customLiteral'
  const delimiter = isCustom ? customDelimiter : preset.delimiter
  const spec: WordcloudSpec = {
    field,
    delimiterMode: preset.mode,
    delimiter,
    caseFold,
    minLength,
    stopwords
  }

  useEffect(() => {
    if (!field || !delimiter) {
      setPreview(null)
      setPreviewError('')
      setPreviewing(false)
      return
    }
    let cancelled = false
    setPreviewing(true)
    const timer = setTimeout(() => {
      const sql =
        `SELECT word, count(*) AS n FROM (${wordcloudTokenSql(quoteIdent(`ds_${dsId}`), spec)}) t ` +
        `GROUP BY word ORDER BY n DESC, word LIMIT ${PREVIEW_LIMIT}`
      api
        .runQuery(sql)
        .then((res) => {
          if (cancelled) return
          setPreview(res.rows.map((r) => ({ word: String(r.word), n: Number(r.n) })))
          setPreviewError('')
        })
        .catch((e) => {
          if (cancelled) return
          setPreview(null)
          setPreviewError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false)
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsId, field, preset.mode, delimiter, caseFold, minLength, stopwords])

  const create = async (): Promise<void> => {
    if (!field || !delimiter) return
    setBusy(true)
    setError('')
    try {
      const def: DataSourceDef = {
        kind: 'wordcloud',
        id: nextId('wc'),
        name: name.trim() || `${field} (words)`,
        sourceId: dsId,
        field,
        delimiterMode: spec.delimiterMode,
        delimiter,
        caseFold,
        minLength,
        stopwords
      }
      const desc = await api.registerDataSource(def)
      useApp.getState().addDataSource(def, desc.fields, desc.rowCount)
      const wsId = useApp.getState().addWorksheet(def.id)
      useApp.getState().updateShelf(wsId, (s) => ({
        ...s,
        chartType: 'wordcloud',
        columns: [{ field: 'word', role: 'dimension' }],
        rows: [{ field: '*', role: 'measure', agg: 'count' }]
      }))
      void useApp.getState().runWorksheet(wsId)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const maxN = preview?.length ? Math.max(...preview.map((p) => p.n)) : 1
  const canCreate = !!field && !!delimiter && !busy

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 580 }}>
        <header>New Word Cloud from &quot;{sourceName}&quot;</header>
        <div className="body">
          {!textFields.length ? (
            <div className="drop-hint">This data source has no text fields to extract words from.</div>
          ) : (
            <>
              <div className="form-row">
                <label>Field</label>
                <select value={field} onChange={(e) => setField(e.target.value)}>
                  {textFields.map((f) => (
                    <option key={f.name} value={f.name}>{f.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>Split on</label>
                <select value={presetId} onChange={(e) => setPresetId(e.target.value as PresetId)}>
                  {PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
              {isCustom && (
                <div className="form-row">
                  <label>{presetId === 'customRegex' ? 'Pattern (RE2)' : 'Delimiter'}</label>
                  <input
                    value={customDelimiter}
                    onChange={(e) => setCustomDelimiter(e.target.value)}
                    placeholder={presetId === 'customRegex' ? '[^\\p{L}]+' : ','}
                  />
                </div>
              )}
              <div className="form-row">
                <label>Options</label>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', flex: 1, alignItems: 'center' }}>
                  <label style={{ width: 'auto', display: 'flex', gap: 5, alignItems: 'center', fontSize: 12 }}>
                    <input type="checkbox" checked={caseFold} onChange={(e) => setCaseFold(e.target.checked)} />
                    Ignore case
                  </label>
                  <label style={{ width: 'auto', display: 'flex', gap: 5, alignItems: 'center', fontSize: 12 }}>
                    <input type="checkbox" checked={stopwords} onChange={(e) => setStopwords(e.target.checked)} />
                    Remove common words (the, a, de, para…)
                  </label>
                  <label style={{ width: 'auto', display: 'flex', gap: 5, alignItems: 'center', fontSize: 12 }}>
                    Min length
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={minLength}
                      onChange={(e) => setMinLength(Math.max(1, Number(e.target.value) || 1))}
                      style={{ width: 48 }}
                    />
                  </label>
                </div>
              </div>
              <div className="form-row">
                <label>New source name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${field} (words)`} />
              </div>
              <div>
                <div className="drop-hint">
                  Preview{previewing && <span className="spinner" style={{ marginLeft: 6 }} />}
                  {!previewing && preview && ` — top ${preview.length} tokenized words`}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minHeight: 32, marginTop: 4 }}>
                  {preview?.map((p) => (
                    <span
                      key={p.word}
                      className="filter-chip"
                      style={{ cursor: 'default', fontSize: 11 + Math.round((p.n / maxN) * 8) }}
                      title={`${p.n.toLocaleString()} occurrence(s)`}
                    >
                      {p.word}
                    </span>
                  ))}
                  {preview && preview.length === 0 && !previewError && (
                    <span className="drop-hint">No words survived the current filters.</span>
                  )}
                </div>
                {previewError && <div style={{ color: 'var(--red)', fontSize: 12 }}>{previewError}</div>}
              </div>
              {error && <div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{error}</div>}
            </>
          )}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!canCreate} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create Word Cloud →'}
          </button>
        </footer>
      </div>
    </div>
  )
}

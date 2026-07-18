// Dataset-level wizard: scans one or more text fields for entity patterns
// (e-mail, CPF, CNPJ, telefone, URL, crypto…) and registers a new derived
// data source with one row per entity occurrence (see entityTokenSql):
// entity_id / source_id / source_table / entity / entity_raw / entity_type /
// source_field. source_id references the origin row (an existing key column,
// or a synthetic row_id the wizard adds to the origin view) so the entities
// can be joined back via Join Sources. Then creates a worksheet pre-wired as
// a top-20 horizontal bar of entities. Mirrors WordcloudWizard.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { nextId, useApp } from '../store'
import type { DataSourceDef } from '@shared/types'
import {
  entityTokenSql,
  quoteIdent,
  calcFieldKind,
  resolvedCalcSql,
  type EntitiesSpec
} from '@shared/sqlBuilder'
import type { FieldInfo } from '@shared/types'
import { EXTRACT_PATTERNS } from './FieldTools'
import { ProgressBar } from './ProgressBar'
import { SqlPreviewDialog } from './SqlPreviewDialog'

const PREVIEW_LIMIT = 15
const PREVIEW_DEBOUNCE_MS = 400
/** patterns pre-checked when the dialog opens (the most common identifiers) */
const DEFAULT_PATTERN_IDS = new Set(['email', 'cpf', 'cnpj', 'telefone', 'url'])

export function EntityWizardDialog({ dsId, onClose }: { dsId: string; onClose: () => void }): React.JSX.Element {
  const rawFields = useApp((s) => s.fields[dsId])
  const calcFieldsFromStore = useApp((s) => s.workbook.calculatedFields[dsId])
  const sourceDef = useApp((s) => s.workbook.dataSources.find((d) => d.id === dsId))
  const sourceName = sourceDef?.name ?? ''
  const fields = useMemo(() => {
    const raw = rawFields ?? []
    const calcInfo: FieldInfo[] = (calcFieldsFromStore ?? []).map((c) => ({
      name: c.name, dbType: 'CALCULATED', kind: calcFieldKind(c), role: c.role
    }))
    return [...raw, ...calcInfo]
  }, [rawFields, calcFieldsFromStore])
  const textFields = useMemo(
    () => fields.filter((f) => f.kind === 'string' || f.kind === 'other'),
    [fields]
  )
  const [selFields, setSelFields] = useState<Set<string>>(
    () => new Set(textFields.map((f) => f.name))
  )
  const [selPatterns, setSelPatterns] = useState<Set<string>>(
    () => new Set(EXTRACT_PATTERNS.filter((p) => DEFAULT_PATTERN_IDS.has(p.id)).map((p) => p.id))
  )
  const [customPattern, setCustomPattern] = useState('')
  const [customLabel, setCustomLabel] = useState('')
  const [normalize, setNormalize] = useState(true)
  // source-row back-reference: '' = synthetic row number (adds a row_id column
  // to the origin so the join back works); otherwise an existing key column
  const [idField, setIdField] = useState(() =>
    (rawFields ?? []).some((f) => f.name === 'row_id') ? 'row_id' : ''
  )
  const [name, setName] = useState('')
  const [preview, setPreview] = useState<Array<{ entity: string; type: string; n: number }> | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [rowPreviewSql, setRowPreviewSql] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // stable id up front so the extraction progress bar (keyed ds:<id>) can be
  // subscribed before create() runs
  const [entId] = useState(() => nextId('ent'))
  const extractProgress = useApp((s) => s.progress[`ds:${entId}`])

  useEffect(() => {
    setSelFields(new Set(textFields.map((f) => f.name)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsId])

  const spec: EntitiesSpec = useMemo(() => {
    const patterns = EXTRACT_PATTERNS.filter((p) => selPatterns.has(p.id)).map((p) => ({
      id: p.id,
      label: p.label,
      pattern: p.pattern
    }))
    if (customPattern.trim()) {
      patterns.push({
        id: 'custom',
        label: customLabel.trim() || 'Custom',
        pattern: customPattern.trim()
      })
    }
    // calc fields have no column on ds_<id> — ship their resolved SQL along
    const fieldExprs: Record<string, string> = {}
    for (const f of selFields) {
      const e = resolvedCalcSql(calcFieldsFromStore ?? [], f)
      if (e) fieldExprs[f] = e
    }
    return {
      fields: [...selFields],
      patterns,
      normalize,
      ...(Object.keys(fieldExprs).length ? { fieldExprs } : {})
    }
  }, [selFields, selPatterns, customPattern, customLabel, normalize, calcFieldsFromStore])

  useEffect(() => {
    if (!spec.fields.length || !spec.patterns.length) {
      setPreview(null)
      setPreviewError('')
      setPreviewing(false)
      return
    }
    let cancelled = false
    setPreviewing(true)
    const timer = setTimeout(() => {
      const sql =
        `SELECT entity, entity_type, count(*) AS n FROM (${entityTokenSql(quoteIdent(`ds_${dsId}`), spec)}) t ` +
        `GROUP BY 1, 2 ORDER BY n DESC, entity LIMIT ${PREVIEW_LIMIT}`
      api
        .runQuery(sql)
        .then((res) => {
          if (cancelled) return
          setPreview(
            res.rows.map((r) => ({
              entity: String(r.entity),
              type: String(r.entity_type),
              n: Number(r.n)
            }))
          )
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
  }, [dsId, spec])

  const toggle = (set: Set<string>, v: string, apply: (s: Set<string>) => void): void => {
    const next = new Set(set)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    apply(next)
  }

  /** Section header shared by the two checklists: title, count, All/None. */
  const SectionHead = ({
    title, count, total, onAll, onNone
  }: {
    title: string
    count: number
    total: number
    onAll: () => void
    onNone: () => void
  }): React.JSX.Element => (
    <div className="wiz-head">
      <span className="wiz-title">{title}</span>
      <span className="wiz-count">{count} of {total} selected</span>
      <button type="button" onClick={onAll}>All</button>
      <button type="button" onClick={onNone}>None</button>
    </div>
  )

  /**
   * Resolve the source_id column: a picked existing column is used as-is; the
   * synthetic option re-registers the ORIGIN view with a row_id column
   * (withRowId) so entities.source_id = origin.row_id is joinable in-app.
   * Derived origins (join/wordcloud/entities) can't be re-registered with
   * withRowId — the extraction falls back to an internal row number.
   */
  const resolveIdField = async (): Promise<string | undefined> => {
    if (idField) return idField
    // origin already exposes a row_id column (its own data or a prior run)
    if ((rawFields ?? []).some((f) => f.name === 'row_id')) return 'row_id'
    if (
      !sourceDef ||
      sourceDef.kind === 'join' ||
      sourceDef.kind === 'wordcloud' ||
      sourceDef.kind === 'entities'
    ) {
      return undefined
    }
    const updated = { ...sourceDef, withRowId: true }
    const desc = await api.registerDataSource(updated)
    useApp.getState().updateDataSource(updated, desc.fields)
    return 'row_id'
  }

  const create = async (): Promise<void> => {
    if (!spec.fields.length || !spec.patterns.length) return
    setBusy(true)
    setError('')
    try {
      const resolvedId = await resolveIdField()
      const def: DataSourceDef = {
        kind: 'entities',
        id: entId,
        name: name.trim() || `${sourceName} (entities)`,
        sourceId: dsId,
        fields: spec.fields,
        patterns: spec.patterns,
        normalize,
        ...(spec.fieldExprs ? { fieldExprs: spec.fieldExprs } : {}),
        ...(resolvedId ? { idField: resolvedId } : {}),
        sourceTable: sourceName
      }
      const desc = await api.registerDataSource(def)
      useApp.getState().addDataSource(def, desc.fields, desc.rowCount)
      const wsId = useApp.getState().addWorksheet(def.id)
      useApp.getState().updateShelf(wsId, (s) => ({
        ...s,
        chartType: 'barh',
        rows: [
          {
            field: 'entity',
            role: 'dimension',
            sort: 'valueDesc',
            topN: { n: 20, byField: '*', byAgg: 'count', others: false }
          }
        ],
        columns: [{ field: '*', role: 'measure', agg: 'count' }],
        color: spec.patterns.length > 1 ? { field: 'entity_type', role: 'dimension' } : undefined
      }))
      void useApp.getState().runWorksheet(wsId)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const canCreate = spec.fields.length > 0 && spec.patterns.length > 0 && !busy

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 860 }}>
        <header>Extract Entities from &quot;{sourceName}&quot;</header>
        <div className="body">
          {!textFields.length ? (
            <div className="drop-hint">This data source has no text fields to scan.</div>
          ) : (
            <>
              <section className="wiz-section">
                <SectionHead
                  title="Scan fields"
                  count={selFields.size}
                  total={textFields.length}
                  onAll={() => setSelFields(new Set(textFields.map((f) => f.name)))}
                  onNone={() => setSelFields(new Set())}
                />
                <div className="checklist wiz-fields">
                  {textFields.map((f) => (
                    <label key={f.name}>
                      <input
                        type="checkbox"
                        checked={selFields.has(f.name)}
                        onChange={() => toggle(selFields, f.name, setSelFields)}
                      />
                      <span className="vtext" title={f.name}>{f.name}</span>
                      {f.dbType === 'CALCULATED' && <span className="badge">calc</span>}
                    </label>
                  ))}
                </div>
              </section>
              <section className="wiz-section">
                <SectionHead
                  title="Entities to extract"
                  count={selPatterns.size}
                  total={EXTRACT_PATTERNS.length}
                  onAll={() => setSelPatterns(new Set(EXTRACT_PATTERNS.map((p) => p.id)))}
                  onNone={() => setSelPatterns(new Set())}
                />
                <div className="checklist wiz-patterns">
                  {EXTRACT_PATTERNS.map((p) => (
                    <label key={p.id} className="ent-row" title={`${p.label} — e.g. ${p.example}`}>
                      <input
                        type="checkbox"
                        checked={selPatterns.has(p.id)}
                        onChange={() => toggle(selPatterns, p.id, setSelPatterns)}
                      />
                      <span className="ent-meta">
                        <span className="ent-label">{p.label}</span>
                        <span className="ent-example">{p.example}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="wiz-custom">
                  <span className="wiz-custom-label">Custom (RE2)</span>
                  <input
                    value={customPattern}
                    onChange={(e) => setCustomPattern(e.target.value)}
                    placeholder="optional regex, e.g. \b[A-Z]{2}-\d{5}\b"
                    style={{ flex: 2 }}
                  />
                  <input
                    value={customLabel}
                    onChange={(e) => setCustomLabel(e.target.value)}
                    placeholder="label (e.g. Protocolo)"
                    style={{ flex: 1 }}
                  />
                </div>
              </section>
              <div className="form-row">
                <label>Options</label>
                <label style={{ width: 'auto', display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
                  <input type="checkbox" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
                  Normalize (group <code>123.456.789-09</code> with <code>12345678909</code>,{' '}
                  <code>Foo@X.com</code> with <code>foo@x.com</code>…)
                </label>
              </div>
              <div className="form-row">
                <label>Source ID</label>
                <select value={idField} onChange={(e) => setIdField(e.target.value)}>
                  <option value="">(Row number — adds a row_id column to the origin)</option>
                  {(rawFields ?? []).map((f) => (
                    <option key={f.name} value={f.name}>{f.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>New source name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${sourceName} (entities)`} />
              </div>
              <section className="wiz-section">
                <div className="wiz-head">
                  <span className="wiz-title">Preview</span>
                  <span className="wiz-count">
                    {previewing && <span className="spinner" />}
                    {!previewing && preview && `top ${preview.length} entities by count`}
                  </span>
                  <button
                    type="button"
                    disabled={!spec.fields.length || !spec.patterns.length}
                    title="Open a grid of the actual extracted rows (all columns) before creating the source"
                    onClick={() =>
                      setRowPreviewSql(
                        `SELECT * FROM (${entityTokenSql(quoteIdent(`ds_${dsId}`), spec)}) t LIMIT 500`
                      )
                    }
                  >
                    🔍 Preview rows
                  </button>
                </div>
                <div className="wiz-preview">
                  {preview?.map((p, i) => (
                    <div key={i} className="prow">
                      <span className="badge">{p.type}</span>
                      <span className="ent-val" title={p.entity}>{p.entity}</span>
                      <span className="pn">{p.n.toLocaleString()}</span>
                    </div>
                  ))}
                  {preview && preview.length === 0 && !previewError && (
                    <span className="drop-hint">No entities matched in the selected fields.</span>
                  )}
                  {!preview && !previewError && !previewing && (
                    <span className="drop-hint">Select at least one field and one entity type to preview.</span>
                  )}
                </div>
                {previewError && <div style={{ color: 'var(--red)', fontSize: 12 }}>{previewError}</div>}
              </section>
              {error && <div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{error}</div>}
              <div className="drop-hint wiz-note">
                The new source has one row per occurrence: <code>entity_id</code> (unique row id),{' '}
                <code>source_id</code> (the origin row — join it back via Join Sources:{' '}
                <code>source_id</code> = the origin&apos;s <code>row_id</code> / ID column),{' '}
                <code>source_table</code>, <code>entity</code>, <code>entity_raw</code>,{' '}
                <code>entity_type</code> and <code>source_field</code>.
                E-mail entities also gain structured columns inferred from the address:{' '}
                <code>email_user</code>, <code>email_domain</code>, <code>email_category</code>{' '}
                (Particular / Corporativo / Governamental…), <code>email_org</code> (known
                organizations, else derived from the domain), <code>email_org_type</code> and{' '}
                <code>email_location</code>. Use &quot;+ Group values&quot; on the new source to
                merge related entities by hand.
              </div>
            </>
          )}
        </div>
        <footer>
          {(busy || extractProgress) && (
            <span style={{ flex: 1, minWidth: 0, marginRight: 8 }}>
              {extractProgress ? (
                <ProgressBar p={extractProgress} showLabel={false} />
              ) : (
                <span className="progress-row">
                  <span className="progress-track">
                    <span className="progress-fill indeterminate" />
                  </span>
                </span>
              )}
            </span>
          )}
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" disabled={!canCreate} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Extract Entities →'}
          </button>
        </footer>
      </div>
      {rowPreviewSql && (
        <SqlPreviewDialog
          title="Extracted entities — row preview (first 500)"
          sql={rowPreviewSql}
          onClose={() => setRowPreviewSql(null)}
        />
      )}
    </div>
  )
}

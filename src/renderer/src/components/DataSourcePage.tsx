import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import type { FieldInfo, QueryResult } from '@shared/types'
import {
  filtersToWhere,
  quoteIdent,
  calcFieldKind,
  calcFieldSql,
  resolveCalcExprs,
  resolvedCalcSql
} from '@shared/sqlBuilder'
import { FilterDialog } from './FilterDialog'
import { DateDerivedDialog, DetectPatternsDialog, GroupDialog, SmartAnalysisDialog, TemplateFieldDialog } from './FieldTools'
import { WordcloudWizardDialog } from './WordcloudWizard'
import { EntityWizardDialog } from './EntityWizard'

const PAGE_SIZE = 200
const MIN_COL_WIDTH = 60

interface ColProfile {
  nullPct: number
  distinct: number
}

type SortSpec = { field: string; dir: 'ASC' | 'DESC' } | null

export function DataSourcePage({ id }: { id: string }): React.JSX.Element {
  const def = useApp((s) => s.workbook.dataSources.find((d) => d.id === id))
  const fieldListRaw = useApp((s) => s.fields[id])
  const calcFieldsRaw = useApp((s) => s.workbook.calculatedFields[id])
  const sourceFiltersRaw = useApp((s) => s.workbook.sourceFilters[id])
  const rowCount = useApp((s) => s.rowCounts[id])
  const calcFields = calcFieldsRaw ?? []
  const fieldList = useMemo(() => {
    const raw = fieldListRaw ?? []
    const calcInfo: FieldInfo[] = calcFields.map((c) => ({
      name: c.name, dbType: 'CALCULATED', kind: calcFieldKind(c), role: c.role
    }))
    return [...raw, ...calcInfo]
  }, [fieldListRaw, calcFields])
  const sourceFilters = useMemo(() => sourceFiltersRaw ?? [], [sourceFiltersRaw])
  const [preview, setPreview] = useState<QueryResult | null>(null)
  const [filteredCount, setFilteredCount] = useState<number | null>(null)
  const [pageNum, setPageNum] = useState(0)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<'template' | 'dates' | 'group' | 'patterns' | 'smart' | 'wordcloud' | 'entities' | null>(null)
  const [filterField, setFilterField] = useState<
    { field: string; kind: FieldInfo['kind']; calcExpr?: string } | null
  >(null)
  const [profile, setProfile] = useState<Record<string, ColProfile> | null>(null)
  const [profiling, setProfiling] = useState(false)
  const [emlBusy, setEmlBusy] = useState(false)
  // grid display options
  const [sort, setSort] = useState<SortSpec>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [colWidths, setColWidths] = useState<Record<string, number>>({})
  const [colsMenuOpen, setColsMenuOpen] = useState(false)
  const resizing = useRef(false)

  const whereSql = useMemo(() => {
    const clauses = filtersToWhere(sourceFilters)
    return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  }, [sourceFilters])

  // FROM-ready source with calculated fields materialized as extra columns —
  // so the preview grid SHOWS calc fields and dataset filters/sorts on them
  // work (they don't exist as columns on the raw ds_<id> view)
  const fromSql = useMemo(() => {
    const view = quoteIdent(`ds_${id}`)
    if (!calcFieldsRaw?.length) return view
    const resolved = resolveCalcExprs(calcFieldsRaw)
    const cols = calcFieldsRaw
      .map((c) => `${calcFieldSql({ ...c, expr: resolved.get(c.name) ?? c.expr })} AS ${quoteIdent(c.name)}`)
      .join(', ')
    return `(SELECT *, ${cols} FROM ${view})`
  }, [id, calcFieldsRaw])

  useEffect(() => {
    let cancelled = false
    setError('')
    const load = async (): Promise<void> => {
      try {
        const orderSql = sort
          ? ` ORDER BY ${quoteIdent(sort.field)} ${sort.dir} NULLS LAST`
          : ''
        const sql = `SELECT * FROM ${fromSql}${whereSql}${orderSql} LIMIT ${PAGE_SIZE} OFFSET ${pageNum * PAGE_SIZE}`
        if (whereSql) {
          const [r, cnt] = await Promise.all([
            api.runQuery(sql),
            api.runQuery(`SELECT count(*) AS n FROM ${fromSql}${whereSql}`)
          ])
          if (cancelled) return
          setPreview(r)
          setFilteredCount(Number(cnt.rows[0]?.n ?? 0))
        } else {
          const r = await api.runQuery(sql)
          if (cancelled) return
          setPreview(r)
          setFilteredCount(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [id, pageNum, whereSql, sort, fromSql])

  if (!def) return <div style={{ padding: 20 }}>Data source not found.</div>

  const total = filteredCount ?? rowCount ?? 0
  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)

  const runProfile = async (): Promise<void> => {
    if (!fieldList.length) return
    setProfiling(true)
    try {
      const parts = fieldList.flatMap((f, i) => [
        `sum(CASE WHEN ${quoteIdent(f.name)} IS NULL THEN 1 ELSE 0 END) AS ${quoteIdent(`null_${i}`)}`,
        `approx_count_distinct(${quoteIdent(f.name)}) AS ${quoteIdent(`dist_${i}`)}`
      ])
      const res = await api.runQuery(
        `SELECT count(*) AS n, ${parts.join(', ')} FROM ${fromSql}`
      )
      const row = res.rows[0] ?? {}
      const n = Math.max(1, Number(row.n ?? 0))
      const out: Record<string, ColProfile> = {}
      fieldList.forEach((f, i) => {
        out[f.name] = {
          nullPct: (Number(row[`null_${i}`] ?? 0) / n) * 100,
          distinct: Number(row[`dist_${i}`] ?? 0)
        }
      })
      setProfile(out)
    } catch (e) {
      useApp.getState().setStatus(`Profile failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setProfiling(false)
    }
  }

  const removeFilter = (idx: number): void =>
    useApp.getState().setSourceFilters(id, sourceFilters.filter((_f, i) => i !== idx))

  /** Export the emails source's current messages (honoring dataset filters) as .eml files. */
  const exportEml = async (): Promise<void> => {
    setEmlBusy(true)
    try {
      // filters compiled against real view columns; a folder picker in main
      // then writes one .eml per message
      const where = filtersToWhere(sourceFilters).join(' AND ')
      const res = await api.exportEml(id, where)
      if (res) {
        useApp.getState().setStatus(
          `Exported ${res.written.toLocaleString()} .eml files to ${res.folder}` +
            (res.failed ? ` (${res.failed} failed)` : '')
        )
      }
    } catch (e) {
      useApp.getState().setStatus(`EML export failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setEmlBusy(false)
    }
  }

  const cycleSort = (field: string): void => {
    if (resizing.current) return // a resize drag must not toggle sorting
    setPageNum(0)
    setSort((s) => {
      if (!s || s.field !== field) return { field, dir: 'ASC' }
      if (s.dir === 'ASC') return { field, dir: 'DESC' }
      return null
    })
  }

  const startResize = (e: React.MouseEvent, col: string, current: number): void => {
    e.preventDefault()
    e.stopPropagation()
    resizing.current = true
    const startX = e.clientX
    const onMove = (ev: MouseEvent): void => {
      const w = Math.max(MIN_COL_WIDTH, current + (ev.clientX - startX))
      setColWidths((prev) => ({ ...prev, [col]: w }))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // let the header click handler see the flag before clearing it
      setTimeout(() => {
        resizing.current = false
      }, 0)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const visibleColumns = preview?.columns.filter((c) => !hidden.has(c.name)) ?? []

  return (
    <div className="ds-page">
      <div className="ds-header">
        <strong style={{ color: '#fff' }}>{def.name}</strong>
        <span className="badge">{def.kind}</span>
        <span style={{ color: 'var(--text-dim)' }}>
          {total.toLocaleString()} rows{filteredCount !== null ? ' (filtered)' : ''} · {fieldList.length} fields
          {calcFields.length ? ` · ${calcFields.length} calculated` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => setDialog('template')} title="Create a field from a text/number/extraction template">
          + Field from template
        </button>
        <button onClick={() => setDialog('dates')} title="Generate Year/Quarter/Month/… fields from a date">
          + Date fields
        </button>
        <button onClick={() => setDialog('group')} title="Combine values into named groups">
          + Group values
        </button>
        <button
          onClick={() => setDialog('patterns')}
          title="Scan text columns for CPF, CNPJ, placa, telefone, PIX, crypto addresses…"
        >
          🔎 Detect patterns
        </button>
        <button
          onClick={() => setDialog('smart')}
          title="Idioma, tom, sentimento, emoção, intenção, área, urgência… por heurísticas de palavras-chave (sem IA)"
        >
          🧠 Smart analyses
        </button>
        <button
          className="primary"
          onClick={() => useApp.getState().addWorksheet(id)}
        >
          New Worksheet →
        </button>
        <button onClick={() => setDialog('wordcloud')} title="Extract words from a text field and chart them as a word cloud">
          ☁ New Word Cloud →
        </button>
        <button
          onClick={() => setDialog('entities')}
          title="Extract and group entities (e-mail, CPF, CNPJ, telefone, URL…) from text fields into a new source"
        >
          🧩 Extract Entities →
        </button>
        {def.kind === 'emails' && (
          <button onClick={() => void exportEml()} disabled={emlBusy} title="Save the current messages as .eml files in a folder">
            {emlBusy ? 'Exporting…' : '✉️ Export as EML'}
          </button>
        )}
        <button
          onClick={() => {
            if (confirm(`Remove data source "${def.name}" and its worksheets?`))
              void useApp.getState().removeDataSource(id)
          }}
        >
          Remove
        </button>
      </div>
      <div className="ds-filterbar">
        <span style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase' }}>
          Dataset filters
        </span>
        {sourceFilters.map((f, i) => (
          <span key={i} className="filter-chip" title={JSON.stringify(f)}>
            {f.kind === 'expr' ? f.expr : `${'field' in f ? f.field : ''} (${f.kind})`}
            <span
              className="x"
              style={{ cursor: 'pointer', fontWeight: 700 }}
              onClick={() => removeFilter(i)}
            >
              ×
            </span>
          </span>
        ))}
        <FilterFieldPicker
          fields={fieldList}
          onPick={(f) =>
            setFilterField({ ...f, calcExpr: resolvedCalcSql(calcFields, f.field) })
          }
        />
        <span style={{ flex: 1 }} />
        {sort && (
          <span className="filter-chip" title="Preview sort (does not affect worksheets)">
            ⇅ {sort.field} {sort.dir === 'ASC' ? '↑' : '↓'}
            <span className="x" style={{ cursor: 'pointer', fontWeight: 700 }} onClick={() => setSort(null)}>
              ×
            </span>
          </span>
        )}
        <span style={{ position: 'relative' }}>
          <button onClick={() => setColsMenuOpen((o) => !o)} title="Show / hide preview columns">
            Columns{hidden.size ? ` (${hidden.size} hidden)` : ''} ▾
          </button>
          {colsMenuOpen && preview && (
            <div className="menu" style={{ top: '110%', right: 0, maxHeight: 300 }}>
              <div
                className="item"
                onClick={() => {
                  setHidden(new Set())
                  setColsMenuOpen(false)
                }}
              >
                Show all
              </div>
              <div className="sep" />
              {preview.columns.map((c) => (
                <label key={c.name} className="item" style={{ gap: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!hidden.has(c.name)}
                    onChange={(e) => {
                      setHidden((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.delete(c.name)
                        else next.add(c.name)
                        return next
                      })
                    }}
                  />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                </label>
              ))}
            </div>
          )}
        </span>
        <button onClick={() => void runProfile()} disabled={profiling}>
          {profiling ? 'Profiling…' : profile ? 'Refresh profile' : 'Profile fields'}
        </button>
      </div>
      <div className="ds-body">
        <div className="ds-fields">
          <div className="section-title" style={{ padding: '4px 0' }}>Fields</div>
          {fieldList.map((f) => (
            <div key={f.name} className={`field-item ${f.role}`} title={f.dbType} style={{ flexWrap: 'wrap' }}>
              <span className="type-icon">
                {f.kind === 'number' ? '#' : f.kind === 'date' ? '📅' : f.kind === 'bool' ? '◐' : 'Abc'}
              </span>
              <span className="name">{f.name}</span>
              <select
                value={f.role}
                onChange={(e) =>
                  useApp.getState().setFieldRole(id, f.name, e.target.value as 'dimension' | 'measure')
                }
                style={{ fontSize: 10, padding: '1px 2px' }}
              >
                <option value="dimension">Dim</option>
                <option value="measure">Meas</option>
              </select>
              {profile?.[f.name] && (
                <span style={{ width: '100%', fontSize: 10, color: 'var(--text-dim)', paddingLeft: 22 }}>
                  {profile[f.name].nullPct.toFixed(1)}% null · {profile[f.name].distinct.toLocaleString()} distinct
                </span>
              )}
            </div>
          ))}
          {calcFields.length > 0 && (
            <div className="section-title" style={{ padding: '8px 0 2px' }}>Calculated</div>
          )}
          {calcFields.map((c) => (
            <div key={c.name} className={`field-item ${c.role}`} title={c.expr}>
              <span className="type-icon">=</span>
              <span className="name">{c.name}</span>
              <span
                className="x"
                style={{ cursor: 'pointer', color: 'var(--text-dim)' }}
                onClick={() => useApp.getState().removeCalcField(id, c.name)}
                title="Delete calculated field"
              >
                ×
              </span>
            </div>
          ))}
        </div>
        <div className="ds-preview">
          {error && <div style={{ color: 'var(--red)', padding: 12 }}>{error}</div>}
          {preview && (
            <>
              <table className="grid">
                <thead>
                  <tr>
                    <th className="rownum">#</th>
                    {visibleColumns.map((c) => {
                      const w = colWidths[c.name]
                      const sorted = sort?.field === c.name
                      return (
                        <th
                          key={c.name}
                          onClick={() => cycleSort(c.name)}
                          title={`Click to sort · drag the right edge to resize`}
                          style={{
                            cursor: 'pointer',
                            position: 'sticky',
                            ...(w ? { width: w, minWidth: w, maxWidth: w } : {})
                          }}
                        >
                          <span
                            style={{
                              display: 'inline-block',
                              maxWidth: w ? w - 26 : undefined,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              verticalAlign: 'bottom'
                            }}
                          >
                            {c.name}
                          </span>
                          {sorted && <span style={{ color: 'var(--accent2)' }}> {sort!.dir === 'ASC' ? '↑' : '↓'}</span>}
                          <span
                            className="col-resize"
                            onMouseDown={(e) => startResize(e, c.name, w ?? 150)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i}>
                      <td className="rownum">{(pageNum * PAGE_SIZE + i + 1).toLocaleString()}</td>
                      {visibleColumns.map((c) => {
                        const w = colWidths[c.name]
                        return (
                          <td
                            key={c.name}
                            className={c.kind === 'number' ? 'num' : ''}
                            style={w ? { width: w, minWidth: w, maxWidth: w } : undefined}
                            title={row[c.name] === null ? undefined : String(row[c.name])}
                          >
                            {row[c.name] === null ? <em style={{ color: 'var(--text-dim)' }}>null</em> : String(row[c.name])}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                <button disabled={pageNum === 0} onClick={() => setPageNum(0)}>⏮ First</button>
                <button disabled={pageNum === 0} onClick={() => setPageNum((p) => p - 1)}>◀ Prev</button>
                <span style={{ color: 'var(--text-dim)' }}>
                  Page {pageNum + 1} / {maxPage + 1}
                </span>
                <button disabled={pageNum >= maxPage} onClick={() => setPageNum((p) => p + 1)}>Next ▶</button>
                <button disabled={pageNum >= maxPage} onClick={() => setPageNum(maxPage)}>Last ⏭</button>
              </div>
            </>
          )}
        </div>
      </div>
      {dialog === 'template' && <TemplateFieldDialog dsId={id} onClose={() => setDialog(null)} />}
      {dialog === 'dates' && <DateDerivedDialog dsId={id} onClose={() => setDialog(null)} />}
      {dialog === 'group' && <GroupDialog dsId={id} onClose={() => setDialog(null)} />}
      {dialog === 'patterns' && <DetectPatternsDialog dsId={id} onClose={() => setDialog(null)} />}
      {dialog === 'smart' && <SmartAnalysisDialog dsId={id} onClose={() => setDialog(null)} />}
      {dialog === 'wordcloud' && <WordcloudWizardDialog dsId={id} onClose={() => setDialog(null)} />}
      {dialog === 'entities' && <EntityWizardDialog dsId={id} onClose={() => setDialog(null)} />}
      {filterField && (
        <FilterDialog
          dsId={id}
          field={filterField.field}
          kind={filterField.kind}
          calcExpr={filterField.calcExpr}
          onAdd={(f) => {
            useApp.getState().setSourceFilters(id, [...sourceFilters, f])
            setFilterField(null)
            setPageNum(0)
          }}
          onClose={() => setFilterField(null)}
        />
      )}
    </div>
  )
}

function FilterFieldPicker({
  fields, onPick
}: {
  fields: FieldInfo[]
  onPick: (f: { field: string; kind: FieldInfo['kind'] }) => void
}): React.JSX.Element {
  return (
    <select
      value=""
      style={{ fontSize: 11 }}
      onChange={(e) => {
        const f = fields.find((x) => x.name === e.target.value)
        if (f) onPick({ field: f.name, kind: f.kind })
        e.target.value = ''
      }}
    >
      <option value="">+ Add filter…</option>
      {fields.map((f) => (
        <option key={f.name} value={f.name}>{f.name}</option>
      ))}
    </select>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import type { FieldInfo, QueryResult, ShelfState } from '@shared/types'
import {
  buildDetailQuery,
  calcFieldKind,
  fieldLabel,
  type DrillPair
} from '@shared/sqlBuilder'

const PAGE_SIZE = 100

/**
 * Drill-through panel: shows the source records behind a clicked chart mark
 * (or the whole filtered worksheet when pairs is empty), with search, sort,
 * pagination and CSV/XLSX export.
 */
export function ViewDataPanel({
  worksheetId, shelf, pairs, onClose
}: {
  worksheetId: string
  shelf: ShelfState
  pairs: DrillPair[]
  onClose: () => void
}): React.JSX.Element {
  const dsId = shelf.dataSourceId
  const calcFieldsRaw = useApp((s) => s.workbook.calculatedFields[dsId])
  const sourceFilters = useApp((s) => s.workbook.sourceFilters[dsId])
  const sheetName = useApp(
    (s) => s.workbook.worksheets.find((w) => w.id === worksheetId)?.name ?? 'data'
  )
  const dsFields = useApp((s) => s.fields[dsId])
  const calcFields = useMemo(() => calcFieldsRaw ?? [], [calcFieldsRaw])

  const searchColumns = useMemo(
    () => [...(dsFields ?? []).map((f) => f.name), ...calcFields.map((c) => c.name)],
    [dsFields, calcFields]
  )

  // must match the kinds the worksheet query was built with, or the TRY_CAST
  // guards (and thus the drill predicates) would diverge from the chart's SQL
  const fieldKinds = useMemo(() => {
    const kinds: Record<string, FieldInfo['kind']> = {}
    for (const f of dsFields ?? []) kinds[f.name] = f.kind
    for (const c of calcFields) kinds[c.name] = calcFieldKind(c)
    return kinds
  }, [dsFields, calcFields])

  const [page, setPage] = useState(0)
  const [total, setTotal] = useState<number | null>(null)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ field: string; dir: 'ASC' | 'DESC' } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busyMsg, setBusyMsg] = useState('')

  const detail = useMemo(
    () =>
      buildDetailQuery(shelf, calcFields, `ds_${dsId}`, pairs, {
        sourceFilters,
        fieldKinds,
        search: search ? { columns: searchColumns, text: search } : undefined,
        orderBy: sort ?? undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE
      }),
    [shelf, calcFields, dsId, pairs, sourceFilters, fieldKinds, search, searchColumns, sort, page]
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void Promise.all([api.runQuery(detail.sql), api.runQuery(detail.countSql)])
      .then(([res, cnt]) => {
        if (cancelled) return
        setResult(res)
        setTotal(Number(cnt.rows[0]?.n ?? 0))
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [detail])

  const doExport = async (format: 'csv' | 'xlsx'): Promise<void> => {
    setBusyMsg(`Exporting ${format.toUpperCase()}…`)
    try {
      const path = await api.exportData(detail.exportSql, format, `${sheetName}_records`)
      useApp.getState().setStatus(path ? `Exported → ${path}` : 'Export cancelled')
    } catch (e) {
      useApp.getState().setStatus(`Export failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusyMsg('')
    }
  }

  const maxPage = total !== null ? Math.max(0, Math.ceil(total / PAGE_SIZE) - 1) : 0

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide">
        <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>View Data — {sheetName}</span>
          {pairs.map((p, i) => (
            <span key={i} className="badge">
              {fieldLabel(p.ref)} = {p.value === null ? '∅' : String(p.value)}
            </span>
          ))}
          <span style={{ flex: 1 }} />
          <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-dim)' }}>
            {total !== null ? `${total.toLocaleString()} records` : ''}
          </span>
          <button onClick={onClose}>✕ Close</button>
        </header>
        <div className="body" style={{ flex: 1, minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              placeholder="Search all columns… (Enter)"
              value={searchInput}
              style={{ width: 260 }}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setSearch(searchInput)
                  setPage(0)
                }
              }}
            />
            <button onClick={() => { setSearch(searchInput); setPage(0) }}>Search</button>
            {search && (
              <button onClick={() => { setSearch(''); setSearchInput(''); setPage(0) }}>Clear</button>
            )}
            <span style={{ flex: 1 }} />
            <button onClick={() => void doExport('csv')}>Export CSV</button>
            <button onClick={() => void doExport('xlsx')}>Export Excel</button>
            {busyMsg && <span className="drop-hint">{busyMsg}</span>}
          </div>
          <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 4, position: 'relative' }}>
            {error && <div style={{ color: 'var(--red)', padding: 12, whiteSpace: 'pre-wrap' }}>{error}</div>}
            {!error && result && (
              <table className="grid">
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th
                        key={c.name}
                        style={{ cursor: 'pointer' }}
                        title="Click to sort"
                        onClick={() => {
                          setPage(0)
                          setSort((s) =>
                            s?.field === c.name
                              ? s.dir === 'ASC'
                                ? { field: c.name, dir: 'DESC' }
                                : null
                              : { field: c.name, dir: 'ASC' }
                          )
                        }}
                      >
                        {c.name}
                        {sort?.field === c.name ? (sort.dir === 'ASC' ? ' ▲' : ' ▼') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, ri) => (
                    <tr key={ri}>
                      {result.columns.map((c) => (
                        <td key={c.name} className={c.kind === 'number' ? 'num' : ''}>
                          {row[c.name] === null ? '∅' : String(row[c.name])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {loading && (
              <div className="loading-overlay">
                <div className="spinner" />
                <span>Loading records…</span>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>◀ Prev</button>
            <span style={{ color: 'var(--text-dim)' }}>
              Page {page + 1} / {maxPage + 1}
            </span>
            <button disabled={page >= maxPage} onClick={() => setPage((p) => p + 1)}>Next ▶</button>
          </div>
        </div>
      </div>
    </div>
  )
}

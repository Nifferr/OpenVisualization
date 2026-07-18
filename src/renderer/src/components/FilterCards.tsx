// Dashboard filter cards: the in-tile controls (value checklist, numeric
// range, date range) and the "+ Filter card" dialog. Selections persist on
// the tile (DashFilterCard) and are applied to every worksheet tile on the
// same data source via store.setTileFilter -> runDashboard.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useApp } from '../store'
import { calcFieldKind, resolvedCalcSql } from '@shared/sqlBuilder'
import type { DashboardTile, DashFilterCard, DistinctValue, FieldInfo } from '@shared/types'

const VALUES_PAGE = 200
const SEARCH_DEBOUNCE_MS = 300

export function filterCardModeFor(kind: FieldInfo['kind']): DashFilterCard['mode'] {
  if (kind === 'number') return 'range'
  if (kind === 'date') return 'dateRange'
  return 'in'
}

/**
 * Resolved SQL for a card's field when it is a calculated field —
 * distinctValues/fieldRange query the raw ds_<id> view, where calc fields
 * don't exist as columns. Undefined for real columns.
 */
function useCardCalcExpr(cfg: DashFilterCard): string | undefined {
  const calcFields = useApp((s) => s.workbook.calculatedFields[cfg.dsId])
  return useMemo(() => resolvedCalcSql(calcFields ?? [], cfg.field), [calcFields, cfg.field])
}

/** The interactive control rendered inside a filter-card tile's body. */
export function FilterCardBody({
  dashId,
  tile
}: {
  dashId: string
  tile: DashboardTile
}): React.JSX.Element {
  const cfg = tile.filter!
  if (cfg.mode === 'range') return <RangeCard dashId={dashId} tile={tile} />
  if (cfg.mode === 'dateRange') return <DateRangeCard dashId={dashId} tile={tile} />
  return <ValuesCard dashId={dashId} tile={tile} />
}

function ValuesCard({ dashId, tile }: { dashId: string; tile: DashboardTile }): React.JSX.Element {
  const cfg = tile.filter!
  const calcExpr = useCardCalcExpr(cfg)
  const [search, setSearch] = useState('')
  const [values, setValues] = useState<DistinctValue[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState('')
  const selected = useMemo(() => new Set(cfg.values ?? []), [cfg.values])

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      api
        .distinctValues(cfg.dsId, cfg.field, {
          expr: calcExpr,
          search: search || undefined,
          limit: VALUES_PAGE,
          orderBy: 'count'
        })
        .then((res) => {
          if (cancelled) return
          setValues(res.values)
          setTotal(res.total)
          setError('')
        })
        .catch((e) => {
          if (cancelled) return
          setError(e instanceof Error ? e.message : String(e))
        })
    }, search ? SEARCH_DEBOUNCE_MS : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cfg.dsId, cfg.field, calcExpr, search])

  const toggle = (v: string): void => {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    useApp.getState().setTileFilter(dashId, tile.id, { values: [...next] })
  }

  return (
    <div className="fcard">
      <div className="fcard-top">
        <input
          className="fcard-search"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="fcard-clear"
          title="Clear the selection (show everything)"
          disabled={!selected.size}
          onClick={() => useApp.getState().setTileFilter(dashId, tile.id, { values: [] })}
        >
          All
        </button>
      </div>
      <div className="fcard-hint">
        {selected.size ? `${selected.size} selected` : 'Nothing selected — showing all'}
        {total > values.length ? ` · ${values.length} of ${total.toLocaleString()} values` : ''}
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 11 }}>{error}</div>}
      <div className="fcard-list">
        {values.map((dv) => (
          <label key={dv.v}>
            <input type="checkbox" checked={selected.has(dv.v)} onChange={() => toggle(dv.v)} />
            <span className="vtext" title={dv.v === '' ? 'Empty or NULL' : dv.v}>
              {dv.v === '' ? '(blank)' : dv.v}
            </span>
            <span className="vcount">{dv.n.toLocaleString()}</span>
          </label>
        ))}
        {!values.length && !error && <div className="drop-hint">No values.</div>}
      </div>
    </div>
  )
}

function RangeCard({ dashId, tile }: { dashId: string; tile: DashboardTile }): React.JSX.Element {
  const cfg = tile.filter!
  const calcExpr = useCardCalcExpr(cfg)
  const [extent, setExtent] = useState<{ min: unknown; max: unknown } | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .fieldRange(cfg.dsId, cfg.field, calcExpr)
      .then((r) => !cancelled && setExtent(r))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [cfg.dsId, cfg.field, calcExpr])

  const patch = (key: 'min' | 'max', raw: string): void => {
    const v = raw.trim() === '' ? undefined : Number(raw)
    useApp.getState().setTileFilter(dashId, tile.id, {
      [key]: v !== undefined && Number.isFinite(v) ? v : undefined
    })
  }

  return (
    <div className="fcard">
      <div className="fcard-range">
        <input
          type="number"
          placeholder={extent?.min !== undefined && extent?.min !== null ? String(extent.min) : 'min'}
          defaultValue={cfg.min ?? ''}
          onChange={(e) => patch('min', e.target.value)}
        />
        <span>—</span>
        <input
          type="number"
          placeholder={extent?.max !== undefined && extent?.max !== null ? String(extent.max) : 'max'}
          defaultValue={cfg.max ?? ''}
          onChange={(e) => patch('max', e.target.value)}
        />
      </div>
      <div className="fcard-hint">
        {cfg.min === undefined && cfg.max === undefined
          ? 'No bounds — showing all'
          : `${cfg.min ?? '…'} to ${cfg.max ?? '…'}`}
      </div>
    </div>
  )
}

function DateRangeCard({ dashId, tile }: { dashId: string; tile: DashboardTile }): React.JSX.Element {
  const cfg = tile.filter!
  const patch = (key: 'from' | 'to', raw: string): void => {
    useApp.getState().setTileFilter(dashId, tile.id, { [key]: raw || undefined })
  }
  return (
    <div className="fcard">
      <div className="fcard-range">
        <input type="date" defaultValue={cfg.from ?? ''} onChange={(e) => patch('from', e.target.value)} />
        <span>—</span>
        <input type="date" defaultValue={cfg.to ?? ''} onChange={(e) => patch('to', e.target.value)} />
      </div>
      <div className="fcard-hint">
        {!cfg.from && !cfg.to ? 'No bounds — showing all' : `${cfg.from ?? '…'} → ${cfg.to ?? '…'}`}
      </div>
    </div>
  )
}

/** Dialog that creates a filter-card tile: pick a data source and a field. */
export function AddFilterCardDialog({
  onAdd,
  onClose
}: {
  onAdd: (cfg: DashFilterCard) => void
  onClose: () => void
}): React.JSX.Element {
  const dataSources = useApp((s) => s.workbook.dataSources)
  const fields = useApp((s) => s.fields)
  const calcFieldsAll = useApp((s) => s.workbook.calculatedFields)
  const [dsId, setDsId] = useState(dataSources[0]?.id ?? '')
  const [field, setField] = useState('')
  const [label, setLabel] = useState('')

  const dsFields = useMemo(() => {
    const raw = fields[dsId] ?? []
    const calcInfo: FieldInfo[] = (calcFieldsAll[dsId] ?? []).map((c) => ({
      name: c.name, dbType: 'CALCULATED', kind: calcFieldKind(c), role: c.role
    }))
    return [...raw, ...calcInfo]
  }, [fields, calcFieldsAll, dsId])
  useEffect(() => {
    if (!dsFields.some((f) => f.name === field)) setField(dsFields[0]?.name ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsId])

  const kind = dsFields.find((f) => f.name === field)?.kind ?? 'string'
  const mode = filterCardModeFor(kind)
  const modeLabel = { in: 'value checklist', range: 'numeric range', dateRange: 'date range' }[mode]

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 420 }}>
        <header>New Filter Card</header>
        <div className="body">
          <div className="form-row">
            <label>Data source</label>
            <select value={dsId} onChange={(e) => setDsId(e.target.value)}>
              {dataSources.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>Field</label>
            <select value={field} onChange={(e) => setField(e.target.value)}>
              {dsFields.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>Label</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={field} />
          </div>
          <div className="drop-hint">
            Control: {modeLabel}. The card filters every tile on this data source — here and in the
            exported HTML, where it stays interactive.
          </div>
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!dsId || !field}
            onClick={() => onAdd({ dsId, field, mode, label: label.trim() || undefined })}
          >
            Add
          </button>
        </footer>
      </div>
    </div>
  )
}

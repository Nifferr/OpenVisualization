import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { DistinctValue, FieldInfo, Filter } from '@shared/types'
import { quoteIdent, quoteLiteral, validateExpression } from '@shared/sqlBuilder'

/** page size for the Values tab — server search + paging cover the rest */
const VALUES_PAGE = 500

type TextOp =
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'equals'
  | 'notEquals'
  | 'isNull'
  | 'notNull'

const TEXT_OPS: Array<{ op: TextOp; label: string; needsValue: boolean }> = [
  { op: 'contains', label: 'Contains', needsValue: true },
  { op: 'notContains', label: 'Does not contain', needsValue: true },
  { op: 'startsWith', label: 'Starts with', needsValue: true },
  { op: 'endsWith', label: 'Ends with', needsValue: true },
  { op: 'equals', label: 'Equals', needsValue: true },
  { op: 'notEquals', label: 'Does not equal', needsValue: true },
  { op: 'isNull', label: 'Is null', needsValue: false },
  { op: 'notNull', label: 'Is not null', needsValue: false }
]

function likePattern(v: string, pre: string, post: string): string {
  return pre + v.replace(/([\\%_])/g, '\\$1') + post
}

function textOpExpr(field: string, op: TextOp, value: string): string {
  const col = `CAST(${quoteIdent(field)} AS VARCHAR)`
  switch (op) {
    case 'contains':
      return `${col} ILIKE ${quoteLiteral(likePattern(value, '%', '%'))} ESCAPE '\\'`
    case 'notContains':
      return `(${col} NOT ILIKE ${quoteLiteral(likePattern(value, '%', '%'))} ESCAPE '\\' OR ${quoteIdent(field)} IS NULL)`
    case 'startsWith':
      return `${col} ILIKE ${quoteLiteral(likePattern(value, '', '%'))} ESCAPE '\\'`
    case 'endsWith':
      return `${col} ILIKE ${quoteLiteral(likePattern(value, '%', ''))} ESCAPE '\\'`
    case 'equals':
      return `${col} = ${quoteLiteral(value)}`
    case 'notEquals':
      return `(${col} <> ${quoteLiteral(value)} OR ${quoteIdent(field)} IS NULL)`
    case 'isNull':
      return `${quoteIdent(field)} IS NULL`
    case 'notNull':
      return `${quoteIdent(field)} IS NOT NULL`
  }
}

export function FilterDialog({
  dsId, field, kind, calcExpr, onAdd, onClose
}: {
  dsId: string
  field: string
  kind: FieldInfo['kind']
  /** SQL expression backing `field` when it's a calculated field (not a real column). */
  calcExpr?: string
  onAdd: (f: Filter) => void
  onClose: () => void
}): React.JSX.Element {
  // "Number of Records" is the count(*) pseudo-field — it only exists as an
  // aggregate over a group, so it has no per-row value a WHERE-style filter
  // (this app's only filter mechanism) could ever test against.
  const isCountPseudo = field === '*'
  const isCategorical = kind === 'string' || kind === 'bool'
  const [mode, setMode] = useState<'values' | 'condition' | 'range' | 'dateRange' | 'expr'>(
    isCategorical ? 'values' : kind === 'number' ? 'range' : 'dateRange'
  )
  const [values, setValues] = useState<DistinctValue[] | null>(null)
  const [total, setTotal] = useState(0)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [exclude, setExclude] = useState(false)
  const [search, setSearch] = useState('')
  const [debSearch, setDebSearch] = useState('')
  const [orderBy, setOrderBy] = useState<'value' | 'count'>('value')
  const [loadingMore, setLoadingMore] = useState(false)
  const reqSeq = useRef(0)
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [textOp, setTextOp] = useState<TextOp>('contains')
  const [textVal, setTextVal] = useState('')
  const [expr, setExpr] = useState(`${quoteIdent(field)} `)
  const [error, setError] = useState('')

  // debounce the search box so every keystroke doesn't fire a query
  useEffect(() => {
    const t = setTimeout(() => setDebSearch(search), 300)
    return (): void => clearTimeout(t)
  }, [search])

  // Values tab: server-side search over the FULL distinct domain, first page.
  // `checked` deliberately survives searches so selections accumulate.
  useEffect(() => {
    if (isCountPseudo || !isCategorical) return
    setError('')
    setValues(null)
    setLoadingMore(false) // a fresh page-0 load supersedes any in-flight "load more"
    const seq = ++reqSeq.current
    api
      .distinctValues(dsId, field, {
        expr: calcExpr,
        search: debSearch,
        orderBy,
        limit: VALUES_PAGE
      })
      .then((r) => {
        if (reqSeq.current !== seq) return
        setValues(r.values)
        setTotal(r.total)
      })
      .catch((e) => {
        if (reqSeq.current !== seq) return
        setValues([])
        setTotal(0)
        setError(`Could not load values: ${e instanceof Error ? e.message : String(e)}`)
      })
  }, [dsId, field, isCategorical, calcExpr, isCountPseudo, debSearch, orderBy])

  useEffect(() => {
    if (isCountPseudo || kind !== 'number') return
    setError('')
    api
      .fieldRange(dsId, field, calcExpr)
      .then((r) => {
        setMin(String(r.min ?? ''))
        setMax(String(r.max ?? ''))
      })
      .catch((e) => {
        setError(`Could not load range: ${e instanceof Error ? e.message : String(e)}`)
      })
  }, [dsId, field, kind, calcExpr, isCountPseudo])

  const loadMore = (): void => {
    if (!values || loadingMore) return
    setLoadingMore(true)
    const seq = ++reqSeq.current
    api
      .distinctValues(dsId, field, {
        expr: calcExpr,
        search: debSearch,
        orderBy,
        offset: values.length,
        limit: VALUES_PAGE
      })
      .then((r) => {
        if (reqSeq.current !== seq) return
        setValues([...values, ...r.values])
        setTotal(r.total)
        setLoadingMore(false)
      })
      .catch((e) => {
        if (reqSeq.current !== seq) return
        setLoadingMore(false)
        setError(`Could not load values: ${e instanceof Error ? e.message : String(e)}`)
      })
  }

  const apply = (): void => {
    setError('')
    if (mode === 'values') {
      if (checked.size === 0) {
        setError(
          exclude
            ? 'Check at least one value to exclude.'
            : 'Check at least one value to keep — or turn on "Exclude selected" to keep everything except the checked values.'
        )
        return
      }
      onAdd({ kind: 'in', field, values: [...checked], exclude: exclude || undefined })
    } else if (mode === 'range') {
      onAdd({
        kind: 'range',
        field,
        min: min === '' ? undefined : Number(min),
        max: max === '' ? undefined : Number(max)
      })
    } else if (mode === 'dateRange') {
      onAdd({ kind: 'dateRange', field, from: from || undefined, to: to || undefined })
    } else if (mode === 'condition') {
      const def = TEXT_OPS.find((t) => t.op === textOp)!
      if (def.needsValue && !textVal.trim()) {
        setError('Enter a value for this condition')
        return
      }
      onAdd({ kind: 'expr', expr: textOpExpr(field, textOp, textVal) })
    } else {
      const guard = validateExpression(expr)
      if (guard) {
        setError(guard)
        return
      }
      if (!expr.trim()) {
        setError('Enter an expression')
        return
      }
      onAdd({ kind: 'expr', expr })
    }
  }

  const tabs: Array<{ id: typeof mode; label: string }> = [
    ...(isCategorical ? [{ id: 'values' as const, label: 'Values' }] : []),
    ...(kind === 'number' ? [{ id: 'range' as const, label: 'Range' }] : []),
    ...(kind === 'date' || kind === 'other' ? [{ id: 'dateRange' as const, label: 'Date range' }] : []),
    { id: 'condition' as const, label: 'Condition' },
    { id: 'expr' as const, label: 'Expression' }
  ]

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 480 }}>
        <header>Filter: {isCountPseudo ? 'Number of Records' : field}</header>
        <div className="body">
          {isCountPseudo ? (
            <div className="drop-hint">
              "Number of Records" is an aggregate (count of rows in a group), not a
              value any single row has — so it can't be tested by a row filter. Use
              Top N on the Rows/Columns shelf to limit by frequency instead.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 4 }}>
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    className={mode === t.id ? 'primary' : ''}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={() => setMode(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {mode === 'values' && (
                <>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      style={{ flex: 1 }}
                      placeholder="Search all values…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <select
                      value={orderBy}
                      title="Sort values"
                      onChange={(e) => setOrderBy(e.target.value as 'value' | 'count')}
                    >
                      <option value="value">A → Z</option>
                      <option value="count">By count</option>
                    </select>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button
                      title="Check every value shown below"
                      onClick={() =>
                        setChecked(new Set([...checked, ...(values ?? []).map((x) => x.v)]))
                      }
                    >
                      All shown
                    </button>
                    <button onClick={() => setChecked(new Set())}>None</button>
                    <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input type="checkbox" checked={exclude} onChange={(e) => setExclude(e.target.checked)} />
                      Exclude selected
                    </label>
                    <span className="drop-hint" style={{ marginLeft: 'auto' }}>
                      {checked.size} selected · {values?.length ?? 0} of {total} value{total === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="checklist">
                    {(values ?? []).map(({ v, n }) => (
                      <label key={v}>
                        <input
                          type="checkbox"
                          checked={checked.has(v)}
                          onChange={(e) => {
                            const next = new Set(checked)
                            if (e.target.checked) next.add(v)
                            else next.delete(v)
                            setChecked(next)
                          }}
                        />
                        <span className="vtext" title={v || '(blank = empty or null)'}>
                          {v || '(blank)'}
                        </span>
                        <span className="vcount">{n.toLocaleString()}</span>
                      </label>
                    ))}
                    {!values && <div className="drop-hint">Loading values…</div>}
                    {values && values.length === 0 && (
                      <div className="drop-hint">
                        {debSearch ? `No values match "${debSearch}"` : 'No values'}
                      </div>
                    )}
                  </div>
                  {values && values.length < total && (
                    <button onClick={loadMore} disabled={loadingMore}>
                      {loadingMore
                        ? 'Loading…'
                        : `Load ${Math.min(VALUES_PAGE, total - values.length).toLocaleString()} more (${(total - values.length).toLocaleString()} remaining)`}
                    </button>
                  )}
                  {total > (values?.length ?? 0) && (
                    <div className="drop-hint">
                      Tip: search hits all {total.toLocaleString()} values server-side; to keep
                      everything except a few, check them and use "Exclude selected".
                    </div>
                  )}
                </>
              )}
              {mode === 'range' && (
                <div className="form-row">
                  <label>Range</label>
                  <input value={min} onChange={(e) => setMin(e.target.value)} placeholder="min" />
                  <span>—</span>
                  <input value={max} onChange={(e) => setMax(e.target.value)} placeholder="max" />
                </div>
              )}
              {mode === 'dateRange' && (
                <div className="form-row">
                  <label>Date range</label>
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                  <span>—</span>
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              )}
              {mode === 'condition' && (
                <div className="form-row">
                  <select value={textOp} onChange={(e) => setTextOp(e.target.value as TextOp)}>
                    {TEXT_OPS.map((t) => (
                      <option key={t.op} value={t.op}>{t.label}</option>
                    ))}
                  </select>
                  {TEXT_OPS.find((t) => t.op === textOp)!.needsValue && (
                    <input value={textVal} onChange={(e) => setTextVal(e.target.value)} placeholder="value" />
                  )}
                </div>
              )}
              {mode === 'expr' && (
                <>
                  <div className="drop-hint">DuckDB boolean expression over the source columns:</div>
                  <textarea
                    rows={3}
                    style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
                    value={expr}
                    onChange={(e) => setExpr(e.target.value)}
                    placeholder={`${quoteIdent(field)} > 100 AND ${quoteIdent(field)} < 900`}
                  />
                </>
              )}
              {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}
            </>
          )}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          {!isCountPseudo && <button className="primary" onClick={apply}>Add Filter</button>}
        </footer>
      </div>
    </div>
  )
}

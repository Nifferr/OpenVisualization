import { useEffect, useMemo, useRef, useState } from 'react'
import type { ECharts } from 'echarts'
import { api } from '../api'
import { useApp } from '../store'
import { EChart, renderChartPng } from '../charts/EChart'
import { buildChartOption, clickToPairs, type ChartClickParams } from '../charts/optionBuilder'
import { toLightOption } from '../charts/exportTheme'
import {
  AGG_LABELS,
  DATE_BIN_LABELS,
  FIELD_KIND_LABELS,
  TABLE_CALC_LABELS,
  type Agg,
  type CalcField,
  type CalcKind,
  type ChartType,
  type ColorRule,
  type DateBin,
  type FieldInfo,
  type FieldRef,
  type QueryResult,
  type ReferenceLine,
  type ShelfState,
  type TableCalcKind,
  type TopNSpec
} from '@shared/types'
import {
  calcFieldKind,
  resolvedCalcSql,
  CHART_TYPES,
  chartTypeApplicable,
  collectRefs,
  fieldLabel,
  NUMERIC_AGGS,
  validateExpression,
  type BuiltQuery,
  type DrillPair
} from '@shared/sqlBuilder'
import { ChartGuide } from './ChartGuide'
import { FilterDialog } from './FilterDialog'
import { ViewDataPanel } from './ViewDataPanel'

interface DragPayload {
  field: string
  role: 'dimension' | 'measure'
  kind: FieldInfo['kind']
}

function setDrag(e: React.DragEvent, p: DragPayload): void {
  e.dataTransfer.setData('application/x-field', JSON.stringify(p))
  e.dataTransfer.effectAllowed = 'copy'
}

function getDrag(e: React.DragEvent): DragPayload | null {
  const raw = e.dataTransfer.getData('application/x-field')
  if (!raw) return null
  try {
    return JSON.parse(raw) as DragPayload
  } catch {
    return null
  }
}

function refFromPayload(p: DragPayload): FieldRef {
  if (p.role === 'measure') {
    // SUM over text/date/bool would be a Binder Error — default those to count
    const agg: Agg = p.field === '*' ? 'count' : p.kind === 'number' ? 'sum' : 'count'
    return { field: p.field, role: 'measure', agg }
  }
  return { field: p.field, role: 'dimension' }
}

// pills already on a shelf drag with their own payload type so a reorder/move
// (effect 'move') never collides with the field-list drop path (effect 'copy')
type PillShelfKey = 'columns' | 'rows' | 'tooltip'
interface PillDragPayload {
  from: PillShelfKey
  index: number
}

function setPillDrag(e: React.DragEvent, p: PillDragPayload): void {
  e.dataTransfer.setData('application/x-pill', JSON.stringify(p))
  e.dataTransfer.effectAllowed = 'move'
}

function getPillDrag(e: React.DragEvent): PillDragPayload | null {
  const raw = e.dataTransfer.getData('application/x-pill')
  if (!raw) return null
  try {
    return JSON.parse(raw) as PillDragPayload
  } catch {
    return null
  }
}

const CHART_GLYPHS: Record<ChartType, string> = {
  table: '▦', bar: '▮', barh: '▬', stackedBar: '▤', percentBar: '％', line: '╱',
  area: '◪', stackedArea: '◩', scatter: '∴', bubble: '◉', pie: '◕', donut: '◍',
  rose: '❀', heatmap: '▩', treemap: '◫', sunburst: '☀', sankey: '⇶', funnel: '▽',
  gauge: '◔', radar: '✦', boxplot: '𝍩', calendar: '📅', candlestick: '𝍪',
  waterfall: '⇘', pareto: '⫽', themeriver: '≋', parallel: '∥', graph: '🕸',
  tree: '🌳', wordcloud: '☁', map: '🗺', combo: '⧉', stepLine: '⌐', effectScatter: '✨',
  stackedBarH: '≡', percentBarH: '﹪', smoothLine: '∿', polarBar: '◎', lollipop: '🍭',
  rangeBar: '⇕', bullet: '➤', kpi: '🔢', pictorial: '⣿', pyramid: '△', halfDonut: '◗',
  mapPoints: '📌', mapFlow: '✈', graphCircular: '⭕', treeRadial: '❋'
}

export function WorksheetPage({ id }: { id: string }): React.JSX.Element {
  // slice subscriptions: unrelated store churn (status line, other sheets'
  // loading/results) must not re-render this whole page
  const sheet = useApp((s) => s.workbook.worksheets.find((w) => w.id === id))
  const dsId = sheet?.shelf.dataSourceId
  const dataSources = useApp((s) => s.workbook.dataSources)
  const dsFieldsRaw = useApp((s) => (dsId ? s.fields[dsId] : undefined))
  const calcFieldsRaw = useApp((s) => (dsId ? s.workbook.calculatedFields[dsId] : undefined))
  const res = useApp((s) => s.results[id])
  const err = useApp((s) => s.errors[id])
  const isLoading = useApp((s) => !!s.loading[id])
  const chartRef = useRef<ECharts | null>(null)
  const [calcOpen, setCalcOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [fieldSearch, setFieldSearch] = useState('')
  const [filterField, setFilterField] = useState<
    { field: string; kind: FieldInfo['kind']; calcExpr?: string } | null
  >(null)
  const [drill, setDrill] = useState<DrillPair[] | null>(null)
  const [refLineOpen, setRefLineOpen] = useState(false)
  const [colorRulesOpen, setColorRulesOpen] = useState(false)

  useEffect(() => {
    void useApp.getState().runWorksheet(id)
  }, [id])

  // all hooks stay above the not-found guard (constant hook count per render)
  const shelfMemo = sheet?.shelf
  const option = useMemo(() => {
    if (!res || !shelfMemo || shelfMemo.chartType === 'table') return null
    try {
      return buildChartOption(shelfMemo, res.built, res.result)
    } catch (e) {
      console.error('[chart] option build failed:', e)
      return null
    }
  }, [res, shelfMemo])

  if (!sheet) return <div style={{ padding: 20 }}>Worksheet not found.</div>
  const shelf = sheet.shelf
  const dsFields = dsFieldsRaw ?? []
  const calcFields = calcFieldsRaw ?? []
  // pills and Top N must resolve calc fields too (kind by declared role),
  // otherwise a calculated measure would look like text and warn wrongly
  const pillFields: FieldInfo[] = [
    ...dsFields,
    ...calcFields.map((c) => ({
      name: c.name,
      dbType: 'CALCULATED',
      kind: calcFieldKind(c),
      role: c.role
    }))
  ]

  const update = (fn: (s: ShelfState) => ShelfState): void =>
    useApp.getState().updateShelf(id, fn)

  /** Move a pill to `toIndex` of shelf `to` (possibly from another shelf). */
  const movePill = (p: PillDragPayload, to: PillShelfKey, toIndex: number): void => {
    if (p.from === to && (toIndex === p.index || toIndex === p.index + 1)) return // dropped in place
    update((s) => {
      const arrs: Record<PillShelfKey, FieldRef[]> = {
        columns: [...s.columns],
        rows: [...s.rows],
        tooltip: [...s.tooltip]
      }
      const [moved] = arrs[p.from].splice(p.index, 1)
      if (!moved) return s
      let idx = toIndex
      if (p.from === to && p.index < toIndex) idx -= 1 // account for the removed slot
      arrs[to].splice(Math.max(0, Math.min(idx, arrs[to].length)), 0, moved)
      return { ...s, columns: arrs.columns, rows: arrs.rows, tooltip: arrs.tooltip }
    })
  }

  const fieldMatches = (name: string): boolean =>
    name.toLowerCase().includes(fieldSearch.trim().toLowerCase())

  const calcDims = calcFields.filter((c) => c.role === 'dimension' && fieldMatches(c.name))
  const calcMeas = calcFields.filter((c) => c.role === 'measure' && fieldMatches(c.name))

  const { dims, meas } = collectRefs(shelf)

  const onChartReady = (chart: ECharts): void => {
    chartRef.current = chart
    chart.off('click')
    chart.on('click', (params) => {
      // read fresh state: the closure may outlive several shelf edits
      const st = useApp.getState()
      const ws = st.workbook.worksheets.find((w) => w.id === id)
      const r = st.results[id]
      if (!ws || !r) return
      const pairs = clickToPairs(ws.shelf, r.built, r.result, params as ChartClickParams)
      if (pairs) setDrill(pairs)
    })
  }

  return (
    <div className="ws">
      <div className="ws-left">
        <div className="section-title">
          Data
          <select
            value={shelf.dataSourceId}
            onChange={(e) => {
              const dsId = e.target.value
              update((s) => ({ ...s, dataSourceId: dsId, rows: [], columns: [], filters: [], color: undefined, size: undefined, label: undefined, tooltip: [] }))
            }}
            style={{ maxWidth: 130 }}
          >
            {dataSources.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
        <div style={{ padding: '6px 8px 0' }}>
          <input
            style={{ width: '100%' }}
            placeholder="🔍 Search fields…"
            value={fieldSearch}
            onChange={(e) => setFieldSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setFieldSearch('')}
            title="Filter the field list (Esc clears)"
          />
        </div>
        <div className="section-title">
          Dimensions
        </div>
        <div className="field-list" style={{ flex: 1 }}>
          {dsFields.filter((f) => f.role === 'dimension' && fieldMatches(f.name)).map((f) => (
            <FieldItem key={f.name} field={f} />
          ))}
          {calcDims.length > 0 && <div className="field-sub-head">Calculated</div>}
          {calcDims.map((c) => (
            <CalcItem key={c.name} calc={c} dsId={shelf.dataSourceId} />
          ))}
          <div className="section-title" style={{ padding: '8px 0 2px' }}>
            Measures
            <button style={{ fontSize: 10, padding: '1px 6px' }} onClick={() => setCalcOpen(true)} title="New calculated field">
              + Calc
            </button>
          </div>
          {fieldMatches('Number of Records') && (
            <div
              className="field-item measure"
              draggable
              onDragStart={(e) => setDrag(e, { field: '*', role: 'measure', kind: 'number' })}
            >
              <span className="type-icon">Σ</span>
              <span className="name"><em>Number of Records</em></span>
            </div>
          )}
          {dsFields.filter((f) => f.role === 'measure' && fieldMatches(f.name)).map((f) => (
            <FieldItem key={f.name} field={f} />
          ))}
          {calcMeas.length > 0 && <div className="field-sub-head">Calculated</div>}
          {calcMeas.map((c) => (
            <CalcItem key={c.name} calc={c} dsId={shelf.dataSourceId} />
          ))}
        </div>
      </div>

      <div className="ws-center">
        <ShelfRow label="Columns" shelfKey="columns" refs={shelf.columns} dsFields={pillFields} chartType={shelf.chartType}
          onDropRef={(r) => update((s) => ({ ...s, columns: [...s.columns, r] }))}
          onChange={(refs) => update((s) => ({ ...s, columns: refs }))}
          onMovePill={movePill} />
        <ShelfRow label="Rows" shelfKey="rows" refs={shelf.rows} dsFields={pillFields} chartType={shelf.chartType}
          onDropRef={(r) => update((s) => ({ ...s, rows: [...s.rows, r] }))}
          onChange={(refs) => update((s) => ({ ...s, rows: refs }))}
          onMovePill={movePill} />
        <div className="shelf-row">
          <div className="shelf-label">Filters</div>
          <div className="shelf" style={{ gap: 8 }}>
            {shelf.filters.map((f, i) => (
              <span key={i} className="filter-chip" title={JSON.stringify(f)}>
                {f.kind === 'expr' ? f.expr : `${'field' in f ? f.field : ''} (${f.kind})`}
                <span
                  className="x"
                  style={{ cursor: 'pointer', fontWeight: 700 }}
                  onClick={() => update((s) => ({ ...s, filters: s.filters.filter((_x, j) => j !== i) }))}
                >
                  ×
                </span>
              </span>
            ))}
            <FieldDropZone
              hint="+ drop field to filter"
              onDropPayload={(p) => {
                setFilterField({
                  field: p.field,
                  kind: p.kind,
                  // dependencies on other calc fields inlined — the filter
                  // dialog queries ds_<id> directly, where only raw columns exist
                  calcExpr: resolvedCalcSql(calcFields, p.field)
                })
              }}
            />
          </div>
        </div>

        <div className="ws-body">
          <div className="marks-panel">
            <h4>Marks</h4>
            <MarkSlot label="Color" refVal={shelf.color} dsFields={pillFields}
              onDropRef={(r) => update((s) => ({ ...s, color: r }))}
              onClear={() => update((s) => ({ ...s, color: undefined }))}
              onChange={(r) => update((s) => ({ ...s, color: r }))} />
            <MarkSlot label="Size" refVal={shelf.size} dsFields={pillFields}
              onDropRef={(r) => update((s) => ({ ...s, size: r }))}
              onClear={() => update((s) => ({ ...s, size: undefined }))}
              onChange={(r) => update((s) => ({ ...s, size: r }))} />
            <MarkSlot label="Label" refVal={shelf.label} dsFields={pillFields}
              onDropRef={(r) => update((s) => ({ ...s, label: r }))}
              onClear={() => update((s) => ({ ...s, label: undefined }))}
              onChange={(r) => update((s) => ({ ...s, label: r }))} />
            <div className="mark-slot">
              <div className="slot-label">Tooltip</div>
              <div className="slot"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  const pp = getPillDrag(e)
                  if (pp) {
                    movePill(pp, 'tooltip', shelf.tooltip.length)
                    return
                  }
                  const p = getDrag(e)
                  if (p) update((s) => ({ ...s, tooltip: [...s.tooltip, refFromPayload(p)] }))
                }}
              >
                {shelf.tooltip.map((r, i) => (
                  <Pill key={`${r.field}:${i}`} refVal={r} dsFields={pillFields}
                    dragSource={{ from: 'tooltip', index: i }}
                    onPillDrop={(p, side) => movePill(p, 'tooltip', side === 'before' ? i : i + 1)}
                    onRemove={() => update((s) => ({ ...s, tooltip: s.tooltip.filter((_x, j) => j !== i) }))}
                    onChange={(nr) => update((s) => ({ ...s, tooltip: s.tooltip.map((x, j) => (j === i ? nr : x)) }))} />
                ))}
              </div>
            </div>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button
                title="Browse the source records behind this view (you can also click any chart mark)"
                onClick={() => setDrill([])}
              >
                🔍 View Data
              </button>
              <button
                title="Average/median/min/max/constant lines drawn across the chart"
                onClick={() => setRefLineOpen(true)}
              >
                📏 Reference Lines{shelf.referenceLines?.length ? ` (${shelf.referenceLines.length})` : ''}
              </button>
              <button
                title="Value-based mark coloring (conditional formatting)"
                onClick={() => setColorRulesOpen(true)}
              >
                🎨 Color Rules{shelf.colorRules?.length ? ` (${shelf.colorRules.length})` : ''}
              </button>
            </div>
            <ExportMenu worksheetId={id} chartRef={chartRef} />
          </div>

          <div className="chart-area">
            {isLoading && !res && (
              <div className="empty-hint">
                <span><span className="spinner" /> Executing query…</span>
              </div>
            )}
            {!isLoading && !res && !err && (
              <div className="empty-hint">
                Drag fields to Rows and Columns to build a view.<br />
                Dimensions are blue, measures are green.
              </div>
            )}
            {res && shelf.chartType === 'table' && <ResultTable res={res} />}
            {res && option && (
              <EChart option={option} onReady={onChartReady} resetKey={shelf.chartType} />
            )}
            {isLoading && res && (
              <div className="loading-overlay">
                <span className="spinner" /> Executing query…
              </div>
            )}
            {err && <div className="chart-error">{err}</div>}
          </div>

          <div className="showme">
            <h4>
              Show Me ({CHART_TYPES.length} types)
              <button
                style={{ fontSize: 10, padding: '1px 7px', marginLeft: 6 }}
                title="Open the chart guide"
                onClick={() => setGuideOpen(true)}
              >
                ? Guide
              </button>
            </h4>
            <div className="types">
              {CHART_TYPES.map((ct) => {
                const ok = chartTypeApplicable(ct, dims.length, shelf.chartType === 'boxplot' && ct.type === 'boxplot' ? 1 : meas.length)
                const title = ok
                  ? ct.hint
                  : `${ct.hint} — you have ${dims.length} dimension(s) and ${meas.length} measure(s)`
                return (
                  <div
                    key={ct.type}
                    className={`ct ${shelf.chartType === ct.type ? 'active' : ''} ${ok ? '' : 'disabled'}`}
                    title={title}
                    onClick={() => ok && update((s) => ({ ...s, chartType: ct.type }))}
                  >
                    <span className="glyph">{CHART_GLYPHS[ct.type]}</span>
                    {ct.label}
                  </div>
                )
              })}
            </div>
            {res && (
              <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 11 }}>View SQL</summary>
                <pre style={{ fontSize: 10, whiteSpace: 'pre-wrap', color: 'var(--text-dim)' }}>{res.built.sql}</pre>
              </details>
            )}
          </div>
        </div>
      </div>

      {guideOpen && <ChartGuide nDims={dims.length} nMeas={meas.length} onClose={() => setGuideOpen(false)} />}
      {calcOpen && <CalcFieldDialog dsId={shelf.dataSourceId} onClose={() => setCalcOpen(false)} />}
      {filterField && (
        <FilterDialog
          dsId={shelf.dataSourceId}
          field={filterField.field}
          kind={filterField.kind}
          calcExpr={filterField.calcExpr}
          onAdd={(f) => {
            update((s) => ({ ...s, filters: [...s.filters, f] }))
            setFilterField(null)
          }}
          onClose={() => setFilterField(null)}
        />
      )}
      {drill && (
        <ViewDataPanel worksheetId={id} shelf={shelf} pairs={drill} onClose={() => setDrill(null)} />
      )}
      {refLineOpen && (
        <ReferenceLineDialog
          lines={shelf.referenceLines ?? []}
          meas={meas}
          onChange={(lines) => update((s) => ({ ...s, referenceLines: lines.length ? lines : undefined }))}
          onClose={() => setRefLineOpen(false)}
        />
      )}
      {colorRulesOpen && (
        <ColorRulesDialog
          rules={shelf.colorRules ?? []}
          meas={meas}
          onChange={(rules) => update((s) => ({ ...s, colorRules: rules.length ? rules : undefined }))}
          onClose={() => setColorRulesOpen(false)}
        />
      )}
    </div>
  )
}

const ROW_H = 26
const OVERSCAN = 15

/** Virtualized result grid (P10): renders only the visible window of rows. */
function ResultTable({ res }: { res: { built: BuiltQuery; result: QueryResult } }): React.JSX.Element {
  const [scrollTop, setScrollTop] = useState(0)
  const { built, result } = res
  const headers = [...built.dimLabels, ...built.measureLabels]
  const aliases = [...built.dimAliases, ...built.measureAliases]
  const rows = result.rows
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(rows.length, start + 2 * OVERSCAN + 40)
  return (
    <div
      style={{ position: 'absolute', inset: 0, overflow: 'auto' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <table className="grid">
        <thead>
          <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {start > 0 && (
            <tr style={{ height: start * ROW_H }}>
              <td colSpan={aliases.length} style={{ padding: 0, border: 0 }} />
            </tr>
          )}
          {rows.slice(start, end).map((row, ri) => (
            <tr key={start + ri} style={{ height: ROW_H }}>
              {aliases.map((a, ci) => (
                <td key={ci} className={ci >= built.dimAliases.length ? 'num' : ''}>
                  {row[a] === null ? '∅' : String(row[a])}
                </td>
              ))}
            </tr>
          ))}
          {end < rows.length && (
            <tr style={{ height: (rows.length - end) * ROW_H }}>
              <td colSpan={aliases.length} style={{ padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function FieldItem({ field }: { field: FieldInfo }): React.JSX.Element {
  return (
    <div
      className={`field-item ${field.role}`}
      draggable
      title={field.dbType}
      onDragStart={(e) => setDrag(e, { field: field.name, role: field.role, kind: field.kind })}
    >
      <span className="type-icon">
        {field.kind === 'number' ? '#' : field.kind === 'date' ? '📅' : field.kind === 'bool' ? '◐' : 'Abc'}
      </span>
      <span className="name">{field.name}</span>
    </div>
  )
}

const CALC_KIND_ICON: Record<CalcKind, string> = { string: 'Abc', number: '#', date: '📅', bool: '◐' }

/** Folds any kind outside the 4 user-selectable ones (i.e. 'other') into 'string', same as every other kind icon in this file. */
function displayCalcKind(kind: FieldInfo['kind']): CalcKind {
  return kind === 'number' || kind === 'date' || kind === 'bool' ? kind : 'string'
}

function CalcItem({ calc, dsId }: { calc: CalcField; dsId: string }): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dateFmtOpen, setDateFmtOpen] = useState(false)
  const [dateFmt, setDateFmt] = useState('')
  const kind = displayCalcKind(calcFieldKind(calc))

  const applyKind = (k: CalcKind): void => {
    useApp.getState().setCalcFieldKind(dsId, calc.name, k)
    setMenuOpen(false)
    setDateFmtOpen(false)
  }
  const applyDate = (): void => {
    useApp.getState().setCalcFieldKind(dsId, calc.name, 'date', dateFmt.trim() || undefined)
    setMenuOpen(false)
    setDateFmtOpen(false)
  }
  const resetKind = (): void => {
    useApp.getState().setCalcFieldKind(dsId, calc.name, undefined)
    setMenuOpen(false)
    setDateFmtOpen(false)
  }

  return (
    <div
      className={`field-item ${calc.role}`}
      draggable
      title={calc.expr}
      onDragStart={(e) => setDrag(e, { field: calc.name, role: calc.role, kind })}
    >
      <span className="type-icon">=</span>
      <span className="name">{calc.name}</span>
      <span
        className="calc-kind"
        onClick={(e) => {
          e.stopPropagation()
          setMenuOpen((o) => !o)
          setDateFmtOpen(false)
        }}
        title={`Type: ${FIELD_KIND_LABELS[kind]}${calc.dateFormat ? ` (${calc.dateFormat})` : ''} — click to change`}
      >
        {CALC_KIND_ICON[kind]}
      </span>
      {menuOpen && (
        <div className="menu" style={{ top: '110%', right: 0 }} onClick={(e) => e.stopPropagation()}>
          <div className="head">Field type</div>
          <div className={`item ${kind === 'string' ? 'checked' : ''}`} onClick={() => applyKind('string')}>
            {FIELD_KIND_LABELS.string}
          </div>
          <div className={`item ${kind === 'number' ? 'checked' : ''}`} onClick={() => applyKind('number')}>
            {FIELD_KIND_LABELS.number}
          </div>
          <div
            className={`item ${kind === 'date' ? 'checked' : ''}`}
            onClick={() => {
              setDateFmt(calc.dateFormat ?? '')
              setDateFmtOpen((o) => !o)
            }}
          >
            {FIELD_KIND_LABELS.date}
          </div>
          {dateFmtOpen && (
            <div className="item" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
              <input
                style={{ width: 150, fontSize: 11 }}
                placeholder="auto (ISO) or e.g. %d/%m/%Y"
                title="strptime format for text that isn't already an ISO date — e.g. dd/mm/yyyy needs %d/%m/%Y. Leave empty to auto-parse ISO dates (2024-01-15)."
                value={dateFmt}
                onChange={(e) => setDateFmt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyDate()}
              />
              <button style={{ fontSize: 10, padding: '1px 6px' }} onClick={applyDate}>
                Apply
              </button>
            </div>
          )}
          <div className={`item ${kind === 'bool' ? 'checked' : ''}`} onClick={() => applyKind('bool')}>
            {FIELD_KIND_LABELS.bool}
          </div>
          {calc.kind !== undefined && (
            <>
              <div className="sep" />
              <div className="item" onClick={resetKind}>
                Reset to default
              </div>
            </>
          )}
        </div>
      )}
      <span
        className="x"
        style={{ cursor: 'pointer', color: 'var(--text-dim)' }}
        onClick={(e) => {
          e.stopPropagation()
          useApp.getState().removeCalcField(dsId, calc.name)
        }}
        title="Delete calculated field"
      >
        ×
      </span>
    </div>
  )
}

function FieldDropZone({ hint, onDropPayload }: { hint: string; onDropPayload: (p: DragPayload) => void }): React.JSX.Element {
  const [over, setOver] = useState(false)
  return (
    <span
      style={{
        color: 'var(--text-dim)', fontSize: 11, padding: '2px 8px',
        border: `1px dashed ${over ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 4
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const p = getDrag(e)
        if (p) onDropPayload(p)
      }}
    >
      {hint}
    </span>
  )
}

function ShelfRow({
  label, shelfKey, refs, dsFields, onDropRef, onChange, onMovePill, chartType
}: {
  label: string
  shelfKey: PillShelfKey
  refs: FieldRef[]
  dsFields: FieldInfo[]
  onDropRef: (r: FieldRef) => void
  onChange: (refs: FieldRef[]) => void
  onMovePill: (p: PillDragPayload, to: PillShelfKey, toIndex: number) => void
  chartType?: ChartType
}): React.JSX.Element {
  const [over, setOver] = useState(false)
  return (
    <div className="shelf-row">
      <div className="shelf-label">{label}</div>
      <div
        className={`shelf ${over ? 'drag-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const pp = getPillDrag(e)
          if (pp) {
            onMovePill(pp, shelfKey, refs.length) // empty-area drop: move to end
            return
          }
          const p = getDrag(e)
          if (p) onDropRef(refFromPayload(p))
        }}
      >
        {refs.map((r, i) => (
          <Pill key={`${r.field}:${i}`} refVal={r} dsFields={dsFields} chartType={chartType}
            dragSource={{ from: shelfKey, index: i }}
            onPillDrop={(p, side) => onMovePill(p, shelfKey, side === 'before' ? i : i + 1)}
            onRemove={() => onChange(refs.filter((_x, j) => j !== i))}
            onChange={(nr) => onChange(refs.map((x, j) => (j === i ? nr : x)))} />
        ))}
      </div>
    </div>
  )
}

function MarkSlot({
  label, refVal, dsFields, onDropRef, onClear, onChange
}: {
  label: string
  refVal?: FieldRef
  dsFields: FieldInfo[]
  onDropRef: (r: FieldRef) => void
  onClear: () => void
  onChange: (r: FieldRef) => void
}): React.JSX.Element {
  const [over, setOver] = useState(false)
  return (
    <div className="mark-slot">
      <div className="slot-label">{label}</div>
      <div
        className={`slot ${over ? 'drag-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const p = getDrag(e)
          if (p) onDropRef(refFromPayload(p))
        }}
      >
        {refVal && <Pill refVal={refVal} dsFields={dsFields} onRemove={onClear} onChange={onChange} />}
      </div>
    </div>
  )
}

function Pill({
  refVal, dsFields, onRemove, onChange, dragSource, onPillDrop, chartType
}: {
  refVal: FieldRef
  dsFields: FieldInfo[]
  onRemove: () => void
  onChange: (r: FieldRef) => void
  /** when set, the pill can be dragged to reorder / move across shelves */
  dragSource?: PillDragPayload
  onPillDrop?: (p: PillDragPayload, side: 'before' | 'after') => void
  /** enables the Combo (dual-axis) axis/series-type controls when === 'combo' */
  chartType?: ChartType
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [topNOpen, setTopNOpen] = useState(false)
  const [binSize, setBinSize] = useState('')
  const [movingAvgOpen, setMovingAvgOpen] = useState(false)
  const [maWindow, setMaWindow] = useState('')
  const info = dsFields.find((f) => f.name === refVal.field)
  const kind = refVal.field === '*' ? 'number' : (info?.kind ?? 'string')
  // numeric aggregation over a non-numeric column: TRY_CAST makes it run, but
  // unparseable values silently become NULL — surface that on the pill
  const numericAggOnText =
    refVal.role === 'measure' &&
    refVal.field !== '*' &&
    kind !== 'number' &&
    NUMERIC_AGGS.has(refVal.agg ?? 'sum')

  return (
    <span
      className={`pill ${refVal.role}`}
      draggable={!!dragSource}
      onDragStart={
        dragSource &&
        ((e) => {
          setMenuOpen(false)
          setPillDrag(e, dragSource)
        })
      }
      onDrop={
        onPillDrop &&
        ((e) => {
          const p = getPillDrag(e)
          if (!p) return // field drop: let it bubble to the shelf handler
          e.preventDefault()
          e.stopPropagation()
          const rect = e.currentTarget.getBoundingClientRect()
          onPillDrop(p, e.clientX < rect.left + rect.width / 2 ? 'before' : 'after')
        })
      }
      onClick={() => setMenuOpen((o) => !o)}
    >
      {numericAggOnText && (
        <span
          title={`"${refVal.field}" is not a numeric column: values are converted with TRY_CAST and anything unparseable becomes NULL. Prefer Count / Count Distinct / Min / Max, or convert the field first.`}
          style={{ color: '#ffd166', fontWeight: 700 }}
        >
          ⚠
        </span>
      )}
      {fieldLabel(refVal)}
      <span
        className="x"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        ×
      </span>
      {menuOpen && (
        <div className="menu" style={{ top: '110%', left: 0 }} onClick={(e) => e.stopPropagation()}>
          {refVal.role === 'measure' && refVal.field !== '*' && (
            <>
              <div className="head">Aggregation</div>
              {(Object.keys(AGG_LABELS) as Agg[]).map((a) => {
                const mismatched = kind !== 'number' && NUMERIC_AGGS.has(a)
                return (
                  <div
                    key={a}
                    className={`item ${refVal.agg === a ? 'checked' : ''}`}
                    style={mismatched ? { opacity: 0.55 } : undefined}
                    title={
                      mismatched
                        ? 'Numeric aggregation over a non-numeric field: unparseable values become NULL'
                        : undefined
                    }
                    onClick={() => {
                      onChange({ ...refVal, agg: a })
                      setMenuOpen(false)
                    }}
                  >
    {AGG_LABELS[a]}
                    {mismatched ? ' ⚠' : ''}
                  </div>
                )
              })}
              <div className="sep" />
              <div className="head">Table calculation</div>
              <div
                className={`item ${!refVal.tableCalc ? 'checked' : ''}`}
                onClick={() => {
                  const { tableCalc: _tc, ...rest } = refVal
                  onChange(rest)
                  setMenuOpen(false)
                }}
              >
                None
              </div>
              {(['runningTotal', 'percentOfTotal', 'difference'] as TableCalcKind[]).map((k) => (
                <div
                  key={k}
                  className={`item ${refVal.tableCalc?.kind === k ? 'checked' : ''}`}
                  onClick={() => {
                    onChange({ ...refVal, tableCalc: { kind: k } })
                    setMenuOpen(false)
                  }}
                >
                  {TABLE_CALC_LABELS[k]}
                </div>
              ))}
              <div
                className={`item ${refVal.tableCalc?.kind === 'movingAvg' ? 'checked' : ''}`}
                style={{ gap: 6 }}
                onClick={(e) => {
                  e.stopPropagation()
                  setMaWindow(String(refVal.tableCalc?.window ?? 3))
                  setMovingAvgOpen((o) => !o)
                }}
              >
                {TABLE_CALC_LABELS.movingAvg}…
              </div>
              {movingAvgOpen && (
                <div className="item" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
                  <input
                    type="number"
                    style={{ width: 50 }}
                    min={1}
                    value={maWindow}
                    onChange={(e) => setMaWindow(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onChange({ ...refVal, tableCalc: { kind: 'movingAvg', window: Math.max(1, Number(maWindow) || 3) } })
                        setMovingAvgOpen(false)
                        setMenuOpen(false)
                      }
                    }}
                  />
                  <button
                    style={{ fontSize: 10, padding: '1px 6px' }}
                    onClick={() => {
                      onChange({ ...refVal, tableCalc: { kind: 'movingAvg', window: Math.max(1, Number(maWindow) || 3) } })
                      setMovingAvgOpen(false)
                      setMenuOpen(false)
                    }}
                  >
                    Apply
                  </button>
                </div>
              )}
              <div
                className={`item ${refVal.tableCalc?.kind === 'rank' && refVal.tableCalc.direction !== 'asc' ? 'checked' : ''}`}
                onClick={() => {
                  onChange({ ...refVal, tableCalc: { kind: 'rank', direction: 'desc' } })
                  setMenuOpen(false)
                }}
              >
                Rank (highest = 1)
              </div>
              <div
                className={`item ${refVal.tableCalc?.kind === 'rank' && refVal.tableCalc.direction === 'asc' ? 'checked' : ''}`}
                onClick={() => {
                  onChange({ ...refVal, tableCalc: { kind: 'rank', direction: 'asc' } })
                  setMenuOpen(false)
                }}
              >
                Rank (lowest = 1)
              </div>
              <div className="sep" />
{chartType === 'combo' && (
                <>
                  <div className="head" title="Unset: 1st measure defaults to Bar/Axis 1, the rest to Line/Axis 2">
                    Combo series type
                  </div>
                  {(['bar', 'line'] as const).map((st) => (
                    <div
                      key={st}
                      className={`item ${refVal.seriesType === st ? 'checked' : ''}`}
                      onClick={() => {
                        onChange({ ...refVal, seriesType: refVal.seriesType === st ? undefined : st })
                        setMenuOpen(false)
                      }}
                    >
                      {st === 'bar' ? 'Bar' : 'Line'}
                    </div>
                  ))}
                  <div className="head">Combo axis</div>
                  {([1, 2] as const).map((ax) => (
                    <div
                      key={ax}
                      className={`item ${refVal.axis === ax ? 'checked' : ''}`}
                      onClick={() => {
                        onChange({ ...refVal, axis: refVal.axis === ax ? undefined : ax })
                        setMenuOpen(false)
                      }}
                    >
                      Axis {ax}
                    </div>
                  ))}
                  <div className="sep" />
                </>
              )}
            </>
          )}
          {refVal.role === 'dimension' && kind === 'date' && (
            <>
              <div className="head">Date part</div>
              {(Object.keys(DATE_BIN_LABELS) as DateBin[]).map((b) => (
                <div
                  key={b}
                  className={`item ${refVal.dateBin === b ? 'checked' : ''}`}
                  onClick={() => {
                    onChange({ ...refVal, dateBin: refVal.dateBin === b ? undefined : b })
                    setMenuOpen(false)
                  }}
                >
                  {DATE_BIN_LABELS[b]}
                </div>
              ))}
              <div className="sep" />
            </>
          )}
          {refVal.role === 'dimension' && kind === 'number' && (
            <>
              <div className="head">Bin (histogram)</div>
              <div className="item" style={{ gap: 6 }} onClick={(e) => e.stopPropagation()}>
                <input
                  type="number"
                  style={{ width: 70 }}
                  placeholder="size"
                  value={binSize || String(refVal.numBin?.size ?? '')}
                  onChange={(e) => setBinSize(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const n = Number(binSize)
                      onChange({ ...refVal, numBin: n > 0 ? { size: n } : undefined })
                      setMenuOpen(false)
                    }
                  }}
                />
                <button
                  style={{ fontSize: 10, padding: '1px 6px' }}
                  onClick={() => {
                    const n = Number(binSize || refVal.numBin?.size || 0)
                    onChange({ ...refVal, numBin: n > 0 ? { size: n } : undefined })
                    setMenuOpen(false)
                  }}
                >
                  Apply
                </button>
                {refVal.numBin && (
                  <button
                    style={{ fontSize: 10, padding: '1px 6px' }}
                    onClick={() => {
                      onChange({ ...refVal, numBin: undefined })
                      setMenuOpen(false)
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              <div className="sep" />
            </>
          )}
          {refVal.role === 'dimension' && (
            <>
              <div className="head">Top / Bottom N</div>
              <div
                className="item"
                onClick={() => {
                  setMenuOpen(false)
                  setTopNOpen(true)
                }}
              >
                {refVal.topN
                  ? `${refVal.topN.direction === 'bottom' ? 'Bottom' : 'Top'} ${refVal.topN.n}${refVal.topN.mode === 'percent' ? '%' : ''}${refVal.topN.others ? ' + Others' : ''} (edit)`
                  : 'Top N…'}
              </div>
              <div className="head">Sort</div>
              {(['asc', 'desc', 'valueAsc', 'valueDesc'] as const).map((s) => (
                <div
                  key={s}
                  className={`item ${refVal.sort === s ? 'checked' : ''}`}
                  onClick={() => {
                    onChange({ ...refVal, sort: refVal.sort === s ? undefined : s })
                    setMenuOpen(false)
                  }}
                >
                  {s === 'asc' ? 'A → Z' : s === 'desc' ? 'Z → A' : s === 'valueAsc' ? 'Value ↑' : 'Value ↓'}
                </div>
              ))}
              <div className="sep" />
            </>
          )}
          <div
            className="item"
            onClick={() => {
              onRemove()
              setMenuOpen(false)
            }}
          >
            Remove
          </div>
        </div>
      )}
      {topNOpen && (
        <TopNDialog
          refVal={refVal}
          dsFields={dsFields}
          onApply={(topN) => {
            if (topN) onChange({ ...refVal, topN })
            else {
              const { topN: _t, ...rest } = refVal
              onChange(rest)
            }
            setTopNOpen(false)
          }}
          onClose={() => setTopNOpen(false)}
        />
      )}
    </span>
  )
}

function TopNDialog({
  refVal, dsFields, onApply, onClose
}: {
  refVal: FieldRef
  dsFields: FieldInfo[]
  onApply: (t: TopNSpec | undefined) => void
  onClose: () => void
}): React.JSX.Element {
  const t = refVal.topN
  const [direction, setDirection] = useState<'top' | 'bottom'>(t?.direction ?? 'top')
  const [mode, setMode] = useState<'count' | 'percent'>(t?.mode ?? 'count')
  const [n, setN] = useState(String(t?.n ?? 10))
  const [byField, setByField] = useState(t?.byField ?? '*')
  const [byAgg, setByAgg] = useState<Agg>(t?.byAgg ?? 'count')
  const [others, setOthers] = useState(t?.others ?? false)

  const numericFields = dsFields.filter((f) => f.kind === 'number')
  const nVal = Number(n)

  return (
    <div
      className="overlay"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="dialog" style={{ width: 420 }}>
        <header>Top N — {refVal.field}</header>
        <div className="body">
          <div className="form-row">
            <label>Keep</label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as 'top' | 'bottom')}>
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
            </select>
            <input
              type="number"
              min={1}
              style={{ width: 80 }}
              value={n}
              onChange={(e) => setN(e.target.value)}
            />
            <select value={mode} onChange={(e) => setMode(e.target.value as 'count' | 'percent')}>
              <option value="count">values</option>
              <option value="percent">% of values</option>
            </select>
          </div>
          <div className="form-row">
            <label>Ranked by</label>
            <select
              value={byAgg}
              onChange={(e) => {
                const agg = e.target.value as Agg
                setByAgg(agg)
                if (agg === 'count' || agg === 'count_distinct') return
                if (byField === '*') setByField(numericFields[0]?.name ?? '*')
              }}
            >
              {(Object.keys(AGG_LABELS) as Agg[]).map((a) => (
                <option key={a} value={a}>{AGG_LABELS[a]}</option>
              ))}
            </select>
            <select value={byField} onChange={(e) => setByField(e.target.value)}>
              <option value="*">Number of Records</option>
              {dsFields.map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
          </div>
          <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} />
            Group remaining values as "Others" (unchecked = filter them out)
          </label>
        </div>
        <footer>
          {t && (
            <button style={{ marginRight: 'auto' }} onClick={() => onApply(undefined)}>
              Clear Top N
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!Number.isFinite(nVal) || nVal <= 0}
            onClick={() => onApply({ n: nVal, byField, byAgg, others, direction, mode })}
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  )
}

function ReferenceLineDialog({
  lines, meas, onChange, onClose
}: {
  lines: ReferenceLine[]
  meas: FieldRef[]
  onChange: (lines: ReferenceLine[]) => void
  onClose: () => void
}): React.JSX.Element {
  const [measureIdx, setMeasureIdx] = useState(0)
  const [kind, setKind] = useState<ReferenceLine['kind']>('average')
  const [value, setValue] = useState('0')
  const [label, setLabel] = useState('')
  const [color, setColor] = useState('#e15759')

  const kindLabel = (rl: ReferenceLine): string =>
    rl.label || (rl.kind === 'constant' ? `Constant (${rl.value ?? 0})` : rl.kind[0].toUpperCase() + rl.kind.slice(1))

  return (
    <div
      className="overlay"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="dialog" style={{ width: 460 }}>
        <header>Reference Lines</header>
        <div className="body">
          {lines.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>
              No reference lines yet — add an average, median, min/max or constant line below.
            </div>
          )}
          {lines.map((rl, i) => (
            <div key={i} className="form-row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ display: 'inline-block', width: 10, height: 10, background: rl.color ?? '#e15759', borderRadius: 2 }} />
                {kindLabel(rl)} — {fieldLabel(meas[rl.measureIdx ?? 0] ?? meas[0])}
              </span>
              <button
                style={{ fontSize: 10, padding: '1px 6px' }}
                onClick={() => onChange(lines.filter((_x, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          {lines.length > 0 && <div className="sep" />}
          <div className="form-row">
            <label>Measure</label>
            <select value={measureIdx} onChange={(e) => setMeasureIdx(Number(e.target.value))}>
              {meas.map((m, i) => (
                <option key={i} value={i}>{fieldLabel(m)}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>Type</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as ReferenceLine['kind'])}>
              <option value="average">Average</option>
              <option value="median">Median</option>
              <option value="min">Min</option>
              <option value="max">Max</option>
              <option value="constant">Constant value</option>
            </select>
            {kind === 'constant' && (
              <input
                type="number"
                style={{ width: 90 }}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            )}
          </div>
          <div className="form-row">
            <label>Label</label>
            <input placeholder="optional" value={label} onChange={(e) => setLabel(e.target.value)} />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              style={{ width: 36, padding: 0 }}
              title="Line color"
            />
          </div>
        </div>
        <footer>
          <button onClick={onClose}>Close</button>
          <button
            className="primary"
            disabled={!meas.length}
            onClick={() => {
              onChange([
                ...lines,
                {
                  measureIdx,
                  kind,
                  value: kind === 'constant' ? Number(value) || 0 : undefined,
                  label: label.trim() || undefined,
                  color
                }
              ])
              setLabel('')
            }}
          >
            + Add Line
          </button>
        </footer>
      </div>
    </div>
  )
}

function ColorRulesDialog({
  rules, meas, onChange, onClose
}: {
  rules: ColorRule[]
  meas: FieldRef[]
  onChange: (rules: ColorRule[]) => void
  onClose: () => void
}): React.JSX.Element {
  const [measureIdx, setMeasureIdx] = useState(0)
  const [op, setOp] = useState<ColorRule['op']>('>')
  const [value, setValue] = useState('0')
  const [color, setColor] = useState('#e15759')

  return (
    <div
      className="overlay"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="dialog" style={{ width: 460 }}>
        <header>Color Rules</header>
        <div className="body">
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
            First matching rule wins. Applies to bar/pie-family marks and per-point line/scatter markers.
          </div>
          {rules.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>No rules yet.</div>
          )}
          {rules.map((r, i) => (
            <div key={i} className="form-row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ display: 'inline-block', width: 10, height: 10, background: r.color, borderRadius: 2 }} />
                {fieldLabel(meas[r.measureIdx] ?? meas[0])} {r.op} {r.value}
              </span>
              <button
                style={{ fontSize: 10, padding: '1px 6px' }}
                onClick={() => onChange(rules.filter((_x, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
          {rules.length > 0 && <div className="sep" />}
          <div className="form-row">
            <label>Measure</label>
            <select value={measureIdx} onChange={(e) => setMeasureIdx(Number(e.target.value))}>
              {meas.map((m, i) => (
                <option key={i} value={i}>{fieldLabel(m)}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>When</label>
            <select value={op} onChange={(e) => setOp(e.target.value as ColorRule['op'])}>
              <option value=">">&gt;</option>
              <option value=">=">&ge;</option>
              <option value="<">&lt;</option>
              <option value="<=">&le;</option>
              <option value="=">=</option>
              <option value="!=">&ne;</option>
            </select>
            <input type="number" style={{ width: 90 }} value={value} onChange={(e) => setValue(e.target.value)} />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              style={{ width: 36, padding: 0 }}
              title="Rule color"
            />
          </div>
        </div>
        <footer>
          <button onClick={onClose}>Close</button>
          <button
            className="primary"
            disabled={!meas.length}
            onClick={() => onChange([...rules, { measureIdx, op, value: Number(value) || 0, color }])}
          >
            + Add Rule
          </button>
        </footer>
      </div>
    </div>
  )
}

function CalcFieldDialog({ dsId, onClose }: { dsId: string; onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [expr, setExpr] = useState('')
  const [role, setRole] = useState<'dimension' | 'measure'>('measure')
  const [error, setError] = useState('')
  const fieldsRaw = useApp((s) => s.fields[dsId])
  const fields = fieldsRaw ?? []

  const save = async (): Promise<void> => {
    const guard = validateExpression(expr)
    if (guard) {
      setError(guard)
      return
    }
    try {
      await api.runQuery(`SELECT (${expr}) AS t FROM "ds_${dsId}" LIMIT 0`)
      useApp.getState().addCalcField(dsId, { name: name.trim(), expr, role })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 560 }}>
        <header>New Calculated Field</header>
        <div className="body">
          <div className="form-row">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Profit Ratio" />
            <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="measure">Measure</option>
              <option value="dimension">Dimension</option>
            </select>
          </div>
          <div>
            <div className="drop-hint" style={{ marginBottom: 4 }}>
              DuckDB SQL expression. Click a field to insert it:
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {fields.map((f) => (
                <span key={f.name} className="badge" style={{ cursor: 'pointer' }}
                  onClick={() => setExpr((x) => x + `"${f.name}"`)}>
                  {f.name}
                </span>
              ))}
            </div>
            <textarea
              rows={4}
              style={{ width: '100%', fontFamily: 'Consolas, monospace' }}
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              placeholder={'"profit" / nullif("sales", 0)'}
            />
          </div>
          {error && <div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{error}</div>}
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim() || !expr.trim()} onClick={() => void save()}>
            Create
          </button>
        </footer>
      </div>
    </div>
  )
}

function ExportMenu({
  worksheetId, chartRef
}: {
  worksheetId: string
  chartRef: React.RefObject<ECharts | null>
}): React.JSX.Element {
  const [busyMsg, setBusyMsg] = useState('')
  const sheet = useApp((s) => s.workbook.worksheets.find((w) => w.id === worksheetId))
  const res = useApp((s) => s.results[worksheetId])

  const run = async (label: string, fn: () => Promise<string | null>): Promise<void> => {
    setBusyMsg(`Exporting ${label}…`)
    try {
      const path = await fn()
      useApp.getState().setStatus(path ? `Exported → ${path}` : 'Export cancelled')
    } catch (e) {
      useApp.getState().setStatus(`Export failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setBusyMsg('')
    }
  }

  const name = sheet?.name.replace(/[^\w-]+/g, '_') ?? 'chart'
  const sql = res?.built.sql ?? ''
  const canChart = !!chartRef.current && sheet?.shelf.chartType !== 'table'

  return (
    <div style={{ marginTop: 14 }}>
      <h4>Export</h4>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <button disabled={!canChart} onClick={() => void run('PNG', () =>
          api.exportImage(chartRef.current!.getDataURL({ pixelRatio: 2, backgroundColor: '#1e1f24' }), 'png', name))}>
          PNG
        </button>
        <button disabled={!canChart || !res} onClick={() => void run('PDF', async () => {
          if (!sheet || !res) return null
          const option = buildChartOption(sheet.shelf, res.built, res.result)
          if (!option) return null
          const png = await renderChartPng(toLightOption(option), 1280, 720)
          return api.exportPdf(sheet.name, [{ png }], name)
        })}>
          PDF
        </button>
        <button disabled={!sql} onClick={() => void run('CSV', () => api.exportData(sql, 'csv', name))}>CSV</button>
        <button disabled={!sql} onClick={() => void run('Excel', () => api.exportData(sql, 'xlsx', name))}>XLSX</button>
        <button disabled={!sql} onClick={() => void run('JSON', () => api.exportData(sql, 'json', name))}>JSON</button>
        <button disabled={!sql} onClick={() => void run('Parquet', () => api.exportData(sql, 'parquet', name))}>Parquet</button>
      </div>
      {busyMsg && <div className="drop-hint" style={{ marginTop: 4 }}>{busyMsg}</div>}
    </div>
  )
}

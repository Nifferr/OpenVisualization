import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { dashResultKey, nextId, useApp } from '../store'
import { EChart, renderChartPng, worldGeoJson } from '../charts/EChart'
import { buildChartOption, PALETTE } from '../charts/optionBuilder'
import { toLightOption } from '../charts/exportTheme'
import { buildChartDetailPayload } from '../charts/exportDetail'
import { calcFieldKind, resolvedCalcSql } from '@shared/sqlBuilder'
import { parseMiniMarkdown } from '@shared/miniMarkdown'
import type {
  DashboardTile,
  DashFilterCard,
  ExportTile,
  FieldInfo,
  PdfSection
} from '@shared/types'
import { AddFilterCardDialog, FilterCardBody } from './FilterCards'

const CELL = 40 // grid row height in px (x-axis cell width is fluid)
const COLS = 24

/** Accent swatches offered in the tile settings menu. */
const ACCENTS = PALETTE.slice(0, 8)

export function DashboardPage({ id }: { id: string }): React.JSX.Element {
  // slice subscriptions: tiles re-render individually; results are read at
  // export time via getState() so query churn doesn't re-render the canvas
  const dash = useApp((s) => s.workbook.dashboards.find((d) => d.id === id))
  const worksheets = useApp((s) => s.workbook.worksheets)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [textTileOpen, setTextTileOpen] = useState(false)
  const [filterCardOpen, setFilterCardOpen] = useState(false)
  // fluid grid: 24 columns always span the full canvas width, so the whole
  // area is usable on any monitor and tiles grow with the window
  const [cellW, setCellW] = useState(CELL)
  const [canvasH, setCanvasH] = useState(600)

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const measure = (): void => {
      setCellW(Math.max(24, el.clientWidth / COLS))
      setCanvasH(el.clientHeight)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // re-apply persisted filter-card selections when the dashboard opens
  useEffect(() => {
    useApp.getState().runDashboard(id)
  }, [id])

  if (!dash) return <div style={{ padding: 20 }}>Dashboard not found.</div>

  const update = (fn: (tiles: DashboardTile[]) => DashboardTile[]): void =>
    useApp.getState().updateDashboard(id, (d) => ({ ...d, tiles: fn(d.tiles) }))

  const nextY = (): number => Math.max(0, ...dash.tiles.map((t) => t.y + t.h))

  const addTile = (worksheetId: string): void => {
    update((tiles) => [...tiles, { id: nextId('tile'), worksheetId, x: 0, y: nextY(), w: 12, h: 8 }])
    if (worksheets.some((ws) => ws.id === worksheetId)) {
      void useApp.getState().runWorksheet(worksheetId)
      useApp.getState().runDashboard(id)
    }
  }

  const addTextTile = (text: string): void => {
    update((tiles) => [...tiles, { id: nextId('tile'), text, x: 0, y: nextY(), w: 12, h: 2 }])
  }

  const addFilterCard = (cfg: DashFilterCard): void => {
    const h = cfg.mode === 'in' ? 7 : 4
    update((tiles) => [...tiles, { id: nextId('tile'), filter: cfg, x: 0, y: nextY(), w: 5, h }])
    setFilterCardOpen(false)
  }

  /**
   * Snapshot every tile (charts light-themed, tables, text, filter cards)
   * preserving the grid layout. Charts/tables additionally carry a detail
   * payload when filter cards exist on their data source, so the exported
   * HTML can re-filter them client-side.
   */
  const collectExportTiles = async (
    maxTableRows: number
  ): Promise<{ tiles: ExportTile[]; hasMap: boolean }> => {
    const st = useApp.getState()
    const out: ExportTile[] = []
    let hasMap = false
    const cardTiles = dash.tiles.filter((t) => t.filter)
    const cardsFor = (dsId: string): Array<{ cardId: string; card: DashFilterCard }> =>
      cardTiles.filter((t) => t.filter!.dsId === dsId).map((t) => ({ cardId: t.id, card: t.filter! }))
    const fieldKindsFor = (dsId: string): Record<string, FieldInfo['kind']> => {
      const kinds: Record<string, FieldInfo['kind']> = {}
      for (const f of st.fields[dsId] ?? []) kinds[f.name] = f.kind
      for (const c of st.workbook.calculatedFields[dsId] ?? []) kinds[c.name] = calcFieldKind(c)
      return kinds
    }

    for (const tile of [...dash.tiles].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const box = { x: tile.x, y: tile.y, w: tile.w, h: tile.h }
      const style = { hideHead: tile.hideHead, accent: tile.accent }
      if (tile.filter) {
        const cfg = tile.filter
        const base = {
          kind: 'filter' as const,
          cardId: tile.id,
          label: tile.title ?? cfg.label ?? cfg.field,
          mode: cfg.mode,
          accent: tile.accent,
          ...box
        }
        // calc fields aren't columns of ds_<id>; queries need their SQL
        const cardExpr = resolvedCalcSql(st.workbook.calculatedFields[cfg.dsId] ?? [], cfg.field)
        if (cfg.mode === 'in') {
          let values: Array<{ v: string; n: number }> = []
          try {
            values = (
              await api.distinctValues(cfg.dsId, cfg.field, {
                expr: cardExpr,
                limit: 200,
                orderBy: 'count'
              })
            ).values
          } catch (e) {
            console.error('[export] filter card values failed:', e)
          }
          out.push({ ...base, values, selected: cfg.values })
        } else if (cfg.mode === 'range') {
          let lo: number | undefined
          let hi: number | undefined
          try {
            const r = await api.fieldRange(cfg.dsId, cfg.field, cardExpr)
            lo = Number(r.min)
            hi = Number(r.max)
          } catch {
            // extent is only a placeholder — export proceeds without it
          }
          out.push({
            ...base,
            min: cfg.min,
            max: cfg.max,
            rangeLo: Number.isFinite(lo) ? lo : undefined,
            rangeHi: Number.isFinite(hi) ? hi : undefined
          })
        } else {
          out.push({ ...base, from: cfg.from, to: cfg.to })
        }
        continue
      }
      if (tile.text) {
        out.push({ kind: 'text', text: tile.text, accent: tile.accent, ...box })
        continue
      }
      if (!tile.worksheetId) continue
      const ws = worksheets.find((w) => w.id === tile.worksheetId)
      const res = st.results[dashResultKey(id, tile.worksheetId)] ?? st.results[tile.worksheetId]
      if (!ws || !res) continue

      // detail payload (client-side re-filtering) when cards target this source
      let detail: string | undefined
      const cards = cardsFor(ws.shelf.dataSourceId)
      if (cards.length) {
        try {
          const payload = await buildChartDetailPayload(`ds_${ws.shelf.dataSourceId}`, {
            shelf: ws.shelf,
            built: res.built,
            columns: res.result.columns,
            calcFields: st.workbook.calculatedFields[ws.shelf.dataSourceId] ?? [],
            sourceFilters: st.workbook.sourceFilters[ws.shelf.dataSourceId] ?? [],
            fieldKinds: fieldKindsFor(ws.shelf.dataSourceId),
            cards
          })
          if (payload) detail = JSON.stringify(payload)
        } catch (e) {
          console.error(`[export] detail payload failed for "${ws.name}" (chart stays static):`, e)
        }
      }

      if (ws.shelf.chartType === 'table') {
        const aliases = [...res.built.dimAliases, ...res.built.measureAliases]
        out.push({
          kind: 'table',
          title: tile.title ?? ws.name,
          columns: [...res.built.dimLabels, ...res.built.measureLabels],
          rows: res.result.rows
            .slice(0, maxTableRows)
            .map((row) => aliases.map((a) => (row[a] === null ? '∅' : String(row[a])))),
          detail,
          maxRows: maxTableRows,
          ...style,
          ...box
        })
        continue
      }
      // one bad tile (bad shelf state, oversized data) must not sink the whole export
      let option
      try {
        option = buildChartOption(ws.shelf, res.built, res.result)
      } catch (e) {
        console.error(`[export] chart option build failed for "${ws.name}":`, e)
        continue
      }
      if (!option) continue
      if (ws.shelf.chartType === 'map') hasMap = true
      out.push({
        kind: 'chart',
        title: tile.title ?? ws.name,
        option: JSON.stringify(toLightOption(option)),
        detail,
        ...style,
        ...box
      })
    }
    return { tiles: out, hasMap }
  }

  const exportHtml = async (): Promise<void> => {
    useApp.getState().setStatus('Exporting HTML…')
    const { tiles, hasMap } = await collectExportTiles(500)
    if (!tiles.length) {
      useApp.getState().setStatus('Nothing to export — add tiles to the dashboard first')
      return
    }
    const path = await api.exportHtml(
      dash.name,
      tiles,
      dash.name.replace(/[^\w-]+/g, '_'),
      hasMap ? worldGeoJson : undefined
    )
    useApp.getState().setStatus(path ? `Exported → ${path}` : 'Export cancelled')
  }

  const exportPdf = async (): Promise<void> => {
    useApp.getState().setStatus('Exporting PDF…')
    const { tiles } = await collectExportTiles(200)
    if (!tiles.length) {
      useApp.getState().setStatus('Nothing to export — add tiles to the dashboard first')
      return
    }
    try {
      const sections: PdfSection[] = []
      for (const t of tiles) {
        if (t.kind === 'chart') {
          const png = await renderChartPng(
            JSON.parse(t.option),
            Math.max(640, t.w * CELL * 1.5),
            Math.max(360, t.h * CELL * 1.5)
          )
          sections.push({ title: t.title, png })
        } else if (t.kind === 'text') {
          sections.push({ text: t.text })
        } else if (t.kind === 'filter') {
          const sel =
            t.mode === 'in'
              ? t.selected?.length
                ? t.selected.map((v) => (v === '' ? '(blank)' : v)).join(', ')
                : 'all values'
              : t.mode === 'range'
                ? `${t.min ?? '…'} – ${t.max ?? '…'}`
                : `${t.from ?? '…'} → ${t.to ?? '…'}`
          sections.push({ text: `Filter — ${t.label}: ${sel}` })
        } else {
          sections.push({ title: t.title, table: { columns: t.columns, rows: t.rows } })
        }
      }
      const path = await api.exportPdf(dash.name, sections, dash.name.replace(/[^\w-]+/g, '_'))
      useApp.getState().setStatus(path ? `Exported → ${path}` : 'Export cancelled')
    } catch (e) {
      useApp.getState().setStatus(`Export failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  return (
    <div className="dash">
      <div className="dash-side">
        <div className="section-title">Worksheets</div>
        {worksheets.map((ws) => (
          <div key={ws.id} className="dash-item" onClick={() => addTile(ws.id)} title="Click to add">
            📊 {ws.name}
          </div>
        ))}
        {worksheets.length === 0 && (
          <div className="drop-hint">Create worksheets first, then add them here as tiles.</div>
        )}
        <div className="section-title" style={{ marginTop: 8 }}>Tiles</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button onClick={() => setTextTileOpen(true)}>+ Text tile</button>
          <button onClick={() => setFilterCardOpen(true)} title="Interactive filter applied to every tile on a data source — kept interactive in the HTML export">
            + Filter card
          </button>
        </div>
        <div className="section-title" style={{ marginTop: 8 }}>Export</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button className="primary" onClick={() => void exportHtml()}>
            Interactive HTML
          </button>
          <button onClick={() => void exportPdf()}>PDF</button>
        </div>
      </div>
      <div
        className="dash-canvas"
        ref={canvasRef}
        style={{ backgroundSize: `${cellW}px ${CELL}px` }}
      >
        {dash.tiles.length === 0 && (
          <div className="dash-empty">
            <div className="big">▦</div>
            <div>This dashboard is empty.</div>
            <div className="drop-hint">Click a worksheet on the left to add it as a tile, then drag and resize freely.</div>
          </div>
        )}
        <div
          className="dash-grid"
          style={{
            height: Math.max(canvasH - 2, ...dash.tiles.map((t) => (t.y + t.h) * CELL + 40))
          }}
        >
          {dash.tiles.map((tile) => (
            <Tile key={tile.id} tile={tile} dashId={id} cellW={cellW}
              onChange={(t) => update((tiles) => tiles.map((x) => (x.id === t.id ? t : x)))}
              onRemove={() => {
                const hadFilter = !!tile.filter
                update((tiles) => tiles.filter((x) => x.id !== tile.id))
                if (hadFilter) useApp.getState().runDashboard(id)
              }} />
          ))}
        </div>
      </div>
      {textTileOpen && (
        <TextTileDialog
          onSave={(text) => {
            addTextTile(text)
            setTextTileOpen(false)
          }}
          onClose={() => setTextTileOpen(false)}
        />
      )}
      {filterCardOpen && (
        <AddFilterCardDialog onAdd={addFilterCard} onClose={() => setFilterCardOpen(false)} />
      )}
    </div>
  )
}

function TextTileDialog({
  initial,
  onSave,
  onClose
}: {
  initial?: string
  onSave: (text: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [text, setText] = useState(initial ?? '')
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 460 }}>
        <header>{initial === undefined ? 'New Text Tile' : 'Edit Text Tile'}</header>
        <div className="body">
          <textarea
            rows={6}
            autoFocus
            style={{ width: '100%' }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'# Heading\nNotes with **bold** text\n- bullet item'}
          />
          <div className="drop-hint"># heading · ## subheading · - bullet · **bold**</div>
        </div>
        <footer>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!text.trim()} onClick={() => onSave(text)}>
            {initial === undefined ? 'Add' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  )
}

/** Text tile body: the mini-markdown subset (headings, bullets, bold). */
function MdText({ text }: { text: string }): React.JSX.Element {
  const blocks = parseMiniMarkdown(text)
  return (
    <div className="tile-text">
      {blocks.map((b, i) => {
        const spans = b.spans.map((s, j) =>
          s.bold ? <strong key={j}>{s.text}</strong> : <span key={j}>{s.text}</span>
        )
        if (b.kind === 'h1') return <div key={i} className="md-h1">{spans}</div>
        if (b.kind === 'h2') return <div key={i} className="md-h2">{spans}</div>
        if (b.kind === 'li') return <div key={i} className="md-li">{spans}</div>
        return (
          <div key={i} className="md-p">
            {spans.length ? spans : ' '}
          </div>
        )
      })}
    </div>
  )
}

function Tile({
  tile, dashId, cellW, onChange, onRemove
}: {
  tile: DashboardTile
  dashId: string
  cellW: number
  onChange: (t: DashboardTile) => void
  onRemove: () => void
}): React.JSX.Element {
  // per-tile slices: only this tile re-renders when its worksheet updates.
  // dashboard-filtered results (filter cards) take precedence over the
  // worksheet's own result.
  const overrideKey = tile.worksheetId ? dashResultKey(dashId, tile.worksheetId) : ''
  const ws = useApp((s) =>
    tile.worksheetId ? s.workbook.worksheets.find((w) => w.id === tile.worksheetId) : undefined
  )
  const res = useApp((s) =>
    tile.worksheetId ? s.results[overrideKey] ?? s.results[tile.worksheetId] : undefined
  )
  const err = useApp((s) =>
    tile.worksheetId ? s.errors[overrideKey] ?? s.errors[tile.worksheetId] : undefined
  )
  const isLoading = useApp(
    (s) => !!(tile.worksheetId && (s.loading[overrideKey] || s.loading[tile.worksheetId]))
  )
  const [drag, setDrag] = useState<{ mode: 'move' | 'resize'; startX: number; startY: number; orig: DashboardTile } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editText, setEditText] = useState(false)

  const option = useMemo(() => {
    if (!ws || !res || ws.shelf.chartType === 'table') return null
    try {
      return buildChartOption(ws.shelf, res.built, res.result)
    } catch {
      return null
    }
  }, [ws, res])

  const startDrag = (e: React.MouseEvent, mode: 'move' | 'resize'): void => {
    e.preventDefault()
    setDrag({ mode, startX: e.clientX, startY: e.clientY, orig: tile })
    const onMove = (ev: MouseEvent): void => {
      const dx = Math.round((ev.clientX - e.clientX) / cellW)
      const dy = Math.round((ev.clientY - e.clientY) / CELL)
      if (mode === 'move') {
        onChange({
          ...tile,
          x: Math.max(0, Math.min(COLS - tile.w, tile.x + dx)),
          y: Math.max(0, tile.y + dy)
        })
      } else {
        onChange({
          ...tile,
          w: Math.max(2, Math.min(COLS - tile.x, tile.w + dx)),
          h: Math.max(2, tile.h + dy)
        })
      }
    }
    const onUp = (): void => {
      setDrag(null)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const name =
    tile.title ??
    ws?.name ??
    (tile.filter ? tile.filter.label ?? tile.filter.field : tile.text ? 'Text' : 'Tile')

  const tools = (
    <span className="tile-tools" onMouseDown={(e) => e.stopPropagation()}>
      <span className="tbtn" title="Tile settings" onClick={() => setMenuOpen((o) => !o)}>⚙</span>
      <span className="tbtn x" title="Remove tile" onClick={onRemove}>×</span>
    </span>
  )

  return (
    <div
      className={`dash-tile${tile.hideHead ? ' headless' : ''}`}
      style={{
        left: tile.x * cellW,
        top: tile.y * CELL,
        width: tile.w * cellW,
        height: tile.h * CELL,
        opacity: drag ? 0.85 : 1,
        zIndex: drag || menuOpen ? 10 : 1,
        borderTop: tile.accent ? `3px solid ${tile.accent}` : undefined
      }}
    >
      {tile.hideHead ? (
        <div className="tile-hoverbar" onMouseDown={(e) => startDrag(e, 'move')} title={name}>
          {tools}
        </div>
      ) : (
        <div className="tile-head" onMouseDown={(e) => startDrag(e, 'move')}>
          <span className="tile-title">{name}</span>
          {tools}
        </div>
      )}
      {menuOpen && (
        <>
          <div className="tile-menu-backdrop" onMouseDown={() => setMenuOpen(false)} />
          <div className="tile-menu">
            <input
              placeholder="Title override…"
              defaultValue={tile.title ?? ''}
              onKeyDown={(e) => {
                if (e.key === 'Enter')
                  onChange({ ...tile, title: e.currentTarget.value.trim() || undefined })
              }}
              onBlur={(e) => onChange({ ...tile, title: e.target.value.trim() || undefined })}
            />
            <label>
              <input
                type="checkbox"
                checked={!tile.hideHead}
                onChange={(e) => onChange({ ...tile, hideHead: e.target.checked ? undefined : true })}
              />
              Show header
            </label>
            <div className="tm-swatches">
              <span
                className="swatch none"
                title="No accent"
                onClick={() => onChange({ ...tile, accent: undefined })}
              >
                ∅
              </span>
              {ACCENTS.map((c) => (
                <span
                  key={c}
                  className={`swatch${tile.accent === c ? ' sel' : ''}`}
                  style={{ background: c }}
                  onClick={() => onChange({ ...tile, accent: c })}
                />
              ))}
            </div>
            {tile.text !== undefined && (
              <button
                onClick={() => {
                  setMenuOpen(false)
                  setEditText(true)
                }}
              >
                Edit text…
              </button>
            )}
          </div>
        </>
      )}
      <div className="tile-body">
        {tile.filter && <FilterCardBody dashId={dashId} tile={tile} />}
        {tile.text !== undefined && !tile.filter && (
          <div style={{ height: '100%', overflow: 'auto' }} onDoubleClick={() => setEditText(true)}>
            <MdText text={tile.text} />
          </div>
        )}
        {ws && !res && !err && (
          <div className="drop-hint" style={{ padding: 10 }}>
            <span className="spinner" /> Loading data…
          </div>
        )}
        {ws && err && <div style={{ color: 'var(--red)', padding: 10, fontSize: 11 }}>{err}</div>}
        {option && <EChart option={option} resetKey={ws?.shelf.chartType} />}
        {ws && res && isLoading && (
          <div className="loading-overlay">
            <span className="spinner" /> Updating…
          </div>
        )}
        {ws && res && ws.shelf.chartType === 'table' && (
          <div style={{ overflow: 'auto', height: '100%' }}>
            <table className="grid">
              <thead>
                <tr>{[...res.built.dimLabels, ...res.built.measureLabels].map((h, i) => <th key={i}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {res.result.rows.slice(0, 100).map((row, ri) => (
                  <tr key={ri}>
                    {[...res.built.dimAliases, ...res.built.measureAliases].map((a, ci) => (
                      <td key={ci}>{row[a] === null ? '∅' : String(row[a])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="resize-handle" onMouseDown={(e) => startDrag(e, 'resize')} />
      {editText && tile.text !== undefined && (
        <TextTileDialog
          initial={tile.text}
          onSave={(text) => {
            onChange({ ...tile, text })
            setEditText(false)
          }}
          onClose={() => setEditText(false)}
        />
      )}
    </div>
  )
}

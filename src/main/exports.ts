// Export subsystem: data via DuckDB COPY / exceljs, images from renderer data,
// PDF via a hidden window, standalone HTML with inlined ECharts.
import { BrowserWindow, dialog } from 'electron'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ensureExtension, exec, runQuery, sqlPath } from './duck'
import { viewName } from './datasources'
import { emitProgress } from './progress'
import { parseMiniMarkdown } from '../shared/miniMarkdown'
import { quoteIdent } from '../shared/sqlBuilder'
import { rowToEml, sanitizeName } from '../shared/emailParse'
import type { EmlExportResult, ExportTile, PdfSection } from '../shared/types'

const require = createRequire(import.meta.url)

async function askSavePath(
  defaultName: string,
  filters: Electron.FileFilter[]
): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const res = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters })
  return res.canceled || !res.filePath ? null : res.filePath
}

export type DataExportFormat = 'csv' | 'json' | 'parquet' | 'xlsx'

export async function exportData(
  sql: string,
  format: DataExportFormat,
  defaultName: string
): Promise<string | null> {
  const filters: Record<DataExportFormat, Electron.FileFilter> = {
    csv: { name: 'CSV', extensions: ['csv'] },
    json: { name: 'JSON', extensions: ['json'] },
    parquet: { name: 'Parquet', extensions: ['parquet'] },
    xlsx: { name: 'Excel Workbook', extensions: ['xlsx'] }
  }
  const path = await askSavePath(`${defaultName}.${format}`, [filters[format]])
  if (!path) return null

  const inner = sql.replace(/;\s*$/, '')
  if (format === 'csv') {
    await exec(`COPY (${inner}) TO ${sqlPath(path)} (FORMAT csv, HEADER)`)
  } else if (format === 'json') {
    await exec(`COPY (${inner}) TO ${sqlPath(path)} (FORMAT json, ARRAY true)`)
  } else if (format === 'parquet') {
    await exec(`COPY (${inner}) TO ${sqlPath(path)} (FORMAT parquet)`)
  } else {
    // XLSX: native DuckDB COPY (excel extension) streams straight to disk.
    // The old exceljs path buffered the entire result in JS and could OOM
    // the main process on large exports; it remains only as a capped fallback
    // for the rare type the xlsx writer refuses.
    try {
      await ensureExtension('excel')
      await exec(`COPY (${inner}) TO ${sqlPath(path)} (FORMAT xlsx, HEADER true)`)
    } catch {
      const res = await runQuery(inner, 250_000)
      const ExcelJS = await import('exceljs')
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('Data')
      ws.columns = res.columns.map((c) => ({ header: c.name, key: c.name, width: 18 }))
      for (const row of res.rows) ws.addRow(row)
      ws.getRow(1).font = { bold: true }
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: res.columns.length } }
      ws.views = [{ state: 'frozen', ySplit: 1 }]
      await wb.xlsx.writeFile(path)
    }
  }
  return path
}

// ---------- EML export (emails source) ----------

/**
 * Write each message of an emails source as a .eml file into a chosen folder.
 * `whereSql` is a ready WHERE clause (without the keyword) reflecting the
 * dataset's active filters, so the export honors what the user is viewing.
 */
export async function exportEml(dsId: string, whereSql: string): Promise<EmlExportResult | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a folder to save .eml files',
    properties: ['openDirectory', 'createDirectory']
  })
  if (res.canceled || !res.filePaths.length) return null
  const folder = res.filePaths[0]
  await mkdir(folder, { recursive: true })

  const where = whereSql ? ` WHERE ${whereSql}` : ''
  const view = quoteIdent(viewName(dsId))
  const data = await runQuery(
    `SELECT subject, from_name, from_email, to_recipients, cc_recipients, ` +
      `date_sent, message_id, in_reply_to, body, body_html, headers FROM ${view}${where}`,
    250_000
  )
  const key = `eml:${dsId}`
  const label = 'Exporting e-mails as .eml'
  emitProgress({ key, label, pct: 0 })
  const used = new Set<string>()
  let written = 0
  let failed = 0
  try {
    for (let i = 0; i < data.rows.length; i++) {
      const r = data.rows[i]
      try {
        const base = sanitizeName(String(r.subject ?? ''), `message-${i + 1}`)
        let fname = `${base}.eml`
        let n = 1
        while (used.has(fname.toLowerCase())) fname = `${base} (${++n}).eml`
        used.add(fname.toLowerCase())
        await writeFile(join(folder, fname), rowToEml(r), 'utf-8')
        written++
      } catch {
        failed++
      }
      if (i % 50 === 0) {
        emitProgress({
          key,
          label,
          pct: data.rows.length ? (i + 1) / data.rows.length : 1,
          detail: `${written.toLocaleString()} of ${data.rows.length.toLocaleString()}`
        })
        await new Promise((rr) => setImmediate(rr))
      }
    }
    return { folder, written, failed }
  } finally {
    emitProgress({ key, label, pct: 1, done: true })
  }
}

export async function exportImage(
  dataUrlOrSvg: string,
  format: 'png' | 'svg',
  defaultName: string
): Promise<string | null> {
  const path = await askSavePath(`${defaultName}.${format}`, [
    format === 'png' ? { name: 'PNG Image', extensions: ['png'] } : { name: 'SVG Image', extensions: ['svg'] }
  ])
  if (!path) return null
  if (format === 'png') {
    const base64 = dataUrlOrSvg.replace(/^data:image\/png;base64,/, '')
    await writeFile(path, Buffer.from(base64, 'base64'))
  } else {
    await writeFile(path, dataUrlOrSvg, 'utf-8')
  }
  return path
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Neutralize "</script>" (and any other tag) inside JSON destined for a <script> block. */
const safeJson = (json: string): string => json.replace(/</g, '\\u003c')

function tableHtml(columns: string[], rows: string[][], tbodyId?: string): string {
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join('')
  const body = rows
    .map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`)
    .join('\n')
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody${tbodyId ? ` id="${tbodyId}"` : ''}>${body}</tbody></table></div>`
}

/** Text-tile body: the mini-markdown subset (headings, bullets, bold), escaped. */
function textHtml(text: string): string {
  return parseMiniMarkdown(text)
    .map((b) => {
      const inner =
        b.spans.map((s) => (s.bold ? `<strong>${esc(s.text)}</strong>` : esc(s.text))).join('') ||
        '&nbsp;'
      return `<div class="md-${b.kind}">${inner}</div>`
    })
    .join('')
}

const BRAND_FOOTER = (): string =>
  `<footer>Exported by <strong>OpenVisualization</strong> â€” ${esc(new Date().toLocaleString())}</footer>`

export async function exportPdf(
  title: string,
  sections: PdfSection[],
  defaultName: string
): Promise<string | null> {
  const path = await askSavePath(`${defaultName}.pdf`, [{ name: 'PDF', extensions: ['pdf'] }])
  if (!path) return null
  const nCharts = sections.filter((s) => s.png).length
  const nTables = sections.filter((s) => s.table).length
  const summary = [
    nCharts ? `${nCharts} visualization${nCharts === 1 ? '' : 's'}` : '',
    nTables ? `${nTables} table${nTables === 1 ? '' : 's'}` : ''
  ]
    .filter(Boolean)
    .join(' Â· ')
  const blocks = sections
    .map((s) => {
      const parts: string[] = []
      if (s.title) parts.push(`<h2>${esc(s.title)}</h2>`)
      if (s.png) parts.push(`<img src="${s.png}">`)
      if (s.text) parts.push(`<p class="note">${esc(s.text)}</p>`)
      if (s.table) parts.push(tableHtml(s.table.columns, s.table.rows))
      return `<section>${parts.join('\n')}</section>`
    })
    .join('\n')
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #ffffff; color: #23272f; margin: 0; }
    .cover {
      background: linear-gradient(135deg, #24425f 0%, #4e79a7 70%, #6d94ba 100%);
      color: #ffffff; border-radius: 10px; padding: 26px 30px; margin-bottom: 24px;
    }
    .cover h1 { font-size: 26px; font-weight: 650; margin: 0 0 6px; letter-spacing: .2px; }
    .cover .meta { font-size: 12px; color: #dbe6f1; }
    .cover .brand {
      display: inline-block; margin-top: 14px; font-size: 10.5px; font-weight: 600; letter-spacing: .8px;
      text-transform: uppercase; color: #ffffff; border: 1px solid rgba(255,255,255,.5);
      border-radius: 12px; padding: 3px 12px;
    }
    main { padding: 0 2px; }
    section {
      page-break-inside: avoid; margin-bottom: 20px; border: 1px solid #e4e8ee;
      border-radius: 10px; padding: 14px 16px; background: #ffffff;
      box-shadow: 0 1px 2px rgba(16,24,40,.05);
    }
    h2 { font-size: 14px; font-weight: 600; color: #24425f; margin: 0 0 10px;
         padding-bottom: 6px; border-bottom: 2px solid #eef2f7; }
    img { max-width: 100%; border-radius: 6px; display: block; margin: 0 auto; }
    .note { font-size: 13px; line-height: 1.55; color: #3c4450; white-space: pre-wrap;
            background: #f6f8fb; border-left: 3px solid #4e79a7; border-radius: 4px; padding: 10px 14px; margin: 0; }
    .table-wrap { border: 1px solid #e4e8ee; border-radius: 8px; overflow: hidden; }
    table { border-collapse: collapse; width: 100%; font-size: 10.5px; }
    th { background: #24425f; color: #ffffff; text-align: left; padding: 6px 10px; }
    td { padding: 5px 10px; border-bottom: 1px solid #eef1f5; color: #3c4450; }
    tr:nth-child(even) td { background: #f7f9fc; }
    footer { font-size: 10px; color: #9aa2ad; border-top: 1px solid #e4e8ee; padding-top: 8px; margin-top: 4px; }
  </style></head><body>
    <div class="cover">
      <h1>${esc(title)}</h1>
      <div class="meta">${esc(new Date().toLocaleString())}${summary ? ` â€” ${esc(summary)}` : ''}</div>
      <span class="brand">OpenVisualization</span>
    </div>
    <main>${blocks}</main>
    ${BRAND_FOOTER()}
  </body></html>`
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const pdf = await win.webContents.printToPDF({
      landscape: true,
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.45, bottom: 0.55, left: 0.45, right: 0.45 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        `<div style="width:100%;font-size:8px;color:#9aa2ad;padding:0 34px;display:flex;justify-content:space-between;">` +
        `<span>${esc(title)}</span>` +
        `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>` +
        `</div>`
    })
    await writeFile(path, pdf)
  } finally {
    win.destroy()
  }
  return path
}

/**
 * Standalone interactive HTML: inlined echarts + serialized options.
 * Tiles keep the dashboard's 24-column grid placement; text, table and
 * filter-card tiles are exported too, so the file mirrors the dashboard.
 * When filter cards are present (and the export runtime bundle is built),
 * charts/tables carrying a detail payload stay INTERACTIVE: the page filters
 * and re-aggregates the embedded detail rows client-side and rebuilds each
 * chart through the real buildChartOption (see shared/exportInteractive.ts).
 */
export async function exportHtml(
  title: string,
  tiles: ExportTile[],
  defaultName: string,
  worldMapJson?: string
): Promise<string | null> {
  const path = await askSavePath(`${defaultName}.html`, [{ name: 'HTML', extensions: ['html'] }])
  if (!path) return null
  const echartsJs = await readFile(require.resolve('echarts/dist/echarts.min.js'), 'utf-8')
  const wordcloudJs = await readFile(
    require.resolve('echarts-wordcloud/dist/echarts-wordcloud.min.js'),
    'utf-8'
  ).catch(() => '')
  // built by `npm run build:runtime` (predev/prebuild hook); without it the
  // export still works, just with static charts
  const runtimeJs = await readFile(
    fileURLToPath(new URL('../../resources/ov-export-runtime.js', import.meta.url)),
    'utf-8'
  ).catch(() => '')
  const hasCards = tiles.some((t) => t.kind === 'filter')
  const interactive = !!runtimeJs && hasCards
  if (hasCards && !runtimeJs) {
    console.warn('[export] ov-export-runtime.js missing â€” filter cards exported read-only')
  }

  const place = (t: ExportTile): string =>
    `grid-column: ${t.x + 1} / span ${t.w}; grid-row: ${t.y + 1} / span ${t.h};`
  const accent = (t: { accent?: string }): string =>
    t.accent ? ` border-top: 3px solid ${esc(t.accent)};` : ''

  const cells: string[] = []
  const inits: string[] = []
  const payloadInits: string[] = []
  const cardsInit: Record<string, unknown> = {}
  tiles.forEach((t, i) => {
    if (t.kind === 'chart') {
      const head = t.hideHead ? '' : `<h2>${esc(t.title)}</h2>`
      cells.push(
        `<div class="tile" style="${place(t)}${accent(t)}">${head}<div id="chart${i}" class="chart"></div></div>`
      )
      inits.push(
        `CHARTS[${i}] = echarts.init(document.getElementById('chart${i}'), null, { renderer: 'canvas' });\n` +
          `CHARTS[${i}].setOption(${safeJson(t.option)});`
      )
      if (interactive && t.detail) payloadInits.push(`PAYLOADS[${i}] = ${safeJson(t.detail)};`)
    } else if (t.kind === 'text') {
      cells.push(`<div class="tile text" style="${place(t)}${accent(t)}">${textHtml(t.text)}</div>`)
    } else if (t.kind === 'table') {
      const head = t.hideHead ? '' : `<h2>${esc(t.title)}</h2>`
      cells.push(
        `<div class="tile" style="${place(t)}${accent(t)}">${head}${tableHtml(t.columns, t.rows, `tbody${i}`)}</div>`
      )
      if (interactive && t.detail)
        payloadInits.push(`TABLES[${i}] = { payload: ${safeJson(t.detail)}, maxRows: ${t.maxRows ?? 500} };`)
    } else {
      const cid = esc(t.cardId)
      cardsInit[t.cardId] = {
        mode: t.mode,
        values: t.selected ?? [],
        min: t.min,
        max: t.max,
        from: t.from,
        to: t.to
      }
      let body: string
      if (t.mode === 'in') {
        const sel = new Set(t.selected ?? [])
        const rows = (t.values ?? [])
          .map(
            (dv) =>
              `<label><input type="checkbox" class="fv" data-card="${cid}" value="${esc(dv.v)}"${sel.has(dv.v) ? ' checked' : ''}>` +
              `<span class="v">${esc(dv.v === '' ? '(blank)' : dv.v)}</span><span class="n">${dv.n.toLocaleString()}</span></label>`
          )
          .join('')
        body =
          `<div class="ftop"><input type="search" class="fsearch" placeholder="Searchâ€¦">` +
          `<button class="fclear" data-card="${cid}">All</button></div>` +
          `<div class="fhint" data-card="${cid}"></div><div class="fvals">${rows}</div>`
      } else if (t.mode === 'range') {
        const ph = (v?: number): string => (v !== undefined ? ` placeholder="${esc(String(v))}"` : '')
        const val = (v?: number): string => (v !== undefined ? ` value="${esc(String(v))}"` : '')
        body =
          `<div class="frange"><input type="number" class="fmin" data-card="${cid}"${val(t.min)}${ph(t.rangeLo)}>` +
          `<span>â€”</span><input type="number" class="fmax" data-card="${cid}"${val(t.max)}${ph(t.rangeHi)}></div>` +
          `<div class="fhint" data-card="${cid}"></div>`
      } else {
        const val = (v?: string): string => (v ? ` value="${esc(v)}"` : '')
        body =
          `<div class="frange"><input type="date" class="ffrom" data-card="${cid}"${val(t.from)}>` +
          `<span>â€”</span><input type="date" class="fto" data-card="${cid}"${val(t.to)}></div>` +
          `<div class="fhint" data-card="${cid}"></div>`
      }
      cells.push(
        `<div class="tile fcard" style="${place(t)}${accent(t)}"><h2>${esc(t.label)}</h2>${body}</div>`
      )
    }
  })

  const nCharts = tiles.filter((t) => t.kind === 'chart').length
  const nTables = tiles.filter((t) => t.kind === 'table').length
  const nFilters = tiles.filter((t) => t.kind === 'filter').length
  const summary = [
    nCharts ? `${nCharts} chart${nCharts === 1 ? '' : 's'}` : '',
    nTables ? `${nTables} table${nTables === 1 ? '' : 's'}` : '',
    nFilters && interactive ? `${nFilters} interactive filter${nFilters === 1 ? '' : 's'}` : ''
  ]
    .filter(Boolean)
    .join(' Â· ')
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="OpenVisualization">
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #eef1f6; color: #23272f; margin: 0; }
  .topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 14px;
            padding: 14px 28px; background: #ffffff; border-bottom: 1px solid #e4e8ee;
            box-shadow: 0 1px 4px rgba(16,24,40,.05); }
  .logo { width: 12px; height: 12px; border-radius: 3px; flex: none;
          background: linear-gradient(135deg, #24425f, #4e79a7); }
  .topbar h1 { font-size: 19px; font-weight: 650; color: #1b2733; margin: 0; letter-spacing: .2px; }
  .topbar .when { font-size: 12px; color: #7a8291; }
  .topbar .stats { font-size: 12px; color: #7a8291; border-left: 1px solid #e4e8ee; padding-left: 14px; }
  .topbar .spacer { flex: 1; }
  .topbar .print { font-size: 12px; color: #4e79a7; background: #f2f6fb; border: 1px solid #d5e0ec;
                   border-radius: 6px; padding: 5px 14px; cursor: pointer; font-family: inherit; }
  .topbar .print:hover { background: #e6eef7; }
  .topbar .brand { font-size: 10.5px; font-weight: 600; letter-spacing: .8px; text-transform: uppercase;
                   color: #4e79a7; border: 1px solid #d5e0ec; border-radius: 12px; padding: 3px 12px; }
  .grid { display: grid; grid-template-columns: repeat(24, 1fr); grid-auto-rows: 34px; gap: 14px;
          padding: 22px 28px; max-width: 1600px; margin: 0 auto; }
  .tile { background: #ffffff; border: 1px solid #e4e8ee; border-radius: 10px; padding: 14px 16px;
          box-shadow: 0 1px 3px rgba(16,24,40,.06); display: flex; flex-direction: column;
          min-width: 0; min-height: 0; overflow: hidden; transition: box-shadow .15s, transform .15s; }
  .tile:hover { box-shadow: 0 4px 14px rgba(16,24,40,.12); }
  .tile h2 { font-size: 13px; font-weight: 600; color: #24425f; margin: 0 0 8px; flex: none;
             padding-bottom: 6px; border-bottom: 2px solid #f0f3f8; }
  .chart { flex: 1; min-height: 0; width: 100%; }
  .tile.text { font-size: 14px; line-height: 1.55; color: #3c4450; }
  .tile.text .md-h1 { font-size: 19px; font-weight: 650; color: #1b2733; margin: 2px 0 6px; }
  .tile.text .md-h2 { font-size: 15px; font-weight: 600; color: #24425f; margin: 2px 0 4px; }
  .tile.text .md-li { padding-left: 16px; position: relative; }
  .tile.text .md-li::before { content: 'â€¢'; position: absolute; left: 4px; color: #4e79a7; }
  .tile.text .md-p { min-height: 8px; }
  .tile.fcard .ftop { display: flex; gap: 6px; margin-bottom: 4px; }
  .fsearch { flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 3px 8px;
             border: 1px solid #d5e0ec; border-radius: 6px; }
  .fclear { font-size: 11px; color: #4e79a7; background: #f2f6fb; border: 1px solid #d5e0ec;
            border-radius: 6px; padding: 3px 10px; cursor: pointer; font-family: inherit; }
  .fclear:hover { background: #e6eef7; }
  .fhint { font-size: 10.5px; color: #7a8291; margin-bottom: 4px; }
  .fvals { flex: 1; min-height: 0; overflow: auto; border: 1px solid #eef1f5; border-radius: 6px; padding: 4px; }
  .fvals label { display: flex; gap: 6px; align-items: center; font-size: 12px; padding: 2px 4px;
                 cursor: pointer; color: #3c4450; }
  .fvals .v { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fvals .n { color: #9aa2ad; font-size: 10px; }
  .frange { display: flex; gap: 6px; align-items: center; color: #7a8291; }
  .frange input { flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 3px 8px;
                  border: 1px solid #d5e0ec; border-radius: 6px; }
  .table-wrap { flex: 1; min-height: 0; overflow: auto; border: 1px solid #eef1f5; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th { position: sticky; top: 0; background: #24425f; color: #ffffff; text-align: left;
       padding: 6px 10px; white-space: nowrap; }
  td { padding: 5px 10px; border-bottom: 1px solid #eef1f5; color: #3c4450; white-space: nowrap; }
  tr:nth-child(even) td { background: #f7f9fc; }
  tr:hover td { background: #eef4fb; }
  footer { text-align: center; font-size: 11px; color: #9aa2ad; padding: 6px 0 22px; }
  @media print {
    .topbar { position: static; box-shadow: none; }
    .topbar .print { display: none; }
    body { background: #ffffff; }
    .tile { break-inside: avoid; box-shadow: none; }
  }
  @media (max-width: 900px) {
    .grid { display: flex; flex-direction: column; }
    .chart { height: 340px; }
  }
</style>
<script>${echartsJs}</script>
<script>${wordcloudJs}</script>
${worldMapJson ? `<script>echarts.registerMap('world', ${safeJson(worldMapJson)});</script>` : ''}
${interactive ? `<script>${runtimeJs}</script>` : ''}
</head><body>
<div class="topbar">
  <span class="logo"></span>
  <h1>${esc(title)}</h1>
  <span class="when">${esc(new Date().toLocaleString())}</span>
  ${summary ? `<span class="stats">${esc(summary)}</span>` : ''}
  <span class="spacer"></span>
  <button class="print" onclick="window.print()">ðŸ–¨ Print / PDF</button>
  <span class="brand">OpenVisualization</span>
</div>
<div class="grid">
${cells.join('\n')}
</div>
${BRAND_FOOTER()}
<script>
var CHARTS = {};
${inits.join('\n')}
window.addEventListener('resize', () => document.querySelectorAll('.chart').forEach(el => echarts.getInstanceByDom(el)?.resize()));
window.addEventListener('beforeprint', () => document.querySelectorAll('.chart').forEach(el => echarts.getInstanceByDom(el)?.resize()));
</script>
${interactive ? interactiveScript(payloadInits, cardsInit) : ''}
</body></html>`
  await writeFile(path, html, 'utf-8')
  return path
}

/**
 * The in-page filtering script. Deliberately free of template-literal
 * interpolation inside the JS itself (plain string concatenation) so nothing
 * here can collide with the outer TypeScript template.
 */
function interactiveScript(payloadInits: string[], cardsInit: Record<string, unknown>): string {
  return `<script>
var PAYLOADS = {};
var TABLES = {};
${payloadInits.join('\n')}
var CARDS = ${safeJson(JSON.stringify(cardsInit))};
function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function updateHint(id) {
  var c = CARDS[id];
  var el = document.querySelector('.fhint[data-card="' + id + '"]');
  if (!c || !el) return;
  if (c.mode === 'in') {
    el.textContent = c.values && c.values.length
      ? c.values.length + ' selected'
      : 'Nothing selected â€” showing all';
  } else if (c.mode === 'range') {
    el.textContent = c.min === undefined && c.max === undefined
      ? 'No bounds â€” showing all'
      : (c.min !== undefined ? c.min : 'â€¦') + ' to ' + (c.max !== undefined ? c.max : 'â€¦');
  } else {
    el.textContent = !c.from && !c.to
      ? 'No bounds â€” showing all'
      : (c.from || 'â€¦') + ' â†’ ' + (c.to || 'â€¦');
  }
}
function refresh() {
  if (!window.OVR) return;
  Object.keys(PAYLOADS).forEach(function (k) {
    try {
      var p = PAYLOADS[k];
      var res = OVR.computeFilteredResult(p, CARDS);
      var opt = OVR.buildChartOption(p.shelf, p.built, res);
      if (opt && CHARTS[k]) CHARTS[k].setOption(OVR.toLightOption(opt), { notMerge: true });
    } catch (err) { console.error('chart refresh', k, err); }
  });
  Object.keys(TABLES).forEach(function (k) {
    try {
      var tp = TABLES[k];
      var res = OVR.computeFilteredResult(tp.payload, CARDS);
      var aliases = tp.payload.built.dimAliases.concat(tp.payload.built.measureAliases);
      var html = res.rows.slice(0, tp.maxRows).map(function (row) {
        return '<tr>' + aliases.map(function (a) {
          var v = row[a];
          return '<td>' + escHtml(v === null || v === undefined ? '\\u2205' : String(v)) + '</td>';
        }).join('') + '</tr>';
      }).join('');
      var body = document.getElementById('tbody' + k);
      if (body) body.innerHTML = html;
    } catch (err) { console.error('table refresh', k, err); }
  });
}
var refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 120);
}
document.addEventListener('change', function (e) {
  var t = e.target;
  if (!t || !t.getAttribute) return;
  var id = t.getAttribute('data-card');
  var c = id && CARDS[id];
  if (!c) return;
  if (t.classList.contains('fv')) {
    c.values = c.values || [];
    var idx = c.values.indexOf(t.value);
    if (t.checked && idx < 0) c.values.push(t.value);
    if (!t.checked && idx >= 0) c.values.splice(idx, 1);
  } else if (t.classList.contains('fmin') || t.classList.contains('fmax')) {
    var v = t.value.trim() === '' ? undefined : Number(t.value);
    if (v !== undefined && isNaN(v)) v = undefined;
    if (t.classList.contains('fmin')) c.min = v; else c.max = v;
  } else if (t.classList.contains('ffrom')) {
    c.from = t.value || undefined;
  } else if (t.classList.contains('fto')) {
    c.to = t.value || undefined;
  }
  updateHint(id);
  scheduleRefresh();
});
document.addEventListener('click', function (e) {
  var t = e.target;
  if (!t || !t.classList || !t.classList.contains('fclear')) return;
  var id = t.getAttribute('data-card');
  var c = id && CARDS[id];
  if (!c) return;
  c.values = [];
  var tile = t.closest('.tile');
  if (tile) tile.querySelectorAll('.fv').forEach(function (cb) { cb.checked = false; });
  updateHint(id);
  scheduleRefresh();
});
document.addEventListener('input', function (e) {
  var t = e.target;
  if (!t || !t.classList || !t.classList.contains('fsearch')) return;
  var q = t.value.toLowerCase();
  var tile = t.closest('.tile');
  if (!tile) return;
  tile.querySelectorAll('.fvals label').forEach(function (l) {
    l.style.display = l.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
  });
});
Object.keys(CARDS).forEach(updateHint);
refresh();
</script>`
}

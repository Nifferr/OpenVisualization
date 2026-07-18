// Mail-archive ingestion. Two strategies:
//   'pst'    — structured MAPI walk of Outlook PST/OST via pst-extractor
//              (pure JS: no native build, respects the OneDrive/Windows notes
//              in CLAUDE.md).
//   'carved' — raw RFC-822 recovery scan for NSF/ZDB/BAK and for PST/OST files
//              too corrupted for the structured walk. Salvages every message
//              block it can find and never throws on a bad record.
// Both emit one row per message with MAPI-ish columns into a Parquet file,
// which registerDataSource then reads via read_parquet (kind: 'emails').
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { exec, runQuery, sqlPath } from './duck'
import { emitProgress } from './progress'
import { quoteIdent } from '../shared/sqlBuilder'
import {
  carveMessages,
  EMAIL_COLUMN_TYPES,
  type EmailRow
} from '../shared/emailParse'
import type { EmailIngestResult } from '../shared/types'

const IMPORTANCE = ['Low', 'Normal', 'High']
const SENSITIVITY = ['Normal', 'Personal', 'Private', 'Confidential']

function iso(d: unknown): string | undefined {
  if (!(d instanceof Date)) return undefined
  const t = d.getTime()
  if (!Number.isFinite(t) || t <= 0) return undefined
  return d.toISOString()
}

/** Yield to the event loop so queued progress IPC actually reaches the UI. */
const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

// ---------- structured PST/OST walk ----------

/* eslint-disable @typescript-eslint/no-explicit-any */
function countMessages(folder: any): number {
  let n = 0
  try {
    n += Number(folder.contentCount ?? 0)
  } catch {
    /* unreadable count */
  }
  try {
    for (const sub of folder.getSubFolders() ?? []) n += countMessages(sub)
  } catch {
    /* unreadable subfolder list */
  }
  return n
}

function recipientsByType(msg: any): { to: string; cc: string; bcc: string } {
  const buckets: Record<number, string[]> = { 1: [], 2: [], 3: [] }
  let count = 0
  try {
    count = Number(msg.numberOfRecipients ?? 0)
  } catch {
    count = 0
  }
  for (let i = 0; i < count; i++) {
    try {
      const r = msg.getRecipient(i)
      if (!r) continue
      const addr = (r.smtpAddress || r.emailAddress || '').trim()
      const name = (r.recipientDisplayName || r.displayName || '').trim()
      const label = name && addr && name !== addr ? `${name} <${addr}>` : addr || name
      if (label) (buckets[r.recipientType] ?? (buckets[3] ||= [])).push(label)
    } catch {
      /* skip unreadable recipient */
    }
  }
  return {
    to: buckets[1].join('; '),
    cc: buckets[2].join('; '),
    bcc: buckets[3].join('; ')
  }
}

function attachmentInfo(msg: any): { count: number; names: string } {
  let count = 0
  try {
    count = Number(msg.numberOfAttachments ?? 0)
  } catch {
    count = 0
  }
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    try {
      const a = msg.getAttachment(i)
      const n = a?.longFilename || a?.filename || ''
      if (n) names.push(n)
    } catch {
      /* skip unreadable attachment */
    }
  }
  return { count, names: names.join('; ') }
}

function messageToRow(msg: any, folderPath: string): EmailRow {
  const g = <T>(fn: () => T): T | undefined => {
    try {
      return fn()
    } catch {
      return undefined
    }
  }
  const rec = recipientsByType(msg)
  const att = attachmentInfo(msg)
  const impNum = g(() => Number(msg.importance))
  const sensNum = g(() => Number(msg.sensitivity))
  return {
    folder: folderPath,
    subject: g(() => msg.subject) || undefined,
    from_name: g(() => msg.senderName || msg.sentRepresentingName) || undefined,
    from_email:
      g(() => msg.senderEmailAddress || msg.sentRepresentingEmailAddress) || undefined,
    to_recipients: rec.to || undefined,
    cc_recipients: rec.cc || undefined,
    bcc_recipients: rec.bcc || undefined,
    date_sent: iso(g(() => msg.clientSubmitTime)),
    date_received: iso(g(() => msg.messageDeliveryTime)),
    message_id: g(() => msg.internetMessageId) || undefined,
    in_reply_to: g(() => msg.inReplyToId) || undefined,
    conversation_topic: g(() => msg.conversationTopic) || undefined,
    importance: impNum !== undefined ? IMPORTANCE[impNum] ?? String(impNum) : undefined,
    priority: g(() => (msg.priority !== undefined ? String(msg.priority) : undefined)),
    sensitivity: sensNum !== undefined ? SENSITIVITY[sensNum] ?? String(sensNum) : undefined,
    message_class: g(() => msg.messageClass) || undefined,
    is_read: g(() => Boolean(msg.isRead)),
    has_attachments: att.count > 0,
    num_attachments: att.count,
    attachment_names: att.names || undefined,
    size: g(() => Number(msg.messageSize)) || undefined,
    body: g(() => msg.body) || undefined,
    body_html: g(() => msg.bodyHTML) || undefined,
    headers: g(() => msg.transportMessageHeaders) || undefined
  }
}

async function walkPst(
  path: string,
  emit: (row: EmailRow) => void,
  onProgress: (done: number, total: number) => void,
  warnings: string[]
): Promise<number> {
  const mod = (await import('pst-extractor')) as typeof import('pst-extractor') & {
    default?: typeof import('pst-extractor')
  }
  const PSTFile = mod.PSTFile ?? mod.default?.PSTFile
  if (!PSTFile) throw new Error('pst-extractor failed to load')
  const pst = new PSTFile(path)
  const root = pst.getRootFolder()
  const total = countMessages(root)
  let done = 0

  const walk = async (folder: any, pathParts: string[]): Promise<void> => {
    const name = (() => {
      try {
        return folder.displayName || ''
      } catch {
        return ''
      }
    })()
    const here = name ? [...pathParts, name] : pathParts
    const folderPath = here.join(' / ')
    let hasContent = false
    try {
      hasContent = Number(folder.contentCount ?? 0) > 0
    } catch {
      hasContent = true // attempt anyway
    }
    if (hasContent) {
      // getNextChild advances an internal cursor; loop until it returns null
      for (;;) {
        let child: any
        try {
          child = folder.getNextChild()
        } catch (e) {
          warnings.push(`Folder "${folderPath}": ${e instanceof Error ? e.message : e}`)
          break
        }
        if (!child) break
        try {
          emit(messageToRow(child, folderPath))
        } catch (e) {
          warnings.push(`Message in "${folderPath}": ${e instanceof Error ? e.message : e}`)
        }
        done++
        if (done % 25 === 0) {
          onProgress(done, total)
          await yieldToLoop()
        }
      }
    }
    let subs: any[] = []
    try {
      subs = folder.getSubFolders() ?? []
    } catch (e) {
      warnings.push(`Subfolders of "${folderPath}": ${e instanceof Error ? e.message : e}`)
    }
    for (const sub of subs) await walk(sub, here)
  }

  await walk(root, [])
  onProgress(done, total)
  try {
    pst.close()
  } catch {
    /* ignore */
  }
  return done
}

// ---------- write rows → Parquet via DuckDB ----------

async function rowsToParquet(rows: EmailRow[], parquetPath: string): Promise<number> {
  const keys = Object.keys(EMAIL_COLUMN_TYPES) as (keyof EmailRow)[]
  if (rows.length === 0) {
    // still emit a schema-correct empty Parquet so the view can register
    const empty = keys.map((k) => `CAST(NULL AS ${EMAIL_COLUMN_TYPES[k]}) AS ${quoteIdent(k)}`).join(', ')
    await exec(`COPY (SELECT ${empty} WHERE 1 = 0) TO ${sqlPath(parquetPath)} (FORMAT parquet)`)
    return 0
  }
  const ndjsonPath = parquetPath + '.ndjson'
  // NDJSON handles arbitrarily large bodies natively (no giant SQL literals);
  // read_json with explicit column types keeps the Parquet schema stable even
  // when the first rows have NULLs everywhere.
  const lines = rows.map((r) => {
    const obj: Record<string, unknown> = {}
    for (const k of keys) obj[k] = r[k] ?? null
    return JSON.stringify(obj)
  })
  await writeFile(ndjsonPath, lines.join('\n'), 'utf-8')
  const colSpec = keys.map((k) => `'${k}': '${EMAIL_COLUMN_TYPES[k]}'`).join(', ')
  await exec(
    `COPY (SELECT * FROM read_json(${sqlPath(ndjsonPath)}, ` +
      `format = 'newline_delimited', columns = {${colSpec}})) ` +
      `TO ${sqlPath(parquetPath)} (FORMAT parquet)`
  )
  await unlink(ndjsonPath).catch(() => {})
  const cnt = await runQuery(`SELECT count(*) AS c FROM read_parquet(${sqlPath(parquetPath)})`)
  return Number(cnt.rows[0]?.['c'] ?? 0)
}

/**
 * Parse a mail archive into a Parquet of messages. `outPath` lets the caller
 * (view re-registration on workbook open) target an existing path; omitted, a
 * fresh file is minted under userData/emails so the source survives reopen.
 */
export async function ingestEmailArchive(
  path: string,
  outPath?: string
): Promise<EmailIngestResult> {
  const dir = join(app.getPath('userData'), 'emails')
  await mkdir(dir, { recursive: true })
  const parquetPath = outPath ?? join(dir, `${randomUUID()}.parquet`)
  const warnings: string[] = []
  const rows: EmailRow[] = []
  const label = `Reading e-mails — ${path.replace(/\\/g, '/').split('/').pop()}`
  const key = `emails:${path}`
  emitProgress({ key, label, pct: null })

  let format: 'pst' | 'carved' = 'carved'
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  const tryPst = ext === '.pst' || ext === '.ost'

  try {
    if (tryPst) {
      try {
        await walkPst(
          path,
          (row) => rows.push(row),
          (done, total) =>
            emitProgress({
              key,
              label,
              pct: total > 0 ? done / total : null,
              detail: `${done.toLocaleString()}${total ? ` of ${total.toLocaleString()}` : ''} messages`
            }),
          warnings
        )
        format = 'pst'
      } catch (e) {
        // structured walk failed outright (bad header, truncated file) — carve
        warnings.push(
          `Structured read failed (${e instanceof Error ? e.message : e}); recovered by scanning raw bytes.`
        )
        rows.length = 0
      }
    }

    if (format === 'carved') {
      emitProgress({ key, label, pct: null, detail: 'scanning for messages…' })
      const buf = await readFile(path)
      // latin1 is byte-preserving; header/body text survives, binary is inert
      const carved = carveMessages(buf.toString('latin1'), (row) => rows.push(row))
      if (carved === 0 && tryPst) {
        warnings.push('No readable messages were recovered from this file.')
      }
    }

    emitProgress({ key, label, pct: 0.98, detail: `writing ${rows.length.toLocaleString()} messages` })
    const rowCount = await rowsToParquet(rows, parquetPath)
    return { parquetPath, format, rowCount, warnings }
  } finally {
    emitProgress({ key, label, pct: 1, done: true })
  }
}

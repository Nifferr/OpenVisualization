// Import a mail archive (PST/OST/NSF/ZDB/BAK) as an "Emails" data source.
// The main process parses it into a Parquet of messages (structured MAPI walk
// for Outlook stores, raw RFC-822 carving for the rest and for corrupted
// files) while pushing progress; this dialog shows the bar and, on success,
// registers the source and opens it.
import { useState } from 'react'
import { api } from '../api'
import { nextId, useApp } from '../store'
import type { DataSourceDef } from '@shared/types'
import { ProgressBar } from './ProgressBar'

export function EmailImportDialog({
  path,
  name,
  onClose
}: {
  path: string
  name: string
  onClose: () => void
}): React.JSX.Element {
  const progress = useApp((s) => s.progress[`emails:${path}`])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[] | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setWarnings(null)
    try {
      const res = await api.ingestEmails(path)
      if (res.rowCount === 0) {
        setError(
          'No messages could be read from this file.' +
            (res.warnings.length ? '\n\n' + res.warnings.join('\n') : '')
        )
        setBusy(false)
        return
      }
      const def: DataSourceDef = {
        kind: 'emails',
        id: nextId('eml'),
        name,
        path,
        parquetPath: res.parquetPath,
        format: res.format
      }
      const desc = await api.registerDataSource(def)
      const s = useApp.getState()
      s.addDataSource(def, desc.fields, desc.rowCount)
      s.setStatus(
        `Loaded ${name}: ${res.rowCount.toLocaleString()} messages` +
          (res.format === 'carved' ? ' (recovered by raw scan)' : '')
      )
      if (res.warnings.length) {
        // surface non-fatal issues but keep the successfully-loaded source open
        setWarnings(res.warnings)
        setBusy(false)
        return
      }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => !busy && e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 560 }}>
        <header>Import e-mails from &quot;{name}&quot;</header>
        <div className="body">
          <div className="form-row">
            <label>File</label>
            <span className="vtext" style={{ fontSize: 12 }} title={path}>{path}</span>
          </div>
          <div className="drop-hint wiz-note">
            Reads every MAPI field it can (subject, from/to/cc/bcc, dates, importance,
            headers, body, attachments…) into a table with one row per message.
            Outlook <code>.pst</code>/<code>.ost</code> are walked by structure;{' '}
            <code>.nsf</code>/<code>.zdb</code>/<code>.bak</code> and any file too corrupted for
            that fall back to a raw byte scan that salvages whatever messages it can find.
            Afterwards you can chart the messages or export any selection as{' '}
            <code>.eml</code> from the source page.
          </div>
          {(busy || progress) && (
            <div style={{ marginTop: 8 }}>
              {progress ? (
                <ProgressBar p={progress} />
              ) : (
                <div className="progress-row">
                  <span className="plabel">Working…</span>
                  <span className="progress-track">
                    <span className="progress-fill indeterminate" />
                  </span>
                </div>
              )}
            </div>
          )}
          {warnings && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--text)' }}>
                Loaded with {warnings.length} warning{warnings.length > 1 ? 's' : ''}:
              </div>
              <div
                className="drop-hint"
                style={{
                  maxHeight: 140,
                  overflow: 'auto',
                  fontSize: 11,
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'Consolas, monospace'
                }}
              >
                {warnings.slice(0, 100).join('\n')}
                {warnings.length > 100 ? `\n…and ${warnings.length - 100} more` : ''}
              </div>
            </div>
          )}
          {error && (
            <div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8 }}>
              {error}
            </div>
          )}
        </div>
        <footer>
          <button onClick={onClose} disabled={busy}>
            {warnings ? 'Close' : 'Cancel'}
          </button>
          {!warnings && (
            <button className="primary" disabled={busy} onClick={() => void run()}>
              {busy ? 'Reading…' : 'Import e-mails →'}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

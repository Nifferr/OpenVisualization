// Lightweight read-only grid over an arbitrary SELECT. Used where a full
// DataSourcePage isn't available yet — e.g. previewing entity-extraction rows
// (all columns) before the source is created.
import { useEffect, useState } from 'react'
import { api } from '../api'
import type { QueryResult } from '@shared/types'

export function SqlPreviewDialog({
  title,
  sql,
  onClose
}: {
  title: string
  sql: string
  onClose: () => void
}): React.JSX.Element {
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setResult(null)
    setError('')
    api
      .runQuery(sql)
      .then((r) => !cancelled && setResult(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [sql])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide">
        <header>{title}</header>
        <div className="body" style={{ position: 'relative', overflow: 'auto' }}>
          {error && <div style={{ color: 'var(--red)', whiteSpace: 'pre-wrap', fontSize: 12 }}>{error}</div>}
          {!result && !error && (
            <div className="loading-overlay">
              <span className="spinner" /> Running preview…
            </div>
          )}
          {result && (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>
                {result.rowCount.toLocaleString()} rows{result.truncated ? ' (truncated)' : ''} ·{' '}
                {result.columns.length} columns
              </div>
              <table className="grid">
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th key={c.name} title={c.kind}>{c.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {result.columns.map((c) => {
                        const v = row[c.name]
                        return (
                          <td key={c.name} title={v == null ? '' : String(v)}>
                            {v == null ? '' : String(v)}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
        <footer>
          <button className="primary" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>
  )
}

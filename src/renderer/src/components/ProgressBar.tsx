// Progress bar for main-process OpProgress events: determinate when a
// fraction is known, sliding animation when not (pct === null).
import type { OpProgress } from '@shared/types'

export function ProgressBar({
  p,
  showLabel = true
}: {
  p: OpProgress
  showLabel?: boolean
}): React.JSX.Element {
  return (
    <div className="progress-row" title={p.detail ? `${p.label} — ${p.detail}` : p.label}>
      {showLabel && <span className="plabel">{p.label}</span>}
      <span className="progress-track">
        {p.pct === null ? (
          <span className="progress-fill indeterminate" />
        ) : (
          <span className="progress-fill" style={{ width: `${Math.round(p.pct * 100)}%` }} />
        )}
      </span>
      <span className="progress-pct">
        {p.pct !== null ? `${Math.round(p.pct * 100)}%` : ''}
        {p.detail ? ` ${p.detail}` : ''}
      </span>
    </div>
  )
}

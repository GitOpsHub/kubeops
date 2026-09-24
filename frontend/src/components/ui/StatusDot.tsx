import { statusMeta, type StatusDomain, type Tone } from '../../lib/status'
import './StatusDot.css'

type Props = {
  /** Either a tone directly, or a domain and value to look one up. */
  tone?: Tone
  domain?: StatusDomain
  status?: string | null
  /** Overrides the pulse the status implies. */
  inFlight?: boolean
  size?: 'sm' | 'md'
  /** Drops the soft halo, for dense rows. */
  plain?: boolean
  /**
   * The dot is decorative unless labelled: most callers print the status
   * beside it. Pass a label when the dot stands alone.
   */
  label?: string
  className?: string
}

export function StatusDot({
  tone,
  domain,
  status,
  inFlight,
  size = 'md',
  plain = false,
  label,
  className = '',
}: Props) {
  const meta = domain ? statusMeta(domain, status) : null
  const resolved = tone ?? meta?.tone ?? 'idle'
  const pulse = inFlight ?? meta?.inFlight ?? false
  const classes = [
    'status-dot',
    size === 'sm' && 'status-dot--sm',
    plain && 'status-dot--plain',
    pulse && 'status-dot--pulse',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span
      className={classes}
      data-tone={resolved}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}

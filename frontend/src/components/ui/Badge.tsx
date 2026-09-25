import type { ReactNode } from 'react'
import { statusMeta, type StatusDomain, type Tone } from '../../lib/status'
import './Badge.css'

type StatusProps = {
  status: string
  /** Where the value comes from; see `StatusDomain`. */
  domain: StatusDomain
  /** Overrides the derived tone when the caller knows better (e.g. a removed row). */
  tone?: Tone
  /** Overrides the canonical label. */
  label?: string
}

/**
 * One badge for every status the API reports — cluster health, deployment
 * state, sync runs, Argo CD — so "failed" is the same red and "Out of Sync"
 * the same words wherever they appear. Work still in flight breathes.
 *
 * When the canonical label differs from the API value only in case, the DOM
 * keeps the API's own word and CSS capitalises it: find-in-page, copy, and
 * tests all see "active", the eye sees "Active".
 */
export function StatusBadge({ status, domain, tone, label }: StatusProps) {
  const meta = statusMeta(domain, status)
  const resolved = tone ?? meta.tone
  // A plain lowercase compare, not normalise(): normalise strips spaces, which
  // would treat "OutOfSync" → "Out of Sync" as a case-only change.
  // An exact match needs no CSS casing — capitalize would turn "Out of Sync"
  // into "Out Of Sync".
  const trimmed = status.trim()
  const caseOnly =
    !label && meta.label !== trimmed && meta.label.toLowerCase() === trimmed.toLowerCase()
  const text = label ?? (caseOnly ? status : meta.label)
  const classes = [
    'status-badge',
    `status-badge--${resolved}`,
    meta.inFlight && 'status-badge--pulse',
    caseOnly && 'status-badge--cased',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={classes} data-tone={resolved}>
      {text}
    </span>
  )
}

/** A neutral tag for identifiers: environments, regions, source IDs. */
export function Tag({
  children,
  mono = false,
  title,
}: {
  children: ReactNode
  mono?: boolean
  title?: string
}) {
  return (
    <span className={mono ? 'tag tag--mono' : 'tag'} title={title}>
      {children}
    </span>
  )
}

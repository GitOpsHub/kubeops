import { useEffect, useState } from 'react'
import { formatElapsed } from './operation-phases'

type Props = {
  startedAt: string | null
  finishedAt?: string | null
  /** Ticks every second while true; otherwise shows the final duration. */
  running: boolean
  className?: string
}

/** A stopwatch for an operation: live while it runs, frozen once it ends. */
export function ElapsedTime({ startedAt, finishedAt, running, className }: Props) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running])

  const start = startedAt ? Date.parse(startedAt) : Number.NaN
  if (Number.isNaN(start)) return null
  const end = !running && finishedAt ? Date.parse(finishedAt) : now
  return (
    <span className={`elapsed tabular ${className ?? ''}`.trim()}>
      {formatElapsed(Math.max(0, (Number.isNaN(end) ? now : end) - start))}
    </span>
  )
}

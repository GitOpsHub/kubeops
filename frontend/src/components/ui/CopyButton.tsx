import { useEffect, useState } from 'react'
import { CheckIcon, CopyIcon } from '../icons'
import { Button } from './Button'

type Props = {
  value: string
  /** What is copied, for the accessible name: "Copy image reference". */
  label?: string
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Copies a value and confirms in place: the icon turns into a check and the
 * name says "Copied" for a moment. No toast — the feedback belongs where the
 * pointer already is.
 */
export function CopyButton({ value, label = 'value', size = 'sm', className }: Props) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      // Clipboard access can be denied; the value is still on screen to select.
    }
  }

  const name = copied ? 'Copied' : `Copy ${label}`
  return (
    <Button
      variant="ghost"
      size={size}
      iconOnly
      aria-label={name}
      title={name}
      className={className}
      onClick={() => void copy()}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

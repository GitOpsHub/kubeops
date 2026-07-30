import type { ReactNode } from 'react'
import { KubernetesLogo } from './BrandIcons'

type Props = {
  kind: string
  className?: string
}

/**
 * Small topology glyphs that distinguish Kubernetes object types at a glance.
 * They inherit the category colour from the graph card instead of introducing
 * a second, unrelated palette.
 */
export function KubernetesResourceIcon({ kind, className = '' }: Props) {
  const normalized = kind.toLowerCase()
  const paths: Record<string, ReactNode> = {
    deployment: (
      <>
        <rect x="5" y="5" width="10" height="10" rx="1.5" />
        <path d="M9 3h8a2 2 0 0 1 2 2v8M7 19h8a2 2 0 0 0 2-2" />
      </>
    ),
    replicaset: (
      <>
        <rect x="4" y="8" width="8" height="8" rx="1.5" />
        <rect x="8" y="4" width="8" height="8" rx="1.5" />
        <rect x="12" y="8" width="8" height="8" rx="1.5" />
      </>
    ),
    pod: (
      <>
        <path d="m12 3 7 4v8l-7 4-7-4V7l7-4Z" />
        <path d="m5 7 7 4 7-4M12 11v8" />
      </>
    ),
    service: (
      <>
        <circle cx="12" cy="5" r="2" />
        <circle cx="6" cy="16" r="2" />
        <circle cx="18" cy="16" r="2" />
        <path d="m11 7-4 7m6-7 4 7M8 16h8" />
      </>
    ),
    serviceaccount: (
      <>
        <circle cx="12" cy="8" r="3" />
        <path d="M5.5 19a6.5 6.5 0 0 1 13 0M17 5.5l1.5-1.5M7 5.5 5.5 4" />
      </>
    ),
    ingress: (
      <>
        <path d="M4 6h7a4 4 0 0 1 4 4v8M8 3 4 6l4 3" />
        <path d="m12 15 3 3 3-3" />
      </>
    ),
    configmap: (
      <>
        <path d="M8 4H5v16h3M16 4h3v16h-3" />
        <path d="M10 8h4M10 12h4M10 16h4" />
      </>
    ),
    secret: (
      <>
        <rect x="5" y="10" width="14" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" />
      </>
    ),
    persistentvolumeclaim: (
      <>
        <ellipse cx="12" cy="6" rx="7" ry="3" />
        <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
      </>
    ),
    job: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="m8 12 2.5 2.5L16 9" />
      </>
    ),
  }

  const content = paths[normalized]
  if (!content) return <KubernetesLogo className={className} />

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
    >
      {content}
    </svg>
  )
}

import type { SVGProps } from 'react'
import type { Provider } from '../api/inventory'

type IconProps = SVGProps<SVGSVGElement> & {
  title?: string
}

export function KubernetesLogo({ title, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" role={title ? 'img' : undefined} aria-hidden={!title} {...props}>
      {title && <title>{title}</title>}
      <path
        fill="#326CE5"
        d="M24 2.8 42.4 13.4v21.2L24 45.2 5.6 34.6V13.4L24 2.8Z"
      />
      <g fill="none" stroke="#fff" strokeLinecap="round">
        <circle cx="24" cy="24" r="7.1" strokeWidth="3" />
        <path
          d="M24 9.8v7.1M24 31.1v7.1M38.2 24h-7.1M16.9 24H9.8M34 14l-5 5M19 29l-5 5M34 34l-5-5M19 19l-5-5"
          strokeWidth="2.6"
        />
      </g>
    </svg>
  )
}

function EksLogo(props: IconProps) {
  return (
    <svg viewBox="0 0 40 40" {...props}>
      <image href="/icons/amazon-eks.svg" width="40" height="40" />
    </svg>
  )
}

function AksLogo(props: IconProps) {
  return (
    <svg viewBox="0 0 18 18" {...props}>
      <image href="/icons/azure-aks.svg" width="18" height="18" />
    </svg>
  )
}

function GkeLogo(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...props}>
      <image href="/icons/google-gke.svg" width="24" height="24" />
    </svg>
  )
}

/** Marks a container image, e.g. beside an application's image reference. */
export function ContainerImageLogo(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" {...props}>
      <g fill="#2496ED">
        <path d="M9 20h6v5H9zM16 20h6v5h-6zM23 20h6v5h-6zM16 14h6v5h-6zM23 14h6v5h-6zM30 20h6v5h-6zM23 8h6v5h-6z" />
        <path d="M43 22.2c-1.7-1.1-4.3-.8-5.5-.1-.2-2-1.3-3.8-3.3-5l-1.2 1.8c1.5.9 2.3 2.1 2.4 3.8H6.2c-.4 6.2 1.4 11.1 5.3 14 3.7 2.8 9.5 3.3 15.3 1.2 5.8-2.1 9.7-6.6 11.1-12.6 2.2.1 4-.7 5.1-3.1Z" />
      </g>
    </svg>
  )
}

export function ProviderLogo({ provider, ...props }: IconProps & { provider: Provider }) {
  const Icon = {
    aws: EksLogo,
    azure: AksLogo,
    gcp: GkeLogo,
  }[provider]

  return <Icon aria-hidden="true" {...props} />
}

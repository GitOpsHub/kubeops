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

function AwsLogo(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" {...props}>
      <path
        fill="#232F3E"
        d="M11.2 25.5c0 2.9 1.8 4.3 4.1 4.3 1.6 0 2.9-.5 3.8-1.7.2.6.4 1 .8 1.5h3.4c-.6-1-.8-2.2-.8-3.5v-6c0-3.6-2.7-5-5.8-5-3.2 0-5.6 1.3-6 4.2l3.2.3c.2-1.3 1.1-1.9 2.6-1.9 1.7 0 2.5.7 2.5 2.2v.8c-4.9.1-7.8 1.5-7.8 4.8Zm7.8-2.4v1.2c0 1.9-1.2 3-2.8 3-1.1 0-1.8-.7-1.8-1.8 0-1.6 1.5-2.3 4.6-2.4Zm7.2 6.5h3.2l1.8-8.6 1.8 8.6h3.2l3.8-14.2h-3.3l-2.1 9.4-1.8-9.4h-2.9L28 24.8l-2.1-9.4h-3.4l3.7 14.2Z"
      />
      <path
        fill="none"
        stroke="#FF9900"
        strokeLinecap="round"
        strokeWidth="2.2"
        d="M10 34c7.8 4.8 18.9 5.2 27.3.9"
      />
      <path fill="#FF9900" d="m35.2 32.5 5.2.1-2.2 4.7-.8-2.3-2.2-2.5Z" />
    </svg>
  )
}

function AzureLogo(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" {...props}>
      <path fill="#0078D4" d="M18.4 7.5h11L18 41H7L18.4 7.5Z" />
      <path fill="#1490DF" d="M30.8 7.5 41 35H23.2l5.5-8.1h7.2L26.4 7.5h4.4Z" />
      <path fill="#0062AD" d="m18 41 10.7-14.1 5.2 14.1H18Z" />
    </svg>
  )
}

function GoogleCloudLogo(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" {...props}>
      <path
        fill="none"
        stroke="#4285F4"
        strokeLinecap="round"
        strokeWidth="7"
        d="M17 35.5h18a8 8 0 0 0 2.1-15.7"
      />
      <path
        fill="none"
        stroke="#34A853"
        strokeLinecap="round"
        strokeWidth="7"
        d="M17 35.5a10 10 0 0 1-8-9.8"
      />
      <path
        fill="none"
        stroke="#FBBC04"
        strokeLinecap="round"
        strokeWidth="7"
        d="M9 25.7a10 10 0 0 1 6-9.2"
      />
      <path
        fill="none"
        stroke="#EA4335"
        strokeLinecap="round"
        strokeWidth="7"
        d="M15 16.5a12 12 0 0 1 20.8 3.3"
      />
    </svg>
  )
}

function DockerLogo(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" {...props}>
      <g fill="#2496ED">
        <path d="M9 20h6v5H9zM16 20h6v5h-6zM23 20h6v5h-6zM16 14h6v5h-6zM23 14h6v5h-6zM30 20h6v5h-6zM23 8h6v5h-6z" />
        <path d="M43 22.2c-1.7-1.1-4.3-.8-5.5-.1-.2-2-1.3-3.8-3.3-5l-1.2 1.8c1.5.9 2.3 2.1 2.4 3.8H6.2c-.4 6.2 1.4 11.1 5.3 14 3.7 2.8 9.5 3.3 15.3 1.2 5.8-2.1 9.7-6.6 11.1-12.6 2.2.1 4-.7 5.1-3.1Z" />
      </g>
    </svg>
  )
}

function MinikubeLogo(props: IconProps) {
  return (
    <svg viewBox="0 0 48 48" {...props}>
      <path fill="#FFC61C" d="M24 3 42 13.5v21L24 45 6 34.5v-21L24 3Z" />
      <path
        fill="#1F2937"
        d="m13 15 6.8 4.2L24 16l4.2 3.2L35 15v18l-6.8-4.2L24 32l-4.2-3.2L13 33V15Zm5.2 7.1v4.3l5.8-3.8 5.8 3.8v-4.3L24 26l-5.8-3.9Z"
      />
    </svg>
  )
}

export function ProviderLogo({ provider, ...props }: IconProps & { provider: Provider }) {
  const Icon = {
    aws: AwsLogo,
    azure: AzureLogo,
    gcp: GoogleCloudLogo,
    docker: DockerLogo,
    minikube: MinikubeLogo,
  }[provider]

  return <Icon aria-hidden="true" {...props} />
}

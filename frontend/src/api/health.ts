import { request } from './client'

export type HealthResponse = {
  service: string
  status: string
  environment: string
}

export function getHealth(signal?: AbortSignal) {
  return request<HealthResponse>('/health', { signal })
}

import { parse, stringify } from 'yaml'

/** Normalizes JSON or YAML API responses into readable Kubernetes YAML. */
export function formatResourceManifest(manifest: string) {
  try {
    return stringify(parse(manifest), { lineWidth: 0 })
  } catch {
    return manifest
  }
}

import type { CloudSource } from '../../api/inventory'
import { ProviderLogo } from '../../components/BrandIcons'
import { Tag } from '../../components/ui/Badge'
import { environmentTone } from '../../lib/status'

const visiblePlatformIds = 2

type Props = {
  ids: string[]
  /** Known sources, by ID; an unknown ID still shows, as itself. */
  sources?: Map<string, CloudSource>
}

/**
 * Platforms read by source name and provider logo; the raw ID, which is what
 * filters and the API use, stays in the title for comparing or copying. An
 * application spread over six platforms stacked six chips and made one row as
 * tall as four, so two are shown and the rest collapse into a counter that
 * names them on hover; the expanded row lists them all.
 */
export function PlatformIds({ ids, sources }: Props) {
  if (ids.length === 0) return <>—</>
  const overflow = ids.slice(visiblePlatformIds)
  const nameOf = (id: string) => sources?.get(id)?.name ?? id
  return (
    <span className="platform-ids">
      {ids.slice(0, visiblePlatformIds).map((id) => {
        const source = sources?.get(id)
        return (
          <Tag key={id} mono={!source} title={source ? `${source.name} · ${id}` : id}>
            {source && <ProviderLogo provider={source.provider} className="platform-logo" />}
            {nameOf(id)}
          </Tag>
        )
      })}
      {overflow.length > 0 && <Tag title={overflow.map(nameOf).join(', ')}>+{overflow.length}</Tag>}
    </span>
  )
}

export function EnvironmentTags({ environments }: { environments: string[] }) {
  if (environments.length === 0) return <>—</>
  return (
    <span className="environment-tags">
      {environments.map((item) => (
        <span
          className={`environment-tag environment-tag--${item}`}
          data-tone={environmentTone(item)}
          key={item}
        >
          {item}
        </span>
      ))}
    </span>
  )
}

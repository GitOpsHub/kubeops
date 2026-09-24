import { Tag } from '../../components/ui/Badge'
import { environmentTone } from '../../lib/status'

const visiblePlatformIds = 2

/**
 * An application spread over six platforms stacked six chips and made one row
 * as tall as four. Two are shown and the rest collapse into a counter that
 * names them on hover; the expanded row lists them all.
 */
export function PlatformIds({ ids }: { ids: string[] }) {
  if (ids.length === 0) return <>—</>
  const overflow = ids.slice(visiblePlatformIds)
  return (
    <span className="platform-ids">
      {ids.slice(0, visiblePlatformIds).map((id) => (
        <Tag key={id} mono title={id}>
          {id}
        </Tag>
      ))}
      {overflow.length > 0 && <Tag title={overflow.join(', ')}>+{overflow.length}</Tag>}
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

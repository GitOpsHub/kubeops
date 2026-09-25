import type { ArgoAppStatus } from '../../api/argo'
import type { ApplicationDeployment } from '../../api/onboarding'
import { DeploymentTargetLogo } from '../../components/DeploymentTargetLogo'
import { StatusDot } from '../../components/ui/StatusDot'
import { ToggleGroup } from '../../components/ui/ToggleGroup'
import { healthTone } from '../../lib/status'
import { isInFlightPhase } from '../argo/operation-phases'

type Props = {
  targets: ApplicationDeployment[]
  statuses: Record<string, ArgoAppStatus | undefined>
  value: string
  onChange: (targetId: string) => void
}

/**
 * The cluster every per-target tab looks at. Each option carries its health
 * as a dot, pulsing while that cluster is mid-sync, so switching is informed.
 */
export function TargetSelector({ targets, statuses, value, onChange }: Props) {
  return (
    <ToggleGroup
      label="Choose a cluster"
      appearance="pills"
      size="sm"
      className="target-switch"
      itemClassName="target-switch-item"
      value={value}
      onChange={onChange}
      options={targets.map((target) => {
        const running = isInFlightPhase(statuses[target.id]?.operation?.phase)
        return {
          value: target.id,
          label: (
            <>
              {target.clusterName}
              <StatusDot
                size="sm"
                plain
                tone={running ? 'info' : healthTone(target.healthStatus)}
                inFlight={running}
              />
            </>
          ),
          icon: <DeploymentTargetLogo target={target} />,
          title: running ? `${target.clusterName} · syncing` : undefined,
        }
      })}
    />
  )
}

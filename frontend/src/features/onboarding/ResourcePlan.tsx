import { ExternalLinkIcon } from '../../components/icons'
import { KubernetesResourceIcon } from '../../components/KubernetesResourceIcon'
import { plural } from '../../lib/format'
import type { PlannedResource } from './onboarding-plan'

/** The planned resources as a table: the authoritative list on the review step. */
export function ResourcePlanTable({ resources }: { resources: PlannedResource[] }) {
  return (
    <div className="wizard-table">
      <table className="data-table" aria-label="Generated Kubernetes resources">
        <thead>
          <tr>
            <th scope="col">Resource</th>
            <th scope="col">Name</th>
          </tr>
        </thead>
        <tbody>
          {resources.map((resource) => (
            <tr key={`${resource.kind}-${resource.name}`}>
              <td>{resource.kind}</td>
              <td className="mono">
                {resource.href ? (
                  <a href={resource.href} target="_blank" rel="noreferrer">
                    {resource.name}
                  </a>
                ) : (
                  resource.name
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type PreviewProps = {
  resources: PlannedResource[] | null
  scope: string
  targetCount: number
  waitingForDefaults: boolean
}

/**
 * The same plan, compact and live beside the form on wide screens, so the
 * operator sees names change as they type rather than only at review.
 */
export function PlanPreview({ resources, scope, targetCount, waitingForDefaults }: PreviewProps) {
  return (
    <aside className="wizard-aside" aria-labelledby="plan-preview-title">
      <header className="wizard-aside-header">
        <h2 id="plan-preview-title">What will be created</h2>
        <p>
          <span className="mono">{scope}</span> ·{' '}
          {targetCount > 0 ? plural(targetCount, 'target cluster') : 'no targets yet'}
        </p>
      </header>
      {resources ? (
        <ul className="plan-list">
          {resources.map((resource) => (
            <li key={`${resource.kind}-${resource.name}`}>
              <span className="plan-list-icon" aria-hidden="true">
                <KubernetesResourceIcon kind={resource.kind} />
              </span>
              <span className="plan-list-copy">
                <span className="plan-list-kind">{resource.kind}</span>
                <span className="plan-list-name mono">
                  {resource.name}
                  {resource.href && <ExternalLinkIcon aria-hidden="true" />}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wizard-placeholder">
          {waitingForDefaults
            ? 'Waiting for the chart defaults…'
            : 'Enter a valid application name to preview the generated resources.'}
        </p>
      )}
    </aside>
  )
}

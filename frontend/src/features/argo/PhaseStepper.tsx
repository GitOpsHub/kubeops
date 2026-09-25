import { CheckIcon, CloseIcon, MinusIcon } from '../../components/icons'
import type { PhaseStep } from './operation-phases'

const stateText: Record<PhaseStep['state'], string> = {
  complete: 'done',
  current: 'in progress',
  upcoming: 'not started',
  failed: 'failed',
  skipped: 'skipped',
}

/**
 * The sync's waves as a track. A connector fills when the step before it
 * completes; the fill is a transform transition, so it plays when a poll
 * brings a new phase and stays still when a poll brings the same one.
 */
export function PhaseStepper({ steps }: { steps: PhaseStep[] }) {
  return (
    <ol className="phase-stepper" aria-label="Sync progress">
      {steps.map((step, index) => (
        <li
          key={step.id}
          className={`phase-step phase-step--${step.state}`}
          aria-current={step.state === 'current' ? 'step' : undefined}
        >
          {index > 0 && (
            <span className="phase-connector" aria-hidden="true">
              <span
                className={
                  step.state === 'upcoming' || step.state === 'current'
                    ? 'phase-connector-fill'
                    : 'phase-connector-fill is-filled'
                }
              />
            </span>
          )}
          <span className="phase-marker" aria-hidden="true">
            {step.state === 'complete' ? (
              <CheckIcon />
            ) : step.state === 'failed' ? (
              <CloseIcon />
            ) : step.state === 'skipped' ? (
              <MinusIcon />
            ) : null}
          </span>
          <span className="phase-copy">
            <span className="phase-label">{step.label}</span>
            {step.detail && <span className="phase-detail">{step.detail}</span>}
            <span className="sr-only">, {stateText[step.state]}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

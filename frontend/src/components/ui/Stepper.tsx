import { CheckIcon } from '../icons'
import './Stepper.css'

export type Step = {
  id: string
  label: string
  description?: string
}

type Props = {
  steps: Step[]
  /** The id of the step in progress. Earlier steps read as complete. */
  current: string
  /** Makes completed steps buttons that go back to them. */
  onStepSelect?: (id: string) => void
  className?: string
}

/** Where a multi-step flow stands: done, current, and still to come. */
export function Stepper({ steps, current, onStepSelect, className = '' }: Props) {
  const currentIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === current),
  )

  return (
    <ol className={`stepper ${className}`.trim()} aria-label="Progress">
      {steps.map((step, index) => {
        const state =
          index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'upcoming'
        const marker = (
          <>
            <span className="stepper-marker" aria-hidden="true">
              {state === 'complete' ? <CheckIcon /> : index + 1}
            </span>
            <span className="stepper-copy">
              <span className="stepper-label">{step.label}</span>
              {step.description && <span className="stepper-description">{step.description}</span>}
              {state === 'complete' && <span className="sr-only"> (completed)</span>}
            </span>
          </>
        )
        return (
          <li
            key={step.id}
            className={`stepper-step stepper-step--${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            {state === 'complete' && onStepSelect ? (
              <button
                type="button"
                className="stepper-button"
                onClick={() => onStepSelect(step.id)}
              >
                {marker}
              </button>
            ) : (
              <span className="stepper-button">{marker}</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

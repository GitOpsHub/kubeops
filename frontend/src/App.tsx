import { useEffect, useState } from 'react'
import { getHealth } from './api/health'

type ApiState = 'checking' | 'connected' | 'unavailable'

function App() {
  const [apiState, setApiState] = useState<ApiState>('checking')

  useEffect(() => {
    const controller = new AbortController()

    getHealth(controller.signal)
      .then(() => setApiState('connected'))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setApiState('unavailable')
        }
      })

    return () => controller.abort()
  }, [])

  return (
    <main>
      <section className="hero">
        <div className="eyebrow">Kubernetes application onboarding</div>
        <h1>Ship applications with a clear path to the cluster.</h1>
        <p className="intro">
          KubeOps will guide teams through deployment configuration, validation, and
          onboarding without hiding the Kubernetes resources they own.
        </p>
        <div className="actions">
          <button type="button">Start onboarding</button>
          <span className={`status status--${apiState}`} role="status">
            <span aria-hidden="true" />
            API {apiState}
          </span>
        </div>
      </section>

      <section className="workflow" aria-labelledby="workflow-title">
        <div>
          <p className="step">01</p>
          <h2 id="workflow-title">Describe</h2>
          <p>Capture the application, ownership, runtime, and deployment requirements.</p>
        </div>
        <div>
          <p className="step">02</p>
          <h2>Validate</h2>
          <p>Check configuration and policies before anything reaches a cluster.</p>
        </div>
        <div>
          <p className="step">03</p>
          <h2>Deploy</h2>
          <p>Generate a reviewable deployment path with visible status and ownership.</p>
        </div>
      </section>
    </main>
  )
}

export default App

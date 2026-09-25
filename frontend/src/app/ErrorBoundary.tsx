import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RetryIcon } from '../components/icons'
import { Button } from '../components/ui/Button'
import { ErrorState } from '../components/ui/ErrorState'

type Props = {
  /** Changing this clears a caught error, e.g. on navigation. */
  resetKey: string
  children: ReactNode
}

type State = { error: Error | null; resetKey: string }

/**
 * Contains a render failure to the page that threw, so the shell and its
 * navigation keep working. A failed lazy-chunk load after a deploy lands here
 * too, which is why the fallback offers a full reload.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page crashed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="page-error">
        {/* ErrorState is the alert; the actions sit outside it so the
            announcement is the failure, not a list of buttons. */}
        <ErrorState
          title="This page failed to render"
          message={this.state.error.message || 'An unexpected error occurred.'}
        />
        <div className="page-error-actions">
          <Button onClick={() => this.setState({ error: null })}>Try again</Button>
          <Button variant="primary" icon={<RetryIcon />} onClick={() => window.location.reload()}>
            Reload page
          </Button>
        </div>
        <p className="page-error-hint">
          The rest of KubeOps still works — pick another page from the sidebar.
        </p>
      </div>
    )
  }
}

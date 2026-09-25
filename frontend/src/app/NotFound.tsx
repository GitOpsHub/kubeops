import { Link, useLocation } from 'react-router-dom'
import { HelpIcon } from '../components/icons'
import { buttonClass } from '../components/ui/button-class'
import { EmptyState } from '../components/ui/EmptyState'

export function NotFound() {
  const { pathname } = useLocation()
  return (
    <section className="page" aria-labelledby="not-found-heading">
      <div className="page-error">
        <EmptyState
          icon={<HelpIcon />}
          titleAs="h1"
          title={<span id="not-found-heading">Page not found</span>}
          description={
            <>
              Nothing lives at <code className="mono">{pathname}</code>. The link may be out of
              date, or the page has moved.
            </>
          }
          action={
            <div className="page-error-actions">
              <Link className={buttonClass('primary')} to="/">
                Go to overview
              </Link>
              <Link className={buttonClass('secondary')} to="/applications">
                View applications
              </Link>
            </div>
          }
        />
      </div>
    </section>
  )
}

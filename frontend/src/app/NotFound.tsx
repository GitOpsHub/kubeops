import { Link } from 'react-router-dom'
import { buttonClass } from '../components/ui/button-class'
import { EmptyState } from '../components/ui/EmptyState'

export function NotFound() {
  return (
    <div className="page-error">
      <EmptyState
        title="Page not found"
        description="The link may be out of date, or the page has moved."
        action={
          <Link className={buttonClass('primary')} to="/">
            Go to overview
          </Link>
        }
      />
    </div>
  )
}

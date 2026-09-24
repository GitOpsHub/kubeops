import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from '../App'

// Every page test mounts the whole app so it exercises the real shell,
// providers, and routing rather than a hand-assembled subset of them.
export function renderApp(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  )
}

import { lazy } from 'react'
import { Route, Routes } from 'react-router-dom'
import { AppShell } from './app/AppShell'
import { NotFound } from './app/NotFound'
import { ToastProvider } from './components/ui/Toast'

// Every page is its own chunk, so the resource graph, the manifest diff, and
// the YAML parser only download when a page that uses them is opened.
const OverviewPage = lazy(() =>
  import('./features/overview/OverviewPage').then((module) => ({ default: module.OverviewPage })),
)
const ClustersPage = lazy(() =>
  import('./features/clusters/ClustersPage').then((module) => ({ default: module.ClustersPage })),
)
const SourcesPage = lazy(() =>
  import('./features/sources/SourcesPage').then((module) => ({ default: module.SourcesPage })),
)
const ApplicationsPage = lazy(() =>
  import('./features/applications/ApplicationsPage').then((module) => ({
    default: module.ApplicationsPage,
  })),
)
const ApplicationDetailPage = lazy(() =>
  import('./features/application-detail/ApplicationDetailPage').then((module) => ({
    default: module.ApplicationDetailPage,
  })),
)
const LogsPage = lazy(() =>
  import('./features/log-viewer/LogsPage').then((module) => ({ default: module.LogsPage })),
)
const OnboardingPage = lazy(() =>
  import('./features/onboarding/OnboardingPage').then((module) => ({
    default: module.OnboardingPage,
  })),
)

function App() {
  // The provider lives here rather than in main.tsx so every test that
  // renders <App /> inside a MemoryRouter gets toasts too.
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="clusters" element={<ClustersPage />} />
          <Route path="sources" element={<SourcesPage />} />
          <Route path="applications" element={<ApplicationsPage />} />
          <Route path="applications/new" element={<OnboardingPage />} />
          <Route path="applications/:id" element={<ApplicationDetailPage />} />
          <Route path="applications/:id/logs" element={<LogsPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </ToastProvider>
  )
}

export default App

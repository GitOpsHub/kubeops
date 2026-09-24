import { lazy } from 'react'
import { Route, Routes } from 'react-router-dom'
import { AppShell } from './app/AppShell'
import { NotFound } from './app/NotFound'

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
const OnboardingPage = lazy(() =>
  import('./features/onboarding/OnboardingPage').then((module) => ({
    default: module.OnboardingPage,
  })),
)

function App() {
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="clusters" element={<ClustersPage />} />
        <Route path="sources" element={<SourcesPage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="applications/new" element={<OnboardingPage />} />
        <Route path="applications/:id" element={<ApplicationDetailPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

export default App

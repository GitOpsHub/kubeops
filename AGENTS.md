# Repository Guidelines

## Project Structure & Module Organization

KubeOps is a monorepo for Kubernetes application onboarding. Keep the React UI in `frontend/` and the Go API in `backend/`.

- `frontend/src/` contains pages, components, hooks, API clients, and styles. Keep tests beside their subjects as `*.test.ts` or `*.test.tsx`; place static files in `frontend/public/`.
- `backend/cmd/` contains entry points; `backend/internal/` contains handlers, services, and Kubernetes integrations. Name Go tests `*_test.go`.
- Put shared Kubernetes manifests in `manifests/` when introduced.

Keep business logic out of React components and HTTP handlers. UI code should use an API client; handlers should delegate to services.

## Build, Test, and Development Commands

Run these commands from the repository root:

- `make dev-frontend` — start the React development server.
- `make dev-backend` — start the Go API.
- `make test` — run frontend and backend tests.
- `make lint` — run ESLint and `go vet`.
- `make build` — build the UI and API.

Run `cd frontend && npm install` after cloning. Copy `.env.example` to the ignored root `.env` for local settings. Never commit Kubernetes credentials.

## Coding Style & Naming Conventions

Use two-space indentation in TypeScript, JavaScript, JSON, and YAML. Name React components in PascalCase (`OnboardingForm.tsx`), hooks with a `use` prefix, and other frontend files in kebab-case. Follow the repository’s ESLint and formatter configuration when added.

Run `gofmt` on all Go code. Use short, lowercase Go package names and exported PascalCase identifiers. Keep Kubernetes resource names lowercase and kebab-case.

## Testing Guidelines

Add tests for new behavior and regressions. Prefer user-visible React assertions and table-driven Go tests. Mock cluster access; tests must not depend on a developer’s active Kubernetes context. Run both suites for API-spanning changes.

## Commit & Pull Request Guidelines

History contains only `Initial commit`; use imperative subjects such as `Add onboarding API endpoint`. Keep commits focused. Pull requests must explain motivation, implementation, validation, configuration changes, and rollout risks. Link issues and include screenshots for UI changes. Never add automated-tool attribution.

## Tooling Notes

For Python utilities, use `uv` rather than `pip`.

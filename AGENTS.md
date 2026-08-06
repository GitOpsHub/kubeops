# Repository Guidelines

## Project Structure & Module Organization

KubeOps is a monorepo for Kubernetes application onboarding and multi-cloud/local cluster inventory. Keep the React UI in `frontend/` and the Go API in `backend/`.

- `frontend/src/` contains pages, components, hooks, API clients, and styles. Keep tests beside their subjects as `*.test.ts` or `*.test.tsx`; place static files in `frontend/public/`.
- `backend/cmd/` contains entry points; `backend/internal/` contains handlers, services, and Kubernetes integrations. Name Go tests `*_test.go`.
- Put shared Kubernetes manifests in `manifests/` when introduced.

Keep business logic out of React components and HTTP handlers. UI code should use an API client; handlers should delegate to services.

## Cloud Authentication

`backend/internal/cloudauth` is the only place that builds cloud provider credentials. Provider code in `backend/internal/provider` must call `cloudauth.AWSConfig`, `cloudauth.GCPClientOptions`, or `cloudauth.AzureCredential` rather than constructing an SDK credential directly, so federation and the fallback chain stay in one place.

Two rules follow from how the identity token is delivered:

- **Never cache the token.** It is short-lived and re-issued per invocation. Read it through a `cloudauth.TokenSource` on every credential refresh.
- **Always thread the request context.** Deployed serverless functions carry the token in the `x-vercel-oidc-token` request header, which `withIdentityToken` moves into the request context. A cloud call made with `context.Background()` silently falls back to the SDK default credential chain instead of failing, so the regression is invisible until a deployment cannot see any clusters.

Sources opt into federation per provider: `role_arn` (AWS), `workload_identity_provider` plus `impersonate_service_account` (GCP), `tenant_id` plus `client_id` (Azure). Credential-bearing fields on `model.CloudSource` are tagged `json:"-"` and must stay that way — the inventory API is unauthenticated.

Never add a static cloud credential to configuration, tests, or fixtures. See the README's *Keyless cloud access* section for the cloud-side trust setup.

## Build, Test, and Development Commands

Run these commands from the repository root:

- `make dev-frontend` — start the React development server.
- `make dev-backend` — start the Go API.
- `make db-up` — start the local PostgreSQL 18 container.
- `make test` — run frontend and backend tests.
- `make test-integration` — verify migrations and inventory lifecycle against PostgreSQL. Runs against a dedicated `kubeops_test` database (created on demand) because the tests truncate every table; they refuse to run against the `kubeops` development database.
- `make lint` — run ESLint and `go vet`.
- `make build` — build the UI and API.

Run `cd frontend && npm install` after cloning. Copy `.env.example` to the ignored root `.env` for local settings. Never commit Kubernetes credentials.

## Coding Style & Naming Conventions

Use two-space indentation in TypeScript, JavaScript, JSON, and YAML. Name React components in PascalCase (`OnboardingForm.tsx`), hooks with a `use` prefix, and other frontend files in kebab-case. Follow the repository’s ESLint and formatter configuration when added.

Run `gofmt` on all Go code. Use short, lowercase Go package names and exported PascalCase identifiers. Keep Kubernetes resource names lowercase and kebab-case.

## Testing Guidelines

Add tests for new behavior and regressions. Prefer user-visible React assertions and table-driven Go tests. Mock cluster access; tests must not depend on a developer’s active Kubernetes context. Run both suites for API-spanning changes.

Tests must not reach a cloud provider. When asserting on credentials, inspect the constructed provider — for example `aws.CredentialsCache.IsCredentialsProvider` — rather than calling `Retrieve`, which issues a real STS request.

## Commit & Pull Request Guidelines

History contains only `Initial commit`; use imperative subjects such as `Add onboarding API endpoint`. Keep commits focused. Pull requests must explain motivation, implementation, validation, configuration changes, and rollout risks. Link issues and include screenshots for UI changes. Never add automated-tool attribution.

## Tooling Notes

For Python utilities, use `uv` rather than `pip`.

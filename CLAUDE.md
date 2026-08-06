# KubeOps

Monorepo for Kubernetes application onboarding and multi-cloud cluster inventory:
React UI in `frontend/`, Go API in `backend/`. See [AGENTS.md](AGENTS.md) for
structure, style, and contribution conventions, and the [README](README.md) for
setup and deployment.

## Commands

Run from the repository root:

```bash
make test
```

- `make dev-backend` / `make dev-frontend` — start the API and UI.
- `make db-up` — start the local PostgreSQL 18 container. The backend will not
  start without it.
- `make test-integration` — migrations and inventory lifecycle against the
  dedicated `kubeops_test` database. It truncates every table and refuses to run
  against the `kubeops` development database.
- `make lint` — ESLint and `go vet`. Run `gofmt` on all Go code.

## Architecture notes

**Clusters are discovered, never registered.** There is no "add a cluster" API.
Operators edit `config/cloud-sources.yaml` (or `CLOUD_SOURCES_YAML` on
serverless), and the syncer polls each provider. No kubeconfig, cluster token, or
cloud credential is ever stored in the database — the only DB secret is the
encrypted Argo CD UI password.

**`backend/internal/cloudauth` owns all cloud credentials.** Provider code calls
`AWSConfig`, `GCPClientOptions`, or `AzureCredential`; it never builds an SDK
credential directly. Deployed environments federate a short-lived OIDC token into
a cloud role, and local development falls back to the `~/.aws`, `gcloud`, and `az`
chains. Two invariants:

- Never cache the identity token — it is re-issued per invocation.
- Always thread the request context into a cloud call. A deployed function
  receives its token in the `x-vercel-oidc-token` header, which
  `withIdentityToken` puts into the request context. Using `context.Background()`
  instead does not error; it silently falls back to the default credential chain,
  so the deployment just sees no clusters.

Never introduce a static cloud credential. Fields on `model.CloudSource` that
carry credential material are tagged `json:"-"` and must stay that way.

**Serverless constraints shape the config layer.** The filesystem is read-only
apart from the temp directory, and the process can be suspended after any
request. Hence the inline `*_YAML` environment variables alongside file paths,
and `BACKGROUND_WORKERS` defaulting to off when `VERCEL` is set — manual syncs
then run synchronously inside their HTTP request.

**The API has no authentication.** The router applies only CORS and request
logging, and the Argo CD reverse proxy injects an admin bearer token for anyone
who can reach it (`backend/internal/httpapi/argoproxy.go`). Treat this as known
and unresolved; do not assume a caller has been authorized.

## Conventions

- Comments explain *why*, not *what*. Match the density of the surrounding file.
- Go tests are table-driven. Tests must never reach a cloud provider — inspect
  the constructed credential provider rather than calling `Retrieve`.
- Do not add automated-tool attribution to commits or pull requests.

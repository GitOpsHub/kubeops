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
Cloud sources and Argo CD targets can come from either `config/cloud-sources.yaml`
/ `config/argo-targets.yaml` (or their `*_YAML` env equivalents) or from the
`cloud_sources` / `argo_targets` database tables; at startup `main.go` merges
both by ID, **database wins on conflict**. YAML stays the natural way to
configure local-dev-only sources (`docker-desktop`, `minikube`) that have no
business in a shared database; the database is how a shared/production
cloud source or a cluster's Argo CD access gets added without a redeploy —
insert a `cloud_sources` row directly (its federation columns are identifiers,
not credentials) or run `backend/cmd/seed-argo-target` (it encrypts the Argo
API token/UI password before writing `argo_targets`). There is deliberately no
HTTP endpoint for either table — the API has no authentication. The syncer
still just polls whatever providers this merged set names; no kubeconfig,
cluster token, or cloud credential is ever stored in the database. DB secrets
today: the encrypted Argo CD UI password (`argo_cluster_access`), and the
encrypted Argo API token/UI password in `argo_targets`.

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

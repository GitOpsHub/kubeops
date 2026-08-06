# KubeOps

KubeOps inventories managed Kubernetes clusters across AWS EKS, Google GKE, Azure AKS, and local Docker or Minikube environments. A Go service polls configured sources every five minutes, stores normalized inventory and sync history in PostgreSQL, and serves a React dashboard.

## Repository layout

- `frontend/` — React, TypeScript, and Vite dashboard
- `backend/` — Go API, cloud providers, scheduler, migrations, and PostgreSQL store
- `config/` — cloud source examples; credentials are never stored here
- `.github/` — CI and contribution templates

## Local development

Prerequisites: Node.js 22.12+, npm, Go 1.26+, Docker, `kubectl`, Helm,
the Argo CD CLI, and OpenSSL. Local application onboarding expects the
`docker-desktop` and `minikube` kubeconfig contexts by default.

```sh
cp .env.example .env
cd frontend && npm install
cd ..
make dev
```

`make dev` starts PostgreSQL, installs or upgrades Argo CD in both local
clusters, creates scoped KubeOps API tokens and verified local TLS endpoints,
creates separate `kubeops` UI login passwords, generates the ignored
`config/argo-targets.yaml`, and runs the API, UI, and Argo port-forwards
together. Cluster details include an **Open Argo CD** link and a password-copy
control. Press Ctrl-C to stop the local processes. Override the defaults with
`KUBEOPS_DOCKER_CONTEXT`, `KUBEOPS_MINIKUBE_CONTEXT`,
`KUBEOPS_DOCKER_ARGO_PORT`, or `KUBEOPS_MINIKUBE_ARGO_PORT`.

Argo CD is reached over `kubectl` port-forwards on localhost, one per target
in `config/argo-targets.yaml`: `18081` for docker-desktop and `18082` for
minikube. Remote clusters are opt-in — set `KUBEOPS_GKE_CONTEXT` or
`KUBEOPS_AKS_CONTEXT` in `.env` (with optional `KUBEOPS_GKE_ARGO_PORT` and
`KUBEOPS_AKS_ARGO_PORT`, default `18083` and `18084`) to forward a GKE or AKS
Argo CD as well. A target whose kube context is missing is skipped rather than
failing the others. `make dev` supervises the forwards and restarts any that
drop, so a laptop suspend or a rescheduled Argo CD server pod no longer leaves
every Argo CD operation failing with connection refused.

To discard and recreate the complete local environment, run:

```sh
make dev-recreate
```

This is destructive: it removes the PostgreSQL volume and all stored data,
resets the Docker Desktop Kubernetes cluster, and deletes the configured
Minikube profile before recreating both clusters and rerunning `dev-setup`.
It does not modify remote Kubernetes contexts such as GKE. Set
`KUBEOPS_MINIKUBE_CONTEXT` when the Minikube profile is not named `minikube`.
Use `make db-destroy` when only the local PostgreSQL data should be discarded.

Set `ARGO_GITHUB_READ_TOKEN` to a dedicated read-only GitHub token when Argo CD
must clone private `GitOpsHub` values repositories or pull the private GHCR Helm
chart. Set `GITHUB_REPOSITORY_USERNAME` to the GitHub username associated with
that token. The setup intentionally does not copy a broad GitHub CLI credential
into either cluster.

Set the desired sources to `enabled: true`. Locally, authentication uses each provider’s standard credential chain:

- AWS default credentials, optionally assuming `role_arn`
- Google Application Default Credentials, optionally impersonating a service account
- Azure `DefaultAzureCredential`, optionally scoped with `tenant_id`
- Docker Desktop, kind, k3d, and Minikube through the configured kubeconfig

Deployed environments federate an OIDC token into a cloud role instead, so no
provider key is stored — see [Keyless cloud access](#keyless-cloud-access). The
fallback above is what keeps local development working unchanged. To exercise the
federated path locally, run `vercel env pull` and copy the `VERCEL_OIDC_TOKEN` it
writes into `.env.local` across to `.env`, which is the file the backend reads.
Development tokens are valid for twelve hours, and their `sub` ends in
`:environment:development`, so the cloud trust policies need an entry for that
environment too.

Local providers default to `~/.kube/config`. Docker discovery recognizes `docker-desktop`, `docker-for-desktop`, `kind-*`, and `k3d-*` contexts; Minikube recognizes `minikube`, `minikube-*`, and Minikube certificate paths. Set `contexts` explicitly when profiles use custom names.

To run only one application process:

```sh
make dev-backend
make dev-frontend
```

These start no port-forwards, so Argo CD is unreachable and onboarding, sync,
and resource views fail with connection refused until the forwards are running.
Start and manage them separately:

```sh
make argo-forward          # start the supervised forwards (safe to re-run)
make argo-forward-status   # show which targets are reachable
make argo-forward-stop     # tear them down
```

`make argo-forward` waits for each Argo CD endpoint to answer before reporting
success and writes per-target logs to the ignored `.dev/argo-forwards/`
directory. `make dev` manages the same forwards on its own, so the targets above
are only needed when the API runs outside it.

Open `http://localhost:5173`. Database migrations run automatically when the API starts.

## Validation

```sh
make test
make test-integration
make lint
make build
```

`make test-integration` truncates every table, so it runs against a dedicated
`kubeops_test` database that the target creates in the local PostgreSQL
container when it is missing. The tests abort unless `TEST_DATABASE_URL` names a
database ending in `_test` and different from `DATABASE_URL`, which keeps them
from wiping local development data. Override with
`KUBEOPS_ALLOW_DESTRUCTIVE_TESTS=1` only when the target database is disposable.

The root `.env`, `config/cloud-sources.yaml`, and `config/argo-targets.yaml`
are ignored. Only variables prefixed with `VITE_` are exposed to browser code;
never place secrets in them.

## Vercel deployment

The frontend and backend deploy as separate Vercel projects from this monorepo.
Set their project root directories to `frontend` and `backend`, respectively.
The frontend configuration enables Vite builds and SPA history fallback; the
backend uses Vercel's native Go server detection and listens on Vercel's `PORT`.

Configure the frontend project with:

```text
VITE_API_BASE_URL=https://<backend-domain>/api
```

Configure the backend project with its runtime variables from `.env`, replacing
local URLs and paths with production values. At minimum it requires
`DATABASE_URL`, `BACKEND_HOST=0.0.0.0`, `PUBLIC_BASE_URL`, and
`CORS_ALLOWED_ORIGIN=https://<frontend-domain>`. Vercel supplies `PORT`; do not
create that variable manually. Environment variable changes require a new
deployment.

Vercel automatically disables the continuous inventory and onboarding workers.
Manual inventory syncs execute completely inside the initiating HTTP request.
Because ignored local YAML files are not available in a Git deployment, set
`CLOUD_SOURCES_YAML` and `ARGO_TARGETS_YAML` to the contents of their respective
configuration files, and set `GLOBAL_HELM_DEFAULT_VALUES_YAML` when the chart
defaults file is outside the backend project root. Keep the token variables
referenced by `ARGO_TARGETS_YAML` as separate encrypted environment variables.
Only configure cloud and Argo CD endpoints reachable from Vercel; Docker Desktop,
Minikube, localhost URLs, and local kubeconfig files cannot be used there.

Every provider named by an enabled source also needs a way to authenticate,
because the provider SDKs fall back to local `aws`, `gcloud`, and `az` profiles
that do not exist on Vercel. An enabled source that cannot authenticate leaves
the fleet view empty and fails its syncs. The supported answer is OIDC workload
identity federation, described below; long-lived provider keys still work but
should be treated as a migration path rather than a destination.

### Keyless cloud access

Vercel mints a short-lived OIDC identity token for every deployment and
invocation. KubeOps exchanges it for temporary provider credentials, so each
cloud grants access to a **role** that trusts the Vercel issuer instead of to a
secret stored in the environment. Nothing is cached: the token is re-read on
every credential refresh.

Enable **Secure Backend Access with OIDC Federation** in the Vercel project
settings, then register the same issuer, subject, and audience with each cloud.

| Claim | Value |
| --- | --- |
| `iss` | `https://oidc.vercel.com/<team-slug>` in **team** issuer mode, or `https://oidc.vercel.com` in **global** mode. The project's OIDC settings decide which. |
| `sub` | `owner:<team-slug>:project:<project-name>:environment:production`. Register a second trust entry for `environment:preview` if preview deployments must reach the clouds. |
| `aud` | `https://vercel.com/<team-slug>`. |

KubeOps presents the **default audience** to all three clouds. Vercel can mint a
token with a custom `aud`, but only through the `@vercel/oidc` npm helper, which
a Go backend cannot use — so configure each cloud to accept the default value
rather than the provider-recommended one.

| Cloud | Trust setup | Source fields | Permissions |
| --- | --- | --- | --- |
| AWS | Create an IAM OIDC identity provider for the issuer, then a role whose trust policy allows `sts:AssumeRoleWithWebIdentity` with `StringEquals` conditions on both `<issuer-host>:aud` and `<issuer-host>:sub` | `role_arn` | `eks:ListClusters`, `eks:DescribeCluster`, `eks:ListNodegroups`, `eks:DescribeNodegroup`; add `eks:UpdateNodegroupConfig` to scale |
| Google | Create a workload identity pool and an OIDC provider: **Issuer URL** as above, **Allowed audiences** set to `https://vercel.com/<team-slug>` (not *Default audience*, which would require a custom `aud`), and the attribute mapping `google.subject = assertion.sub`. Then grant the pool principal `principal://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/<pool>/subject/<sub>` the Workload Identity User role on the target service account | `workload_identity_provider`, `impersonate_service_account` | Service account needs `roles/container.viewer`; `roles/container.developer` to scale |
| Azure | On an app registration or user-assigned managed identity, add a federated credential with scenario **Other**, **Issuer** as above, **Subject identifier** set to the exact `sub`, and **Audience** set to `https://vercel.com/<team-slug>`. Azure does not support partial claim matching, so add one credential per environment | `tenant_id`, `client_id` | `Reader` on the subscription; `Azure Kubernetes Service Contributor` to scale |

`workload_identity_provider` is the pool provider's full resource name,
`//iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`.

Set `CLOUD_IDENTITY_MODE` to `auto` (the default) to federate whenever the
platform supplies a token and otherwise fall back to the SDK default chains,
`vercel` to always use Vercel's token, or `off` to disable federation entirely.
Set `CLOUD_IDENTITY_AUDIENCE` to the audience above; it is reported in the
startup log so a trust policy mismatch is visible without a failed sync. Each
enabled source also logs whether it resolved to `federated` or `default-chain`.

Once federation is verified, delete `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, and `GOOGLE_APPLICATION_CREDENTIALS_JSON`
from the Vercel project.

#### Where the token comes from

The token reaches the backend by two different routes, and both are handled:

- **Deployed functions** receive it as the `x-vercel-oidc-token` **request
  header**. `VERCEL_OIDC_TOKEN` is *not* set at runtime. `withIdentityToken` in
  `backend/internal/httpapi/handler.go` moves the header into the request
  context, and the credential builders read it from there. This is why the
  handler chain matters: a code path that reaches a cloud provider without a
  request context falls back to the default chain.
- **Builds and local development** receive it as the `VERCEL_OIDC_TOKEN`
  environment variable, which is what `vercel env pull` writes.

Token lifetimes are set by Vercel: one hour for build tokens, two hours for
`preview` and `production` function tokens, and twelve hours for `development`
tokens.

Because background workers have no request context, they can only federate from
the environment variable. That is consistent with `BACKGROUND_WORKERS`
defaulting to off on Vercel — syncs there run inside a request, which carries
the header.

### Static credentials (fallback)

Sources without federation configured use each provider's standard credential
chain, which on Vercel means these variables.

| Provider | Variables |
| --- | --- |
| AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` |
| Azure | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` |
| Google | `GOOGLE_APPLICATION_CREDENTIALS_JSON` |

Google's SDK reads credentials from a file rather than an environment variable,
so the backend writes `GOOGLE_APPLICATION_CREDENTIALS_JSON` to the temporary
directory at startup and points `GOOGLE_APPLICATION_CREDENTIALS` at it. Set it to
a service account key or to a Workload Identity Federation external account
configuration. Leave the variable unset to keep an externally provided
`GOOGLE_APPLICATION_CREDENTIALS` path in effect; sources that set
`workload_identity_provider` bypass this file entirely.

Set `BACKGROUND_WORKERS=true` only on an always-running backend. Such a worker
must use the same authoritative source configuration as the API, and local
development should use a separate database from production.

GitHub Actions runs tests for pull requests and creates production deployments
for pushes to `main`, after both test jobs pass. Create a GitHub Actions
environment named `production`, then add these environment secrets under
**Settings > Environments > production**:

- `VERCEL_TOKEN` — a Vercel access token that can deploy both projects
- `VERCEL_ORG_ID` — the Vercel team or account ID owning both projects
- `VERCEL_BACKEND_PROJECT_ID` — the backend Vercel project ID
- `VERCEL_FRONTEND_PROJECT_ID` — the frontend Vercel project ID

The IDs are available in each project's Vercel settings or in
`.vercel/project.json` after running `vercel link` locally. Keep `.vercel/`
uncommitted. If the projects remain connected to Vercel's Git integration,
disable its automatic deployments to avoid producing a second deployment for
every GitHub Actions run.

## Application onboarding

The reusable global chart lives in [`charts/kubeops`](charts/kubeops) and is
published by [`.github/workflows/helm-chart.yml`](.github/workflows/helm-chart.yml)
to the OCI repository `ghcr.io/gitopshub/charts/kubeops`. Its core is
cloud-neutral, with opt-in blocks for EKS, GKE and AKS ingress, storage,
workload identity and secret management; see the
[chart README](charts/kubeops/README.md) for the per-platform profiles.

Validate a chart change before pushing it:

```sh
./scripts/validate-helm-chart.sh
```

To publish version `1.1.0`, create and push the matching `helm-v1.1.0` Git tag.
The workflow rejects a tag that does not match `version` in `Chart.yaml`.

```sh
git tag helm-v1.1.0
git push origin helm-v1.1.0
helm pull oci://ghcr.io/gitopshub/charts/kubeops --version 1.1.0
```

The workflow authenticates with the job's `GITHUB_TOKEN`, which only carries a
write role on packages that are linked to this repository. A package that was
first pushed from a workstation (or from another repository) has no such link,
so `helm push` fails with a bare `403 Forbidden` on a blob `HEAD` request. Fix
it once, as an organization package administrator, at
[the package's settings page](https://github.com/orgs/GitOpsHub/packages/container/charts%2Fkubeops/settings):
under **Manage Actions access**, add `GitOpsHub/kubeops` with the **Write**
role. Packages that CI creates itself are linked automatically and never need
this.

GitHub Container Registry creates new packages as private by default. An
organization package administrator must change the package visibility to
**Public** once after its first publication if anonymous Argo CD access is
required. Keeping it private is also supported — `scripts/setup-local-argocd.sh`
provisions the `kubeops-ghcr-helm-creds` repository secret so Argo CD can pull
with credentials. Configure the fixed chart name, revision, and matching local defaults
file in `.env`.

`GLOBAL_HELM_REVISION` is the chart version new onboardings are pinned to; it is
`1.1.0`. Each application records the revision it was onboarded with, so raising
this value changes what the next onboarding gets and leaves existing
applications where they are. Move one of those by editing the chart revision on
its Argo CD Application. Set `GITHUB_TOKEN`
to a PAT authorized for the `GitOpsHub` organization and private repository
creation (`repo` for a classic PAT; `delete_repo` is recommended for compensation
cleanup). A GitHub App ID, installation ID, and private-key file remain supported
as an alternative. KubeOps uses the credential to create a private
`GitOpsHub/<application-name>` repository and commit its root `values.yaml`. Add one
entry to `config/argo-targets.yaml` for each inventory cluster, keyed by its cloud
source ID and provider resource ID. Store each Argo CD bearer token only in the
environment variable named by that target. Optional private CA bundles are
supported; TLS verification cannot be disabled.

Targets may also configure `ui_url`, `username`, and `password_env`. KubeOps
encrypts the password with AES-256-GCM before storing it in PostgreSQL; set
`ARGO_CREDENTIAL_ENCRYPTION_KEY` to a base64-encoded 32-byte key. The cluster
details drawer retrieves the password only from the dedicated access endpoint.
Keep the API restricted to the trusted internal network because this version
does not include authentication or RBAC.

The UI uses browser history routes: `/` for the fleet inventory, `/applications` for the
searchable onboarded-application list (filters are kept in the URL query string),
`/applications/new` for the onboarding form, and `/applications/{id}` for one application's
deployment targets. Production static hosting must rewrite unknown application routes to
`index.html`; the Vite dev server already does. Each target links to its specific Argo CD
Application and copies the cluster's Argo CD password straight to the clipboard on request —
the password is never fetched until then and is never rendered.

The onboarding view creates one Argo CD Application per selected cluster with
automated sync, pruning, self-healing, and namespace creation enabled. Argo uses
the OCI chart plus `$values/values.yaml` from the private application
repository. For production, configure a separate read-only GitHub App credential
template in every Argo instance for `https://github.com/GitOpsHub`. KubeOps stores the initial
commit SHA and values digest, but not the values contents. Values must refer to
existing Kubernetes or external secrets instead of containing secret material.
When a values repository already exists, onboarding reuses its current
`values.yaml`, revision, and commit instead of overwriting it. Offboarding removes
the Argo CD Application and its managed cluster resources while preserving the
GitHub repository for a later re-onboarding.

## Inventory API

- `GET /api/clusters` — filter and paginate cluster inventory
- `GET /api/clusters/{id}/details` — load live node-pool and networking details
- `GET /api/clusters/{id}/argo-access` — load configured Argo CD UI access
- `POST /api/clusters/{id}/node-pools/{pool}/scale` — set a managed node pool's desired size
- `GET /api/cloud-sources` — source counts and latest status
- `GET /api/sync-runs` — recent reconciliation history
- `POST /api/cloud-sources/{id}/sync` — queue a source refresh
- `POST /api/application-onboardings` — create Argo CD Applications for selected clusters
- `POST /api/application-onboardings/{id}/sync` — recreate missing Argo CD Applications and sync every target
- `POST /api/application-onboardings/{id}/offboard` — remove every target from its cluster while preserving GitHub values
- `GET /api/application-onboardings` — page, search, and filter onboarded applications with
  `page`, `pageSize`, `search` (case-insensitive over name and namespace), and `status`
  (`progressing`, `healthy`, `partial`, or `failed`); the legacy `limit` parameter remains
  supported as a page-size alias
- `GET /api/application-onboardings/{id}` — load per-cluster sync and health status
- `GET /api/health` and `GET /api/ready` — liveness and database readiness

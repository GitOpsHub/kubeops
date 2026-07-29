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

Set the desired sources to `enabled: true`. Authentication uses each provider’s standard credential chain:

- AWS default credentials, optionally assuming `role_arn`
- Google Application Default Credentials, optionally impersonating a service account
- Azure `DefaultAzureCredential`, optionally scoped with `tenant_id`
- Docker Desktop, kind, k3d, and Minikube through the configured kubeconfig

Local providers default to `~/.kube/config`. Docker discovery recognizes `docker-desktop`, `docker-for-desktop`, `kind-*`, and `k3d-*` contexts; Minikube recognizes `minikube`, `minikube-*`, and Minikube certificate paths. Set `contexts` explicitly when profiles use custom names.

To run only one application process:

```sh
make dev-backend
make dev-frontend
```

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

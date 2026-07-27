# KubeOps

KubeOps inventories managed Kubernetes clusters across AWS EKS, Google GKE, Azure AKS, and local Docker or Minikube environments. A Go service polls configured sources every five minutes, stores normalized inventory and sync history in PostgreSQL, and serves a React dashboard.

## Repository layout

- `frontend/` — React, TypeScript, and Vite dashboard
- `backend/` — Go API, cloud providers, scheduler, migrations, and PostgreSQL store
- `config/` — cloud source examples; credentials are never stored here
- `.github/` — CI and contribution templates

## Local development

Prerequisites: Node.js 22.12+, npm, Go 1.26+, and Docker.

```sh
cp .env.example .env
cp config/cloud-sources.example.yaml config/cloud-sources.yaml
cp config/argo-targets.example.yaml config/argo-targets.yaml
cd frontend && npm install
cd ..
make db-up
```

Set the desired sources to `enabled: true`. Authentication uses each provider’s standard credential chain:

- AWS default credentials, optionally assuming `role_arn`
- Google Application Default Credentials, optionally impersonating a service account
- Azure `DefaultAzureCredential`, optionally scoped with `tenant_id`
- Docker Desktop, kind, k3d, and Minikube through the configured kubeconfig

Local providers default to `~/.kube/config`. Docker discovery recognizes `docker-desktop`, `docker-for-desktop`, `kind-*`, and `k3d-*` contexts; Minikube recognizes `minikube`, `minikube-*`, and Minikube certificate paths. Set `contexts` explicitly when profiles use custom names.

Run the API and UI in separate terminals:

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

The root `.env`, `config/cloud-sources.yaml`, and `config/argo-targets.yaml`
are ignored. Only variables prefixed with `VITE_` are exposed to browser code;
never place secrets in them.

## Application onboarding

The default global chart is published from `charts/kubeops` to the public OCI
repository `ghcr.io/gitopshub/charts/kubeops:0.0.1`. Configure its fixed chart
name, revision, and matching local defaults file in `.env`. Set `GITHUB_TOKEN`
to a PAT authorized for the `GitOpsHub` organization and private repository
creation (`repo` for a classic PAT; `delete_repo` is recommended for compensation
cleanup). A GitHub App ID, installation ID, and private-key file remain supported
as an alternative. KubeOps uses the credential to create a private
`GitOpsHub/<application-name>` repository and commit its root `values.yaml`. Add one
entry to `config/argo-targets.yaml` for each inventory cluster, keyed by its cloud
source ID and provider resource ID. Store each Argo CD bearer token only in the
environment variable named by that target. Optional private CA bundles are
supported; TLS verification cannot be disabled.

The onboarding view creates one Argo CD Application per selected cluster with
automated sync, pruning, self-healing, and namespace creation enabled. Argo uses
the public OCI chart plus `$values/values.yaml` from the private application
repository. Configure a separate read-only GitHub App credential template in
every Argo instance for `https://github.com/GitOpsHub`. KubeOps stores the initial
commit SHA and values digest, but not the values contents. Values must refer to
existing Kubernetes or external secrets instead of containing secret material.

## Inventory API

- `GET /api/clusters` — filter and paginate cluster inventory
- `GET /api/clusters/{id}/details` — load live node-pool and networking details
- `POST /api/clusters/{id}/node-pools/{pool}/scale` — set a managed node pool's desired size
- `GET /api/cloud-sources` — source counts and latest status
- `GET /api/sync-runs` — recent reconciliation history
- `POST /api/cloud-sources/{id}/sync` — queue a source refresh
- `POST /api/application-onboardings` — create Argo CD Applications for selected clusters
- `GET /api/application-onboardings` — list recent onboarding status
- `GET /api/application-onboardings/{id}` — load per-cluster sync and health status
- `GET /api/health` and `GET /api/ready` — liveness and database readiness

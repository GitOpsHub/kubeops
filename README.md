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

The root `.env` and `config/cloud-sources.yaml` are ignored. Only variables prefixed with `VITE_` are exposed to browser code; never place secrets in them.

## Inventory API

- `GET /api/clusters` — filter and paginate cluster inventory
- `GET /api/clusters/{id}/details` — load live node-pool and networking details
- `POST /api/clusters/{id}/node-pools/{pool}/scale` — set a managed node pool's desired size
- `GET /api/cloud-sources` — source counts and latest status
- `GET /api/sync-runs` — recent reconciliation history
- `POST /api/cloud-sources/{id}/sync` — queue a source refresh
- `GET /api/health` and `GET /api/ready` — liveness and database readiness

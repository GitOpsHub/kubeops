# KubeOps

KubeOps is a React and Go application for onboarding applications to Kubernetes deployments.

## Repository layout

- `frontend/` — React, TypeScript, and Vite user interface
- `backend/` — Go HTTP API and Kubernetes integration boundary
- `.github/` — CI, dependency updates, and contribution templates

## Prerequisites

- Node.js 22.12 or newer and npm
- Go 1.26 or newer

## Local development

Copy the safe development defaults and install UI dependencies:

```sh
cp .env.example .env
cd frontend && npm install
```

Run the backend and frontend in separate terminals from the repository root:

```sh
make dev-backend
make dev-frontend
```

Open `http://localhost:5173`. The API listens on `http://127.0.0.1:8080`.

## Validation

```sh
make test
make lint
make build
```

The root `.env` is intentionally ignored. Only variables prefixed with `VITE_` are exposed to browser code; never store secrets in those variables.

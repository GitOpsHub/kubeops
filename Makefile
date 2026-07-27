.PHONY: db-up db-down dev dev-setup dev-argocd dev-frontend dev-backend test test-integration lint build

db-up:
	docker compose up -d postgres

db-down:
	docker compose down

dev: dev-setup
	./scripts/dev-local.sh

dev-setup: db-up dev-argocd

dev-argocd:
	./scripts/setup-local-argocd.sh

dev-frontend:
	cd frontend && npm run dev

dev-backend:
	cd backend && go run ./cmd/server

test:
	cd frontend && npm test
	cd backend && go test ./...

test-integration:
	cd backend && TEST_DATABASE_URL=postgres://kubeops:kubeops@127.0.0.1:5432/kubeops?sslmode=disable go test ./internal/store -run TestInventoryLifecycle -count=1

lint:
	cd frontend && npm run lint
	cd backend && go vet ./...

build:
	cd frontend && npm run build
	cd backend && go build -o bin/kubeops ./cmd/server

.PHONY: db-up db-down db-destroy dev dev-setup dev-recreate dev-argocd argo-forward argo-forward-stop argo-forward-status dev-frontend dev-backend test test-db test-integration test-chart lint build

# Integration tests TRUNCATE every table, so they run against their own
# database rather than the `kubeops` database the local dev stack uses.
TEST_DB_NAME ?= kubeops_test
TEST_DATABASE_URL ?= postgres://kubeops:kubeops@127.0.0.1:5432/$(TEST_DB_NAME)?sslmode=disable

db-up:
	docker compose up -d postgres

db-down:
	docker compose down

db-destroy:
	docker compose down --volumes --remove-orphans

dev: dev-setup
	./scripts/dev-local.sh

dev-setup: db-up dev-argocd

# Argo CD port-forwards on their own, for when the API runs outside `make dev`.
argo-forward:
	./scripts/argo-port-forward.sh start

argo-forward-stop:
	./scripts/argo-port-forward.sh stop

argo-forward-status:
	./scripts/argo-port-forward.sh status

dev-recreate:
	$(MAKE) db-destroy
	docker desktop kubernetes reset-cluster
	minikube delete --profile "$${KUBEOPS_MINIKUBE_CONTEXT:-minikube}"
	minikube start --profile "$${KUBEOPS_MINIKUBE_CONTEXT:-minikube}" --driver=docker
	$(MAKE) dev-setup

dev-argocd:
	./scripts/setup-local-argocd.sh

dev-frontend:
	cd frontend && npm run dev

dev-backend:
	cd backend && go run ./cmd/server

test:
	cd frontend && npm test
	cd backend && go test ./...

test-db: db-up
	@for i in $$(seq 30); do \
		docker compose exec -T postgres pg_isready -U kubeops -q && exit 0; \
		sleep 1; \
	done; \
	echo "postgres did not become ready" >&2; exit 1
	@docker compose exec -T postgres psql -U kubeops -d postgres -tAc \
		"SELECT 1 FROM pg_database WHERE datname = '$(TEST_DB_NAME)'" | grep -q 1 \
		|| docker compose exec -T postgres createdb -U kubeops $(TEST_DB_NAME)

test-integration: test-db
	cd backend && TEST_DATABASE_URL='$(TEST_DATABASE_URL)' go test ./internal/store -run 'TestInventoryLifecycle|TestGetKubespinArgoDetails|TestArgoTargetsAndCloudSourcesConfigRoundTrip' -count=1

# Lints and renders every platform profile in charts/kubeops/ci, validates the
# result against the Kubernetes API schemas, and asserts the chart still rejects
# the unworkable value combinations in ci/invalid.
test-chart:
	./scripts/validate-helm-chart.sh

lint:
	cd frontend && npm run lint
	cd backend && go vet ./...

build:
	cd frontend && npm run build
	cd backend && go build -o bin/kubeops ./cmd/server

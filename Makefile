.PHONY: dev-frontend dev-backend test lint build

dev-frontend:
	cd frontend && npm run dev

dev-backend:
	cd backend && go run ./cmd/server

test:
	cd frontend && npm test
	cd backend && go test ./...

lint:
	cd frontend && npm run lint
	cd backend && go vet ./...

build:
	cd frontend && npm run build
	cd backend && go build -o bin/kubeops ./cmd/server

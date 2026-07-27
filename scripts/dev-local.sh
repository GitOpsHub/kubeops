#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_CONTEXT="${KUBEOPS_DOCKER_CONTEXT:-docker-desktop}"
MINIKUBE_CONTEXT="${KUBEOPS_MINIKUBE_CONTEXT:-minikube}"
DOCKER_PORT="${KUBEOPS_DOCKER_ARGO_PORT:-18081}"
MINIKUBE_PORT="${KUBEOPS_MINIKUBE_ARGO_PORT:-18082}"
ARGO_NAMESPACE="${KUBEOPS_ARGO_NAMESPACE:-argo-cd}"
ARGO_RELEASE="${KUBEOPS_ARGO_RELEASE:-argo-cd}"
PIDS=()

cleanup() {
  local pid
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

start_process() {
  "$@" &
  PIDS+=("$!")
}

github_token="${GITHUB_TOKEN:-}"
if [[ -z "$github_token" ]] && command -v gh >/dev/null 2>&1; then
  github_token="$(gh auth token -h github.com 2>/dev/null || true)"
fi

cd "$ROOT_DIR"
start_process kubectl --context "$DOCKER_CONTEXT" -n "$ARGO_NAMESPACE" \
  port-forward "service/$ARGO_RELEASE-argocd-server" "$DOCKER_PORT:443" \
  --address 127.0.0.1
start_process kubectl --context "$MINIKUBE_CONTEXT" -n "$ARGO_NAMESPACE" \
  port-forward "service/$ARGO_RELEASE-argocd-server" "$MINIKUBE_PORT:443" \
  --address 127.0.0.1
start_process env GITHUB_TOKEN="$github_token" make dev-backend
start_process make dev-frontend

echo "KubeOps frontend: http://localhost:5173"
echo "KubeOps backend:  http://localhost:8080"
echo "Press Ctrl-C to stop all local services."

while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      exit $?
    fi
  done
  sleep 1
done

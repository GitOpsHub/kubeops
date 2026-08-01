#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
DOCKER_CONTEXT="${KUBEOPS_DOCKER_CONTEXT:-docker-desktop}"
MINIKUBE_CONTEXT="${KUBEOPS_MINIKUBE_CONTEXT:-minikube}"
DOCKER_PORT="${KUBEOPS_DOCKER_ARGO_PORT:-18081}"
MINIKUBE_PORT="${KUBEOPS_MINIKUBE_ARGO_PORT:-18082}"
ARGO_NAMESPACE="${KUBEOPS_ARGO_NAMESPACE:-argo-cd}"
ARGO_RELEASE="${KUBEOPS_ARGO_RELEASE:-argo-cd}"
PIDS=()

env_value() {
  local key="$1"
  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[\"'\'']|[\"'\'']$/, "", value)
      print value
      exit
    }
  ' "$ENV_FILE"
}

GKE_CONTEXT="${KUBEOPS_GKE_CONTEXT:-$(env_value KUBEOPS_GKE_CONTEXT)}"
GKE_PORT="${KUBEOPS_GKE_ARGO_PORT:-$(env_value KUBEOPS_GKE_ARGO_PORT)}"
GKE_PORT="${GKE_PORT:-18083}"
AKS_CONTEXT="${KUBEOPS_AKS_CONTEXT:-$(env_value KUBEOPS_AKS_CONTEXT)}"
AKS_PORT="${KUBEOPS_AKS_ARGO_PORT:-$(env_value KUBEOPS_AKS_ARGO_PORT)}"
AKS_PORT="${AKS_PORT:-18084}"

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
# Supervised forwards: a dropped connection restarts itself instead of silently
# leaving every Argo CD call in the session failing with "connection refused".
KUBEOPS_DOCKER_CONTEXT="$DOCKER_CONTEXT" \
  KUBEOPS_MINIKUBE_CONTEXT="$MINIKUBE_CONTEXT" \
  KUBEOPS_DOCKER_ARGO_PORT="$DOCKER_PORT" \
  KUBEOPS_MINIKUBE_ARGO_PORT="$MINIKUBE_PORT" \
  KUBEOPS_GKE_CONTEXT="$GKE_CONTEXT" KUBEOPS_GKE_ARGO_PORT="$GKE_PORT" \
  KUBEOPS_AKS_CONTEXT="$AKS_CONTEXT" KUBEOPS_AKS_ARGO_PORT="$AKS_PORT" \
  KUBEOPS_ARGO_NAMESPACE="$ARGO_NAMESPACE" KUBEOPS_ARGO_RELEASE="$ARGO_RELEASE" \
  ./scripts/argo-port-forward.sh start
trap 'cleanup; ./scripts/argo-port-forward.sh stop >/dev/null 2>&1 || true' EXIT INT TERM
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

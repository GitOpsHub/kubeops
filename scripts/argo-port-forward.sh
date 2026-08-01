#!/usr/bin/env bash

# Keeps the local Argo CD port-forwards alive.
#
# `kubectl port-forward` exits on its own whenever the API server drops the
# connection — a laptop sleeping, a cluster control plane restarting, or an Argo
# CD server pod being rescheduled all kill it. A one-shot forward therefore goes
# quiet after a while and every Argo CD call in KubeOps starts failing with
# "connection refused" even though the cluster is healthy. Each target here gets
# a supervisor that restarts its forward until asked to stop.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
RUN_DIR="${KUBEOPS_ARGO_FORWARD_RUN_DIR:-$ROOT_DIR/.dev/argo-forwards}"
ARGO_NAMESPACE="${KUBEOPS_ARGO_NAMESPACE:-argo-cd}"
ARGO_RELEASE="${KUBEOPS_ARGO_RELEASE:-argo-cd}"
RETRY_DELAY="${KUBEOPS_ARGO_FORWARD_RETRY_DELAY:-3}"

env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^["'\'']|["'\'']$/, "", value)
      print value
      exit
    }
  ' "$ENV_FILE"
}

# Targets are "<label> <context> <port>". Local contexts are fixed; the cloud
# ones are opt-in through .env exactly as dev-local.sh reads them.
targets() {
  printf '%s\n' \
    "docker-local ${KUBEOPS_DOCKER_CONTEXT:-docker-desktop} ${KUBEOPS_DOCKER_ARGO_PORT:-18081}" \
    "minikube-local ${KUBEOPS_MINIKUBE_CONTEXT:-minikube} ${KUBEOPS_MINIKUBE_ARGO_PORT:-18082}"
  local gke_context gke_port aks_context aks_port
  gke_context="${KUBEOPS_GKE_CONTEXT:-$(env_value KUBEOPS_GKE_CONTEXT)}"
  gke_port="${KUBEOPS_GKE_ARGO_PORT:-$(env_value KUBEOPS_GKE_ARGO_PORT)}"
  aks_context="${KUBEOPS_AKS_CONTEXT:-$(env_value KUBEOPS_AKS_CONTEXT)}"
  aks_port="${KUBEOPS_AKS_ARGO_PORT:-$(env_value KUBEOPS_AKS_ARGO_PORT)}"
  [[ -n "$gke_context" ]] && printf '%s\n' "gke ${gke_context} ${gke_port:-18083}"
  [[ -n "$aks_context" ]] && printf '%s\n' "aks ${aks_context} ${aks_port:-18084}"
  return 0
}

context_exists() {
  kubectl config get-contexts -o name 2>/dev/null | grep -Fxq "$1"
}

port_serving() {
  curl -sk -o /dev/null --max-time 5 "https://127.0.0.1:$1/api/version"
}

# One supervisor per target. Runs in the background until its pid file is gone.
supervise() {
  local label="$1" context="$2" port="$3" pid_file="$RUN_DIR/$label.pid"
  local log_file="$RUN_DIR/$label.log"
  while [[ -f "$pid_file" ]]; do
    kubectl --context "$context" -n "$ARGO_NAMESPACE" port-forward \
      "service/$ARGO_RELEASE-argocd-server" "$port:443" --address 127.0.0.1 \
      >>"$log_file" 2>&1
    [[ -f "$pid_file" ]] || break
    echo "[$(date '+%H:%M:%S')] forward for $label exited; restarting" >>"$log_file"
    sleep "$RETRY_DELAY"
  done
}

start() {
  mkdir -p "$RUN_DIR"
  local started=0 skipped=0
  while read -r label context port; do
    [[ -n "$label" ]] || continue
    local pid_file="$RUN_DIR/$label.pid"
    if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
      echo "already running: $label (port $port)"
      continue
    fi
    if ! context_exists "$context"; then
      # A missing context is normal — not everyone has every cloud cluster
      # configured — so skip it instead of failing the other targets.
      echo "skipping $label: kube context not found: $context" >&2
      skipped=$((skipped + 1))
      continue
    fi
    : >"$RUN_DIR/$label.log"
    touch "$pid_file"
    # Detach from this shell's stdio: an inherited stdout would keep the pipe
    # open and make `make argo-forward` appear to hang after the script is done.
    supervise "$label" "$context" "$port" </dev/null >/dev/null 2>&1 &
    echo "$!" >"$pid_file"
    disown %% 2>/dev/null || true
    echo "started $label -> https://127.0.0.1:$port (context $context)"
    started=$((started + 1))
  done < <(targets)

  [[ $started -eq 0 ]] && return 0
  echo "waiting for Argo CD servers to answer..."
  local label context port ready=0 total=0
  while read -r label context port; do
    [[ -n "$label" ]] || continue
    [[ -f "$RUN_DIR/$label.pid" ]] || continue
    total=$((total + 1))
    local attempt=0
    until port_serving "$port"; do
      attempt=$((attempt + 1))
      if [[ $attempt -ge 20 ]]; then
        echo "  $label (port $port): NOT responding — see $RUN_DIR/$label.log" >&2
        continue 2
      fi
      sleep 1
    done
    echo "  $label (port $port): ok"
    ready=$((ready + 1))
  done < <(targets)
  echo "$ready/$total Argo CD endpoints reachable${skipped:+ ($skipped skipped)}"
}

stop() {
  local stopped=0
  for pid_file in "$RUN_DIR"/*.pid; do
    [[ -e "$pid_file" ]] || continue
    local pid label
    pid="$(cat "$pid_file")"
    label="$(basename "$pid_file" .pid)"
    # Remove the pid file first so the supervisor loop exits instead of
    # restarting the forward we are about to kill.
    rm -f "$pid_file"
    pkill -P "$pid" 2>/dev/null
    kill "$pid" 2>/dev/null
    echo "stopped $label"
    stopped=$((stopped + 1))
  done
  [[ $stopped -eq 0 ]] && echo "no forwards running"
  return 0
}

status() {
  local label context port
  while read -r label context port; do
    [[ -n "$label" ]] || continue
    local state="stopped"
    if [[ -f "$RUN_DIR/$label.pid" ]] && kill -0 "$(cat "$RUN_DIR/$label.pid")" 2>/dev/null; then
      state="supervised"
    fi
    if port_serving "$port"; then
      echo "$label (port $port): reachable [$state]"
    else
      echo "$label (port $port): UNREACHABLE [$state]"
    fi
  done < <(targets)
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *)
    echo "usage: $(basename "$0") [start|stop|restart|status]" >&2
    exit 2
    ;;
esac

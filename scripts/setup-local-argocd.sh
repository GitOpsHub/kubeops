#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DOCKER_CONTEXT="${KUBEOPS_DOCKER_CONTEXT:-docker-desktop}"
MINIKUBE_CONTEXT="${KUBEOPS_MINIKUBE_CONTEXT:-minikube}"
DOCKER_PORT="${KUBEOPS_DOCKER_ARGO_PORT:-18081}"
MINIKUBE_PORT="${KUBEOPS_MINIKUBE_ARGO_PORT:-18082}"
ARGO_NAMESPACE="${KUBEOPS_ARGO_NAMESPACE:-argo-cd}"
ARGO_RELEASE="${KUBEOPS_ARGO_RELEASE:-argo-cd}"
ARGO_CHART_VERSION="${KUBEOPS_ARGO_CHART_VERSION:-10.2.1}"
TLS_DIR="$ROOT_DIR/config/.argocd-local-tls"
CA_FILE="$ROOT_DIR/config/argocd-local-ca.crt"
VALUES_FILE="$ROOT_DIR/manifests/argocd/kubeops-values.yaml"
TARGETS_FILE="$ROOT_DIR/config/argo-targets.yaml"
ENV_FILE="$ROOT_DIR/.env"
ARGO_CLI_CONFIG="$(mktemp /private/tmp/kubeops-argocd-cli.XXXXXX)"
DOCKER_FORWARD_PID=""
MINIKUBE_FORWARD_PID=""

cleanup() {
  if [[ -n "$DOCKER_FORWARD_PID" ]]; then
    kill "$DOCKER_FORWARD_PID" 2>/dev/null || true
  fi
  if [[ -n "$MINIKUBE_FORWARD_PID" ]]; then
    kill "$MINIKUBE_FORWARD_PID" 2>/dev/null || true
  fi
  rm -f "$ARGO_CLI_CONFIG"
}
trap cleanup EXIT INT TERM

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

env_value() {
  local key="$1"
  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      gsub(/^["'\'']|["'\'']$/, "", value)
      print value
      exit
    }
  ' "$ENV_FILE"
}

upsert_env_secret() {
  local key="$1"
  local value="$2"
  ENV_KEY="$key" ENV_VALUE="$value" perl -0pi -e '
    $key = quotemeta($ENV{ENV_KEY});
    if (s/^$key=.*$/$ENV{ENV_KEY}=$ENV{ENV_VALUE}/m) {
      next;
    }
    $_ .= "\n" unless /\n\z/;
    $_ .= "$ENV{ENV_KEY}=$ENV{ENV_VALUE}\n";
  ' "$ENV_FILE"
}

wait_for_https() {
  local port="$1"
  local attempts=0
  until curl --cacert "$CA_FILE" -fsS "https://localhost:$port/healthz" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [[ "$attempts" -ge 60 ]]; then
      echo "Timed out waiting for Argo CD on localhost:$port" >&2
      exit 1
    fi
    sleep 1
  done
}

install_argocd() {
  local context="$1"
  local bootstrap_admin="$2"
  local helm_args=(
    upgrade
    --install
    "$ARGO_RELEASE"
    argo/argo-cd
    --version
    "$ARGO_CHART_VERSION"
    --kube-context
    "$context"
    --namespace
    "$ARGO_NAMESPACE"
    --values
    "$VALUES_FILE"
    --wait
    --timeout
    10m
  )

  kubectl --context "$context" create namespace "$ARGO_NAMESPACE" \
    --dry-run=client -o yaml | kubectl --context "$context" apply -f - >/dev/null

  kubectl --context "$context" -n "$ARGO_NAMESPACE" create secret tls argocd-server-tls \
    --cert="$TLS_DIR/tls.crt" \
    --key="$TLS_DIR/tls.key" \
    --dry-run=client -o yaml | kubectl --context "$context" apply -f - >/dev/null

  if kubectl --context "$context" get crd applications.argoproj.io >/dev/null 2>&1; then
    helm_args+=(--set crds.install=false)
  fi
  if helm upgrade --help | grep -q -- '--force-conflicts'; then
    helm_args+=(--force-conflicts)
  fi
  if [[ "$bootstrap_admin" == "true" ]]; then
    helm_args+=(--set-string 'configs.cm.admin\.enabled=true')
  fi

  helm "${helm_args[@]}" >/dev/null
}

configure_ui_password() {
  local context="$1"
  local port="$2"
  local context_name="$3"
  local ui_password="$4"
  local password

  password="$(kubectl --context "$context" -n "$ARGO_NAMESPACE" \
    get secret argocd-initial-admin-secret \
    -o go-template='{{.data.password | base64decode}}')"

  argocd login "localhost:$port" \
    --config "$ARGO_CLI_CONFIG" \
    --name "$context_name" \
    --username admin \
    --password "$password" \
    --insecure \
    --grpc-web >/dev/null

  argocd account update-password \
    --config "$ARGO_CLI_CONFIG" \
    --argocd-context "$context_name" \
    --account kubeops \
    --current-password "$password" \
    --new-password "$ui_password" >/dev/null
}

generate_api_token() {
  local context_name="$1"

  argocd account generate-token \
    --config "$ARGO_CLI_CONFIG" \
    --argocd-context "$context_name" \
    --account kubeops \
    --id "kubeops-ui-$(date +%s)"
}

verify_token() {
  local port="$1"
  local token="$2"
  [[ -n "$token" ]] && curl --cacert "$CA_FILE" -fsS \
    -H "Authorization: Bearer $token" \
    "https://localhost:$port/api/v1/applications" >/dev/null 2>&1
}

configure_repo_credentials() {
  local context="$1"
  local token="$2"
  local username="$3"

  GITHUB_REPO_TOKEN="$token" kubectl --context "$context" -n "$ARGO_NAMESPACE" \
    create secret generic kubeops-github-repo-creds \
    --from-literal=type=git \
    --from-literal=url=https://github.com/GitOpsHub \
    --from-literal=username="$username" \
    --from-literal=password="$token" \
    --dry-run=client -o yaml |
    kubectl label --local -f - argocd.argoproj.io/secret-type=repo-creds -o yaml |
    kubectl --context "$context" apply -f - >/dev/null
}

configure_helm_registry_credentials() {
  local context="$1"
  local token="$2"
  local username="$3"

  kubectl --context "$context" -n "$ARGO_NAMESPACE" \
    create secret generic kubeops-ghcr-helm-creds \
    --from-literal=type=helm \
    --from-literal=name=kubeops-ghcr \
    --from-literal=url=ghcr.io/gitopshub/charts \
    --from-literal=enableOCI=true \
    --from-literal=username="$username" \
    --from-literal=password="$token" \
    --dry-run=client -o yaml |
    kubectl label --local -f - argocd.argoproj.io/secret-type=repository -o yaml |
    kubectl --context "$context" apply -f - >/dev/null
}

for command in kubectl helm argocd openssl curl perl awk grep; do
  require_command "$command"
done

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT_DIR/.env.example" "$ENV_FILE"
fi

if [[ ! -f "$ROOT_DIR/config/cloud-sources.yaml" ]]; then
  printf '%s\n' \
    'sources:' \
    '  - id: docker-local' \
    '    provider: docker' \
    '    name: Docker Kubernetes' \
    '    scope_id: local-docker' \
    '    regions: [local]' \
    '    enabled: true' \
    '    kubeconfig_path: ~/.kube/config' \
    "    contexts: [$DOCKER_CONTEXT]" \
    '' \
    '  - id: minikube-local' \
    '    provider: minikube' \
    '    name: Minikube' \
    '    scope_id: local-minikube' \
    '    regions: [local]' \
    '    enabled: true' \
    '    kubeconfig_path: ~/.kube/config' \
    "    contexts: [$MINIKUBE_CONTEXT]" \
    > "$ROOT_DIR/config/cloud-sources.yaml"
fi

if ! kubectl config get-contexts -o name | grep -Fxq "$DOCKER_CONTEXT"; then
  echo "Kubernetes context not found: $DOCKER_CONTEXT" >&2
  exit 1
fi
if ! kubectl config get-contexts -o name | grep -Fxq "$MINIKUBE_CONTEXT"; then
  echo "Kubernetes context not found: $MINIKUBE_CONTEXT" >&2
  exit 1
fi

mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR"
if [[ ! -s "$TLS_DIR/ca.key" || ! -s "$TLS_DIR/ca.crt" ||
  ! -s "$TLS_DIR/tls.key" || ! -s "$TLS_DIR/tls.crt" ]]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -subj /CN=KubeOps-local-Argo-CD-CA \
    -keyout "$TLS_DIR/ca.key" \
    -out "$TLS_DIR/ca.crt" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes \
    -subj /CN=localhost \
    -addext subjectAltName=DNS:localhost,IP:127.0.0.1 \
    -keyout "$TLS_DIR/tls.key" \
    -out "$TLS_DIR/tls.csr" >/dev/null 2>&1
  printf '%s\n' \
    'subjectAltName=DNS:localhost,IP:127.0.0.1' \
    'extendedKeyUsage=serverAuth' \
    > "$TLS_DIR/server.ext"
  openssl x509 -req \
    -in "$TLS_DIR/tls.csr" \
    -CA "$TLS_DIR/ca.crt" \
    -CAkey "$TLS_DIR/ca.key" \
    -CAserial "$TLS_DIR/ca.srl" \
    -CAcreateserial \
    -days 825 \
    -sha256 \
    -extfile "$TLS_DIR/server.ext" \
    -out "$TLS_DIR/tls.crt" >/dev/null 2>&1
  chmod 600 "$TLS_DIR/ca.key" "$TLS_DIR/tls.key"
fi
install -m 0644 "$TLS_DIR/ca.crt" "$CA_FILE"

gke_context="${KUBEOPS_GKE_CONTEXT:-$(env_value KUBEOPS_GKE_CONTEXT)}"
gke_port="${KUBEOPS_GKE_ARGO_PORT:-$(env_value KUBEOPS_GKE_ARGO_PORT)}"
gke_port="${gke_port:-18083}"
gke_source_id="${KUBEOPS_GKE_SOURCE_ID:-$(env_value KUBEOPS_GKE_SOURCE_ID)}"
gke_provider_resource_id="$(
  if [[ -n "${KUBEOPS_GKE_PROVIDER_RESOURCE_ID:-}" ]]; then
    printf '%s' "$KUBEOPS_GKE_PROVIDER_RESOURCE_ID"
  else
    env_value KUBEOPS_GKE_PROVIDER_RESOURCE_ID
  fi
)"

printf '%s\n' \
  'targets:' \
  '  - source_id: docker-local' \
  "    provider_resource_id: kubeconfig:docker-local:$DOCKER_CONTEXT" \
  "    server_url: https://localhost:$DOCKER_PORT" \
  '    token_env: ARGO_DOCKER_LOCAL_TOKEN' \
  '    ca_file: ../config/argocd-local-ca.crt' \
  "    ui_url: https://localhost:$DOCKER_PORT" \
  '    username: kubeops' \
  '    password_env: ARGO_DOCKER_LOCAL_PASSWORD' \
  '' \
  '  - source_id: minikube-local' \
  "    provider_resource_id: kubeconfig:minikube-local:$MINIKUBE_CONTEXT" \
  "    server_url: https://localhost:$MINIKUBE_PORT" \
  '    token_env: ARGO_MINIKUBE_LOCAL_TOKEN' \
  '    ca_file: ../config/argocd-local-ca.crt' \
  "    ui_url: https://localhost:$MINIKUBE_PORT" \
  '    username: kubeops' \
  '    password_env: ARGO_MINIKUBE_LOCAL_PASSWORD' \
  > "$TARGETS_FILE"

if [[ -n "$gke_context" && -n "$gke_source_id" && -n "$gke_provider_resource_id" ]]; then
  printf '%s\n' \
    '' \
    "  - source_id: $gke_source_id" \
    "    provider_resource_id: $gke_provider_resource_id" \
    "    server_url: https://localhost:$gke_port" \
    '    token_env: ARGO_GKE_KUBERNETES_DEV_TOKEN' \
    '    ca_file: ../config/argocd-local-ca.crt' \
    "    ui_url: https://localhost:$gke_port" \
    '    username: kubeops' \
    '    password_env: ARGO_GKE_KUBERNETES_DEV_PASSWORD' \
    >> "$TARGETS_FILE"
fi

helm repo add argo https://argoproj.github.io/argo-helm --force-update >/dev/null
helm repo update argo >/dev/null

docker_token="$(env_value ARGO_DOCKER_LOCAL_TOKEN)"
minikube_token="$(env_value ARGO_MINIKUBE_LOCAL_TOKEN)"
docker_password="$(env_value ARGO_DOCKER_LOCAL_PASSWORD)"
minikube_password="$(env_value ARGO_MINIKUBE_LOCAL_PASSWORD)"
credential_key="$(env_value ARGO_CREDENTIAL_ENCRYPTION_KEY)"

if [[ ${#docker_password} -lt 8 || ${#docker_password} -gt 32 ]]; then
  docker_password="$(openssl rand -hex 16)"
  upsert_env_secret ARGO_DOCKER_LOCAL_PASSWORD "$docker_password"
fi
if [[ ${#minikube_password} -lt 8 || ${#minikube_password} -gt 32 ]]; then
  minikube_password="$(openssl rand -hex 16)"
  upsert_env_secret ARGO_MINIKUBE_LOCAL_PASSWORD "$minikube_password"
fi
if [[ -z "$credential_key" ]]; then
  credential_key="$(openssl rand -base64 32)"
  upsert_env_secret ARGO_CREDENTIAL_ENCRYPTION_KEY "$credential_key"
fi

install_argocd "$DOCKER_CONTEXT" true
install_argocd "$MINIKUBE_CONTEXT" true

kubectl --context "$DOCKER_CONTEXT" -n "$ARGO_NAMESPACE" port-forward \
  "service/$ARGO_RELEASE-argocd-server" "$DOCKER_PORT:443" \
  --address 127.0.0.1 >/dev/null 2>&1 &
DOCKER_FORWARD_PID=$!
kubectl --context "$MINIKUBE_CONTEXT" -n "$ARGO_NAMESPACE" port-forward \
  "service/$ARGO_RELEASE-argocd-server" "$MINIKUBE_PORT:443" \
  --address 127.0.0.1 >/dev/null 2>&1 &
MINIKUBE_FORWARD_PID=$!

wait_for_https "$DOCKER_PORT"
wait_for_https "$MINIKUBE_PORT"

configure_ui_password "$DOCKER_CONTEXT" "$DOCKER_PORT" kubeops-docker "$docker_password"
configure_ui_password "$MINIKUBE_CONTEXT" "$MINIKUBE_PORT" kubeops-minikube "$minikube_password"

if ! verify_token "$DOCKER_PORT" "$docker_token"; then
  docker_token="$(generate_api_token kubeops-docker)"
  upsert_env_secret ARGO_DOCKER_LOCAL_TOKEN "$docker_token"
fi
if ! verify_token "$MINIKUBE_PORT" "$minikube_token"; then
  minikube_token="$(generate_api_token kubeops-minikube)"
  upsert_env_secret ARGO_MINIKUBE_LOCAL_TOKEN "$minikube_token"
fi

install_argocd "$DOCKER_CONTEXT" false
install_argocd "$MINIKUBE_CONTEXT" false

github_read_token="${ARGO_GITHUB_READ_TOKEN:-$(env_value ARGO_GITHUB_READ_TOKEN)}"
github_repository_username="$(
  if [[ -n "${GITHUB_REPOSITORY_USERNAME:-}" ]]; then
    printf '%s' "$GITHUB_REPOSITORY_USERNAME"
  else
    env_value GITHUB_REPOSITORY_USERNAME
  fi
)"
if [[ -n "$github_read_token" ]]; then
  if [[ -z "$github_repository_username" ]]; then
    echo "GITHUB_REPOSITORY_USERNAME must identify the owner of ARGO_GITHUB_READ_TOKEN." >&2
    exit 1
  fi
  configure_repo_credentials "$DOCKER_CONTEXT" "$github_read_token" "$github_repository_username"
  configure_repo_credentials "$MINIKUBE_CONTEXT" "$github_read_token" "$github_repository_username"
  configure_helm_registry_credentials "$DOCKER_CONTEXT" "$github_read_token" "$github_repository_username"
  configure_helm_registry_credentials "$MINIKUBE_CONTEXT" "$github_read_token" "$github_repository_username"
else
  echo "Argo CD private Git and GHCR credentials were not configured."
  echo "Set ARGO_GITHUB_READ_TOKEN to a read-only GitHub token before onboarding private repositories or charts."
fi

echo "Local Argo CD is configured for $DOCKER_CONTEXT and $MINIKUBE_CONTEXT."

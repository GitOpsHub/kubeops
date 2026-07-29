#!/usr/bin/env bash
# Validate the KubeOps global application chart.
#
#   ./scripts/validate-helm-chart.sh                 everything below
#   ./scripts/validate-helm-chart.sh --profile eks   one platform profile
#   ./scripts/validate-helm-chart.sh --guardrails    only the rejection tests
#   ./scripts/validate-helm-chart.sh --list          print the profile names
#
# For each platform profile in charts/kubeops/ci:
#   1. helm lint --strict
#   2. helm template
#   3. kubeconform against the Kubernetes API schemas and the CRD catalog
#
# Then every file in ci/invalid must be rejected by the chart's own validation,
# with the message it declares on its first line. That keeps a guardrail in
# _helpers.tpl from being removed without a test turning red.
#
# kubeconform is optional locally; the schema step is skipped when it is absent.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chart_path="${CHART_PATH:-$repo_root/charts/kubeops}"
# Rendered manifests are validated against this API version. Keep it at or above
# the chart's kubeVersion floor.
kube_version="${KUBE_VERSION:-1.30.0}"

all_profiles=(
  default
  eks
  eks-full
  gke
  gke-full
  aks
  aks-full
  gateway
  minikube
  docker-desktop
)

profiles=("${all_profiles[@]}")
run_guardrails=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)
      printf '%s\n' "${all_profiles[@]}"
      exit 0
      ;;
    --profile)
      [[ $# -ge 2 ]] || { echo "--profile needs a name" >&2; exit 2; }
      profiles=("$2")
      run_guardrails=false
      shift 2
      ;;
    --guardrails)
      profiles=()
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

failures=0
render_dir="$(mktemp -d)"
trap 'rm -rf "$render_dir"' EXIT

# The ${a[@]+...} form keeps `set -u` from tripping on an empty array, which is
# what --guardrails leaves behind on the bash 3.2 that ships with macOS.
for profile in ${profiles[@]+"${profiles[@]}"}; do
  values="$chart_path/ci/$profile-values.yaml"
  if [[ ! -f "$values" ]]; then
    echo "::error::missing profile values file: $values"
    failures=$((failures + 1))
    continue
  fi

  echo "==> lint: $profile"
  if ! helm lint "$chart_path" --strict --values "$values"; then
    failures=$((failures + 1))
    continue
  fi

  echo "==> render: $profile"
  if ! helm template kubeops-validate "$chart_path" \
    --namespace kubeops-validate \
    --kube-version "$kube_version" \
    --values "$values" \
    >"$render_dir/$profile.yaml"; then
    failures=$((failures + 1))
    continue
  fi

  if ! command -v kubeconform >/dev/null 2>&1; then
    echo "==> schema: skipped ($profile, kubeconform not installed)"
    continue
  fi

  echo "==> schema: $profile"
  # The catalog covers every CRD this chart emits: ExternalSecret,
  # SecretProviderClass, ServiceMonitor, PodMonitor, HTTPRoute, BackendConfig,
  # FrontendConfig and ManagedCertificate. -ignore-missing-schemas keeps a CRD
  # newly added to the chart from breaking the run before the catalog catches
  # up; -strict still rejects unknown fields in everything that does resolve.
  if ! kubeconform \
    -strict \
    -summary \
    -kubernetes-version "$kube_version" \
    -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
    -ignore-missing-schemas \
    "$render_dir/$profile.yaml"; then
    failures=$((failures + 1))
  fi
done

if [[ "$run_guardrails" == true ]]; then
  echo "==> rejected combinations"
  shopt -s nullglob
  for values in "$chart_path"/ci/invalid/*.yaml; do
    name="$(basename "$values" .yaml)"
    expected="$(sed -n '1s/^# expect: //p' "$values")"
    if [[ -z "$expected" ]]; then
      echo "::error::$name has no '# expect:' line stating the message it should produce"
      failures=$((failures + 1))
      continue
    fi

    if output="$(helm template kubeops-validate "$chart_path" \
      --namespace kubeops-validate \
      --kube-version "$kube_version" \
      --values "$values" 2>&1)"; then
      echo "::error::$name rendered successfully but should have been rejected"
      failures=$((failures + 1))
    elif [[ "$output" != *"$expected"* ]]; then
      echo "::error::$name failed with an unexpected message"
      echo "  expected to contain: $expected"
      echo "  got: $output"
      failures=$((failures + 1))
    else
      echo "    rejected: $name"
    fi
  done
  shopt -u nullglob
fi

if ((failures > 0)); then
  echo
  echo "$failures check(s) failed" >&2
  exit 1
fi

echo
echo "Chart validation passed."

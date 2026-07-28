# KubeOps global application chart

This cloud-neutral chart deploys one containerized HTTP application using only
standard Kubernetes APIs. It supports EKS, GKE, AKS, other conformant managed
Kubernetes services, Minikube, and Docker Desktop with Kubernetes enabled.
KubeOps uses it as the fixed global chart while each onboarded application keeps
only its environment-specific `values.yaml` in a private repository.

## Install from GitHub Container Registry

```sh
helm install my-app oci://ghcr.io/gitopshub/charts/kubeops \
  --version 1.0.0 \
  --namespace my-app \
  --create-namespace \
  --set image.repository=ghcr.io/example/my-app \
  --set image.tag=1.0.0
```

Public packages can be pulled without registry credentials. If the package is
private, authenticate first:

```sh
echo "$GITHUB_TOKEN" | helm registry login ghcr.io \
  --username YOUR_GITHUB_USERNAME \
  --password-stdin
```

## Important values

| Value | Default | Purpose |
| --- | --- | --- |
| `image.repository` | `nginxinc/nginx-unprivileged` | Application image repository |
| `image.tag` | `1.27-alpine` | Immutable image tag to deploy |
| `container.port` | `8080` | HTTP port exposed by the container |
| `container.env` | `[]` | Kubernetes container environment variables |
| `container.envFrom` | `[]` | ConfigMap or Secret environment sources |
| `service.port` | `80` | Service port |
| `service.targetPort` | `http` | Named container port targeted by the Service |
| `service.annotations` | `{}` | Provider/controller-specific Service annotations |
| `service.nodePort` | `null` | Optional fixed port for NodePort/LoadBalancer |
| `service.loadBalancerClass` | `""` | Optional installed load-balancer controller class |
| `ingress.enabled` | `false` | Create an Ingress |
| `autoscaling.enabled` | `false` | Create a CPU-based HPA |
| `probes.*.enabled` | `true` | Enable HTTP liveness/readiness probes |

Do not put secret values directly in a values file. Use `secretKeyRef`,
`envFrom`, an external secret operator, or an existing Kubernetes Secret.

## Platform profiles

The chart does not auto-detect a cloud provider. Auto-detection would make the
same GitOps values render differently between clusters. Instead, start with the
matching tested profile and add only annotations required by the controllers
installed in your cluster:

```sh
# EKS, GKE, or AKS
helm upgrade --install my-app ./charts/kubeops \
  --namespace my-app --create-namespace \
  --values ./charts/kubeops/ci/eks-values.yaml

# Minikube
helm upgrade --install my-app ./charts/kubeops \
  --namespace my-app --create-namespace \
  --values ./charts/kubeops/ci/minikube-values.yaml
minikube service my-app-kubeops --namespace my-app

# Docker Desktop with Kubernetes enabled
helm upgrade --install my-app ./charts/kubeops \
  --namespace my-app --create-namespace \
  --values ./charts/kubeops/ci/docker-desktop-values.yaml
kubectl port-forward --namespace my-app service/my-app-kubeops 8080:80
```

The cloud profiles use `LoadBalancer`; the cloud's installed Service controller
selects and provisions the actual load balancer. The local profiles use
`NodePort`, one replica, and smaller resource requests. A plain Docker Engine
does not provide Kubernetes, so it cannot install a Helm chart.

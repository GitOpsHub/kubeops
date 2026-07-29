# KubeOps global application chart

This chart deploys one containerized HTTP application. The core is
cloud-neutral — standard Kubernetes APIs only — and every provider-specific
behaviour is an opt-in block. It supports EKS, GKE, AKS, other conformant
managed Kubernetes services, Minikube, and Docker Desktop with Kubernetes
enabled. KubeOps uses it as the fixed global chart while each onboarded
application keeps only its environment-specific `values.yaml` in a private
repository.

The chart does not auto-detect a cloud provider. Auto-detection would make the
same GitOps values render differently between clusters, which is exactly what a
GitOps pipeline must not do. Start from the matching profile in `ci/` instead
and change what your cluster's controllers actually need.

## Install from GitHub Container Registry

```sh
helm install my-app oci://ghcr.io/gitopshub/charts/kubeops \
  --version 1.1.0 \
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

## Platform profiles

| Profile | What it covers |
| --- | --- |
| `ci/default-values.yaml` | ClusterIP only, no provider integrations |
| `ci/eks-values.yaml` | EKS, Network Load Balancer Service |
| `ci/eks-full-values.yaml` | EKS with ALB Ingress, EBS + EFS storage, IRSA, Secrets Manager |
| `ci/gke-values.yaml` | GKE, container-native load balancer Service |
| `ci/gke-full-values.yaml` | GKE with Ingress, managed certificate, PD + Filestore + GCS FUSE, Workload Identity |
| `ci/aks-values.yaml` | AKS, Azure Load Balancer Service |
| `ci/aks-full-values.yaml` | AKS with application routing Ingress, Azure Disk + Files + Blob, Workload Identity |
| `ci/gateway-values.yaml` | Gateway API instead of Ingress, shared storage, in-chart config and RBAC |
| `ci/minikube-values.yaml` | Minikube, NodePort, small requests |
| `ci/docker-desktop-values.yaml` | Docker Desktop with Kubernetes enabled |

```sh
helm upgrade --install my-app ./charts/kubeops \
  --namespace my-app --create-namespace \
  --values ./charts/kubeops/ci/eks-full-values.yaml
```

Local clusters use `NodePort`, one replica, and smaller requests:

```sh
minikube service my-app-service --namespace my-app
kubectl port-forward --namespace my-app service/my-app-service 8080:80
```

A plain Docker Engine does not provide Kubernetes, so it cannot install a Helm
chart.

## Ingress

Set `ingress.className` to the class your controller registers, then enable the
matching provider block. Anything in `ingress.annotations` overrides what the
block generates.

| Platform | `ingress.className` | Block | Controller |
| --- | --- | --- | --- |
| EKS | `alb` | `ingress.aws` | AWS Load Balancer Controller |
| GKE | `gce`, `gce-internal` | `ingress.gke` | GKE Ingress (built in) |
| AKS | `webapprouting.kubernetes.azure.com` | `ingress.azure.appRouting` | Application routing add-on |
| AKS | `azure-application-gateway` | `ingress.azure.agic` | Application Gateway Ingress Controller |
| Any | `nginx` | — | ingress-nginx |
| Any | — | `httpRoute` | Gateway API |

Three details decide whether an Ingress actually reaches your pods, and the
chart refuses to render when they are wrong rather than leaving you with a
load balancer that health-checks nothing:

- **EKS.** `ingress.aws.targetType: ip` sends traffic straight to pod IPs and
  works with a `ClusterIP` Service. `instance` routes through node ports and
  therefore needs `service.type: NodePort`.
- **GKE.** A GKE Ingress cannot reach a plain `ClusterIP` Service. Either set
  `service.gcp.neg.enabled: true` for container-native load balancing, or use
  `service.type: NodePort`.
- **All three.** The cloud health check hits the pod directly, on the path you
  configure in the provider block — not through the Service. Point it at a path
  the application really serves.

TLS certificates come from the platform rather than the chart:

- EKS: `ingress.aws.certificateArn` (ACM), with `sslRedirect: "443"`.
- GKE: `ingress.gke.managedCertificate` provisions a Google-managed
  certificate. Each domain must already resolve to the load balancer address or
  issuance stays in `FAILED_NOT_VISIBLE`.
- AKS: `ingress.azure.appRouting.tlsCertKeyVaultUri` points the add-on at a Key
  Vault certificate.
- Anywhere cert-manager is installed: `ingress.certManager`, which requires an
  `ingress.tls` entry naming the Secret to fill.

## Storage

`persistence` is the application's own volume. Under a `Deployment` it is a
single claim shared by every replica; under a `StatefulSet` it becomes a
`volumeClaimTemplate`, so each replica gets its own volume — which is what makes
single-writer block storage usable with more than one replica.

`extraPersistentVolumeClaims` are always shared claims mounted by every replica,
so with more than one replica they need a `ReadWriteMany` class.

| Need | EKS | GKE | AKS |
| --- | --- | --- | --- |
| Block storage, one writer | EBS (`ebs.csi.aws.com`) | Persistent Disk / Hyperdisk (`pd.csi.storage.gke.io`) | Azure Disk (`disk.csi.azure.com`) |
| Shared file system, many writers | EFS (`efs.csi.aws.com`) | Filestore (`filestore.csi.storage.gke.io`) | Azure Files (`file.csi.azure.com`) |
| Object storage as files | Mountpoint for S3 | Cloud Storage FUSE (`gcsfuse.csi.storage.gke.io`) | Azure Blob (`blob.csi.azure.com`) |
| Snapshots | `ebs.csi.aws.com` | `pd.csi.storage.gke.io` | `disk.csi.azure.com` |

The full profiles in `ci/` contain working `storage.classes.items` definitions
for each of these, with the parameters that matter (gp3 IOPS and throughput,
Hyperdisk provisioned throughput, Azure Files NFS mount options).

Other storage shapes the chart models:

| Value | Use |
| --- | --- |
| `storage.emptyDirs` | Scratch space; `medium: Memory` for a tmpfs, needed when `readOnlyRootFilesystem` is on |
| `storage.ephemeralVolumes` | A CSI volume provisioned per pod and deleted with it |
| `storage.csiVolumes` | Inline CSI volumes such as GCS FUSE or Azure Blob |
| `storage.hostPaths` | Node-local paths; requires `storage.allowHostPath: true` |
| `storage.classes` | StorageClasses (cluster-scoped — create once per cluster) |
| `storage.snapshotClasses` | VolumeSnapshotClasses for backup and restore |
| `persistence.dataSource` | Restore from a VolumeSnapshot or clone a claim |

Three things about persistent storage are easy to get wrong, so the chart
enforces them:

- A single-writer volume cannot back more than one `Deployment` replica. Use a
  `StatefulSet`, or a `ReadWriteMany` class.
- A single-writer volume needs `deploymentStrategy.type: Recreate`. A rolling
  update starts the replacement pod before the old one detaches the volume, and
  the rollout deadlocks on multi-attach.
- A non-root container cannot write to a freshly provisioned volume unless
  `podSecurityContext.fsGroup` is set.

Claims are annotated `helm.sh/resource-policy: keep`, so `helm uninstall` leaves
application data behind. Set `persistence.retainOnDelete: false` to opt out.

## Identity and secrets

Nothing sensitive belongs in a values file: it ends up in Git and in the Helm
release Secret in plain text.

| Value | Purpose |
| --- | --- |
| `serviceAccount.aws.roleArn` | IAM Roles for Service Accounts (EKS) |
| `serviceAccount.gcp.serviceAccount` | Workload Identity (GKE) |
| `serviceAccount.azure.clientId` | Azure Workload Identity; also labels the pod |
| `externalSecret` | External Secrets Operator syncs a provider secret into a Kubernetes Secret |
| `secretsStore` | Secrets Store CSI Driver mounts provider secrets as files |
| `secret` | Plain Secret, for placeholders and local development only |

`secretsStore` mounts secrets as files. Exposing them as environment variables
additionally needs `secretsStore.secretObjects`, because the mirrored Secret is
what `envFrom` reads — and it only exists while a pod mounts the volume.

## Other integrations

| Value | Creates |
| --- | --- |
| `workload.kind` | `Deployment` or `StatefulSet` |
| `autoscaling` | HPA on CPU, memory, or custom metrics, with scaling behavior |
| `podDisruptionBudget` | Protects replicas during node upgrades and scale-down |
| `networkPolicy` | Ingress and egress rules (needs a CNI that enforces them) |
| `metrics.serviceMonitor`, `metrics.podMonitor` | Prometheus Operator scrape configs |
| `configMap` | ConfigMap, mountable and/or exported as env, with rollout on change |
| `rbac` | Namespaced Role and RoleBinding for the application's ServiceAccount |
| `initContainers`, `sidecars` | Extra containers in the pod |
| `extraObjects` | Any manifest the chart does not model, Go-templated |
| `tests` | A `helm test` connectivity check |

## Important values

| Value | Default | Purpose |
| --- | --- | --- |
| `workload.kind` | `Deployment` | `StatefulSet` for per-replica storage and identity |
| `image.repository` | `nginxinc/nginx-unprivileged` | Application image repository |
| `image.tag` | `1.27-alpine` | Image tag to deploy |
| `image.digest` | `""` | Pins the image immutably; wins over `tag` |
| `container.port` | `8080` | HTTP port exposed by the container |
| `container.env` | `[]` | Container environment variables |
| `container.envFrom` | `[]` | ConfigMap or Secret environment sources |
| `service.port` | `80` | Service port |
| `service.targetPort` | `http` | Named container port targeted by the Service |
| `service.annotations` | `{}` | Annotations, applied after the provider blocks |
| `ingress.enabled` | `false` | Create an Ingress |
| `persistence.enabled` | `false` | Create and mount a PersistentVolumeClaim |
| `autoscaling.enabled` | `false` | Create an HPA |
| `probes.*.enabled` | `true` | HTTP liveness, readiness and startup probes |

## Validating a change

```sh
./scripts/validate-helm-chart.sh
```

For every profile this lints, renders, and validates the result against the
Kubernetes API schemas plus the CRD catalog — so `BackendConfig`,
`SecretProviderClass`, `ExternalSecret` and the rest are schema-checked, not
just rendered. It then asserts that every combination in `ci/invalid/` is still
rejected with the message it declares.

Run one profile with `--profile eks-full`, or only the rejection tests with
`--guardrails`. `kubeconform` is optional locally and skipped when absent; CI
installs it. CI additionally installs the chart on a real cluster, checks that
`StatefulSet` volumes bind and are writable, and puts every profile through a
server-side dry run.

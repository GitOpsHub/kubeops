{{/*
Expand the name of the chart.
*/}}
{{- define "kubeops.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "kubeops.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create a release-scoped name with a resource-kind suffix. Truncate the release
portion first so the suffix is always preserved within Kubernetes' 63-character
DNS label limit.
*/}}
{{- define "kubeops.resourceName" -}}
{{- $suffix := .suffix -}}
{{- $maxStemLength := sub 62 (len $suffix) | int -}}
{{- $stem := default .root.Release.Name .root.Values.fullnameOverride -}}
{{- printf "%s-%s" ($stem | trunc $maxStemLength | trimSuffix "-") $suffix -}}
{{- end }}

{{/*
Name of the workload object. Deployment keeps the historical "-deployment"
suffix so existing releases are not renamed.
*/}}
{{- define "kubeops.workloadName" -}}
{{- include "kubeops.resourceName" (dict "root" . "suffix" (lower .Values.workload.kind)) -}}
{{- end }}

{{- define "kubeops.serviceName" -}}
{{- include "kubeops.resourceName" (dict "root" . "suffix" "service") -}}
{{- end }}

{{- define "kubeops.headlessServiceName" -}}
{{- include "kubeops.resourceName" (dict "root" . "suffix" "headless") -}}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "kubeops.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "kubeops.labels" -}}
helm.sh/chart: {{ include "kubeops.chart" . }}
{{ include "kubeops.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "kubeops.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kubeops.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use.
*/}}
{{- define "kubeops.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "kubeops.resourceName" (dict "root" . "suffix" "serviceaccount")) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Fully qualified image reference. A digest pins the image immutably and wins over
the tag when both are set.
*/}}
{{- define "kubeops.image" -}}
{{- $repository := .Values.image.repository -}}
{{- with .Values.image.registry -}}
{{- $repository = printf "%s/%s" (trimSuffix "/" .) $repository -}}
{{- end -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" $repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end }}

{{/*
Render a map as annotation-safe key/value pairs. Kubernetes rejects non-string
annotation values, so everything is stringified here rather than at each call.
*/}}
{{- define "kubeops.renderAnnotations" -}}
{{- range $key, $value := . }}
{{ $key }}: {{ toString $value | quote }}
{{- end }}
{{- end }}

{{/*
Join a list into the comma-separated form the cloud controllers expect.
*/}}
{{- define "kubeops.commaList" -}}
{{- join "," . -}}
{{- end }}

{{/*
Render a map as the "key=value,key=value" form used by AWS tag and attribute
annotations. Keys are sorted by range, so the rendered manifest is stable.
*/}}
{{- define "kubeops.keyValueList" -}}
{{- $pairs := list -}}
{{- range $key, $value := . -}}
{{- $pairs = append $pairs (printf "%s=%v" $key $value) -}}
{{- end -}}
{{- join "," $pairs -}}
{{- end }}

{{- define "kubeops.externalSecretName" -}}
{{- default (include "kubeops.resourceName" (dict "root" . "suffix" "external")) .Values.externalSecret.target.name -}}
{{- end }}

{{- define "kubeops.secretProviderClassName" -}}
{{- default (include "kubeops.resourceName" (dict "root" . "suffix" "secrets")) .Values.secretsStore.name -}}
{{- end }}

{{- define "kubeops.configMapName" -}}
{{- include "kubeops.resourceName" (dict "root" . "suffix" "config") -}}
{{- end }}

{{- define "kubeops.secretName" -}}
{{- include "kubeops.resourceName" (dict "root" . "suffix" "secret") -}}
{{- end }}

{{- define "kubeops.pvcPrefix" -}}
{{- include "kubeops.resourceName" (dict "root" . "suffix" "pvc") -}}
{{- end }}

{{- define "kubeops.backendConfigName" -}}
{{- default (include "kubeops.resourceName" (dict "root" . "suffix" "backendconfig")) .Values.ingress.gke.backendConfig.name -}}
{{- end }}

{{- define "kubeops.frontendConfigName" -}}
{{- default (include "kubeops.resourceName" (dict "root" . "suffix" "frontendconfig")) .Values.ingress.gke.frontendConfig.name -}}
{{- end }}

{{- define "kubeops.managedCertificateName" -}}
{{- default (include "kubeops.resourceName" (dict "root" . "suffix" "cert")) .Values.ingress.gke.managedCertificate.name -}}
{{- end }}

{{/*
Body of a PersistentVolumeClaim spec, shared by the standalone PVC objects, the
StatefulSet volumeClaimTemplates and generic ephemeral volumes.
*/}}
{{- define "kubeops.claimSpec" -}}
accessModes:
  {{- toYaml (default (list "ReadWriteOnce") .accessModes) | nindent 2 }}
volumeMode: {{ default "Filesystem" .volumeMode }}
resources:
  requests:
    storage: {{ default "8Gi" .size | quote }}
{{- if eq (default "" .storageClassName) "-" }}
storageClassName: ""
{{- else if .storageClassName }}
storageClassName: {{ .storageClassName | quote }}
{{- end }}
{{- with .selector }}
selector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .dataSource }}
dataSource:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .dataSourceRef }}
dataSourceRef:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/*
Every volume the pod mounts, assembled from the storage blocks. Under a
StatefulSet the primary volume is omitted here because volumeClaimTemplates
create one claim per replica instead. Extra claims are always shared objects.
*/}}
{{- define "kubeops.volumes" -}}
{{- if and .Values.persistence.enabled (ne .Values.workload.kind "StatefulSet") }}
- name: {{ .Values.persistence.name }}
  persistentVolumeClaim:
    claimName: {{ default (printf "%s-%s" (include "kubeops.pvcPrefix" .) .Values.persistence.name) .Values.persistence.existingClaim }}
    readOnly: {{ .Values.persistence.readOnly }}
{{- end }}
{{- range .Values.extraPersistentVolumeClaims }}
- name: {{ .name }}
  persistentVolumeClaim:
    claimName: {{ default (printf "%s-%s" (include "kubeops.pvcPrefix" $) .name) .existingClaim }}
    readOnly: {{ default false .readOnly }}
{{- end }}
{{- range .Values.storage.emptyDirs }}
- name: {{ .name }}
  emptyDir:
    {{- with .medium }}
    medium: {{ . }}
    {{- end }}
    {{- with .sizeLimit }}
    sizeLimit: {{ . }}
    {{- end }}
{{- end }}
{{- range .Values.storage.ephemeralVolumes }}
- name: {{ .name }}
  ephemeral:
    volumeClaimTemplate:
      {{- with .labels }}
      metadata:
        labels:
          {{- toYaml . | nindent 10 }}
      {{- end }}
      spec:
        {{- include "kubeops.claimSpec" . | nindent 8 }}
{{- end }}
{{- range .Values.storage.csiVolumes }}
- name: {{ .name }}
  csi:
    driver: {{ .driver }}
    readOnly: {{ default false .readOnly }}
    {{- with .fsType }}
    fsType: {{ . }}
    {{- end }}
    {{- with .volumeAttributes }}
    volumeAttributes:
      {{- range $key, $value := . }}
      {{ $key }}: {{ toString $value | quote }}
      {{- end }}
    {{- end }}
    {{- with .nodePublishSecretRef }}
    nodePublishSecretRef:
      {{- toYaml . | nindent 6 }}
    {{- end }}
{{- end }}
{{- if .Values.storage.allowHostPath }}
{{- range .Values.storage.hostPaths }}
- name: {{ .name }}
  hostPath:
    path: {{ .path }}
    {{- with .type }}
    type: {{ . }}
    {{- end }}
{{- end }}
{{- end }}
{{- if and .Values.configMap.enabled .Values.configMap.mountPath }}
- name: config
  configMap:
    name: {{ include "kubeops.configMapName" . }}
    defaultMode: {{ default 420 .Values.configMap.defaultMode }}
{{- end }}
{{- if and .Values.secret.enabled .Values.secret.mountPath }}
- name: secret
  secret:
    secretName: {{ include "kubeops.secretName" . }}
    defaultMode: {{ default 288 .Values.secret.defaultMode }}
{{- end }}
{{- if and .Values.externalSecret.enabled .Values.externalSecret.mountPath }}
- name: external-secret
  secret:
    secretName: {{ include "kubeops.externalSecretName" . }}
    defaultMode: {{ default 288 .Values.externalSecret.defaultMode }}
{{- end }}
{{- if .Values.secretsStore.enabled }}
- name: secrets-store
  csi:
    driver: secrets-store.csi.k8s.io
    readOnly: {{ .Values.secretsStore.readOnly }}
    volumeAttributes:
      secretProviderClass: {{ include "kubeops.secretProviderClassName" . }}
{{- end }}
{{- with .Values.volumes }}
{{- toYaml . }}
{{- end }}
{{- with .Values.extraVolumes }}
{{- toYaml . }}
{{- end }}
{{- end }}

{{/*
Mounts matching kubeops.volumes, in the same order.
*/}}
{{- define "kubeops.volumeMounts" -}}
{{- if .Values.persistence.enabled }}
- name: {{ .Values.persistence.name }}
  mountPath: {{ .Values.persistence.mountPath }}
  readOnly: {{ .Values.persistence.readOnly }}
  {{- with .Values.persistence.subPath }}
  subPath: {{ . }}
  {{- end }}
{{- end }}
{{- range .Values.extraPersistentVolumeClaims }}
- name: {{ .name }}
  mountPath: {{ .mountPath }}
  readOnly: {{ default false .readOnly }}
  {{- with .subPath }}
  subPath: {{ . }}
  {{- end }}
{{- end }}
{{- range .Values.storage.emptyDirs }}
- name: {{ .name }}
  mountPath: {{ .mountPath }}
  {{- with .subPath }}
  subPath: {{ . }}
  {{- end }}
{{- end }}
{{- range .Values.storage.ephemeralVolumes }}
- name: {{ .name }}
  mountPath: {{ .mountPath }}
  {{- with .subPath }}
  subPath: {{ . }}
  {{- end }}
{{- end }}
{{- range .Values.storage.csiVolumes }}
- name: {{ .name }}
  mountPath: {{ .mountPath }}
  readOnly: {{ default false .readOnly }}
{{- end }}
{{- if .Values.storage.allowHostPath }}
{{- range .Values.storage.hostPaths }}
- name: {{ .name }}
  mountPath: {{ .mountPath }}
  readOnly: {{ default true .readOnly }}
{{- end }}
{{- end }}
{{- if and .Values.configMap.enabled .Values.configMap.mountPath }}
- name: config
  mountPath: {{ .Values.configMap.mountPath }}
  {{- with .Values.configMap.subPath }}
  subPath: {{ . }}
  {{- end }}
  readOnly: true
{{- end }}
{{- if and .Values.secret.enabled .Values.secret.mountPath }}
- name: secret
  mountPath: {{ .Values.secret.mountPath }}
  readOnly: true
{{- end }}
{{- if and .Values.externalSecret.enabled .Values.externalSecret.mountPath }}
- name: external-secret
  mountPath: {{ .Values.externalSecret.mountPath }}
  readOnly: true
{{- end }}
{{- if .Values.secretsStore.enabled }}
- name: secrets-store
  mountPath: {{ .Values.secretsStore.mountPath }}
  readOnly: true
{{- end }}
{{- with .Values.volumeMounts }}
{{- toYaml . }}
{{- end }}
{{- with .Values.extraVolumeMounts }}
{{- toYaml . }}
{{- end }}
{{- end }}

{{/*
Container ports: the application port, an optional metrics port, and any extras.
*/}}
{{- define "kubeops.containerPorts" -}}
- name: http
  containerPort: {{ .Values.container.port }}
  protocol: TCP
{{- if .Values.metrics.enabled }}
- name: {{ .Values.metrics.portName }}
  containerPort: {{ .Values.metrics.port }}
  protocol: TCP
{{- end }}
{{- with .Values.container.extraPorts }}
{{- toYaml . }}
{{- end }}
{{- end }}

{{/*
envFrom sources: the raw list plus every configuration integration that opts in.
*/}}
{{- define "kubeops.envFrom" -}}
{{- with .Values.container.envFrom }}
{{- toYaml . }}
{{- end }}
{{- if and .Values.configMap.enabled .Values.configMap.asEnvFrom }}
- configMapRef:
    name: {{ include "kubeops.configMapName" . }}
{{- end }}
{{- if and .Values.secret.enabled .Values.secret.asEnvFrom }}
- secretRef:
    name: {{ include "kubeops.secretName" . }}
{{- end }}
{{- if and .Values.externalSecret.enabled .Values.externalSecret.asEnvFrom }}
- secretRef:
    name: {{ include "kubeops.externalSecretName" . }}
{{- end }}
{{- if .Values.secretsStore.enabled }}
{{- if .Values.secretsStore.asEnvFrom }}
{{- range .Values.secretsStore.secretObjects }}
- secretRef:
    name: {{ .secretName }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
An HTTP probe. Call with (dict "probe" .Values.probes.liveness).
*/}}
{{- define "kubeops.probe" -}}
httpGet:
  path: {{ .probe.path }}
  port: {{ default "http" .probe.port }}
  scheme: {{ default "HTTP" .probe.scheme }}
  {{- with .probe.httpHeaders }}
  httpHeaders:
    {{- toYaml . | nindent 4 }}
  {{- end }}
initialDelaySeconds: {{ default 0 .probe.initialDelaySeconds }}
periodSeconds: {{ default 10 .probe.periodSeconds }}
timeoutSeconds: {{ default 1 .probe.timeoutSeconds }}
failureThreshold: {{ default 3 .probe.failureThreshold }}
{{- with .probe.successThreshold }}
successThreshold: {{ . }}
{{- end }}
{{- end }}

{{/*
Pod annotations, including the content checksums that roll pods when mounted
configuration changes.
*/}}
{{- define "kubeops.podAnnotations" -}}
{{- $annotations := merge (dict) .Values.podAnnotations -}}
{{- if and .Values.configMap.enabled .Values.configMap.rollOnChange -}}
{{- $_ := set $annotations "checksum/configmap" (toYaml .Values.configMap | sha256sum) -}}
{{- end -}}
{{- if and .Values.secret.enabled .Values.secret.rollOnChange -}}
{{- $_ := set $annotations "checksum/secret" (toYaml .Values.secret | sha256sum) -}}
{{- end -}}
{{- if .Values.storage.gcsFuse.enabled -}}
{{- $_ := set $annotations "gke-gcsfuse/volumes" "true" -}}
{{- with .Values.storage.gcsFuse.cpuLimit }}{{- $_ := set $annotations "gke-gcsfuse/cpu-limit" . -}}{{- end -}}
{{- with .Values.storage.gcsFuse.memoryLimit }}{{- $_ := set $annotations "gke-gcsfuse/memory-limit" . -}}{{- end -}}
{{- with .Values.storage.gcsFuse.ephemeralStorageLimit }}{{- $_ := set $annotations "gke-gcsfuse/ephemeral-storage-limit" . -}}{{- end -}}
{{- end -}}
{{- if $annotations }}
{{- include "kubeops.renderAnnotations" $annotations }}
{{- end }}
{{- end }}

{{/*
Pod labels, including the opt-in Azure Workload Identity marker.
*/}}
{{- define "kubeops.podLabels" -}}
{{ include "kubeops.selectorLabels" . }}
{{- if .Values.serviceAccount.azure.clientId }}
azure.workload.identity/use: "true"
{{- end }}
{{- with .Values.podLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
ServiceAccount annotations, including cloud workload identity bindings.
*/}}
{{- define "kubeops.serviceAccountAnnotations" -}}
{{- $annotations := dict -}}
{{- with .Values.serviceAccount.aws.roleArn }}{{- $_ := set $annotations "eks.amazonaws.com/role-arn" . -}}{{- end -}}
{{- with .Values.serviceAccount.aws.audience }}{{- $_ := set $annotations "eks.amazonaws.com/audience" . -}}{{- end -}}
{{- with .Values.serviceAccount.gcp.serviceAccount }}{{- $_ := set $annotations "iam.gke.io/gcp-service-account" . -}}{{- end -}}
{{- with .Values.serviceAccount.azure.clientId }}{{- $_ := set $annotations "azure.workload.identity/client-id" . -}}{{- end -}}
{{- with .Values.serviceAccount.azure.tenantId }}{{- $_ := set $annotations "azure.workload.identity/tenant-id" . -}}{{- end -}}
{{- $annotations = mergeOverwrite $annotations (merge (dict) .Values.serviceAccount.annotations) -}}
{{- if $annotations }}
{{- include "kubeops.renderAnnotations" $annotations }}
{{- end }}
{{- end }}

{{/*
Service annotations. Provider blocks contribute defaults; anything set in
service.annotations wins.
*/}}
{{- define "kubeops.serviceAnnotations" -}}
{{- $annotations := dict -}}
{{- $nlb := .Values.service.aws.nlb -}}
{{- if and $nlb.enabled (eq .Values.service.type "LoadBalancer") -}}
{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-type" "external" -}}
{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-nlb-target-type" $nlb.targetType -}}
{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-scheme" $nlb.scheme -}}
{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-ip-address-type" $nlb.ipAddressType -}}
{{- $attributes := merge (dict) $nlb.attributes -}}
{{- if $nlb.crossZone -}}
{{- $_ := set $attributes "load_balancing.cross_zone.enabled" "true" -}}
{{- end -}}
{{- if $attributes -}}
{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-attributes" (include "kubeops.keyValueList" $attributes) -}}
{{- end -}}
{{- with $nlb.subnets }}{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-subnets" (include "kubeops.commaList" .) -}}{{- end -}}
{{- with $nlb.securityGroups }}{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-security-groups" (include "kubeops.commaList" .) -}}{{- end -}}
{{- with $nlb.certificateArn }}{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-ssl-cert" . -}}{{- end -}}
{{- with $nlb.sslPorts }}{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-ssl-ports" . -}}{{- end -}}
{{- with $nlb.backendProtocol }}{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-backend-protocol" . -}}{{- end -}}
{{- if $nlb.proxyProtocolV2 }}{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-proxy-protocol" "*" -}}{{- end -}}
{{- with $nlb.healthcheckProtocol }}{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-healthcheck-protocol" . -}}{{- end -}}
{{- with $nlb.healthcheckPath }}{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-healthcheck-path" . -}}{{- end -}}
{{- with $nlb.healthcheckPort }}{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-healthcheck-port" . -}}{{- end -}}
{{- with $nlb.eipAllocations }}{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-eip-allocations" (include "kubeops.commaList" .) -}}{{- end -}}
{{- with $nlb.tags }}{{- $_ := set $annotations "service.beta.kubernetes.io/aws-load-balancer-additional-resource-tags" (include "kubeops.keyValueList" .) -}}{{- end -}}
{{- end -}}
{{- $neg := .Values.service.gcp.neg -}}
{{- if $neg.enabled -}}
{{- $negConfig := dict -}}
{{- if $neg.ingress }}{{- $_ := set $negConfig "ingress" true -}}{{- end -}}
{{- with $neg.exposedPorts }}{{- $_ := set $negConfig "exposed_ports" . -}}{{- end -}}
{{- $_ := set $annotations "cloud.google.com/neg" (toJson $negConfig) -}}
{{- end -}}
{{- if .Values.service.gcp.backendConfig.enabled -}}
{{- $backendConfig := default (include "kubeops.backendConfigName" .) .Values.service.gcp.backendConfig.name -}}
{{- $_ := set $annotations "cloud.google.com/backend-config" (toJson (dict "default" $backendConfig)) -}}
{{- end -}}
{{- $gcpILB := .Values.service.gcp.internalLoadBalancer -}}
{{- if eq .Values.service.type "LoadBalancer" -}}
{{- if $gcpILB.enabled -}}
{{- $_ := set $annotations "networking.gke.io/load-balancer-type" "Internal" -}}
{{- with $gcpILB.subnet }}{{- $_ := set $annotations "networking.gke.io/internal-load-balancer-subnet" . -}}{{- end -}}
{{- if $gcpILB.globalAccess }}{{- $_ := set $annotations "networking.gke.io/internal-load-balancer-allow-global-access" "true" -}}{{- end -}}
{{- end -}}
{{- $azureLB := .Values.service.azure.loadBalancer -}}
{{- if $azureLB.internal -}}
{{- $_ := set $annotations "service.beta.kubernetes.io/azure-load-balancer-internal" "true" -}}
{{- end -}}
{{- with $azureLB.internalSubnet }}{{- $_ := set $annotations "service.beta.kubernetes.io/azure-load-balancer-internal-subnet" . -}}{{- end -}}
{{- with $azureLB.resourceGroup }}{{- $_ := set $annotations "service.beta.kubernetes.io/azure-load-balancer-resource-group" . -}}{{- end -}}
{{- with $azureLB.pipName }}{{- $_ := set $annotations "service.beta.kubernetes.io/azure-pip-name" . -}}{{- end -}}
{{- with $azureLB.dnsLabelName }}{{- $_ := set $annotations "service.beta.kubernetes.io/azure-dns-label-name" . -}}{{- end -}}
{{- with $azureLB.healthProbeRequestPath }}{{- $_ := set $annotations "service.beta.kubernetes.io/azure-load-balancer-health-probe-request-path" . -}}{{- end -}}
{{- end -}}
{{- $annotations = mergeOverwrite $annotations (merge (dict) .Values.service.annotations) -}}
{{- if $annotations }}
{{- include "kubeops.renderAnnotations" $annotations }}
{{- end }}
{{- end }}

{{/*
Ingress annotations. Provider blocks contribute defaults; anything set in
ingress.annotations wins.
*/}}
{{- define "kubeops.ingressAnnotations" -}}
{{- $annotations := dict -}}
{{- $aws := .Values.ingress.aws -}}
{{- if $aws.enabled -}}
{{- $_ := set $annotations "alb.ingress.kubernetes.io/scheme" $aws.scheme -}}
{{- $_ := set $annotations "alb.ingress.kubernetes.io/target-type" $aws.targetType -}}
{{- $_ := set $annotations "alb.ingress.kubernetes.io/ip-address-type" $aws.ipAddressType -}}
{{- with $aws.listenPorts }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/listen-ports" . -}}{{- end -}}
{{- with $aws.certificateArn }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/certificate-arn" . -}}{{- end -}}
{{- with $aws.sslRedirect }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/ssl-redirect" . -}}{{- end -}}
{{- with $aws.sslPolicy }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/ssl-policy" . -}}{{- end -}}
{{- with $aws.groupName }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/group.name" . -}}{{- end -}}
{{- with $aws.groupOrder }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/group.order" . -}}{{- end -}}
{{- with $aws.loadBalancerName }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/load-balancer-name" . -}}{{- end -}}
{{- with $aws.subnets }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/subnets" (include "kubeops.commaList" .) -}}{{- end -}}
{{- with $aws.securityGroups }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/security-groups" (include "kubeops.commaList" .) -}}{{- end -}}
{{- with $aws.inboundCidrs }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/inbound-cidrs" (include "kubeops.commaList" .) -}}{{- end -}}
{{- with $aws.backendProtocol }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/backend-protocol" . -}}{{- end -}}
{{- with $aws.healthcheckPath }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/healthcheck-path" . -}}{{- end -}}
{{- with $aws.healthcheckPort }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/healthcheck-port" . -}}{{- end -}}
{{- with $aws.healthcheckProtocol }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/healthcheck-protocol" . -}}{{- end -}}
{{- with $aws.healthcheckIntervalSeconds }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/healthcheck-interval-seconds" . -}}{{- end -}}
{{- with $aws.healthcheckTimeoutSeconds }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/healthcheck-timeout-seconds" . -}}{{- end -}}
{{- with $aws.successCodes }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/success-codes" . -}}{{- end -}}
{{- with $aws.wafv2AclArn }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/wafv2-acl-arn" . -}}{{- end -}}
{{- if kindIs "bool" $aws.shieldAdvancedProtection }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/shield-advanced-protection" $aws.shieldAdvancedProtection -}}{{- end -}}
{{- with $aws.targetGroupAttributes }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/target-group-attributes" (include "kubeops.keyValueList" .) -}}{{- end -}}
{{- with $aws.loadBalancerAttributes }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/load-balancer-attributes" (include "kubeops.keyValueList" .) -}}{{- end -}}
{{- with $aws.tags }}{{- $_ := set $annotations "alb.ingress.kubernetes.io/tags" (include "kubeops.keyValueList" .) -}}{{- end -}}
{{- end -}}
{{- $gke := .Values.ingress.gke -}}
{{- if $gke.enabled -}}
{{- with $gke.globalStaticIpName }}{{- $_ := set $annotations "kubernetes.io/ingress.global-static-ip-name" . -}}{{- end -}}
{{- with $gke.regionalStaticIpName }}{{- $_ := set $annotations "kubernetes.io/ingress.regional-static-ip-name" . -}}{{- end -}}
{{- with $gke.preSharedCerts }}{{- $_ := set $annotations "ingress.gcp.kubernetes.io/pre-shared-cert" (include "kubeops.commaList" .) -}}{{- end -}}
{{- if $gke.managedCertificate.enabled -}}
{{- $_ := set $annotations "networking.gke.io/managed-certificates" (include "kubeops.managedCertificateName" .) -}}
{{- end -}}
{{- if $gke.frontendConfig.enabled -}}
{{- $_ := set $annotations "networking.gke.io/v1beta1.FrontendConfig" (include "kubeops.frontendConfigName" .) -}}
{{- end -}}
{{- end -}}
{{- $azure := .Values.ingress.azure -}}
{{- if $azure.appRouting.enabled -}}
{{- with $azure.appRouting.tlsCertKeyVaultUri }}{{- $_ := set $annotations "kubernetes.azure.com/tls-cert-keyvault-uri" . -}}{{- end -}}
{{- end -}}
{{- if $azure.agic.enabled -}}
{{- $_ := set $annotations "appgw.ingress.kubernetes.io/ssl-redirect" (toString $azure.agic.sslRedirect) -}}
{{- $_ := set $annotations "appgw.ingress.kubernetes.io/use-private-ip" (toString $azure.agic.usePrivateIp) -}}
{{- with $azure.agic.backendPathPrefix }}{{- $_ := set $annotations "appgw.ingress.kubernetes.io/backend-path-prefix" . -}}{{- end -}}
{{- with $azure.agic.backendProtocol }}{{- $_ := set $annotations "appgw.ingress.kubernetes.io/backend-protocol" . -}}{{- end -}}
{{- with $azure.agic.backendHostname }}{{- $_ := set $annotations "appgw.ingress.kubernetes.io/backend-hostname" . -}}{{- end -}}
{{- with $azure.agic.healthProbePath }}{{- $_ := set $annotations "appgw.ingress.kubernetes.io/health-probe-path" . -}}{{- end -}}
{{- with $azure.agic.wafPolicyResourceId }}{{- $_ := set $annotations "appgw.ingress.kubernetes.io/waf-policy-for-path" . -}}{{- end -}}
{{- with $azure.agic.requestTimeout }}{{- $_ := set $annotations "appgw.ingress.kubernetes.io/request-timeout" . -}}{{- end -}}
{{- if $azure.agic.connectionDraining.enabled -}}
{{- $_ := set $annotations "appgw.ingress.kubernetes.io/connection-draining" "true" -}}
{{- $_ := set $annotations "appgw.ingress.kubernetes.io/connection-draining-timeout" $azure.agic.connectionDraining.timeout -}}
{{- end -}}
{{- end -}}
{{- if .Values.ingress.certManager.enabled -}}
{{- if eq .Values.ingress.certManager.issuerKind "ClusterIssuer" -}}
{{- $_ := set $annotations "cert-manager.io/cluster-issuer" .Values.ingress.certManager.issuerName -}}
{{- else -}}
{{- $_ := set $annotations "cert-manager.io/issuer" .Values.ingress.certManager.issuerName -}}
{{- end -}}
{{- $annotations = mergeOverwrite $annotations (merge (dict) .Values.ingress.certManager.annotations) -}}
{{- end -}}
{{- $annotations = mergeOverwrite $annotations (merge (dict) .Values.ingress.annotations) -}}
{{- if $annotations }}
{{- include "kubeops.renderAnnotations" $annotations }}
{{- end }}
{{- end }}

{{/*
Fail fast on value combinations that render valid YAML but cannot work on a real
cluster. A clear message here beats a stuck rollout later.
*/}}
{{- define "kubeops.validate" -}}
{{- if not (has .Values.workload.kind (list "Deployment" "StatefulSet")) -}}
{{- fail (printf "workload.kind must be Deployment or StatefulSet, got %q" .Values.workload.kind) -}}
{{- end -}}
{{- if and (not .Values.image.tag) (not .Values.image.digest) (not .Chart.AppVersion) -}}
{{- fail "set image.tag or image.digest" -}}
{{- end -}}
{{- if .Values.ingress.enabled -}}
{{- if and (not .Values.ingress.hosts) (not .Values.ingress.defaultBackend) -}}
{{- fail "ingress.enabled requires ingress.hosts or ingress.defaultBackend" -}}
{{- end -}}
{{- if and .Values.ingress.aws.enabled (eq .Values.ingress.aws.targetType "instance") (eq .Values.service.type "ClusterIP") -}}
{{- fail "ingress.aws.targetType=instance routes through node ports: set service.type=NodePort, or keep targetType=ip to target pods directly" -}}
{{- end -}}
{{- if and .Values.ingress.gke.enabled (eq .Values.service.type "ClusterIP") (not .Values.service.gcp.neg.enabled) -}}
{{- fail "GKE Ingress cannot reach a plain ClusterIP Service: set service.gcp.neg.enabled=true for container-native load balancing, or set service.type=NodePort" -}}
{{- end -}}
{{- if and .Values.ingress.gke.managedCertificate.enabled (not .Values.ingress.gke.managedCertificate.domains) -}}
{{- fail "ingress.gke.managedCertificate.enabled requires ingress.gke.managedCertificate.domains" -}}
{{- end -}}
{{- if and .Values.ingress.certManager.enabled (not .Values.ingress.tls) -}}
{{- fail "ingress.certManager.enabled requires ingress.tls entries naming the Secret cert-manager should fill" -}}
{{- end -}}
{{- end -}}
{{- if .Values.persistence.enabled -}}
{{- $shared := or (has "ReadWriteMany" .Values.persistence.accessModes) (has "ReadOnlyMany" .Values.persistence.accessModes) -}}
{{- if eq .Values.workload.kind "Deployment" -}}
{{- if and (or .Values.autoscaling.enabled (gt (int .Values.replicaCount) 1)) (not $shared) -}}
{{- fail "a single-writer volume cannot back more than one Deployment replica: use workload.kind=StatefulSet for a volume per replica, or a ReadWriteMany class such as EFS, Azure Files or Filestore" -}}
{{- end -}}
{{- if and (not $shared) (ne .Values.deploymentStrategy.type "Recreate") -}}
{{- fail "a single-writer volume needs deploymentStrategy.type=Recreate, because a rolling update starts the new pod before the old one releases the volume" -}}
{{- end -}}
{{- else if .Values.persistence.existingClaim -}}
{{- fail "persistence.existingClaim cannot be combined with workload.kind=StatefulSet, which provisions one claim per replica" -}}
{{- end -}}
{{- end -}}
{{- $multiReplica := or .Values.autoscaling.enabled (gt (int .Values.replicaCount) 1) -}}
{{- range .Values.extraPersistentVolumeClaims -}}
{{- $modes := default (list "ReadWriteOnce") .accessModes -}}
{{- if and $multiReplica (not (or (has "ReadWriteMany" $modes) (has "ReadOnlyMany" $modes))) -}}
{{- fail (printf "extraPersistentVolumeClaims entry %q is a shared claim mounted by every replica, so it needs ReadWriteMany or ReadOnlyMany; move per-replica storage to `persistence` under a StatefulSet instead" .name) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.storage.hostPaths (not .Values.storage.allowHostPath) -}}
{{- fail "storage.hostPaths bypasses the storage stack and pins pods to nodes: set storage.allowHostPath=true to confirm" -}}
{{- end -}}
{{- if .Values.secretsStore.enabled -}}
{{- if not (has .Values.secretsStore.provider (list "aws" "azure" "gcp" "vault")) -}}
{{- fail (printf "secretsStore.provider must be aws, azure, gcp or vault, got %q" .Values.secretsStore.provider) -}}
{{- end -}}
{{- end -}}
{{- if .Values.externalSecret.enabled -}}
{{- if not .Values.externalSecret.secretStoreRef.name -}}
{{- fail "externalSecret.enabled requires externalSecret.secretStoreRef.name" -}}
{{- end -}}
{{- if and (not .Values.externalSecret.data) (not .Values.externalSecret.dataFrom) -}}
{{- fail "externalSecret.enabled requires externalSecret.data or externalSecret.dataFrom" -}}
{{- end -}}
{{- end -}}
{{- if .Values.serviceAccount.azure.clientId -}}
{{- if not (or .Values.serviceAccount.create .Values.serviceAccount.name) -}}
{{- fail "Azure Workload Identity needs a dedicated ServiceAccount: set serviceAccount.create=true or serviceAccount.name" -}}
{{- end -}}
{{- end -}}
{{- if and .Values.httpRoute.enabled (not .Values.httpRoute.parentRefs) -}}
{{- fail "httpRoute.enabled requires httpRoute.parentRefs naming the Gateway to attach to" -}}
{{- end -}}
{{- if .Values.podDisruptionBudget.enabled -}}
{{- if not (or .Values.podDisruptionBudget.minAvailable .Values.podDisruptionBudget.maxUnavailable) -}}
{{- fail "podDisruptionBudget.enabled requires minAvailable or maxUnavailable" -}}
{{- end -}}
{{- end -}}
{{- end }}

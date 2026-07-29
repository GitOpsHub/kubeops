{{/*
The pod template shared by the Deployment and the StatefulSet, so both workload
kinds stay identical apart from their volume handling.
*/}}
{{- define "kubeops.podTemplate" -}}
metadata:
  {{- with (include "kubeops.podAnnotations" . | trim) }}
  annotations:
    {{- . | nindent 4 }}
  {{- end }}
  labels:
    {{- include "kubeops.podLabels" . | nindent 4 }}
spec:
  terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}
  serviceAccountName: {{ include "kubeops.serviceAccountName" . }}
  automountServiceAccountToken: {{ .Values.serviceAccount.automount }}
  {{- with .Values.restartPolicy }}
  restartPolicy: {{ . }}
  {{- end }}
  {{- with .Values.priorityClassName }}
  priorityClassName: {{ . }}
  {{- end }}
  {{- with .Values.runtimeClassName }}
  runtimeClassName: {{ . }}
  {{- end }}
  {{- with .Values.schedulerName }}
  schedulerName: {{ . }}
  {{- end }}
  {{- with .Values.dnsPolicy }}
  dnsPolicy: {{ . }}
  {{- end }}
  {{- with .Values.dnsConfig }}
  dnsConfig:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.hostAliases }}
  hostAliases:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.imagePullSecrets }}
  imagePullSecrets:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  securityContext:
    {{- toYaml .Values.podSecurityContext | nindent 4 }}
  {{- with .Values.initContainers }}
  initContainers:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  containers:
    - name: application
      image: {{ include "kubeops.image" . | quote }}
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      securityContext:
        {{- toYaml .Values.securityContext | nindent 8 }}
      {{- with .Values.container.command }}
      command:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.container.args }}
      args:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.container.env }}
      env:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with (include "kubeops.envFrom" . | trim) }}
      envFrom:
        {{- . | nindent 8 }}
      {{- end }}
      ports:
        {{- include "kubeops.containerPorts" . | nindent 8 }}
      {{- if .Values.probes.startup.enabled }}
      startupProbe:
        {{- include "kubeops.probe" (dict "probe" .Values.probes.startup) | nindent 8 }}
      {{- end }}
      {{- if .Values.probes.liveness.enabled }}
      livenessProbe:
        {{- include "kubeops.probe" (dict "probe" .Values.probes.liveness) | nindent 8 }}
      {{- end }}
      {{- if .Values.probes.readiness.enabled }}
      readinessProbe:
        {{- include "kubeops.probe" (dict "probe" .Values.probes.readiness) | nindent 8 }}
      {{- end }}
      {{- with .Values.container.lifecycle }}
      lifecycle:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      resources:
        {{- toYaml .Values.resources | nindent 8 }}
      {{- with (include "kubeops.volumeMounts" . | trim) }}
      volumeMounts:
        {{- . | nindent 8 }}
      {{- end }}
    {{- with .Values.sidecars }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- with (include "kubeops.volumes" . | trim) }}
  volumes:
    {{- . | nindent 4 }}
  {{- end }}
  {{- with .Values.nodeSelector }}
  nodeSelector:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.affinity }}
  affinity:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.tolerations }}
  tolerations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.topologySpreadConstraints }}
  topologySpreadConstraints:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}

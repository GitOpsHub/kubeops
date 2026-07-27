package model

import "time"

const (
	ProviderAWS      = "aws"
	ProviderGCP      = "gcp"
	ProviderAzure    = "azure"
	ProviderDocker   = "docker"
	ProviderMinikube = "minikube"
)

type CloudSource struct {
	ID                        string   `json:"id" yaml:"id"`
	Provider                  string   `json:"provider" yaml:"provider"`
	Name                      string   `json:"name" yaml:"name"`
	ScopeID                   string   `json:"scopeId" yaml:"scope_id"`
	Regions                   []string `json:"regions" yaml:"regions"`
	Enabled                   bool     `json:"enabled" yaml:"enabled"`
	RoleARN                   string   `json:"-" yaml:"role_arn,omitempty"`
	ImpersonateServiceAccount string   `json:"-" yaml:"impersonate_service_account,omitempty"`
	TenantID                  string   `json:"-" yaml:"tenant_id,omitempty"`
	KubeconfigPath            string   `json:"-" yaml:"kubeconfig_path,omitempty"`
	Contexts                  []string `json:"-" yaml:"contexts,omitempty"`
}

type SourceSummary struct {
	CloudSource
	ClusterCount   int        `json:"clusterCount"`
	LastSyncStatus string     `json:"lastSyncStatus"`
	LastSyncAt     *time.Time `json:"lastSyncAt"`
	LastSyncError  string     `json:"lastSyncError,omitempty"`
}

type Cluster struct {
	ID                 string         `json:"id"`
	SourceID           string         `json:"sourceId"`
	SourceName         string         `json:"sourceName,omitempty"`
	Provider           string         `json:"provider"`
	ProviderResourceID string         `json:"providerResourceId"`
	Name               string         `json:"name"`
	Location           string         `json:"location"`
	KubernetesVersion  string         `json:"kubernetesVersion"`
	Status             string         `json:"status"`
	EndpointAccess     string         `json:"endpointAccess"`
	NodeCount          *int32         `json:"nodeCount"`
	Metadata           map[string]any `json:"metadata"`
	FirstSeenAt        time.Time      `json:"firstSeenAt"`
	LastSeenAt         time.Time      `json:"lastSeenAt"`
	UpdatedAt          time.Time      `json:"updatedAt"`
	RemovedAt          *time.Time     `json:"removedAt"`
}

type ClusterFilter struct {
	Provider       string
	SourceID       string
	Status         string
	Search         string
	IncludeRemoved bool
	Page           int
	PageSize       int
}

type ClusterPage struct {
	Items    []Cluster `json:"items"`
	Total    int       `json:"total"`
	Page     int       `json:"page"`
	PageSize int       `json:"pageSize"`
}

type SyncRun struct {
	ID              string     `json:"id"`
	SourceID        string     `json:"sourceId"`
	SourceName      string     `json:"sourceName,omitempty"`
	Provider        string     `json:"provider,omitempty"`
	Trigger         string     `json:"trigger"`
	Status          string     `json:"status"`
	DiscoveredCount int        `json:"discoveredCount"`
	ChangedCount    int        `json:"changedCount"`
	RemovedCount    int        `json:"removedCount"`
	Error           string     `json:"error,omitempty"`
	QueuedAt        time.Time  `json:"queuedAt"`
	StartedAt       *time.Time `json:"startedAt"`
	CompletedAt     *time.Time `json:"completedAt"`
}

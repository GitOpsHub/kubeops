package model

import "time"

const (
	ProviderAWS      = "aws"
	ProviderGCP      = "gcp"
	ProviderAzure    = "azure"
	ProviderDocker   = "docker"
	ProviderMinikube = "minikube"
)

const (
	OnboardingProgressing = "progressing"
	OnboardingHealthy     = "healthy"
	OnboardingPartial     = "partial"
	OnboardingFailed      = "failed"
	OnboardingOffboarded  = "offboarded"
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

type ClusterCapability struct {
	CanScaleNodes bool   `json:"canScaleNodes"`
	Reason        string `json:"reason,omitempty"`
}

type NodePool struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	DesiredCount      int32    `json:"desiredCount"`
	MinCount          *int32   `json:"minCount"`
	MaxCount          *int32   `json:"maxCount"`
	Autoscaling       string   `json:"autoscaling"`
	Status            string   `json:"status"`
	MachineType       string   `json:"machineType,omitempty"`
	Zones             []string `json:"zones"`
	Scalable          bool     `json:"scalable"`
	UnavailableReason string   `json:"unavailableReason,omitempty"`
}

type AWSNetworking struct {
	VPCID                      string   `json:"vpcId,omitempty"`
	SubnetIDs                  []string `json:"subnetIds"`
	ClusterSecurityGroupID     string   `json:"clusterSecurityGroupId,omitempty"`
	AdditionalSecurityGroupIDs []string `json:"additionalSecurityGroupIds"`
	PublicAccessCIDRs          []string `json:"publicAccessCidrs"`
	IPFamily                   string   `json:"ipFamily,omitempty"`
	ServiceIPv4CIDR            string   `json:"serviceIpv4Cidr,omitempty"`
	ServiceIPv6CIDR            string   `json:"serviceIpv6Cidr,omitempty"`
}

type GCPNetworking struct {
	Network              string   `json:"network,omitempty"`
	Subnetwork           string   `json:"subnetwork,omitempty"`
	PodCIDRs             []string `json:"podCidrs"`
	ServiceCIDRs         []string `json:"serviceCidrs"`
	ControlPlaneIPv4CIDR string   `json:"controlPlaneIpv4Cidr,omitempty"`
	PrivateNodes         bool     `json:"privateNodes"`
	PrivateEndpoint      bool     `json:"privateEndpoint"`
	DatapathProvider     string   `json:"datapathProvider,omitempty"`
	NetworkPolicyEnabled bool     `json:"networkPolicyEnabled"`
}

type AzureNetworking struct {
	SubnetIDs        []string `json:"subnetIds"`
	PodSubnetIDs     []string `json:"podSubnetIds"`
	NetworkPlugin    string   `json:"networkPlugin,omitempty"`
	NetworkMode      string   `json:"networkMode,omitempty"`
	NetworkPolicy    string   `json:"networkPolicy,omitempty"`
	NetworkDataplane string   `json:"networkDataplane,omitempty"`
	PodCIDRs         []string `json:"podCidrs"`
	ServiceCIDRs     []string `json:"serviceCidrs"`
	DNSServiceIP     string   `json:"dnsServiceIp,omitempty"`
	OutboundType     string   `json:"outboundType,omitempty"`
	LoadBalancerSKU  string   `json:"loadBalancerSku,omitempty"`
	PrivateDNSZone   string   `json:"privateDnsZone,omitempty"`
}

type LocalNetworking struct {
	APIServer string `json:"apiServer,omitempty"`
}

type ClusterNetworking struct {
	Provider       string           `json:"provider"`
	EndpointAccess string           `json:"endpointAccess"`
	AWS            *AWSNetworking   `json:"aws,omitempty"`
	GCP            *GCPNetworking   `json:"gcp,omitempty"`
	Azure          *AzureNetworking `json:"azure,omitempty"`
	Local          *LocalNetworking `json:"local,omitempty"`
}

type ClusterDetails struct {
	Cluster    Cluster           `json:"cluster"`
	Capability ClusterCapability `json:"capability"`
	NodePools  []NodePool        `json:"nodePools"`
	Networking ClusterNetworking `json:"networking"`
}

type ArgoAccess struct {
	URL string `json:"url"`
}

type EncryptedArgoAccess struct {
	SourceID           string
	ProviderResourceID string
	URL                string
	Username           string
	PasswordCiphertext []byte
	PasswordNonce      []byte
}

type ScaleResult struct {
	NodePoolID          string `json:"nodePoolId"`
	DesiredCount        int32  `json:"desiredCount"`
	Status              string `json:"status"`
	ProviderOperationID string `json:"providerOperationId,omitempty"`
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

type ApplicationOnboarding struct {
	ID                       string                  `json:"id"`
	Name                     string                  `json:"name"`
	Namespace                string                  `json:"namespace"`
	Environment              string                  `json:"environment"`
	Region                   string                  `json:"region"`
	ChartRepoURL             string                  `json:"chartRepoUrl"`
	ChartName                string                  `json:"chartName"`
	ChartRevision            string                  `json:"chartRevision"`
	Image                    string                  `json:"image"`
	ValuesDigest             string                  `json:"valuesDigest"`
	ValuesRepositoryURL      string                  `json:"valuesRepositoryUrl"`
	ValuesRepositoryCloneURL string                  `json:"valuesRepositoryCloneUrl,omitempty"`
	ValuesRepositoryName     string                  `json:"valuesRepositoryName"`
	ValuesRevision           string                  `json:"valuesRevision"`
	ValuesCommitSHA          string                  `json:"valuesCommitSha"`
	Status                   string                  `json:"status"`
	Targets                  []ApplicationDeployment `json:"targets"`
	CreatedAt                time.Time               `json:"createdAt"`
	UpdatedAt                time.Time               `json:"updatedAt"`
	CompletedAt              *time.Time              `json:"completedAt"`
}

type ApplicationDeployment struct {
	ID                 string `json:"id"`
	OnboardingID       string `json:"onboardingId"`
	ClusterID          string `json:"clusterId"`
	ClusterName        string `json:"clusterName"`
	Region             string `json:"region"`
	SourceID           string `json:"sourceId"`
	ProviderResourceID string `json:"providerResourceId"`
	ArgoApplication    string `json:"argoApplication"`
	HasRegionValues    bool   `json:"hasRegionValues"`
	// ArgoApplicationURL and ArgoUsername are derived from the configured Argo CD
	// target and stay empty when that target exposes no UI access.
	ArgoApplicationURL string     `json:"argoApplicationUrl,omitempty"`
	ArgoUsername       string     `json:"argoUsername,omitempty"`
	Status             string     `json:"status"`
	SyncStatus         string     `json:"syncStatus"`
	HealthStatus       string     `json:"healthStatus"`
	Message            string     `json:"message,omitempty"`
	CreatedAt          time.Time  `json:"createdAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`
	CompletedAt        *time.Time `json:"completedAt"`
	// AttemptStartedAt marks when the current deployment attempt began. It is set
	// at creation and reset by every sync, so the deployment timeout measures the
	// attempt in flight rather than the age of the target.
	AttemptStartedAt time.Time `json:"attemptStartedAt"`
}

type ApplicationOnboardingFilter struct {
	Search   string
	Status   string
	Page     int
	PageSize int
}

type ApplicationOnboardingPage struct {
	Items    []ApplicationOnboarding `json:"items"`
	Total    int                     `json:"total"`
	Page     int                     `json:"page"`
	PageSize int                     `json:"pageSize"`
}

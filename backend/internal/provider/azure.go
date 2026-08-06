package provider

import (
	"context"
	"fmt"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/containerservice/armcontainerservice/v9"
	"github.com/GitOpsHub/kubeops/backend/internal/cloudauth"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

// Azure discovers and manages AKS clusters. Identity, when set, presents an
// OIDC token as a client assertion so no client secret is needed.
type Azure struct {
	Identity cloudauth.TokenSource
}

func (a Azure) Discover(ctx context.Context, source model.CloudSource) ([]model.Cluster, error) {
	credential, err := cloudauth.AzureCredential(ctx, a.Identity, source)
	if err != nil {
		return nil, err
	}
	client, err := armcontainerservice.NewManagedClustersClient(source.ScopeID, credential, nil)
	if err != nil {
		return nil, fmt.Errorf("create AKS client: %w", err)
	}

	pager := client.NewListPager(nil)
	clusters := make([]model.Cluster, 0)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list AKS clusters for subscription %s: %w", source.ScopeID, err)
		}
		for _, value := range page.Value {
			if value == nil {
				continue
			}
			clusters = append(clusters, normalizeAKSCluster(source, value))
		}
	}
	return clusters, nil
}

func normalizeAKSCluster(source model.CloudSource, value *armcontainerservice.ManagedCluster) model.Cluster {
	properties := value.Properties
	var nodeCount int32
	hasNodeCount := false
	version := ""
	status := "unknown"
	endpointAccess := "unknown"
	metadata := map[string]any{"tags": stringMap(value.Tags)}
	if properties != nil {
		for _, pool := range properties.AgentPoolProfiles {
			if pool != nil && pool.Count != nil {
				nodeCount += *pool.Count
				hasNodeCount = true
			}
		}
		version = stringValue(properties.CurrentKubernetesVersion)
		if version == "" {
			version = stringValue(properties.KubernetesVersion)
		}
		status = strings.ToLower(stringValue(properties.ProvisioningState))
		if properties.APIServerAccessProfile != nil &&
			boolValue(properties.APIServerAccessProfile.EnablePrivateCluster) {
			endpointAccess = EndpointAccess(
				boolValue(properties.APIServerAccessProfile.EnablePrivateClusterPublicFQDN),
				true,
			)
		} else {
			endpointAccess = EndpointAccess(true, false)
		}
		metadata["nodeResourceGroup"] = stringValue(properties.NodeResourceGroup)
		metadata["powerState"] = properties.PowerState
	}

	resourceID := stringValue(value.ID)
	if resourceID == "" {
		resourceID = fmt.Sprintf("/subscriptions/%s/providers/Microsoft.ContainerService/managedClusters/%s",
			source.ScopeID, stringValue(value.Name))
	}
	var nodeCountValue *int32
	if hasNodeCount {
		nodeCountValue = &nodeCount
	}
	return model.Cluster{
		SourceID:           source.ID,
		Provider:           model.ProviderAzure,
		ProviderResourceID: resourceID,
		Name:               stringValue(value.Name),
		Location:           stringValue(value.Location),
		KubernetesVersion:  version,
		Status:             status,
		EndpointAccess:     endpointAccess,
		NodeCount:          nodeCountValue,
		Metadata:           metadata,
	}
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func boolValue(value *bool) bool {
	return value != nil && *value
}

func stringMap(values map[string]*string) map[string]string {
	result := make(map[string]string, len(values))
	for key, value := range values {
		result[key] = stringValue(value)
	}
	return result
}

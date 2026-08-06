package provider

import (
	"context"
	"fmt"
	"strings"

	"cloud.google.com/go/container/apiv1"
	"cloud.google.com/go/container/apiv1/containerpb"
	"github.com/GitOpsHub/kubeops/backend/internal/cloudauth"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

// GCP discovers and manages GKE clusters. Identity, when set, federates an OIDC
// token through Workload Identity Federation so no service account key is
// needed.
type GCP struct {
	Identity cloudauth.TokenSource
}

func (g GCP) client(ctx context.Context, source model.CloudSource) (*container.ClusterManagerClient, error) {
	options, err := cloudauth.GCPClientOptions(ctx, g.Identity, source)
	if err != nil {
		return nil, err
	}
	client, err := container.NewClusterManagerClient(ctx, options...)
	if err != nil {
		return nil, fmt.Errorf("create GKE client: %w", err)
	}
	return client, nil
}

func (g GCP) Discover(ctx context.Context, source model.CloudSource) ([]model.Cluster, error) {
	client, err := g.client(ctx, source)
	if err != nil {
		return nil, err
	}
	defer client.Close()

	response, err := client.ListClusters(ctx, &containerpb.ListClustersRequest{
		Parent: fmt.Sprintf("projects/%s/locations/-", source.ScopeID),
	})
	if err != nil {
		return nil, fmt.Errorf("list GKE clusters for project %s: %w", source.ScopeID, err)
	}

	clusters := make([]model.Cluster, 0, len(response.Clusters))
	for _, value := range response.Clusters {
		if value == nil {
			continue
		}
		location := value.Location
		if location == "" {
			location = value.Zone
		}
		resourceID := value.SelfLink
		if resourceID == "" {
			resourceID = fmt.Sprintf("projects/%s/locations/%s/clusters/%s", source.ScopeID, location, value.Name)
		}
		endpointAccess := EndpointAccess(true, false)
		if value.PrivateClusterConfig != nil && value.PrivateClusterConfig.EnablePrivateEndpoint {
			endpointAccess = EndpointAccess(false, true)
		}
		nodeCount := value.CurrentNodeCount
		releaseChannel := ""
		if value.ReleaseChannel != nil {
			releaseChannel = value.ReleaseChannel.Channel.String()
		}

		clusters = append(clusters, model.Cluster{
			SourceID:           source.ID,
			Provider:           model.ProviderGCP,
			ProviderResourceID: resourceID,
			Name:               value.Name,
			Location:           location,
			KubernetesVersion:  value.CurrentMasterVersion,
			Status:             strings.ToLower(value.Status.String()),
			EndpointAccess:     endpointAccess,
			NodeCount:          &nodeCount,
			Metadata: map[string]any{
				"network":        value.Network,
				"subnetwork":     value.Subnetwork,
				"releaseChannel": releaseChannel,
				"labels":         value.ResourceLabels,
			},
		})
	}
	return clusters, nil
}

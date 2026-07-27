package provider

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"cloud.google.com/go/container/apiv1/containerpb"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/containerservice/armcontainerservice/v9"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	ekstypes "github.com/aws/aws-sdk-go-v2/service/eks/types"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

var (
	ErrOperationUnsupported = errors.New("operation unsupported")
	ErrNodePoolNotFound     = errors.New("node pool not found")
	ErrOperationInProgress  = errors.New("provider operation in progress")
	ErrScaleOutOfBounds     = errors.New("desired count is outside the node pool bounds")
)

type Manager interface {
	Details(context.Context, model.CloudSource, model.Cluster) (model.ClusterDetails, error)
	ScaleNodePool(context.Context, model.CloudSource, model.Cluster, string, int32) (model.ScaleResult, error)
}

type ManagementRegistry map[string]Manager

func (r ManagementRegistry) Details(
	ctx context.Context,
	source model.CloudSource,
	cluster model.Cluster,
) (model.ClusterDetails, error) {
	manager, ok := r[cluster.Provider]
	if !ok {
		return localDetails(cluster), nil
	}
	return manager.Details(ctx, source, cluster)
}

func (r ManagementRegistry) ScaleNodePool(
	ctx context.Context,
	source model.CloudSource,
	cluster model.Cluster,
	poolID string,
	desired int32,
) (model.ScaleResult, error) {
	manager, ok := r[cluster.Provider]
	if !ok {
		return model.ScaleResult{}, ErrOperationUnsupported
	}
	return manager.ScaleNodePool(ctx, source, cluster, poolID, desired)
}

func localDetails(cluster model.Cluster) model.ClusterDetails {
	apiServer, _ := cluster.Metadata["apiServer"].(string)
	return model.ClusterDetails{
		Cluster: cluster,
		Capability: model.ClusterCapability{
			CanScaleNodes: false,
			Reason:        "Local clusters are inventory-only",
		},
		NodePools: []model.NodePool{},
		Networking: model.ClusterNetworking{
			Provider:       cluster.Provider,
			EndpointAccess: cluster.EndpointAccess,
			Local:          &model.LocalNetworking{APIServer: apiServer},
		},
	}
}

func validateDesired(pool model.NodePool, desired int32) error {
	if desired < 0 {
		return ErrScaleOutOfBounds
	}
	if pool.MinCount != nil && desired < *pool.MinCount {
		return ErrScaleOutOfBounds
	}
	if pool.MaxCount != nil && desired > *pool.MaxCount {
		return ErrScaleOutOfBounds
	}
	if !pool.Scalable {
		return ErrOperationUnsupported
	}
	return nil
}

func awsClient(ctx context.Context, source model.CloudSource, region string) (*eks.Client, error) {
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region), awsconfig.WithRetryMaxAttempts(5))
	if err != nil {
		return nil, fmt.Errorf("load AWS credentials: %w", err)
	}
	if source.RoleARN != "" {
		cfg.Credentials = aws.NewCredentialsCache(
			stscreds.NewAssumeRoleProvider(sts.NewFromConfig(cfg), source.RoleARN),
		)
	}
	return eks.NewFromConfig(cfg), nil
}

func (AWS) Details(
	ctx context.Context,
	source model.CloudSource,
	cluster model.Cluster,
) (model.ClusterDetails, error) {
	client, err := awsClient(ctx, source, cluster.Location)
	if err != nil {
		return model.ClusterDetails{}, err
	}
	output, err := client.DescribeCluster(ctx, &eks.DescribeClusterInput{Name: &cluster.Name})
	if err != nil {
		return model.ClusterDetails{}, fmt.Errorf("describe EKS cluster: %w", err)
	}
	if output.Cluster == nil {
		return model.ClusterDetails{}, fmt.Errorf("describe EKS cluster returned no cluster")
	}

	details := model.ClusterDetails{
		Cluster:    cluster,
		Capability: model.ClusterCapability{CanScaleNodes: true},
		NodePools:  []model.NodePool{},
		Networking: model.ClusterNetworking{
			Provider:       model.ProviderAWS,
			EndpointAccess: cluster.EndpointAccess,
			AWS: &model.AWSNetworking{
				SubnetIDs:                  []string{},
				AdditionalSecurityGroupIDs: []string{},
				PublicAccessCIDRs:          []string{},
			},
		},
	}
	value := output.Cluster
	if value.ResourcesVpcConfig != nil {
		vpc := value.ResourcesVpcConfig
		details.Networking.EndpointAccess = EndpointAccess(vpc.EndpointPublicAccess, vpc.EndpointPrivateAccess)
		details.Networking.AWS.VPCID = aws.ToString(vpc.VpcId)
		details.Networking.AWS.SubnetIDs = vpc.SubnetIds
		details.Networking.AWS.ClusterSecurityGroupID = aws.ToString(vpc.ClusterSecurityGroupId)
		details.Networking.AWS.AdditionalSecurityGroupIDs = vpc.SecurityGroupIds
		details.Networking.AWS.PublicAccessCIDRs = vpc.PublicAccessCidrs
	}
	if value.KubernetesNetworkConfig != nil {
		network := value.KubernetesNetworkConfig
		details.Networking.AWS.IPFamily = string(network.IpFamily)
		details.Networking.AWS.ServiceIPv4CIDR = aws.ToString(network.ServiceIpv4Cidr)
		details.Networking.AWS.ServiceIPv6CIDR = aws.ToString(network.ServiceIpv6Cidr)
	}

	pager := eks.NewListNodegroupsPaginator(client, &eks.ListNodegroupsInput{ClusterName: &cluster.Name})
	for pager.HasMorePages() {
		page, pageErr := pager.NextPage(ctx)
		if pageErr != nil {
			return model.ClusterDetails{}, fmt.Errorf("list EKS node groups: %w", pageErr)
		}
		for _, name := range page.Nodegroups {
			group, groupErr := client.DescribeNodegroup(ctx, &eks.DescribeNodegroupInput{
				ClusterName:   &cluster.Name,
				NodegroupName: &name,
			})
			if groupErr != nil {
				return model.ClusterDetails{}, fmt.Errorf("describe EKS node group: %w", groupErr)
			}
			if group.Nodegroup != nil {
				details.NodePools = append(details.NodePools, normalizeEKSNodePool(group.Nodegroup))
			}
		}
	}
	if len(details.NodePools) == 0 {
		details.Capability = model.ClusterCapability{
			CanScaleNodes: false,
			Reason:        "No EKS managed node groups were found",
		}
	}
	return details, nil
}

func normalizeEKSNodePool(group *ekstypes.Nodegroup) model.NodePool {
	pool := model.NodePool{
		ID:          aws.ToString(group.NodegroupName),
		Name:        aws.ToString(group.NodegroupName),
		Autoscaling: "unknown",
		Status:      strings.ToLower(string(group.Status)),
		Zones:       []string{},
		Scalable:    group.Status == ekstypes.NodegroupStatusActive,
	}
	if len(group.InstanceTypes) > 0 {
		pool.MachineType = strings.Join(group.InstanceTypes, ", ")
	}
	if group.ScalingConfig != nil {
		pool.DesiredCount = aws.ToInt32(group.ScalingConfig.DesiredSize)
		pool.MinCount = group.ScalingConfig.MinSize
		pool.MaxCount = group.ScalingConfig.MaxSize
	}
	if !pool.Scalable {
		pool.UnavailableReason = "The node group must be active before it can be scaled"
	}
	return pool
}

func (AWS) ScaleNodePool(
	ctx context.Context,
	source model.CloudSource,
	cluster model.Cluster,
	poolID string,
	desired int32,
) (model.ScaleResult, error) {
	client, err := awsClient(ctx, source, cluster.Location)
	if err != nil {
		return model.ScaleResult{}, err
	}
	current, err := client.DescribeNodegroup(ctx, &eks.DescribeNodegroupInput{
		ClusterName: &cluster.Name, NodegroupName: &poolID,
	})
	if err != nil || current.Nodegroup == nil {
		return model.ScaleResult{}, ErrNodePoolNotFound
	}
	pool := normalizeEKSNodePool(current.Nodegroup)
	if err := validateDesired(pool, desired); err != nil {
		if current.Nodegroup.Status != ekstypes.NodegroupStatusActive {
			return model.ScaleResult{}, ErrOperationInProgress
		}
		return model.ScaleResult{}, err
	}
	if pool.DesiredCount == desired {
		return model.ScaleResult{NodePoolID: poolID, DesiredCount: desired, Status: "unchanged"}, nil
	}
	output, err := client.UpdateNodegroupConfig(ctx, &eks.UpdateNodegroupConfigInput{
		ClusterName:   &cluster.Name,
		NodegroupName: &poolID,
		ScalingConfig: &ekstypes.NodegroupScalingConfig{DesiredSize: &desired},
	})
	if err != nil {
		return model.ScaleResult{}, fmt.Errorf("request EKS node group scale: %w", err)
	}
	result := model.ScaleResult{NodePoolID: poolID, DesiredCount: desired, Status: "accepted"}
	if output.Update != nil {
		result.ProviderOperationID = aws.ToString(output.Update.Id)
	}
	return result, nil
}

func stringPointers(values []*string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value != nil && *value != "" {
			result = append(result, *value)
		}
	}
	return result
}

func uniqueStrings(values ...[]string) []string {
	seen := map[string]struct{}{}
	result := []string{}
	for _, group := range values {
		for _, value := range group {
			if value == "" {
				continue
			}
			if _, ok := seen[value]; !ok {
				seen[value] = struct{}{}
				result = append(result, value)
			}
		}
	}
	return result
}

func gkePool(clusterName string, value *containerpb.NodePool, autopilot bool) model.NodePool {
	pool := model.NodePool{
		ID:           value.GetName(),
		Name:         value.GetName(),
		DesiredCount: value.GetInitialNodeCount(),
		Autoscaling:  "disabled",
		Status:       strings.ToLower(value.GetStatus().String()),
		Zones:        value.GetLocations(),
		Scalable:     !autopilot && value.GetStatus() == containerpb.NodePool_RUNNING,
	}
	if value.GetConfig() != nil {
		pool.MachineType = value.GetConfig().GetMachineType()
	}
	if autoscaling := value.GetAutoscaling(); autoscaling != nil && autoscaling.GetEnabled() {
		pool.Autoscaling = "enabled"
		minimum, maximum := autoscaling.GetTotalMinNodeCount(), autoscaling.GetTotalMaxNodeCount()
		if maximum == 0 {
			minimum, maximum = autoscaling.GetMinNodeCount(), autoscaling.GetMaxNodeCount()
		}
		pool.MinCount, pool.MaxCount = &minimum, &maximum
	}
	if autopilot {
		pool.UnavailableReason = "GKE Autopilot manages node capacity automatically"
	} else if !pool.Scalable {
		pool.UnavailableReason = "The node pool must be running before it can be scaled"
	}
	pool.ID = strings.TrimPrefix(pool.ID, clusterName+"/nodePools/")
	return pool
}

func (GCP) Details(
	ctx context.Context,
	source model.CloudSource,
	cluster model.Cluster,
) (model.ClusterDetails, error) {
	client, err := newGCPClient(ctx, source)
	if err != nil {
		return model.ClusterDetails{}, err
	}
	defer client.Close()
	name := fmt.Sprintf("projects/%s/locations/%s/clusters/%s", source.ScopeID, cluster.Location, cluster.Name)
	value, err := client.GetCluster(ctx, &containerpb.GetClusterRequest{Name: name})
	if err != nil {
		return model.ClusterDetails{}, fmt.Errorf("describe GKE cluster: %w", err)
	}
	autopilot := value.GetAutopilot().GetEnabled()
	details := model.ClusterDetails{
		Cluster: cluster,
		Capability: model.ClusterCapability{
			CanScaleNodes: !autopilot,
		},
		NodePools: []model.NodePool{},
		Networking: model.ClusterNetworking{
			Provider:       model.ProviderGCP,
			EndpointAccess: cluster.EndpointAccess,
			GCP: &model.GCPNetworking{
				Network:              value.GetNetwork(),
				Subnetwork:           value.GetSubnetwork(),
				PodCIDRs:             uniqueStrings([]string{value.GetClusterIpv4Cidr()}),
				ServiceCIDRs:         uniqueStrings([]string{value.GetServicesIpv4Cidr()}),
				NetworkPolicyEnabled: value.GetNetworkPolicy().GetEnabled(),
				DatapathProvider:     strings.ToLower(value.GetNetworkConfig().GetDatapathProvider().String()),
			},
		},
	}
	if private := value.GetPrivateClusterConfig(); private != nil {
		details.Networking.GCP.PrivateNodes = private.GetEnablePrivateNodes()
		details.Networking.GCP.PrivateEndpoint = private.GetEnablePrivateEndpoint()
		details.Networking.GCP.ControlPlaneIPv4CIDR = private.GetMasterIpv4CidrBlock()
	}
	if allocation := value.GetIpAllocationPolicy(); allocation != nil {
		details.Networking.GCP.PodCIDRs = uniqueStrings(
			details.Networking.GCP.PodCIDRs,
			[]string{allocation.GetClusterIpv4CidrBlock()},
		)
		details.Networking.GCP.ServiceCIDRs = uniqueStrings(
			details.Networking.GCP.ServiceCIDRs,
			[]string{allocation.GetServicesIpv4CidrBlock()},
		)
	}
	for _, pool := range value.GetNodePools() {
		if pool != nil {
			details.NodePools = append(details.NodePools, gkePool(name, pool, autopilot))
		}
	}
	if autopilot {
		details.Capability.Reason = "GKE Autopilot manages node capacity automatically"
	}
	return details, nil
}

func (GCP) ScaleNodePool(
	ctx context.Context,
	source model.CloudSource,
	cluster model.Cluster,
	poolID string,
	desired int32,
) (model.ScaleResult, error) {
	client, err := newGCPClient(ctx, source)
	if err != nil {
		return model.ScaleResult{}, err
	}
	defer client.Close()
	clusterName := fmt.Sprintf("projects/%s/locations/%s/clusters/%s", source.ScopeID, cluster.Location, cluster.Name)
	value, err := client.GetCluster(ctx, &containerpb.GetClusterRequest{Name: clusterName})
	if err != nil {
		return model.ScaleResult{}, fmt.Errorf("describe GKE cluster: %w", err)
	}
	if value.GetAutopilot().GetEnabled() {
		return model.ScaleResult{}, ErrOperationUnsupported
	}
	var selected *containerpb.NodePool
	for _, pool := range value.GetNodePools() {
		if pool != nil && pool.GetName() == poolID {
			selected = pool
			break
		}
	}
	if selected == nil {
		return model.ScaleResult{}, ErrNodePoolNotFound
	}
	pool := gkePool(clusterName, selected, false)
	if err := validateDesired(pool, desired); err != nil {
		if selected.GetStatus() != containerpb.NodePool_RUNNING {
			return model.ScaleResult{}, ErrOperationInProgress
		}
		return model.ScaleResult{}, err
	}
	if pool.DesiredCount == desired {
		return model.ScaleResult{NodePoolID: poolID, DesiredCount: desired, Status: "unchanged"}, nil
	}
	operation, err := client.SetNodePoolSize(ctx, &containerpb.SetNodePoolSizeRequest{
		Name:      clusterName + "/nodePools/" + poolID,
		NodeCount: desired,
	})
	if err != nil {
		return model.ScaleResult{}, fmt.Errorf("request GKE node pool scale: %w", err)
	}
	return model.ScaleResult{
		NodePoolID: poolID, DesiredCount: desired, Status: "accepted",
		ProviderOperationID: operation.GetName(),
	}, nil
}

func azureResourceGroup(resourceID string) (string, error) {
	parts := strings.Split(strings.Trim(resourceID, "/"), "/")
	for index := 0; index+1 < len(parts); index++ {
		if strings.EqualFold(parts[index], "resourceGroups") {
			return parts[index+1], nil
		}
	}
	return "", fmt.Errorf("cluster resource ID does not contain a resource group")
}

func azurePool(value *armcontainerservice.ManagedClusterAgentPoolProfile) model.NodePool {
	pool := model.NodePool{
		ID:          stringValue(value.Name),
		Name:        stringValue(value.Name),
		Autoscaling: "disabled",
		Status:      strings.ToLower(stringValue(value.ProvisioningState)),
		MachineType: stringValue(value.VMSize),
		Zones:       stringPointers(value.AvailabilityZones),
		Scalable:    strings.EqualFold(stringValue(value.ProvisioningState), "succeeded"),
	}
	if value.Count != nil {
		pool.DesiredCount = *value.Count
	}
	if boolValue(value.EnableAutoScaling) {
		pool.Autoscaling = "enabled"
		pool.MinCount, pool.MaxCount = value.MinCount, value.MaxCount
	} else if value.Mode != nil && *value.Mode == armcontainerservice.AgentPoolModeSystem {
		minimum := int32(1)
		pool.MinCount = &minimum
	}
	if !pool.Scalable {
		pool.UnavailableReason = "The agent pool must be in a succeeded state before it can be scaled"
	}
	return pool
}

func (Azure) Details(
	ctx context.Context,
	source model.CloudSource,
	cluster model.Cluster,
) (model.ClusterDetails, error) {
	resourceGroup, err := azureResourceGroup(cluster.ProviderResourceID)
	if err != nil {
		return model.ClusterDetails{}, err
	}
	credential, err := azidentity.NewDefaultAzureCredential(&azidentity.DefaultAzureCredentialOptions{TenantID: source.TenantID})
	if err != nil {
		return model.ClusterDetails{}, fmt.Errorf("load Azure credentials: %w", err)
	}
	client, err := armcontainerservice.NewManagedClustersClient(source.ScopeID, credential, nil)
	if err != nil {
		return model.ClusterDetails{}, fmt.Errorf("create AKS client: %w", err)
	}
	response, err := client.Get(ctx, resourceGroup, cluster.Name, nil)
	if err != nil {
		return model.ClusterDetails{}, fmt.Errorf("describe AKS cluster: %w", err)
	}
	details := model.ClusterDetails{
		Cluster:    cluster,
		Capability: model.ClusterCapability{CanScaleNodes: true},
		NodePools:  []model.NodePool{},
		Networking: model.ClusterNetworking{
			Provider:       model.ProviderAzure,
			EndpointAccess: cluster.EndpointAccess,
			Azure: &model.AzureNetworking{
				SubnetIDs:    []string{},
				PodSubnetIDs: []string{},
				PodCIDRs:     []string{},
				ServiceCIDRs: []string{},
			},
		},
	}
	properties := response.Properties
	if properties == nil {
		return details, nil
	}
	for _, value := range properties.AgentPoolProfiles {
		if value == nil {
			continue
		}
		details.NodePools = append(details.NodePools, azurePool(value))
		details.Networking.Azure.SubnetIDs = uniqueStrings(
			details.Networking.Azure.SubnetIDs,
			[]string{stringValue(value.VnetSubnetID)},
		)
		details.Networking.Azure.PodSubnetIDs = uniqueStrings(
			details.Networking.Azure.PodSubnetIDs,
			[]string{stringValue(value.PodSubnetID)},
		)
	}
	if profile := properties.NetworkProfile; profile != nil {
		details.Networking.Azure.NetworkPlugin = enumString(profile.NetworkPlugin)
		details.Networking.Azure.NetworkMode = enumString(profile.NetworkMode)
		details.Networking.Azure.NetworkPolicy = enumString(profile.NetworkPolicy)
		details.Networking.Azure.NetworkDataplane = enumString(profile.NetworkDataplane)
		details.Networking.Azure.OutboundType = enumString(profile.OutboundType)
		details.Networking.Azure.LoadBalancerSKU = enumString(profile.LoadBalancerSKU)
		details.Networking.Azure.DNSServiceIP = stringValue(profile.DNSServiceIP)
		details.Networking.Azure.PodCIDRs = uniqueStrings(
			stringPointers(profile.PodCidrs), []string{stringValue(profile.PodCidr)},
		)
		details.Networking.Azure.ServiceCIDRs = uniqueStrings(
			stringPointers(profile.ServiceCidrs), []string{stringValue(profile.ServiceCidr)},
		)
	}
	if properties.APIServerAccessProfile != nil {
		details.Networking.Azure.PrivateDNSZone = stringValue(properties.APIServerAccessProfile.PrivateDNSZone)
	}
	if len(details.NodePools) == 0 {
		details.Capability = model.ClusterCapability{CanScaleNodes: false, Reason: "No AKS agent pools were found"}
	}
	return details, nil
}

func enumString[T ~string](value *T) string {
	if value == nil {
		return ""
	}
	return strings.ToLower(string(*value))
}

func (Azure) ScaleNodePool(
	ctx context.Context,
	source model.CloudSource,
	cluster model.Cluster,
	poolID string,
	desired int32,
) (model.ScaleResult, error) {
	resourceGroup, err := azureResourceGroup(cluster.ProviderResourceID)
	if err != nil {
		return model.ScaleResult{}, err
	}
	credential, err := azidentity.NewDefaultAzureCredential(&azidentity.DefaultAzureCredentialOptions{TenantID: source.TenantID})
	if err != nil {
		return model.ScaleResult{}, fmt.Errorf("load Azure credentials: %w", err)
	}
	client, err := armcontainerservice.NewAgentPoolsClient(source.ScopeID, credential, nil)
	if err != nil {
		return model.ScaleResult{}, fmt.Errorf("create AKS agent pool client: %w", err)
	}
	response, err := client.Get(ctx, resourceGroup, cluster.Name, poolID, nil)
	if err != nil || response.Properties == nil {
		return model.ScaleResult{}, ErrNodePoolNotFound
	}
	profile := &armcontainerservice.ManagedClusterAgentPoolProfile{
		Name: response.Name,
	}
	if response.Properties != nil {
		profile.Count = response.Properties.Count
		profile.EnableAutoScaling = response.Properties.EnableAutoScaling
		profile.MinCount = response.Properties.MinCount
		profile.MaxCount = response.Properties.MaxCount
		profile.Mode = response.Properties.Mode
		profile.ProvisioningState = response.Properties.ProvisioningState
	}
	pool := azurePool(profile)
	if err := validateDesired(pool, desired); err != nil {
		if !strings.EqualFold(stringValue(response.Properties.ProvisioningState), "succeeded") {
			return model.ScaleResult{}, ErrOperationInProgress
		}
		return model.ScaleResult{}, err
	}
	if pool.DesiredCount == desired {
		return model.ScaleResult{NodePoolID: poolID, DesiredCount: desired, Status: "unchanged"}, nil
	}
	response.Properties.Count = &desired
	_, err = client.BeginCreateOrUpdate(ctx, resourceGroup, cluster.Name, poolID, response.AgentPool, nil)
	if err != nil {
		return model.ScaleResult{}, fmt.Errorf("request AKS agent pool scale: %w", err)
	}
	return model.ScaleResult{NodePoolID: poolID, DesiredCount: desired, Status: "accepted"}, nil
}

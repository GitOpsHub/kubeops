package provider

import (
	"context"
	"fmt"
	"strings"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

type AWS struct{}

func (AWS) Discover(ctx context.Context, source model.CloudSource) ([]model.Cluster, error) {
	base, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRetryMaxAttempts(5))
	if err != nil {
		return nil, fmt.Errorf("load AWS credentials: %w", err)
	}
	if source.RoleARN != "" {
		base.Credentials = aws.NewCredentialsCache(
			stscreds.NewAssumeRoleProvider(sts.NewFromConfig(base), source.RoleARN),
		)
	}

	clusters := make([]model.Cluster, 0)
	for _, region := range source.Regions {
		cfg := base
		cfg.Region = region
		client := eks.NewFromConfig(cfg)
		paginator := eks.NewListClustersPaginator(client, &eks.ListClustersInput{})
		for paginator.HasMorePages() {
			page, err := paginator.NextPage(ctx)
			if err != nil {
				return nil, fmt.Errorf("list EKS clusters in %s: %w", region, err)
			}
			for _, name := range page.Clusters {
				cluster, err := discoverEKSCluster(ctx, client, source, region, name)
				if err != nil {
					return nil, err
				}
				clusters = append(clusters, cluster)
			}
		}
	}
	return clusters, nil
}

func discoverEKSCluster(
	ctx context.Context,
	client *eks.Client,
	source model.CloudSource,
	region string,
	name string,
) (model.Cluster, error) {
	output, err := client.DescribeCluster(ctx, &eks.DescribeClusterInput{Name: &name})
	if err != nil {
		return model.Cluster{}, fmt.Errorf("describe EKS cluster %s: %w", name, err)
	}
	if output.Cluster == nil {
		return model.Cluster{}, fmt.Errorf("describe EKS cluster %s returned no cluster", name)
	}
	value := output.Cluster

	var nodeCount int32
	hasNodeCount := false
	nodeGroups := eks.NewListNodegroupsPaginator(client, &eks.ListNodegroupsInput{ClusterName: &name})
	for nodeGroups.HasMorePages() {
		page, err := nodeGroups.NextPage(ctx)
		if err != nil {
			return model.Cluster{}, fmt.Errorf("list EKS node groups for %s: %w", name, err)
		}
		for _, nodeGroupName := range page.Nodegroups {
			nodeGroup, err := client.DescribeNodegroup(ctx, &eks.DescribeNodegroupInput{
				ClusterName:   &name,
				NodegroupName: &nodeGroupName,
			})
			if err != nil {
				return model.Cluster{}, fmt.Errorf("describe EKS node group %s: %w", nodeGroupName, err)
			}
			if nodeGroup.Nodegroup != nil && nodeGroup.Nodegroup.ScalingConfig != nil &&
				nodeGroup.Nodegroup.ScalingConfig.DesiredSize != nil {
				nodeCount += *nodeGroup.Nodegroup.ScalingConfig.DesiredSize
				hasNodeCount = true
			}
		}
	}
	var nodeCountValue *int32
	if hasNodeCount {
		nodeCountValue = &nodeCount
	}

	endpointAccess := "unknown"
	if value.ResourcesVpcConfig != nil {
		endpointAccess = EndpointAccess(
			value.ResourcesVpcConfig.EndpointPublicAccess,
			value.ResourcesVpcConfig.EndpointPrivateAccess,
		)
	}
	resourceID := aws.ToString(value.Arn)
	if resourceID == "" {
		resourceID = fmt.Sprintf("arn:aws:eks:%s:%s:cluster/%s", region, source.ScopeID, name)
	}

	return model.Cluster{
		SourceID:           source.ID,
		Provider:           model.ProviderAWS,
		ProviderResourceID: resourceID,
		Name:               aws.ToString(value.Name),
		Location:           region,
		KubernetesVersion:  aws.ToString(value.Version),
		Status:             strings.ToLower(string(value.Status)),
		EndpointAccess:     endpointAccess,
		NodeCount:          nodeCountValue,
		Metadata: map[string]any{
			"platformVersion": aws.ToString(value.PlatformVersion),
			"tags":            value.Tags,
		},
	}, nil
}

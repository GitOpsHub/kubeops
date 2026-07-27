package provider

import (
	"testing"

	"cloud.google.com/go/container/apiv1/containerpb"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/containerservice/armcontainerservice/v9"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	ekstypes "github.com/aws/aws-sdk-go-v2/service/eks/types"
)

func TestEndpointAccess(t *testing.T) {
	tests := []struct {
		public  bool
		private bool
		want    string
	}{
		{true, true, "both"},
		{true, false, "public"},
		{false, true, "private"},
		{false, false, "unknown"},
	}
	for _, test := range tests {
		if got := EndpointAccess(test.public, test.private); got != test.want {
			t.Fatalf("EndpointAccess(%t, %t) = %q, want %q", test.public, test.private, got, test.want)
		}
	}
}

func TestNormalizeEKSNodePool(t *testing.T) {
	name := "workers"
	desired, minimum, maximum := int32(4), int32(2), int32(8)
	pool := normalizeEKSNodePool(&ekstypes.Nodegroup{
		NodegroupName: &name,
		Status:        ekstypes.NodegroupStatusActive,
		InstanceTypes: []string{"m6i.large"},
		ScalingConfig: &ekstypes.NodegroupScalingConfig{
			DesiredSize: &desired,
			MinSize:     &minimum,
			MaxSize:     &maximum,
		},
	})
	if pool.ID != name || pool.DesiredCount != desired || !pool.Scalable {
		t.Fatalf("unexpected EKS pool: %#v", pool)
	}
	if pool.Autoscaling != "unknown" || *pool.MinCount != minimum || *pool.MaxCount != maximum {
		t.Fatalf("unexpected EKS scaling metadata: %#v", pool)
	}
}

func TestNormalizeGKENodePool(t *testing.T) {
	pool := gkePool("projects/p/locations/l/clusters/c", &containerpb.NodePool{
		Name:             "workers",
		InitialNodeCount: 3,
		Status:           containerpb.NodePool_RUNNING,
		Config:           &containerpb.NodeConfig{MachineType: "e2-standard-4"},
		Autoscaling: &containerpb.NodePoolAutoscaling{
			Enabled:           true,
			TotalMinNodeCount: 1,
			TotalMaxNodeCount: 9,
		},
	}, false)
	if pool.DesiredCount != 3 || pool.Autoscaling != "enabled" || !pool.Scalable {
		t.Fatalf("unexpected GKE pool: %#v", pool)
	}
	if *pool.MinCount != 1 || *pool.MaxCount != 9 {
		t.Fatalf("unexpected GKE bounds: %#v", pool)
	}
}

func TestAzureResourceGroupAndSystemPoolBounds(t *testing.T) {
	resourceGroup, err := azureResourceGroup(
		"/subscriptions/sub/resourceGroups/platform-rg/providers/Microsoft.ContainerService/managedClusters/prod",
	)
	if err != nil || resourceGroup != "platform-rg" {
		t.Fatalf("unexpected resource group: %q, %v", resourceGroup, err)
	}
	name, state, machine := "system", "Succeeded", "Standard_DS2_v2"
	count := int32(3)
	mode := armcontainerservice.AgentPoolModeSystem
	pool := azurePool(&armcontainerservice.ManagedClusterAgentPoolProfile{
		Name: &name, Count: &count, Mode: &mode, ProvisioningState: &state, VMSize: &machine,
	})
	if !pool.Scalable || pool.MinCount == nil || *pool.MinCount != 1 {
		t.Fatalf("unexpected AKS pool: %#v", pool)
	}
}

func TestValidateDesired(t *testing.T) {
	minimum, maximum := int32(2), int32(5)
	pool := model.NodePool{Scalable: true, MinCount: &minimum, MaxCount: &maximum}
	if err := validateDesired(pool, 4); err != nil {
		t.Fatalf("expected valid desired count: %v", err)
	}
	if err := validateDesired(pool, 1); err != ErrScaleOutOfBounds {
		t.Fatalf("expected bounds error, got %v", err)
	}
}

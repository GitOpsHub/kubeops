package provider

import (
	"context"
	"fmt"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

type Discoverer interface {
	Discover(context.Context, model.CloudSource) ([]model.Cluster, error)
}

type Registry map[string]Discoverer

func (r Registry) Discover(ctx context.Context, source model.CloudSource) ([]model.Cluster, error) {
	discoverer, ok := r[source.Provider]
	if !ok {
		return nil, fmt.Errorf("unsupported provider %q", source.Provider)
	}
	return discoverer.Discover(ctx, source)
}

func EndpointAccess(public, private bool) string {
	switch {
	case public && private:
		return "both"
	case public:
		return "public"
	case private:
		return "private"
	default:
		return "unknown"
	}
}

package cloudauth

import (
	"context"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

// AzureCredential builds a credential for a cloud source. With a usable
// identity token and a configured app registration it presents the token as a
// client assertion, which is the federated identity credential flow and needs
// no client secret; otherwise it falls back to the default Azure chain.
func AzureCredential(
	ctx context.Context,
	source TokenSource,
	cloudSource model.CloudSource,
) (azcore.TokenCredential, error) {
	if cloudSource.ClientID != "" && available(ctx, source) {
		credential, err := azidentity.NewClientAssertionCredential(
			cloudSource.TenantID,
			cloudSource.ClientID,
			func(ctx context.Context) (string, error) { return source.Token(ctx) },
			nil,
		)
		if err != nil {
			return nil, fmt.Errorf("federate Azure credentials: %w", err)
		}
		return credential, nil
	}

	credential, err := azidentity.NewDefaultAzureCredential(&azidentity.DefaultAzureCredentialOptions{
		TenantID: cloudSource.TenantID,
	})
	if err != nil {
		return nil, fmt.Errorf("load Azure credentials: %w", err)
	}
	return credential, nil
}

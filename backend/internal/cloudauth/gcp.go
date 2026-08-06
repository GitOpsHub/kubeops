package cloudauth

import (
	"context"
	"fmt"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"golang.org/x/oauth2/google"
	"golang.org/x/oauth2/google/externalaccount"
	"google.golang.org/api/impersonate"
	"google.golang.org/api/option"
)

const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform"

// subjectTokenSupplier adapts a TokenSource to the interface Google's external
// account exchange expects. It is called on every token refresh, so the
// per-invocation identity token is always read fresh.
type subjectTokenSupplier struct {
	source TokenSource
}

func (s subjectTokenSupplier) SubjectToken(
	ctx context.Context,
	_ externalaccount.SupplierOptions,
) (string, error) {
	return s.source.Token(ctx)
}

// GCPClientOptions builds the client options for a GKE client. With a usable
// identity token and a configured workload identity provider it exchanges the
// token through Workload Identity Federation and impersonates the target
// service account; otherwise it falls back to application default credentials.
func GCPClientOptions(
	ctx context.Context,
	source TokenSource,
	cloudSource model.CloudSource,
) ([]option.ClientOption, error) {
	if cloudSource.WorkloadIdentityProvider != "" && available(ctx, source) {
		tokenSource, err := externalaccount.NewTokenSource(ctx, externalaccount.Config{
			Audience:         cloudSource.WorkloadIdentityProvider,
			SubjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
			ServiceAccountImpersonationURL: fmt.Sprintf(
				"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/%s:generateAccessToken",
				cloudSource.ImpersonateServiceAccount,
			),
			Scopes:               []string{cloudPlatformScope},
			SubjectTokenSupplier: subjectTokenSupplier{source: source},
		})
		if err != nil {
			return nil, fmt.Errorf("federate Google credentials: %w", err)
		}
		return []option.ClientOption{option.WithTokenSource(tokenSource)}, nil
	}

	if cloudSource.ImpersonateServiceAccount == "" {
		return nil, nil
	}

	credentials, err := google.FindDefaultCredentials(ctx, cloudPlatformScope)
	if err != nil {
		return nil, fmt.Errorf("load Google credentials: %w", err)
	}
	tokenSource, err := impersonate.CredentialsTokenSource(ctx, impersonate.CredentialsConfig{
		TargetPrincipal: cloudSource.ImpersonateServiceAccount,
		Scopes:          []string{cloudPlatformScope},
		Subject:         "",
		Delegates:       nil,
	}, option.WithCredentials(credentials))
	if err != nil {
		return nil, fmt.Errorf("impersonate Google service account: %w", err)
	}
	return []option.ClientOption{option.WithTokenSource(tokenSource)}, nil
}

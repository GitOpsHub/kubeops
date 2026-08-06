package cloudauth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
)

// stubSource returns a fixed token, standing in for a platform that supplies a
// workload identity.
type stubSource struct{ token string }

func (s stubSource) Token(context.Context) (string, error) {
	if s.token == "" {
		return "", ErrNoIdentityToken
	}
	return s.token, nil
}

func TestVercelTokenSourceRereadsEnvironmentOnEveryCall(t *testing.T) {
	t.Setenv(VercelOIDCTokenEnv, "first-token")
	source := VercelTokenSource{}

	first, err := source.Token(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	// Vercel replaces the variable in place on each invocation, so a value read
	// once at startup would be replayed after it expires.
	t.Setenv(VercelOIDCTokenEnv, "second-token")
	second, err := source.Token(t.Context())
	if err != nil {
		t.Fatal(err)
	}

	if first != "first-token" || second != "second-token" {
		t.Fatalf("token was cached: first=%q second=%q", first, second)
	}
}

func TestVercelTokenSourceReportsMissingToken(t *testing.T) {
	t.Setenv(VercelOIDCTokenEnv, "")
	if _, err := (VercelTokenSource{}).Token(t.Context()); !errors.Is(err, ErrNoIdentityToken) {
		t.Fatalf("got %v, want ErrNoIdentityToken", err)
	}
}

func TestResolveSelectsSourceForMode(t *testing.T) {
	tests := []struct {
		name     string
		mode     string
		envToken string
		want     bool
	}{
		{name: "off ignores an available token", mode: ModeOff, envToken: "token", want: false},
		{name: "vercel is explicit", mode: ModeVercel, envToken: "", want: true},
		{name: "auto federates when a token exists", mode: ModeAuto, envToken: "token", want: true},
		{name: "auto falls back without a token", mode: ModeAuto, envToken: "", want: false},
		{name: "empty mode behaves as auto", mode: "", envToken: "token", want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("VERCEL", "")
			t.Setenv(VercelOIDCTokenEnv, test.envToken)
			if got := Resolve(test.mode) != nil; got != test.want {
				t.Fatalf("Resolve(%q) resolved=%t, want %t", test.mode, got, test.want)
			}
		})
	}
}

func TestAWSConfigFederatesOnlyWithTokenAndRole(t *testing.T) {
	// The default chain must not be consulted, so no ambient AWS environment
	// leaks into the assertions below.
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	t.Setenv("AWS_REGION", "us-east-1")

	role := model.CloudSource{ID: "aws-platform", RoleARN: "arn:aws:iam::123456789012:role/KubeOps"}
	noRole := model.CloudSource{ID: "aws-platform"}

	tests := []struct {
		name      string
		source    TokenSource
		cloud     model.CloudSource
		federated bool
	}{
		{name: "no token source", source: nil, cloud: role, federated: false},
		{name: "token source with no token", source: stubSource{}, cloud: role, federated: false},
		{name: "token source with no role", source: stubSource{token: "jwt"}, cloud: noRole, federated: false},
		{name: "token source and role", source: stubSource{token: "jwt"}, cloud: role, federated: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg, err := AWSConfig(t.Context(), test.source, test.cloud, "us-west-2")
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Region != "us-west-2" {
				t.Fatalf("region = %q, want us-west-2", cfg.Region)
			}
			// Inspected rather than retrieved: resolving credentials for real would
			// call STS over the network.
			cache, isCache := cfg.Credentials.(*aws.CredentialsCache)
			federated := isCache && cache.IsCredentialsProvider(&stscreds.WebIdentityRoleProvider{})
			if federated != test.federated {
				t.Fatalf("federated = %t, want %t (provider %T)", federated, test.federated, cfg.Credentials)
			}
		})
	}
}

func TestAWSConfigPreservesAssumeRoleFallback(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")

	cfg, err := AWSConfig(t.Context(), nil, model.CloudSource{
		ID:      "aws-platform",
		RoleARN: "arn:aws:iam::123456789012:role/KubeOps",
	}, "us-east-1")
	if err != nil {
		t.Fatal(err)
	}
	// Without federation the role is still assumed, just from a static base
	// identity, which is the behaviour local development relies on.
	cache, ok := cfg.Credentials.(*aws.CredentialsCache)
	if !ok || !cache.IsCredentialsProvider(&stscreds.AssumeRoleProvider{}) {
		t.Fatalf("expected an assume-role credentials cache, got %T", cfg.Credentials)
	}
}

func TestAWSSessionNameIsSTSSafe(t *testing.T) {
	name := awsSessionName("aws/platform prod:" + strings.Repeat("x", 80))
	if len(name) != 64 {
		t.Fatalf("session name length = %d, want 64", len(name))
	}
	if !strings.HasPrefix(name, "kubeops-aws-platform-prod-") {
		t.Fatalf("unexpected session name %q", name)
	}
}

func TestGCPClientOptionsSelectsFederation(t *testing.T) {
	federated := model.CloudSource{
		ID:                        "gcp-platform",
		WorkloadIdentityProvider:  "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/v",
		ImpersonateServiceAccount: "kubeops@example.iam.gserviceaccount.com",
	}

	options, err := GCPClientOptions(t.Context(), stubSource{token: "jwt"}, federated)
	if err != nil {
		t.Fatal(err)
	}
	if len(options) != 1 {
		t.Fatalf("federated path returned %d client options, want 1", len(options))
	}

	// Neither a plain source nor an unavailable token should reach the external
	// account exchange; both fall through to application default credentials,
	// which this test environment does not have configured.
	plain, err := GCPClientOptions(t.Context(), stubSource{token: "jwt"}, model.CloudSource{ID: "gcp-platform"})
	if err != nil {
		t.Fatal(err)
	}
	if plain != nil {
		t.Fatalf("expected no client options without impersonation, got %d", len(plain))
	}
}

func TestAzureCredentialSelectsFederation(t *testing.T) {
	federated := model.CloudSource{
		ID:       "azure-platform",
		TenantID: "00000000-0000-0000-0000-000000000000",
		ClientID: "11111111-1111-1111-1111-111111111111",
	}

	credential, err := AzureCredential(t.Context(), stubSource{token: "jwt"}, federated)
	if err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprintf("%T", credential); got != "*azidentity.ClientAssertionCredential" {
		t.Fatalf("federated path built %s, want a client assertion credential", got)
	}

	fallback, err := AzureCredential(t.Context(), nil, federated)
	if err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprintf("%T", fallback); got != "*azidentity.DefaultAzureCredential" {
		t.Fatalf("fallback path built %s, want the default credential", got)
	}
}

func TestVercelTokenSourcePrefersRequestContext(t *testing.T) {
	// A deployed function receives the token as a request header and never in
	// its environment, so the context value has to win.
	t.Setenv(VercelOIDCTokenEnv, "build-time-token")
	ctx := WithToken(t.Context(), "request-token")

	token, err := (VercelTokenSource{}).Token(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if token != "request-token" {
		t.Fatalf("token = %q, want the request-scoped token", token)
	}
}

func TestWithTokenIgnoresBlankValues(t *testing.T) {
	if _, ok := TokenFromContext(WithToken(t.Context(), "   ")); ok {
		t.Fatal("a blank header must not register as an identity token")
	}
}

func TestResolveFederatesOnVercelWithoutAnEnvironmentToken(t *testing.T) {
	// The runtime token arrives per request, so there is nothing to detect at
	// startup beyond running on the platform at all.
	t.Setenv("VERCEL", "1")
	t.Setenv(VercelOIDCTokenEnv, "")
	if Resolve(ModeAuto) == nil {
		t.Fatal("auto mode must federate on Vercel even with no environment token")
	}
}

func TestAWSConfigUsesTheRequestScopedToken(t *testing.T) {
	t.Setenv(VercelOIDCTokenEnv, "")
	ctx := WithToken(t.Context(), "request-token")

	cfg, err := AWSConfig(ctx, VercelTokenSource{}, model.CloudSource{
		ID:      "aws-platform",
		RoleARN: "arn:aws:iam::123456789012:role/KubeOps",
	}, "us-east-1")
	if err != nil {
		t.Fatal(err)
	}
	cache, ok := cfg.Credentials.(*aws.CredentialsCache)
	if !ok || !cache.IsCredentialsProvider(&stscreds.WebIdentityRoleProvider{}) {
		t.Fatalf("expected a web identity provider, got %T", cfg.Credentials)
	}
}

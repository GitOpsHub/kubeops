package cloudauth

import (
	"context"
	"fmt"
	"strings"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

// identityTokenRetriever adapts a TokenSource to the interface the AWS SDK's
// web identity provider expects. The SDK calls it on every credential refresh,
// which is what keeps the short-lived token from going stale.
//
// The interface has no context parameter, so the request context is captured
// here. That is safe because the config this retriever belongs to is built per
// request, and it is necessary: a deployed function carries its identity token
// in the request context rather than in the environment.
type identityTokenRetriever struct {
	ctx    context.Context
	source TokenSource
}

func (r identityTokenRetriever) GetIdentityToken() ([]byte, error) {
	token, err := r.source.Token(r.ctx)
	if err != nil {
		return nil, err
	}
	return []byte(token), nil
}

// AWSConfig builds an AWS configuration for a cloud source. With a usable
// identity token and a role to assume it federates through
// AssumeRoleWithWebIdentity; otherwise it returns the SDK default chain, which
// preserves the previous behaviour for local development.
func AWSConfig(
	ctx context.Context,
	source TokenSource,
	cloudSource model.CloudSource,
	region string,
) (aws.Config, error) {
	options := []func(*awsconfig.LoadOptions) error{awsconfig.WithRetryMaxAttempts(5)}
	if region != "" {
		options = append(options, awsconfig.WithRegion(region))
	}

	if cloudSource.RoleARN == "" || !available(ctx, source) {
		cfg, err := awsconfig.LoadDefaultConfig(ctx, options...)
		if err != nil {
			return aws.Config{}, fmt.Errorf("load AWS credentials: %w", err)
		}
		if cloudSource.RoleARN != "" {
			cfg.Credentials = aws.NewCredentialsCache(
				stscreds.NewAssumeRoleProvider(sts.NewFromConfig(cfg), cloudSource.RoleARN),
			)
		}
		return cfg, nil
	}

	// AssumeRoleWithWebIdentity is unsigned: the JWT is the proof of identity.
	// Resolving the default chain here would either fail outright in a keyless
	// deployment or silently sign the call with stale credentials.
	federationOptions := append(options, awsconfig.WithCredentialsProvider(aws.AnonymousCredentials{}))
	base, err := awsconfig.LoadDefaultConfig(ctx, federationOptions...)
	if err != nil {
		return aws.Config{}, fmt.Errorf("prepare AWS federation client: %w", err)
	}

	cfg := base
	cfg.Credentials = aws.NewCredentialsCache(
		stscreds.NewWebIdentityRoleProvider(
			sts.NewFromConfig(base),
			cloudSource.RoleARN,
			identityTokenRetriever{ctx: ctx, source: source},
			func(o *stscreds.WebIdentityRoleOptions) {
				o.RoleSessionName = awsSessionName(cloudSource.ID)
			},
		),
	)
	return cfg, nil
}

// awsSessionName derives the CloudTrail-visible session name from the source id.
// STS accepts at most 64 characters drawn from [\w+=,.@-], so anything else in a
// source id is replaced rather than rejected at call time.
func awsSessionName(sourceID string) string {
	var builder strings.Builder
	builder.WriteString("kubeops-")
	for _, r := range sourceID {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			builder.WriteRune(r)
		case strings.ContainsRune("+=,.@-_", r):
			builder.WriteRune(r)
		default:
			builder.WriteRune('-')
		}
	}
	name := builder.String()
	if len(name) > 64 {
		return name[:64]
	}
	return name
}

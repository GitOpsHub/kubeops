// Package cloudauth exchanges a workload identity token for short-lived cloud
// provider credentials, so KubeOps can reach AWS, GCP, and Azure without any
// long-lived key material. Each provider grants access to a role that trusts the
// deployment platform's OIDC issuer rather than to a secret stored in the
// environment.
//
// When no identity token is available the builders here fall back to the
// provider SDK's own default credential chain, which keeps local development
// working against ~/.aws, gcloud, and az logins.
package cloudauth

import (
	"context"
	"errors"
	"os"
	"strings"
)

// ErrNoIdentityToken signals that no workload identity is available right now,
// so the caller must fall back to the provider SDK's default credential chain.
var ErrNoIdentityToken = errors.New("cloudauth: no workload identity token available")

// TokenSource yields the OIDC identity token that proves this deployment's
// identity to a cloud provider.
type TokenSource interface {
	// Token returns a currently valid OIDC identity token, or ErrNoIdentityToken
	// when the platform did not supply one.
	Token(ctx context.Context) (string, error)
}

// Identity modes accepted by Resolve.
const (
	ModeAuto   = "auto"
	ModeVercel = "vercel"
	ModeOff    = "off"
)

const (
	// VercelOIDCTokenEnv carries the identity token during builds and in local
	// development, where `vercel env pull` writes it.
	VercelOIDCTokenEnv = "VERCEL_OIDC_TOKEN"
	// VercelOIDCTokenHeader carries the identity token in a deployed function.
	// The variable above is not set at runtime there, so the request header is
	// the only source that works in production.
	VercelOIDCTokenHeader = "x-vercel-oidc-token"
)

type tokenContextKey struct{}

// WithToken attaches a request-scoped identity token to ctx. Handlers call this
// with the value of the incoming request's identity header so the credential
// builders downstream can reach it.
func WithToken(ctx context.Context, token string) context.Context {
	token = strings.TrimSpace(token)
	if token == "" {
		return ctx
	}
	return context.WithValue(ctx, tokenContextKey{}, token)
}

// TokenFromContext returns a request-scoped identity token, if one was attached.
func TokenFromContext(ctx context.Context) (string, bool) {
	token, ok := ctx.Value(tokenContextKey{}).(string)
	return token, ok && token != ""
}

// VercelTokenSource reads Vercel's short-lived OIDC token.
type VercelTokenSource struct{}

// Token prefers the request-scoped token and falls back to the environment.
// Deployed functions only ever receive the token as a request header; the
// environment variable is populated during builds and in local development.
// Neither is cached: the token is short-lived, so a value captured once would
// expire and then keep being replayed for the life of the process.
func (VercelTokenSource) Token(ctx context.Context) (string, error) {
	if token, ok := TokenFromContext(ctx); ok {
		return token, nil
	}
	token := strings.TrimSpace(os.Getenv(VercelOIDCTokenEnv))
	if token == "" {
		return "", ErrNoIdentityToken
	}
	return token, nil
}

// Resolve selects the token source for the configured mode. A nil result means
// federation is inactive and callers should use the SDK default credential
// chain; that is the expected outcome for local development.
func Resolve(mode string) TokenSource {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case ModeOff:
		return nil
	case ModeVercel:
		return VercelTokenSource{}
	default:
		// ModeAuto, and any unset value. Running on Vercel is enough on its own,
		// because a deployed function receives the token per request rather than
		// in the environment; there is nothing to detect at startup. Elsewhere the
		// token variable is the signal. Either way a source that turns out to have
		// no token still degrades to the default credential chain per call.
		if os.Getenv("VERCEL") != "" {
			return VercelTokenSource{}
		}
		if strings.TrimSpace(os.Getenv(VercelOIDCTokenEnv)) == "" {
			return nil
		}
		return VercelTokenSource{}
	}
}

// available reports whether the source can produce a token right now. A source
// that exists but has no token yet is treated the same as no source at all, so
// a transient gap degrades to the default chain instead of failing the request.
func available(ctx context.Context, source TokenSource) bool {
	if source == nil {
		return false
	}
	token, err := source.Token(ctx)
	return err == nil && token != ""
}

// Command seed-argo-target encrypts and upserts one argo_targets row so a
// cluster's Argo CD access can be registered directly in the database
// instead of editing config/argo-targets.yaml and redeploying. It is the
// only way to write this table: there is no HTTP endpoint for it, since the
// API has no authentication and Argo CD credentials should not be exposed
// through it.
//
// Usage:
//
//	DATABASE_URL=... ARGO_CREDENTIAL_ENCRYPTION_KEY=... \
//	  go run ./cmd/seed-argo-target \
//	    -source-id aws-prod \
//	    -provider-resource-id arn:aws:eks:us-east-1:465532803838:cluster/eks-spot-dev-02 \
//	    -server-url https://argocd.example.com \
//	    -token "$ARGO_TOKEN"
package main

import (
	"context"
	"encoding/base64"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/secure"
	"github.com/GitOpsHub/kubeops/backend/internal/store"
)

func main() {
	sourceID := flag.String("source-id", "", "cloud source id this cluster belongs to, e.g. aws-prod (required)")
	providerResourceID := flag.String("provider-resource-id", "", "the cluster's provider resource id, e.g. an EKS cluster ARN (required)")
	serverURL := flag.String("server-url", "", "Argo CD server URL this backend calls with the API token (required)")
	token := flag.String("token", "", "Argo CD API token (required; prefer passing via a file or env var, not a shell literal)")
	caCertFile := flag.String("ca-cert-file", "", "optional path to a PEM CA certificate for a private Argo CD server")
	uiURL := flag.String("ui-url", "", "optional Argo CD UI URL, for deep links")
	username := flag.String("username", "", "optional Argo CD UI username (requires -password)")
	password := flag.String("password", "", "optional Argo CD UI password (requires -username)")
	flag.Parse()

	if *sourceID == "" || *providerResourceID == "" || *serverURL == "" || *token == "" {
		fmt.Fprintln(os.Stderr, "source-id, provider-resource-id, server-url, and token are required")
		flag.Usage()
		os.Exit(2)
	}
	if (*username == "") != (*password == "") {
		fmt.Fprintln(os.Stderr, "username and password must be set together, or not at all")
		os.Exit(2)
	}

	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL must be set")
		os.Exit(2)
	}
	key, err := loadKey()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	var caCert string
	if *caCertFile != "" {
		content, err := os.ReadFile(*caCertFile)
		if err != nil {
			fmt.Fprintf(os.Stderr, "read CA certificate: %v\n", err)
			os.Exit(1)
		}
		caCert = string(content)
	}

	target := model.EncryptedArgoTarget{
		SourceID:           *sourceID,
		ProviderResourceID: *providerResourceID,
		ServerURL:          *serverURL,
		CACert:             caCert,
		UIURL:              *uiURL,
		Username:           *username,
	}

	tokenCiphertext, tokenNonce, err := secure.Encrypt(key, []byte(*token))
	if err != nil {
		fmt.Fprintf(os.Stderr, "encrypt token: %v\n", err)
		os.Exit(1)
	}
	target.TokenCiphertext = tokenCiphertext
	target.TokenNonce = tokenNonce

	if *password != "" {
		passwordCiphertext, passwordNonce, err := secure.Encrypt(key, []byte(*password))
		if err != nil {
			fmt.Fprintf(os.Stderr, "encrypt password: %v\n", err)
			os.Exit(1)
		}
		target.PasswordCiphertext = passwordCiphertext
		target.PasswordNonce = passwordNonce
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	repository, err := store.Open(ctx, databaseURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "connect to database: %v\n", err)
		os.Exit(1)
	}
	defer repository.Close()

	if err := repository.UpsertArgoTarget(ctx, target); err != nil {
		fmt.Fprintf(os.Stderr, "upsert argo target: %v\n", err)
		os.Exit(1)
	}

	slog.Info("Argo CD target saved",
		"source_id", *sourceID,
		"provider_resource_id", *providerResourceID,
		"server_url", *serverURL,
	)
}

func loadKey() ([]byte, error) {
	encoded := strings.TrimSpace(os.Getenv("ARGO_CREDENTIAL_ENCRYPTION_KEY"))
	if encoded == "" {
		return nil, fmt.Errorf("ARGO_CREDENTIAL_ENCRYPTION_KEY must be set (the same key the backend uses)")
	}
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(key) != secure.KeyBytes {
		return nil, fmt.Errorf("ARGO_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded %d-byte key", secure.KeyBytes)
	}
	return key, nil
}

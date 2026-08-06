package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/cloudauth"
	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/httpapi"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/onboarding"
	"github.com/GitOpsHub/kubeops/backend/internal/provider"
	"github.com/GitOpsHub/kubeops/backend/internal/store"
	"github.com/GitOpsHub/kubeops/backend/internal/syncer"
)

func main() {
	cfg, err := config.Load("../.env")
	if err != nil {
		slog.Error("load configuration", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	repository, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("initialize database", "error", err)
		os.Exit(1)
	}
	defer repository.Close()

	if err := repository.UpsertSources(ctx, cfg.CloudSources); err != nil {
		slog.Error("reconcile cloud sources", "error", err)
		os.Exit(1)
	}

	// Resolved once: the source reads the platform's identity token on every
	// credential refresh, so it stays valid across invocations without being
	// rebuilt. A nil source means the provider SDK default chains are used.
	identity := cloudauth.Resolve(cfg.CloudIdentity.Mode)
	for _, source := range cfg.CloudSources {
		if !source.Enabled {
			continue
		}
		slog.Info("cloud source credentials",
			"source", source.ID,
			"provider", source.Provider,
			"mode", cfg.FederationMode(source),
			"audience", cfg.CloudIdentity.Audience,
		)
	}

	syncService := syncer.New(
		repository,
		provider.Registry{
			model.ProviderAWS:      provider.AWS{Identity: identity},
			model.ProviderGCP:      provider.GCP{Identity: identity},
			model.ProviderAzure:    provider.Azure{Identity: identity},
			model.ProviderDocker:   provider.LocalKubernetes{Provider: model.ProviderDocker},
			model.ProviderMinikube: provider.LocalKubernetes{Provider: model.ProviderMinikube},
		},
		cfg.CloudSources,
		cfg.SyncInterval,
		cfg.SyncWorkers,
	)
	if cfg.BackgroundWorkers {
		syncService.Start(ctx)
	} else if err := syncService.PrepareRequestDriven(ctx); err != nil {
		slog.Error("prepare request-driven cluster syncs", "error", err)
		os.Exit(1)
	}

	onboardingService, err := onboarding.NewService(repository, cfg.Onboarding)
	if err != nil {
		slog.Error("initialize application onboarding", "error", err)
		os.Exit(1)
	}
	if cfg.BackgroundWorkers {
		onboardingService.Start(ctx)
	}

	clusterManagers := provider.ManagementRegistry{
		model.ProviderAWS:   provider.AWS{Identity: identity},
		model.ProviderGCP:   provider.GCP{Identity: identity},
		model.ProviderAzure: provider.Azure{Identity: identity},
	}

	server := &http.Server{
		Addr: cfg.Address(),
		Handler: httpapi.NewHandlerWithOnboarding(
			cfg, repository, clusterManagers, onboardingService, syncService,
		),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		slog.Info("starting KubeOps API",
			"address", server.Addr,
			"environment", cfg.Environment,
			"sources", len(cfg.CloudSources),
			"sync_interval", cfg.SyncInterval,
			"background_workers", cfg.BackgroundWorkers,
		)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("serve API", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown API", "error", err)
	}
}

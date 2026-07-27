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

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/httpapi"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
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

	syncService := syncer.New(
		repository,
		provider.Registry{
			model.ProviderAWS:      provider.AWS{},
			model.ProviderGCP:      provider.GCP{},
			model.ProviderAzure:    provider.Azure{},
			model.ProviderDocker:   provider.LocalKubernetes{Provider: model.ProviderDocker},
			model.ProviderMinikube: provider.LocalKubernetes{Provider: model.ProviderMinikube},
		},
		cfg.CloudSources,
		cfg.SyncInterval,
		cfg.SyncWorkers,
	)
	syncService.Start(ctx)

	server := &http.Server{
		Addr:              cfg.Address(),
		Handler:           httpapi.NewHandler(cfg, repository),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		slog.Info("starting KubeOps API",
			"address", server.Addr,
			"environment", cfg.Environment,
			"sources", len(cfg.CloudSources),
			"sync_interval", cfg.SyncInterval,
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

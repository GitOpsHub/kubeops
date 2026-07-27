package syncer

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/provider"
)

type Service struct {
	store       Repository
	providers   provider.Registry
	sources     map[string]model.CloudSource
	interval    time.Duration
	workerCount int
}

type Repository interface {
	QueueAll(context.Context, string) error
	ClaimNextSync(context.Context) (*model.SyncRun, error)
	CompleteSync(context.Context, model.SyncRun, []model.Cluster) error
	FailSync(context.Context, model.SyncRun, string) error
}

func New(
	store Repository,
	providers provider.Registry,
	sources []model.CloudSource,
	interval time.Duration,
	workerCount int,
) *Service {
	byID := make(map[string]model.CloudSource, len(sources))
	for _, source := range sources {
		byID[source.ID] = source
	}
	return &Service{
		store: store, providers: providers, sources: byID,
		interval: interval, workerCount: workerCount,
	}
}

func (s *Service) Start(ctx context.Context) {
	if err := s.store.QueueAll(ctx, "startup"); err != nil {
		slog.Error("queue startup syncs", "error", err)
	}

	go s.schedule(ctx)
	for worker := 0; worker < s.workerCount; worker++ {
		go s.work(ctx, worker+1)
	}
}

func (s *Service) schedule(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.store.QueueAll(ctx, "scheduled"); err != nil {
				slog.Error("queue scheduled syncs", "error", err)
			}
		}
	}
}

func (s *Service) work(ctx context.Context, worker int) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := s.runNext(ctx, worker); err != nil {
			slog.Error("run cluster sync", "worker", worker, "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Service) runNext(ctx context.Context, worker int) error {
	run, err := s.store.ClaimNextSync(ctx)
	if err != nil || run == nil {
		return err
	}
	source, ok := s.sources[run.SourceID]
	if !ok || !source.Enabled {
		return s.store.FailSync(ctx, *run, "cloud source is not enabled in configuration")
	}

	slog.Info("discovering clusters", "worker", worker, "source", source.ID, "provider", source.Provider)
	syncCtx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	clusters, err := s.providers.Discover(syncCtx, source)
	if err != nil {
		message := sanitizeError(err)
		if failErr := s.store.FailSync(ctx, *run, message); failErr != nil {
			return failErr
		}
		slog.Warn("cluster discovery failed", "source", source.ID, "error", message)
		return nil
	}
	if err := s.store.CompleteSync(ctx, *run, clusters); err != nil {
		return err
	}
	slog.Info("cluster discovery completed", "source", source.ID, "clusters", len(clusters))
	return nil
}

func sanitizeError(err error) string {
	message := strings.Join(strings.Fields(err.Error()), " ")
	if len(message) > 500 {
		message = message[:500]
	}
	for _, marker := range []string{"password=", "token=", "secret="} {
		if index := strings.Index(strings.ToLower(message), marker); index >= 0 {
			message = message[:index] + marker + "[redacted]"
		}
	}
	return message
}

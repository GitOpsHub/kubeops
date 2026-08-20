package syncer

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/provider"
	"github.com/GitOpsHub/kubeops/backend/internal/store"
)

type Service struct {
	store       Repository
	providers   provider.Registry
	sources     map[string]model.CloudSource
	interval    time.Duration
	workerCount int
}

type Repository interface {
	RecoverRunningSyncs(context.Context) error
	RecoverRequestDrivenSyncs(context.Context) error
	QueueAll(context.Context, string, []string) error
	StartSync(context.Context, string, string) (model.SyncRun, error)
	ClaimNextSync(context.Context) (*model.SyncRun, error)
	CompleteSync(context.Context, model.SyncRun, []model.Cluster) error
	FailSync(context.Context, model.SyncRun, string) error
}

var ErrSourceUnavailable = errors.New("cloud source is not enabled in configuration")

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
	if err := s.initialize(ctx); err != nil {
		slog.Error("initialize cluster syncs", "error", err)
	}

	go s.schedule(ctx)
	for worker := 0; worker < s.workerCount; worker++ {
		go s.work(ctx, worker+1)
	}
}

func (s *Service) PrepareRequestDriven(ctx context.Context) error {
	return s.store.RecoverRequestDrivenSyncs(ctx)
}

func (s *Service) initialize(ctx context.Context) error {
	if err := s.store.RecoverRunningSyncs(ctx); err != nil {
		return err
	}
	return s.store.QueueAll(ctx, "startup", s.sourceIDs())
}

func (s *Service) schedule(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.store.QueueAll(ctx, "scheduled", s.sourceIDs()); err != nil {
				slog.Error("queue scheduled syncs", "error", err)
			}
		}
	}
}

func (s *Service) sourceIDs() []string {
	ids := make([]string, 0, len(s.sources))
	for id, source := range s.sources {
		if source.Enabled {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// Sync executes a manual discovery inside the caller's request. This is the
// durable execution path for serverless deployments, where a queued goroutine
// may be suspended as soon as the HTTP response is returned.
func (s *Service) Sync(ctx context.Context, sourceID, trigger string) (model.SyncRun, error) {
	source, ok := s.sources[sourceID]
	if !ok || !source.Enabled {
		return model.SyncRun{}, ErrSourceUnavailable
	}
	run, err := s.store.StartSync(ctx, sourceID, trigger)
	if err != nil {
		return model.SyncRun{}, err
	}

	syncCtx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	clusters, discoverErr := s.providers.Discover(syncCtx, source)
	completedAt := time.Now()
	run.CompletedAt = &completedAt
	if discoverErr != nil {
		message := sanitizeError(discoverErr)
		if err := s.store.FailSync(context.WithoutCancel(ctx), run, message); err != nil {
			return model.SyncRun{}, err
		}
		run.Status = "failed"
		run.Error = message
		return run, nil
	}
	if err := s.store.CompleteSync(context.WithoutCancel(ctx), run, clusters); err != nil {
		return model.SyncRun{}, err
	}
	run.Status = "succeeded"
	run.DiscoveredCount = len(clusters)
	return run, nil
}

// SyncAll runs Sync for every enabled source in turn, inside the caller's
// request. It is the durable, request-driven equivalent of the scheduler's
// ticker for deployments where BACKGROUND_WORKERS is off (Vercel): an
// external scheduler (e.g. Vercel Cron) hits an endpoint that calls this
// instead of a user pressing "Sync now" per source. A source's discovery
// error does not stop the remaining sources from being attempted.
func (s *Service) SyncAll(ctx context.Context, trigger string) ([]model.SyncRun, error) {
	runs := make([]model.SyncRun, 0, len(s.sources))
	deployed := os.Getenv("VERCEL") != ""
	for _, sourceID := range s.sourceIDs() {
		// Local-only sources (docker-desktop, minikube) can never succeed from
		// a deployed function; skip them on the unattended cron path instead
		// of repeatedly marking them failed. A person clicking "Sync now"
		// still gets a clear error via Sync.
		if deployed && isLocalProvider(s.sources[sourceID].Provider) {
			continue
		}
		run, err := s.Sync(ctx, sourceID, trigger)
		if err != nil {
			if errors.Is(err, store.ErrSyncAlreadyActive) {
				continue
			}
			return runs, err
		}
		runs = append(runs, run)
	}
	return runs, nil
}

func isLocalProvider(provider string) bool {
	return provider == model.ProviderDocker || provider == model.ProviderMinikube
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
		return s.store.FailSync(ctx, *run, ErrSourceUnavailable.Error())
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

package syncer

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/provider"
	"github.com/GitOpsHub/kubeops/backend/internal/store"
	"golang.org/x/sync/errgroup"
)

type Service struct {
	store         Repository
	providers     provider.Registry
	sources       map[string]model.CloudSource
	interval      time.Duration
	workerCount   int
	sourceTimeout time.Duration
}

// DefaultSourceTimeout bounds one source's discovery. It has to stay below the
// serverless function's maxDuration (vercel.json), or the platform kills the
// request before FailSync can record why.
const DefaultSourceTimeout = 4 * time.Minute

// staleMargin is how long past the source timeout a run may stay active before
// it counts as abandoned, covering the database writes after discovery.
const staleMargin = time.Minute

// syncAllConcurrency bounds how many sources SyncAll discovers at once. They
// ran one after another before, which on a serverless function let a few slow
// sources push the whole request past its duration limit.
const syncAllConcurrency = 4

type Option func(*Service)

// WithSourceTimeout overrides DefaultSourceTimeout (SYNC_SOURCE_TIMEOUT).
func WithSourceTimeout(timeout time.Duration) Option {
	return func(s *Service) {
		if timeout > 0 {
			s.sourceTimeout = timeout
		}
	}
}

type Repository interface {
	RecoverStaleSyncs(context.Context, time.Duration) error
	QueueAll(context.Context, string, []string) error
	StartSync(context.Context, string, string, time.Duration) (model.SyncRun, error)
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
	options ...Option,
) *Service {
	byID := make(map[string]model.CloudSource, len(sources))
	for _, source := range sources {
		byID[source.ID] = source
	}
	service := &Service{
		store: store, providers: providers, sources: byID,
		interval: interval, workerCount: workerCount,
		sourceTimeout: DefaultSourceTimeout,
	}
	for _, option := range options {
		option(service)
	}
	return service
}

// staleAfter is how old an active run must be before no instance can still
// own it.
func (s *Service) staleAfter() time.Duration {
	return s.sourceTimeout + staleMargin
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
	return s.store.RecoverStaleSyncs(ctx, s.staleAfter())
}

func (s *Service) initialize(ctx context.Context) error {
	if err := s.store.RecoverStaleSyncs(ctx, s.staleAfter()); err != nil {
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
			// Startup recovery only clears runs that were already stale then; a
			// run orphaned more recently would block its source's scheduled
			// syncs until the next restart.
			if err := s.store.RecoverStaleSyncs(ctx, s.staleAfter()); err != nil {
				slog.Error("recover stale syncs", "error", err)
			}
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
	run, err := s.store.StartSync(ctx, sourceID, trigger, s.staleAfter())
	if err != nil {
		return model.SyncRun{}, err
	}

	syncCtx, cancel := context.WithTimeout(ctx, s.sourceTimeout)
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

// SyncAll runs Sync for every enabled source inside the caller's request. It
// is the durable, request-driven equivalent of the scheduler's ticker for
// deployments where BACKGROUND_WORKERS is off (Vercel): an external scheduler
// (e.g. Vercel Cron) hits an endpoint that calls this instead of a user
// pressing "Sync now" per source. A discovery failure is recorded on that
// source's run; any other error is collected and returned alongside the runs
// of the remaining sources, which are still attempted.
func (s *Service) SyncAll(ctx context.Context, trigger string) ([]model.SyncRun, error) {
	deployed := os.Getenv("VERCEL") != ""
	var (
		mu   sync.Mutex
		runs = make([]model.SyncRun, 0, len(s.sources))
		errs []error
	)
	var group errgroup.Group
	group.SetLimit(syncAllConcurrency)
	for _, sourceID := range s.sourceIDs() {
		// Local-only sources (docker-desktop, minikube) can never succeed from
		// a deployed function; skip them on the unattended cron path instead
		// of repeatedly marking them failed. A person clicking "Sync now"
		// still gets a clear error via Sync.
		if deployed && isLocalProvider(s.sources[sourceID].Provider) {
			continue
		}
		group.Go(func() error {
			run, err := s.Sync(ctx, sourceID, trigger)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case errors.Is(err, store.ErrSyncAlreadyActive):
			case err != nil:
				errs = append(errs, fmt.Errorf("sync %s: %w", sourceID, err))
			default:
				runs = append(runs, run)
			}
			return nil
		})
	}
	_ = group.Wait()
	sort.Slice(runs, func(i, j int) bool { return runs[i].SourceID < runs[j].SourceID })
	return runs, errors.Join(errs...)
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
	syncCtx, cancel := context.WithTimeout(ctx, s.sourceTimeout)
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

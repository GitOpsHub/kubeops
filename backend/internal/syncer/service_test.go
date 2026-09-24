package syncer

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/provider"
)

type fakeStore struct {
	// mu serializes access: SyncAll syncs sources concurrently.
	mu            sync.Mutex
	run           *model.SyncRun
	completed     []model.Cluster
	failed        string
	startupCalls  []string
	recoverError  error
	queueAllError error
	// startErr fails StartSync for the named sources.
	startErr   map[string]error
	staleAfter time.Duration
}

func (f *fakeStore) RecoverStaleSyncs(_ context.Context, staleAfter time.Duration) error {
	f.startupCalls = append(f.startupCalls, "recover")
	f.staleAfter = staleAfter
	return f.recoverError
}
func (f *fakeStore) QueueAll(_ context.Context, trigger string, sourceIDs []string) error {
	f.startupCalls = append(f.startupCalls, "queue:"+trigger)
	return f.queueAllError
}
func (f *fakeStore) StartSync(
	_ context.Context,
	sourceID, trigger string,
	staleAfter time.Duration,
) (model.SyncRun, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.staleAfter = staleAfter
	if err := f.startErr[sourceID]; err != nil {
		return model.SyncRun{}, err
	}
	return model.SyncRun{
		ID: "manual-run", SourceID: sourceID, Trigger: trigger, Status: "running",
	}, nil
}
func (f *fakeStore) ClaimNextSync(context.Context) (*model.SyncRun, error) {
	run := f.run
	f.run = nil
	return run, nil
}
func (f *fakeStore) CompleteSync(_ context.Context, _ model.SyncRun, clusters []model.Cluster) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.completed = clusters
	return nil
}
func (f *fakeStore) FailSync(_ context.Context, _ model.SyncRun, message string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failed = message
	return nil
}

type fakeDiscoverer struct {
	provider string
	err      error
}

func (f fakeDiscoverer) Discover(_ context.Context, source model.CloudSource) ([]model.Cluster, error) {
	if f.err != nil {
		return nil, f.err
	}
	return []model.Cluster{{
		SourceID: source.ID, Provider: f.provider,
		ProviderResourceID: f.provider + "-cluster", Name: f.provider + "-cluster",
	}}, nil
}

func TestRunNextNormalizesAllProviderResults(t *testing.T) {
	for _, providerName := range []string{
		model.ProviderAWS,
		model.ProviderGCP,
		model.ProviderAzure,
		model.ProviderDocker,
		model.ProviderMinikube,
	} {
		t.Run(providerName, func(t *testing.T) {
			repository := &fakeStore{run: &model.SyncRun{ID: "run", SourceID: providerName}}
			source := model.CloudSource{
				ID: providerName, Provider: providerName, Name: providerName,
				ScopeID: "scope", Enabled: true,
			}
			service := New(
				repository,
				provider.Registry{providerName: fakeDiscoverer{provider: providerName}},
				[]model.CloudSource{source},
				5*time.Minute,
				1,
			)

			if err := service.runNext(context.Background(), 1); err != nil {
				t.Fatal(err)
			}
			if len(repository.completed) != 1 || repository.completed[0].Provider != providerName {
				t.Fatalf("unexpected clusters: %#v", repository.completed)
			}
		})
	}
}

func TestInitializeRecoversInterruptedSyncsBeforeQueueing(t *testing.T) {
	repository := &fakeStore{}
	service := New(repository, nil, nil, 5*time.Minute, 1)

	if err := service.initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(repository.startupCalls) != 2 ||
		repository.startupCalls[0] != "recover" ||
		repository.startupCalls[1] != "queue:startup" {
		t.Fatalf("unexpected startup calls: %#v", repository.startupCalls)
	}
}

func TestInitializeDoesNotQueueWhenRecoveryFails(t *testing.T) {
	repository := &fakeStore{recoverError: errors.New("recover failed")}
	service := New(repository, nil, nil, 5*time.Minute, 1)

	if err := service.initialize(context.Background()); err == nil {
		t.Fatal("expected recovery error")
	}
	if len(repository.startupCalls) != 1 || repository.startupCalls[0] != "recover" {
		t.Fatalf("unexpected startup calls: %#v", repository.startupCalls)
	}
}

func TestPrepareRequestDrivenOnlyRecoversOrphanedWork(t *testing.T) {
	repository := &fakeStore{}
	service := New(repository, nil, nil, 5*time.Minute, 1)
	if err := service.PrepareRequestDriven(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(repository.startupCalls) != 1 || repository.startupCalls[0] != "recover" {
		t.Fatalf("unexpected preparation calls: %#v", repository.startupCalls)
	}
	// Only runs older than the source timeout can be orphaned; a younger one
	// may belong to a live request on another instance.
	if want := DefaultSourceTimeout + staleMargin; repository.staleAfter != want {
		t.Fatalf("recovered runs younger than %s (staleAfter %s)", want, repository.staleAfter)
	}
}

func TestRunNextKeepsFailureSanitized(t *testing.T) {
	repository := &fakeStore{run: &model.SyncRun{ID: "run", SourceID: "aws"}}
	service := New(
		repository,
		provider.Registry{"aws": fakeDiscoverer{err: errors.New("request failed token=secret-value more")}},
		[]model.CloudSource{{ID: "aws", Provider: "aws", Name: "AWS", ScopeID: "scope", Enabled: true}},
		5*time.Minute,
		1,
	)

	if err := service.runNext(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if repository.failed != "request failed token=[redacted]" {
		t.Fatalf("unexpected sanitized error: %q", repository.failed)
	}
}

func TestSyncRunsDiscoveryInsideRequest(t *testing.T) {
	repository := &fakeStore{}
	service := New(
		repository,
		provider.Registry{"gcp": fakeDiscoverer{provider: "gcp"}},
		[]model.CloudSource{{
			ID: "gcp", Provider: "gcp", Name: "GCP", ScopeID: "project", Enabled: true,
		}},
		5*time.Minute,
		1,
	)

	run, err := service.Sync(context.Background(), "gcp", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != "succeeded" || run.DiscoveredCount != 1 || len(repository.completed) != 1 {
		t.Fatalf("unexpected sync result: %#v, clusters: %#v", run, repository.completed)
	}
}

func TestSyncAllRunsEveryEnabledSource(t *testing.T) {
	repository := &fakeStore{}
	service := New(
		repository,
		provider.Registry{
			"gcp": fakeDiscoverer{provider: "gcp"},
			"aws": fakeDiscoverer{provider: "aws"},
		},
		[]model.CloudSource{
			{ID: "gcp", Provider: "gcp", Name: "GCP", ScopeID: "project", Enabled: true},
			{ID: "aws", Provider: "aws", Name: "AWS", ScopeID: "account", Enabled: true},
			{ID: "disabled", Provider: "aws", Name: "Disabled", ScopeID: "account", Enabled: false},
		},
		5*time.Minute,
		1,
	)

	runs, err := service.SyncAll(context.Background(), "cron")
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 2 {
		t.Fatalf("expected 2 runs, got %#v", runs)
	}
	for _, run := range runs {
		if run.Trigger != "cron" || run.Status != "succeeded" {
			t.Fatalf("unexpected run: %#v", run)
		}
	}
}

func TestSyncRejectsSourceMissingFromRuntimeConfiguration(t *testing.T) {
	service := New(&fakeStore{}, nil, nil, 5*time.Minute, 1)
	if _, err := service.Sync(context.Background(), "stale-source", "manual"); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("expected unavailable source error, got %v", err)
	}
}

func TestSyncAllContinuesPastFailingSource(t *testing.T) {
	repository := &fakeStore{startErr: map[string]error{"aws": errors.New("database unavailable")}}
	service := New(
		repository,
		provider.Registry{
			"gcp":   fakeDiscoverer{provider: "gcp"},
			"aws":   fakeDiscoverer{provider: "aws"},
			"azure": fakeDiscoverer{provider: "azure"},
		},
		[]model.CloudSource{
			{ID: "aws", Provider: "aws", Name: "AWS", ScopeID: "account", Enabled: true},
			{ID: "azure", Provider: "azure", Name: "Azure", ScopeID: "sub", Enabled: true},
			{ID: "gcp", Provider: "gcp", Name: "GCP", ScopeID: "project", Enabled: true},
		},
		5*time.Minute,
		1,
		WithSourceTimeout(90*time.Second),
	)

	runs, err := service.SyncAll(context.Background(), "cron")
	if err == nil {
		t.Fatal("expected the failing source's error")
	}
	if len(runs) != 2 || runs[0].SourceID != "azure" || runs[1].SourceID != "gcp" {
		t.Fatalf("sources after the failure were not synced: %#v", runs)
	}
	if want := 90*time.Second + staleMargin; repository.staleAfter != want {
		t.Fatalf("staleAfter = %s, want %s", repository.staleAfter, want)
	}
}

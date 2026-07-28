package syncer

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/provider"
)

type fakeStore struct {
	run           *model.SyncRun
	completed     []model.Cluster
	failed        string
	startupCalls  []string
	recoverError  error
	queueAllError error
}

func (f *fakeStore) RecoverRunningSyncs(context.Context) error {
	f.startupCalls = append(f.startupCalls, "recover")
	return f.recoverError
}
func (f *fakeStore) QueueAll(_ context.Context, trigger string) error {
	f.startupCalls = append(f.startupCalls, "queue:"+trigger)
	return f.queueAllError
}
func (f *fakeStore) ClaimNextSync(context.Context) (*model.SyncRun, error) {
	run := f.run
	f.run = nil
	return run, nil
}
func (f *fakeStore) CompleteSync(_ context.Context, _ model.SyncRun, clusters []model.Cluster) error {
	f.completed = clusters
	return nil
}
func (f *fakeStore) FailSync(_ context.Context, _ model.SyncRun, message string) error {
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

package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/store"
)

type fakeRepository struct {
	readyErr error
	queueErr error
	filter   model.ClusterFilter
}

func (f *fakeRepository) Ready(context.Context) error { return f.readyErr }
func (f *fakeRepository) ListSources(context.Context) ([]model.SourceSummary, error) {
	return []model.SourceSummary{}, nil
}
func (f *fakeRepository) ListClusters(_ context.Context, filter model.ClusterFilter) (model.ClusterPage, error) {
	f.filter = filter
	return model.ClusterPage{Items: []model.Cluster{}, Page: filter.Page, PageSize: filter.PageSize}, nil
}
func (f *fakeRepository) ListSyncRuns(context.Context, int) ([]model.SyncRun, error) {
	return []model.SyncRun{}, nil
}
func (f *fakeRepository) QueueSync(_ context.Context, sourceID, trigger string) (model.SyncRun, error) {
	if f.queueErr != nil {
		return model.SyncRun{}, f.queueErr
	}
	return model.SyncRun{ID: "run-1", SourceID: sourceID, Trigger: trigger, Status: "queued"}, nil
}

func TestHealth(t *testing.T) {
	handler := NewHandler(config.Config{
		Environment: "test", CORSAllowedOrigin: "http://localhost:5173",
	}, &fakeRepository{})
	request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", response.Code)
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "http://localhost:5173" {
		t.Fatal("expected CORS header")
	}
}

func TestReadinessFailure(t *testing.T) {
	handler := NewHandler(config.Config{}, &fakeRepository{readyErr: errors.New("offline")})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/ready", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected status 503, got %d", response.Code)
	}
}

func TestClusterFilters(t *testing.T) {
	repository := &fakeRepository{}
	handler := NewHandler(config.Config{}, repository)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/clusters?provider=aws&page=2&pageSize=10&search=prod", nil)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", response.Code)
	}
	if repository.filter.Provider != "aws" || repository.filter.Page != 2 ||
		repository.filter.PageSize != 10 || repository.filter.Search != "prod" {
		t.Fatalf("unexpected filter: %#v", repository.filter)
	}
}

func TestRejectsInvalidProvider(t *testing.T) {
	handler := NewHandler(config.Config{}, &fakeRepository{})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/clusters?provider=other", nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d", response.Code)
	}
}

func TestQueueSync(t *testing.T) {
	handler := NewHandler(config.Config{}, &fakeRepository{})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/cloud-sources/aws-platform/sync", nil))
	if response.Code != http.StatusAccepted {
		t.Fatalf("expected status 202, got %d", response.Code)
	}
	var run model.SyncRun
	if err := json.NewDecoder(response.Body).Decode(&run); err != nil {
		t.Fatal(err)
	}
	if run.SourceID != "aws-platform" {
		t.Fatalf("unexpected source: %s", run.SourceID)
	}
}

func TestQueueSyncConflict(t *testing.T) {
	handler := NewHandler(config.Config{}, &fakeRepository{queueErr: store.ErrSyncAlreadyActive})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/cloud-sources/aws-platform/sync", nil))
	if response.Code != http.StatusConflict {
		t.Fatalf("expected status 409, got %d", response.Code)
	}
}

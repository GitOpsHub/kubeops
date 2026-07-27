package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/provider"
	"github.com/GitOpsHub/kubeops/backend/internal/store"
)

type fakeRepository struct {
	readyErr   error
	queueErr   error
	filter     model.ClusterFilter
	cluster    model.Cluster
	clusterErr error
}

func (f *fakeRepository) Ready(context.Context) error { return f.readyErr }
func (f *fakeRepository) ListSources(context.Context) ([]model.SourceSummary, error) {
	return []model.SourceSummary{}, nil
}
func (f *fakeRepository) ListClusters(_ context.Context, filter model.ClusterFilter) (model.ClusterPage, error) {
	f.filter = filter
	return model.ClusterPage{Items: []model.Cluster{}, Page: filter.Page, PageSize: filter.PageSize}, nil
}
func (f *fakeRepository) GetCluster(context.Context, string) (model.Cluster, error) {
	return f.cluster, f.clusterErr
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

type fakeClusterManager struct {
	details     model.ClusterDetails
	detailsErr  error
	scaleResult model.ScaleResult
	scaleErr    error
	poolID      string
	desired     int32
}

func (f *fakeClusterManager) Details(
	context.Context,
	model.CloudSource,
	model.Cluster,
) (model.ClusterDetails, error) {
	return f.details, f.detailsErr
}

func (f *fakeClusterManager) ScaleNodePool(
	_ context.Context,
	_ model.CloudSource,
	_ model.Cluster,
	poolID string,
	desired int32,
) (model.ScaleResult, error) {
	f.poolID, f.desired = poolID, desired
	return f.scaleResult, f.scaleErr
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

func TestClusterDetails(t *testing.T) {
	cluster := model.Cluster{ID: "cluster-1", SourceID: "aws-platform", Provider: model.ProviderAWS}
	manager := &fakeClusterManager{details: model.ClusterDetails{
		Cluster:    cluster,
		Capability: model.ClusterCapability{CanScaleNodes: true},
		NodePools:  []model.NodePool{{ID: "workers", Name: "workers", DesiredCount: 3}},
	}}
	handler := NewHandler(config.Config{CloudSources: []model.CloudSource{{
		ID: "aws-platform", Provider: model.ProviderAWS,
	}}}, &fakeRepository{cluster: cluster}, manager)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/clusters/cluster-1/details", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", response.Code)
	}
	var details model.ClusterDetails
	if err := json.NewDecoder(response.Body).Decode(&details); err != nil {
		t.Fatal(err)
	}
	if len(details.NodePools) != 1 || details.NodePools[0].ID != "workers" {
		t.Fatalf("unexpected details: %#v", details)
	}
}

func TestScaleNodePool(t *testing.T) {
	cluster := model.Cluster{ID: "cluster-1", SourceID: "aws-platform", Provider: model.ProviderAWS}
	manager := &fakeClusterManager{scaleResult: model.ScaleResult{
		NodePoolID: "workers", DesiredCount: 5, Status: "accepted",
	}}
	handler := NewHandler(config.Config{CloudSources: []model.CloudSource{{
		ID: "aws-platform", Provider: model.ProviderAWS,
	}}}, &fakeRepository{cluster: cluster}, manager)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/clusters/cluster-1/node-pools/workers/scale",
		strings.NewReader(`{"desiredCount":5}`),
	)

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("expected status 202, got %d: %s", response.Code, response.Body.String())
	}
	if manager.poolID != "workers" || manager.desired != 5 {
		t.Fatalf("unexpected scale request: pool=%q desired=%d", manager.poolID, manager.desired)
	}
}

func TestScaleNodePoolErrors(t *testing.T) {
	cluster := model.Cluster{ID: "cluster-1", SourceID: "aws-platform", Provider: model.ProviderAWS}
	tests := []struct {
		name   string
		err    error
		status int
	}{
		{"missing pool", provider.ErrNodePoolNotFound, http.StatusNotFound},
		{"busy pool", provider.ErrOperationInProgress, http.StatusConflict},
		{"unsupported pool", provider.ErrOperationUnsupported, http.StatusUnprocessableEntity},
		{"outside bounds", provider.ErrScaleOutOfBounds, http.StatusUnprocessableEntity},
		{"provider failure", errors.New("secret provider response"), http.StatusBadGateway},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manager := &fakeClusterManager{scaleErr: test.err}
			handler := NewHandler(config.Config{CloudSources: []model.CloudSource{{
				ID: "aws-platform", Provider: model.ProviderAWS,
			}}}, &fakeRepository{cluster: cluster}, manager)
			response := httptest.NewRecorder()
			request := httptest.NewRequest(
				http.MethodPost,
				"/api/clusters/cluster-1/node-pools/workers/scale",
				strings.NewReader(`{"desiredCount":5}`),
			)
			handler.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("expected status %d, got %d", test.status, response.Code)
			}
			if strings.Contains(response.Body.String(), "secret provider response") {
				t.Fatal("provider error was exposed")
			}
		})
	}
}

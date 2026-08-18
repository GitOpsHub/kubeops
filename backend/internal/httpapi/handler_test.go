package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/cloudauth"
	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/onboarding"
	"github.com/GitOpsHub/kubeops/backend/internal/provider"
	"github.com/GitOpsHub/kubeops/backend/internal/store"
	"github.com/jackc/pgx/v5"
)

type fakeRepository struct {
	readyErr   error
	queueErr   error
	listErr    error
	filter     model.ClusterFilter
	cluster    model.Cluster
	clusterErr error
	sources    []model.SourceSummary
}

func (f *fakeRepository) Ready(context.Context) error { return f.readyErr }
func (f *fakeRepository) ListSources(context.Context) ([]model.SourceSummary, error) {
	return f.sources, f.listErr
}
func (f *fakeRepository) ListClusters(_ context.Context, filter model.ClusterFilter) (model.ClusterPage, error) {
	f.filter = filter
	if f.listErr != nil {
		return model.ClusterPage{}, f.listErr
	}
	return model.ClusterPage{Items: []model.Cluster{}, Page: filter.Page, PageSize: filter.PageSize}, nil
}
func (f *fakeRepository) GetCluster(context.Context, string) (model.Cluster, error) {
	return f.cluster, f.clusterErr
}
func (f *fakeRepository) ListSyncRuns(context.Context, int) ([]model.SyncRun, error) {
	return []model.SyncRun{}, f.listErr
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

type fakeSourceSyncer struct {
	sourceID   string
	trigger    string
	run        model.SyncRun
	err        error
	allTrigger string
	allRuns    []model.SyncRun
	allErr     error
	allCalled  int
}

func (f *fakeSourceSyncer) Sync(
	_ context.Context,
	sourceID string,
	trigger string,
) (model.SyncRun, error) {
	f.sourceID = sourceID
	f.trigger = trigger
	return f.run, f.err
}

func (f *fakeSourceSyncer) SyncAll(_ context.Context, trigger string) ([]model.SyncRun, error) {
	f.allCalled++
	f.allTrigger = trigger
	return f.allRuns, f.allErr
}

type fakeApplicationOnboarder struct {
	input      onboarding.CreateInput
	filter     model.ApplicationOnboardingFilter
	record     model.ApplicationOnboarding
	err        error
	syncID     string
	scaleID    string
	replicas   int32
	offboardID string
	// Resource endpoints: what to return, and what the handler passed through.
	resources       []onboarding.ResourceNode
	manifest        string
	desiredManifest string
	resourceErr     error
	deletedRef      onboarding.ResourceRef
	logRef          onboarding.ResourceRef
	resourceTargets []string
	logStream       string
	reconcileCalls  int
}

func (f *fakeApplicationOnboarder) Reconcile(context.Context) {
	f.reconcileCalls++
}

func (f *fakeApplicationOnboarder) Resources(
	_ context.Context,
	_ string,
	targetID string,
) ([]onboarding.ResourceNode, error) {
	f.resourceTargets = append(f.resourceTargets, targetID)
	return f.resources, f.resourceErr
}
func (f *fakeApplicationOnboarder) ResourceManifests(
	_ context.Context,
	_ string,
	_ string,
	_ onboarding.ResourceRef,
) (onboarding.ResourceManifestComparison, error) {
	return onboarding.ResourceManifestComparison{
		LiveManifest:    f.manifest,
		DesiredManifest: f.desiredManifest,
	}, f.resourceErr
}
func (f *fakeApplicationOnboarder) DeleteResource(
	_ context.Context,
	_ string,
	_ string,
	ref onboarding.ResourceRef,
) error {
	f.deletedRef = ref
	return f.resourceErr
}
func (f *fakeApplicationOnboarder) PodLogs(
	_ context.Context,
	_ string,
	_ string,
	ref onboarding.ResourceRef,
) (io.ReadCloser, error) {
	f.logRef = ref
	if f.resourceErr != nil {
		return nil, f.resourceErr
	}
	return io.NopCloser(strings.NewReader(f.logStream)), nil
}

func (f *fakeApplicationOnboarder) Create(
	_ context.Context,
	input onboarding.CreateInput,
) (model.ApplicationOnboarding, error) {
	f.input = input
	return f.record, f.err
}
func (f *fakeApplicationOnboarder) Get(
	context.Context,
	string,
) (model.ApplicationOnboarding, error) {
	return f.record, f.err
}
func (f *fakeApplicationOnboarder) Sync(
	_ context.Context,
	id string,
) (model.ApplicationOnboarding, error) {
	f.syncID = id
	return f.record, f.err
}
func (f *fakeApplicationOnboarder) Scale(
	_ context.Context,
	id string,
	replicas int32,
) (model.ApplicationOnboarding, error) {
	f.scaleID = id
	f.replicas = replicas
	return f.record, f.err
}
func (f *fakeApplicationOnboarder) Offboard(
	_ context.Context,
	id string,
) (model.ApplicationOnboarding, error) {
	f.offboardID = id
	return f.record, f.err
}
func (f *fakeApplicationOnboarder) List(
	_ context.Context,
	filter model.ApplicationOnboardingFilter,
) (model.ApplicationOnboardingPage, error) {
	f.filter = filter
	if f.err != nil {
		return model.ApplicationOnboardingPage{}, f.err
	}
	return model.ApplicationOnboardingPage{
		Items: []model.ApplicationOnboarding{f.record},
		Total: 1, Page: filter.Page, PageSize: filter.PageSize,
	}, nil
}
func (f *fakeApplicationOnboarder) Defaults() onboarding.Defaults {
	return onboarding.Defaults{
		ChartName: "kubeops", ChartRevision: "0.0.1", ValuesYAML: "replicaCount: 2\n",
	}
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

func TestCORSPreflightAllowsDelete(t *testing.T) {
	handler := NewHandler(config.Config{
		CORSAllowedOrigin: "https://kubeops.example.test",
	}, &fakeRepository{})
	request := httptest.NewRequest(http.MethodOptions, "/api/application-onboardings/example", nil)
	request.Header.Set("Origin", "https://kubeops.example.test")
	request.Header.Set("Access-Control-Request-Method", http.MethodDelete)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("expected status 204, got %d", response.Code)
	}
	if methods := response.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(methods, http.MethodDelete) {
		t.Fatalf("expected DELETE in allowed methods, got %q", methods)
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
	handler := NewHandler(config.Config{CloudSources: []model.CloudSource{{
		ID: "aws-platform", Provider: model.ProviderAWS, Enabled: true,
	}}}, repository)
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
	if len(repository.filter.SourceIDs) != 1 || repository.filter.SourceIDs[0] != "aws-platform" {
		t.Fatalf("expected configured source scope, got %#v", repository.filter.SourceIDs)
	}
}

func TestSourcesHideRecordsMissingFromRuntimeConfiguration(t *testing.T) {
	repository := &fakeRepository{sources: []model.SourceSummary{
		{CloudSource: model.CloudSource{ID: "gcp-production", Enabled: true}},
		{CloudSource: model.CloudSource{ID: "docker-local", Enabled: true}},
	}}
	handler := NewHandler(config.Config{CloudSources: []model.CloudSource{{
		ID: "gcp-production", Provider: model.ProviderGCP, Enabled: true,
	}}}, repository)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/cloud-sources", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", response.Code)
	}
	var body struct {
		Items []model.SourceSummary `json:"items"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 1 || body.Items[0].ID != "gcp-production" {
		t.Fatalf("unexpected visible sources: %#v", body.Items)
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

func TestManualSyncCompletesInsideRequestWhenSyncerIsConfigured(t *testing.T) {
	repository := &fakeRepository{}
	sourceSyncer := &fakeSourceSyncer{run: model.SyncRun{
		ID: "run-1", SourceID: "gcp-platform", Trigger: "manual", Status: "succeeded",
	}}
	handler := NewHandlerWithOnboarding(
		config.Config{}, repository, nil, nil, sourceSyncer,
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		httptest.NewRequest(http.MethodPost, "/api/cloud-sources/gcp-platform/sync", nil),
	)

	if response.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", response.Code)
	}
	if sourceSyncer.sourceID != "gcp-platform" || sourceSyncer.trigger != "manual" {
		t.Fatalf("unexpected sync call: %#v", sourceSyncer)
	}
}

func TestCronSyncRequiresConfiguredSecret(t *testing.T) {
	handler := NewHandlerWithOnboarding(
		config.Config{}, &fakeRepository{}, nil, nil, &fakeSourceSyncer{},
	)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/cloud-sources/sync", nil)
	request.Header.Set("Authorization", "Bearer anything")
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected status 503, got %d", response.Code)
	}
}

func TestCronSyncRejectsWrongSecret(t *testing.T) {
	handler := NewHandlerWithOnboarding(
		config.Config{CronSecret: "correct-secret"}, &fakeRepository{}, nil, nil, &fakeSourceSyncer{},
	)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/cloud-sources/sync", nil)
	request.Header.Set("Authorization", "Bearer wrong-secret")
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected status 401, got %d", response.Code)
	}
}

func TestCronSyncRunsAllSourcesWithMatchingSecret(t *testing.T) {
	sourceSyncer := &fakeSourceSyncer{allRuns: []model.SyncRun{
		{ID: "run-1", SourceID: "aws-platform", Trigger: "cron", Status: "succeeded"},
		{ID: "run-2", SourceID: "gcp-platform", Trigger: "cron", Status: "succeeded"},
	}}
	handler := NewHandlerWithOnboarding(
		config.Config{CronSecret: "correct-secret"}, &fakeRepository{}, nil, nil, sourceSyncer,
	)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/cloud-sources/sync", nil)
	request.Header.Set("Authorization", "Bearer correct-secret")
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", response.Code)
	}
	if sourceSyncer.allCalled != 1 || sourceSyncer.allTrigger != "cron" {
		t.Fatalf("unexpected sync call: %#v", sourceSyncer)
	}
	var body struct {
		Items []model.SyncRun `json:"items"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 2 {
		t.Fatalf("expected 2 runs, got %#v", body.Items)
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

func TestClusterArgoAccess(t *testing.T) {
	target := config.ArgoTarget{
		SourceID:           "aws-platform",
		ProviderResourceID: "arn:aws:eks:us-east-1:123:cluster/prod",
		ServerURL:          "https://argo.example.test",
	}
	handler := NewHandler(config.Config{Onboarding: config.OnboardingConfig{
		PublicBaseURL: "https://kubeops.example.test",
		ArgoTargets:   []config.ArgoTarget{target},
	}}, &fakeRepository{cluster: model.Cluster{
		ID:                 "cluster-1",
		SourceID:           target.SourceID,
		ProviderResourceID: target.ProviderResourceID,
	}})
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		httptest.NewRequest(http.MethodGet, "/api/clusters/cluster-1/argo-access", nil),
	)
	if response.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", response.Code, response.Body.String())
	}
	var access model.ArgoAccess
	body := response.Body.Bytes()
	if err := json.Unmarshal(body, &access); err != nil {
		t.Fatal(err)
	}
	wantURL := "https://kubeops.example.test/argo/" + target.ProxyID() + "/applications"
	if access.URL != wantURL {
		t.Fatalf("unexpected access: %#v", access)
	}
	if strings.Contains(string(body), "username") || strings.Contains(string(body), "password") {
		t.Fatalf("Argo CD credentials leaked in response: %s", body)
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

func TestCreateApplicationOnboarding(t *testing.T) {
	onboarder := &fakeApplicationOnboarder{record: model.ApplicationOnboarding{
		ID: "onboarding-1", Name: "payments", Status: "progressing",
	}}
	handler := NewHandlerWithOnboarding(
		config.Config{},
		&fakeRepository{},
		&fakeClusterManager{},
		onboarder,
	)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/application-onboardings",
		strings.NewReader(`{
			"name":"payments",
			"namespace":"payments",
			"clusterIds":["cluster-1"],
			"valuesYaml":"replicaCount: 2\n"
		}`),
	)

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated {
		t.Fatalf("expected status 201, got %d: %s", response.Code, response.Body.String())
	}
	if onboarder.input.Name != "payments" || len(onboarder.input.ClusterIDs) != 1 {
		t.Fatalf("unexpected input: %#v", onboarder.input)
	}
}

func TestScaleApplicationOnboarding(t *testing.T) {
	onboarder := &fakeApplicationOnboarder{record: model.ApplicationOnboarding{
		ID: "onboarding-1", Name: "payments", Status: "progressing",
	}}
	handler := NewHandlerWithOnboarding(
		config.Config{}, &fakeRepository{}, &fakeClusterManager{}, onboarder,
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodPost,
		"/api/application-onboardings/onboarding-1/scale",
		strings.NewReader(`{"replicas":5}`),
	))

	if response.Code != http.StatusOK || onboarder.scaleID != "onboarding-1" ||
		onboarder.replicas != 5 {
		t.Fatalf(
			"unexpected scale response: status=%d id=%q replicas=%d body=%s",
			response.Code, onboarder.scaleID, onboarder.replicas, response.Body.String(),
		)
	}
}

func TestScaleApplicationOnboardingRequiresReplicaCount(t *testing.T) {
	handler := NewHandlerWithOnboarding(
		config.Config{}, &fakeRepository{}, &fakeClusterManager{}, &fakeApplicationOnboarder{},
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodPost,
		"/api/application-onboardings/onboarding-1/scale",
		strings.NewReader(`{}`),
	))

	if response.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: %d %s", response.Code, response.Body.String())
	}
}

func TestCreateApplicationOnboardingValidationError(t *testing.T) {
	onboarder := &fakeApplicationOnboarder{
		err: onboarding.ValidationError{Message: "valuesYaml must contain valid YAML"},
	}
	handler := NewHandlerWithOnboarding(
		config.Config{}, &fakeRepository{}, &fakeClusterManager{}, onboarder,
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		httptest.NewRequest(http.MethodPost, "/api/application-onboardings", strings.NewReader(`{}`)),
	)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected status 422, got %d", response.Code)
	}
}

func TestApplicationLifecycleActions(t *testing.T) {
	for _, test := range []struct {
		name   string
		path   string
		called func(*fakeApplicationOnboarder) string
	}{
		{
			name: "sync", path: "/api/application-onboardings/onboarding-1/sync",
			called: func(onboarder *fakeApplicationOnboarder) string { return onboarder.syncID },
		},
		{
			name: "offboard", path: "/api/application-onboardings/onboarding-1/offboard",
			called: func(onboarder *fakeApplicationOnboarder) string { return onboarder.offboardID },
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			onboarder := &fakeApplicationOnboarder{record: model.ApplicationOnboarding{
				ID: "onboarding-1", Name: "payments",
			}}
			handler := NewHandlerWithOnboarding(
				config.Config{}, &fakeRepository{}, &fakeClusterManager{}, onboarder,
			)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, test.path, nil))

			if response.Code != http.StatusOK || test.called(onboarder) != "onboarding-1" {
				t.Fatalf("unexpected lifecycle response: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestListApplicationResources(t *testing.T) {
	onboarder := &fakeApplicationOnboarder{resources: []onboarding.ResourceNode{{
		ResourceRef: onboarding.ResourceRef{
			Group: "apps", Version: "v1", Kind: "Deployment",
			Namespace: "payments", Name: "payments-api",
		},
		UID: "uid-1", HealthStatus: "Healthy", SyncStatus: "Synced",
	}}}
	handler := NewHandlerWithOnboarding(
		config.Config{}, &fakeRepository{}, &fakeClusterManager{}, onboarder,
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodGet,
		"/api/application-onboardings/onboarding-1/targets/target-9/resources",
		nil,
	))

	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d %s", response.Code, response.Body.String())
	}
	var body struct {
		Items []onboarding.ResourceNode `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 1 || body.Items[0].Kind != "Deployment" {
		t.Fatalf("unexpected resources: %#v", body.Items)
	}
	// The target must come from the path, or one deployment's resources could be
	// read through another's URL.
	if len(onboarder.resourceTargets) != 1 || onboarder.resourceTargets[0] != "target-9" {
		t.Fatalf("unexpected target routing: %#v", onboarder.resourceTargets)
	}
}

func TestDeleteApplicationResource(t *testing.T) {
	onboarder := &fakeApplicationOnboarder{}
	handler := NewHandlerWithOnboarding(
		config.Config{}, &fakeRepository{}, &fakeClusterManager{}, onboarder,
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodDelete,
		"/api/application-onboardings/onboarding-1/targets/target-1/resources"+
			"?group=apps&version=v1&kind=Deployment&namespace=payments&name=payments-api",
		nil,
	))

	if response.Code != http.StatusNoContent {
		t.Fatalf("unexpected status: %d %s", response.Code, response.Body.String())
	}
	want := onboarding.ResourceRef{
		Group: "apps", Version: "v1", Kind: "Deployment",
		Namespace: "payments", Name: "payments-api",
	}
	if onboarder.deletedRef != want {
		t.Fatalf("unexpected resource ref: %#v", onboarder.deletedRef)
	}
}

func TestStreamApplicationPodLogs(t *testing.T) {
	onboarder := &fakeApplicationOnboarder{logStream: strings.Join([]string{
		`{"result":{"timeStampStr":"2026-08-04T12:00:00Z","podName":"api-123","content":"ready","last":false}}`,
		`{"result":{"timeStampStr":"2026-08-04T12:00:01Z","podName":"","content":"","last":true}}`,
	}, "\n")}
	handler := NewHandlerWithOnboarding(
		config.Config{}, &fakeRepository{}, &fakeClusterManager{}, onboarder,
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodGet,
		"/api/application-onboardings/onboarding-1/targets/target-1/resources/logs"+
			"?version=v1&kind=Pod&namespace=payments&name=api-123",
		nil,
	))

	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != "application/x-ndjson; charset=utf-8" {
		t.Fatalf("unexpected content type: %s", response.Header().Get("Content-Type"))
	}
	if onboarder.logRef.Kind != "Pod" || onboarder.logRef.Name != "api-123" {
		t.Fatalf("unexpected log ref: %#v", onboarder.logRef)
	}
	var entry podLogEntry
	if err := json.Unmarshal(response.Body.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if entry.Content != "ready" || entry.PodName != "api-123" {
		t.Fatalf("unexpected log entry: %#v", entry)
	}
}

// An incomplete reference must not reach Argo CD, where a missing kind or name
// could match something other than what the caller meant.
func TestDeleteApplicationResourceRequiresFullReference(t *testing.T) {
	onboarder := &fakeApplicationOnboarder{}
	handler := NewHandlerWithOnboarding(
		config.Config{}, &fakeRepository{}, &fakeClusterManager{}, onboarder,
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodDelete,
		"/api/application-onboardings/onboarding-1/targets/target-1/resources?kind=Deployment",
		nil,
	))

	if response.Code != http.StatusBadRequest {
		t.Fatalf("unexpected status: %d %s", response.Code, response.Body.String())
	}
	if onboarder.deletedRef != (onboarding.ResourceRef{}) {
		t.Fatalf("a delete was attempted for %#v", onboarder.deletedRef)
	}
}

func TestApplicationResourceErrorsMapToStatus(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want int
	}{
		{name: "missing target", err: onboarding.ErrTargetNotFound, want: http.StatusNotFound},
		{name: "missing resource", err: onboarding.ErrResourceNotFound, want: http.StatusNotFound},
		{name: "logs forbidden", err: onboarding.ErrPodLogsForbidden, want: http.StatusForbidden},
		{name: "argo unreachable", err: errors.New("dial tcp: refused"), want: http.StatusBadGateway},
	} {
		t.Run(test.name, func(t *testing.T) {
			onboarder := &fakeApplicationOnboarder{resourceErr: test.err}
			handler := NewHandlerWithOnboarding(
				config.Config{}, &fakeRepository{}, &fakeClusterManager{}, onboarder,
			)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(
				http.MethodGet,
				"/api/application-onboardings/onboarding-1/targets/target-1/resources",
				nil,
			))

			if response.Code != test.want {
				t.Fatalf("unexpected status: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestListApplicationOnboardingsPaging(t *testing.T) {
	onboarder := &fakeApplicationOnboarder{record: model.ApplicationOnboarding{
		ID: "onboarding-1", Name: "payments", Status: "healthy",
	}}
	handler := NewHandlerWithOnboarding(
		config.Config{}, &fakeRepository{}, &fakeClusterManager{}, onboarder,
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodGet,
		"/api/application-onboardings?page=3&pageSize=5&search=Pay%20Ments&status=healthy",
		nil,
	))

	if response.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", response.Code, response.Body.String())
	}
	if onboarder.filter.Page != 3 || onboarder.filter.PageSize != 5 ||
		onboarder.filter.Search != "Pay Ments" || onboarder.filter.Status != "healthy" {
		t.Fatalf("unexpected filter: %#v", onboarder.filter)
	}
	if onboarder.reconcileCalls != 1 {
		t.Fatalf("expected request-driven reconciliation, got %d calls", onboarder.reconcileCalls)
	}
	var page model.ApplicationOnboardingPage
	if err := json.NewDecoder(response.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || page.Page != 3 || page.PageSize != 5 || len(page.Items) != 1 {
		t.Fatalf("unexpected page: %#v", page)
	}
}

func TestListApplicationOnboardingsDefaultsAndLegacyLimit(t *testing.T) {
	for _, test := range []struct {
		name     string
		query    string
		page     int
		pageSize int
	}{
		{name: "defaults", query: "", page: 1, pageSize: 20},
		{name: "legacy limit", query: "?limit=50", page: 1, pageSize: 50},
		{name: "pageSize wins over limit", query: "?limit=50&pageSize=7", page: 1, pageSize: 7},
	} {
		t.Run(test.name, func(t *testing.T) {
			onboarder := &fakeApplicationOnboarder{}
			handler := NewHandlerWithOnboarding(
				config.Config{}, &fakeRepository{}, &fakeClusterManager{}, onboarder,
			)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(
				http.MethodGet, "/api/application-onboardings"+test.query, nil,
			))
			if response.Code != http.StatusOK {
				t.Fatalf("expected status 200, got %d", response.Code)
			}
			if onboarder.filter.Page != test.page || onboarder.filter.PageSize != test.pageSize {
				t.Fatalf("unexpected filter: %#v", onboarder.filter)
			}
		})
	}
}

func TestListApplicationOnboardingsRejectsInvalidParameters(t *testing.T) {
	for _, query := range []string{
		"?page=0", "?page=abc", "?pageSize=0", "?pageSize=201", "?limit=201", "?status=unknown",
	} {
		t.Run(query, func(t *testing.T) {
			handler := NewHandlerWithOnboarding(
				config.Config{}, &fakeRepository{}, &fakeClusterManager{},
				&fakeApplicationOnboarder{},
			)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(
				http.MethodGet, "/api/application-onboardings"+query, nil,
			))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("expected status 400, got %d", response.Code)
			}
		})
	}
}

func TestGetApplicationOnboardingNotFound(t *testing.T) {
	handler := NewHandlerWithOnboarding(
		config.Config{}, &fakeRepository{}, &fakeClusterManager{},
		&fakeApplicationOnboarder{err: pgx.ErrNoRows},
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodGet, "/api/application-onboardings/missing", nil,
	))
	if response.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d", response.Code)
	}
}

func TestAbortedRequestsAreNotServerErrors(t *testing.T) {
	var logged bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelError})))
	t.Cleanup(func() { slog.SetDefault(previous) })

	handler := NewHandlerWithOnboarding(
		config.Config{},
		&fakeRepository{listErr: context.Canceled},
		&fakeClusterManager{},
		&fakeApplicationOnboarder{err: context.Canceled},
	)
	for _, path := range []string{
		"/api/clusters", "/api/cloud-sources", "/api/sync-runs",
		"/api/application-onboardings", "/api/application-onboardings/onboarding-1",
	} {
		t.Run(path, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx))
			// The client is gone, so the handler writes nothing rather than a 500.
			if response.Code != http.StatusOK || response.Body.Len() != 0 {
				t.Fatalf("expected an empty response, got %d: %s", response.Code, response.Body.String())
			}
		})
	}
	if logged.Len() != 0 {
		t.Fatalf("client cancellation was logged as an error: %s", logged.String())
	}
}

func TestIdentityTokenMiddlewareCarriesTheHeaderIntoContext(t *testing.T) {
	var got string
	var present bool
	handler := withIdentityToken(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got, present = cloudauth.TokenFromContext(r.Context())
	}))

	request := httptest.NewRequest(http.MethodGet, "/api/clusters", nil)
	request.Header.Set(cloudauth.VercelOIDCTokenHeader, "header-token")
	handler.ServeHTTP(httptest.NewRecorder(), request)

	if !present || got != "header-token" {
		t.Fatalf("token = %q present = %t, want the header value", got, present)
	}
}

func TestIdentityTokenMiddlewarePassesThroughWithoutAHeader(t *testing.T) {
	var present bool
	handler := withIdentityToken(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, present = cloudauth.TokenFromContext(r.Context())
	}))

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/clusters", nil))

	if present {
		t.Fatal("no identity token should be registered when the header is absent")
	}
}

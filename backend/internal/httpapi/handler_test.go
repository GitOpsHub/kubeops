package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/onboarding"
	"github.com/GitOpsHub/kubeops/backend/internal/provider"
	"github.com/GitOpsHub/kubeops/backend/internal/secure"
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
	argoAccess model.EncryptedArgoAccess
	argoErr    error
}

func (f *fakeRepository) Ready(context.Context) error { return f.readyErr }
func (f *fakeRepository) ListSources(context.Context) ([]model.SourceSummary, error) {
	return []model.SourceSummary{}, f.listErr
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
func (f *fakeRepository) GetArgoAccessByClusterID(
	context.Context,
	string,
) (model.EncryptedArgoAccess, error) {
	return f.argoAccess, f.argoErr
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

type fakeApplicationOnboarder struct {
	input  onboarding.CreateInput
	filter model.ApplicationOnboardingFilter
	record model.ApplicationOnboarding
	err    error
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

func TestClusterArgoAccess(t *testing.T) {
	key := make([]byte, secure.KeyBytes)
	ciphertext, nonce, err := secure.Encrypt(key, []byte("login-password"))
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(config.Config{Onboarding: config.OnboardingConfig{
		ArgoCredentialKey: key,
	}}, &fakeRepository{argoAccess: model.EncryptedArgoAccess{
		URL:                "https://argo.example.test",
		Username:           "kubeops",
		PasswordCiphertext: ciphertext,
		PasswordNonce:      nonce,
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
	if err := json.NewDecoder(response.Body).Decode(&access); err != nil {
		t.Fatal(err)
	}
	if access.URL != "https://argo.example.test" || access.Username != "kubeops" ||
		access.Password != "login-password" {
		t.Fatalf("unexpected access: %#v", access)
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

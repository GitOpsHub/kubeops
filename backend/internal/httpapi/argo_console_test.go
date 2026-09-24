package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/onboarding"
	"github.com/jackc/pgx/v5"
)

const consolePrefix = "/api/application-onboardings/onboarding-1"

func serveConsole(onboarder *fakeApplicationOnboarder, method, path string) *httptest.ResponseRecorder {
	handler := NewHandlerWithOnboarding(config.Config{}, &fakeRepository{}, &fakeClusterManager{}, onboarder)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(method, path, nil))
	return response
}

func TestTargetStatusRoute(t *testing.T) {
	onboarder := &fakeApplicationOnboarder{status: onboarding.ArgoAppStatus{
		Sync:   onboarding.ArgoSyncStatus{Status: "Synced", Revisions: []string{"1.0.0", "abc"}},
		Health: onboarding.ArgoHealth{Status: "Healthy"},
	}}
	response := serveConsole(onboarder, http.MethodGet, consolePrefix+"/targets/target-7/argo")
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d %s", response.Code, response.Body.String())
	}
	var body onboarding.ArgoAppStatus
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Sync.Status != "Synced" || len(onboarder.resourceTargets) != 1 ||
		onboarder.resourceTargets[0] != "target-7" {
		t.Fatalf("unexpected status routing: %#v %#v", body, onboarder.resourceTargets)
	}
}

func TestTargetEventsRoute(t *testing.T) {
	onboarder := &fakeApplicationOnboarder{events: []onboarding.ArgoEvent{{Reason: "BackOff"}}}
	response := serveConsole(onboarder, http.MethodGet,
		consolePrefix+"/targets/target-1/events?kind=Pod&name=api-1&namespace=payments&uid=u-1")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"items":[{`) {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
	want := onboarding.EventQuery{Kind: "Pod", Name: "api-1", Namespace: "payments", UID: "u-1"}
	if onboarder.eventQuery != want {
		t.Fatalf("unexpected query: %#v", onboarder.eventQuery)
	}
}

func TestContainersRoute(t *testing.T) {
	onboarder := &fakeApplicationOnboarder{containers: []onboarding.Container{{Name: "app", Image: "app:1"}}}
	response := serveConsole(onboarder, http.MethodGet,
		consolePrefix+"/targets/target-1/resources/containers?group=apps&version=v1&kind=Deployment&namespace=p&name=api")
	if response.Code != http.StatusOK ||
		response.Body.String() != `{"items":[{"name":"app","image":"app:1","init":false}]}`+"\n" {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
	if onboarder.containerRef.Kind != "Deployment" || onboarder.containerRef.Group != "apps" {
		t.Fatalf("unexpected ref: %#v", onboarder.containerRef)
	}
	response = serveConsole(&fakeApplicationOnboarder{}, http.MethodGet,
		consolePrefix+"/targets/target-1/resources/containers?kind=Pod")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an incomplete ref, got %d", response.Code)
	}
}

func TestLogsRouteParameters(t *testing.T) {
	for _, test := range []struct {
		name       string
		path       string
		wantStatus int
		check      func(*testing.T, onboarding.LogQuery)
	}{
		{
			name: "workload with every option",
			path: "/targets/target-1/logs?kind=Deployment&name=api&namespace=p&container=app" +
				"&tailLines=100&sinceTime=2026-09-24T12:00:00Z&previous=true&follow=false&filter=err",
			wantStatus: http.StatusOK,
			check: func(t *testing.T, query onboarding.LogQuery) {
				if query.Resource.Kind != "Deployment" || query.Container != "app" || query.TailLines != 100 ||
					query.SinceTime == nil || query.SinceTime.Hour() != 12 || !query.Previous ||
					query.Follow || query.Filter != "err" {
					t.Fatalf("unexpected query: %#v", query)
				}
			},
		},
		{
			name: "follow and service defaults", path: "/targets/target-1/logs?kind=Pod&name=api-1",
			wantStatus: http.StatusOK,
			check: func(t *testing.T, query onboarding.LogQuery) {
				if !query.Follow || query.TailLines != 0 || query.SinceSeconds != 0 {
					t.Fatalf("unexpected defaults: %#v", query)
				}
			},
		},
		{
			// The original route and its version-carrying query keep working.
			name:       "legacy alias",
			path:       "/targets/target-1/resources/logs?version=v1&kind=Pod&namespace=p&name=api-1",
			wantStatus: http.StatusOK,
			check: func(t *testing.T, query onboarding.LogQuery) {
				if query.Resource.Kind != "Pod" || query.Resource.Version != "v1" || !query.Follow {
					t.Fatalf("unexpected alias query: %#v", query)
				}
			},
		},
		{name: "missing name", path: "/targets/target-1/logs?kind=Pod", wantStatus: http.StatusBadRequest},
		{name: "non-numeric tail", path: "/targets/target-1/logs?kind=Pod&name=a&tailLines=all",
			wantStatus: http.StatusBadRequest},
		{name: "negative since", path: "/targets/target-1/logs?kind=Pod&name=a&sinceSeconds=-5",
			wantStatus: http.StatusBadRequest},
		{name: "bad timestamp", path: "/targets/target-1/logs?kind=Pod&name=a&sinceTime=yesterday",
			wantStatus: http.StatusBadRequest},
		{name: "bad boolean", path: "/targets/target-1/logs?kind=Pod&name=a&previous=maybe",
			wantStatus: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			onboarder := &fakeApplicationOnboarder{logStream: `{"result":{"podName":"api-1","content":"up"}}`}
			response := serveConsole(onboarder, http.MethodGet, consolePrefix+test.path)
			if response.Code != test.wantStatus {
				t.Fatalf("expected %d, got %d: %s", test.wantStatus, response.Code, response.Body.String())
			}
			if test.check != nil {
				test.check(t, onboarder.logQuery)
				if response.Body.String() != `{"podName":"api-1","content":"up"}`+"\n" {
					t.Fatalf("unexpected stream: %s", response.Body.String())
				}
			}
		})
	}
}

func TestLogsRouteMapsServiceValidationTo422(t *testing.T) {
	onboarder := &fakeApplicationOnboarder{resourceErr: onboarding.ValidationError{Message: "logs are available for Pods"}}
	response := serveConsole(onboarder, http.MethodGet, consolePrefix+"/targets/target-1/logs?kind=Service&name=a")
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d", response.Code)
	}
}

func TestRevisionRoutes(t *testing.T) {
	for _, test := range []struct {
		name       string
		path       string
		err        error
		wantStatus int
		wantBody   string
	}{
		{name: "history", path: "/revisions?limit=5", wantStatus: http.StatusOK, wantBody: `"branch":"main"`},
		{name: "history default limit", path: "/revisions", wantStatus: http.StatusOK},
		{name: "history limit too large", path: "/revisions?limit=101", wantStatus: http.StatusBadRequest},
		{name: "values", path: "/revisions/abc1234/values", wantStatus: http.StatusOK,
			wantBody: `"valuesYaml":"a: 1\n"`},
		{name: "values bad sha", path: "/revisions/HEAD~1/values", wantStatus: http.StatusBadRequest},
		{name: "values uppercase sha", path: "/revisions/ABC1234/values", wantStatus: http.StatusBadRequest},
		{name: "missing onboarding", path: "/revisions", err: pgx.ErrNoRows, wantStatus: http.StatusNotFound},
		{name: "missing revision", path: "/revisions/abc1234/values", err: onboarding.ErrRevisionNotFound,
			wantStatus: http.StatusNotFound},
		{name: "unconfigured", path: "/revisions",
			err:        onboarding.ValidationError{Message: "application values repository is not configured"},
			wantStatus: http.StatusUnprocessableEntity},
		{name: "GitHub failure", path: "/revisions",
			err:        onboarding.ExternalError{Err: errors.New("GitHub API returned status 500: token=secret")},
			wantStatus: http.StatusBadGateway, wantBody: "GitHub could not list application values history"},
	} {
		t.Run(test.name, func(t *testing.T) {
			onboarder := &fakeApplicationOnboarder{
				history:   onboarding.ValuesHistory{Path: "dev/us-east-1/values.yaml", Branch: "main"},
				valuesErr: test.err,
			}
			response := serveConsole(onboarder, http.MethodGet, consolePrefix+test.path)
			if response.Code != test.wantStatus || !strings.Contains(response.Body.String(), test.wantBody) {
				t.Fatalf("expected %d with %q, got %d: %s",
					test.wantStatus, test.wantBody, response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "secret") {
				t.Fatalf("GitHub error text reached the client: %s", response.Body.String())
			}
			if test.name == "history" && onboarder.revisionLimit != 5 {
				t.Fatalf("unexpected limit: %d", onboarder.revisionLimit)
			}
			if test.name == "history default limit" && onboarder.revisionLimit != onboarding.DefaultRevisionPage {
				t.Fatalf("unexpected default limit: %d", onboarder.revisionLimit)
			}
		})
	}
}

func TestConsoleReadErrorsMapToStatus(t *testing.T) {
	for _, test := range []struct {
		err  error
		want int
	}{
		{pgx.ErrNoRows, http.StatusNotFound},
		{onboarding.ErrTargetNotFound, http.StatusNotFound},
		{onboarding.ErrApplicationNotFound, http.StatusNotFound},
		{onboarding.ValidationError{Message: "cluster has no Argo CD target"}, http.StatusUnprocessableEntity},
		{errors.New("Argo CD API returned status 500"), http.StatusBadGateway},
	} {
		for _, path := range []string{"/targets/t/argo", "/targets/t/events"} {
			response := serveConsole(&fakeApplicationOnboarder{resourceErr: test.err}, http.MethodGet, consolePrefix+path)
			if response.Code != test.want {
				t.Fatalf("%s with %v: expected %d, got %d", path, test.err, test.want, response.Code)
			}
		}
	}
}

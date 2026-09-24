package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/onboarding"
)

func TestActionsRecordOperations(t *testing.T) {
	for _, test := range []struct {
		name        string
		method      string
		path        string
		body        string
		err         error
		wantKind    string
		wantTarget  string
		wantParams  map[string]any
		wantResult  string
		wantNoTrail bool
	}{
		{name: "plain sync", method: http.MethodPost, path: "/sync", wantKind: "sync",
			wantParams: map[string]any{"prune": true, "force": false, "applyOutOfSyncOnly": false},
			wantResult: operationSucceeded},
		{name: "subset dry run", method: http.MethodPost, path: "/sync",
			body: `{"targetIds":["t-1"],"dryRun":true,"prune":false}`, wantKind: "dry-run",
			wantParams: map[string]any{"prune": false, "force": false, "applyOutOfSyncOnly": false,
				"targetIds": []string{"t-1"}},
			wantResult: operationSucceeded},
		{name: "failed dry run", method: http.MethodPost, path: "/sync", body: `{"dryRun":true}`,
			err: onboarding.ErrDryRunFailed, wantKind: "dry-run", wantResult: operationFailed,
			wantParams: map[string]any{"prune": true, "force": false, "applyOutOfSyncOnly": false}},
		{name: "rejected sync leaves no trail", method: http.MethodPost, path: "/sync",
			body: `{"targetIds":["x"]}`, err: onboarding.ValidationError{Message: "no"}, wantNoTrail: true},
		{name: "rollback", method: http.MethodPost, path: "/rollback", body: `{"commitSha":"abc1234"}`,
			wantKind: "rollback", wantResult: operationSucceeded,
			wantParams: map[string]any{"commitSha": "abc1234", "valuesCommitSha": "rolled"}},
		{name: "failed rollback", method: http.MethodPost, path: "/rollback", body: `{"commitSha":"abc1234"}`,
			err: onboarding.ExternalError{Err: errors.New("status 500")}, wantKind: "rollback",
			wantResult: operationFailed, wantParams: map[string]any{"commitSha": "abc1234"}},
		{name: "terminate", method: http.MethodDelete, path: "/targets/t-2/operation", wantKind: "terminate",
			wantTarget: "t-2", wantResult: operationSucceeded},
		{name: "scale", method: http.MethodPost, path: "/scale", body: `{"replicas":3}`, wantKind: "scale",
			wantParams: map[string]any{"replicas": int32(3)}, wantResult: operationSucceeded},
		{name: "offboard", method: http.MethodPost, path: "/offboard", wantKind: "offboard",
			wantParams: map[string]any{}, wantResult: operationSucceeded},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &fakeRepository{}
			onboarder := &fakeApplicationOnboarder{
				record: model.ApplicationOnboarding{ID: "onboarding-1", ValuesCommitSHA: "rolled"},
				err:    test.err,
			}
			handler := NewHandlerWithOnboarding(config.Config{
				Onboarding: config.OnboardingConfig{ConsoleMutations: true},
			}, repository, &fakeClusterManager{}, onboarder)
			request := httptest.NewRequest(test.method,
				"/api/application-onboardings/onboarding-1"+test.path, strings.NewReader(test.body))
			if test.body != "" {
				request.Header.Set("Content-Type", "application/json")
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if test.wantNoTrail {
				if len(repository.operations) != 0 {
					t.Fatalf("unexpected trail: %#v", repository.operations)
				}
				return
			}
			if len(repository.operations) != 1 {
				t.Fatalf("expected one operation, got %#v (%d %s)",
					repository.operations, response.Code, response.Body.String())
			}
			operation := repository.operations[0]
			if operation.OnboardingID != "onboarding-1" || operation.Kind != test.wantKind ||
				operation.Result != test.wantResult || !reflect.DeepEqual(operation.Params, test.wantParams) {
				t.Fatalf("unexpected operation: %#v", operation)
			}
			if (operation.TargetID == nil) != (test.wantTarget == "") ||
				(operation.TargetID != nil && *operation.TargetID != test.wantTarget) {
				t.Fatalf("unexpected target: %#v", operation.TargetID)
			}
		})
	}
}

// The trail is best effort: failing to write it must not fail an action that
// already happened.
func TestOperationRecordingFailureKeepsTheResponse(t *testing.T) {
	repository := &fakeRepository{recordErr: errors.New("database down")}
	onboarder := &fakeApplicationOnboarder{record: model.ApplicationOnboarding{ID: "onboarding-1"}}
	handler := NewHandlerWithOnboarding(config.Config{}, repository, &fakeClusterManager{}, onboarder)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost,
		"/api/application-onboardings/onboarding-1/offboard", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
}

func TestListApplicationOperations(t *testing.T) {
	for _, test := range []struct {
		query      string
		wantStatus int
		wantLimit  int
	}{
		{query: "", wantStatus: http.StatusOK, wantLimit: 50},
		{query: "?limit=200", wantStatus: http.StatusOK, wantLimit: 200},
		{query: "?limit=0", wantStatus: http.StatusBadRequest},
		{query: "?limit=201", wantStatus: http.StatusBadRequest},
	} {
		t.Run(test.query, func(t *testing.T) {
			repository := &fakeRepository{operations: []model.ApplicationOperation{{ID: "op-1", Kind: "sync"}}}
			handler := NewHandler(config.Config{}, repository)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet,
				"/api/application-onboardings/onboarding-1/operations"+test.query, nil))
			if response.Code != test.wantStatus {
				t.Fatalf("expected %d, got %d", test.wantStatus, response.Code)
			}
			if test.wantStatus == http.StatusOK && (repository.operationsID != "onboarding-1" ||
				repository.operationsLimit != test.wantLimit ||
				!strings.Contains(response.Body.String(), `"items":[{"id":"op-1"`)) {
				t.Fatalf("unexpected listing: %s (limit %d)", response.Body.String(), repository.operationsLimit)
			}
		})
	}
}

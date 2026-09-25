package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/onboarding"
	"github.com/jackc/pgx/v5"
)

func serveMutation(
	onboarder *fakeApplicationOnboarder,
	mutations bool,
	method, path, contentType, body string,
) *httptest.ResponseRecorder {
	return serveMutationWithStore(&fakeRepository{}, onboarder, mutations, method, path, contentType, body)
}

// serveMutationWithStore is serveMutation with a repository the caller can
// inspect afterwards, e.g. for the audit rows a mutation wrote.
func serveMutationWithStore(
	repository *fakeRepository,
	onboarder *fakeApplicationOnboarder,
	mutations bool,
	method, path, contentType, body string,
) *httptest.ResponseRecorder {
	handler := NewHandlerWithOnboarding(config.Config{
		Onboarding: config.OnboardingConfig{ConsoleMutations: mutations},
	}, repository, &fakeClusterManager{}, onboarder)
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestSyncRequestBody(t *testing.T) {
	for _, test := range []struct {
		name        string
		contentType string
		body        string
		err         error
		wantStatus  int
		want        *onboarding.SyncOptions
	}{
		{name: "empty body keeps the original sync", wantStatus: http.StatusOK},
		{name: "whitespace body is empty", body: " \n", wantStatus: http.StatusOK},
		{name: "empty object defaults to pruning", contentType: "application/json", body: `{}`,
			wantStatus: http.StatusOK, want: &onboarding.SyncOptions{Prune: true}},
		{name: "every option", contentType: "application/json; charset=utf-8",
			body:       `{"targetIds":["t-1"],"prune":false,"dryRun":true,"force":true,"applyOutOfSyncOnly":true}`,
			wantStatus: http.StatusOK, want: &onboarding.SyncOptions{
				TargetIDs: []string{"t-1"}, DryRun: true, Force: true, ApplyOutOfSyncOnly: true,
			}},
		{name: "no content type", body: `{}`, wantStatus: http.StatusUnsupportedMediaType},
		{name: "form content type", contentType: "application/x-www-form-urlencoded", body: `{}`,
			wantStatus: http.StatusUnsupportedMediaType},
		{name: "unknown field", contentType: "application/json", body: `{"revision":"main"}`,
			wantStatus: http.StatusBadRequest},
		{name: "two objects", contentType: "application/json", body: `{}{}`, wantStatus: http.StatusBadRequest},
		{name: "too large", contentType: "application/json",
			body: `{"targetIds":["` + strings.Repeat("x", 5000) + `"]}`, wantStatus: http.StatusRequestEntityTooLarge},
		{name: "unknown target", contentType: "application/json", body: `{"targetIds":["t-9"]}`,
			err:        onboarding.ValidationError{Message: "targetIds must name deployment targets of this application"},
			wantStatus: http.StatusUnprocessableEntity},
		{name: "dry run refused", contentType: "application/json", body: `{"dryRun":true}`,
			err: errors.Join(onboarding.ErrDryRunFailed), wantStatus: http.StatusBadGateway},
		{name: "missing onboarding", contentType: "application/json", body: `{}`,
			err: pgx.ErrNoRows, wantStatus: http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			onboarder := &fakeApplicationOnboarder{
				record: model.ApplicationOnboarding{ID: "onboarding-1"}, err: test.err,
			}
			response := serveMutation(onboarder, true, http.MethodPost,
				"/api/application-onboardings/onboarding-1/sync", test.contentType, test.body)
			if response.Code != test.wantStatus {
				t.Fatalf("expected %d, got %d: %s", test.wantStatus, response.Code, response.Body.String())
			}
			if test.wantStatus != http.StatusOK {
				return
			}
			if onboarder.syncID != "onboarding-1" {
				t.Fatalf("sync was not called: %#v", onboarder)
			}
			switch {
			case test.want == nil && onboarder.syncOptions != nil:
				t.Fatalf("an empty body must use the original sync, got %#v", onboarder.syncOptions)
			case test.want != nil && (onboarder.syncOptions == nil ||
				onboarder.syncOptions.Prune != test.want.Prune ||
				onboarder.syncOptions.DryRun != test.want.DryRun ||
				onboarder.syncOptions.Force != test.want.Force ||
				onboarder.syncOptions.ApplyOutOfSyncOnly != test.want.ApplyOutOfSyncOnly ||
				strings.Join(onboarder.syncOptions.TargetIDs, ",") != strings.Join(test.want.TargetIDs, ",")):
				t.Fatalf("expected %#v, got %#v", test.want, onboarder.syncOptions)
			}
		})
	}
}

func TestTerminateOperationRoute(t *testing.T) {
	for _, test := range []struct {
		name       string
		mutations  bool
		err        error
		wantStatus int
	}{
		{name: "terminated", mutations: true, wantStatus: http.StatusNoContent},
		{name: "nothing running", mutations: true, err: onboarding.ErrNoOperation, wantStatus: http.StatusConflict},
		{name: "unknown target", mutations: true, err: onboarding.ErrTargetNotFound, wantStatus: http.StatusNotFound},
		{name: "argo unreachable", mutations: true, err: errors.New("dial tcp"), wantStatus: http.StatusBadGateway},
		{name: "disabled", mutations: false, wantStatus: http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			onboarder := &fakeApplicationOnboarder{err: test.err}
			response := serveMutation(onboarder, test.mutations, http.MethodDelete,
				"/api/application-onboardings/onboarding-1/targets/target-2/operation", "", "")
			if response.Code != test.wantStatus {
				t.Fatalf("expected %d, got %d: %s", test.wantStatus, response.Code, response.Body.String())
			}
			if test.mutations && onboarder.terminated != "onboarding-1/target-2" {
				t.Fatalf("unexpected terminate routing: %q", onboarder.terminated)
			}
			if !test.mutations && onboarder.terminated != "" {
				t.Fatal("a disabled terminate reached the service")
			}
		})
	}
}

func TestRollbackRoute(t *testing.T) {
	const body = `{"commitSha":"abc1234"}`
	const rollbackCommit = "fed9876aaaabbbbccccddddeeeeffff000011112"
	for _, test := range []struct {
		name        string
		mutations   bool
		contentType string
		body        string
		err         error
		wantStatus  int
		wantMessage string
		// wantAudit is the result of the one audit row the request must
		// write, or empty when it must write none.
		wantAudit       string
		wantAuditCommit string
	}{
		{name: "rolled back", mutations: true, contentType: "application/json", body: body,
			wantStatus: http.StatusOK, wantAudit: operationSucceeded, wantAuditCommit: rollbackCommit},
		{name: "disabled", contentType: "application/json", body: body, wantStatus: http.StatusForbidden},
		{name: "no body", mutations: true, wantStatus: http.StatusBadRequest},
		{name: "bad sha", mutations: true, contentType: "application/json", body: `{"commitSha":"main"}`,
			wantStatus: http.StatusBadRequest},
		{name: "wrong content type", mutations: true, contentType: "text/plain", body: body,
			wantStatus: http.StatusUnsupportedMediaType},
		{name: "unknown field", mutations: true, contentType: "application/json",
			body: `{"commitSha":"abc1234","path":"values.yaml"}`, wantStatus: http.StatusBadRequest},
		{name: "unchanged", mutations: true, contentType: "application/json", body: body,
			err:        onboarding.ValidationError{Message: "values at abc1234 already match the current values"},
			wantStatus: http.StatusUnprocessableEntity, wantMessage: "already match"},
		{name: "GitHub failure", mutations: true, contentType: "application/json", body: body,
			err:        onboarding.ExternalError{Err: errors.New("GitHub API returned status 500: token=secret")},
			wantStatus: http.StatusBadGateway, wantMessage: "GitHub could not roll back application values",
			wantAudit: operationFailed},
		{name: "values changed during the rollback", mutations: true, contentType: "application/json", body: body,
			err:         fmt.Errorf("commit: %w", onboarding.ErrValuesConflict),
			wantStatus:  http.StatusConflict,
			wantMessage: `"the values file changed while rolling back; refresh and try again"`},
		{name: "committed but not synced", mutations: true, contentType: "application/json", body: body,
			err: onboarding.RollbackFollowUpError{
				CommitSHA: rollbackCommit, Step: onboarding.RollbackStepSync, Err: errors.New("token=secret"),
			},
			wantStatus: http.StatusBadGateway,
			wantMessage: `"error":"Rolled back values in commit fed9876, but KubeOps could not start the sync. ` +
				`Argo CD's automated sync will still apply it.","valuesCommitSha":"` + rollbackCommit + `"`,
			wantAudit: operationSucceeded, wantAuditCommit: rollbackCommit},
		{name: "committed but not recorded", mutations: true, contentType: "application/json", body: body,
			err: onboarding.RollbackFollowUpError{
				CommitSHA: rollbackCommit, Step: onboarding.RollbackStepRecord, Err: errors.New("token=secret"),
			},
			wantStatus:  http.StatusInternalServerError,
			wantMessage: "Rolled back values in commit fed9876, but KubeOps could not record it.",
			wantAudit:   operationSucceeded, wantAuditCommit: rollbackCommit},
		{name: "missing onboarding", mutations: true, contentType: "application/json", body: body,
			err: pgx.ErrNoRows, wantStatus: http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			onboarder := &fakeApplicationOnboarder{
				record: model.ApplicationOnboarding{ID: "onboarding-1", ValuesCommitSHA: rollbackCommit}, err: test.err,
			}
			repository := &fakeRepository{}
			response := serveMutationWithStore(repository, onboarder, test.mutations, http.MethodPost,
				"/api/application-onboardings/onboarding-1/rollback", test.contentType, test.body)
			if response.Code != test.wantStatus || !strings.Contains(response.Body.String(), test.wantMessage) {
				t.Fatalf("expected %d %q, got %d: %s",
					test.wantStatus, test.wantMessage, response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "secret") {
				t.Fatalf("GitHub error text reached the client: %s", response.Body.String())
			}
			if test.wantStatus == http.StatusOK &&
				(onboarder.rollbackID != "onboarding-1" || onboarder.rollbackSHA != "abc1234") {
				t.Fatalf("unexpected rollback call: %q %q", onboarder.rollbackID, onboarder.rollbackSHA)
			}
			if !test.mutations && onboarder.rollbackID != "" {
				t.Fatal("a disabled rollback reached the service")
			}
			if test.wantAudit == "" {
				if len(repository.operations) != 0 {
					t.Fatalf("expected no audit row, got %#v", repository.operations)
				}
				return
			}
			if len(repository.operations) != 1 {
				t.Fatalf("expected one audit row, got %#v", repository.operations)
			}
			operation := repository.operations[0]
			if operation.Kind != "rollback" || operation.Result != test.wantAudit ||
				operation.Params["commitSha"] != "abc1234" ||
				(test.wantAuditCommit != "" && operation.Params["valuesCommitSha"] != test.wantAuditCommit) {
				t.Fatalf("unexpected audit row: %#v", operation)
			}
		})
	}
}

// Server-side failures may have changed something, so they are audited; a
// request refused as invalid changed nothing and is not.
func TestActionFailuresAreAudited(t *testing.T) {
	const prefix = "/api/application-onboardings/onboarding-1"
	const jsonType = "application/json"
	for _, test := range []struct {
		name        string
		method      string
		path        string
		contentType string
		body        string
		err         error
		wantStatus  int
		// wantKind is the audited operation's kind, empty when none is recorded.
		wantKind   string
		wantResult string
	}{
		{name: "sync fails", method: http.MethodPost, path: "/sync",
			err: errors.New("db down"), wantStatus: http.StatusInternalServerError,
			wantKind: "sync", wantResult: operationFailed},
		{name: "sync with options fails", method: http.MethodPost, path: "/sync",
			contentType: jsonType, body: `{"prune":false}`,
			err: errors.New("db down"), wantStatus: http.StatusInternalServerError,
			wantKind: "sync", wantResult: operationFailed},
		{name: "dry run refused by Argo CD", method: http.MethodPost, path: "/sync",
			contentType: jsonType, body: `{"dryRun":true}`, err: onboarding.ErrDryRunFailed,
			wantStatus: http.StatusBadGateway, wantKind: "dry-run", wantResult: operationFailed},
		{name: "offboard fails", method: http.MethodPost, path: "/offboard",
			err: errors.New("db down"), wantStatus: http.StatusInternalServerError,
			wantKind: "offboard", wantResult: operationFailed},
		{name: "scale fails", method: http.MethodPost, path: "/scale",
			contentType: jsonType, body: `{"replicas":3}`, err: errors.New("db down"),
			wantStatus: http.StatusInternalServerError, wantKind: "scale", wantResult: operationFailed},
		{name: "scale refused by GitHub", method: http.MethodPost, path: "/scale",
			contentType: jsonType, body: `{"replicas":3}`, err: onboarding.ExternalError{Err: errors.New("500")},
			wantStatus: http.StatusBadGateway, wantKind: "scale", wantResult: operationFailed},
		{name: "terminate cannot reach Argo CD", method: http.MethodDelete, path: "/targets/target-1/operation",
			err: errors.New("dial tcp: refused"), wantStatus: http.StatusBadGateway,
			wantKind: "terminate", wantResult: operationFailed},
		{name: "rollback fails", method: http.MethodPost, path: "/rollback",
			contentType: jsonType, body: `{"commitSha":"abc1234"}`, err: errors.New("db down"),
			wantStatus: http.StatusInternalServerError, wantKind: "rollback", wantResult: operationFailed},
		{name: "sync succeeds", method: http.MethodPost, path: "/sync",
			wantStatus: http.StatusOK, wantKind: "sync", wantResult: operationSucceeded},
		{name: "sync of a missing onboarding", method: http.MethodPost, path: "/sync",
			err: pgx.ErrNoRows, wantStatus: http.StatusNotFound},
		{name: "sync of an unknown target", method: http.MethodPost, path: "/sync",
			contentType: jsonType, body: `{"targetIds":["other"]}`,
			err:        onboarding.ValidationError{Message: "targetIds must name deployment targets"},
			wantStatus: http.StatusUnprocessableEntity},
		{name: "scale rejected", method: http.MethodPost, path: "/scale",
			contentType: jsonType, body: `{"replicas":3}`,
			err: onboarding.ValidationError{Message: "replicas out of range"}, wantStatus: http.StatusUnprocessableEntity},
		{name: "terminate with nothing running", method: http.MethodDelete, path: "/targets/target-1/operation",
			err: onboarding.ErrNoOperation, wantStatus: http.StatusConflict},
		{name: "terminate of an unknown target", method: http.MethodDelete, path: "/targets/target-1/operation",
			err: onboarding.ErrTargetNotFound, wantStatus: http.StatusNotFound},
		{name: "rollback rejected", method: http.MethodPost, path: "/rollback",
			contentType: jsonType, body: `{"commitSha":"abc1234"}`,
			err:        onboarding.ValidationError{Message: "values at abc1234 already match the current values"},
			wantStatus: http.StatusUnprocessableEntity},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &fakeRepository{}
			onboarder := &fakeApplicationOnboarder{record: model.ApplicationOnboarding{ID: "onboarding-1"}, err: test.err}
			response := serveMutationWithStore(repository, onboarder, true, test.method, prefix+test.path,
				test.contentType, test.body)
			if response.Code != test.wantStatus {
				t.Fatalf("expected %d, got %d: %s", test.wantStatus, response.Code, response.Body.String())
			}
			if test.wantKind == "" {
				if len(repository.operations) != 0 {
					t.Fatalf("a %d must not be audited: %#v", response.Code, repository.operations)
				}
				return
			}
			if len(repository.operations) != 1 || repository.operations[0].Kind != test.wantKind ||
				repository.operations[0].Result != test.wantResult {
				t.Fatalf("expected one %s %s row, got %#v", test.wantResult, test.wantKind, repository.operations)
			}
		})
	}
}

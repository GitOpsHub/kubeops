package onboarding

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
)

func testArgoClient(t *testing.T, handler http.HandlerFunc) *HTTPArgoClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewHTTPArgoClient(config.ArgoTarget{
		SourceID: "aws", ServerURL: server.URL, Token: "test-token",
	}, config.OnboardingConfig{RequestTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestHTTPArgoClientLogsRequest(t *testing.T) {
	since := time.Date(2026, 9, 24, 12, 0, 0, 500, time.UTC)
	for _, test := range []struct {
		name  string
		query LogQuery
		want  string
	}{
		{
			name: "pod reads the pod endpoint",
			query: LogQuery{
				Resource:  ResourceRef{Kind: "Pod", Namespace: "dev", Name: "nginx-123"},
				TailLines: 500, Follow: true,
			},
			want: "/api/v1/applications/nginx/pods/nginx-123/logs?" +
				"appNamespace=argo-cd&follow=true&namespace=dev&tailLines=500",
		},
		{
			name: "pod with every option",
			query: LogQuery{
				Resource:  ResourceRef{Kind: "Pod", Namespace: "dev", Name: "nginx-123"},
				Container: "app", TailLines: 10, SinceSeconds: 60, Previous: true,
				Filter: "error level", Follow: false,
			},
			want: "/api/v1/applications/nginx/pods/nginx-123/logs?" +
				"appNamespace=argo-cd&container=app&filter=error+level&follow=false" +
				"&namespace=dev&previous=true&sinceSeconds=60&tailLines=10",
		},
		{
			name: "deployment merges its pods through the application endpoint",
			query: LogQuery{
				Resource:  ResourceRef{Group: "ignored", Kind: "Deployment", Namespace: "dev", Name: "nginx"},
				TailLines: 500, Follow: true,
			},
			want: "/api/v1/applications/nginx/logs?appNamespace=argo-cd&follow=true" +
				"&group=apps&kind=Deployment&namespace=dev&resourceName=nginx&tailLines=500",
		},
		{
			name: "job uses the batch group and sinceTime is flattened",
			query: LogQuery{
				Resource:  ResourceRef{Kind: "Job", Namespace: "dev", Name: "migrate"},
				TailLines: 5, SinceTime: &since,
			},
			want: fmt.Sprintf("/api/v1/applications/nginx/logs?appNamespace=argo-cd&follow=false"+
				"&group=batch&kind=Job&namespace=dev&resourceName=migrate"+
				"&sinceTime.nanos=500&sinceTime.seconds=%d&tailLines=5", since.Unix()),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requested string
			client := testArgoClient(t, func(w http.ResponseWriter, r *http.Request) {
				requested = r.URL.RequestURI()
				_, _ = w.Write([]byte(`{"result":{"content":"ready"}}` + "\n"))
			})
			stream, err := client.Logs(context.Background(), "nginx", "argo-cd", test.query)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(stream)
			stream.Close()
			if !strings.Contains(string(body), `"content":"ready"`) {
				t.Fatalf("unexpected stream: %s", body)
			}
			if requested != test.want {
				t.Fatalf("unexpected request:\n got %s\nwant %s", requested, test.want)
			}
		})
	}
}

func TestHTTPArgoClientLogsErrors(t *testing.T) {
	for _, test := range []struct {
		status int
		want   error
	}{
		{http.StatusNotFound, ErrResourceNotFound},
		{http.StatusForbidden, ErrPodLogsForbidden},
		{http.StatusInternalServerError, argoAPIError{status: http.StatusInternalServerError}},
	} {
		t.Run(http.StatusText(test.status), func(t *testing.T) {
			client := testArgoClient(t, func(w http.ResponseWriter, _ *http.Request) {
				http.Error(w, "token=secret", test.status)
			})
			_, err := client.Logs(context.Background(), "nginx", "argo-cd", LogQuery{
				Resource: ResourceRef{Kind: "Pod", Name: "nginx-1"},
			})
			if !errors.Is(err, test.want) || strings.Contains(fmt.Sprint(err), "secret") {
				t.Fatalf("expected %v, got %v", test.want, err)
			}
		})
	}
}

// The status response is served to unauthenticated callers, so where the chart
// and values live must not survive the decoder.
func TestHTTPArgoClientApplicationStatus(t *testing.T) {
	const application = `{
		"metadata": {"name": "payments"},
		"spec": {"sources": [
			{"repoURL": "https://charts.example.test", "chart": "app"},
			{"repoURL": "https://github.com/GitOpsHub/payments.git", "ref": "values"}
		]},
		"status": {
			"sync": {"status": "OutOfSync", "revisions": ["1.2.3", "abc123"]},
			"health": {"status": "Progressing", "message": "rolling out"},
			"operationState": {
				"phase": "Running", "message": "waiting for hook",
				"startedAt": "2026-09-24T12:00:00Z", "retryCount": 1,
				"operation": {
					"initiatedBy": {"username": "admin"},
					"sync": {"dryRun": true, "prune": true, "revisions": ["1.2.3", "abc123"]}
				},
				"syncResult": {
					"revisions": ["1.2.3", "def456"],
					"source": {"repoURL": "https://charts.example.test"},
					"resources": [{
						"group": "batch", "version": "v1", "kind": "Job", "namespace": "payments",
						"name": "migrate", "status": "Synced", "message": "job created",
						"hookType": "PreSync", "hookPhase": "Running", "syncPhase": "PreSync"
					}]
				}
			},
			"history": [
				{"id": 1, "revisions": ["1.2.2", "aaa"], "deployedAt": "2026-09-20T00:00:00Z",
				 "sources": [{"repoURL": "https://charts.example.test"}]},
				{"id": 2, "revision": "bbb", "deployStartedAt": "2026-09-21T00:00:00Z",
				 "deployedAt": "2026-09-21T00:01:00Z", "initiatedBy": {"automated": true}}
			],
			"conditions": [{
				"type": "ComparisonError",
				"message": "failed to fetch https://bot:ghp_secret@github.com/GitOpsHub/payments.git",
				"lastTransitionTime": "2026-09-24T11:00:00Z"
			}],
			"summary": {"images": ["nginx:1.27"]},
			"reconciledAt": "2026-09-24T12:00:05Z",
			"sourceTypes": ["Helm"]
		}
	}`
	var requested string
	client := testArgoClient(t, func(w http.ResponseWriter, r *http.Request) {
		requested = r.URL.RequestURI()
		_, _ = w.Write([]byte(application))
	})
	status, err := client.ApplicationStatus(context.Background(), "payments", "argo-cd")
	if err != nil {
		t.Fatal(err)
	}
	if requested != "/api/v1/applications/payments?appNamespace=argo-cd" {
		t.Fatalf("unexpected request: %s", requested)
	}
	if status.Sync.Status != "OutOfSync" || !reflect.DeepEqual(status.Sync.Revisions, []string{"1.2.3", "abc123"}) ||
		status.Health.Status != "Progressing" || status.Health.Message != "rolling out" {
		t.Fatalf("unexpected sync or health: %#v %#v", status.Sync, status.Health)
	}
	operation := status.Operation
	if operation == nil || operation.Phase != "Running" || operation.RetryCount != 1 ||
		operation.InitiatedBy.Username != "admin" || !operation.DryRun || !operation.Prune ||
		operation.StartedAt == nil || operation.FinishedAt != nil ||
		!reflect.DeepEqual(operation.Revisions, []string{"1.2.3", "def456"}) ||
		len(operation.Resources) != 1 || operation.Resources[0].HookPhase != "Running" {
		t.Fatalf("unexpected operation: %#v", operation)
	}
	if len(status.History) != 2 || status.History[0].ID != 2 ||
		!reflect.DeepEqual(status.History[0].Revisions, []string{"bbb"}) ||
		!status.History[0].InitiatedBy.Automated || status.History[1].ID != 1 {
		t.Fatalf("history must be newest first: %#v", status.History)
	}
	if len(status.Conditions) != 1 ||
		status.Conditions[0].Message != "failed to fetch https://github.com/GitOpsHub/payments.git" {
		t.Fatalf("condition credentials were not scrubbed: %#v", status.Conditions)
	}
	if !reflect.DeepEqual(status.Images, []string{"nginx:1.27"}) || status.ReconciledAt == nil {
		t.Fatalf("unexpected summary: %#v", status)
	}
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"repoURL", `"source":`, `"sources":`, "charts.example.test", "ghp_secret"} {
		if strings.Contains(string(encoded), leak) {
			t.Fatalf("status response exposes %q: %s", leak, encoded)
		}
	}
}

func TestHTTPArgoClientApplicationStatusWithoutOperation(t *testing.T) {
	client := testArgoClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":{"sync":{"revision":"abc"}}}`))
	})
	status, err := client.ApplicationStatus(context.Background(), "payments", "argo-cd")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(status)
	// Collections are empty arrays rather than null so the UI can map them.
	want := `{"sync":{"status":"Unknown","revisions":["abc"]},"health":{"status":"Unknown"},` +
		`"operation":null,"history":[],"conditions":[],"images":[],"reconciledAt":null}`
	if string(encoded) != want {
		t.Fatalf("unexpected encoding:\n got %s\nwant %s", encoded, want)
	}
}

func TestHTTPArgoClientApplicationEvents(t *testing.T) {
	events := `{"items": [
		{"involvedObject": {"kind": "Pod", "name": "api-1", "namespace": "payments", "uid": "u1"},
		 "reason": "BackOff", "message": "Back-off restarting", "type": "Warning", "count": 4,
		 "source": {"component": "kubelet"},
		 "firstTimestamp": "2026-09-24T10:00:00Z", "lastTimestamp": "2026-09-24T12:00:00Z"},
		{"involvedObject": {"kind": "ReplicaSet", "name": "api-rs", "namespace": "payments"},
		 "reason": "SuccessfulCreate", "message": "Created pod", "type": "Normal",
		 "reportingComponent": "replicaset-controller",
		 "eventTime": "2026-09-24T11:00:00.123456Z"},
		{"involvedObject": {"kind": "Pod", "name": "api-2", "namespace": "payments"},
		 "reason": "Pulled", "message": "pulled", "type": "Normal",
		 "series": {"count": 7, "lastObservedTime": "2026-09-24T13:00:00Z"},
		 "eventTime": "2026-09-24T09:00:00Z"}
	]}`
	for _, test := range []struct {
		name        string
		query       EventQuery
		wantRequest string
		wantReasons []string
	}{
		{
			name:        "application events, newest first",
			wantRequest: "/api/v1/applications/payments/events?appNamespace=argo-cd",
			wantReasons: []string{"Pulled", "BackOff", "SuccessfulCreate"},
		},
		{
			name:  "one resource, filtered by kind",
			query: EventQuery{Kind: "Pod", Name: "api-1", Namespace: "payments", UID: "u1"},
			wantRequest: "/api/v1/applications/payments/events?appNamespace=argo-cd" +
				"&resourceName=api-1&resourceNamespace=payments&resourceUID=u1",
			wantReasons: []string{"Pulled", "BackOff"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requested string
			client := testArgoClient(t, func(w http.ResponseWriter, r *http.Request) {
				requested = r.URL.RequestURI()
				_, _ = w.Write([]byte(events))
			})
			items, err := client.ApplicationEvents(context.Background(), "payments", "argo-cd", test.query)
			if err != nil {
				t.Fatal(err)
			}
			if requested != test.wantRequest {
				t.Fatalf("unexpected request: %s", requested)
			}
			var reasons []string
			for _, item := range items {
				reasons = append(reasons, item.Reason)
			}
			if !reflect.DeepEqual(reasons, test.wantReasons) {
				t.Fatalf("unexpected events: %v", reasons)
			}
		})
	}

	client := testArgoClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(events))
	})
	items, err := client.ApplicationEvents(context.Background(), "payments", "argo-cd", EventQuery{})
	if err != nil {
		t.Fatal(err)
	}
	pulled, backOff, created := items[0], items[1], items[2]
	if pulled.Count != 7 || pulled.LastSeen == nil || pulled.LastSeen.Hour() != 13 ||
		pulled.FirstSeen == nil || pulled.FirstSeen.Hour() != 9 {
		t.Fatalf("series events must use the series count and time: %#v", pulled)
	}
	if backOff.Count != 4 || backOff.Source != "kubelet" || backOff.Object.UID != "u1" {
		t.Fatalf("unexpected legacy event: %#v", backOff)
	}
	if created.Count != 1 || created.Source != "replicaset-controller" ||
		created.FirstSeen == nil || created.LastSeen == nil {
		t.Fatalf("unexpected events.k8s.io event: %#v", created)
	}
}

func TestHTTPArgoClientApplicationEventsCapsTheList(t *testing.T) {
	var items []string
	for index := 0; index < maxEvents+50; index++ {
		items = append(items, fmt.Sprintf(`{"reason":"R%d","lastTimestamp":"2026-09-24T12:%02d:%02dZ"}`,
			index, (index/60)%60, index%60))
	}
	client := testArgoClient(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"items":[` + strings.Join(items, ",") + `]}`))
	})
	events, err := client.ApplicationEvents(context.Background(), "payments", "argo-cd", EventQuery{})
	if err != nil || len(events) != maxEvents || events[0].Reason != fmt.Sprintf("R%d", maxEvents+49) {
		t.Fatalf("expected the newest %d events, got %d, %v", maxEvents, len(events), err)
	}
}

func TestHTTPArgoClientSyncBody(t *testing.T) {
	for _, test := range []struct {
		name    string
		options SyncOptions
		want    string
	}{
		{name: "default prunes", options: DefaultSyncOptions(),
			want: `{"appNamespace":"argo-cd","name":"payments","prune":true}`},
		{name: "no prune", options: SyncOptions{},
			want: `{"appNamespace":"argo-cd","name":"payments","prune":false}`},
		{name: "dry run", options: SyncOptions{Prune: true, DryRun: true},
			want: `{"appNamespace":"argo-cd","dryRun":true,"name":"payments","prune":true}`},
		{name: "force", options: SyncOptions{Prune: true, Force: true},
			want: `{"appNamespace":"argo-cd","name":"payments","prune":true,"strategy":{"apply":{"force":true}}}`},
		{name: "apply out of sync only", options: SyncOptions{ApplyOutOfSyncOnly: true},
			want: `{"appNamespace":"argo-cd","name":"payments","prune":false,` +
				`"syncOptions":{"items":["ApplyOutOfSyncOnly=true"]}}`},
		{name: "everything", options: SyncOptions{Prune: true, DryRun: true, Force: true, ApplyOutOfSyncOnly: true},
			want: `{"appNamespace":"argo-cd","dryRun":true,"name":"payments","prune":true,` +
				`"strategy":{"apply":{"force":true}},"syncOptions":{"items":["ApplyOutOfSyncOnly=true"]}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			var body []byte
			client := testArgoClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/api/v1/applications/payments/sync" {
					t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
				body, _ = io.ReadAll(r.Body)
				_, _ = w.Write([]byte(`{"status":{"sync":{"status":"OutOfSync"}}}`))
			})
			if _, err := client.SyncApplication(context.Background(), "payments", "argo-cd", test.options); err != nil {
				t.Fatal(err)
			}
			if string(body) != test.want {
				t.Fatalf("unexpected sync body:\n got %s\nwant %s", body, test.want)
			}
		})
	}
}

func TestHTTPArgoClientTerminateOperation(t *testing.T) {
	for _, test := range []struct {
		status int
		want   error
	}{
		{http.StatusOK, nil},
		{http.StatusBadRequest, ErrNoOperation},
		{http.StatusConflict, ErrNoOperation},
		{http.StatusPreconditionFailed, ErrNoOperation},
		{http.StatusNotFound, ErrApplicationNotFound},
		{http.StatusForbidden, ErrApplicationNotFound},
		{http.StatusBadGateway, argoAPIError{status: http.StatusBadGateway}},
	} {
		t.Run(http.StatusText(test.status), func(t *testing.T) {
			client := testArgoClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodDelete ||
					r.URL.RequestURI() != "/api/v1/applications/payments/operation?appNamespace=argo-cd" ||
					r.Header.Get("Content-Type") != "application/json" {
					t.Fatalf("unexpected request: %s %s %q", r.Method, r.URL.RequestURI(), r.Header.Get("Content-Type"))
				}
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(`{"message":"no operation is in progress; token=secret"}`))
			})
			err := client.TerminateOperation(context.Background(), "payments", "argo-cd")
			if !errors.Is(err, test.want) && !(err == nil && test.want == nil) {
				t.Fatalf("expected %v, got %v", test.want, err)
			}
			if err != nil && strings.Contains(err.Error(), "secret") {
				t.Fatalf("error exposes the response body: %v", err)
			}
		})
	}
}

func TestScrubMessage(t *testing.T) {
	for _, test := range []struct {
		name    string
		message string
		want    string
	}{
		{name: "no URL", message: "rpc error: deadline exceeded", want: "rpc error: deadline exceeded"},
		{name: "userinfo", message: "failed to fetch https://bot:ghp_secret@github.com/org/repo.git",
			want: "failed to fetch https://github.com/org/repo.git"},
		{name: "password containing @", message: "clone https://user:p@ss@host.example/repo failed",
			want: "clone https://host.example/repo failed"},
		{name: "token without a password", message: "pull oci://ghp_token@ghcr.io/org/chart",
			want: "pull oci://ghcr.io/org/chart"},
		{name: "every URL in the message",
			message: "tried http://a:b@one.example and https://c:d@two.example/x",
			want:    "tried http://one.example and https://two.example/x"},
		{name: "an email after the path is not userinfo",
			message: "https://github.com/org/repo: denied for dev@example.com",
			want:    "https://github.com/org/repo: denied for dev@example.com"},
		{name: "query credentials",
			message: `Get "https://host/chart.tgz?access_token=abc&ref=main&sig=xyz": 403`,
			want:    `Get "https://host/chart.tgz?access_token=<redacted>&ref=main&sig=<redacted>": 403`},
		{name: "signed URL",
			message: "https://bucket.s3.amazonaws.com/c.tgz?X-Amz-Credential=AKIA%2F&X-Amz-Signature=deadbeef",
			want:    "https://bucket.s3.amazonaws.com/c.tgz?X-Amz-Credential=<redacted>&X-Amz-Signature=<redacted>"},
		{name: "key, secret, and password parameters",
			message: "https://api.example/v1?key=k1&client_secret=s1&password=p1&page=2",
			want:    "https://api.example/v1?key=<redacted>&client_secret=<redacted>&password=<redacted>&page=2"},
		{name: "quoted URL ends at the quote",
			message: `fetch "https://host/x?token=abc" failed`,
			want:    `fetch "https://host/x?token=<redacted>" failed`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := ScrubMessage(test.message); got != test.want {
				t.Fatalf("got %q, want %q", got, test.want)
			}
		})
	}
}

// The application state's message is stored on the target and returned by the
// onboarding API, so it is scrubbed like the console's own messages.
func TestHTTPArgoClientScrubsApplicationStateMessage(t *testing.T) {
	for _, test := range []struct {
		name   string
		status string
		want   string
	}{
		{name: "operation message",
			status: `{"operationState":{"phase":"Failed","message":"fetch https://bot:ghp_x@github.com/o/r failed"}}`,
			want:   "fetch https://github.com/o/r failed"},
		{name: "health message",
			status: `{"health":{"status":"Degraded","message":"pull oci://ghcr.io/o/c?token=abc denied"}}`,
			want:   "pull oci://ghcr.io/o/c?token=<redacted> denied"},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := testArgoClient(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"status":` + test.status + `}`))
			})
			state, err := client.GetApplication(context.Background(), "payments", "argo-cd")
			if err != nil || state.Message != test.want {
				t.Fatalf("got %q, %v; want %q", state.Message, err, test.want)
			}
		})
	}
}

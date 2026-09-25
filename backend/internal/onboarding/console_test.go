package onboarding

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/jackc/pgx/v5"
)

func consoleService(client *fakeArgoClient, values *fakeValuesRepositoryManager) (*Service, *fakeRepository) {
	target := model.ApplicationDeployment{
		ID: "target-1", ClusterName: "prod", SourceID: "aws",
		ProviderResourceID: "arn:cluster/prod", ArgoApplication: "payments-dev-us-east-1",
		Status: "healthy", SyncStatus: "Synced", HealthStatus: "Healthy",
	}
	repository := &fakeRepository{record: model.ApplicationOnboarding{
		ID: "onboarding-1", Name: "payments", Namespace: "payments-dev-us-east-1",
		Environment: "dev", Region: "us-east-1", Status: model.OnboardingHealthy,
		ChartRepoURL: "repo", ChartName: "chart", ChartRevision: "1",
		ValuesRepositoryName: "payments", ValuesRevision: "main", ValuesCommitSHA: "old",
		Targets: []model.ApplicationDeployment{target},
	}}
	service := &Service{
		store: repository,
		config: config.OnboardingConfig{
			ArgoProject: "default", ArgoNamespace: "argo-cd", RequestTimeout: time.Second,
		},
		clients: map[string]ArgoClient{targetKey("aws", "arn:cluster/prod"): client},
	}
	if values != nil {
		service.github = values
	}
	return service, repository
}

// Replaces the Pod-only check: logs now cover workloads, and every parameter
// that reaches Argo CD is bounded here.
func TestLogsValidation(t *testing.T) {
	since := time.Now()
	pod := ResourceRef{Version: "v1", Kind: "Pod", Namespace: "payments", Name: "api-123"}
	for _, test := range []struct {
		name      string
		query     LogQuery
		wantError string
		wantKind  string
		wantTail  int64
	}{
		{name: "pod with defaults", query: LogQuery{Resource: pod}, wantKind: "Pod", wantTail: DefaultTailLines},
		{name: "kind casing is normalised",
			query:    LogQuery{Resource: ResourceRef{Kind: "deployment", Name: "api"}, TailLines: 10},
			wantKind: "Deployment", wantTail: 10},
		{name: "statefulset", query: LogQuery{Resource: ResourceRef{Kind: "StatefulSet", Name: "db"}},
			wantKind: "StatefulSet", wantTail: DefaultTailLines},
		{name: "job", query: LogQuery{Resource: ResourceRef{Kind: "Job", Name: "migrate"}, TailLines: MaxTailLines},
			wantKind: "Job", wantTail: MaxTailLines},
		{name: "service has no logs", query: LogQuery{Resource: ResourceRef{Kind: "Service", Name: "api"}},
			wantError: "logs are available for"},
		{name: "cronjob is not streamed", query: LogQuery{Resource: ResourceRef{Kind: "CronJob", Name: "api"}},
			wantError: "logs are available for"},
		{name: "bad name", query: LogQuery{Resource: ResourceRef{Kind: "Pod", Name: "../etc"}},
			wantError: "name must be"},
		{name: "bad namespace", query: LogQuery{Resource: ResourceRef{Kind: "Pod", Name: "a", Namespace: "A_B"}},
			wantError: "namespace must be"},
		{name: "bad container", query: LogQuery{Resource: pod, Container: "App Server"},
			wantError: "container must be"},
		{name: "too many lines", query: LogQuery{Resource: pod, TailLines: MaxTailLines + 1},
			wantError: "tailLines must be between"},
		{name: "negative lines", query: LogQuery{Resource: pod, TailLines: -1},
			wantError: "tailLines must be between"},
		{name: "since too far back", query: LogQuery{Resource: pod, SinceSeconds: MaxSinceSeconds + 1},
			wantError: "sinceSeconds must be between"},
		{name: "two since bounds", query: LogQuery{Resource: pod, SinceSeconds: 60, SinceTime: &since},
			wantError: "not both"},
		{name: "long filter", query: LogQuery{Resource: pod, Filter: strings.Repeat("x", MaxLogFilterLength+1)},
			wantError: "filter must not exceed"},
		{name: "multi-line filter", query: LogQuery{Resource: pod, Filter: "a\nb"},
			wantError: "single line"},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &fakeArgoClient{logStream: "{}\n"}
			service, _ := consoleService(client, nil)
			stream, err := service.Logs(context.Background(), "onboarding-1", "target-1", test.query)
			if test.wantError != "" {
				var validationError ValidationError
				if !errors.As(err, &validationError) || !strings.Contains(validationError.Message, test.wantError) {
					t.Fatalf("expected validation error %q, got %v", test.wantError, err)
				}
				if client.logQuery.Resource.Kind != "" {
					t.Fatal("an invalid query reached Argo CD")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			stream.Close()
			if client.logQuery.Resource.Kind != test.wantKind || client.logQuery.TailLines != test.wantTail {
				t.Fatalf("unexpected forwarded query: %#v", client.logQuery)
			}
		})
	}
}

func TestLogsRejectsUnknownTarget(t *testing.T) {
	service, _ := consoleService(&fakeArgoClient{}, nil)
	_, err := service.Logs(context.Background(), "onboarding-1", "other-target", LogQuery{
		Resource: ResourceRef{Kind: "Pod", Name: "api"},
	})
	if !errors.Is(err, ErrTargetNotFound) {
		t.Fatalf("expected ErrTargetNotFound, got %v", err)
	}
}

func TestTargetEventsValidation(t *testing.T) {
	for _, test := range []struct {
		query EventQuery
		valid bool
	}{
		{EventQuery{}, true},
		{EventQuery{Kind: "Pod", Name: "api-1.x", Namespace: "payments", UID: "0f1e-22"}, true},
		{EventQuery{Kind: "Pod/../x"}, false},
		{EventQuery{Name: "API"}, false},
		{EventQuery{Namespace: "a.b"}, false},
		{EventQuery{UID: "not a uid"}, false},
	} {
		client := &fakeArgoClient{events: []ArgoEvent{{Reason: "Pulled"}}}
		service, _ := consoleService(client, nil)
		events, err := service.TargetEvents(context.Background(), "onboarding-1", "target-1", test.query)
		if test.valid != (err == nil) {
			t.Fatalf("query %#v: valid=%t, got %v", test.query, test.valid, err)
		}
		if test.valid && (len(events) != 1 || client.eventQuery != test.query) {
			t.Fatalf("query %#v was not forwarded: %#v", test.query, client.eventQuery)
		}
	}
}

func TestContainersFromManifest(t *testing.T) {
	for _, test := range []struct {
		name     string
		manifest string
		want     []Container
	}{
		{
			name: "pod",
			manifest: "kind: Pod\nspec:\n  initContainers:\n  - name: migrate\n    image: tools:1\n" +
				"  containers:\n  - name: app\n    image: app:2\n  - name: istio-proxy\n    image: proxy:1\n",
			want: []Container{
				{Name: "migrate", Image: "tools:1", Init: true},
				{Name: "app", Image: "app:2"}, {Name: "istio-proxy", Image: "proxy:1"},
			},
		},
		{
			name:     "deployment template",
			manifest: "kind: Deployment\nspec:\n  replicas: 2\n  template:\n    spec:\n      containers:\n      - name: web\n        image: nginx\n",
			want:     []Container{{Name: "web", Image: "nginx"}},
		},
		{
			name: "cronjob template",
			manifest: "kind: CronJob\nspec:\n  jobTemplate:\n    spec:\n      template:\n        spec:\n" +
				"          containers:\n          - name: report\n            image: report:1\n",
			want: []Container{{Name: "report", Image: "report:1"}},
		},
		{name: "service has none", manifest: "kind: Service\nspec:\n  ports: []\n", want: []Container{}},
		{name: "invalid yaml", manifest: "{", want: []Container{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := containersFromManifest(test.manifest); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("got %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestRevisions(t *testing.T) {
	history := []ValuesCommit{{SHA: "abc1234", Current: true}, {SHA: "def5678"}}
	for _, test := range []struct {
		name      string
		values    *fakeValuesRepositoryManager
		mutate    func(*model.ApplicationOnboarding)
		limit     int
		wantError string
		external  bool
	}{
		{name: "history of the release file", values: &fakeValuesRepositoryManager{history: history}, limit: 20},
		{name: "limit bounds", values: &fakeValuesRepositoryManager{}, limit: MaxRevisionPage + 1,
			wantError: "limit must be between"},
		{name: "unconfigured repository", limit: 20, wantError: "not configured"},
		{name: "no release context", values: &fakeValuesRepositoryManager{}, limit: 20,
			mutate:    func(record *model.ApplicationOnboarding) { record.Region = "" },
			wantError: "no release-scoped values file"},
		{name: "GitHub failure", values: &fakeValuesRepositoryManager{historyErr: errors.New("status 500")},
			limit: 20, external: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			service, repository := consoleService(&fakeArgoClient{}, test.values)
			if test.mutate != nil {
				test.mutate(&repository.record)
			}
			result, err := service.Revisions(context.Background(), "onboarding-1", test.limit)
			var validationError ValidationError
			var externalError ExternalError
			switch {
			case test.wantError != "":
				if !errors.As(err, &validationError) || !strings.Contains(validationError.Message, test.wantError) {
					t.Fatalf("expected %q, got %v", test.wantError, err)
				}
			case test.external:
				if !errors.As(err, &externalError) {
					t.Fatalf("expected an external error, got %v", err)
				}
			default:
				if err != nil {
					t.Fatal(err)
				}
				if result.Path != "dev/us-east-1/values.yaml" || result.Branch != "main" ||
					!reflect.DeepEqual(result.Items, history) || test.values.historyPath != result.Path ||
					test.values.historyLimit != test.limit {
					t.Fatalf("unexpected history: %#v (manager %#v)", result, test.values)
				}
			}
		})
	}
}

func TestRevisionValues(t *testing.T) {
	values := &fakeValuesRepositoryManager{valuesAt: map[string]string{"abc1234": "replicaCount: 3\n"}}
	service, _ := consoleService(&fakeArgoClient{}, values)
	result, err := service.RevisionValues(context.Background(), "onboarding-1", "abc1234")
	if err != nil || result.ValuesYAML != "replicaCount: 3\n" || result.Path != "dev/us-east-1/values.yaml" {
		t.Fatalf("unexpected values: %#v, %v", result, err)
	}
	for _, sha := range []string{"abc", "ABC1234", "abc1234;", strings.Repeat("a", 41)} {
		if _, err := service.RevisionValues(context.Background(), "onboarding-1", sha); err == nil {
			t.Fatalf("expected %q to be rejected", sha)
		}
	}
	values.valuesAtErr = ErrRevisionNotFound
	if _, err := service.RevisionValues(context.Background(), "onboarding-1", "abc1234"); !errors.Is(err, ErrRevisionNotFound) {
		t.Fatalf("expected ErrRevisionNotFound, got %v", err)
	}
}

func TestConsoleReadsReportMissingOnboarding(t *testing.T) {
	service, _ := consoleService(&fakeArgoClient{}, &fakeValuesRepositoryManager{})
	service.store = &missingRepository{fakeRepository: &fakeRepository{}}
	if _, err := service.TargetStatus(context.Background(), "missing", "target-1"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("expected pgx.ErrNoRows, got %v", err)
	}
	if _, err := service.Revisions(context.Background(), "missing", 20); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("expected pgx.ErrNoRows, got %v", err)
	}
}

type missingRepository struct{ *fakeRepository }

func (missingRepository) GetApplicationOnboarding(context.Context, string) (model.ApplicationOnboarding, error) {
	return model.ApplicationOnboarding{}, pgx.ErrNoRows
}

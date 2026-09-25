package onboarding

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
)

func testGitHubClient(t *testing.T, handler http.HandlerFunc) *GitHubClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewGitHubClient(config.OnboardingConfig{
		GitHubAPIURL: server.URL, GitHubOrg: "GitOpsHub", GitHubToken: "pat",
		GitHubVisibility: "private", RequestTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func contents(sha, content string) map[string]string {
	return map[string]string{
		"sha": sha, "encoding": "base64",
		"content": base64.StdEncoding.EncodeToString([]byte(content)),
	}
}

func TestGitHubClientValuesHistory(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
		want   int
		err    bool
	}{
		{name: "commits", status: http.StatusOK, want: 2, body: `[
			{"sha": "aaa1111", "html_url": "https://github.com/GitOpsHub/payments/commit/aaa1111",
			 "commit": {"message": "Scale dev/us-east-1 to 3 replicas\n\nbody", "author": {"name": "Bot"},
			            "committer": {"date": "2026-09-24T12:00:00Z"}}},
			{"sha": "bbb2222", "author": {"login": "octocat"},
			 "commit": {"message": "Add values", "author": {"date": "2026-09-20T12:00:00Z"}}}
		]`},
		{name: "missing repository is empty history", status: http.StatusNotFound, want: 0},
		{name: "empty repository is empty history", status: http.StatusConflict, want: 0},
		{name: "server error", status: http.StatusInternalServerError, err: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requested string
			client := testGitHubClient(t, func(w http.ResponseWriter, r *http.Request) {
				requested = r.URL.RequestURI()
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			})
			history, err := client.ValuesHistory(context.Background(), "payments", "main", "dev/us-east-1/values.yaml", 20)
			if requested != "/repos/GitOpsHub/payments/commits?path=dev%2Fus-east-1%2Fvalues.yaml&per_page=20&sha=main" {
				t.Fatalf("unexpected request: %s", requested)
			}
			if test.err {
				if err == nil {
					t.Fatal("expected an error")
				}
				return
			}
			if err != nil || len(history) != test.want {
				t.Fatalf("unexpected history: %#v, %v", history, err)
			}
			if test.want == 0 {
				return
			}
			first, second := history[0], history[1]
			if !first.Current || second.Current || first.Message != "Scale dev/us-east-1 to 3 replicas" ||
				first.Author != "Bot" || first.CommittedAt == nil || first.CommittedAt.Day() != 24 ||
				first.URL == "" {
				t.Fatalf("unexpected first commit: %#v", first)
			}
			if second.Author != "octocat" || second.CommittedAt == nil || second.CommittedAt.Day() != 20 {
				t.Fatalf("fallbacks were not applied: %#v", second)
			}
		})
	}
}

func TestGitHubClientValuesAt(t *testing.T) {
	client := testGitHubClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/GitOpsHub/payments/contents/dev/us-east-1/values.yaml" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("ref") == "missing1" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(contents("blob", "replicaCount: 2\n"))
	})
	values, err := client.ValuesAt(context.Background(), "payments", "dev/us-east-1/values.yaml", "abc1234")
	if err != nil || values != "replicaCount: 2\n" {
		t.Fatalf("unexpected values: %q, %v", values, err)
	}
	if _, err := client.ValuesAt(context.Background(), "payments", "dev/us-east-1/values.yaml", "missing1"); !errors.Is(err, ErrRevisionNotFound) {
		t.Fatalf("expected ErrRevisionNotFound, got %v", err)
	}
}

func TestGitHubClientRestoreValues(t *testing.T) {
	for _, test := range []struct {
		name      string
		old       string
		current   string
		putStatus int
		wantErr   error
		wantPut   bool
		otherErr  bool
	}{
		{name: "restores older content", old: "replicaCount: 2\n", current: "replicaCount: 5\n",
			putStatus: http.StatusOK, wantPut: true},
		{name: "unchanged", old: "replicaCount: 2\n", current: "replicaCount: 2\n", wantErr: ErrValuesUnchanged},
		{name: "file absent at revision", current: "replicaCount: 5\n", wantErr: ErrRevisionNotFound},
		{name: "concurrent edit refused", old: "a: 1\n", current: "a: 2\n",
			putStatus: http.StatusConflict, wantPut: true, wantErr: ErrValuesConflict},
		{name: "commit failure", old: "a: 1\n", current: "a: 2\n",
			putStatus: http.StatusInternalServerError, wantPut: true, otherErr: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var put struct {
				Message string `json:"message"`
				Content string `json:"content"`
				Branch  string `json:"branch"`
				SHA     string `json:"sha"`
			}
			var putCalled bool
			client := testGitHubClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/repos/GitOpsHub/payments/contents/dev/us-east-1/values.yaml" {
					t.Fatalf("unexpected path: %s", r.URL.Path)
				}
				switch {
				case r.Method == http.MethodPut:
					putCalled = true
					_ = json.NewDecoder(r.Body).Decode(&put)
					w.WriteHeader(test.putStatus)
					_, _ = w.Write([]byte(`{"commit":{"sha":"new9999"}}`))
				case r.URL.Query().Get("ref") == "main":
					_ = json.NewEncoder(w).Encode(contents("current-blob", test.current))
				case test.old == "":
					w.WriteHeader(http.StatusNotFound)
				default:
					_ = json.NewEncoder(w).Encode(contents("old-blob", test.old))
				}
			})
			update, err := client.RestoreValues(context.Background(), "payments", "main",
				"dev/us-east-1/values.yaml", "abc1234def")
			if putCalled != test.wantPut {
				t.Fatalf("expected put=%t, got %t", test.wantPut, putCalled)
			}
			switch {
			case test.wantErr != nil:
				if !errors.Is(err, test.wantErr) {
					t.Fatalf("expected %v, got %v", test.wantErr, err)
				}
				return
			case test.otherErr:
				if err == nil || errors.Is(err, ErrValuesUnchanged) || errors.Is(err, ErrValuesConflict) {
					t.Fatalf("expected a GitHub error, got %v", err)
				}
				return
			case err != nil:
				t.Fatal(err)
			}
			decoded, _ := base64.StdEncoding.DecodeString(put.Content)
			if string(decoded) != test.old || put.SHA != "current-blob" || put.Branch != "main" ||
				put.Message != "Roll back dev/us-east-1 values to abc1234" {
				t.Fatalf("unexpected commit: %#v (%q)", put, decoded)
			}
			if update.CommitSHA != "new9999" || update.ValuesYAML != test.old {
				t.Fatalf("unexpected update: %#v", update)
			}
		})
	}
}

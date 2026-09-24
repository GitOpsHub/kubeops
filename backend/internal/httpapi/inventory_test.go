package httpapi

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

func TestClusterSorting(t *testing.T) {
	for _, test := range []struct {
		query          string
		wantStatus     int
		wantSort       string
		wantDescending bool
	}{
		{query: "", wantStatus: http.StatusOK},
		{query: "?sort=nodes", wantStatus: http.StatusOK, wantSort: model.ClusterSortNodes},
		{query: "?sort=lastSeen&order=desc", wantStatus: http.StatusOK,
			wantSort: model.ClusterSortLastSeen, wantDescending: true},
		{query: "?sort=version&order=asc", wantStatus: http.StatusOK, wantSort: model.ClusterSortVersion},
		{query: "?order=desc", wantStatus: http.StatusOK,
			wantSort: model.ClusterSortName, wantDescending: true},
		// The key selects an ORDER BY expression, so anything off the list is
		// refused rather than passed toward SQL.
		{query: "?sort=name%20DESC", wantStatus: http.StatusBadRequest},
		{query: "?sort=metadata", wantStatus: http.StatusBadRequest},
		{query: "?sort=name&order=sideways", wantStatus: http.StatusBadRequest},
	} {
		t.Run(test.query, func(t *testing.T) {
			repository := &fakeRepository{}
			handler := NewHandler(config.Config{}, repository)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/clusters"+test.query, nil))

			if response.Code != test.wantStatus {
				t.Fatalf("expected %d, got %d: %s", test.wantStatus, response.Code, response.Body.String())
			}
			if test.wantStatus != http.StatusOK {
				return
			}
			if repository.filter.Sort != test.wantSort || repository.filter.Descending != test.wantDescending {
				t.Fatalf("unexpected sort: %#v", repository.filter)
			}
		})
	}
}

func TestSyncRunsSourceFilter(t *testing.T) {
	sources := []model.CloudSource{{ID: "aws-prod"}, {ID: "gcp-dev"}}
	for _, test := range []struct {
		name       string
		query      string
		wantStatus int
		wantLimit  int
		wantScope  []string
	}{
		{name: "every configured source", query: "", wantStatus: http.StatusOK,
			wantLimit: 50, wantScope: []string{"aws-prod", "gcp-dev"}},
		{name: "one source", query: "?sourceId=gcp-dev&limit=200", wantStatus: http.StatusOK,
			wantLimit: 200, wantScope: []string{"gcp-dev"}},
		// An unconfigured source must not widen the scope back to its history.
		{name: "unconfigured source", query: "?sourceId=azure-old", wantStatus: http.StatusOK,
			wantLimit: 50, wantScope: []string{}},
		{name: "limit too large", query: "?limit=201", wantStatus: http.StatusBadRequest},
		{name: "limit too small", query: "?limit=0", wantStatus: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &fakeRepository{}
			handler := NewHandler(config.Config{CloudSources: sources}, repository)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/sync-runs"+test.query, nil))

			if response.Code != test.wantStatus {
				t.Fatalf("expected %d, got %d: %s", test.wantStatus, response.Code, response.Body.String())
			}
			if test.wantStatus != http.StatusOK {
				return
			}
			if repository.runLimit != test.wantLimit || !reflect.DeepEqual(repository.runSources, test.wantScope) {
				t.Fatalf("unexpected query: limit=%d scope=%#v", repository.runLimit, repository.runSources)
			}
		})
	}
}

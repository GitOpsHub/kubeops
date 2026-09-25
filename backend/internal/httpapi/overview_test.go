package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

func TestOverview(t *testing.T) {
	stats := model.OverviewStats{
		Clusters: model.OverviewClusters{Total: 3, ByProvider: map[string]int{"aws": 3}},
		Attention: []model.AttentionItem{{
			Kind: model.AttentionApplication, ID: "app-1", Name: "payments",
			Status: "failed", Href: "/applications/app-1",
		}},
	}
	for _, test := range []struct {
		name          string
		sources       []model.CloudSource
		background    bool
		err           error
		wantStatus    int
		wantScope     []string
		wantReconcile int
	}{
		{
			name:       "scoped to configured sources and reconciled",
			sources:    []model.CloudSource{{ID: "aws-prod"}, {ID: "gcp-dev"}},
			wantStatus: http.StatusOK, wantScope: []string{"aws-prod", "gcp-dev"},
			wantReconcile: 1,
		},
		{
			// An empty, non-nil scope matches nothing; nil would disable scoping
			// and expose rows from sources this deployment no longer configures.
			name: "no configured sources matches nothing", wantStatus: http.StatusOK,
			wantScope: []string{}, wantReconcile: 1,
		},
		{
			name: "background workers own reconciliation", background: true,
			sources:    []model.CloudSource{{ID: "aws-prod"}},
			wantStatus: http.StatusOK, wantScope: []string{"aws-prod"},
		},
		{
			name: "store failure", err: errors.New("connection reset"),
			wantStatus: http.StatusInternalServerError, wantScope: []string{},
			wantReconcile: 1,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &fakeRepository{overview: stats, overviewErr: test.err}
			onboarder := &fakeApplicationOnboarder{}
			handler := NewHandlerWithOnboarding(config.Config{
				CloudSources: test.sources, BackgroundWorkers: test.background,
			}, repository, &fakeClusterManager{}, onboarder)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/overview", nil))

			if response.Code != test.wantStatus {
				t.Fatalf("expected %d, got %d: %s", test.wantStatus, response.Code, response.Body.String())
			}
			if !reflect.DeepEqual(repository.overviewSources, test.wantScope) {
				t.Fatalf("unexpected scope: %#v", repository.overviewSources)
			}
			if onboarder.reconcileCalls != test.wantReconcile {
				t.Fatalf("expected %d reconcile calls, got %d", test.wantReconcile, onboarder.reconcileCalls)
			}
			if test.wantStatus != http.StatusOK {
				return
			}
			var body model.OverviewStats
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Clusters.Total != 3 || len(body.Attention) != 1 ||
				body.Attention[0].Href != "/applications/app-1" {
				t.Fatalf("unexpected overview: %#v", body)
			}
		})
	}
}

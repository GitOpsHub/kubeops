package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/provider"
	"github.com/GitOpsHub/kubeops/backend/internal/store"
	"github.com/jackc/pgx/v5"
)

type Repository interface {
	Ready(context.Context) error
	ListSources(context.Context) ([]model.SourceSummary, error)
	ListClusters(context.Context, model.ClusterFilter) (model.ClusterPage, error)
	GetCluster(context.Context, string) (model.Cluster, error)
	ListSyncRuns(context.Context, int) ([]model.SyncRun, error)
	QueueSync(context.Context, string, string) (model.SyncRun, error)
}

type ClusterManager interface {
	Details(context.Context, model.CloudSource, model.Cluster) (model.ClusterDetails, error)
	ScaleNodePool(context.Context, model.CloudSource, model.Cluster, string, int32) (model.ScaleResult, error)
}

type API struct {
	config  config.Config
	store   Repository
	manager ClusterManager
}

func NewHandler(cfg config.Config, repository Repository, managers ...ClusterManager) http.Handler {
	var manager ClusterManager = provider.ManagementRegistry{}
	if len(managers) > 0 && managers[0] != nil {
		manager = managers[0]
	}
	api := &API{config: cfg, store: repository, manager: manager}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", api.health)
	mux.HandleFunc("GET /api/ready", api.ready)
	mux.HandleFunc("GET /api/clusters", api.clusters)
	mux.HandleFunc("GET /api/clusters/{id}/details", api.clusterDetails)
	mux.HandleFunc("POST /api/clusters/{id}/node-pools/{pool}/scale", api.scaleNodePool)
	mux.HandleFunc("GET /api/cloud-sources", api.sources)
	mux.HandleFunc("GET /api/sync-runs", api.syncRuns)
	mux.HandleFunc("POST /api/cloud-sources/{id}/sync", api.queueSync)
	return withCORS(withRequestLog(mux), cfg.CORSAllowedOrigin)
}

func (api *API) source(id string) (model.CloudSource, bool) {
	for _, source := range api.config.CloudSources {
		if source.ID == id {
			return source, true
		}
	}
	return model.CloudSource{}, false
}

func (api *API) operationalCluster(w http.ResponseWriter, r *http.Request) (model.CloudSource, model.Cluster, bool) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "cluster id is required")
		return model.CloudSource{}, model.Cluster{}, false
	}
	cluster, err := api.store.GetCluster(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "cluster not found")
		return model.CloudSource{}, model.Cluster{}, false
	}
	if err != nil {
		slog.Error("get cluster", "cluster", id, "error", err)
		writeError(w, http.StatusInternalServerError, "unable to load cluster")
		return model.CloudSource{}, model.Cluster{}, false
	}
	source, ok := api.source(cluster.SourceID)
	if !ok {
		writeError(w, http.StatusNotFound, "configured cloud source not found")
		return model.CloudSource{}, model.Cluster{}, false
	}
	return source, cluster, true
}

func (api *API) clusterDetails(w http.ResponseWriter, r *http.Request) {
	source, cluster, ok := api.operationalCluster(w, r)
	if !ok {
		return
	}
	details, err := api.manager.Details(r.Context(), source, cluster)
	if err != nil {
		slog.Error("load live cluster details", "cluster", cluster.ID, "provider", cluster.Provider, "error", err)
		writeError(w, http.StatusBadGateway, "unable to load live cluster details")
		return
	}
	writeJSON(w, http.StatusOK, details)
}

func (api *API) scaleNodePool(w http.ResponseWriter, r *http.Request) {
	source, cluster, ok := api.operationalCluster(w, r)
	if !ok {
		return
	}
	if cluster.RemovedAt != nil {
		writeError(w, http.StatusUnprocessableEntity, "removed clusters cannot be scaled")
		return
	}
	poolID := strings.TrimSpace(r.PathValue("pool"))
	if poolID == "" {
		writeError(w, http.StatusBadRequest, "node pool id is required")
		return
	}
	var request struct {
		DesiredCount *int32 `json:"desiredCount"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || request.DesiredCount == nil || *request.DesiredCount < 0 {
		writeError(w, http.StatusBadRequest, "desiredCount must be a nonnegative integer")
		return
	}
	result, err := api.manager.ScaleNodePool(r.Context(), source, cluster, poolID, *request.DesiredCount)
	switch {
	case errors.Is(err, provider.ErrNodePoolNotFound):
		writeError(w, http.StatusNotFound, "node pool not found")
		return
	case errors.Is(err, provider.ErrOperationInProgress):
		writeError(w, http.StatusConflict, "a provider operation is already in progress for this node pool")
		return
	case errors.Is(err, provider.ErrOperationUnsupported):
		writeError(w, http.StatusUnprocessableEntity, "this node pool does not support manual scaling")
		return
	case errors.Is(err, provider.ErrScaleOutOfBounds):
		writeError(w, http.StatusUnprocessableEntity, "desiredCount is outside the node pool bounds")
		return
	case err != nil:
		slog.Error("scale node pool", "cluster", cluster.ID, "pool", poolID, "error", err)
		writeError(w, http.StatusBadGateway, "the cloud provider rejected the scaling request")
		return
	}
	status := http.StatusAccepted
	if result.Status == "unchanged" {
		status = http.StatusOK
	}
	writeJSON(w, status, result)
}

func (api *API) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"service": "kubeops-api", "status": "ok", "environment": api.config.Environment,
	})
}

func (api *API) ready(w http.ResponseWriter, r *http.Request) {
	if err := api.store.Ready(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database is not ready")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (api *API) clusters(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	filter := model.ClusterFilter{
		Provider:       strings.ToLower(query.Get("provider")),
		SourceID:       query.Get("source"),
		Status:         strings.ToLower(query.Get("status")),
		Search:         strings.TrimSpace(query.Get("search")),
		IncludeRemoved: query.Get("includeRemoved") == "true",
		Page:           intQuery(query.Get("page"), 1),
		PageSize:       intQuery(query.Get("pageSize"), 25),
	}
	if filter.Provider != "" &&
		filter.Provider != model.ProviderAWS &&
		filter.Provider != model.ProviderGCP &&
		filter.Provider != model.ProviderAzure &&
		filter.Provider != model.ProviderDocker &&
		filter.Provider != model.ProviderMinikube {
		writeError(w, http.StatusBadRequest, "provider must be aws, gcp, azure, docker, or minikube")
		return
	}
	if filter.Page < 1 || filter.PageSize < 1 || filter.PageSize > 200 {
		writeError(w, http.StatusBadRequest, "page must be positive and pageSize must be between 1 and 200")
		return
	}

	page, err := api.store.ListClusters(r.Context(), filter)
	if err != nil {
		slog.Error("list clusters", "error", err)
		writeError(w, http.StatusInternalServerError, "unable to list clusters")
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (api *API) sources(w http.ResponseWriter, r *http.Request) {
	sources, err := api.store.ListSources(r.Context())
	if err != nil {
		slog.Error("list cloud sources", "error", err)
		writeError(w, http.StatusInternalServerError, "unable to list cloud sources")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": sources})
}

func (api *API) syncRuns(w http.ResponseWriter, r *http.Request) {
	limit := intQuery(r.URL.Query().Get("limit"), 50)
	if limit < 1 || limit > 200 {
		writeError(w, http.StatusBadRequest, "limit must be between 1 and 200")
		return
	}
	runs, err := api.store.ListSyncRuns(r.Context(), limit)
	if err != nil {
		slog.Error("list sync runs", "error", err)
		writeError(w, http.StatusInternalServerError, "unable to list sync runs")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": runs})
}

func (api *API) queueSync(w http.ResponseWriter, r *http.Request) {
	sourceID := strings.TrimSpace(r.PathValue("id"))
	if sourceID == "" {
		writeError(w, http.StatusBadRequest, "cloud source id is required")
		return
	}
	run, err := api.store.QueueSync(r.Context(), sourceID, "manual")
	if errors.Is(err, store.ErrSyncAlreadyActive) {
		writeError(w, http.StatusConflict, "a sync is already active for this cloud source")
		return
	}
	if err != nil {
		slog.Error("queue manual sync", "source", sourceID, "error", err)
		writeError(w, http.StatusNotFound, "enabled cloud source not found")
		return
	}
	writeJSON(w, http.StatusAccepted, run)
}

func withCORS(next http.Handler, allowedOrigin string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") == allowedOrigin {
			w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func withRequestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		slog.Debug("API request", "method", r.Method, "path", r.URL.Path)
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func intQuery(value string, fallback int) int {
	if value == "" {
		return fallback
	}
	number, err := strconv.Atoi(value)
	if err != nil {
		return -1
	}
	return number
}

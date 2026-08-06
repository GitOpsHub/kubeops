package httpapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/GitOpsHub/kubeops/backend/internal/cloudauth"
	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/onboarding"
	"github.com/GitOpsHub/kubeops/backend/internal/provider"
	"github.com/GitOpsHub/kubeops/backend/internal/store"
	"github.com/GitOpsHub/kubeops/backend/internal/syncer"
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

type ApplicationOnboarder interface {
	Create(context.Context, onboarding.CreateInput) (model.ApplicationOnboarding, error)
	Get(context.Context, string) (model.ApplicationOnboarding, error)
	Sync(context.Context, string) (model.ApplicationOnboarding, error)
	Scale(context.Context, string, int32) (model.ApplicationOnboarding, error)
	Offboard(context.Context, string) (model.ApplicationOnboarding, error)
	List(
		context.Context,
		model.ApplicationOnboardingFilter,
	) (model.ApplicationOnboardingPage, error)
	Defaults() onboarding.Defaults
	Resources(context.Context, string, string) ([]onboarding.ResourceNode, error)
	ResourceManifests(
		context.Context,
		string,
		string,
		onboarding.ResourceRef,
	) (onboarding.ResourceManifestComparison, error)
	DeleteResource(context.Context, string, string, onboarding.ResourceRef) error
	PodLogs(context.Context, string, string, onboarding.ResourceRef) (io.ReadCloser, error)
}

type SourceSyncer interface {
	Sync(context.Context, string, string) (model.SyncRun, error)
}

type ApplicationReconciler interface {
	Reconcile(context.Context)
}

type API struct {
	config    config.Config
	store     Repository
	manager   ClusterManager
	onboarder ApplicationOnboarder
	syncer    SourceSyncer
}

func NewHandler(cfg config.Config, repository Repository, managers ...ClusterManager) http.Handler {
	var manager ClusterManager = provider.ManagementRegistry{}
	if len(managers) > 0 && managers[0] != nil {
		manager = managers[0]
	}
	return newHandler(cfg, repository, manager, nil, nil)
}

func NewHandlerWithOnboarding(
	cfg config.Config,
	repository Repository,
	manager ClusterManager,
	onboarder ApplicationOnboarder,
	sourceSyncers ...SourceSyncer,
) http.Handler {
	if manager == nil {
		manager = provider.ManagementRegistry{}
	}
	var sourceSyncer SourceSyncer
	if len(sourceSyncers) > 0 {
		sourceSyncer = sourceSyncers[0]
	}
	return newHandler(cfg, repository, manager, onboarder, sourceSyncer)
}

func newHandler(
	cfg config.Config,
	repository Repository,
	manager ClusterManager,
	onboarder ApplicationOnboarder,
	sourceSyncer SourceSyncer,
) http.Handler {
	api := &API{
		config: cfg, store: repository, manager: manager,
		onboarder: onboarder, syncer: sourceSyncer,
	}
	mux := http.NewServeMux()
	// {$} matches only the bare root so unknown paths still fall through to 404.
	mux.HandleFunc("GET /{$}", api.health)
	mux.HandleFunc("GET /api/health", api.health)
	mux.HandleFunc("GET /api/ready", api.ready)
	mux.HandleFunc("GET /api/clusters", api.clusters)
	mux.HandleFunc("GET /api/clusters/{id}/details", api.clusterDetails)
	mux.HandleFunc("GET /api/clusters/{id}/argo-access", api.clusterArgoAccess)
	mux.HandleFunc("POST /api/clusters/{id}/node-pools/{pool}/scale", api.scaleNodePool)
	mux.HandleFunc("GET /api/cloud-sources", api.sources)
	mux.HandleFunc("GET /api/sync-runs", api.syncRuns)
	mux.HandleFunc("POST /api/cloud-sources/{id}/sync", api.queueSync)
	mux.HandleFunc("POST /api/application-onboardings", api.createApplicationOnboarding)
	mux.HandleFunc("GET /api/application-onboardings", api.applicationOnboardings)
	mux.HandleFunc("GET /api/application-onboardings/defaults", api.applicationOnboardingDefaults)
	mux.HandleFunc("GET /api/application-onboardings/{id}", api.applicationOnboarding)
	mux.HandleFunc("POST /api/application-onboardings/{id}/sync", api.syncApplicationOnboarding)
	mux.HandleFunc("POST /api/application-onboardings/{id}/scale", api.scaleApplicationOnboarding)
	mux.HandleFunc("POST /api/application-onboardings/{id}/offboard", api.offboardApplicationOnboarding)
	mux.HandleFunc(
		"GET /api/application-onboardings/{id}/targets/{targetId}/resources",
		api.applicationResources,
	)
	mux.HandleFunc(
		"GET /api/application-onboardings/{id}/targets/{targetId}/resources/manifest",
		api.applicationResourceManifest,
	)
	mux.HandleFunc(
		"GET /api/application-onboardings/{id}/targets/{targetId}/resources/logs",
		api.applicationPodLogs,
	)
	mux.HandleFunc(
		"DELETE /api/application-onboardings/{id}/targets/{targetId}/resources",
		api.deleteApplicationResource,
	)
	// Serves the Argo CD UI on this origin so the browser needs neither Argo CD
	// credentials nor trust in the Argo CD server's certificate.
	if proxy, err := newArgoProxy(cfg.Onboarding.ArgoTargets); err != nil {
		// A misconfigured target must not take down the rest of the API; the deep
		// links simply stay unavailable.
		slog.Error("configure Argo CD proxy", "error", err)
	} else {
		mux.Handle(argoProxyPrefix, proxy)
	}
	return withCORS(withRequestLog(withIdentityToken(mux)), cfg.CORSAllowedOrigin)
}

// withIdentityToken carries the platform's OIDC identity token from the request
// into the context, where the cloud credential builders read it. A deployed
// serverless function receives the token this way on every invocation and never
// in its environment, so without this the backend would silently fall back to
// the provider SDK default chains in production.
//
// The header is injected by the platform, not by the browser: the CORS policy
// above never allows it through, so a caller cannot supply its own.
func withIdentityToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get(cloudauth.VercelOIDCTokenHeader)
		if token == "" {
			next.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r.WithContext(cloudauth.WithToken(r.Context(), token)))
	})
}

// aborted reports whether the client gave up on the request. The UI cancels
// in-flight reads whenever a route unmounts or a filter changes, so the resulting
// failures are routine rather than server faults and must not be logged as errors.
func aborted(r *http.Request) bool {
	return r.Context().Err() != nil
}

func (api *API) source(id string) (model.CloudSource, bool) {
	for _, source := range api.config.CloudSources {
		if source.ID == id {
			return source, true
		}
	}
	return model.CloudSource{}, false
}

func (api *API) configuredSourceIDs() []string {
	ids := make([]string, 0, len(api.config.CloudSources))
	for _, source := range api.config.CloudSources {
		ids = append(ids, source.ID)
	}
	return ids
}

func (api *API) reconcileApplications(ctx context.Context) {
	if api.config.BackgroundWorkers || api.onboarder == nil {
		return
	}
	if reconciler, ok := api.onboarder.(ApplicationReconciler); ok {
		reconciler.Reconcile(ctx)
	}
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
		if aborted(r) {
			return model.CloudSource{}, model.Cluster{}, false
		}
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
		if aborted(r) {
			return
		}
		slog.Error("load live cluster details", "cluster", cluster.ID, "provider", cluster.Provider, "error", err)
		writeError(w, http.StatusBadGateway, "unable to load live cluster details")
		return
	}
	writeJSON(w, http.StatusOK, details)
}

func (api *API) clusterArgoAccess(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "cluster id is required")
		return
	}
	cluster, err := api.store.GetCluster(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "cluster not found")
		return
	}
	if err != nil {
		if aborted(r) {
			return
		}
		slog.Error("get cluster for Argo CD access", "cluster", id, "error", err)
		writeError(w, http.StatusInternalServerError, "unable to load Argo CD access")
		return
	}
	for _, target := range api.config.Onboarding.ArgoTargets {
		if target.SourceID != cluster.SourceID ||
			target.ProviderResourceID != cluster.ProviderResourceID {
			continue
		}
		writeJSON(w, http.StatusOK, model.ArgoAccess{
			URL: api.config.Onboarding.PublicBaseURL + argoProxyPrefix +
				target.ProxyID() + "/applications",
		})
		return
	}
	writeError(w, http.StatusNotFound, "Argo CD access is not configured for this cluster")
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
		SourceIDs:      api.configuredSourceIDs(),
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
		if aborted(r) {
			return
		}
		slog.Error("list clusters", "error", err)
		writeError(w, http.StatusInternalServerError, "unable to list clusters")
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (api *API) sources(w http.ResponseWriter, r *http.Request) {
	sources, err := api.store.ListSources(r.Context())
	if err != nil {
		if aborted(r) {
			return
		}
		slog.Error("list cloud sources", "error", err)
		writeError(w, http.StatusInternalServerError, "unable to list cloud sources")
		return
	}
	configured := make(map[string]struct{}, len(api.config.CloudSources))
	for _, source := range api.config.CloudSources {
		configured[source.ID] = struct{}{}
	}
	visible := make([]model.SourceSummary, 0, len(sources))
	for _, source := range sources {
		if _, ok := configured[source.ID]; ok {
			visible = append(visible, source)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": visible})
}

func (api *API) syncRuns(w http.ResponseWriter, r *http.Request) {
	limit := intQuery(r.URL.Query().Get("limit"), 50)
	if limit < 1 || limit > 200 {
		writeError(w, http.StatusBadRequest, "limit must be between 1 and 200")
		return
	}
	// Fetch a wider window before applying runtime configuration scoping so stale
	// runs from a previous deployment cannot crowd configured sources out.
	runs, err := api.store.ListSyncRuns(r.Context(), 200)
	if err != nil {
		if aborted(r) {
			return
		}
		slog.Error("list sync runs", "error", err)
		writeError(w, http.StatusInternalServerError, "unable to list sync runs")
		return
	}
	configured := make(map[string]struct{}, len(api.config.CloudSources))
	for _, source := range api.config.CloudSources {
		configured[source.ID] = struct{}{}
	}
	visible := make([]model.SyncRun, 0, limit)
	for _, run := range runs {
		if _, ok := configured[run.SourceID]; !ok {
			continue
		}
		visible = append(visible, run)
		if len(visible) == limit {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": visible})
}

func (api *API) queueSync(w http.ResponseWriter, r *http.Request) {
	sourceID := strings.TrimSpace(r.PathValue("id"))
	if sourceID == "" {
		writeError(w, http.StatusBadRequest, "cloud source id is required")
		return
	}
	if api.syncer != nil {
		run, err := api.syncer.Sync(r.Context(), sourceID, "manual")
		switch {
		case errors.Is(err, syncer.ErrSourceUnavailable):
			writeError(w, http.StatusNotFound, err.Error())
			return
		case errors.Is(err, store.ErrSyncAlreadyActive):
			writeError(w, http.StatusConflict, "a sync is already active for this cloud source")
			return
		case err != nil:
			slog.Error("run manual sync", "source", sourceID, "error", err)
			writeError(w, http.StatusInternalServerError, "unable to run cloud source sync")
			return
		}
		writeJSON(w, http.StatusOK, run)
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

func (api *API) createApplicationOnboarding(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	var input onboarding.CreateInput
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 300*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "request body must contain valid onboarding JSON")
		return
	}
	result, err := api.onboarder.Create(r.Context(), input)
	var validationError onboarding.ValidationError
	var conflictError onboarding.ConflictError
	var externalError onboarding.ExternalError
	switch {
	case errors.As(err, &validationError):
		writeError(w, http.StatusUnprocessableEntity, validationError.Message)
		return
	case errors.As(err, &conflictError):
		writeError(w, http.StatusConflict, conflictError.Message)
		return
	case errors.As(err, &externalError):
		slog.Error("GitHub application onboarding dependency failed", "error", externalError)
		writeError(w, http.StatusBadGateway, "GitHub could not provision the application repository")
		return
	case err != nil:
		slog.Error("create application onboarding", "error", err)
		writeError(w, http.StatusInternalServerError, "unable to create application onboarding")
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

// resourceRef reads the resource tuple from the query string. Kind, name, and
// version identify the object; group is empty for core resources and namespace
// is empty for cluster-scoped ones, so only the first three are required.
func resourceRef(r *http.Request) (onboarding.ResourceRef, bool) {
	query := r.URL.Query()
	ref := onboarding.ResourceRef{
		Group:     query.Get("group"),
		Version:   query.Get("version"),
		Kind:      query.Get("kind"),
		Namespace: query.Get("namespace"),
		Name:      query.Get("name"),
	}
	if ref.Kind == "" || ref.Name == "" || ref.Version == "" {
		return onboarding.ResourceRef{}, false
	}
	return ref, true
}

// writeResourceError maps the shared failure modes of the resource endpoints.
func (api *API) writeResourceError(w http.ResponseWriter, err error, action string) {
	var validationError onboarding.ValidationError
	switch {
	case errors.Is(err, onboarding.ErrTargetNotFound):
		writeError(w, http.StatusNotFound, "deployment target not found")
	case errors.Is(err, onboarding.ErrResourceNotFound),
		errors.Is(err, onboarding.ErrApplicationNotFound):
		writeError(w, http.StatusNotFound, "resource not found in Argo CD")
	case errors.Is(err, onboarding.ErrPodLogsForbidden):
		writeError(w, http.StatusForbidden, "Pod log access is not configured in Argo CD")
	case errors.As(err, &validationError):
		writeError(w, http.StatusUnprocessableEntity, validationError.Message)
	default:
		slog.Error(action, "error", err)
		writeError(w, http.StatusBadGateway, "Argo CD could not be reached")
	}
}

func (api *API) applicationResources(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	nodes, err := api.onboarder.Resources(r.Context(), r.PathValue("id"), r.PathValue("targetId"))
	if err != nil {
		api.writeResourceError(w, err, "list application resources")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": nodes})
}

func (api *API) applicationResourceManifest(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	ref, ok := resourceRef(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "kind, name, and version are required")
		return
	}
	manifests, err := api.onboarder.ResourceManifests(
		r.Context(), r.PathValue("id"), r.PathValue("targetId"), ref,
	)
	if err != nil {
		api.writeResourceError(w, err, "read application resource manifest")
		return
	}
	writeJSON(w, http.StatusOK, manifests)
}

func (api *API) deleteApplicationResource(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	ref, ok := resourceRef(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "kind, name, and version are required")
		return
	}
	if err := api.onboarder.DeleteResource(
		r.Context(), r.PathValue("id"), r.PathValue("targetId"), ref,
	); err != nil {
		api.writeResourceError(w, err, "delete application resource")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type podLogEntry struct {
	Timestamp string `json:"timestamp,omitempty"`
	PodName   string `json:"podName,omitempty"`
	Content   string `json:"content,omitempty"`
	Error     string `json:"error,omitempty"`
}

// applicationPodLogs converts Argo CD's grpc-gateway stream envelopes into
// stable newline-delimited entries for the browser. Each encoded line is
// flushed immediately so the UI follows the running Pod rather than waiting
// for the response to finish.
func (api *API) applicationPodLogs(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	ref, ok := resourceRef(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "kind, name, and version are required")
		return
	}
	stream, err := api.onboarder.PodLogs(
		r.Context(), r.PathValue("id"), r.PathValue("targetId"), ref,
	)
	if err != nil {
		api.writeResourceError(w, err, "stream Pod logs")
		return
	}
	defer stream.Close()

	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	encoder := json.NewEncoder(w)
	flusher, _ := w.(http.Flusher)
	scanner := bufio.NewScanner(stream)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		var frame struct {
			Result *struct {
				Timestamp string `json:"timeStampStr"`
				PodName   string `json:"podName"`
				Content   string `json:"content"`
				Last      bool   `json:"last"`
			} `json:"result"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &frame); err != nil {
			continue
		}
		if frame.Error != nil {
			_ = encoder.Encode(podLogEntry{Error: frame.Error.Message})
			if flusher != nil {
				flusher.Flush()
			}
			return
		}
		if frame.Result == nil || frame.Result.Last {
			continue
		}
		if err := encoder.Encode(podLogEntry{
			Timestamp: frame.Result.Timestamp,
			PodName:   frame.Result.PodName,
			Content:   frame.Result.Content,
		}); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
	if err := scanner.Err(); err != nil && !aborted(r) {
		slog.Warn("read Pod log stream", "error", err)
	}
}

func (api *API) applicationOnboardingDefaults(w http.ResponseWriter, _ *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	defaults := api.onboarder.Defaults()
	if defaults.ValuesYAML == "" {
		writeError(w, http.StatusServiceUnavailable, "application onboarding defaults are not configured")
		return
	}
	writeJSON(w, http.StatusOK, defaults)
}

func (api *API) applicationOnboardings(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	query := r.URL.Query()
	// `limit` predates paging and stays supported as a page-size alias.
	pageSize := query.Get("pageSize")
	if pageSize == "" {
		pageSize = query.Get("limit")
	}
	filter := model.ApplicationOnboardingFilter{
		Search:   strings.TrimSpace(query.Get("search")),
		Status:   strings.ToLower(strings.TrimSpace(query.Get("status"))),
		Page:     intQuery(query.Get("page"), 1),
		PageSize: intQuery(pageSize, 20),
	}
	if filter.Page < 1 || filter.PageSize < 1 || filter.PageSize > 200 {
		writeError(w, http.StatusBadRequest, "page must be positive and pageSize must be between 1 and 200")
		return
	}
	if filter.Status != "" &&
		filter.Status != model.OnboardingProgressing &&
		filter.Status != model.OnboardingHealthy &&
		filter.Status != model.OnboardingPartial &&
		filter.Status != model.OnboardingFailed &&
		filter.Status != model.OnboardingOffboarded {
		writeError(
			w, http.StatusBadRequest,
			"status must be progressing, healthy, partial, failed, or offboarded",
		)
		return
	}
	api.reconcileApplications(r.Context())
	page, err := api.onboarder.List(r.Context(), filter)
	if err != nil {
		if aborted(r) {
			return
		}
		slog.Error("list application onboardings", "error", err)
		writeError(w, http.StatusInternalServerError, "unable to list application onboardings")
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (api *API) applicationOnboarding(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "application onboarding id is required")
		return
	}
	api.reconcileApplications(r.Context())
	item, err := api.onboarder.Get(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "application onboarding not found")
		return
	}
	if err != nil {
		if aborted(r) {
			return
		}
		slog.Error("get application onboarding", "onboarding", id, "error", err)
		writeError(w, http.StatusInternalServerError, "unable to load application onboarding")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (api *API) scaleApplicationOnboarding(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	var input struct {
		Replicas *int32 `json:"replicas"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || input.Replicas == nil {
		writeError(w, http.StatusBadRequest, "request body must contain a replica count")
		return
	}
	result, err := api.onboarder.Scale(r.Context(), r.PathValue("id"), *input.Replicas)
	var validationError onboarding.ValidationError
	var externalError onboarding.ExternalError
	switch {
	case errors.As(err, &validationError):
		writeError(w, http.StatusUnprocessableEntity, validationError.Message)
		return
	case errors.As(err, &externalError):
		slog.Error("scale application through GitHub", "error", externalError)
		writeError(w, http.StatusBadGateway, "GitHub could not update application replicas")
		return
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "application onboarding not found")
		return
	case err != nil:
		slog.Error("scale application onboarding", "error", err)
		writeError(w, http.StatusInternalServerError, "unable to scale application")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (api *API) syncApplicationOnboarding(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	api.runApplicationAction(w, r, "sync", api.onboarder.Sync)
}

func (api *API) offboardApplicationOnboarding(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	api.runApplicationAction(w, r, "offboard", api.onboarder.Offboard)
}

func (api *API) runApplicationAction(
	w http.ResponseWriter,
	r *http.Request,
	action string,
	run func(context.Context, string) (model.ApplicationOnboarding, error),
) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "application onboarding id is required")
		return
	}
	item, err := run(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "application onboarding not found")
		return
	}
	if err != nil {
		if aborted(r) {
			return
		}
		slog.Error(action+" application onboarding", "onboarding", id, "error", err)
		writeError(w, http.StatusInternalServerError, "unable to "+action+" application")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func withCORS(next http.Handler, allowedOrigin string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") == allowedOrigin {
			w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
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

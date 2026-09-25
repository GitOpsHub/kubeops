package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"runtime/debug"
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
	ListSyncRuns(context.Context, int, []string) ([]model.SyncRun, error)
	QueueSync(context.Context, string, string) (model.SyncRun, error)
	GetKubespinArgoDetails(context.Context, string) (model.KubespinArgoCDDetails, error)
	Overview(context.Context, []string) (model.OverviewStats, error)
	RecordApplicationOperation(context.Context, model.ApplicationOperation) error
	ListApplicationOperations(context.Context, string, int) ([]model.ApplicationOperation, error)
}

type ClusterManager interface {
	Details(context.Context, model.CloudSource, model.Cluster) (model.ClusterDetails, error)
	ScaleNodePool(context.Context, model.CloudSource, model.Cluster, string, int32) (model.ScaleResult, error)
}

type ApplicationOnboarder interface {
	Create(context.Context, onboarding.CreateInput) (model.ApplicationOnboarding, error)
	Get(context.Context, string) (model.ApplicationOnboarding, error)
	Sync(context.Context, string) (model.ApplicationOnboarding, error)
	SyncWithOptions(context.Context, string, onboarding.SyncOptions) (model.ApplicationOnboarding, error)
	TerminateOperation(context.Context, string, string) error
	Rollback(context.Context, string, string) (model.ApplicationOnboarding, error)
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
	Logs(context.Context, string, string, onboarding.LogQuery) (io.ReadCloser, error)
	TargetStatus(context.Context, string, string) (onboarding.ArgoAppStatus, error)
	TargetEvents(context.Context, string, string, onboarding.EventQuery) ([]onboarding.ArgoEvent, error)
	Containers(context.Context, string, string, onboarding.ResourceRef) ([]onboarding.Container, error)
	Revisions(context.Context, string, int) (onboarding.ValuesHistory, error)
	RevisionValues(context.Context, string, string) (onboarding.RevisionValues, error)
}

type SourceSyncer interface {
	Sync(context.Context, string, string) (model.SyncRun, error)
	SyncAll(context.Context, string) ([]model.SyncRun, error)
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
	mux.HandleFunc("GET /api/overview", api.overview)
	mux.HandleFunc("GET /api/clusters", api.clusters)
	mux.HandleFunc("GET /api/clusters/{id}/details", api.clusterDetails)
	mux.HandleFunc("GET /api/clusters/{id}/argo-access", api.clusterArgoAccess)
	mux.HandleFunc("POST /api/clusters/{id}/node-pools/{pool}/scale", api.scaleNodePool)
	mux.HandleFunc("GET /api/cloud-sources", api.sources)
	mux.HandleFunc("GET /api/sync-runs", api.syncRuns)
	mux.HandleFunc("POST /api/cloud-sources/{id}/sync", api.queueSync)
	// Vercel Cron always invokes with GET; POST stays available for any other
	// scheduler that presents the same bearer secret.
	mux.HandleFunc("GET /api/cloud-sources/sync", api.cronSync)
	mux.HandleFunc("POST /api/cloud-sources/sync", api.cronSync)
	mux.HandleFunc("POST /api/application-onboardings", api.createApplicationOnboarding)
	mux.HandleFunc("GET /api/application-onboardings", api.applicationOnboardings)
	mux.HandleFunc("GET /api/application-onboardings/defaults", api.applicationOnboardingDefaults)
	mux.HandleFunc("GET /api/application-onboardings/{id}", api.applicationOnboarding)
	mux.HandleFunc("POST /api/application-onboardings/{id}/sync", api.syncApplicationOnboarding)
	mux.HandleFunc("POST /api/application-onboardings/{id}/scale", api.scaleApplicationOnboarding)
	mux.HandleFunc("POST /api/application-onboardings/{id}/offboard", api.offboardApplicationOnboarding)
	mux.HandleFunc("POST /api/application-onboardings/{id}/rollback", api.rollbackApplicationOnboarding)
	mux.HandleFunc("GET /api/application-onboardings/{id}/operations", api.applicationOperations)
	mux.HandleFunc(
		"DELETE /api/application-onboardings/{id}/targets/{targetId}/operation",
		api.terminateApplicationOperation,
	)
	mux.HandleFunc(
		"GET /api/application-onboardings/{id}/targets/{targetId}/resources",
		api.applicationResources,
	)
	mux.HandleFunc(
		"GET /api/application-onboardings/{id}/targets/{targetId}/resources/manifest",
		api.applicationResourceManifest,
	)
	// The original Pod-only logs route stays as an alias of the general one.
	mux.HandleFunc(
		"GET /api/application-onboardings/{id}/targets/{targetId}/resources/logs",
		api.applicationLogs,
	)
	mux.HandleFunc(
		"GET /api/application-onboardings/{id}/targets/{targetId}/logs",
		api.applicationLogs,
	)
	mux.HandleFunc(
		"GET /api/application-onboardings/{id}/targets/{targetId}/resources/containers",
		api.applicationContainers,
	)
	mux.HandleFunc(
		"GET /api/application-onboardings/{id}/targets/{targetId}/argo",
		api.applicationTargetStatus,
	)
	mux.HandleFunc(
		"GET /api/application-onboardings/{id}/targets/{targetId}/events",
		api.applicationTargetEvents,
	)
	mux.HandleFunc("GET /api/application-onboardings/{id}/revisions", api.applicationRevisions)
	mux.HandleFunc(
		"GET /api/application-onboardings/{id}/revisions/{sha}/values",
		api.applicationRevisionValues,
	)
	mux.HandleFunc(
		"DELETE /api/application-onboardings/{id}/targets/{targetId}/resources",
		api.deleteApplicationResource,
	)
	// Serves the Argo CD UI on this origin so the browser needs neither Argo CD
	// credentials nor trust in the Argo CD server's certificate.
	if proxy, err := newArgoProxy(cfg.Onboarding.ArgoTargets, repository); err != nil {
		// A misconfigured target must not take down the rest of the API; the deep
		// links simply stay unavailable.
		slog.Error("configure Argo CD proxy", "error", err)
	} else {
		mux.Handle(argoProxyPrefix, proxy)
	}
	return withRecoverer(withCORS(withRequestLog(withIdentityToken(mux)), cfg.CORSAllowedOrigin))
}

// withIdentityToken carries the platform's OIDC identity token from the request
// into the context, where the cloud credential builders read it. A deployed
// serverless function receives the token this way on every invocation and never
// in its environment, so without this the backend would silently fall back to
// the provider SDK default chains in production.
//
// The CORS policy only stops a browser page from setting this header; any
// non-browser caller can send it, and the API has no authentication. What keeps
// that harmless is on the cloud side: a supplied token is only useful if it is
// a valid platform-issued token that the source's trust policy accepts. It is
// also why the Argo CD proxy strips every x-vercel-* header before forwarding.
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

	// No statically configured target: fall back to kubespin's Argo CD details
	// for this cluster, matched by name. Routed through the same reverse proxy
	// as static targets (argoProxy.resolveDynamicProxy resolves it on first
	// request, keyed by the cluster's own id), which logs into kubespin's
	// Argo CD server with its username/password and attaches the resulting
	// session token server-side — the browser lands signed in rather than at
	// an Argo CD login form. Linked at the mount root rather than
	// "/applications": kubespin's Argo CD servers serve the UI shell only at
	// "/" and answer every other client-side route with a bare 404, unlike
	// the fully configured deployments static targets point at.
	_, err = api.store.GetKubespinArgoDetails(r.Context(), cluster.Name)
	if err == nil {
		writeJSON(w, http.StatusOK, model.ArgoAccess{
			URL: api.config.Onboarding.PublicBaseURL + argoProxyPrefix + cluster.ID + "/",
		})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		if aborted(r) {
			return
		}
		slog.Error("get kubespin Argo CD access", "cluster", id, "error", err)
		writeError(w, http.StatusInternalServerError, "unable to load Argo CD access")
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
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
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
	switch sort := query.Get("sort"); sort {
	case "", model.ClusterSortName, model.ClusterSortProvider, model.ClusterSortStatus,
		model.ClusterSortVersion, model.ClusterSortNodes, model.ClusterSortLastSeen:
		filter.Sort = sort
	default:
		writeError(w, http.StatusBadRequest,
			"sort must be name, provider, status, version, nodes, or lastSeen")
		return
	}
	switch query.Get("order") {
	case "", "asc":
	case "desc":
		filter.Descending = true
	default:
		writeError(w, http.StatusBadRequest, "order must be asc or desc")
		return
	}
	if filter.Sort == "" && filter.Descending {
		filter.Sort = model.ClusterSortName
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
	query := r.URL.Query()
	limit := intQuery(query.Get("limit"), 50)
	if limit < 1 || limit > 200 {
		writeError(w, http.StatusBadRequest, "limit must be between 1 and 200")
		return
	}
	// Scoping happens in SQL so runs left by a previous deployment's sources
	// cannot crowd configured sources out of the window.
	scope := api.configuredSourceIDs()
	if sourceID := strings.TrimSpace(query.Get("sourceId")); sourceID != "" {
		if _, ok := api.source(sourceID); ok {
			scope = []string{sourceID}
		} else {
			scope = []string{}
		}
	}
	runs, err := api.store.ListSyncRuns(r.Context(), limit, scope)
	if err != nil {
		if aborted(r) {
			return
		}
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
	switch {
	case errors.Is(err, store.ErrSyncAlreadyActive):
		writeError(w, http.StatusConflict, "a sync is already active for this cloud source")
		return
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "enabled cloud source not found")
		return
	case err != nil:
		if aborted(r) {
			return
		}
		slog.Error("queue manual sync", "source", sourceID, "error", err)
		writeError(w, http.StatusInternalServerError, "unable to queue cloud source sync")
		return
	}
	writeJSON(w, http.StatusAccepted, run)
}

// cronSync pulls every enabled cloud source once, driven by an external
// scheduler (Vercel Cron, which always calls with GET) rather than a person
// clicking "Sync now". It only runs when CRON_SECRET is configured, and only
// for the caller that presents it — the API otherwise has no authentication,
// so an unguarded bulk trigger here would let anyone repeatedly force
// discovery across every source.
func (api *API) cronSync(w http.ResponseWriter, r *http.Request) {
	if api.config.CronSecret == "" {
		writeError(w, http.StatusServiceUnavailable, "scheduled sync is not configured")
		return
	}
	if subtle.ConstantTimeCompare(
		[]byte(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")),
		[]byte(api.config.CronSecret),
	) != 1 {
		writeError(w, http.StatusUnauthorized, "invalid or missing scheduled sync credentials")
		return
	}
	if api.syncer == nil {
		writeError(w, http.StatusServiceUnavailable, "cloud source syncing is not available")
		return
	}
	runs, err := api.syncer.SyncAll(r.Context(), "cron")
	if err != nil {
		slog.Error("run scheduled sync", "error", err)
		writeError(w, http.StatusInternalServerError, "unable to run scheduled cloud source sync")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": runs})
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

// writeResourceError maps the shared failure modes of the resource endpoints
// and returns the status it wrote, or 0 when the caller had hung up.
func (api *API) writeResourceError(w http.ResponseWriter, r *http.Request, err error, action string) int {
	var validationError onboarding.ValidationError
	status, message := http.StatusBadGateway, "Argo CD could not be reached"
	switch {
	case aborted(r):
		return 0
	case errors.Is(err, pgx.ErrNoRows):
		status, message = http.StatusNotFound, "application onboarding not found"
	case errors.Is(err, onboarding.ErrTargetNotFound):
		status, message = http.StatusNotFound, "deployment target not found"
	case errors.Is(err, onboarding.ErrResourceNotFound),
		errors.Is(err, onboarding.ErrApplicationNotFound):
		status, message = http.StatusNotFound, "resource not found in Argo CD"
	case errors.Is(err, onboarding.ErrPodLogsForbidden):
		status, message = http.StatusForbidden, "Pod log access is not configured in Argo CD"
	case errors.As(err, &validationError):
		status, message = http.StatusUnprocessableEntity, validationError.Message
	default:
		slog.Error(action, "error", err)
	}
	writeError(w, status, message)
	return status
}

func (api *API) applicationResources(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	nodes, err := api.onboarder.Resources(r.Context(), r.PathValue("id"), r.PathValue("targetId"))
	if err != nil {
		api.writeResourceError(w, r, err, "list application resources")
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
		api.writeResourceError(w, r, err, "read application resource manifest")
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
		api.writeResourceError(w, r, err, "delete application resource")
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
		api.recordOperation(r, r.PathValue("id"), "", "scale",
			map[string]any{"replicas": *input.Replicas}, operationFailed)
		writeError(w, http.StatusBadGateway, "GitHub could not update application replicas")
		return
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "application onboarding not found")
		return
	case err != nil:
		slog.Error("scale application onboarding", "error", err)
		api.recordOperation(r, r.PathValue("id"), "", "scale",
			map[string]any{"replicas": *input.Replicas}, operationFailed)
		writeError(w, http.StatusInternalServerError, "unable to scale application")
		return
	}
	api.recordOperation(r, r.PathValue("id"), "", "scale",
		map[string]any{"replicas": *input.Replicas}, operationSucceeded)
	writeJSON(w, http.StatusOK, result)
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
	params := map[string]any{}
	if action == "sync" {
		_, params = syncOperation(onboarding.DefaultSyncOptions())
	}
	if err != nil {
		if aborted(r) {
			return
		}
		slog.Error(action+" application onboarding", "onboarding", id, "error", err)
		api.recordOperation(r, id, "", action, params, operationFailed)
		writeError(w, http.StatusInternalServerError, "unable to "+action+" application")
		return
	}
	api.recordOperation(r, id, "", action, params, operationSucceeded)
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

// withRecoverer turns a handler panic into a logged stack and a JSON 500.
// net/http would otherwise just drop the connection, which the UI reports as a
// network error with nothing in the logs to explain it.
func withRecoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tracked := &headerTracker{ResponseWriter: w}
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			// ReverseProxy aborts a half-copied response this way on purpose;
			// net/http knows to close the connection quietly.
			if recovered == http.ErrAbortHandler {
				panic(recovered)
			}
			slog.Error("panic serving API request",
				"method", r.Method, "path", r.URL.Path,
				"panic", recovered, "stack", string(debug.Stack()))
			if !tracked.wroteHeader {
				writeError(w, http.StatusInternalServerError, "internal server error")
			}
		}()
		next.ServeHTTP(tracked, r)
	})
}

// headerTracker records whether a response has started, so withRecoverer
// never writes a second status line into a response already on the wire.
type headerTracker struct {
	http.ResponseWriter
	wroteHeader bool
}

func (t *headerTracker) WriteHeader(status int) {
	t.wroteHeader = true
	t.ResponseWriter.WriteHeader(status)
}

func (t *headerTracker) Write(body []byte) (int, error) {
	t.wroteHeader = true
	return t.ResponseWriter.Write(body)
}

// Flush keeps streaming endpoints (Pod logs) working through the wrapper.
func (t *headerTracker) Flush() {
	t.wroteHeader = true
	if flusher, ok := t.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (t *headerTracker) Unwrap() http.ResponseWriter {
	return t.ResponseWriter
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

package httpapi

import (
	"bufio"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/onboarding"
	"github.com/jackc/pgx/v5"
)

// The Argo CD console endpoints. Every one is scoped to an onboarding and one
// of its targets, so the browser never talks to the unauthenticated /argo
// proxy and cannot point a request at another application's cluster.

func (api *API) applicationTargetStatus(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	status, err := api.onboarder.TargetStatus(r.Context(), r.PathValue("id"), r.PathValue("targetId"))
	if err != nil {
		api.writeResourceError(w, r, err, "read Argo CD application status")
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (api *API) applicationTargetEvents(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	query := r.URL.Query()
	events, err := api.onboarder.TargetEvents(
		r.Context(), r.PathValue("id"), r.PathValue("targetId"),
		onboarding.EventQuery{
			Kind: query.Get("kind"), Name: query.Get("name"),
			Namespace: query.Get("namespace"), UID: query.Get("uid"),
		},
	)
	if err != nil {
		api.writeResourceError(w, r, err, "list Argo CD events")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": events})
}

func (api *API) applicationContainers(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	ref, ok := resourceRef(r)
	if !ok {
		writeError(w, http.StatusBadRequest, "kind, name, and version are required")
		return
	}
	containers, err := api.onboarder.Containers(r.Context(), r.PathValue("id"), r.PathValue("targetId"), ref)
	if err != nil {
		api.writeResourceError(w, r, err, "list resource containers")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": containers})
}

// parseLogQuery checks only the syntax of the log parameters; ranges and the
// kind allowlist are the service's to enforce.
func parseLogQuery(r *http.Request) (onboarding.LogQuery, string) {
	values := r.URL.Query()
	query := onboarding.LogQuery{
		Resource: onboarding.ResourceRef{
			Group: values.Get("group"), Version: values.Get("version"),
			Kind: values.Get("kind"), Namespace: values.Get("namespace"), Name: values.Get("name"),
		},
		Container: values.Get("container"),
		Filter:    values.Get("filter"),
		// Following is the default: the viewer tails a live stream unless it
		// asks for a finite read.
		Follow: true,
	}
	if query.Resource.Kind == "" || query.Resource.Name == "" {
		return onboarding.LogQuery{}, "kind and name are required"
	}
	integer := func(key string, target *int64) bool {
		raw := values.Get(key)
		if raw == "" {
			return true
		}
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 1 {
			return false
		}
		*target = parsed
		return true
	}
	if !integer("tailLines", &query.TailLines) {
		return onboarding.LogQuery{}, "tailLines must be a positive integer"
	}
	if !integer("sinceSeconds", &query.SinceSeconds) {
		return onboarding.LogQuery{}, "sinceSeconds must be a positive integer"
	}
	if raw := values.Get("sinceTime"); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			return onboarding.LogQuery{}, "sinceTime must be an RFC 3339 timestamp"
		}
		query.SinceTime = &parsed
	}
	for key, target := range map[string]*bool{"previous": &query.Previous, "follow": &query.Follow} {
		raw := values.Get(key)
		if raw == "" {
			continue
		}
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			return onboarding.LogQuery{}, key + " must be true or false"
		}
		*target = parsed
	}
	return query, ""
}

type podLogEntry struct {
	Timestamp string `json:"timestamp,omitempty"`
	PodName   string `json:"podName,omitempty"`
	Content   string `json:"content,omitempty"`
	Error     string `json:"error,omitempty"`
}

// applicationLogs converts Argo CD's grpc-gateway stream envelopes into stable
// newline-delimited entries for the browser. Each encoded line is flushed
// immediately so the UI follows the running Pods rather than waiting for the
// response to finish. Log content is never logged server-side.
func (api *API) applicationLogs(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	query, problem := parseLogQuery(r)
	if problem != "" {
		writeError(w, http.StatusBadRequest, problem)
		return
	}
	stream, err := api.onboarder.Logs(r.Context(), r.PathValue("id"), r.PathValue("targetId"), query)
	if err != nil {
		api.writeResourceError(w, r, err, "stream logs")
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
			_ = encoder.Encode(podLogEntry{Error: onboarding.ScrubMessage(frame.Error.Message)})
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
		slog.Warn("read log stream", "onboarding", r.PathValue("id"),
			"target", r.PathValue("targetId"), "error", err)
	}
}

// writeValuesError maps failures of the GitHub-backed values endpoints.
// GitHub's own error text never reaches the caller.
func (api *API) writeValuesError(
	w http.ResponseWriter,
	r *http.Request,
	err error,
	action, gitHubMessage string,
) {
	var validationError onboarding.ValidationError
	var externalError onboarding.ExternalError
	switch {
	case aborted(r):
		return
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "application onboarding not found")
	case errors.Is(err, onboarding.ErrRevisionNotFound):
		writeError(w, http.StatusNotFound, "values file not found at that revision")
	case errors.As(err, &validationError):
		writeError(w, http.StatusUnprocessableEntity, validationError.Message)
	case errors.As(err, &externalError):
		slog.Error(action, "onboarding", r.PathValue("id"), "error", externalError)
		writeError(w, http.StatusBadGateway, gitHubMessage)
	default:
		slog.Error(action, "onboarding", r.PathValue("id"), "error", err)
		writeError(w, http.StatusInternalServerError, "unable to "+action)
	}
}

func (api *API) applicationRevisions(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	limit := intQuery(r.URL.Query().Get("limit"), onboarding.DefaultRevisionPage)
	if limit < 1 || limit > onboarding.MaxRevisionPage {
		writeError(w, http.StatusBadRequest,
			"limit must be between 1 and "+strconv.Itoa(onboarding.MaxRevisionPage))
		return
	}
	history, err := api.onboarder.Revisions(r.Context(), strings.TrimSpace(r.PathValue("id")), limit)
	if err != nil {
		api.writeValuesError(w, r, err, "list values history", "GitHub could not list application values history")
		return
	}
	writeJSON(w, http.StatusOK, history)
}

func (api *API) applicationRevisionValues(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	sha := r.PathValue("sha")
	if !onboarding.ValidCommitSHA(sha) {
		writeError(w, http.StatusBadRequest, "sha must be a 7 to 40 character lowercase hex commit id")
		return
	}
	values, err := api.onboarder.RevisionValues(r.Context(), strings.TrimSpace(r.PathValue("id")), sha)
	if err != nil {
		api.writeValuesError(w, r, err, "read values revision", "GitHub could not read application values")
		return
	}
	writeJSON(w, http.StatusOK, values)
}

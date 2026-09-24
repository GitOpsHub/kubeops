package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"

	"github.com/GitOpsHub/kubeops/backend/internal/onboarding"
	"github.com/jackc/pgx/v5"
)

// maxMutationBody caps the console's mutation bodies, which carry a handful
// of ids and flags at most.
const maxMutationBody = 4 << 10

// readJSONBody decodes an optional JSON body into target. present reports
// whether there was a body at all; ok is false once an error response has been
// written. Requiring application/json whenever a body is sent makes every
// cross-origin browser request preflight, which the CORS policy then refuses
// for other origins: with no authentication, that is this API's CSRF barrier.
func readJSONBody(w http.ResponseWriter, r *http.Request, target any) (present, ok bool) {
	if r.Body == nil {
		return false, true
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxMutationBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "request body must not exceed 4 KiB")
			return true, false
		}
		writeError(w, http.StatusBadRequest, "request body could not be read")
		return true, false
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return false, true
	}
	if mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil ||
		mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "Content-Type must be application/json")
		return true, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		writeError(w, http.StatusBadRequest, "request body must be a single valid JSON object")
		return true, false
	}
	return true, true
}

// consoleMutationsAllowed enforces ONBOARDING_CONSOLE_MUTATIONS for the
// actions that flag covers.
func (api *API) consoleMutationsAllowed(w http.ResponseWriter) bool {
	if api.config.Onboarding.ConsoleMutations {
		return true
	}
	writeError(w, http.StatusForbidden, "Argo CD console actions are disabled on this deployment")
	return false
}

type syncRequest struct {
	TargetIDs          []string `json:"targetIds"`
	Prune              *bool    `json:"prune"`
	DryRun             bool     `json:"dryRun"`
	Force              bool     `json:"force"`
	ApplyOutOfSyncOnly bool     `json:"applyOutOfSyncOnly"`
}

func (api *API) syncApplicationOnboarding(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	var request syncRequest
	present, ok := readJSONBody(w, r, &request)
	if !ok {
		return
	}
	if !present {
		// No body is the original sync: every target, pruning.
		api.runApplicationAction(w, r, "sync", api.onboarder.Sync)
		return
	}
	options := onboarding.DefaultSyncOptions()
	options.TargetIDs = request.TargetIDs
	if request.Prune != nil {
		options.Prune = *request.Prune
	}
	options.DryRun, options.Force = request.DryRun, request.Force
	options.ApplyOutOfSyncOnly = request.ApplyOutOfSyncOnly

	id := strings.TrimSpace(r.PathValue("id"))
	item, err := api.onboarder.SyncWithOptions(r.Context(), id, options)
	var validationError onboarding.ValidationError
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, item)
	case aborted(r):
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "application onboarding not found")
	case errors.As(err, &validationError):
		writeError(w, http.StatusUnprocessableEntity, validationError.Message)
	case errors.Is(err, onboarding.ErrDryRunFailed):
		slog.Error("dry-run sync application onboarding", "onboarding", id, "error", err)
		writeError(w, http.StatusBadGateway, "Argo CD could not start the dry run on every target")
	default:
		slog.Error("sync application onboarding", "onboarding", id, "error", err)
		writeError(w, http.StatusInternalServerError, "unable to sync application")
	}
}

func (api *API) terminateApplicationOperation(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	if !api.consoleMutationsAllowed(w) {
		return
	}
	id, targetID := r.PathValue("id"), r.PathValue("targetId")
	err := api.onboarder.TerminateOperation(r.Context(), id, targetID)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, onboarding.ErrNoOperation):
		writeError(w, http.StatusConflict, "no sync operation is in progress")
	default:
		api.writeResourceError(w, r, err, "terminate Argo CD operation")
	}
}

func (api *API) rollbackApplicationOnboarding(w http.ResponseWriter, r *http.Request) {
	if api.onboarder == nil {
		writeError(w, http.StatusServiceUnavailable, "application onboarding is not available")
		return
	}
	if !api.consoleMutationsAllowed(w) {
		return
	}
	var request struct {
		CommitSHA string `json:"commitSha"`
	}
	present, ok := readJSONBody(w, r, &request)
	if !ok {
		return
	}
	if !present || !onboarding.ValidCommitSHA(request.CommitSHA) {
		writeError(w, http.StatusBadRequest, "request body must contain a 7 to 40 character lowercase hex commitSha")
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	item, err := api.onboarder.Rollback(r.Context(), id, request.CommitSHA)
	var validationError onboarding.ValidationError
	var externalError onboarding.ExternalError
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, item)
	case aborted(r):
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, http.StatusNotFound, "application onboarding not found")
	case errors.As(err, &validationError):
		writeError(w, http.StatusUnprocessableEntity, validationError.Message)
	case errors.As(err, &externalError):
		slog.Error("roll back application through GitHub", "onboarding", id, "sha", request.CommitSHA, "error", externalError)
		writeError(w, http.StatusBadGateway, "GitHub could not roll back application values")
	default:
		slog.Error("roll back application onboarding", "onboarding", id, "sha", request.CommitSHA, "error", err)
		writeError(w, http.StatusInternalServerError, "unable to roll back application")
	}
}

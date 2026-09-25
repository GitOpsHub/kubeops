package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"strings"

	"github.com/GitOpsHub/kubeops/backend/internal/model"
	"github.com/GitOpsHub/kubeops/backend/internal/onboarding"
)

const (
	operationSucceeded = "succeeded"
	operationFailed    = "failed"
)

// recordOperation appends to the application's audit trail. It runs after the
// action has already happened, so a failure is logged rather than turned into
// an error response, and it outlives a client that has hung up.
func (api *API) recordOperation(
	r *http.Request,
	onboardingID, targetID, kind string,
	params map[string]any,
	result string,
) {
	operation := model.ApplicationOperation{
		OnboardingID: strings.TrimSpace(onboardingID), Kind: kind, Params: params, Result: result,
	}
	if targetID != "" {
		operation.TargetID = &targetID
	}
	if err := api.store.RecordApplicationOperation(context.WithoutCancel(r.Context()), operation); err != nil {
		slog.Warn("record application operation",
			"onboarding", onboardingID, "kind", kind, "error", err)
	}
}

func syncOperation(options onboarding.SyncOptions) (string, map[string]any) {
	kind := "sync"
	if options.DryRun {
		kind = "dry-run"
	}
	params := map[string]any{
		"prune": options.Prune, "force": options.Force,
		"applyOutOfSyncOnly": options.ApplyOutOfSyncOnly,
	}
	if len(options.TargetIDs) > 0 {
		params["targetIds"] = options.TargetIDs
	}
	return kind, params
}

func (api *API) applicationOperations(w http.ResponseWriter, r *http.Request) {
	limit := intQuery(r.URL.Query().Get("limit"), 50)
	if limit < 1 || limit > 200 {
		writeError(w, http.StatusBadRequest, "limit must be between 1 and 200")
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	operations, err := api.store.ListApplicationOperations(r.Context(), id, limit)
	if err != nil {
		if aborted(r) {
			return
		}
		slog.Error("list application operations", "onboarding", id, "error", err)
		writeError(w, http.StatusInternalServerError, "unable to list application operations")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": operations})
}

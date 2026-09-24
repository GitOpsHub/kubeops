package httpapi

import (
	"log/slog"
	"net/http"
)

// overview serves the dashboard aggregates in one request. Inventory is scoped
// to the configured sources like every other inventory endpoint, so rows left
// behind by a previous deployment's configuration never inflate the counts.
func (api *API) overview(w http.ResponseWriter, r *http.Request) {
	// Application status is only as fresh as the last reconcile; without
	// background workers nothing else refreshes it before this read.
	api.reconcileApplications(r.Context())
	stats, err := api.store.Overview(r.Context(), api.configuredSourceIDs())
	if err != nil {
		if aborted(r) {
			return
		}
		slog.Error("load overview", "error", err)
		writeError(w, http.StatusInternalServerError, "unable to load overview")
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

package server

import (
	"encoding/json"
	"net/http"
)

// handleUpdate serves GET /api/update — returns the current update status as JSON.
func handleUpdate(version string, viaPkg bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		info := CheckForUpdate(version, viaPkg)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(info)
	}
}

// handleUpdateSkip serves POST /api/update/skip — records a skipped version.
func handleUpdateSkip() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Version string `json:"version"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Version == "" {
			writeJSONError(w, "invalid request", http.StatusBadRequest)
			return
		}
		SkipVersion(body.Version)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Write([]byte(`{"ok":true}`))
	}
}

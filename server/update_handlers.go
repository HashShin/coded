package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
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

// handleUpdateInstall serves GET /api/update/install — streams download progress via SSE,
// downloads the latest release asset, and atomically replaces the running binary.
// Only available for non-pkg installs.
func handleUpdateInstall(version string, viaPkg bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if viaPkg {
			writeJSONError(w, "managed by pkg", http.StatusBadRequest)
			return
		}
		info := CheckForUpdate(version, viaPkg)
		if !info.Available {
			writeJSONError(w, "no update available", http.StatusConflict)
			return
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSONError(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		sseMsg := func(event, data string) {
			if event != "" {
				fmt.Fprintf(w, "event: %s\n", event)
			}
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}

		progress := func(downloaded, total int64) {
			sseMsg("", fmt.Sprintf(`{"downloaded":%d,"total":%d}`, downloaded, total))
		}

		if err := DownloadAndInstall(info.Latest, progress); err != nil {
			errJSON, _ := json.Marshal(map[string]string{"message": err.Error()})
			sseMsg("error", string(errJSON))
			return
		}
		sseMsg("done", "{}")
	}
}

// handleUpdateRestart serves POST /api/update/restart — responds OK then re-execs
// the (now updated) binary, injecting CODED_PORT so it binds the same port.
func handleUpdateRestart(port int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Write([]byte(`{"ok":true}`))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		go func() {
			time.Sleep(300 * time.Millisecond)
			if err := RestartOnPort(port); err != nil {
				log.Printf("coded: restart failed: %v", err)
			}
		}()
	}
}

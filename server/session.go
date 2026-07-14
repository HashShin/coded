package server

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// handleSession dispatches GET and PUT requests for /api/session.
func handleSession(root string) http.HandlerFunc {
	sessionDir  := filepath.Join(root, ".webeditor")
	sessionFile := filepath.Join(sessionDir, "session.json")

	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleSessionGet(sessionFile, w)
		case http.MethodPut:
			handleSessionPut(sessionDir, sessionFile, w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

// handleSessionGet serves GET /api/session — returns session.json or {}.
func handleSessionGet(sessionFile string, w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")

	data, err := os.ReadFile(sessionFile)
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Fprint(w, "{}")
			return
		}
		writeJSONError(w, "read error", http.StatusInternalServerError)
		return
	}

	w.Write(data)
}

// handleSessionPut serves PUT /api/session — stores the request body as session.json.
func handleSessionPut(sessionDir, sessionFile string, w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, "read body error", http.StatusInternalServerError)
		return
	}

	// Ensure the .webeditor directory exists.
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		writeJSONError(w, "mkdir error", http.StatusInternalServerError)
		return
	}

	// Atomic write: temp file in same dir, then rename.
	tmp, err := os.CreateTemp(sessionDir, ".session-tmp-*")
	if err != nil {
		writeJSONError(w, "create temp file error", http.StatusInternalServerError)
		return
	}
	tmpPath := tmp.Name()

	_, writeErr := tmp.Write(body)
	closeErr := tmp.Close()

	if writeErr != nil || closeErr != nil {
		os.Remove(tmpPath)
		writeJSONError(w, "write error", http.StatusInternalServerError)
		return
	}

	if err := os.Rename(tmpPath, sessionFile); err != nil {
		os.Remove(tmpPath)
		writeJSONError(w, "rename error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, `{"ok":true}`)
}

package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"time"
)

// handleUpdate serves GET /api/update — returns the current update status as JSON.
// In dev builds (version=="dev" or "0.0.1" style) pass ?pkg=1 to simulate a pkg install.
func handleUpdate(version string, viaPkg bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		effectiveViaPkg := viaPkg || r.URL.Query().Get("pkg") == "1"
		ignoreSkip := r.URL.Query().Get("ignore_skip") == "1"
		info := CheckForUpdate(version, effectiveViaPkg, ignoreSkip)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(info)
	}
}

// handleUpdateRefresh serves POST /api/update/refresh — resets the cache
// so the next CheckForUpdate call hits the network again.
func handleUpdateRefresh() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		cacheMu.Lock()
		c := loadCache()
		c.LastChecked = time.Time{} // zero → force re-fetch
		saveCache(c)
		cacheMu.Unlock()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Write([]byte(`{"ok":true}`))
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

// handleUpdateInstall serves GET /api/update/install — streams update progress via SSE.
// For non-pkg installs: streams byte-level download progress as JSON messages.
// For pkg installs: runs `pkg upgrade -y coded` and streams its output as log lines.
func handleUpdateInstall(version string, viaPkg bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		effectiveViaPkg := viaPkg || r.URL.Query().Get("pkg") == "1"
		info := CheckForUpdate(version, effectiveViaPkg, false)
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

		if effectiveViaPkg {
			// Stream pkg upgrade output line by line.
			if err := runPkgUpgrade(w, flusher, sseMsg); err != nil {
				errJSON, _ := json.Marshal(map[string]string{"message": err.Error()})
				sseMsg("error", string(errJSON))
				return
			}
			sseMsg("done", "{}")
			return
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

// runPkgUpgrade runs `pkg upgrade -y coded` and streams each output line as an SSE log event.
func runPkgUpgrade(w http.ResponseWriter, flusher http.Flusher, sseMsg func(event, data string)) error {
	cmd := exec.Command("pkg", "install", "-y", "coded")
	cmd.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")

	pr, pw, err := os.Pipe()
	if err != nil {
		return err
	}
	cmd.Stdout = pw
	cmd.Stderr = pw

	if err := cmd.Start(); err != nil {
		pw.Close()
		pr.Close()
		return err
	}
	pw.Close() // close write-end in parent so EOF propagates

	scanner := bufio.NewScanner(pr)
	for scanner.Scan() {
		line := scanner.Text()
		lineJSON, _ := json.Marshal(line)
		sseMsg("log", string(lineJSON))
	}
	pr.Close()

	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("pkg upgrade failed: %w", err)
	}
	return nil
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

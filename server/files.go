package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// resolveWithinRoot safely joins root and relPath, then verifies the result
// stays within root. Returns an absolute path or an error if the path escapes.
func resolveWithinRoot(root, relPath string) (string, error) {
	joined := filepath.Join(root, relPath)
	abs, err := filepath.Abs(joined)
	if err != nil {
		return "", err
	}
	// Must equal root or be directly inside root.
	if abs != root && !strings.HasPrefix(abs, root+string(os.PathSeparator)) {
		return "", os.ErrPermission
	}
	return abs, nil
}

// treeEntry is the JSON shape returned by /api/tree.
type treeEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

// handleTree serves GET /api/tree?path=<relpath>
func handleTree(root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		relPath := r.URL.Query().Get("path")

		abs, err := resolveWithinRoot(root, relPath)
		if err != nil {
			http.Error(w, `{"error":"bad path"}`, http.StatusBadRequest)
			return
		}

		entries, err := os.ReadDir(abs)
		if err != nil {
			if os.IsNotExist(err) {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			} else {
				http.Error(w, `{"error":"read error"}`, http.StatusInternalServerError)
			}
			return
		}

		// Split into dirs and files, skip dot-files.
		var dirs, files []treeEntry
		for _, e := range entries {
			name := e.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			entry := treeEntry{
				Name:  name,
				IsDir: e.IsDir(),
				Size:  info.Size(),
			}
			if e.IsDir() {
				dirs = append(dirs, entry)
			} else {
				files = append(files, entry)
			}
		}

		// Both slices are already in directory order (alphabetical from ReadDir),
		// but sort explicitly for safety.
		sort.Slice(dirs, func(i, j int) bool { return dirs[i].Name < dirs[j].Name })
		sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })

		result := append(dirs, files...)
		if result == nil {
			result = []treeEntry{}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	}
}

// handleFile serves GET /api/file?path=<relpath>
func handleFile(root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		relPath := r.URL.Query().Get("path")
		if relPath == "" {
			http.Error(w, `{"error":"path required"}`, http.StatusBadRequest)
			return
		}

		abs, err := resolveWithinRoot(root, relPath)
		if err != nil {
			http.Error(w, `{"error":"bad path"}`, http.StatusBadRequest)
			return
		}

		info, err := os.Stat(abs)
		if err != nil {
			if os.IsNotExist(err) {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			} else {
				http.Error(w, `{"error":"stat error"}`, http.StatusInternalServerError)
			}
			return
		}

		if info.IsDir() {
			http.Error(w, `{"error":"is a directory"}`, http.StatusBadRequest)
			return
		}

		const maxSize = 10 * 1024 * 1024 // 10 MB
		if info.Size() > maxSize {
			http.Error(w, `{"error":"file too large"}`, http.StatusRequestEntityTooLarge)
			return
		}

		f, err := os.Open(abs)
		if err != nil {
			http.Error(w, `{"error":"open error"}`, http.StatusInternalServerError)
			return
		}
		defer f.Close()

		// Read first 512 bytes to detect binary content.
		var sniff [512]byte
		n, _ := f.Read(sniff[:])
		for i := 0; i < n; i++ {
			if sniff[i] == 0 {
				w.Header().Set("Content-Type", "application/json")
				http.Error(w, `{"error":"binary file"}`, http.StatusUnsupportedMediaType)
				return
			}
		}

		// Seek back and serve the full file.
		if _, err := f.Seek(0, 0); err != nil {
			http.Error(w, `{"error":"seek error"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		buf := make([]byte, info.Size())
		total := 0
		for total < len(buf) {
			nn, err := f.Read(buf[total:])
			total += nn
			if err != nil {
				break
			}
		}
		w.Write(buf[:total])
	}
}

// handleFilesStub serves GET /api/files — stubbed for Task 9.
func handleFilesStub() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"not implemented"}`, http.StatusNotImplemented)
	}
}

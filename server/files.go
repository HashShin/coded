package server

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// writeJSONError writes a JSON error response with the correct Content-Type.
// Use this instead of http.Error for JSON API endpoints, because http.Error
// always sets Content-Type to text/plain which breaks frontend res.json() calls.
func writeJSONError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	fmt.Fprintf(w, `{"error":%q}`, msg)
}

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
			writeJSONError(w, "bad path", http.StatusBadRequest)
			return
		}

		entries, err := os.ReadDir(abs)
		if err != nil {
			if os.IsNotExist(err) {
				writeJSONError(w, "not found", http.StatusNotFound)
			} else {
				writeJSONError(w, "read error", http.StatusInternalServerError)
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
		if err := json.NewEncoder(w).Encode(result); err != nil {
			log.Printf("json encode error: %v", err)
		}
	}
}

// handleFile dispatches GET and PUT requests for /api/file?path=<relpath>
func handleFile(root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleFileGet(root, w, r)
		case http.MethodPut:
			handleFilePut(root, w, r)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	}
}

// handleFileGet serves GET /api/file?path=<relpath>
func handleFileGet(root string, w http.ResponseWriter, r *http.Request) {
	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		writeJSONError(w, "path required", http.StatusBadRequest)
		return
	}

	abs, err := resolveWithinRoot(root, relPath)
	if err != nil {
		writeJSONError(w, "bad path", http.StatusBadRequest)
		return
	}

	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSONError(w, "not found", http.StatusNotFound)
		} else {
			writeJSONError(w, "stat error", http.StatusInternalServerError)
		}
		return
	}

	if info.IsDir() {
		writeJSONError(w, "is a directory", http.StatusBadRequest)
		return
	}

	const maxSize = 10 * 1024 * 1024 // 10 MB
	if info.Size() > maxSize {
		writeJSONError(w, "file too large", http.StatusRequestEntityTooLarge)
		return
	}

	f, err := os.Open(abs)
	if err != nil {
		writeJSONError(w, "open error", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	// Read first 512 bytes to detect binary content.
	var sniff [512]byte
	n, readErr := f.Read(sniff[:])
	if readErr != nil && readErr != io.EOF {
		writeJSONError(w, "internal error", http.StatusInternalServerError)
		return
	}
	for i := 0; i < n; i++ {
		if sniff[i] == 0 {
			writeJSONError(w, "binary file", http.StatusUnsupportedMediaType)
			return
		}
	}

	// Seek back and serve the full file.
	if _, err := f.Seek(0, 0); err != nil {
		writeJSONError(w, "seek error", http.StatusInternalServerError)
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

// handleFilePut serves PUT /api/file?path=<relpath>
// It atomically writes the request body to the target file using a temp file
// in the same directory, then os.Rename to swap it in.
func handleFilePut(root string, w http.ResponseWriter, r *http.Request) {
	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		writeJSONError(w, "path required", http.StatusBadRequest)
		return
	}

	abs, err := resolveWithinRoot(root, relPath)
	if err != nil {
		writeJSONError(w, "bad path", http.StatusBadRequest)
		return
	}

	// Check parent directory exists.
	dir := filepath.Dir(abs)
	dirInfo, err := os.Stat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			writeJSONError(w, "parent directory not found", http.StatusNotFound)
		} else {
			writeJSONError(w, "stat error", http.StatusInternalServerError)
		}
		return
	}
	if !dirInfo.IsDir() {
		writeJSONError(w, "parent is not a directory", http.StatusInternalServerError)
		return
	}

	// Check target is not a directory (if it already exists).
	if info, err := os.Stat(abs); err == nil && info.IsDir() {
		writeJSONError(w, "path is a directory", http.StatusForbidden)
		return
	}

	// Read request body.
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, "read body error", http.StatusInternalServerError)
		return
	}

	// Atomic write: write to temp file in same dir, then rename.
	tmp, err := os.CreateTemp(dir, ".webeditor-tmp-*")
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

	if err := os.Rename(tmpPath, abs); err != nil {
		os.Remove(tmpPath)
		writeJSONError(w, "rename error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, `{"ok":true}`)
}

// handleFiles serves GET /api/files.
// It walks the root directory recursively and returns all non-binary file paths
// (relative, forward-slash separated), sorted alphabetically, up to 5000 files.
// Directories named .git, node_modules, or .webeditor are skipped, as are files
// larger than 10 MB and files containing a null byte in the first 512 bytes.
func handleFiles(root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		const maxFiles = 5000
		const maxFileSize = 10 * 1024 * 1024 // 10 MB

		skipDirs := map[string]bool{
			".git":         true,
			"node_modules": true,
			".webeditor":   true,
		}

		var files []string

		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // skip unreadable entries
			}
			if d.IsDir() {
				if skipDirs[d.Name()] {
					return filepath.SkipDir
				}
				return nil
			}
			if len(files) >= maxFiles {
				return filepath.SkipAll
			}

			// Skip large files.
			info, err := d.Info()
			if err != nil || info.Size() > maxFileSize {
				return nil
			}

			// Binary detection: check first 512 bytes for null bytes.
			f, err := os.Open(path)
			if err != nil {
				return nil
			}
			var sniff [512]byte
			n, _ := f.Read(sniff[:])
			f.Close()
			for i := 0; i < n; i++ {
				if sniff[i] == 0 {
					return nil // binary
				}
			}

			relPath, err := filepath.Rel(root, path)
			if err != nil {
				relPath = path
			}
			files = append(files, filepath.ToSlash(relPath))
			return nil
		})
		if err != nil && err != filepath.SkipAll {
			log.Printf("files walk error: %v", err)
		}

		if files == nil {
			files = []string{}
		}
		sort.Strings(files)

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]interface{}{"files": files}); err != nil {
			log.Printf("files json encode error: %v", err)
		}
	}
}

// searchResult is one match returned by /api/search.
type searchResult struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// handleSearch serves GET /api/search?q=<query>&regex=<0|1>&path=<optional subpath>
// It walks the root directory (or an optional sub-path) and returns matching lines.
func handleSearch(root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		q := r.URL.Query().Get("q")
		if q == "" {
			writeJSONError(w, "q required", http.StatusBadRequest)
			return
		}

		isRegex := r.URL.Query().Get("regex") == "1"

		// Compile matcher.
		var re *regexp.Regexp
		if isRegex {
			var err error
			re, err = regexp.Compile(q)
			if err != nil {
				writeJSONError(w, "invalid regex: "+err.Error(), http.StatusBadRequest)
				return
			}
		}

		// Resolve optional sub-path.
		searchRoot := root
		if subPath := r.URL.Query().Get("path"); subPath != "" {
			abs, err := resolveWithinRoot(root, subPath)
			if err != nil {
				writeJSONError(w, "bad path", http.StatusBadRequest)
				return
			}
			searchRoot = abs
		}

		const maxResults = 200
		const maxFileSize = 1 * 1024 * 1024 // 1 MB

		// Directories to skip entirely.
		skipDirs := map[string]bool{
			".git":        true,
			"node_modules": true,
			".webeditor":  true,
		}

		var results []searchResult

		err := filepath.WalkDir(searchRoot, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // skip unreadable entries
			}
			if len(results) >= maxResults {
				return filepath.SkipAll
			}
			if d.IsDir() {
				if skipDirs[d.Name()] {
					return filepath.SkipDir
				}
				return nil
			}

			// Skip large files.
			info, err := d.Info()
			if err != nil || info.Size() > maxFileSize {
				return nil
			}

			// Read file.
			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}

			// Binary detection: check first 512 bytes for null bytes or invalid UTF-8.
			sniffLen := len(data)
			if sniffLen > 512 {
				sniffLen = 512
			}
			sniff := data[:sniffLen]
			for _, b := range sniff {
				if b == 0 {
					return nil // binary
				}
			}
			if !utf8.Valid(data) {
				return nil // not valid UTF-8
			}

			// Compute relative path from root (not searchRoot).
			relPath, err := filepath.Rel(root, path)
			if err != nil {
				relPath = path
			}
			relPath = filepath.ToSlash(relPath)

			// Search line by line.
			lines := strings.Split(string(data), "\n")
			for lineNum, line := range lines {
				if len(results) >= maxResults {
					return filepath.SkipAll
				}
				var matched bool
				if isRegex {
					matched = re.MatchString(line)
				} else {
					matched = strings.Contains(strings.ToLower(line), strings.ToLower(q))
				}
				if matched {
					results = append(results, searchResult{
						File: relPath,
						Line: lineNum + 1,
						Text: line,
					})
				}
			}
			return nil
		})
		if err != nil && err != filepath.SkipAll {
			log.Printf("search walk error: %v", err)
		}

		if results == nil {
			results = []searchResult{}
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]interface{}{"results": results}); err != nil {
			log.Printf("search json encode error: %v", err)
		}
	}
}

package server

import (
	"embed"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
)

// Start serves the editor using an already-open listener.
// root is the working directory for the editor (used by API handlers registered in later tasks).
// assets is an embedded FS rooted at the "static" directory.
// The caller is responsible for printing the listening address after Start returns successfully.
func Start(root, version string, viaPkg bool, port int, ln net.Listener, assets embed.FS) error {
	// root is used by API handlers (registered in later tasks)

	mux := http.NewServeMux()

	// Sub-FS rooted at "static/" so paths like "index.html" work directly.
	staticFS, err := fs.Sub(assets, "static")
	if err != nil {
		return fmt.Errorf("server: failed to create sub-FS: %w", err)
	}
	fileServer := http.FileServer(http.FS(staticFS))

	// API handlers.
	mux.HandleFunc("/api/tree", handleTree(root))
	mux.HandleFunc("/api/file", handleFile(root))
	mux.HandleFunc("/api/raw", handleRaw(root))
	mux.HandleFunc("/api/files", handleFiles(root))
	mux.HandleFunc("/api/session", handleSession(root))
	mux.HandleFunc("/api/search", handleSearch(root))
	mux.HandleFunc("/api/create", handleCreate(root))
	mux.HandleFunc("/api/rename", handleRename(root))
	mux.HandleFunc("/api/delete", handleDelete(root))
	mux.HandleFunc("/api/copy", handleCopy(root))
	mux.HandleFunc("/api/update", handleUpdate(version, viaPkg))
	mux.HandleFunc("/api/update/skip", handleUpdateSkip())
	mux.HandleFunc("/api/update/refresh", handleUpdateRefresh())
	mux.HandleFunc("/api/update/install", handleUpdateInstall(version, viaPkg))
	mux.HandleFunc("/api/update/restart", handleUpdateRestart(port))

	// Live static preview of the editor's working directory.
	// Serves root at /preview/ so relative imports (CSS, JS, images) resolve naturally.
	previewServer := http.FileServer(http.FS(os.DirFS(root)))
	mux.Handle("/preview/", http.StripPrefix("/preview/", previewServer))

	// All other routes: try to serve a static file; fall back to index.html (SPA).
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" {
			path = "index.html"
		} else if len(path) > 0 && path[0] == '/' {
			path = path[1:]
		}

		// Use fs.Stat to check existence without leaking an open file handle.
		if _, err := fs.Stat(staticFS, path); err != nil {
			// File not found — serve index.html for SPA client-side routing.
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			fileServer.ServeHTTP(w, r2)
			return
		}

		fileServer.ServeHTTP(w, r)
	})

	srv := &http.Server{
		Handler: mux,
	}

	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("server: serve: %w", err)
	}
	return nil
}

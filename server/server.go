package server

import (
	"embed"
	"fmt"
	"io/fs"
	"net"
	"net/http"
)

// Start binds an HTTP server to 127.0.0.1:port and begins serving.
// root is the working directory for the editor (reserved for future use).
// assets is an embedded FS rooted at the "static" directory.
func Start(root string, port int, assets embed.FS) {
	mux := http.NewServeMux()

	// Sub-FS rooted at "static/" so paths like "index.html" work directly.
	staticFS, err := fs.Sub(assets, "static")
	if err != nil {
		panic(fmt.Sprintf("server: failed to create sub-FS: %v", err))
	}
	fileServer := http.FileServer(http.FS(staticFS))

	// Placeholder /api/ handler — 501 Not Implemented.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not implemented", http.StatusNotImplemented)
	})

	// All other routes: try to serve a static file; fall back to index.html (SPA).
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" {
			path = "index.html"
		} else if len(path) > 0 && path[0] == '/' {
			path = path[1:]
		}

		_, err := staticFS.Open(path)
		if err != nil {
			// File not found — serve index.html for SPA client-side routing.
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			fileServer.ServeHTTP(w, r2)
			return
		}

		fileServer.ServeHTTP(w, r)
	})

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	srv := &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		panic(fmt.Sprintf("server: listen %s: %v", addr, err))
	}

	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		panic(fmt.Sprintf("server: serve: %v", err))
	}
}

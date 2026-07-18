package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ── Part 1: resolveWithinRoot ────────────────────────────────────────────────

func TestResolveWithinRoot(t *testing.T) {
	root := t.TempDir()
	cases := []struct {
		rel     string
		wantErr bool
	}{
		{"file.go", false},
		{"subdir/file.go", false},
		{"../escape.go", true},
		{"subdir/../../escape.go", true},
		{"/absolute/path", true},
	}
	for _, c := range cases {
		_, err := resolveWithinRoot(root, c.rel)
		if (err != nil) != c.wantErr {
			t.Errorf("resolveWithinRoot(%q) err=%v, wantErr=%v", c.rel, err, c.wantErr)
		}
	}
}

// ── Part 2: GET /api/tree ────────────────────────────────────────────────────

func TestHandleTree(t *testing.T) {
	root := t.TempDir()

	// Create a couple of files and a subdirectory.
	if err := os.WriteFile(filepath.Join(root, "alpha.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "beta.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "subdir"), 0o755); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(handleTree(root))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/tree")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var entries []treeEntry
	if err := json.NewDecoder(resp.Body).Decode(&entries); err != nil {
		t.Fatalf("decode error: %v", err)
	}

	names := make(map[string]bool)
	for _, e := range entries {
		names[e.Name] = true
	}
	for _, want := range []string{"alpha.go", "beta.txt", "subdir"} {
		if !names[want] {
			t.Errorf("expected %q in tree response, got entries: %v", want, entries)
		}
	}
}

// ── Part 3: GET /api/file ────────────────────────────────────────────────────

func TestHandleFileGet(t *testing.T) {
	root := t.TempDir()
	content := "package main\n\nfunc main() {}\n"
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(handleFile(root))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/file?path=main.go")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != content {
		t.Errorf("body mismatch: got %q, want %q", string(body), content)
	}
}

// ── Part 4: PUT /api/file ────────────────────────────────────────────────────

func TestHandleFilePut(t *testing.T) {
	root := t.TempDir()
	newContent := "package main\n\nfunc hello() {}\n"

	srv := httptest.NewServer(handleFile(root))
	defer srv.Close()

	req, err := http.NewRequest(http.MethodPut, srv.URL+"/api/file?path=newfile.go", strings.NewReader(newContent))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, body)
	}

	// Verify the file exists on disk with the correct content.
	got, err := os.ReadFile(filepath.Join(root, "newfile.go"))
	if err != nil {
		t.Fatalf("file not on disk: %v", err)
	}
	if string(got) != newContent {
		t.Errorf("disk content mismatch: got %q, want %q", string(got), newContent)
	}
}

// ── Part 5: GET /api/file with traversal ────────────────────────────────────

func TestHandleFileGetTraversal(t *testing.T) {
	root := t.TempDir()

	srv := httptest.NewServer(handleFile(root))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/file?path=../etc/hosts")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400 for traversal path, got %d", resp.StatusCode)
	}
}

// ── Part 6: POST /api/create ─────────────────────────────────────────────────

func postJSON(t *testing.T, url, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestHandleCreate(t *testing.T) {
	root := t.TempDir()
	srv := httptest.NewServer(handleCreate(root))
	defer srv.Close()

	// Create a file.
	resp := postJSON(t, srv.URL+"/api/create", `{"path":"new.txt","isDir":false}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create file: expected 200, got %d", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(root, "new.txt")); err != nil {
		t.Fatalf("file not created: %v", err)
	}

	// Create a directory.
	resp = postJSON(t, srv.URL+"/api/create", `{"path":"newdir","isDir":true}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create dir: expected 200, got %d", resp.StatusCode)
	}
	if info, err := os.Stat(filepath.Join(root, "newdir")); err != nil || !info.IsDir() {
		t.Fatalf("dir not created: %v", err)
	}

	// Duplicate → 409.
	resp = postJSON(t, srv.URL+"/api/create", `{"path":"new.txt","isDir":false}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("duplicate create: expected 409, got %d", resp.StatusCode)
	}

	// Path traversal → 400.
	resp = postJSON(t, srv.URL+"/api/create", `{"path":"../escape.txt","isDir":false}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("traversal create: expected 400, got %d", resp.StatusCode)
	}
}

// ── Part 7: POST /api/rename ─────────────────────────────────────────────────

func TestHandleRename(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "old.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(handleRename(root))
	defer srv.Close()

	// Rename file.
	resp := postJSON(t, srv.URL+"/api/rename", `{"from":"old.txt","to":"new.txt"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("rename: expected 200, got %d", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(root, "new.txt")); err != nil {
		t.Fatalf("renamed file not found: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "old.txt")); err == nil {
		t.Fatal("old file still exists after rename")
	}

	// Source not found → 404.
	resp = postJSON(t, srv.URL+"/api/rename", `{"from":"missing.txt","to":"other.txt"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("missing source: expected 404, got %d", resp.StatusCode)
	}

	// Destination exists → 409.
	if err := os.WriteFile(filepath.Join(root, "exists.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	resp = postJSON(t, srv.URL+"/api/rename", `{"from":"new.txt","to":"exists.txt"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("dest exists: expected 409, got %d", resp.StatusCode)
	}

	// Path traversal → 400.
	resp = postJSON(t, srv.URL+"/api/rename", `{"from":"new.txt","to":"../escape.txt"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("traversal rename: expected 400, got %d", resp.StatusCode)
	}
}

// ── Part 8: POST /api/delete ─────────────────────────────────────────────────

func TestHandleDelete(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "del.txt"), []byte("bye"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "subdir", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "subdir", "nested", "f.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(handleDelete(root))
	defer srv.Close()

	// Delete a file.
	resp := postJSON(t, srv.URL+"/api/delete", `{"path":"del.txt"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete file: expected 200, got %d", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(root, "del.txt")); err == nil {
		t.Fatal("file still exists after delete")
	}

	// Delete a directory recursively.
	resp = postJSON(t, srv.URL+"/api/delete", `{"path":"subdir"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete dir: expected 200, got %d", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(root, "subdir")); err == nil {
		t.Fatal("dir still exists after delete")
	}

	// Not found → 404.
	resp = postJSON(t, srv.URL+"/api/delete", `{"path":"missing.txt"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("missing delete: expected 404, got %d", resp.StatusCode)
	}

	// Path traversal → 400.
	resp = postJSON(t, srv.URL+"/api/delete", `{"path":"../escape"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("traversal delete: expected 400, got %d", resp.StatusCode)
	}
}

// ── Part 9: GET /api/search ──────────────────────────────────────────────────

func TestHandleSearch(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "code.go"), []byte("package main\n\n// helloworld marker\nfunc main() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(handleSearch(root))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/search?q=helloworld")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var result struct {
		Results []searchResult `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("decode error: %v", err)
	}

	if len(result.Results) == 0 {
		t.Fatal("expected at least one search result, got none")
	}
	found := false
	for _, r := range result.Results {
		if strings.Contains(r.Text, "helloworld") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected a result containing 'helloworld', got: %v", result.Results)
	}
}

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

// ── Part 6: GET /api/search ──────────────────────────────────────────────────

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

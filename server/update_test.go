package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// isolateCache points os.UserConfigDir at a temp dir so tests don't touch the
// real ~/.config/coded/update.json, and resets the package cache mutex state.
func isolateCache(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	// os.UserConfigDir uses XDG_CONFIG_HOME on Linux, HOME on darwin.
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("HOME", dir)
	t.Setenv("AppData", dir) // windows
}

// mockGitHub swaps githubLatestURL for a test server returning the given tag.
func mockGitHub(t *testing.T, tag string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tag_name":"` + tag + `"}`))
	}))
	t.Cleanup(srv.Close)
	orig := githubLatestURL
	githubLatestURL = srv.URL
	t.Cleanup(func() { githubLatestURL = orig })
}

func TestCheckForUpdate_Available(t *testing.T) {
	isolateCache(t)
	mockGitHub(t, "v0.2.0")

	info := CheckForUpdate("0.1.0", false)
	if !info.Available {
		t.Fatalf("expected update available, got %+v", info)
	}
	if info.Latest != "0.2.0" || info.Current != "0.1.0" {
		t.Fatalf("unexpected versions: %+v", info)
	}
}

func TestCheckForUpdate_UpToDate(t *testing.T) {
	isolateCache(t)
	mockGitHub(t, "v0.2.0")

	info := CheckForUpdate("0.2.0", false)
	if info.Available {
		t.Fatalf("expected no update when current == latest, got %+v", info)
	}
}

func TestCheckForUpdate_DevSkips(t *testing.T) {
	isolateCache(t)
	mockGitHub(t, "v9.9.9")

	info := CheckForUpdate("dev", false)
	if info.Available {
		t.Fatalf("expected dev build to skip update check, got %+v", info)
	}
}

func TestCheckForUpdate_Skipped(t *testing.T) {
	isolateCache(t)
	mockGitHub(t, "v0.2.0")

	SkipVersion("0.2.0")
	info := CheckForUpdate("0.1.0", false)
	if info.Available {
		t.Fatalf("expected skipped version to suppress notice, got %+v", info)
	}
}

func TestCheckForUpdate_CacheHitAvoidsFetch(t *testing.T) {
	isolateCache(t)

	// Pre-seed a fresh cache; point URL at a server that would fail the test if hit.
	saveCache(updateCache{LastChecked: time.Now(), LatestVersion: "0.5.0"})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("network should not be hit within cache interval")
	}))
	t.Cleanup(srv.Close)
	orig := githubLatestURL
	githubLatestURL = srv.URL
	t.Cleanup(func() { githubLatestURL = orig })

	info := CheckForUpdate("0.1.0", false)
	if !info.Available || info.Latest != "0.5.0" {
		t.Fatalf("expected cached latest 0.5.0 available, got %+v", info)
	}
}

func TestCheckForUpdate_OfflineFallsBackToCache(t *testing.T) {
	isolateCache(t)

	// Stale cache forces a fetch; point at a closed server so the fetch fails.
	saveCache(updateCache{LastChecked: time.Now().Add(-48 * time.Hour), LatestVersion: "0.3.0"})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // now unreachable
	orig := githubLatestURL
	githubLatestURL = url
	t.Cleanup(func() { githubLatestURL = orig })

	info := CheckForUpdate("0.1.0", false)
	// Fetch fails; falls back to stale cached 0.3.0 which is still > current.
	if !info.Available || info.Latest != "0.3.0" {
		t.Fatalf("expected fallback to cached 0.3.0, got %+v", info)
	}
}

func TestUpdateInfo_ViaPkgPassedThrough(t *testing.T) {
	isolateCache(t)
	mockGitHub(t, "v0.2.0")

	info := CheckForUpdate("0.1.0", true)
	if !info.ViaPkg {
		t.Fatalf("expected ViaPkg true, got %+v", info)
	}
}

func TestAssetName(t *testing.T) {
	name := assetName("0.1.3")
	if !strings.HasPrefix(name, "coded_0.1.3_") {
		t.Fatalf("unexpected asset name: %s", name)
	}
	// Must have exactly 3 underscore-separated parts after "coded"
	parts := strings.Split(name, "_")
	if len(parts) != 4 {
		t.Fatalf("expected 4 parts in asset name, got %d: %s", len(parts), name)
	}
}

func TestAssetURL(t *testing.T) {
	orig := githubDownloadBase
	githubDownloadBase = "https://example.com/releases"
	t.Cleanup(func() { githubDownloadBase = orig })

	url := assetURL("0.1.3")
	if !strings.HasPrefix(url, "https://example.com/releases/v0.1.3/coded_0.1.3_") {
		t.Fatalf("unexpected asset URL: %s", url)
	}
}

// mockDownloadServer returns a test server that serves fakeContent as a binary download,
// and patches githubDownloadBase to point at it for the duration of the test.
func mockDownloadServer(t *testing.T, fakeContent []byte) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", string(rune(len(fakeContent))))
		w.WriteHeader(http.StatusOK)
		w.Write(fakeContent)
	}))
	t.Cleanup(srv.Close)
	orig := githubDownloadBase
	// The handler above serves all paths, so any URL under srv.URL works.
	// assetURL builds: base + "/v" + version + "/" + name
	// We strip the path portion by pointing base at srv.URL directly.
	githubDownloadBase = srv.URL
	t.Cleanup(func() { githubDownloadBase = orig })
}

func TestDownloadAndInstall(t *testing.T) {
	// Create a fake "exe" in a temp dir that DownloadAndInstall will replace.
	dir := t.TempDir()
	exePath := filepath.Join(dir, "coded")
	if err := os.WriteFile(exePath, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}

	fakeContent := bytes.Repeat([]byte{0xCA, 0xFE}, 512) // 1KB fake binary

	// Serve the fake content with correct Content-Length.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeContent(w, r, "coded", time.Time{}, bytes.NewReader(fakeContent))
	}))
	t.Cleanup(srv.Close)

	orig := githubDownloadBase
	githubDownloadBase = srv.URL
	t.Cleanup(func() { githubDownloadBase = orig })

	// Override the exe path resolution by using downloadAndInstallTo (internal helper).
	// Since we can't redirect os.Executable(), use the exported wrapper with a target override.
	// Instead call the internal logic directly via downloadTo.
	var progressCalls int
	err := downloadAndInstallTo(exePath, "0.1.3", func(dl, total int64) {
		progressCalls++
	})
	if err != nil {
		t.Fatalf("DownloadAndInstall failed: %v", err)
	}

	got, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatalf("read replaced exe: %v", err)
	}
	if !bytes.Equal(got, fakeContent) {
		t.Fatalf("replaced content mismatch: got %d bytes, want %d", len(got), len(fakeContent))
	}
	if progressCalls == 0 {
		t.Fatal("expected at least one progress callback")
	}
}

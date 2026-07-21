package server

import (
	"net/http"
	"net/http/httptest"
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

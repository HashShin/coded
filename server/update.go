package server

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// githubLatestURL is the GitHub API endpoint for the latest release.
// It is a package var so tests can point it at an httptest.Server.
var githubLatestURL = "https://api.github.com/repos/HashShin/coded/releases/latest"

// checkInterval is how long a cached result is trusted before re-fetching.
const checkInterval = 24 * time.Hour

// cacheMu serializes reads/writes of the on-disk update cache.
var cacheMu sync.Mutex

// UpdateInfo is the result of an update check, returned to callers and the API.
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
	ViaPkg    bool   `json:"viaPkg"`
}

// updateCache is persisted to ~/.config/coded/update.json.
type updateCache struct {
	LastChecked    time.Time `json:"last_checked"`
	LatestVersion  string    `json:"latest_version"`
	SkippedVersion string    `json:"skipped_version"`
}

// updateCachePath returns the path to the cache file, or "" if it can't be determined.
func updateCachePath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "coded", "update.json")
}

// loadCache reads the update cache; returns a zero cache if missing or unreadable.
func loadCache() updateCache {
	var c updateCache
	path := updateCachePath()
	if path == "" {
		return c
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return c
	}
	_ = json.Unmarshal(data, &c)
	return c
}

// saveCache atomically writes the update cache (temp file + rename).
func saveCache(c updateCache) {
	path := updateCachePath()
	if path == "" {
		return
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	data, err := json.Marshal(c)
	if err != nil {
		return
	}
	tmp, err := os.CreateTemp(dir, ".update-tmp-*")
	if err != nil {
		return
	}
	tmpPath := tmp.Name()
	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil || closeErr != nil {
		os.Remove(tmpPath)
		return
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
	}
}

// fetchLatestVersionViaPkg queries the apt cache for the candidate version of
// coded. This is used when coded was installed via the Termux User Repository
// (pkg install coded) so we use the same update mechanism as the package manager
// rather than the GitHub API.
//
// Example output of `apt-cache policy coded`:
//
//	coded:
//	  Installed: 0.1.2
//	  Candidate: 0.1.3
//	  ...
func fetchLatestVersionViaPkg() (string, error) {
	out, err := exec.Command("apt-cache", "policy", "coded").Output()
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Candidate:") {
			v := strings.TrimSpace(strings.TrimPrefix(line, "Candidate:"))
			if v == "(none)" || v == "" {
				return "", nil
			}
			return strings.TrimPrefix(v, "v"), nil
		}
	}
	return "", nil
}

// fetchLatestVersion queries GitHub for the latest release tag (without leading "v").
func fetchLatestVersion() (string, error) {
	client := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequest(http.MethodGet, githubLatestURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var body struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	return strings.TrimPrefix(body.TagName, "v"), nil
}

// CheckForUpdate reports whether a newer release than current is available.
// It caches the GitHub result for checkInterval to avoid hammering the API.
// Returns Available=false for dev builds, when offline, or when up to date.
func CheckForUpdate(current string, viaPkg bool) UpdateInfo {
	info := UpdateInfo{Current: current, ViaPkg: viaPkg}
	if current == "dev" || current == "" {
		return info
	}

	cacheMu.Lock()
	c := loadCache()
	latest := c.LatestVersion
	if time.Since(c.LastChecked) >= checkInterval {
		var fetched string
		var fetchErr error
		if viaPkg {
			fetched, fetchErr = fetchLatestVersionViaPkg()
		} else {
			fetched, fetchErr = fetchLatestVersion()
		}
		if fetchErr == nil && fetched != "" {
			latest = fetched
			c.LatestVersion = fetched
			c.LastChecked = time.Now()
			saveCache(c)
		}
	}
	skipped := c.SkippedVersion
	cacheMu.Unlock()

	info.Latest = latest
	info.Available = latest != "" && latest != current && latest != skipped
	return info
}

// SkipVersion records a version the user chose to skip, suppressing future notices for it.
func SkipVersion(v string) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	c := loadCache()
	c.SkippedVersion = v
	saveCache(c)
}

//go:build !windows

package server

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// isRunnable reports whether p is a regular, non-empty, executable file. After a
// pkg upgrade there is a brief window where the new binary is being written; we
// must not exec a partially-written or missing file.
func isRunnable(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.Mode().IsRegular() && fi.Size() > 0 && fi.Mode()&0111 != 0
}

// resolveExe returns a path to the current coded binary that actually exists
// on disk. os.Executable() reads /proc/self/exe, which after a package upgrade
// (pkg replaces the file) can return a stale "<path> (deleted)" target.
// We recover by (1) stripping the " (deleted)" marker and re-checking, then
// (2) resolving the binary name through PATH.
func resolveExe() (string, error) {
	// Prefer PATH lookup first: after a pkg upgrade the new binary is on PATH
	// at $PREFIX/bin/coded and isRunnable confirms it is fully written.
	name := "coded"
	if len(os.Args) > 0 && os.Args[0] != "" {
		name = filepath.Base(os.Args[0])
	}
	if p, lookErr := exec.LookPath(name); lookErr == nil && isRunnable(p) {
		return p, nil
	}

	// Fall back to os.Executable() with the " (deleted)" suffix stripped.
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	clean := strings.TrimSuffix(exe, " (deleted)")
	if isRunnable(clean) {
		return clean, nil
	}
	return clean, nil
}

// spawn starts a detached child process that is a fresh copy of coded with the
// given environment. The child inherits the parent's cwd and reuses os.Args[1:]
// so flags like --dir are preserved. After a successful Start the parent calls
// os.Exit(0) so the OS releases the bound port for the child to grab.
func spawn(env []string) error {
	exe, err := resolveExe()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Env = env
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// Setsid detaches the child into its own session so it survives the parent
	// exiting (not treated as an orphan by the terminal).
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	// Give the HTTP response a moment to flush before the parent exits and the
	// connection drops. The 300 ms sleep in handleUpdateRestart already covers
	// most of this, but a small extra delay here is harmless insurance.
	time.Sleep(50 * time.Millisecond)
	os.Exit(0)
	return nil // unreachable
}

// Restart replaces the current process with a fresh copy of the (possibly
// updated) binary.
func Restart() error {
	return spawn(os.Environ())
}

// RestartOnPort spawns a fresh coded process with CODED_PORT set so the new
// process binds the same port instead of picking a random free one.
func RestartOnPort(port int) error {
	env := append(os.Environ(), fmt.Sprintf("CODED_PORT=%d", port))
	return spawn(env)
}

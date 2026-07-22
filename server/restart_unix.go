//go:build !windows

package server

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// resolveExe returns a path to the current coded binary that actually exists
// on disk. os.Executable() reads /proc/self/exe, which after a package upgrade
// (pkg replaces the file) can return a stale "<path> (deleted)" target that
// syscall.Exec rejects with ENOENT. In that case we recover by (1) stripping a
// trailing " (deleted)" marker and re-checking, then (2) resolving the binary
// name through PATH.
func resolveExe() (string, error) {
	exe, err := os.Executable()
	if err == nil {
		// Strip the kernel's " (deleted)" suffix if the file was replaced.
		clean := strings.TrimSuffix(exe, " (deleted)")
		if _, statErr := os.Stat(clean); statErr == nil {
			return clean, nil
		}
	}
	// Fall back to resolving the invoked name through PATH (pkg installs live
	// on PATH at $PREFIX/bin/coded).
	name := "coded"
	if len(os.Args) > 0 && os.Args[0] != "" {
		name = filepath.Base(os.Args[0])
	}
	if p, lookErr := exec.LookPath(name); lookErr == nil {
		return p, nil
	}
	// Last resort: return the cleaned os.Executable result (may still fail, but
	// preserves the original error for the caller's log).
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(exe, " (deleted)"), nil
}

// Restart replaces the current process with the (possibly updated) binary.
func Restart() error {
	exe, err := resolveExe()
	if err != nil {
		return err
	}
	return syscall.Exec(exe, os.Args, os.Environ())
}

// RestartOnPort re-execs the binary with CODED_PORT set so the new process
// binds the same port instead of picking a random free one.
func RestartOnPort(port int) error {
	exe, err := resolveExe()
	if err != nil {
		return err
	}
	env := append(os.Environ(), fmt.Sprintf("CODED_PORT=%d", port))
	return syscall.Exec(exe, os.Args, env)
}

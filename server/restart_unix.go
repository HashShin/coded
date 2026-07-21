//go:build !windows

package server

import (
	"fmt"
	"os"
	"syscall"
)

// Restart replaces the current process with the (possibly updated) binary at os.Executable.
func Restart() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return syscall.Exec(exe, os.Args, os.Environ())
}

// RestartOnPort re-execs the binary with CODED_PORT set so the new process
// binds the same port instead of picking a random free one.
func RestartOnPort(port int) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	env := append(os.Environ(), fmt.Sprintf("CODED_PORT=%d", port))
	return syscall.Exec(exe, os.Args, env)
}

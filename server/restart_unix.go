//go:build !windows

package server

import (
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

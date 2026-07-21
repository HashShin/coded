//go:build windows

package server

import "errors"

// Restart is not supported on Windows; the user must restart coded manually.
func Restart() error {
	return errors.New("restart not supported on Windows; please restart coded manually")
}

// RestartOnPort is not supported on Windows.
func RestartOnPort(_ int) error {
	return errors.New("restart not supported on Windows; please restart coded manually")
}

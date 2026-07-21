//go:build android

package main

import "os"

func init() {
	// On Android/Termux the pure-Go DNS resolver must be forced explicitly.
	// /etc/resolv.conf does not exist on Android; without this the resolver
	// falls back to [::1]:53 which fails. GOOS=android cross-compiled binaries
	// are always CGO_ENABLED=0 so netdns=cgo is not available.
	if os.Getenv("GODEBUG") == "" {
		os.Setenv("GODEBUG", "netdns=go")
	}
}

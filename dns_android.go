//go:build android

package main

import (
	"bufio"
	"context"
	"net"
	"os"
	"strings"
	"time"
)

// nameservers returns DNS servers to use, preferring Termux's $PREFIX/etc/resolv.conf,
// then falling back to well-known public resolvers.
// Upstream Go built with GOOS=android+CGO_ENABLED=0 cannot find nameservers on Android
// because /system/etc/resolv.conf does not exist and it has no knowledge of Termux's
// $PREFIX/etc/resolv.conf, so it falls back to [::1]:53 which always fails.
func nameservers() []string {
	var servers []string
	var paths []string
	if p := os.Getenv("PREFIX"); p != "" {
		paths = append(paths, p+"/etc/resolv.conf")
	}
	paths = append(paths, "/etc/resolv.conf")
	for _, path := range paths {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if strings.HasPrefix(line, "nameserver") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					servers = append(servers, net.JoinHostPort(fields[1], "53"))
				}
			}
		}
		f.Close()
		if len(servers) > 0 {
			break
		}
	}
	// Public fallbacks so the binary works even with no resolv.conf at all.
	for _, s := range []string{"1.1.1.1:53", "8.8.8.8:53"} {
		found := false
		for _, existing := range servers {
			if existing == s {
				found = true
				break
			}
		}
		if !found {
			servers = append(servers, s)
		}
	}
	return servers
}

func init() {
	servers := nameservers()
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			d := net.Dialer{Timeout: 5 * time.Second}
			var lastErr error
			for _, s := range servers {
				// Ignore the address Go computed (may be [::1]:53); dial our servers.
				conn, err := d.DialContext(ctx, "udp", s)
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
	}
}

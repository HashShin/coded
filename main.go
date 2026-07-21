package main

import (
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/HashShin/coded/server"
)

// version is set at build time via -ldflags "-X main.version=...".
var version = "dev"

const (
	installShURL  = "https://raw.githubusercontent.com/HashShin/coded/main/install.sh"
	installPS1URL = "https://raw.githubusercontent.com/HashShin/coded/main/install.ps1"
)

// installedViaPkg reports whether the running binary lives inside the Termux
// package prefix (i.e. it was installed with `pkg install coded` via the TUR).
// Self-updating such an install would create a shadow copy in ~/.local/bin that
// drifts from the package manager, so we defer to `pkg` instead.
func installedViaPkg() bool {
	prefix := os.Getenv("PREFIX")
	if prefix == "" {
		return false
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	binDir := filepath.Join(prefix, "bin")
	return strings.HasPrefix(exe, binDir+string(os.PathSeparator)) || filepath.Dir(exe) == binDir
}

// runUninstall removes the coded binary from disk.
// For pkg-managed installs it defers to `pkg remove coded`.
func runUninstall() int {
	if installedViaPkg() {
		cmd := exec.Command("pkg", "remove", "coded")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Stdin = os.Stdin
		if err := cmd.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "error: pkg remove failed: %v\n", err)
			return 1
		}
		return 0
	}

	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: could not locate coded binary: %v\n", err)
		return 1
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	fmt.Printf("Removing %s ...\n", exe)
	if err := os.Remove(exe); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	fmt.Println("coded has been uninstalled.")
	return 0
}

// runUpdate re-runs the install script for the current platform. It passes the
// current version so the script can skip the download if already up to date.
func runUpdate() int {
	if installedViaPkg() {
		fmt.Println("coded was installed via pkg. Update it with:")
		fmt.Println("  pkg upgrade coded")
		return 0
	}

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("powershell", "-Command", "irm "+installPS1URL+" | iex")
	} else {
		cmd = exec.Command("sh", "-c", "curl -fsSL "+installShURL+" | sh")
	}
	cmd.Env = append(os.Environ(), "CODED_CURRENT_VERSION="+version)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "error: update failed: %v\n", err)
		return 1
	}
	return 0
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "android": // Termux
		cmd = exec.Command("termux-open-url", url)
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default: // linux
		// Termux on Android reports GOOS=linux but has a restricted kernel.
		// Detect Termux via environment variable to avoid faccessat2 crash.
		if os.Getenv("TERMUX_VERSION") != "" || os.Getenv("PREFIX") == "/data/data/com.termux/files/usr" {
			cmd = exec.Command("termux-open-url", url)
		} else {
			cmd = exec.Command("xdg-open", url)
		}
	}
	// Fire and forget — if it fails the user still has the printed URL.
	_ = cmd.Start()
}

func main() {
	// Positional subcommands (not flags).
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "update", "upgrade":
			os.Exit(runUpdate())
		case "uninstall", "remove":
			os.Exit(runUninstall())
		case "version":
			if !installedViaPkg() {
				fmt.Printf("coded %s\n", version)
			}
			return
		}
	}

	portFlag := flag.Int("port", 0, "port to listen on (0 = find a free port)")
	dirFlag := flag.String("dir", "", "root directory to serve (default: current directory)")
	versionFlag := flag.Bool("version", false, "print version and exit")
	vFlag := flag.Bool("v", false, "print version and exit (shorthand)")
	flag.Parse()

	if *versionFlag || *vFlag {
		// Suppress version output for pkg-managed installs: the version embedded
		// at build time may be stale (TUR hasn't landed the ldflag PR yet), and
		// pkg users can check the installed version with `pkg show coded`.
		if !installedViaPkg() {
			fmt.Printf("coded %s\n", version)
		}
		return
	}

	root := *dirFlag
	if root == "" {
		var err error
		root, err = os.Getwd()
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: could not get working directory: %v\n", err)
			os.Exit(1)
		}
	} else {
		var err error
		root, err = filepath.Abs(root)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: could not resolve directory: %v\n", err)
			os.Exit(1)
		}
	}

	// On restart via /api/update/restart the server re-execs itself and passes
	// CODED_PORT so the new process binds the same port.
	if envPort := os.Getenv("CODED_PORT"); envPort != "" && *portFlag == 0 {
		var p int
		if _, err := fmt.Sscanf(envPort, "%d", &p); err == nil && p > 0 {
			*portFlag = p
		}
	}
	addr := fmt.Sprintf("127.0.0.1:%d", *portFlag)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: could not bind port: %v\n", err)
		os.Exit(1)
	}

	// Print the URL only after the listener is successfully bound.
	port := ln.Addr().(*net.TCPAddr).Port
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	fmt.Printf("Listening on %s\n", url)

	viaPkg := installedViaPkg()
	if info := server.CheckForUpdate(version, viaPkg); info.Available {
		fmt.Printf("\n  coded %s is available (you have %s).\n", info.Latest, info.Current)
		if info.ViaPkg {
			fmt.Print("  Update with: pkg upgrade coded\n\n")
		} else {
			fmt.Print("  Update with: coded update\n\n")
		}
	}

	openBrowser(url)

	if err := server.Start(root, version, viaPkg, port, ln, staticFiles); err != nil {
		fmt.Fprintf(os.Stderr, "error: server exited: %v\n", err)
		os.Exit(1)
	}
}

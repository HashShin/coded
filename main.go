package main

import (
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/HashShin/coded/server"
)

// version is set at build time via -ldflags "-X main.version=...".
var version = "dev"

const (
	installShURL  = "https://raw.githubusercontent.com/HashShin/coded/main/install.sh"
	installPS1URL = "https://raw.githubusercontent.com/HashShin/coded/main/install.ps1"
)

// runUpdate re-runs the install script for the current platform. It passes the
// current version so the script can skip the download if already up to date.
func runUpdate() int {
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
		case "version":
			fmt.Printf("coded %s\n", version)
			return
		}
	}

	portFlag := flag.Int("port", 0, "port to listen on (0 = find a free port)")
	dirFlag := flag.String("dir", "", "root directory to serve (default: current directory)")
	versionFlag := flag.Bool("version", false, "print version and exit")
	vFlag := flag.Bool("v", false, "print version and exit (shorthand)")
	flag.Parse()

	if *versionFlag || *vFlag {
		fmt.Printf("coded %s\n", version)
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
	openBrowser(url)

	if err := server.Start(root, ln, staticFiles); err != nil {
		fmt.Fprintf(os.Stderr, "error: server exited: %v\n", err)
		os.Exit(1)
	}
}

package main

import (
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"webeditor/server"
)

func main() {
	portFlag := flag.Int("port", 0, "port to listen on (0 = find a free port)")
	dirFlag := flag.String("dir", "", "root directory to serve (default: current directory)")
	flag.Parse()

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
	fmt.Printf("Listening on http://127.0.0.1:%d\n", port)

	if err := server.Start(root, ln, staticFiles); err != nil {
		fmt.Fprintf(os.Stderr, "error: server exited: %v\n", err)
		os.Exit(1)
	}
}

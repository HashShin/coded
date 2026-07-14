package main

import (
	"flag"
	"fmt"
	"net"
	"os"

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
	}

	port := *portFlag
	if port == 0 {
		p, err := findFreePort()
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: could not find a free port: %v\n", err)
			os.Exit(1)
		}
		port = p
	}

	fmt.Printf("Listening on http://127.0.0.1:%d\n", port)
	server.Start(root, port, staticFiles)
}

// findFreePort asks the OS for an available TCP port on 127.0.0.1.
func findFreePort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port, nil
}

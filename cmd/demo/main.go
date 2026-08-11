package main

import (
	"log"
	"net/http"
	"os"

	"github.com/liumingjian/wps-plugin/demo"
)

func main() {
	address := os.Getenv("DEMO_ADDR")
	if address == "" {
		address = "127.0.0.1:4317"
	}
	log.Fatal(http.ListenAndServe(address, demo.Handler()))
}

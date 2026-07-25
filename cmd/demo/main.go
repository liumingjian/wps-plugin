package main

import (
	"log"
	"net/http"

	"github.com/liumingjian/wps-plugin/demo"
)

func main() {
	log.Fatal(http.ListenAndServe("127.0.0.1:4317", demo.Handler()))
}

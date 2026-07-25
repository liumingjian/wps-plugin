package main

import (
	"io/fs"
	"log"
	"net/http"

	"github.com/liumingjian/wps-plugin/demo"
)

func main() {
	assets, err := fs.Sub(demo.Static, "static")
	if err != nil {
		log.Fatal(err)
	}
	http.Handle("/", http.FileServer(http.FS(assets)))
	log.Fatal(http.ListenAndServe("127.0.0.1:4317", nil))
}

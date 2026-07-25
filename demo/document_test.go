package demo_test

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/liumingjian/wps-plugin/demo"
)

func TestDocumentContentEndpointServesValidDOCXAndRejectsUnknownDocument(t *testing.T) {
	server := httptest.NewServer(demo.Handler())
	defer server.Close()

	response, err := http.Get(server.URL + "/documents/doc-001/content")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.StatusCode, body)
	}
	if response.Header.Get("Content-Type") != "application/vnd.openxmlformats-officedocument.wordprocessingml.document" {
		t.Fatalf("content type = %q", response.Header.Get("Content-Type"))
	}
	reader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("fixture is not a DOCX zip: %v", err)
	}
	foundDocument := false
	for _, file := range reader.File {
		foundDocument = foundDocument || file.Name == "word/document.xml"
	}
	if !foundDocument {
		t.Fatal("fixture lacks word/document.xml")
	}

	response, err = http.Get(server.URL + "/documents/unknown/content")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown document status = %d, want 404", response.StatusCode)
	}
}

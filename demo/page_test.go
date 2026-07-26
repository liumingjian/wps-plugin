package demo_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liumingjian/wps-plugin/demo"
)

func TestDemoPageShowsCurrentDocumentWithOneEditAction(t *testing.T) {
	server := httptest.NewServer(demo.Handler())
	defer server.Close()

	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	page := string(body)
	for _, required := range []string{`data-document-id="doc-001"`, `class="edit-entry"`, `id="document-preview"`, `id="document-version"`, `role="status"`, `app.js`} {
		if !strings.Contains(page, required) {
			t.Errorf("page missing %q", required)
		}
	}
	for _, removed := range []string{"Document Link", "Latest submitted result", `/submissions/latest`} {
		if strings.Contains(page, removed) {
			t.Errorf("page still contains %q", removed)
		}
	}
	if count := strings.Count(page, "<button"); count != 1 {
		t.Errorf("button count = %d, want 1", count)
	}
}

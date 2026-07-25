package demo_test

import (
	"io"
	"net/http"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestDemoPageExposesDistinctEditEntryAndStateRegion(t *testing.T) {
	cmd := exec.Command("go", "run", "../cmd/demo")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	var response *http.Response
	var err error
	for range 30 {
		response, err = http.Get("http://127.0.0.1:4317/")
		if err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	page := string(body)
	for _, required := range []string{`data-document-id="doc-001"`, `class="edit-entry"`, `Document Link`, `role="status"`, `app.js`, `Latest submitted result`} {
		if !strings.Contains(page, required) {
			t.Errorf("page missing %q", required)
		}
	}
}

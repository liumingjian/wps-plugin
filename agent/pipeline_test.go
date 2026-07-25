package agent_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/liumingjian/wps-plugin/agent"
)

type recordingLauncher struct {
	path string
}

func (l *recordingLauncher) Open(_ context.Context, path string) error {
	l.path = path
	return nil
}

func TestEditingTaskDownloadsWorkCopyRecordsBaselineAndLaunches(t *testing.T) {
	document := []byte("real fixture document bytes")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/documents/doc-001/content" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
		_, _ = w.Write(document)
	}))
	defer server.Close()

	launcher := new(recordingLauncher)
	var statuses []agent.Status
	result, err := agent.RunTask(context.Background(), agent.TaskStart{
		Version: 1, TaskID: "task-001", DocumentID: "doc-001",
		DownloadURL: server.URL + "/documents/doc-001/content",
		UploadURL:   server.URL + "/tasks/task-001/submissions",
	}, t.TempDir(), launcher, func(status agent.Status) { statuses = append(statuses, status) })
	if err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(result.WorkCopyPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, document) {
		t.Fatalf("work copy = %q, want %q", got, document)
	}
	wantBaseline := fmt.Sprintf("%x", sha256.Sum256(document))
	if result.BaselineSHA256 != wantBaseline {
		t.Fatalf("baseline = %q, want %q", result.BaselineSHA256, wantBaseline)
	}
	if launcher.path != result.WorkCopyPath || !filepath.IsAbs(launcher.path) {
		t.Fatalf("launch path = %q, work copy = %q", launcher.path, result.WorkCopyPath)
	}
	wantStages := []string{"download", "work-copy", "baseline", "launch", "observing"}
	var gotStages []string
	for _, status := range statuses {
		if status.TaskID != "task-001" || status.DocumentID != "doc-001" {
			t.Fatalf("uncorrelated status: %+v", status)
		}
		if status.Kind == "persisted-version" || status.Kind == "submission" {
			t.Fatalf("baseline emitted as edited content: %+v", status)
		}
		gotStages = append(gotStages, status.Stage)
	}
	if !reflect.DeepEqual(gotStages, wantStages) {
		t.Fatalf("stages = %v, want %v", gotStages, wantStages)
	}
}

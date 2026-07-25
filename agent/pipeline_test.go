package agent_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/liumingjian/wps-plugin/agent"
)

type recordingLauncher struct {
	path   string
	opened chan struct{}
}

func (l *recordingLauncher) Open(_ context.Context, path string) error {
	l.path = path
	if l.opened != nil {
		close(l.opened)
	}
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

func TestPipelineReportsFailureWhenSnapshotCreationFails(t *testing.T) {
	launcher := &recordingLauncher{opened: make(chan struct{})}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("baseline"))
	}))
	defer server.Close()

	var statuses []agent.Status
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := agent.RunSubmissionPipeline(ctx, agent.TaskStart{
			Version: 1, TaskID: "task-001", DocumentID: "doc-001",
			DownloadURL: server.URL, UploadURL: server.URL,
		}, t.TempDir(), launcher, agent.PipelineOptions{PollInterval: 10 * time.Millisecond, StabilityDuration: 10 * time.Millisecond}, func(status agent.Status) {
			statuses = append(statuses, status)
		})
		done <- err
	}()
	<-launcher.opened
	if err := os.WriteFile(filepath.Join(filepath.Dir(launcher.path), "snapshots"), []byte("not a directory"), 0400); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(launcher.path, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}

	if err := <-done; err == nil {
		t.Fatal("pipeline error = nil, want snapshot creation error")
	}
	if statuses[len(statuses)-1].Stage != "failed" {
		t.Fatalf("last stage = %q, want failed", statuses[len(statuses)-1].Stage)
	}
}

func TestPipelineSubmitsOneStableChangedAtomicReplacement(t *testing.T) {
	baseline := []byte("baseline")
	changed := []byte("complete changed document")
	var mu sync.Mutex
	var submissions [][]byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/documents/doc-001/content":
			_, _ = w.Write(baseline)
		case r.Method == http.MethodPost && r.URL.Path == "/tasks/task-001/submissions":
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			submissions = append(submissions, body)
			mu.Unlock()
			w.WriteHeader(http.StatusCreated)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	launcher := &recordingLauncher{opened: make(chan struct{})}
	var statuses []agent.Status
	var statusMu sync.Mutex
	done := make(chan error, 1)
	go func() {
		_, err := agent.RunSubmissionPipeline(ctx, agent.TaskStart{
			Version: 1, TaskID: "task-001", DocumentID: "doc-001",
			DownloadURL: server.URL + "/documents/doc-001/content",
			UploadURL:   server.URL + "/tasks/task-001/submissions",
		}, t.TempDir(), launcher, agent.PipelineOptions{PollInterval: 20 * time.Millisecond, StabilityDuration: 300 * time.Millisecond}, func(status agent.Status) {
			statusMu.Lock()
			statuses = append(statuses, status)
			statusMu.Unlock()
		})
		done <- err
	}()
	<-launcher.opened

	// Unchanged content must not submit.
	time.Sleep(350 * time.Millisecond)
	mu.Lock()
	if len(submissions) != 0 {
		t.Fatalf("unchanged baseline produced %d submissions", len(submissions))
	}
	mu.Unlock()

	// A file that keeps changing must not be uploaded before it stabilizes.
	if err := os.WriteFile(launcher.path, []byte("partial"), 0600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	if err := os.WriteFile(launcher.path, []byte("still incomplete"), 0600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(40 * time.Millisecond)
	mu.Lock()
	if len(submissions) != 0 {
		t.Fatalf("incomplete content produced %d submissions", len(submissions))
	}
	mu.Unlock()

	// Temporary disappearance plus atomic replacement restarts stability evaluation.
	replacement := launcher.path + ".replacement"
	if err := os.WriteFile(replacement, changed, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(launcher.path); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if err := os.Rename(replacement, launcher.path); err != nil {
		t.Fatal(err)
	}

	if err := <-done; err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(submissions) != 1 || !reflect.DeepEqual(submissions[0], changed) {
		t.Fatalf("submissions = %q, want exactly %q", submissions, changed)
	}
	statusMu.Lock()
	defer statusMu.Unlock()
	wantStages := []string{"stable-version", "submitting", "succeeded"}
	var gotStages []string
	for _, status := range statuses {
		if status.Stage == "stable-version" || status.Stage == "submitting" || status.Stage == "succeeded" {
			gotStages = append(gotStages, status.Stage)
		}
	}
	if !reflect.DeepEqual(gotStages, wantStages) {
		t.Fatalf("submission stages = %v, want %v", gotStages, wantStages)
	}
}

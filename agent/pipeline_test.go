package agent_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liumingjian/wps-plugin/agent"
)

type recordingLauncher struct {
	path   string
	opened chan struct{}
	closed chan struct{}
}

type recordingSession struct{ closed <-chan struct{} }

func (session recordingSession) WaitClosed(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-session.closed:
		return nil
	}
}

func (launcher *recordingLauncher) Open(_ context.Context, path string) (agent.EditingSession, error) {
	launcher.path = path
	if launcher.closed == nil {
		launcher.closed = make(chan struct{})
	}
	if launcher.opened != nil {
		close(launcher.opened)
	}
	return recordingSession{closed: launcher.closed}, nil
}

type pipelineCompletion struct {
	result agent.Result
	err    error
}

func TestEditingTaskDownloadsWorkCopyRecordsBaselineAndLaunches(t *testing.T) {
	document := []byte("real fixture document bytes")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(document)
	}))
	defer server.Close()

	launcher := new(recordingLauncher)
	var statuses []agent.Status
	result, err := agent.RunTask(context.Background(), task(server.URL), t.TempDir(), launcher, func(status agent.Status) {
		statuses = append(statuses, status)
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(result.WorkCopyPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, document) {
		t.Fatalf("Work Copy = %q, want %q", got, document)
	}
	wantBaseline := fmt.Sprintf("%x", sha256.Sum256(document))
	if result.BaselineSHA256 != wantBaseline {
		t.Fatalf("baseline = %q, want %q", result.BaselineSHA256, wantBaseline)
	}
	if launcher.path != result.WorkCopyPath || !filepath.IsAbs(launcher.path) {
		t.Fatalf("launch path = %q, Work Copy = %q", launcher.path, result.WorkCopyPath)
	}
	if mode := fileMode(t, filepath.Dir(result.WorkCopyPath)); mode != 0o700 {
		t.Fatalf("task directory mode = %o, want 700", mode)
	}
	if mode := fileMode(t, result.WorkCopyPath); mode != 0o600 {
		t.Fatalf("Work Copy mode = %o, want 600", mode)
	}
	wantStages := []string{"download", "work-copy", "baseline", "launch", "observing"}
	var gotStages []string
	for _, status := range statuses {
		gotStages = append(gotStages, status.Stage)
	}
	if !reflect.DeepEqual(gotStages, wantStages) {
		t.Fatalf("stages = %v, want %v", gotStages, wantStages)
	}
}

func TestPipelineCompletesUnchangedOnlyAfterWorkCopyCloses(t *testing.T) {
	launcher := &recordingLauncher{opened: make(chan struct{}), closed: make(chan struct{})}
	var submissions int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			submissions++
			w.WriteHeader(http.StatusCreated)
			return
		}
		_, _ = w.Write([]byte("baseline"))
	}))
	defer server.Close()

	done := runPipeline(t, server.URL, launcher, fastOptions(), func(agent.Status) {})
	<-launcher.opened
	assertNotCompleted(t, done)
	close(launcher.closed)
	completed := awaitCompletion(t, done)
	if completed.err != nil || completed.result.Outcome != "unchanged" {
		t.Fatalf("completion = %+v, want unchanged", completed)
	}
	if submissions != 0 {
		t.Fatalf("Submissions = %d, want 0", submissions)
	}
}

func TestPipelineObservesDuringBlockedSubmissionAndDrainsFIFOAfterClose(t *testing.T) {
	baseline := []byte("baseline")
	first := []byte("first stable version")
	second := []byte("second stable version")
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	submitted := make(chan []byte, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write(baseline)
			return
		}
		body, _ := io.ReadAll(r.Body)
		submitted <- body
		if reflect.DeepEqual(body, first) {
			close(firstStarted)
			<-releaseFirst
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	launcher := &recordingLauncher{opened: make(chan struct{}), closed: make(chan struct{})}
	snapshots := make(chan string, 3)
	done := runPipeline(t, server.URL, launcher, fastOptions(), func(status agent.Status) {
		if status.Stage == "snapshot" {
			snapshots <- status.SnapshotPath
		}
	})
	<-launcher.opened
	writeWorkCopy(t, launcher.path, first)
	<-firstStarted
	<-snapshots
	writeWorkCopy(t, launcher.path, second)
	secondSnapshot := awaitString(t, snapshots)
	if got := readFile(t, secondSnapshot); !reflect.DeepEqual(got, second) {
		t.Fatalf("second Snapshot = %q, want %q", got, second)
	}

	close(releaseFirst)
	if got := <-submitted; !reflect.DeepEqual(got, first) {
		t.Fatalf("first Submission = %q", got)
	}
	if got := <-submitted; !reflect.DeepEqual(got, second) {
		t.Fatalf("second Submission = %q", got)
	}
	assertNotCompleted(t, done)
	close(launcher.closed)
	completed := awaitCompletion(t, done)
	if completed.err != nil || completed.result.Outcome != "submitted" {
		t.Fatalf("completion = %+v, want submitted", completed)
	}
	wantFinal := fmt.Sprintf("%x", sha256.Sum256(second))
	if completed.result.FinalSHA256 != wantFinal {
		t.Fatalf("final hash = %q, want %q", completed.result.FinalSHA256, wantFinal)
	}
}

func TestPipelineSubmitsLaterReversionToBaseline(t *testing.T) {
	baseline := []byte("baseline")
	changed := []byte("changed")
	submitted := make(chan []byte, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write(baseline)
			return
		}
		body, _ := io.ReadAll(r.Body)
		submitted <- body
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	launcher := &recordingLauncher{opened: make(chan struct{}), closed: make(chan struct{})}
	done := runPipeline(t, server.URL, launcher, fastOptions(), func(agent.Status) {})
	<-launcher.opened
	writeWorkCopy(t, launcher.path, changed)
	if got := <-submitted; !reflect.DeepEqual(got, changed) {
		t.Fatalf("first Submission = %q", got)
	}
	writeWorkCopy(t, launcher.path, baseline)
	if got := <-submitted; !reflect.DeepEqual(got, baseline) {
		t.Fatalf("reversion Submission = %q, want baseline", got)
	}
	close(launcher.closed)
	completed := awaitCompletion(t, done)
	if completed.err != nil || completed.result.Outcome != "submitted" {
		t.Fatalf("completion = %+v", completed)
	}
	wantFinal := fmt.Sprintf("%x", sha256.Sum256(baseline))
	if completed.result.FinalSHA256 != wantFinal {
		t.Fatalf("final hash = %q, want baseline %q", completed.result.FinalSHA256, wantFinal)
	}
}

func TestPipelineRejectsTerminallyAndRetainsQueuedSnapshots(t *testing.T) {
	first := []byte("rejected version")
	second := []byte("queued version")
	firstStarted := make(chan struct{})
	rejectFirst := make(chan struct{})
	var mu sync.Mutex
	var submissions [][]byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte("baseline"))
			return
		}
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		submissions = append(submissions, body)
		attempt := len(submissions)
		mu.Unlock()
		if attempt == 1 {
			close(firstStarted)
			<-rejectFirst
			http.Error(w, "reject", http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	launcher := &recordingLauncher{opened: make(chan struct{}), closed: make(chan struct{})}
	snapshots := make(chan string, 3)
	done := runPipeline(t, server.URL, launcher, fastOptions(), func(status agent.Status) {
		if status.Stage == "snapshot" {
			snapshots <- status.SnapshotPath
		}
	})
	<-launcher.opened
	writeWorkCopy(t, launcher.path, first)
	<-firstStarted
	firstSnapshot := <-snapshots
	writeWorkCopy(t, launcher.path, second)
	secondSnapshot := awaitString(t, snapshots)
	close(rejectFirst)
	completed := awaitCompletion(t, done)
	if completed.err == nil || !strings.Contains(completed.err.Error(), firstSnapshot) {
		t.Fatalf("error = %v, want retained Snapshot path %s", completed.err, firstSnapshot)
	}
	if !reflect.DeepEqual(readFile(t, firstSnapshot), first) || !reflect.DeepEqual(readFile(t, secondSnapshot), second) {
		t.Fatal("retained Snapshots do not match their Persisted Versions")
	}
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(submissions, [][]byte{first}) {
		t.Fatalf("Submissions = %q, want only rejected first version", submissions)
	}
}

func TestPipelineDrainsFinalSaveThatArrivesAfterClose(t *testing.T) {
	final := []byte("saved while closing")
	submitted := make(chan []byte, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte("baseline"))
			return
		}
		body, _ := io.ReadAll(r.Body)
		submitted <- body
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()
	launcher := &recordingLauncher{opened: make(chan struct{}), closed: make(chan struct{})}
	options := fastOptions()
	options.FinalDrainDuration = 50 * time.Millisecond
	done := runPipeline(t, server.URL, launcher, options, func(agent.Status) {})
	<-launcher.opened
	close(launcher.closed)
	time.Sleep(5 * time.Millisecond)
	writeWorkCopy(t, launcher.path, final)
	completed := awaitCompletion(t, done)
	if completed.err != nil || completed.result.Outcome != "submitted" {
		t.Fatalf("completion = %+v", completed)
	}
	if got := <-submitted; !reflect.DeepEqual(got, final) {
		t.Fatalf("Submission = %q, want %q", got, final)
	}
}

func TestPipelineReportsSnapshotCreationFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("baseline"))
	}))
	defer server.Close()
	launcher := &recordingLauncher{opened: make(chan struct{}), closed: make(chan struct{})}
	done := runPipeline(t, server.URL, launcher, fastOptions(), func(agent.Status) {})
	<-launcher.opened
	if err := os.WriteFile(filepath.Join(filepath.Dir(launcher.path), "snapshots"), []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeWorkCopy(t, launcher.path, []byte("changed"))
	completed := awaitCompletion(t, done)
	if completed.err == nil {
		t.Fatal("pipeline error = nil, want Snapshot creation failure")
	}
}

func TestSecondTaskLockIsRejectedUntilFirstReleases(t *testing.T) {
	stateRoot := t.TempDir()
	first, err := agent.AcquireTaskLock(stateRoot)
	if err != nil {
		t.Fatal(err)
	}
	second, err := agent.AcquireTaskLock(stateRoot)
	if second != nil || !errors.Is(err, agent.ErrTaskActive) {
		t.Fatalf("second lock = %v, %v; want ErrTaskActive", second, err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	third, err := agent.AcquireTaskLock(stateRoot)
	if err != nil {
		t.Fatalf("lock after release: %v", err)
	}
	third.Close()
	if mode := fileMode(t, filepath.Join(stateRoot, "active-task.lock")); mode != 0o600 {
		t.Fatalf("lock mode = %o, want 600", mode)
	}
}

func task(serverURL string) agent.TaskStart {
	return agent.TaskStart{Version: 1, TaskID: "task-001", DocumentID: "doc-001", DownloadURL: serverURL, UploadURL: serverURL}
}

func fastOptions() agent.PipelineOptions {
	return agent.PipelineOptions{PollInterval: 5 * time.Millisecond, StabilityDuration: 15 * time.Millisecond, FinalDrainDuration: 20 * time.Millisecond}
}

func runPipeline(t *testing.T, serverURL string, launcher *recordingLauncher, options agent.PipelineOptions, emit func(agent.Status)) <-chan pipelineCompletion {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	t.Cleanup(cancel)
	done := make(chan pipelineCompletion, 1)
	go func() {
		result, err := agent.RunSubmissionPipeline(ctx, task(serverURL), t.TempDir(), launcher, options, emit)
		done <- pipelineCompletion{result: result, err: err}
	}()
	return done
}

func assertNotCompleted(t *testing.T, done <-chan pipelineCompletion) {
	t.Helper()
	select {
	case completed := <-done:
		t.Fatalf("pipeline completed while Work Copy remained open: %+v", completed)
	case <-time.After(40 * time.Millisecond):
	}
}

func awaitCompletion(t *testing.T, done <-chan pipelineCompletion) pipelineCompletion {
	t.Helper()
	select {
	case completed := <-done:
		return completed
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for pipeline completion")
		return pipelineCompletion{}
	}
}

func awaitString(t *testing.T, values <-chan string) string {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for status")
		return ""
	}
}

func writeWorkCopy(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func fileMode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

package agent_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/liumingjian/wps-plugin/agent"
)

type durableLauncher struct {
	path   string
	opened chan struct{}
	closed chan struct{}
}

func (launcher *durableLauncher) Open(_ context.Context, path string) (agent.EditingSession, error) {
	launcher.path = path
	close(launcher.opened)
	return durableSession{launcher.closed}, nil
}

type durableSession struct{ closed <-chan struct{} }

func (session durableSession) WaitClosed(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-session.closed:
		return nil
	}
}

func TestDurableEditingTaskCompletesOnlyAfterVerifiedReceipts(t *testing.T) {
	document := minimalDOCX(t)
	hashBytes := sha256.Sum256(document)
	descriptor := validDescriptor()
	descriptor.Document.SizeBytes = int64(len(document))
	descriptor.Document.SHA256 = hex.EncodeToString(hashBytes[:])
	changed := append([]byte(nil), document...)
	changed = append(changed, 'x')

	var mu sync.Mutex
	var submitted [][]byte
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/content":
			w.Header().Set("Content-Type", agent.DOCXMediaType)
			_, _ = w.Write(document)
		case "/submissions":
			content := make([]byte, r.ContentLength)
			_, _ = r.Body.Read(content)
			mu.Lock()
			submitted = append(submitted, content)
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(agent.AcceptanceReceipt{Accepted: true, SubmissionID: "submission-1", DocumentVersion: "8", SnapshotSHA256: r.Header.Get("X-WPS-Snapshot-SHA256"), AcceptedAt: time.Now().UTC()})
		case "/completion":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(agent.CompletionReceipt{Completed: true, TaskID: descriptor.TaskID, Outcome: "submitted", CompletedAt: time.Now().UTC()})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	for endpoint, path := range map[*agent.CapabilityEndpoint]string{&descriptor.Retrieval: "/content", &descriptor.Submission.CapabilityEndpoint: "/submissions", &descriptor.Completion: "/completion"} {
		endpoint.URL = "https://oa.example.test" + path
	}
	client := server.Client()
	client.Transport = rewriteTransport{base: client.Transport, target: mustURL(t, server.URL)}
	launcher := &durableLauncher{opened: make(chan struct{}), closed: make(chan struct{})}
	var events []agent.TaskEvent
	done := make(chan error, 1)
	stateRoot := t.TempDir()
	go func() {
		done <- agent.RunDurableTask(context.Background(), descriptor, stateRoot, launcher, agent.DurableTaskOptions{HTTPClient: client, PollInterval: 5 * time.Millisecond, StabilityDuration: 15 * time.Millisecond, FinalDrainDuration: 20 * time.Millisecond}, func(event agent.TaskEvent) { events = append(events, event) })
	}()
	<-launcher.opened
	if err := os.WriteFile(launcher.path, changed, 0o600); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	close(launcher.closed)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("durable Editing Task did not complete")
	}
	var types []string
	for _, event := range events {
		types = append(types, event.Type)
	}
	positions := map[string]int{}
	for index, eventType := range types {
		positions[eventType] = index
	}
	if len(types) != 5 || types[0] != "wps-opened" || positions["submission-started"] >= positions["submission-accepted"] || positions["submission-accepted"] >= positions["task-completed"] || positions["wps-closed"] >= positions["task-completed"] {
		t.Fatalf("events violate lifecycle ordering: %v", types)
	}
	store, err := agent.OpenTaskStore(stateRoot, descriptor.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	state := store.State()
	if state.TaskPhase != "finished" || state.TaskOutcome != "completed" || len(state.Snapshots) != 1 || state.Snapshots[0].State != "accepted" {
		t.Fatalf("final durable state = %+v", state)
	}
}

func TestResumeDurableTaskReusesSnapshotIdentityAfterReauthorization(t *testing.T) {
	descriptor := validDescriptor()
	var gotKey string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/submissions":
			gotKey = r.Header.Get("Idempotency-Key")
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(agent.AcceptanceReceipt{Accepted: true, SubmissionID: "submission-recovered", DocumentVersion: "9", SnapshotSHA256: r.Header.Get("X-WPS-Snapshot-SHA256"), AcceptedAt: time.Now().UTC()})
		case "/completion":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(agent.CompletionReceipt{Completed: true, TaskID: descriptor.TaskID, Outcome: "submitted", CompletedAt: time.Now().UTC()})
		}
	}))
	defer server.Close()
	for endpoint, path := range map[*agent.CapabilityEndpoint]string{&descriptor.Retrieval: "/content", &descriptor.Submission.CapabilityEndpoint: "/submissions", &descriptor.Completion: "/completion"} {
		endpoint.URL = "https://oa.example.test" + path
	}
	client := server.Client()
	client.Transport = rewriteTransport{base: client.Transport, target: mustURL(t, server.URL)}
	root := t.TempDir()
	store, err := agent.CreateTaskStore(root, descriptor)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, _, err := store.CaptureSnapshot([]byte("retained Snapshot"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RecordFailure(snapshot.Sequence, agent.UserAction, time.Now(), 0); err != nil {
		t.Fatal(err)
	}
	if err := store.SetTaskState("draining", "action-required", nil); err != nil {
		t.Fatal(err)
	}
	if err := agent.ResumeDurableTask(context.Background(), descriptor, root, agent.DurableTaskOptions{HTTPClient: client}, func(agent.TaskEvent) {}); err != nil {
		t.Fatal(err)
	}
	if gotKey != snapshot.IdempotencyKey {
		t.Fatalf("resumed idempotency key = %q, want %q", gotKey, snapshot.IdempotencyKey)
	}
	reopened, err := agent.OpenTaskStore(root, descriptor.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if state := reopened.State(); state.TaskOutcome != "completed" || state.Snapshots[0].State != "accepted" {
		t.Fatalf("resumed task state = %+v", state)
	}
}

type rewriteTransport struct {
	base   http.RoundTripper
	target *url.URL
}

func (transport rewriteTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	copy := request.Clone(request.Context())
	copy.URL.Scheme = transport.target.Scheme
	copy.URL.Host = transport.target.Host
	return transport.base.RoundTrip(copy)
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

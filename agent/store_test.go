package agent_test

import (
	"errors"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/liumingjian/wps-plugin/agent"
)

func TestTaskStorePersistsEveryDistinctObservedVersionInFIFOOrder(t *testing.T) {
	root := t.TempDir()
	store, err := agent.CreateTaskStore(root, validDescriptor())
	if err != nil {
		t.Fatal(err)
	}
	first, created, err := store.CaptureSnapshot([]byte("first"))
	if err != nil || !created || first.Sequence != 1 {
		t.Fatalf("first CaptureSnapshot() = %+v, %v, %v", first, created, err)
	}
	duplicate, created, err := store.CaptureSnapshot([]byte("first"))
	if err != nil || created || duplicate.Sequence != first.Sequence {
		t.Fatalf("duplicate CaptureSnapshot() = %+v, %v, %v", duplicate, created, err)
	}
	second, created, err := store.CaptureSnapshot([]byte("second"))
	if err != nil || !created || second.Sequence != 2 {
		t.Fatalf("second CaptureSnapshot() = %+v, %v, %v", second, created, err)
	}
	reversion, created, err := store.CaptureSnapshot([]byte("first"))
	if err != nil || !created || reversion.Sequence != 3 || reversion.SHA256 != first.SHA256 {
		t.Fatalf("reversion CaptureSnapshot() = %+v, %v, %v", reversion, created, err)
	}
	for _, snapshot := range []agent.SnapshotRecord{first, second, reversion} {
		info, err := os.Stat(snapshot.Path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o400 {
			t.Fatalf("Snapshot %d mode = %o, want 400", snapshot.Sequence, info.Mode().Perm())
		}
	}

	reopened, err := agent.OpenTaskStore(root, validDescriptor().TaskID)
	if err != nil {
		t.Fatal(err)
	}
	state := reopened.State()
	if len(state.Snapshots) != 3 || state.Snapshots[0].Sequence != 1 || state.Snapshots[2].Sequence != 3 {
		t.Fatalf("reopened state Snapshots = %+v", state.Snapshots)
	}
}

func TestTaskStoreAcceptsOnlyMatchingReceiptAndPersistsRetryDisposition(t *testing.T) {
	root := t.TempDir()
	store, err := agent.CreateTaskStore(root, validDescriptor())
	if err != nil {
		t.Fatal(err)
	}
	snapshot, _, err := store.CaptureSnapshot([]byte("version"))
	if err != nil {
		t.Fatal(err)
	}
	bad := agent.AcceptanceReceipt{Accepted: true, SubmissionID: "submission-1", DocumentVersion: "8", SnapshotSHA256: "wrong", AcceptedAt: time.Now().UTC()}
	if err := store.Accept(snapshot.Sequence, bad); err == nil {
		t.Fatal("hash-mismatched Acceptance Receipt was accepted")
	}
	if store.State().Snapshots[0].State == "accepted" {
		t.Fatal("Snapshot changed state after an unverifiable receipt")
	}

	now := time.Now().UTC()
	disposition := agent.ClassifySubmissionFailure(http.StatusServiceUnavailable, errors.New("temporary"), "")
	if disposition != agent.AutomaticRetry {
		t.Fatalf("503 disposition = %q, want automatic retry", disposition)
	}
	if err := store.RecordFailure(snapshot.Sequence, disposition, now, 0); err != nil {
		t.Fatal(err)
	}
	reopened, err := agent.OpenTaskStore(root, validDescriptor().TaskID)
	if err != nil {
		t.Fatal(err)
	}
	retrying := reopened.State().Snapshots[0]
	if retrying.State != "retry-wait" || retrying.RetryCount != 1 || retrying.NextAttemptAt == nil || !retrying.NextAttemptAt.After(now) {
		t.Fatalf("persisted retry = %+v", retrying)
	}

	good := agent.AcceptanceReceipt{Accepted: true, SubmissionID: "submission-1", DocumentVersion: "8", SnapshotSHA256: snapshot.SHA256, AcceptedAt: time.Now().UTC()}
	if err := reopened.Accept(snapshot.Sequence, good); err != nil {
		t.Fatal(err)
	}
	if accepted := reopened.State().Snapshots[0]; accepted.State != "accepted" || accepted.NextAttemptAt != nil {
		t.Fatalf("accepted Snapshot = %+v", accepted)
	}
}

func TestSubmissionFailureClassifierUsesFixedLocalRules(t *testing.T) {
	tests := []struct {
		status  int
		err     error
		receipt string
		want    agent.FailureDisposition
	}{
		{0, errors.New("network"), "", agent.AutomaticRetry},
		{http.StatusUnauthorized, nil, "", agent.UserAction},
		{http.StatusTooManyRequests, nil, "", agent.AutomaticRetry},
		{http.StatusConflict, nil, "", agent.RecoveryRequired},
		{http.StatusCreated, nil, "missing", agent.AutomaticRetry},
	}
	for _, tt := range tests {
		if got := agent.ClassifySubmissionFailure(tt.status, tt.err, tt.receipt); got != tt.want {
			t.Errorf("ClassifySubmissionFailure(%d, %v, %q) = %q, want %q", tt.status, tt.err, tt.receipt, got, tt.want)
		}
	}
}

func TestRetentionCleanupDeletesAcceptedContentButKeepsUnresolvedSnapshot(t *testing.T) {
	root := t.TempDir()
	store, err := agent.CreateTaskStore(root, validDescriptor())
	if err != nil {
		t.Fatal(err)
	}
	accepted, _, _ := store.CaptureSnapshot([]byte("accepted"))
	old := time.Now().Add(-8 * 24 * time.Hour)
	if err := store.Accept(accepted.Sequence, agent.AcceptanceReceipt{Accepted: true, SubmissionID: "one", DocumentVersion: "8", SnapshotSHA256: accepted.SHA256, AcceptedAt: old}); err != nil {
		t.Fatal(err)
	}
	unresolved, _, _ := store.CaptureSnapshot([]byte("unresolved"))
	if err := store.RecordFailure(unresolved.Sequence, agent.RecoveryRequired, old, 0); err != nil {
		t.Fatal(err)
	}
	if err := store.Cleanup(time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(accepted.Path); !os.IsNotExist(err) {
		t.Fatalf("expired accepted Snapshot remains: %v", err)
	}
	if _, err := os.Stat(unresolved.Path); err != nil {
		t.Fatalf("unresolved Snapshot was removed: %v", err)
	}
}

func TestTaskStoreRejectsSymlinkedStateDirectories(t *testing.T) {
	root := t.TempDir()
	target := t.TempDir()
	if err := os.Symlink(target, root+"/tasks"); err != nil {
		t.Fatal(err)
	}
	if _, err := agent.CreateTaskStore(root, validDescriptor()); err == nil {
		t.Fatal("CreateTaskStore accepted a symlinked tasks directory")
	}
}

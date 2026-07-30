package agent

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const StateVersion = 1

type SnapshotRecord struct {
	Sequence       int                `json:"sequence"`
	SHA256         string             `json:"sha256"`
	Path           string             `json:"path"`
	IdempotencyKey string             `json:"idempotencyKey"`
	State          string             `json:"state"`
	RetryCount     int                `json:"retryCount,omitempty"`
	NextAttemptAt  *time.Time         `json:"nextAttemptAt,omitempty"`
	Receipt        *AcceptanceReceipt `json:"receipt,omitempty"`
}

type AcceptanceReceipt struct {
	Accepted        bool      `json:"accepted"`
	SubmissionID    string    `json:"submissionId"`
	DocumentVersion string    `json:"documentVersion"`
	SnapshotSHA256  string    `json:"snapshotSha256"`
	AcceptedAt      time.Time `json:"acceptedAt"`
}

type FailureDisposition string

const (
	AutomaticRetry   FailureDisposition = "automatic-retry"
	UserAction       FailureDisposition = "user-action"
	RecoveryRequired FailureDisposition = "recovery-required"
)

type DurableTaskState struct {
	StateVersion int                `json:"stateVersion"`
	Descriptor   TaskDescriptor     `json:"descriptor"`
	TaskPhase    string             `json:"taskPhase"`
	TaskOutcome  string             `json:"taskOutcome"`
	Snapshots    []SnapshotRecord   `json:"snapshots"`
	Events       []TaskEvent        `json:"events,omitempty"`
	Completion   *CompletionReceipt `json:"completionReceipt,omitempty"`
	LastObserved string             `json:"lastObservedSha256,omitempty"`
	CreatedAt    time.Time          `json:"createdAt"`
	UpdatedAt    time.Time          `json:"updatedAt"`
}

type TaskEvent struct {
	Type             string             `json:"type"`
	TaskID           string             `json:"taskId"`
	EventSequence    int                `json:"eventSequence"`
	Timestamp        time.Time          `json:"timestamp"`
	SnapshotSequence int                `json:"snapshotSequence,omitempty"`
	Receipt          *AcceptanceReceipt `json:"receipt,omitempty"`
	Outcome          string             `json:"outcome,omitempty"`
	Error            *TaskError         `json:"error,omitempty"`
	Replayed         bool               `json:"replayed,omitempty"`
}

type TaskError struct {
	Code        string `json:"code"`
	Phase       string `json:"phase"`
	Disposition string `json:"disposition"`
	Action      string `json:"action,omitempty"`
	Message     string `json:"message"`
}

type CompletionReceipt struct {
	Completed   bool      `json:"completed"`
	TaskID      string    `json:"taskId"`
	Outcome     string    `json:"outcome"`
	CompletedAt time.Time `json:"completedAt"`
}

type TaskStore struct {
	dir       string
	statePath string
	state     DurableTaskState
}

func CreateTaskStore(root string, descriptor TaskDescriptor) (*TaskStore, error) {
	if err := descriptor.Validate(time.Now()); err != nil {
		return nil, err
	}
	if err := secureDirectory(root); err != nil {
		return nil, err
	}
	tasksRoot := filepath.Join(root, "tasks")
	if err := secureDirectory(tasksRoot); err != nil {
		return nil, err
	}
	dir := filepath.Join(tasksRoot, descriptor.TaskID)
	if err := secureDirectory(dir); err != nil {
		return nil, err
	}
	statePath := filepath.Join(dir, "state.json")
	if _, err := os.Lstat(statePath); err == nil {
		return nil, errors.New("Editing Task already exists")
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	now := time.Now().UTC()
	store := &TaskStore{dir: dir, statePath: statePath, state: DurableTaskState{
		StateVersion: StateVersion, Descriptor: descriptor, TaskPhase: "retrieving", TaskOutcome: "active", CreatedAt: now, UpdatedAt: now,
	}}
	if err := store.persist(); err != nil {
		return nil, err
	}
	return store, nil
}

func OpenTaskStore(root, taskID string) (*TaskStore, error) {
	if !identifierPattern.MatchString(taskID) {
		return nil, errors.New("invalid Editing Task identifier")
	}
	dir := filepath.Join(root, "tasks", taskID)
	statePath := filepath.Join(dir, "state.json")
	info, err := os.Lstat(statePath)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 {
		return nil, errors.New("durable task state has unsafe type or permissions")
	}
	data, err := os.ReadFile(statePath)
	if err != nil {
		return nil, err
	}
	var state DurableTaskState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("read durable task state: %w", err)
	}
	if state.StateVersion > StateVersion {
		return nil, fmt.Errorf("task state version %d is newer than supported version %d", state.StateVersion, StateVersion)
	}
	if state.StateVersion != StateVersion || state.Descriptor.TaskID != taskID {
		return nil, errors.New("durable task state identity is invalid")
	}
	return &TaskStore{dir: dir, statePath: statePath, state: state}, nil
}

func (store *TaskStore) State() DurableTaskState {
	copy := store.state
	copy.Snapshots = append([]SnapshotRecord(nil), store.state.Snapshots...)
	copy.Events = append([]TaskEvent(nil), store.state.Events...)
	return copy
}

func (store *TaskStore) SetTaskState(phase, outcome string, completion *CompletionReceipt) error {
	store.state.TaskPhase = phase
	store.state.TaskOutcome = outcome
	store.state.Completion = completion
	store.state.UpdatedAt = time.Now().UTC()
	return store.persist()
}

func (store *TaskStore) UpdateDescriptor(descriptor TaskDescriptor) error {
	if descriptor.TaskID != store.state.Descriptor.TaskID || descriptor.Document.DocumentID != store.state.Descriptor.Document.DocumentID || descriptor.Document.SHA256 != store.state.Descriptor.Document.SHA256 {
		return errors.New("reauthorization descriptor does not match the existing Editing Task")
	}
	store.state.Descriptor = descriptor
	store.state.UpdatedAt = time.Now().UTC()
	return store.persist()
}

func (store *TaskStore) AppendEvent(event TaskEvent) (TaskEvent, error) {
	event.TaskID = store.state.Descriptor.TaskID
	event.EventSequence = len(store.state.Events) + 1
	event.Timestamp = time.Now().UTC()
	store.state.Events = append(store.state.Events, event)
	store.state.UpdatedAt = event.Timestamp
	return event, store.persist()
}

func (store *TaskStore) Cleanup(now time.Time) error {
	changed := false
	for index := range store.state.Snapshots {
		snapshot := &store.state.Snapshots[index]
		if snapshot.State != "accepted" || snapshot.Receipt == nil || snapshot.Path == "" || snapshot.Receipt.AcceptedAt.Add(7*24*time.Hour).After(now) {
			continue
		}
		if err := os.Remove(snapshot.Path); err != nil && !os.IsNotExist(err) {
			return err
		}
		snapshot.Path = ""
		changed = true
	}
	if store.state.TaskOutcome == "completed" && store.state.Completion != nil && !store.state.Completion.CompletedAt.Add(7*24*time.Hour).After(now) {
		_ = os.Remove(filepath.Join(store.dir, "work-copy.docx"))
		store.state.Descriptor.Retrieval.AuthValue = ""
		store.state.Descriptor.Submission.AuthValue = ""
		store.state.Descriptor.Completion.AuthValue = ""
		store.state.Events = nil
		changed = true
	}
	if !changed {
		return nil
	}
	store.state.UpdatedAt = now.UTC()
	return store.persist()
}

func (store *TaskStore) CaptureSnapshot(content []byte) (SnapshotRecord, bool, error) {
	hashBytes := sha256.Sum256(content)
	hash := hex.EncodeToString(hashBytes[:])
	if hash == store.state.LastObserved && len(store.state.Snapshots) > 0 {
		return store.state.Snapshots[len(store.state.Snapshots)-1], false, nil
	}
	sequence := len(store.state.Snapshots) + 1
	snapshotDir := filepath.Join(store.dir, "snapshots")
	if err := secureDirectory(snapshotDir); err != nil {
		return SnapshotRecord{}, false, err
	}
	path := filepath.Join(snapshotDir, fmt.Sprintf("%06d.docx", sequence))
	if err := atomicWrite(path, content, 0o400); err != nil {
		return SnapshotRecord{}, false, err
	}
	key, err := randomKey()
	if err != nil {
		return SnapshotRecord{}, false, err
	}
	record := SnapshotRecord{Sequence: sequence, SHA256: hash, Path: path, IdempotencyKey: key, State: "queued"}
	store.state.Snapshots = append(store.state.Snapshots, record)
	store.state.LastObserved = hash
	store.state.UpdatedAt = time.Now().UTC()
	if err := store.persist(); err != nil {
		return SnapshotRecord{}, false, err
	}
	return record, true, nil
}

func (store *TaskStore) Accept(sequence int, receipt AcceptanceReceipt) error {
	index, err := store.snapshotIndex(sequence)
	if err != nil {
		return err
	}
	snapshot := &store.state.Snapshots[index]
	if !receipt.Accepted || receipt.SubmissionID == "" || receipt.DocumentVersion == "" || receipt.AcceptedAt.IsZero() || receipt.SnapshotSHA256 != snapshot.SHA256 {
		return errors.New("Acceptance Receipt does not verify the exact Snapshot")
	}
	if index > 0 && store.state.Snapshots[index-1].State != "accepted" {
		return errors.New("Acceptance Receipt would violate Snapshot FIFO order")
	}
	snapshot.State = "accepted"
	snapshot.NextAttemptAt = nil
	copy := receipt
	snapshot.Receipt = &copy
	store.state.UpdatedAt = time.Now().UTC()
	return store.persist()
}

func (store *TaskStore) RecordFailure(sequence int, disposition FailureDisposition, now time.Time, retryAfter time.Duration) error {
	index, err := store.snapshotIndex(sequence)
	if err != nil {
		return err
	}
	snapshot := &store.state.Snapshots[index]
	snapshot.RetryCount++
	snapshot.NextAttemptAt = nil
	switch disposition {
	case AutomaticRetry:
		delay := retryDelay(snapshot.RetryCount)
		if retryAfter > delay {
			delay = retryAfter
		}
		next := now.Add(delay)
		snapshot.State = "retry-wait"
		snapshot.NextAttemptAt = &next
	case UserAction:
		snapshot.State = "authorization-required"
		store.state.TaskOutcome = "action-required"
	case RecoveryRequired:
		snapshot.State = "recovery-required"
		store.state.TaskOutcome = "action-required"
	default:
		return errors.New("unknown failure disposition")
	}
	store.state.UpdatedAt = time.Now().UTC()
	return store.persist()
}

func ClassifySubmissionFailure(status int, requestErr error, receiptProblem string) FailureDisposition {
	if requestErr != nil || receiptProblem != "" || status == http.StatusRequestTimeout || status == http.StatusTooEarly || status == http.StatusTooManyRequests || status >= 500 {
		return AutomaticRetry
	}
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return UserAction
	}
	return RecoveryRequired
}

func retryDelay(attempt int) time.Duration {
	delays := []time.Duration{2 * time.Second, 10 * time.Second, 30 * time.Second, 2 * time.Minute, 5 * time.Minute}
	if attempt <= len(delays) {
		return delays[attempt-1]
	}
	return 15 * time.Minute
}

func (store *TaskStore) snapshotIndex(sequence int) (int, error) {
	if sequence <= 0 || sequence > len(store.state.Snapshots) || store.state.Snapshots[sequence-1].Sequence != sequence {
		return 0, errors.New("Snapshot sequence does not exist")
	}
	return sequence - 1, nil
}

func (store *TaskStore) persist() error {
	payload, err := json.MarshalIndent(store.state, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	return atomicWrite(store.statePath, payload, 0o600)
}

func secureDirectory(path string) error {
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("unsafe directory %s", path)
		}
		return os.Chmod(path, 0o700)
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.MkdirAll(path, 0o700)
}

func atomicWrite(path string, content []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, ".write-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	ok := false
	defer func() {
		temp.Close()
		if !ok {
			_ = os.Remove(tempPath)
		}
	}()
	if err := temp.Chmod(mode); err != nil {
		return err
	}
	if _, err := temp.Write(content); err != nil {
		return err
	}
	if err := temp.Sync(); err != nil {
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	directory, err := os.Open(dir)
	if err == nil {
		err = directory.Sync()
		directory.Close()
	}
	if err != nil {
		return err
	}
	ok = true
	return nil
}

func randomKey() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

package agent

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type DurableTaskOptions struct {
	HTTPClient         *http.Client
	PollInterval       time.Duration
	StabilityDuration  time.Duration
	FinalDrainDuration time.Duration
}

type durableSubmissionResult struct {
	snapshot    SnapshotRecord
	receipt     AcceptanceReceipt
	disposition FailureDisposition
	err         error
}

func RunDurableTask(ctx context.Context, descriptor TaskDescriptor, stateRoot string, launcher Launcher, options DurableTaskOptions, emit func(TaskEvent)) error {
	if err := descriptor.Validate(time.Now()); err != nil {
		return err
	}
	store, err := CreateTaskStore(stateRoot, descriptor)
	if err != nil {
		return err
	}
	transport := NewTaskTransport(options.HTTPClient)
	document, err := transport.Retrieve(ctx, descriptor)
	if err != nil {
		_ = store.SetTaskState("finished", "failed", nil)
		return err
	}
	taskDir := filepath.Join(stateRoot, "tasks", descriptor.TaskID)
	workCopy := filepath.Join(taskDir, "work-copy.docx")
	if err := atomicWrite(workCopy, document, 0o600); err != nil {
		_ = store.SetTaskState("finished", "failed", nil)
		return err
	}
	if err := store.SetTaskState("opening", "active", nil); err != nil {
		return err
	}
	session, err := launcher.Open(ctx, workCopy)
	if err != nil {
		_ = store.SetTaskState("finished", "failed", nil)
		return err
	}
	if err := store.SetTaskState("editing", "active", nil); err != nil {
		return err
	}
	if err := appendAndEmit(store, TaskEvent{Type: "wps-opened"}, emit); err != nil {
		return err
	}

	pipelineOptions := normalizedOptions(PipelineOptions{PollInterval: options.PollInterval, StabilityDuration: options.StabilityDuration, FinalDrainDuration: options.FinalDrainDuration})
	observerContext, cancel := context.WithCancel(ctx)
	defer cancel()
	observations := make(chan observation)
	go observeWorkCopy(observerContext, Result{WorkCopyPath: workCopy, BaselineSHA256: descriptor.Document.SHA256, session: session}, pipelineOptions, observations)

	var queue []SnapshotRecord
	var submitting <-chan durableSubmissionResult
	observerDone := false
	changed := false
	closed := false

	for {
		if submitting == nil && len(queue) > 0 {
			current := queue[0]
			if err := appendAndEmit(store, TaskEvent{Type: "submission-started", SnapshotSequence: current.Sequence}, emit); err != nil {
				return err
			}
			content, err := os.ReadFile(current.Path)
			if err != nil {
				return err
			}
			completed := make(chan durableSubmissionResult, 1)
			submitting = completed
			go func(snapshot SnapshotRecord, payload []byte) {
				receipt, disposition, submitErr := transport.Submit(observerContext, descriptor, snapshot, payload)
				completed <- durableSubmissionResult{snapshot: snapshot, receipt: receipt, disposition: disposition, err: submitErr}
			}(current, content)
		}
		if observerDone && submitting == nil && len(queue) == 0 {
			outcome := "unchanged"
			if changed {
				outcome = "submitted"
			}
			if err := store.SetTaskState("completing", "active", nil); err != nil {
				return err
			}
			receipt, err := transport.Complete(ctx, descriptor, outcome)
			if err != nil {
				_ = store.SetTaskState("completing", "action-required", nil)
				_ = appendAndEmit(store, attentionEvent("SUBMISSION_UNCONFIRMED", "close", AutomaticRetry, "The server did not verify Editing Task completion.", 0), emit)
				return err
			}
			if err := store.SetTaskState("finished", "completed", &receipt); err != nil {
				return err
			}
			return appendAndEmit(store, TaskEvent{Type: "task-completed", Outcome: outcome}, emit)
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case observed := <-observations:
			if observed.err != nil {
				_ = store.SetTaskState("interrupted", "action-required", nil)
				_ = appendAndEmit(store, attentionEvent("TASK_INTERRUPTED", "edit", UserAction, "Editing was interrupted; choose Continue editing or End editing.", 0), emit)
				return observed.err
			}
			if observed.closed && !closed {
				closed = true
				_ = store.SetTaskState("draining", "active", nil)
				if err := appendAndEmit(store, TaskEvent{Type: "wps-closed"}, emit); err != nil {
					return err
				}
			}
			if observed.snapshot != nil {
				content, err := os.ReadFile(observed.snapshot.path)
				_ = os.Remove(observed.snapshot.path)
				if err != nil {
					return err
				}
				record, created, err := store.CaptureSnapshot(content)
				if err != nil {
					return err
				}
				if created {
					changed = true
					queue = append(queue, record)
				}
			}
			if observed.done {
				observerDone = true
				observations = nil
			}
		case result := <-submitting:
			submitting = nil
			if result.err != nil {
				if err := store.RecordFailure(result.snapshot.Sequence, result.disposition, time.Now().UTC(), 0); err != nil {
					return err
				}
				code := "SUBMISSION_REJECTED"
				if result.disposition == AutomaticRetry {
					code = "SUBMISSION_UNCONFIRMED"
				}
				if result.disposition == UserAction {
					code = "AUTHENTICATION_REQUIRED"
				}
				_ = appendAndEmit(store, attentionEvent(code, "submit", result.disposition, "The Snapshot remains safe for recovery.", result.snapshot.Sequence), emit)
				return result.err
			}
			if err := store.Accept(result.snapshot.Sequence, result.receipt); err != nil {
				return err
			}
			if err := appendAndEmit(store, TaskEvent{Type: "submission-accepted", SnapshotSequence: result.snapshot.Sequence, Receipt: &result.receipt}, emit); err != nil {
				return err
			}
			queue = queue[1:]
		}
	}
}

func ResumeDurableTask(ctx context.Context, descriptor TaskDescriptor, stateRoot string, options DurableTaskOptions, emit func(TaskEvent)) error {
	if err := descriptor.Validate(time.Now()); err != nil {
		return err
	}
	store, err := OpenTaskStore(stateRoot, descriptor.TaskID)
	if err != nil {
		return err
	}
	if err := store.UpdateDescriptor(descriptor); err != nil {
		return err
	}
	state := store.State()
	for _, event := range state.Events {
		replay := event
		replay.Replayed = true
		emit(replay)
	}
	transport := NewTaskTransport(options.HTTPClient)
	for _, snapshot := range state.Snapshots {
		if snapshot.State == "accepted" {
			continue
		}
		if err := appendAndEmit(store, TaskEvent{Type: "submission-started", SnapshotSequence: snapshot.Sequence}, emit); err != nil {
			return err
		}
		content, err := os.ReadFile(snapshot.Path)
		if err != nil {
			return err
		}
		receipt, disposition, err := transport.Submit(ctx, descriptor, snapshot, content)
		if err != nil {
			if stateErr := store.RecordFailure(snapshot.Sequence, disposition, time.Now().UTC(), 0); stateErr != nil {
				return stateErr
			}
			code := "SUBMISSION_REJECTED"
			if disposition == AutomaticRetry {
				code = "SUBMISSION_UNCONFIRMED"
			} else if disposition == UserAction {
				code = "AUTHENTICATION_REQUIRED"
			}
			_ = appendAndEmit(store, attentionEvent(code, "submit", disposition, "The Snapshot remains safe for recovery.", snapshot.Sequence), emit)
			return err
		}
		if err := store.Accept(snapshot.Sequence, receipt); err != nil {
			return err
		}
		if err := appendAndEmit(store, TaskEvent{Type: "submission-accepted", SnapshotSequence: snapshot.Sequence, Receipt: &receipt}, emit); err != nil {
			return err
		}
	}
	state = store.State()
	if state.TaskPhase != "draining" && state.TaskPhase != "completing" {
		if err := store.SetTaskState("interrupted", "action-required", nil); err != nil {
			return err
		}
		return appendAndEmit(store, attentionEvent("TASK_INTERRUPTED", "edit", UserAction, "Choose Continue editing or End editing.", 0), emit)
	}
	outcome := "unchanged"
	if len(state.Snapshots) > 0 {
		outcome = "submitted"
	}
	receipt, err := transport.Complete(ctx, descriptor, outcome)
	if err != nil {
		return err
	}
	if err := store.SetTaskState("finished", "completed", &receipt); err != nil {
		return err
	}
	return appendAndEmit(store, TaskEvent{Type: "task-completed", Outcome: outcome}, emit)
}

func appendAndEmit(store *TaskStore, event TaskEvent, emit func(TaskEvent)) error {
	durable, err := store.AppendEvent(event)
	if err != nil {
		return err
	}
	emit(durable)
	return nil
}

func attentionEvent(code, phase string, disposition FailureDisposition, message string, sequence int) TaskEvent {
	action := "view-diagnostics"
	if disposition == UserAction {
		action = "reauthorize"
	}
	return TaskEvent{Type: "attention-required", SnapshotSequence: sequence, Error: &TaskError{Code: code, Phase: phase, Disposition: string(disposition), Action: action, Message: message}}
}

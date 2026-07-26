package agent

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type TaskStart struct {
	Version     int    `json:"version"`
	TaskID      string `json:"taskId"`
	DocumentID  string `json:"documentId"`
	DownloadURL string `json:"downloadUrl"`
	UploadURL   string `json:"uploadUrl"`
}

type Status struct {
	TaskID       string `json:"taskId"`
	DocumentID   string `json:"documentId"`
	Stage        string `json:"stage"`
	Status       string `json:"status"`
	Kind         string `json:"kind,omitempty"`
	Message      string `json:"message"`
	SnapshotPath string `json:"snapshotPath,omitempty"`
}

type Result struct {
	WorkCopyPath   string
	BaselineSHA256 string
	FinalSHA256    string
	Outcome        string
	session        EditingSession
}

type PipelineOptions struct {
	PollInterval       time.Duration
	StabilityDuration  time.Duration
	FinalDrainDuration time.Duration
}

var defaultPipelineOptions = PipelineOptions{PollInterval: 500 * time.Millisecond, StabilityDuration: 2 * time.Second, FinalDrainDuration: 2 * time.Second}

type EditingSession interface {
	WaitClosed(context.Context) error
}

type Launcher interface {
	Open(context.Context, string) (EditingSession, error)
}

type snapshot struct {
	hash string
	path string
}

type observation struct {
	snapshot        *snapshot
	closed          bool
	done            bool
	changedOccurred bool
	finalHash       string
	err             error
}

type submissionResult struct {
	snapshot snapshot
	err      error
}

func RunTask(ctx context.Context, task TaskStart, workRoot string, launcher Launcher, emit func(Status)) (Result, error) {
	status := func(stage, state, message string) {
		emit(Status{TaskID: task.TaskID, DocumentID: task.DocumentID, Stage: stage, Status: state, Message: message})
	}

	response, err := http.Get(task.DownloadURL)
	if err != nil {
		status("download", "failed", err.Error())
		return Result{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		err = fmt.Errorf("document download returned HTTP %d", response.StatusCode)
		status("download", "failed", err.Error())
		return Result{}, err
	}
	content, err := io.ReadAll(response.Body)
	if err != nil {
		status("download", "failed", err.Error())
		return Result{}, err
	}
	status("download", "completed", "Document downloaded.")

	taskDir := filepath.Join(workRoot, task.TaskID)
	if err := os.MkdirAll(taskDir, 0o700); err == nil {
		err = os.Chmod(taskDir, 0o700)
	}
	if err != nil {
		status("work-copy", "failed", err.Error())
		return Result{}, err
	}
	workCopy, err := filepath.Abs(filepath.Join(taskDir, task.DocumentID+".docx"))
	if err == nil {
		err = os.WriteFile(workCopy, content, 0o600)
	}
	if err != nil {
		status("work-copy", "failed", err.Error())
		return Result{}, err
	}
	status("work-copy", "completed", "Task-specific Work Copy created.")

	baseline := fmt.Sprintf("%x", sha256.Sum256(content))
	status("baseline", "completed", "Work Copy SHA-256 baseline recorded.")
	session, err := launcher.Open(ctx, workCopy)
	if err != nil {
		status("launch", "failed", err.Error())
		return Result{}, err
	}
	status("launch", "completed", "WPS launch requested.")
	status("observing", "started", "Observing the Work Copy.")
	return Result{WorkCopyPath: workCopy, BaselineSHA256: baseline, session: session}, nil
}

func RunSubmissionPipeline(ctx context.Context, task TaskStart, workRoot string, launcher Launcher, options PipelineOptions, emit func(Status)) (Result, error) {
	options = normalizedOptions(options)
	result, err := RunTask(ctx, task, workRoot, launcher, emit)
	if err != nil {
		return Result{}, err
	}

	pipelineContext, cancel := context.WithCancel(ctx)
	defer cancel()
	observations := make(chan observation)
	go observeWorkCopy(pipelineContext, result, options, observations)

	status := func(stage, state, kind, message, snapshotPath string) {
		emit(Status{TaskID: task.TaskID, DocumentID: task.DocumentID, Stage: stage, Status: state, Kind: kind, Message: message, SnapshotPath: snapshotPath})
	}
	terminalFailure := func(kind string, err error, snapshotPath string) (Result, error) {
		status("failed", "failed", kind, err.Error(), snapshotPath)
		return result, err
	}

	var queue []snapshot
	var submissionResults <-chan submissionResult
	observerDone := false
	changedOccurred := false
	finalHash := result.BaselineSHA256

	for {
		if submissionResults == nil && len(queue) > 0 {
			current := queue[0]
			status("submitting", "started", "submission", "Submitting immutable Snapshot.", current.path)
			completed := make(chan submissionResult, 1)
			submissionResults = completed
			go func(item snapshot) {
				completed <- submissionResult{snapshot: item, err: submitSnapshot(pipelineContext, task.UploadURL, item)}
			}(current)
		}
		if observerDone && submissionResults == nil && len(queue) == 0 {
			result.FinalSHA256 = finalHash
			if changedOccurred {
				result.Outcome = "submitted"
				status("closed", "completed", "lifecycle", "WPS closed and every Persisted Version was submitted in order.", "")
			} else {
				result.Outcome = "unchanged"
				status("closed", "completed", "lifecycle", "WPS closed without a persisted change; the current Document version is unchanged.", "")
			}
			return result, nil
		}

		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case event := <-observations:
			if event.err != nil {
				return terminalFailure("lifecycle", event.err, "")
			}
			if event.closed {
				status("draining", "started", "lifecycle", "WPS closed; checking for a final Persisted Version and draining queued Submissions.", "")
			}
			if event.snapshot != nil {
				status("stable-version", "completed", "persisted-version", "Stable Persisted Version identified.", "")
				status("persisted", "completed", "persisted-version", "Local persistence produced a distinct stable content transition.", "")
				status("snapshot", "completed", "snapshot", "Immutable Snapshot created.", event.snapshot.path)
				queue = append(queue, *event.snapshot)
			}
			if event.done {
				observerDone = true
				changedOccurred = event.changedOccurred
				finalHash = event.finalHash
				observations = nil
			}
		case completed := <-submissionResults:
			submissionResults = nil
			if completed.err != nil {
				err := fmt.Errorf("Submission failed for retained Snapshot %s: %w", completed.snapshot.path, completed.err)
				return terminalFailure("submission", err, completed.snapshot.path)
			}
			result.FinalSHA256 = completed.snapshot.hash
			status("succeeded", "completed", "submission", "Demo service accepted the Submission.", completed.snapshot.path)
			queue = queue[1:]
		}
	}
}

func normalizedOptions(options PipelineOptions) PipelineOptions {
	if options.PollInterval <= 0 {
		options.PollInterval = defaultPipelineOptions.PollInterval
	}
	if options.StabilityDuration <= 0 {
		options.StabilityDuration = defaultPipelineOptions.StabilityDuration
	}
	if options.FinalDrainDuration <= 0 {
		options.FinalDrainDuration = defaultPipelineOptions.FinalDrainDuration
	}
	return options
}

func observeWorkCopy(ctx context.Context, result Result, options PipelineOptions, events chan<- observation) {
	send := func(event observation) bool {
		select {
		case events <- event:
			return true
		case <-ctx.Done():
			return false
		}
	}

	sessionResult := make(chan error, 1)
	go func() { sessionResult <- result.session.WaitClosed(ctx) }()
	ticker := time.NewTicker(options.PollInterval)
	defer ticker.Stop()

	var candidateSize int64
	var candidateModTime time.Time
	var stableSince time.Time
	var closedAt time.Time
	lastObservedHash := result.BaselineSHA256
	finalHash := result.BaselineSHA256
	changedOccurred := false
	snapshotSequence := 0
	evaluated := false

	for {
		select {
		case <-ctx.Done():
			return
		case closeErr := <-sessionResult:
			if closeErr != nil {
				send(observation{err: closeErr})
				return
			}
			closedAt = time.Now()
			sessionResult = nil
			if !send(observation{closed: true}) {
				return
			}
		case now := <-ticker.C:
			info, statErr := os.Stat(result.WorkCopyPath)
			if statErr != nil {
				if os.IsNotExist(statErr) {
					stableSince = time.Time{}
					evaluated = false
					continue
				}
				send(observation{err: statErr})
				return
			}
			if stableSince.IsZero() || candidateSize != info.Size() || !candidateModTime.Equal(info.ModTime()) {
				candidateSize, candidateModTime, stableSince = info.Size(), info.ModTime(), now
				evaluated = false
				continue
			}
			if now.Sub(stableSince) < options.StabilityDuration {
				continue
			}
			if !evaluated {
				content, readErr := os.ReadFile(result.WorkCopyPath)
				if readErr != nil {
					stableSince = time.Time{}
					continue
				}
				current, statErr := os.Stat(result.WorkCopyPath)
				if statErr != nil || current.Size() != candidateSize || !current.ModTime().Equal(candidateModTime) {
					stableSince = time.Time{}
					continue
				}
				hash := fmt.Sprintf("%x", sha256.Sum256(content))
				finalHash = hash
				evaluated = true
				if hash != lastObservedHash {
					lastObservedHash = hash
					changedOccurred = true
					snapshotSequence++
					snapshotDir := filepath.Join(filepath.Dir(result.WorkCopyPath), "snapshots")
					err := os.MkdirAll(snapshotDir, 0o700)
					if err == nil {
						err = os.Chmod(snapshotDir, 0o700)
					}
					if err != nil {
						send(observation{err: err})
						return
					}
					snapshotPath := filepath.Join(snapshotDir, fmt.Sprintf("%06d-%s.docx", snapshotSequence, hash))
					if err := os.WriteFile(snapshotPath, content, 0o400); err != nil {
						send(observation{err: err})
						return
					}
					if !send(observation{snapshot: &snapshot{hash: hash, path: snapshotPath}}) {
						return
					}
				}
			}
			if !closedAt.IsZero() && now.Sub(closedAt) >= options.FinalDrainDuration {
				send(observation{done: true, changedOccurred: changedOccurred, finalHash: finalHash})
				return
			}
		}
	}
}

func submitSnapshot(ctx context.Context, uploadURL string, item snapshot) error {
	file, err := os.Open(item.path)
	if err != nil {
		return err
	}
	defer file.Close()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadURL, file)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("server rejected the Submission with HTTP %d", response.StatusCode)
	}
	return nil
}

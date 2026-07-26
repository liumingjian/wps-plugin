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
	if err := os.MkdirAll(taskDir, 0700); err != nil {
		status("work-copy", "failed", err.Error())
		return Result{}, err
	}
	workCopy, err := filepath.Abs(filepath.Join(taskDir, task.DocumentID+".docx"))
	if err == nil {
		err = os.WriteFile(workCopy, content, 0600)
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
	if options.PollInterval <= 0 {
		options.PollInterval = defaultPipelineOptions.PollInterval
	}
	if options.StabilityDuration <= 0 {
		options.StabilityDuration = defaultPipelineOptions.StabilityDuration
	}
	if options.FinalDrainDuration <= 0 {
		options.FinalDrainDuration = defaultPipelineOptions.FinalDrainDuration
	}
	result, err := RunTask(ctx, task, workRoot, launcher, emit)
	if err != nil {
		return Result{}, err
	}

	ticker := time.NewTicker(options.PollInterval)
	defer ticker.Stop()
	terminalFailure := func(err error) (Result, error) {
		emit(Status{TaskID: task.TaskID, DocumentID: task.DocumentID, Stage: "failed", Status: "failed", Kind: "submission", Message: err.Error()})
		return result, err
	}
	status := func(stage, state, kind, message, snapshotPath string) {
		emit(Status{TaskID: task.TaskID, DocumentID: task.DocumentID, Stage: stage, Status: state, Kind: kind, Message: message, SnapshotPath: snapshotPath})
	}
	var candidateSize int64
	var candidateModTime time.Time
	var stableSince time.Time
	var successfulHash string
	attemptedHashes := make(map[string]struct{})
	sessionContext, stopSession := context.WithCancel(ctx)
	defer stopSession()
	closeResult := make(chan error, 1)
	go func() { closeResult <- result.session.WaitClosed(sessionContext) }()
	var closedAt time.Time
	for {
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case closeErr := <-closeResult:
			if closeErr != nil {
				return terminalFailure(closeErr)
			}
			closedAt = time.Now()
			closeResult = nil
			status("draining", "started", "lifecycle", "WPS closed; checking for a final persisted change.", "")
		case now := <-ticker.C:
			info, statErr := os.Stat(result.WorkCopyPath)
			if statErr != nil {
				if os.IsNotExist(statErr) {
					stableSince = time.Time{}
					continue
				}
				return terminalFailure(statErr)
			}
			if stableSince.IsZero() || candidateSize != info.Size() || !candidateModTime.Equal(info.ModTime()) {
				candidateSize, candidateModTime, stableSince = info.Size(), info.ModTime(), now
				continue
			}
			if now.Sub(stableSince) < options.StabilityDuration {
				continue
			}
			content, readErr := os.ReadFile(result.WorkCopyPath)
			if readErr != nil {
				stableSince = time.Time{}
				continue
			}
			hash := fmt.Sprintf("%x", sha256.Sum256(content))
			if hash == result.BaselineSHA256 || hash == successfulHash {
				if !closedAt.IsZero() && now.Sub(closedAt) >= options.FinalDrainDuration {
					result.FinalSHA256 = hash
					if successfulHash != "" {
						result.Outcome = "submitted"
						return result, nil
					}
					result.Outcome = "unchanged"
					status("closed", "completed", "lifecycle", "WPS closed without a persisted change; the current Document version is unchanged.", "")
					return result, nil
				}
				if closedAt.IsZero() {
					stableSince = time.Time{}
				}
				continue
			}
			if _, alreadyAttempted := attemptedHashes[hash]; alreadyAttempted {
				stableSince = time.Time{}
				continue
			}
			attemptedHashes[hash] = struct{}{}
			status("stable-version", "completed", "persisted-version", "Stable Persisted Version identified.", "")
			status("persisted", "completed", "persisted-version", "Local persistence produced a distinct stable content hash.", "")
			snapshotDir := filepath.Join(filepath.Dir(result.WorkCopyPath), "snapshots")
			if err := os.MkdirAll(snapshotDir, 0700); err != nil {
				return terminalFailure(err)
			}
			snapshotPath := filepath.Join(snapshotDir, fmt.Sprintf("%d-%s.docx", time.Now().UnixNano(), hash))
			if err := os.WriteFile(snapshotPath, content, 0400); err != nil {
				return terminalFailure(err)
			}
			status("snapshot", "completed", "snapshot", "Immutable Snapshot created.", snapshotPath)
			status("submitting", "started", "submission", "Submitting immutable Snapshot.", snapshotPath)
			snapshot, openErr := os.Open(snapshotPath)
			if openErr != nil {
				return terminalFailure(openErr)
			}
			request, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, task.UploadURL, snapshot)
			if requestErr != nil {
				snapshot.Close()
				return terminalFailure(requestErr)
			}
			request.Header.Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
			response, submitErr := http.DefaultClient.Do(request)
			snapshot.Close()

			changedDuringSubmission := true
			if current, currentErr := os.Stat(result.WorkCopyPath); currentErr == nil {
				changedDuringSubmission = current.Size() != candidateSize || !current.ModTime().Equal(candidateModTime)
			}
			stableSince = time.Time{}
			if submitErr != nil {
				status("failed", "failed", "submission", submitErr.Error(), snapshotPath)
				continue
			}
			response.Body.Close()
			if response.StatusCode < 200 || response.StatusCode >= 300 {
				status("rejected", "failed", "submission", fmt.Sprintf("Submission rejected with HTTP %d.", response.StatusCode), snapshotPath)
				continue
			}
			successfulHash = hash
			result.FinalSHA256 = hash
			result.Outcome = "submitted"
			status("succeeded", "completed", "submission", "Demo service accepted the Submission.", snapshotPath)
			if !changedDuringSubmission {
				return result, nil
			}
		}
	}
}

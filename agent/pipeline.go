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
	TaskID     string `json:"taskId"`
	DocumentID string `json:"documentId"`
	Stage      string `json:"stage"`
	Status     string `json:"status"`
	Kind       string `json:"kind,omitempty"`
	Message    string `json:"message"`
}

type Result struct {
	WorkCopyPath   string
	BaselineSHA256 string
}

type PipelineOptions struct {
	PollInterval      time.Duration
	StabilityDuration time.Duration
}

var defaultPipelineOptions = PipelineOptions{PollInterval: 500 * time.Millisecond, StabilityDuration: 2 * time.Second}

type Launcher interface {
	Open(context.Context, string) error
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
	if err := launcher.Open(ctx, workCopy); err != nil {
		status("launch", "failed", err.Error())
		return Result{}, err
	}
	status("launch", "completed", "WPS launch requested.")
	status("observing", "started", "Observing the Work Copy.")
	return Result{WorkCopyPath: workCopy, BaselineSHA256: baseline}, nil
}

func RunSubmissionPipeline(ctx context.Context, task TaskStart, workRoot string, launcher Launcher, options PipelineOptions, emit func(Status)) (Result, error) {
	if options.PollInterval <= 0 {
		options.PollInterval = defaultPipelineOptions.PollInterval
	}
	if options.StabilityDuration <= 0 {
		options.StabilityDuration = defaultPipelineOptions.StabilityDuration
	}
	result, err := RunTask(ctx, task, workRoot, launcher, emit)
	if err != nil {
		return Result{}, err
	}

	ticker := time.NewTicker(options.PollInterval)
	defer ticker.Stop()
	fail := func(err error) (Result, error) {
		emit(Status{TaskID: task.TaskID, DocumentID: task.DocumentID, Stage: "failed", Status: "failed", Kind: "submission", Message: err.Error()})
		return result, err
	}
	var candidateSize int64
	var candidateModTime time.Time
	var stableSince time.Time
	for {
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case now := <-ticker.C:
			info, statErr := os.Stat(result.WorkCopyPath)
			if statErr != nil {
				if os.IsNotExist(statErr) {
					stableSince = time.Time{}
					continue
				}
				return fail(statErr)
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
			if hash == result.BaselineSHA256 {
				stableSince = time.Time{}
				continue
			}
			emit(Status{TaskID: task.TaskID, DocumentID: task.DocumentID, Stage: "stable-version", Status: "completed", Kind: "persisted-version", Message: "Stable Persisted Version identified."})
			snapshotDir := filepath.Join(filepath.Dir(result.WorkCopyPath), "snapshots")
			if err := os.MkdirAll(snapshotDir, 0700); err != nil {
				return fail(err)
			}
			snapshotPath := filepath.Join(snapshotDir, fmt.Sprintf("%d-%s.docx", time.Now().UnixNano(), hash))
			if err := os.WriteFile(snapshotPath, content, 0400); err != nil {
				return fail(err)
			}
			emit(Status{TaskID: task.TaskID, DocumentID: task.DocumentID, Stage: "submitting", Status: "started", Kind: "submission", Message: "Submitting immutable Snapshot."})
			snapshot, err := os.Open(snapshotPath)
			if err != nil {
				return fail(err)
			}
			request, err := http.NewRequestWithContext(ctx, http.MethodPost, task.UploadURL, snapshot)
			if err != nil {
				snapshot.Close()
				return fail(err)
			}
			request.Header.Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
			response, err := http.DefaultClient.Do(request)
			snapshot.Close()
			if err != nil {
				return fail(err)
			}
			response.Body.Close()
			if response.StatusCode < 200 || response.StatusCode >= 300 {
				return fail(fmt.Errorf("submission returned HTTP %d", response.StatusCode))
			}
			emit(Status{TaskID: task.TaskID, DocumentID: task.DocumentID, Stage: "succeeded", Status: "completed", Kind: "submission", Message: "Demo service accepted the Submission."})
			return result, nil
		}
	}
}

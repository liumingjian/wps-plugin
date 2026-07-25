package agent

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
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

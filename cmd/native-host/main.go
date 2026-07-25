package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/liumingjian/wps-plugin/agent"
)

const maxMessageSize = 1024 * 1024

type message struct {
	Version        int    `json:"version"`
	Type           string `json:"type"`
	TaskID         string `json:"taskId,omitempty"`
	DocumentID     string `json:"documentId,omitempty"`
	Status         string `json:"status"`
	Code           string `json:"code,omitempty"`
	Message        string `json:"message"`
	DownloadURL    string `json:"downloadUrl,omitempty"`
	UploadURL      string `json:"uploadUrl,omitempty"`
	Stage          string `json:"stage,omitempty"`
	WorkCopyPath   string `json:"workCopyPath,omitempty"`
	BaselineSHA256 string `json:"baselineSha256,omitempty"`
}

func writeFrame(w io.Writer, value message) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err := binary.Write(w, binary.LittleEndian, uint32(len(payload))); err != nil {
		return err
	}
	_, err = w.Write(payload)
	return err
}

func failure(code, text string) message {
	return message{Version: 1, Type: "error", Status: "failed", Code: code, Message: text}
}

func handle(r io.Reader) message {
	var length uint32
	if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
		return failure("invalid_frame_length", "Unable to read the Native Messaging frame length.")
	}
	if length == 0 || length > maxMessageSize {
		return failure("invalid_frame_length", fmt.Sprintf("Frame length %d is outside the allowed range.", length))
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return failure("invalid_frame_length", "Frame ended before its declared length.")
	}
	var request message
	if err := json.Unmarshal(payload, &request); err != nil {
		return failure("malformed_json", "The control message is not valid JSON.")
	}
	if request.Version != 1 {
		response := failure("unsupported_version", fmt.Sprintf("Protocol version %d is unsupported; expected version 1.", request.Version))
		response.TaskID, response.DocumentID = request.TaskID, request.DocumentID
		return response
	}
	if request.Type != "ping" && request.Type != "task-probe" && request.Type != "task-start" {
		response := failure("unsupported_message", "The control message type is unsupported.")
		response.TaskID, response.DocumentID = request.TaskID, request.DocumentID
		return response
	}
	if request.Type == "task-probe" && (request.TaskID == "" || request.DocumentID == "") {
		return failure("invalid_task", "A task probe requires both an Editing Task ID and a Document ID.")
	}
	if request.Type == "task-start" {
		if request.TaskID == "" || request.DocumentID == "" || request.DownloadURL == "" || request.UploadURL == "" {
			response := failure("invalid_task", "A task start requires an Editing Task ID, Document ID, download URL, and upload URL.")
			response.TaskID, response.DocumentID = request.TaskID, request.DocumentID
			return response
		}
		workRoot := filepath.Join(os.TempDir(), "wps-edit-agent")
		var latest agent.Status
		result, err := agent.RunSubmissionPipeline(context.Background(), agent.TaskStart{Version: request.Version, TaskID: request.TaskID, DocumentID: request.DocumentID, DownloadURL: request.DownloadURL, UploadURL: request.UploadURL}, workRoot, agent.LaunchServicesLauncher{}, agent.PipelineOptions{}, func(status agent.Status) { latest = status })
		if err != nil {
			response := failure("task_failed", latest.Message)
			response.TaskID, response.DocumentID, response.Stage = request.TaskID, request.DocumentID, latest.Stage
			return response
		}
		return message{Version: 1, Type: "task-started", TaskID: request.TaskID, DocumentID: request.DocumentID, Status: "accepted", Stage: latest.Stage, WorkCopyPath: result.WorkCopyPath, BaselineSHA256: result.BaselineSHA256, Message: latest.Message}
	}
	responseType := "pong"
	if request.Type == "task-probe" {
		responseType = "task-accepted"
	}
	return message{Version: 1, Type: responseType, TaskID: request.TaskID, DocumentID: request.DocumentID, Status: "accepted", Message: "Editing Task reached the local agent."}
}

func main() {
	if err := writeFrame(os.Stdout, handle(os.Stdin)); err != nil {
		os.Exit(1)
	}
}

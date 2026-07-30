package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/liumingjian/wps-plugin/agent"
)

const maxMessageSize = 1024 * 1024

type message struct {
	ProtocolVersion int                  `json:"protocolVersion,omitempty"`
	AgentVersion    string               `json:"agentVersion,omitempty"`
	Version         int                  `json:"version"`
	Type            string               `json:"type"`
	TaskID          string               `json:"taskId,omitempty"`
	DocumentID      string               `json:"documentId,omitempty"`
	Status          string               `json:"status"`
	Code            string               `json:"code,omitempty"`
	Message         string               `json:"message"`
	DownloadURL     string               `json:"downloadUrl,omitempty"`
	UploadURL       string               `json:"uploadUrl,omitempty"`
	Stage           string               `json:"stage,omitempty"`
	WorkCopyPath    string               `json:"workCopyPath,omitempty"`
	BaselineSHA256  string               `json:"baselineSha256,omitempty"`
	FinalSHA256     string               `json:"finalSha256,omitempty"`
	Outcome         string               `json:"outcome,omitempty"`
	Changed         *bool                `json:"changed,omitempty"`
	SnapshotPath    string               `json:"snapshotPath,omitempty"`
	Readiness       any                  `json:"readiness,omitempty"`
	Descriptor      agent.TaskDescriptor `json:"descriptor,omitempty"`
	Event           *agent.TaskEvent     `json:"event,omitempty"`
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
	payload, frameError, _ := readPayload(r)
	if frameError.Status != "" {
		return frameError
	}
	return handlePayload(payload)
}

func readPayload(r io.Reader) ([]byte, message, error) {
	var length uint32
	if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
		return nil, failure("invalid_frame_length", "Unable to read the Native Messaging frame length."), err
	}
	if length == 0 || length > maxMessageSize {
		return nil, failure("invalid_frame_length", fmt.Sprintf("Frame length %d is outside the allowed range.", length)), errors.New("invalid frame length")
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, failure("invalid_frame_length", "Frame ended before its declared length."), err
	}
	return payload, message{}, nil
}

func handlePayload(payload []byte) message {
	var request message
	if err := json.Unmarshal(payload, &request); err != nil {
		return failure("malformed_json", "The control message is not valid JSON.")
	}
	if request.ProtocolVersion != 0 {
		return handleProduction(request)
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
		stateRoot, err := agent.DefaultStateRoot()
		if err != nil {
			response := failure("task_failed", err.Error())
			response.TaskID, response.DocumentID = request.TaskID, request.DocumentID
			return response
		}
		lock, err := agent.AcquireTaskLock(stateRoot)
		if err != nil {
			code := "task_failed"
			if errors.Is(err, agent.ErrTaskActive) {
				code = "task_active"
			}
			response := failure(code, err.Error())
			response.TaskID, response.DocumentID = request.TaskID, request.DocumentID
			return response
		}
		defer lock.Close()
		workRoot := filepath.Join(stateRoot, "tasks")
		var latest agent.Status
		result, err := agent.RunSubmissionPipeline(context.Background(), agent.TaskStart{Version: request.Version, TaskID: request.TaskID, DocumentID: request.DocumentID, DownloadURL: request.DownloadURL, UploadURL: request.UploadURL}, workRoot, agent.NewPlatformLauncher(), agent.PipelineOptions{}, func(status agent.Status) { latest = status })
		if err != nil {
			response := failure("task_failed", latest.Message)
			response.TaskID, response.DocumentID, response.Stage, response.SnapshotPath = request.TaskID, request.DocumentID, latest.Stage, latest.SnapshotPath
			return response
		}
		changed := result.Outcome == "submitted"
		stage := "closed"
		messageText := "WPS closed without a persisted change; the current Document version is unchanged."
		if changed {
			stage = "succeeded"
			messageText = latest.Message
		}
		return message{Version: 1, Type: "task-completed", TaskID: request.TaskID, DocumentID: request.DocumentID, Status: "completed", Stage: stage, WorkCopyPath: result.WorkCopyPath, BaselineSHA256: result.BaselineSHA256, FinalSHA256: result.FinalSHA256, Outcome: result.Outcome, Changed: &changed, Message: messageText}
	}
	responseType := "pong"
	if request.Type == "task-probe" {
		responseType = "task-accepted"
	}
	return message{Version: 1, Type: responseType, TaskID: request.TaskID, DocumentID: request.DocumentID, Status: "accepted", Message: "Editing Task reached the local agent."}
}

func handleProduction(request message) message {
	if request.ProtocolVersion != 2 {
		return message{ProtocolVersion: 2, AgentVersion: buildVersion, Type: "error", Status: "failed", Code: "UNSUPPORTED_CONTRACT", Message: "Native Messaging protocol version is incompatible."}
	}
	if request.Type != "get-readiness" && request.Type != "recover-tasks" {
		return message{ProtocolVersion: 2, AgentVersion: buildVersion, Type: "error", Status: "failed", Code: "INVALID_TASK", Message: "The production message type is unsupported."}
	}
	responseType := "readiness"
	if request.Type == "recover-tasks" {
		responseType = "recovery-scan"
	}
	environment, _ := doctor(defaultSetupPaths())
	return message{
		ProtocolVersion: 2,
		AgentVersion:    buildVersion,
		Type:            responseType,
		Status:          "completed",
		Message:         "Local WPS Editing agent is available.",
		Readiness: map[string]any{
			"state":               environment.State,
			"contractVersions":    []int{1},
			"submissionProfiles":  []string{agent.RawBodyProfileV1, agent.NamedFileProfileV1},
			"environmentVerified": environment.State == "verified",
			"issues":              readinessIssues(environment),
		},
	}
}

func readinessIssues(environment commandResult) []any {
	if environment.State == "verified" {
		return []any{}
	}
	return []any{map[string]any{"code": "WPS_UNAVAILABLE", "phase": "open", "disposition": "user-action", "message": environment.Message, "action": "open-setup"}}
}

func main() {
	if len(os.Args) > 1 {
		if os.Args[1] == "manifest" {
			if err := writeManifest(os.Stdout, os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(2)
			}
			return
		}
		if os.Args[1] == "setup" || os.Args[1] == "doctor" || os.Args[1] == "unregister" || os.Args[1] == "export-diagnostics" {
			if err := runUserCommand(os.Args[1], os.Args[2:]); err != nil {
				os.Exit(2)
			}
			return
		}
		if !strings.HasPrefix(os.Args[1], "chrome-extension://") {
			fmt.Fprintf(os.Stderr, "unknown command %q\n", os.Args[1])
			os.Exit(2)
		}
	}
	for {
		payload, frameError, readErr := readPayload(os.Stdin)
		if frameError.Status != "" {
			if errors.Is(readErr, io.EOF) {
				return
			}
			_ = writeFrame(os.Stdout, frameError)
			return
		}
		var request message
		if json.Unmarshal(payload, &request) == nil && request.ProtocolVersion == 2 && (request.Type == "task-open" || request.Type == "task-resume") {
			if err := runProductionTask(os.Stdout, request); err != nil {
				_ = writeFrame(os.Stdout, message{ProtocolVersion: 2, AgentVersion: buildVersion, Type: "task-paused", TaskID: request.Descriptor.TaskID, Status: "action-required", Code: "TASK_INTERRUPTED", Message: "The Editing Task remains available for recovery."})
			}
			continue
		}
		if err := writeFrame(os.Stdout, handlePayload(payload)); err != nil {
			os.Exit(1)
		}
	}
}

func runProductionTask(output io.Writer, request message) error {
	if request.ProtocolVersion != 2 {
		return errors.New("Native Messaging protocol version is incompatible")
	}
	if err := request.Descriptor.Validate(time.Now()); err != nil {
		_ = writeFrame(output, message{ProtocolVersion: 2, AgentVersion: buildVersion, Type: "error", TaskID: request.Descriptor.TaskID, Status: "failed", Code: "INVALID_TASK", Message: err.Error()})
		return nil
	}
	stateRoot, err := agent.ProductionStateRoot()
	if err != nil {
		return err
	}
	lock, err := agent.AcquireTaskLock(stateRoot)
	if err != nil {
		code := "LOCAL_STORAGE_FAILED"
		if errors.Is(err, agent.ErrTaskActive) {
			code = "TASK_CONFLICT"
		}
		_ = writeFrame(output, message{ProtocolVersion: 2, AgentVersion: buildVersion, Type: "error", TaskID: request.Descriptor.TaskID, Status: "failed", Code: code, Message: "Another Editing Task is active or local state is unavailable."})
		return nil
	}
	defer lock.Close()
	if err := writeFrame(output, message{ProtocolVersion: 2, AgentVersion: buildVersion, Type: "task-accepted", TaskID: request.Descriptor.TaskID, Status: "accepted", Message: "The Editing Task was accepted."}); err != nil {
		return err
	}
	emit := func(event agent.TaskEvent) {
		_ = writeFrame(output, message{ProtocolVersion: 2, AgentVersion: buildVersion, Type: "task-event", TaskID: event.TaskID, Status: "completed", Event: &event})
	}
	if request.Type == "task-resume" {
		return agent.ResumeDurableTask(context.Background(), request.Descriptor, stateRoot, agent.DurableTaskOptions{}, emit)
	}
	return agent.RunDurableTask(context.Background(), request.Descriptor, stateRoot, agent.NewPlatformLauncher(), agent.DurableTaskOptions{}, emit)
}

func writeManifest(w io.Writer, args []string) error {
	flags := flag.NewFlagSet("manifest", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	hostPath := flags.String("path", "", "installed Native Messaging host path")
	origin := flags.String("origin", "", "allowed extension origin")
	if err := flags.Parse(args); err != nil {
		return fmt.Errorf("manifest options: %w", err)
	}
	if *hostPath == "" || *origin == "" || flags.NArg() != 0 {
		return errors.New("usage: native-host manifest --path <absolute-host-path> --origin <chrome-extension-origin>")
	}
	if !filepath.IsAbs(*hostPath) {
		return errors.New("Native Messaging host path must be absolute")
	}
	manifest := struct {
		Name           string   `json:"name"`
		Description    string   `json:"description"`
		Path           string   `json:"path"`
		Type           string   `json:"type"`
		AllowedOrigins []string `json:"allowed_origins"`
	}{
		Name:           "com.liumingjian.wps_edit_agent",
		Description:    "Local WPS Editing control-message agent",
		Path:           *hostPath,
		Type:           "stdio",
		AllowedOrigins: []string{*origin},
	}
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(manifest)
}

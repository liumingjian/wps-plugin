// PROTOTYPE: verifies Qaxbrowser Native Messaging on the designated Kylin host.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const maxMessageSize = 1024 * 1024

type message struct {
	Version    int    `json:"version"`
	Type       string `json:"type"`
	TaskID     string `json:"taskId,omitempty"`
	DocumentID string `json:"documentId,omitempty"`
	Status     string `json:"status"`
	Code       string `json:"code,omitempty"`
	Message    string `json:"message"`
}

type logRecord struct {
	Time      time.Time `json:"time"`
	Direction string    `json:"direction"`
	Message   message   `json:"message"`
}

func handle(request message) message {
	failed := func(code, text string) message {
		return message{
			Version: request.Version, Type: "error", TaskID: request.TaskID,
			DocumentID: request.DocumentID, Status: "failed", Code: code, Message: text,
		}
	}
	if request.Version != 1 {
		return failed("unsupported_version", fmt.Sprintf("Protocol version %d is unsupported; expected version 1.", request.Version))
	}
	switch request.Type {
	case "ping":
		return message{Version: 1, Type: "pong", TaskID: request.TaskID, DocumentID: request.DocumentID, Status: "accepted", Message: "Native Messaging ping reached the Kylin ARM64 probe."}
	case "task-probe":
		if request.TaskID == "" || request.DocumentID == "" {
			return failed("invalid_task", "An Editing Task probe requires both an Editing Task ID and a Document ID.")
		}
		return message{Version: 1, Type: "task-accepted", TaskID: request.TaskID, DocumentID: request.DocumentID, Status: "accepted", Message: "Editing Task reached the Kylin ARM64 probe."}
	default:
		return failed("unsupported_message", "The control message type is unsupported by this prototype.")
	}
}

func readFrame(reader io.Reader) (message, error) {
	var length uint32
	if err := binary.Read(reader, binary.LittleEndian, &length); err != nil {
		return message{}, err
	}
	if length == 0 || length > maxMessageSize {
		return message{}, fmt.Errorf("frame length %d is outside the allowed range", length)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return message{}, err
	}
	var request message
	if err := json.Unmarshal(payload, &request); err != nil {
		return message{}, err
	}
	return request, nil
}

func writeFrame(writer io.Writer, response message) error {
	payload, err := json.Marshal(response)
	if err != nil {
		return err
	}
	if err := binary.Write(writer, binary.LittleEndian, uint32(len(payload))); err != nil {
		return err
	}
	_, err = writer.Write(payload)
	return err
}

func appendLog(path, direction string, value message) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	return json.NewEncoder(file).Encode(logRecord{Time: time.Now(), Direction: direction, Message: value})
}

func logPath() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(executable), "..", "logs", "native-host.jsonl"), nil
}

func main() {
	path, err := logPath()
	if err != nil {
		os.Exit(1)
	}
	request, err := readFrame(bufio.NewReader(os.Stdin))
	if err != nil {
		_ = appendLog(path, "host-error", message{Version: 1, Type: "error", Status: "failed", Code: "invalid_frame", Message: err.Error()})
		os.Exit(1)
	}
	response := handle(request)
	if errors.Join(appendLog(path, "request", request), appendLog(path, "response", response), writeFrame(os.Stdout, response)) != nil {
		os.Exit(1)
	}
}

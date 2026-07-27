package protocol_test

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os/exec"
	"testing"
)

type response struct {
	Version        int    `json:"version"`
	Type           string `json:"type"`
	TaskID         string `json:"taskId"`
	DocumentID     string `json:"documentId"`
	Status         string `json:"status"`
	Code           string `json:"code"`
	Message        string `json:"message"`
	Stage          string `json:"stage"`
	WorkCopyPath   string `json:"workCopyPath"`
	BaselineSHA256 string `json:"baselineSha256"`
}

func runHost(t *testing.T, input []byte) response {
	return runHostWithArgs(t, input)
}

func runHostWithArgs(t *testing.T, input []byte, args ...string) response {
	t.Helper()
	commandArgs := append([]string{"run", "../cmd/native-host"}, args...)
	cmd := exec.Command("go", commandArgs...)
	cmd.Stdin = bytes.NewReader(input)
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("host failed: %v", err)
	}
	if len(output) < 4 {
		t.Fatalf("missing response frame: %q", output)
	}
	length := binary.LittleEndian.Uint32(output[:4])
	if int(length) != len(output)-4 {
		t.Fatalf("length=%d payload=%d", length, len(output)-4)
	}
	var got response
	if err := json.Unmarshal(output[4:], &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestPingAcceptsBrowserOriginArgument(t *testing.T) {
	got := runHostWithArgs(t, frame(`{"version":1,"type":"ping","taskId":"browser-ping"}`), "chrome-extension://mbkblmlopgjhdlandbjhpemifinfllim/")
	if got.Version != 1 || got.Type != "pong" || got.Status != "accepted" || got.TaskID != "browser-ping" {
		t.Fatalf("unexpected response: %+v", got)
	}
}

func frame(payload string) []byte {
	buf := new(bytes.Buffer)
	_ = binary.Write(buf, binary.LittleEndian, uint32(len(payload)))
	buf.WriteString(payload)
	return buf.Bytes()
}

func TestTaskProbeReturnsCorrelatedAcceptedResponse(t *testing.T) {
	got := runHost(t, frame(`{"version":1,"type":"task-probe","taskId":"task-doc-001","documentId":"doc-001"}`))
	if got.Version != 1 || got.Type != "task-accepted" || got.Status != "accepted" || got.TaskID != "task-doc-001" || got.DocumentID != "doc-001" {
		t.Fatalf("unexpected response: %+v", got)
	}
}

func TestTaskStartRequiresHTTPTransferContract(t *testing.T) {
	got := runHost(t, frame(`{"version":1,"type":"task-start","taskId":"task-doc-001","documentId":"doc-001"}`))
	if got.Status != "failed" || got.Code != "invalid_task" {
		t.Fatalf("unexpected response: %+v", got)
	}
}

func TestInvalidInputsReturnStructuredErrors(t *testing.T) {
	tests := []struct {
		name  string
		input []byte
		code  string
	}{
		{"invalid frame length", []byte{0xff, 0xff, 0xff, 0x7f}, "invalid_frame_length"},
		{"malformed JSON", frame(`{"version":`), "malformed_json"},
		{"unsupported version", frame(`{"version":2,"type":"ping","taskId":"task-1","documentId":"doc-1"}`), "unsupported_version"},
		{"task probe without identifiers", frame(`{"version":1,"type":"task-probe"}`), "invalid_task"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := runHost(t, tt.input)
			if got.Status != "failed" || got.Code != tt.code || got.Message == "" {
				t.Fatalf("unexpected error: %+v", got)
			}
		})
	}
}

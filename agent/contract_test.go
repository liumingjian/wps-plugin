package agent_test

import (
	"strings"
	"testing"
	"time"

	"github.com/liumingjian/wps-plugin/agent"
)

func TestEditingTaskDescriptorAcceptsConstrainedRawBodyContract(t *testing.T) {
	descriptor := validDescriptor()
	if err := descriptor.Validate(time.Now()); err != nil {
		t.Fatalf("valid Editing Task descriptor rejected: %v", err)
	}
}

func TestEditingTaskDescriptorRejectsLocalAndUndeclaredAuthority(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*agent.TaskDescriptor)
		want   string
	}{
		{"non-HTTP retrieval", func(task *agent.TaskDescriptor) { task.Retrieval.URL = "file:///tmp/private.docx" }, "retrieval"},
		{"URL credentials", func(task *agent.TaskDescriptor) { task.Submission.URL = "https://secret@example.test/submissions" }, "credentials"},
		{"unknown profile", func(task *agent.TaskDescriptor) { task.Submission.Profile = "page-script-v1" }, "profile"},
		{"expired capability", func(task *agent.TaskDescriptor) { task.Retrieval.ExpiresAt = time.Now().Add(-time.Minute) }, "expired"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			descriptor := validDescriptor()
			tt.mutate(&descriptor)
			err := descriptor.Validate(time.Now())
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), tt.want) {
				t.Fatalf("Validate() error = %v, want text %q", err, tt.want)
			}
		})
	}
}

func validDescriptor() agent.TaskDescriptor {
	expires := time.Now().Add(10 * time.Minute).UTC().Truncate(time.Second)
	return agent.TaskDescriptor{
		ContractVersion: 1,
		TaskID:          "task-001",
		Document: agent.DocumentDescriptor{
			DocumentID: "document-001", DisplayName: "Contract.docx", DocumentVersion: "7",
			MediaType: agent.DOCXMediaType, SizeBytes: 1024, SHA256: strings.Repeat("a", 64),
		},
		Retrieval:  agent.CapabilityEndpoint{URL: "https://oa.example.test/editing-tasks/task-001/content", Method: "GET", AuthScheme: "Bearer", AuthValue: "short-lived", ExpiresAt: expires, RedirectOrigins: []string{"https://cdn.example.test"}},
		Submission: agent.SubmissionDescriptor{CapabilityEndpoint: agent.CapabilityEndpoint{URL: "https://oa.example.test/editing-tasks/task-001/submissions", Method: "POST", AuthScheme: "Bearer", AuthValue: "short-lived", ExpiresAt: expires}, Profile: "raw-body-v1"},
		Completion: agent.CapabilityEndpoint{URL: "https://oa.example.test/editing-tasks/task-001/completion", Method: "POST", AuthScheme: "Bearer", AuthValue: "short-lived", ExpiresAt: expires},
	}
}

package agent

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	DOCXMediaType      = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	MaxDocumentBytes   = 100 << 20
	ContractVersionV1  = 1
	RawBodyProfileV1   = "raw-body-v1"
	NamedFileProfileV1 = "named-file-v1"
)

var (
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	sha256Pattern     = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)
	fieldNamePattern  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
)

type TaskDescriptor struct {
	ContractVersion      int                  `json:"contractVersion"`
	TaskID               string               `json:"taskId"`
	RequiredCapabilities []string             `json:"requiredCapabilities,omitempty"`
	Document             DocumentDescriptor   `json:"document"`
	Retrieval            CapabilityEndpoint   `json:"retrieval"`
	Submission           SubmissionDescriptor `json:"submission"`
	Completion           CapabilityEndpoint   `json:"completion"`
}

type DocumentDescriptor struct {
	DocumentID      string `json:"documentId"`
	DisplayName     string `json:"displayName"`
	DocumentVersion string `json:"documentVersion"`
	MediaType       string `json:"mediaType"`
	SizeBytes       int64  `json:"sizeBytes"`
	SHA256          string `json:"sha256"`
}

type CapabilityEndpoint struct {
	URL             string    `json:"url"`
	Method          string    `json:"method"`
	AuthScheme      string    `json:"authScheme,omitempty"`
	AuthValue       string    `json:"authValue,omitempty"`
	ExpiresAt       time.Time `json:"expiresAt"`
	RedirectOrigins []string  `json:"redirectOrigins,omitempty"`
}

type SubmissionDescriptor struct {
	CapabilityEndpoint
	Profile   string            `json:"profile"`
	FileField string            `json:"fileField,omitempty"`
	Fields    map[string]string `json:"fields,omitempty"`
}

func (task TaskDescriptor) Validate(now time.Time) error {
	if task.ContractVersion != ContractVersionV1 {
		return fmt.Errorf("unsupported contract version %d", task.ContractVersion)
	}
	if !identifierPattern.MatchString(task.TaskID) || !identifierPattern.MatchString(task.Document.DocumentID) {
		return errors.New("invalid Editing Task or Document identifier")
	}
	knownCapabilities := map[string]bool{"durable-events": true, "fifo-snapshots": true, "recovery": true, "notifications": true}
	for _, capability := range task.RequiredCapabilities {
		if !knownCapabilities[capability] {
			return fmt.Errorf("unsupported required capability %q", capability)
		}
	}
	if task.Document.MediaType != DOCXMediaType || task.Document.SizeBytes <= 0 || task.Document.SizeBytes > MaxDocumentBytes || !sha256Pattern.MatchString(task.Document.SHA256) {
		return errors.New("invalid DOCX document metadata")
	}
	if len(task.Document.DisplayName) == 0 || len(task.Document.DisplayName) > 255 || !strings.HasSuffix(strings.ToLower(task.Document.DisplayName), ".docx") || strings.ContainsAny(task.Document.DisplayName, `/\`) {
		return errors.New("Document display name must be a bounded DOCX filename")
	}
	if err := validateEndpoint("retrieval", task.Retrieval, "GET", now); err != nil {
		return err
	}
	if err := validateEndpoint("submission", task.Submission.CapabilityEndpoint, "POST", now); err != nil {
		return err
	}
	if err := validateEndpoint("completion", task.Completion, "POST", now); err != nil {
		return err
	}
	switch task.Submission.Profile {
	case RawBodyProfileV1:
		if task.Submission.FileField != "" || len(task.Submission.Fields) != 0 {
			return errors.New("raw-body-v1 profile cannot declare multipart fields")
		}
	case NamedFileProfileV1:
		if !fieldNamePattern.MatchString(task.Submission.FileField) {
			return errors.New("named-file-v1 profile requires a valid file field")
		}
		if len(task.Submission.Fields) > 16 {
			return errors.New("named-file-v1 profile has too many scalar fields")
		}
		for name, value := range task.Submission.Fields {
			if !fieldNamePattern.MatchString(name) || len(value) > 1024 {
				return errors.New("named-file-v1 profile contains an invalid scalar field")
			}
		}
	default:
		return fmt.Errorf("unsupported Submission profile %q", task.Submission.Profile)
	}
	return nil
}

func validateEndpoint(label string, endpoint CapabilityEndpoint, method string, now time.Time) error {
	if endpoint.Method != method {
		return fmt.Errorf("%s method must be %s", label, method)
	}
	parsed, err := url.Parse(endpoint.URL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("%s endpoint must use HTTP(S)", label)
	}
	if parsed.User != nil {
		return fmt.Errorf("%s endpoint URL credentials are forbidden", label)
	}
	if !endpoint.ExpiresAt.After(now) {
		return fmt.Errorf("%s capability is expired", label)
	}
	if endpoint.AuthScheme != "" && endpoint.AuthScheme != "Bearer" {
		return fmt.Errorf("%s authentication scheme is unsupported", label)
	}
	if (endpoint.AuthScheme == "") != (endpoint.AuthValue == "") {
		return fmt.Errorf("%s authentication capability is incomplete", label)
	}
	for _, origin := range endpoint.RedirectOrigins {
		redirect, err := url.Parse(origin)
		if err != nil || (redirect.Scheme != "http" && redirect.Scheme != "https") || redirect.Host == "" || redirect.User != nil || redirect.Path != "" || redirect.RawQuery != "" || redirect.Fragment != "" {
			return fmt.Errorf("%s redirect Origin %q is invalid", label, origin)
		}
	}
	if strings.EqualFold(parsed.Hostname(), "localhost") || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1" {
		return fmt.Errorf("%s loopback endpoint is unavailable outside development mode", label)
	}
	return nil
}

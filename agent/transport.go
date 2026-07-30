package agent

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path/filepath"
	"strconv"
)

type TaskTransport struct {
	client *http.Client
}

func NewTaskTransport(client *http.Client) *TaskTransport {
	if client == nil {
		client = http.DefaultClient
	}
	copy := *client
	return &TaskTransport{client: &copy}
}

func (transport *TaskTransport) Retrieve(ctx context.Context, task TaskDescriptor) ([]byte, error) {
	request, err := capabilityRequest(ctx, task.Retrieval, nil)
	if err != nil {
		return nil, err
	}
	client := transport.clientFor(task.Retrieval)
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Document retrieval returned HTTP %d", response.StatusCode)
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != DOCXMediaType {
		return nil, errors.New("Document retrieval did not return DOCX content")
	}
	limit := task.Document.SizeBytes
	if limit <= 0 || limit > MaxDocumentBytes {
		limit = MaxDocumentBytes
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(content)) != task.Document.SizeBytes {
		return nil, errors.New("retrieved Document size does not match descriptor")
	}
	hash := sha256.Sum256(content)
	if hex.EncodeToString(hash[:]) != task.Document.SHA256 {
		return nil, errors.New("retrieved Document SHA-256 does not match descriptor")
	}
	if err := validateDOCX(content); err != nil {
		return nil, err
	}
	return content, nil
}

func (transport *TaskTransport) Submit(ctx context.Context, task TaskDescriptor, snapshot SnapshotRecord, content []byte) (AcceptanceReceipt, FailureDisposition, error) {
	body := io.Reader(bytes.NewReader(content))
	contentType := DOCXMediaType
	if task.Submission.Profile == NamedFileProfileV1 {
		var encoded bytes.Buffer
		writer := multipart.NewWriter(&encoded)
		for name, value := range task.Submission.Fields {
			_ = writer.WriteField(name, value)
		}
		headers := make(textproto.MIMEHeader)
		headers.Set("Content-Disposition", fmt.Sprintf(`form-data; name=%q; filename=%q`, task.Submission.FileField, filepath.Base(task.Document.DisplayName)))
		headers.Set("Content-Type", DOCXMediaType)
		part, err := writer.CreatePart(headers)
		if err != nil {
			return AcceptanceReceipt{}, RecoveryRequired, err
		}
		if _, err := part.Write(content); err != nil {
			return AcceptanceReceipt{}, RecoveryRequired, err
		}
		if err := writer.Close(); err != nil {
			return AcceptanceReceipt{}, RecoveryRequired, err
		}
		body, contentType = &encoded, writer.FormDataContentType()
	}
	request, err := capabilityRequest(ctx, task.Submission.CapabilityEndpoint, body)
	if err != nil {
		return AcceptanceReceipt{}, RecoveryRequired, err
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("X-WPS-Snapshot-Sequence", strconv.Itoa(snapshot.Sequence))
	request.Header.Set("X-WPS-Snapshot-SHA256", snapshot.SHA256)
	request.Header.Set("Idempotency-Key", snapshot.IdempotencyKey)
	response, requestErr := transport.clientFor(task.Submission.CapabilityEndpoint).Do(request)
	if requestErr != nil {
		return AcceptanceReceipt{}, AutomaticRetry, requestErr
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		disposition := ClassifySubmissionFailure(response.StatusCode, nil, "")
		return AcceptanceReceipt{}, disposition, fmt.Errorf("Submission returned HTTP %d", response.StatusCode)
	}
	var receipt AcceptanceReceipt
	decoder := json.NewDecoder(io.LimitReader(response.Body, 64<<10))
	if err := decoder.Decode(&receipt); err != nil {
		return AcceptanceReceipt{}, AutomaticRetry, errors.New("Acceptance Receipt is missing or invalid")
	}
	if !receipt.Accepted || receipt.SubmissionID == "" || receipt.DocumentVersion == "" || receipt.AcceptedAt.IsZero() || receipt.SnapshotSHA256 != snapshot.SHA256 {
		return AcceptanceReceipt{}, AutomaticRetry, errors.New("Acceptance Receipt does not verify the exact Snapshot")
	}
	return receipt, "", nil
}

func (transport *TaskTransport) Complete(ctx context.Context, task TaskDescriptor, outcome string) (CompletionReceipt, error) {
	payload, err := json.Marshal(map[string]string{"outcome": outcome})
	if err != nil {
		return CompletionReceipt{}, err
	}
	request, err := capabilityRequest(ctx, task.Completion, bytes.NewReader(payload))
	if err != nil {
		return CompletionReceipt{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := transport.clientFor(task.Completion).Do(request)
	if err != nil {
		return CompletionReceipt{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return CompletionReceipt{}, fmt.Errorf("Editing Task completion returned HTTP %d", response.StatusCode)
	}
	var receipt CompletionReceipt
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&receipt); err != nil {
		return CompletionReceipt{}, errors.New("Completion Receipt is missing or invalid")
	}
	if !receipt.Completed || receipt.TaskID != task.TaskID || receipt.Outcome != outcome || receipt.CompletedAt.IsZero() {
		return CompletionReceipt{}, errors.New("Completion Receipt does not verify the Editing Task outcome")
	}
	return receipt, nil
}

func capabilityRequest(ctx context.Context, endpoint CapabilityEndpoint, body io.Reader) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, endpoint.Method, endpoint.URL, body)
	if err != nil {
		return nil, err
	}
	if endpoint.AuthScheme != "" {
		request.Header.Set("Authorization", endpoint.AuthScheme+" "+endpoint.AuthValue)
	}
	return request, nil
}

func (transport *TaskTransport) clientFor(endpoint CapabilityEndpoint) *http.Client {
	copy := *transport.client
	allowed := map[string]bool{}
	if parsed, err := url.Parse(endpoint.URL); err == nil {
		allowed[parsed.Scheme+"://"+parsed.Host] = true
	}
	for _, origin := range endpoint.RedirectOrigins {
		allowed[origin] = true
	}
	copy.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if len(via) > 10 || !allowed[request.URL.Scheme+"://"+request.URL.Host] {
			return errors.New("redirect Origin is not declared by the Editing Capability")
		}
		request.Header.Del("Authorization")
		return nil
	}
	return &copy
}

func validateDOCX(content []byte) error {
	reader, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return errors.New("Document is not a valid DOCX ZIP package")
	}
	var contentTypes, document bool
	for _, file := range reader.File {
		switch file.Name {
		case "[Content_Types].xml":
			contentTypes = true
		case "word/document.xml":
			document = true
		}
	}
	if !contentTypes || !document {
		return errors.New("Document is missing required DOCX package parts")
	}
	return nil
}

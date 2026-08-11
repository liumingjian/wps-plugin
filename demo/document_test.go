package demo_test

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liumingjian/wps-plugin/agent"
	"github.com/liumingjian/wps-plugin/demo"
)

const docxContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

type documentResponse struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     int    `json:"version"`
	PreviewText string `json:"previewText"`
	UpdatedAt   string `json:"updatedAt"`
}

func TestAcceptedSubmissionBecomesTheCurrentDocument(t *testing.T) {
	server := httptest.NewServer(demo.Handler())
	defer server.Close()

	initial := getDocument(t, server.URL)
	if initial.Version != 1 || initial.PreviewText != "WPS local editing fixture" {
		t.Fatalf("initial document = %#v", initial)
	}

	second := testDOCX(t, "First saved edit")
	postDocument(t, server.URL, second, http.StatusCreated)
	assertCurrentDocument(t, server.URL, 2, "First saved edit", second)

	third := testDOCX(t, "First saved edit", "Second saved edit")
	postDocument(t, server.URL, third, http.StatusCreated)
	assertCurrentDocument(t, server.URL, 3, "First saved edit\nSecond saved edit", third)
}

func TestEditingTaskContractReturnsVerifiedReceipts(t *testing.T) {
	server := httptest.NewServer(demo.Handler())
	defer server.Close()

	requestBody := strings.NewReader(`{"contractVersion":1,"documentId":"doc-001","idempotencyKey":"create-1"}`)
	response, err := http.Post(server.URL+"/editing-tasks", "application/json", requestBody)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("create Editing Task status = %d, body = %s", response.StatusCode, body)
	}
	var descriptor agent.TaskDescriptor
	if err := json.NewDecoder(response.Body).Decode(&descriptor); err != nil {
		t.Fatal(err)
	}
	initialResponse, err := http.Get(server.URL + "/documents/doc-001/content")
	if err != nil {
		t.Fatal(err)
	}
	initial, _ := io.ReadAll(initialResponse.Body)
	initialResponse.Body.Close()
	initialHash := fmt.Sprintf("%x", sha256.Sum256(initial))
	if descriptor.ContractVersion != 1 || descriptor.TaskID == "" || descriptor.Document.DocumentID != "doc-001" || descriptor.Document.DisplayName != "Demo-Document.docx" || descriptor.Document.SizeBytes != int64(len(initial)) || descriptor.Document.SHA256 != initialHash {
		t.Fatalf("Editing Task descriptor = %+v", descriptor)
	}
	if descriptor.Retrieval.URL != server.URL+"/editing-tasks/"+descriptor.TaskID+"/content" || descriptor.Submission.URL != server.URL+"/editing-tasks/"+descriptor.TaskID+"/submissions" || descriptor.Completion.URL != server.URL+"/editing-tasks/"+descriptor.TaskID+"/completion" || descriptor.Submission.Profile != agent.RawBodyProfileV1 {
		t.Fatalf("Editing Task endpoints = %+v", descriptor)
	}

	updated := testDOCX(t, "Production SDK submission")
	updatedHash := fmt.Sprintf("%x", sha256.Sum256(updated))
	submission, err := http.NewRequest(http.MethodPost, descriptor.Submission.URL, bytes.NewReader(updated))
	if err != nil {
		t.Fatal(err)
	}
	submission.Header.Set("Content-Type", docxContentType)
	submission.Header.Set("X-WPS-Snapshot-Sequence", "1")
	submission.Header.Set("X-WPS-Snapshot-SHA256", updatedHash)
	submission.Header.Set("Idempotency-Key", "snapshot-1")
	response, err = http.DefaultClient.Do(submission)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var acceptance agent.AcceptanceReceipt
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("Submission status = %d", response.StatusCode)
	}
	if err := json.NewDecoder(response.Body).Decode(&acceptance); err != nil {
		t.Fatal(err)
	}
	if !acceptance.Accepted || acceptance.SubmissionID == "" || acceptance.DocumentVersion != "2" || acceptance.SnapshotSHA256 != updatedHash || acceptance.AcceptedAt.IsZero() {
		t.Fatalf("Acceptance Receipt = %+v", acceptance)
	}

	completion, err := http.NewRequest(http.MethodPost, descriptor.Completion.URL, strings.NewReader(`{"outcome":"submitted"}`))
	if err != nil {
		t.Fatal(err)
	}
	completion.Header.Set("Content-Type", "application/json")
	response, err = http.DefaultClient.Do(completion)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var receipt agent.CompletionReceipt
	if response.StatusCode != http.StatusOK {
		t.Fatalf("Completion status = %d", response.StatusCode)
	}
	if err := json.NewDecoder(response.Body).Decode(&receipt); err != nil {
		t.Fatal(err)
	}
	if !receipt.Completed || receipt.TaskID != descriptor.TaskID || receipt.Outcome != "submitted" || receipt.CompletedAt.IsZero() {
		t.Fatalf("Completion Receipt = %+v", receipt)
	}
	assertCurrentDocument(t, server.URL, 2, "Production SDK submission", updated)
}

func TestRejectedSubmissionDoesNotReplaceTheCurrentDocument(t *testing.T) {
	server := httptest.NewServer(demo.Handler())
	defer server.Close()

	valid := testDOCX(t, "Accepted content")
	postDocument(t, server.URL, valid, http.StatusCreated)

	request, err := http.NewRequest(http.MethodPost, server.URL+"/documents/doc-001/submissions", bytes.NewReader([]byte("not a docx")))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", docxContentType)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid DOCX status = %d, want 400", response.StatusCode)
	}

	assertCurrentDocument(t, server.URL, 2, "Accepted content", valid)

	request, err = http.NewRequest(http.MethodPost, server.URL+"/documents/doc-001/submissions", bytes.NewReader(valid))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "text/plain")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("invalid content type status = %d, want 415", response.StatusCode)
	}

	assertCurrentDocument(t, server.URL, 2, "Accepted content", valid)
}

func TestSubmissionRejectsOversizedAndStructurallyInvalidDOCX(t *testing.T) {
	server := httptest.NewServer(demo.Handler())
	defer server.Close()

	oversized := bytes.Repeat([]byte("x"), (20<<20)+1)
	request, err := http.NewRequest(http.MethodPost, server.URL+"/documents/doc-001/submissions", bytes.NewReader(oversized))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", docxContentType)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized submission status = %d, want 413", response.StatusCode)
	}

	fakeDOCX := zipWithFiles(t, map[string]string{
		"word/document.xml": `<document><body><p><t>not WordprocessingML</t></p></body></document>`,
	})
	postDocument(t, server.URL, fakeDOCX, http.StatusBadRequest)

	largeXML := `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>` + strings.Repeat("x", (4<<20)+1) + `</w:t></w:r></w:p></w:body></w:document>`
	compressedLargeDOCX := zipWithFiles(t, map[string]string{
		"[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"word/document.xml":   largeXML,
	})
	postDocument(t, server.URL, compressedLargeDOCX, http.StatusBadRequest)
}

func TestDocumentEndpointsRejectUnknownDocument(t *testing.T) {
	server := httptest.NewServer(demo.Handler())
	defer server.Close()

	for _, path := range []string{"/documents/unknown", "/documents/unknown/content"} {
		response, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s status = %d, want 404", path, response.StatusCode)
		}
	}

	request, err := http.NewRequest(http.MethodPost, server.URL+"/documents/unknown/submissions", bytes.NewReader(testDOCX(t, "content")))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", docxContentType)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown submission status = %d, want 404", response.StatusCode)
	}
}

func assertCurrentDocument(t *testing.T, serverURL string, wantVersion int, wantPreview string, wantContent []byte) {
	t.Helper()
	document := getDocument(t, serverURL)
	if document.ID != "doc-001" || document.Name != "Demo Document" || document.Version != wantVersion || document.PreviewText != wantPreview || document.UpdatedAt == "" {
		t.Fatalf("current document = %#v", document)
	}

	response, err := http.Get(serverURL + "/documents/doc-001/content")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !bytes.Equal(body, wantContent) {
		t.Fatalf("current content status = %d, equal = %t", response.StatusCode, bytes.Equal(body, wantContent))
	}
	if response.Header.Get("Content-Type") != docxContentType {
		t.Fatalf("content type = %q", response.Header.Get("Content-Type"))
	}
}

func getDocument(t *testing.T, serverURL string) documentResponse {
	t.Helper()
	response, err := http.Get(serverURL + "/documents/doc-001")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("document status = %d, body = %s", response.StatusCode, body)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("cache control = %q", response.Header.Get("Cache-Control"))
	}
	var document documentResponse
	if err := json.NewDecoder(response.Body).Decode(&document); err != nil {
		t.Fatal(err)
	}
	return document
}

func postDocument(t *testing.T, serverURL string, content []byte, wantStatus int) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, serverURL+"/documents/doc-001/submissions", bytes.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", docxContentType+"; charset=binary")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != wantStatus {
		t.Fatalf("submission status = %d, want %d", response.StatusCode, wantStatus)
	}
}

func testDOCX(t *testing.T, paragraphs ...string) []byte {
	t.Helper()
	files := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"_rels/.rels":         `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
	}
	var document bytes.Buffer
	document.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`)
	for _, paragraph := range paragraphs {
		document.WriteString(`<w:p><w:r><w:t>`)
		document.WriteString(xmlEscape(paragraph))
		document.WriteString(`</w:t></w:r></w:p>`)
	}
	document.WriteString(`<w:sectPr/></w:body></w:document>`)
	files["word/document.xml"] = document.String()
	return zipWithFiles(t, files)
}

func zipWithFiles(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for name, content := range files {
		part, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func xmlEscape(value string) string {
	var output bytes.Buffer
	for _, char := range value {
		switch char {
		case '&':
			output.WriteString("&amp;")
		case '<':
			output.WriteString("&lt;")
		case '>':
			output.WriteString("&gt;")
		default:
			output.WriteRune(char)
		}
	}
	return output.String()
}

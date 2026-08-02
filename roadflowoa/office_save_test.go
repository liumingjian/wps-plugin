package roadflowoa_test

import (
	"archive/zip"
	"bytes"
	"crypto/md5"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liumingjian/wps-plugin/roadflowoa"
)

const sourcePath = "/UploadFiles/2026/quarterly-report.docx"

func TestOfficeSaveCommitsOnlyTheAuthorizedDOCXAndReturnsStrictReceipt(t *testing.T) {
	target := filepath.Join(t.TempDir(), "quarterly-report.docx")
	original := docx(t, "original")
	updated := docx(t, "committed edit")
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}
	handler := officeSaveHandler(t, target)

	response := submit(t, handler, sourcePath, updated, checksum(updated), "formId:formeditor", true)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var receipt struct {
		Success bool   `json:"Success"`
		Code    string `json:"Code"`
		Message string `json:"Message"`
		Data    struct {
			FileURL string `json:"fileurl"`
			MD5Sum  string `json:"md5sum"`
			Format  string `json:"format"`
			Bytes   int    `json:"bytes"`
		} `json:"Data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if !receipt.Success || receipt.Code != "overwrite_committed" || receipt.Data.FileURL != sourcePath ||
		receipt.Data.MD5Sum != checksum(updated) || receipt.Data.Format != "docx" || receipt.Data.Bytes != len(updated) {
		t.Fatalf("Overwrite Receipt = %+v", receipt)
	}
	stored, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, updated) {
		t.Fatal("committed Document does not contain the submitted edit")
	}
}

func TestOfficeSaveFailuresPreserveTheOriginalDocument(t *testing.T) {
	tests := []struct {
		name       string
		path       string
		payload    []byte
		md5sum     string
		metadata   string
		authorized bool
		status     int
		code       string
	}{
		{name: "missing session", path: sourcePath, payload: docx(t, "edit"), authorized: false, status: 401, code: "session_required"},
		{name: "traversal", path: "/UploadFiles/2026/../secret.docx", payload: docx(t, "edit"), authorized: true, status: 403, code: "overwrite_forbidden"},
		{name: "unauthorized path", path: "/UploadFiles/2026/other.docx", payload: docx(t, "edit"), authorized: true, status: 403, code: "overwrite_forbidden"},
		{name: "wrong checksum", path: sourcePath, payload: docx(t, "edit"), md5sum: strings.Repeat("0", 32), metadata: "formId:formeditor", authorized: true, status: 400, code: "checksum_mismatch"},
		{name: "wrong metadata", path: sourcePath, payload: docx(t, "edit"), metadata: "sourcePath:/UploadFiles/redirect.docx", authorized: true, status: 400, code: "invalid_multipart"},
		{name: "invalid docx", path: sourcePath, payload: []byte("not a docx"), metadata: "formId:formeditor", authorized: true, status: 400, code: "format_mismatch"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			target := filepath.Join(t.TempDir(), "quarterly-report.docx")
			original := docx(t, "original")
			if err := os.WriteFile(target, original, 0o600); err != nil {
				t.Fatal(err)
			}
			if test.md5sum == "" {
				test.md5sum = checksum(test.payload)
			}
			if test.metadata == "" {
				test.metadata = "formId:formeditor"
			}
			response := submit(t, officeSaveHandler(t, target), test.path, test.payload, test.md5sum, test.metadata, test.authorized)
			assertFailure(t, response, test.status, test.code)
			stored, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(stored, original) {
				t.Fatal("failed overwrite changed original bytes")
			}
		})
	}
}

func TestOfficeSaveMissingOriginalAndCommitFailureHaveNoSuccessReceipt(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "missing.docx")
	response := submit(t, officeSaveHandler(t, missing), sourcePath, docx(t, "edit"), "", "formId:formeditor", true)
	assertFailure(t, response, 404, "original_missing")

	directoryTarget := filepath.Join(root, "cannot-replace.docx")
	if err := os.Mkdir(directoryTarget, 0o700); err != nil {
		t.Fatal(err)
	}
	response = submit(t, officeSaveHandler(t, directoryTarget), sourcePath, docx(t, "edit"), "", "formId:formeditor", true)
	assertFailure(t, response, 500, "commit_failed")
	if info, err := os.Stat(directoryTarget); err != nil || !info.IsDir() {
		t.Fatal("commit failure changed original target")
	}
}

func officeSaveHandler(t *testing.T, target string) http.Handler {
	t.Helper()
	handler, err := roadflowoa.NewOfficeSaveHandler(roadflowoa.OfficeSaveConfig{
		Documents:     map[string]string{sourcePath: target},
		Authenticated: func(request *http.Request) bool { return request.Header.Get("Cookie") == "oa_session=valid" },
		Authorized:    func(_ *http.Request, path string) bool { return path == sourcePath },
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func submit(t *testing.T, handler http.Handler, path string, payload []byte, md5sum, metadata string, authenticated bool) *httptest.ResponseRecorder {
	t.Helper()
	if md5sum == "" {
		md5sum = checksum(payload)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("md5sum", md5sum)
	_ = writer.WriteField("filename", metadata)
	part, err := writer.CreateFormFile("filedata", "attacker-controlled.docx")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/RoadFlow/uploadfiles/OfficeSave?fileurl="+path, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	if authenticated {
		request.Header.Set("Cookie", "oa_session=valid")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertFailure(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", response.Code, status, response.Body.String())
	}
	var failure struct {
		Success bool
		Code    string
		Data    any
	}
	if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil {
		t.Fatal(err)
	}
	if failure.Success || failure.Code != code || failure.Data != nil {
		t.Fatalf("failure = %+v", failure)
	}
}

func checksum(content []byte) string { return fmt.Sprintf("%x", md5.Sum(content)) }

func docx(t *testing.T, text string) []byte {
	t.Helper()
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	files := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"_rels/.rels":         `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		"word/document.xml":   fmt.Sprintf(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>%s</w:t></w:r></w:p></w:body></w:document>`, text),
	}
	for name, content := range files {
		file, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(file, content); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

package roadflowoa_test

import (
	"archive/zip"
	"bytes"
	"crypto/md5"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/liumingjian/wps-plugin/roadflowoa"
)

const (
	sourcePath            = "/UploadFiles/2026/quarterly-report.docx"
	docSourcePath         = "/UploadFiles/2026/legacy-report.doc"
	spreadsheetSourcePath = "/UploadFiles/2026/quarterly-report.xlsx"
)

func TestDocumentFormatSupportsWPSAndExcelSerializations(t *testing.T) {
	for _, test := range []struct {
		path   string
		format string
	}{
		{path: "/UploadFiles/2026/legacy-report.WPS", format: "wps"},
		{path: "/UploadFiles/2026/legacy-report.XLS", format: "xls"},
		{path: "/UploadFiles/2026/quarterly-report.XLSX", format: "xlsx"},
	} {
		if format := roadflowoa.DocumentFormat(test.path); format != test.format {
			t.Errorf("DocumentFormat(%q) = %q, want %q", test.path, format, test.format)
		}
		if format := roadflowoa.WordFormat(test.path); format != "" {
			t.Errorf("WordFormat(%q) = %q, want empty for non-Word formats", test.path, format)
		}
	}
}

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

func TestOfficeSaveCommitsOnlyTheAuthorizedXLSXAndReturnsStrictReceipt(t *testing.T) {
	target := filepath.Join(t.TempDir(), "quarterly-report.xlsx")
	original := xlsx(t, true)
	updated := xlsx(t, true)
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}

	response := submit(t, officeSaveHandlerFor(t, spreadsheetSourcePath, target), spreadsheetSourcePath, updated, "", "formId:formeditor", true)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var receipt struct {
		Success bool   `json:"Success"`
		Code    string `json:"Code"`
		Data    struct {
			FileURL string `json:"fileurl"`
			Format  string `json:"format"`
			Bytes   int    `json:"bytes"`
		} `json:"Data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if !receipt.Success || receipt.Code != "overwrite_committed" || receipt.Data.FileURL != spreadsheetSourcePath ||
		receipt.Data.Format != "xlsx" || receipt.Data.Bytes != len(updated) {
		t.Fatalf("Overwrite Receipt = %+v", receipt)
	}
	stored, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, updated) {
		t.Fatal("committed XLSX does not contain the submitted edit")
	}
}

func TestOfficeSaveAcceptsNativeETUploadForAnAuthorizedXLSX(t *testing.T) {
	target := filepath.Join(t.TempDir(), "quarterly-report.xlsx")
	original := xlsx(t, true)
	updated := xlsx(t, true)
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}

	response := submitNativeET(t, officeSaveHandlerFor(t, spreadsheetSourcePath, target), spreadsheetSourcePath, updated)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var receipt struct {
		Success bool   `json:"Success"`
		Code    string `json:"Code"`
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
	if !receipt.Success || receipt.Code != "overwrite_committed" || receipt.Data.FileURL != spreadsheetSourcePath ||
		receipt.Data.MD5Sum != checksum(updated) || receipt.Data.Format != "xlsx" || receipt.Data.Bytes != len(updated) {
		t.Fatalf("Overwrite Receipt = %+v", receipt)
	}
	stored, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, updated) {
		t.Fatal("native ET upload did not replace the XLSX")
	}
}

func TestOfficeSaveRejectsAnIncompleteXLSX(t *testing.T) {
	target := filepath.Join(t.TempDir(), "quarterly-report.xlsx")
	original := xlsx(t, true)
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}
	response := submit(t, officeSaveHandlerFor(t, spreadsheetSourcePath, target), spreadsheetSourcePath, xlsx(t, false), "", "formId:formeditor", true)
	assertFailure(t, response, http.StatusBadRequest, "format_mismatch")
	stored, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, original) {
		t.Fatal("invalid XLSX changed original bytes")
	}
}

func TestOfficeSaveCommitsOnlyTheAuthorizedDOCAndReturnsStrictReceipt(t *testing.T) {
	target := filepath.Join(t.TempDir(), "legacy-report.doc")
	original := doc(t, "original.doc")
	updated := doc(t, "updated.doc")
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}

	response := submit(t, officeSaveHandlerFor(t, docSourcePath, target), docSourcePath, updated, "", "formId:formeditor", true)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var receipt struct {
		Success bool   `json:"Success"`
		Code    string `json:"Code"`
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
	if !receipt.Success || receipt.Code != "overwrite_committed" || receipt.Data.FileURL != docSourcePath ||
		receipt.Data.MD5Sum != checksum(updated) || receipt.Data.Format != "doc" || receipt.Data.Bytes != len(updated) {
		t.Fatalf("Overwrite Receipt = %+v", receipt)
	}
	stored, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, updated) {
		t.Fatal("committed DOC does not contain the submitted edit")
	}
}

func TestOfficeSaveRejectsUnrelatedSerializationChangesForDOCAndDOCXTargets(t *testing.T) {
	tests := []struct {
		name       string
		sourcePath string
		original   []byte
		payload    []byte
	}{
		{name: "DOC target receives DOCX", sourcePath: docSourcePath, original: doc(t, "original.doc"), payload: docx(t, "wrong serialization")},
		{name: "DOCX target receives XLSX", sourcePath: sourcePath, original: docx(t, "original"), payload: xlsx(t, true)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			target := filepath.Join(t.TempDir(), filepath.Base(test.sourcePath))
			if err := os.WriteFile(target, test.original, 0o600); err != nil {
				t.Fatal(err)
			}
			response := submit(t, officeSaveHandlerFor(t, test.sourcePath, target), test.sourcePath, test.payload, "", "formId:formeditor", true)
			assertFailure(t, response, http.StatusBadRequest, "format_mismatch")
			stored, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(stored, test.original) {
				t.Fatal("format mismatch changed original bytes")
			}
		})
	}
}

func TestOfficeSaveAcceptsLegacyWordSerializationForDOCXTarget(t *testing.T) {
	target := filepath.Join(t.TempDir(), "quarterly-report.docx")
	original := docx(t, "original")
	updated := doc(t, "updated.doc")
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}

	response := submit(t, officeSaveHandlerFor(t, sourcePath, target), sourcePath, updated, "", "formId:formeditor", true)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	stored, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, updated) {
		t.Fatal("legacy Word serialization was not committed")
	}
}

func TestOfficeSaveDOCValidationFailuresPreserveTheOriginalDocument(t *testing.T) {
	original := doc(t, "original.doc")
	invalidFIB := append([]byte(nil), doc(t, "updated.doc")...)
	wordFIB := bytes.Index(invalidFIB, []byte{0xec, 0xa5, 0xc1, 0x00})
	if wordFIB < 0 {
		t.Fatal("DOC fixture does not contain the expected Word FIB")
	}
	invalidFIB[wordFIB] = 0
	invalidLayout := append([]byte(nil), doc(t, "updated.doc")...)
	wordFIB = bytes.Index(invalidLayout, []byte{0xec, 0xa5, 0xc1, 0x00})
	if wordFIB < 0 {
		t.Fatal("DOC fixture does not contain the expected Word FIB")
	}
	invalidLayout[wordFIB+32] = 0
	invalidLayout[wordFIB+33] = 0

	for _, test := range []struct {
		name    string
		payload []byte
	}{
		{name: "CFB without WordDocument", payload: doc(t, "not-doc.cfb")},
		{name: "invalid Word FIB", payload: invalidFIB},
		{name: "incomplete Word FIB layout", payload: invalidLayout},
		{name: "malformed CFB", payload: []byte("not a compound document")},
	} {
		t.Run(test.name, func(t *testing.T) {
			target := filepath.Join(t.TempDir(), "legacy-report.doc")
			if err := os.WriteFile(target, original, 0o600); err != nil {
				t.Fatal(err)
			}
			response := submit(t, officeSaveHandlerFor(t, docSourcePath, target), docSourcePath, test.payload, "", "formId:formeditor", true)
			assertFailure(t, response, http.StatusBadRequest, "format_mismatch")
			stored, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(stored, original) {
				t.Fatal("invalid DOC changed original bytes")
			}
		})
	}
}

func TestCommittedOverwritePassesAFreshHandoffAndReopens(t *testing.T) {
	target := filepath.Join(t.TempDir(), "quarterly-report.docx")
	if err := os.WriteFile(target, docx(t, "original"), 0o600); err != nil {
		t.Fatal(err)
	}
	overwrite := officeSaveHandler(t, target)
	const freshHandoff = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	var receiptMu sync.Mutex
	var deliveryReceipt map[string]any

	mux := http.NewServeMux()
	mux.Handle("POST /RoadFlow/uploadfiles/OfficeSave", overwrite)
	mux.HandleFunc("GET "+sourcePath, func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Cookie") != "oa_session=valid" {
			http.Error(response, "session required", http.StatusUnauthorized)
			return
		}
		content, err := os.ReadFile(target)
		if err != nil {
			http.Error(response, "missing", http.StatusNotFound)
			return
		}
		response.Header().Set("Cache-Control", "no-store")
		_, _ = response.Write(content)
	})
	mux.HandleFunc("GET /wps/document", func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("fileurl") != sourcePath || request.URL.Query().Get("_wpsHandoff") != freshHandoff {
			http.Error(response, "invalid handoff", http.StatusForbidden)
			return
		}
		content, err := os.ReadFile(target)
		if err != nil {
			http.Error(response, "missing", http.StatusNotFound)
			return
		}
		digest := fmt.Sprintf("%x", sha256.Sum256(content))
		receiptMu.Lock()
		deliveryReceipt = map[string]any{
			"handoff": freshHandoff, "sourcePath": sourcePath, "actualFormat": "docx",
			"byteCount": len(content), "sha256": digest,
		}
		receiptMu.Unlock()
		_, _ = response.Write(content)
	})
	mux.HandleFunc("GET /wps/delivery-receipt", func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("handoff") != freshHandoff {
			http.Error(response, "invalid handoff", http.StatusForbidden)
			return
		}
		receiptMu.Lock()
		defer receiptMu.Unlock()
		if deliveryReceipt == nil {
			http.Error(response, "not delivered", http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(response).Encode(deliveryReceipt)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	committed := docx(t, "committed edit rendered after reopen")
	body, contentType := multipartRequest(t, committed, "")
	request, err := http.NewRequest(http.MethodPost, server.URL+"/RoadFlow/uploadfiles/OfficeSave?fileurl="+sourcePath, body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Cookie", "oa_session=valid")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("overwrite status = %d", response.StatusCode)
	}

	sourceRequest, err := http.NewRequest(http.MethodGet, server.URL+sourcePath, nil)
	if err != nil {
		t.Fatal(err)
	}
	sourceRequest.Header.Set("Cookie", "oa_session=valid")
	sourceResponse, err := http.DefaultClient.Do(sourceRequest)
	if err != nil {
		t.Fatal(err)
	}
	sourceBytes, _ := io.ReadAll(sourceResponse.Body)
	sourceResponse.Body.Close()
	if sourceResponse.StatusCode != http.StatusOK {
		t.Fatalf("fresh Edit Entry source status = %d", sourceResponse.StatusCode)
	}
	gatewayResponse, err := http.Get(server.URL + "/wps/document?fileurl=" + sourcePath + "&_wpsHandoff=" + freshHandoff)
	if err != nil {
		t.Fatal(err)
	}
	openedBytes, _ := io.ReadAll(gatewayResponse.Body)
	gatewayResponse.Body.Close()
	if gatewayResponse.StatusCode != http.StatusOK {
		t.Fatalf("fresh Gateway open status = %d", gatewayResponse.StatusCode)
	}
	receiptResponse, err := http.Get(server.URL + "/wps/delivery-receipt?handoff=" + freshHandoff)
	if err != nil {
		t.Fatal(err)
	}
	var freshReceipt map[string]any
	if receiptResponse.StatusCode != http.StatusOK {
		t.Fatalf("fresh receipt status = %d", receiptResponse.StatusCode)
	}
	if err := json.NewDecoder(receiptResponse.Body).Decode(&freshReceipt); err != nil {
		t.Fatal(err)
	}
	receiptResponse.Body.Close()
	committedSHA256 := fmt.Sprintf("%x", sha256.Sum256(committed))
	if !bytes.Equal(sourceBytes, committed) || !bytes.Equal(openedBytes, committed) ||
		freshReceipt["handoff"] != freshHandoff || freshReceipt["sourcePath"] != sourcePath ||
		freshReceipt["sha256"] != committedSHA256 || freshReceipt["byteCount"] != float64(len(committed)) {
		t.Fatalf("fresh reopen did not render committed Document: receipt=%+v", freshReceipt)
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
		{name: "double encoded traversal", path: "/UploadFiles/2026/%252e%252e/secret.docx", payload: docx(t, "edit"), authorized: true, status: 403, code: "overwrite_forbidden"},
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

func TestOfficeSaveRequiresEveryExactMultipartField(t *testing.T) {
	target := filepath.Join(t.TempDir(), "quarterly-report.docx")
	original := docx(t, "original")
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, variant := range []string{"md5sum", "filename", "filedata", "extra"} {
		t.Run(variant, func(t *testing.T) {
			body, contentType := multipartRequest(t, docx(t, "edit"), variant)
			request := httptest.NewRequest(http.MethodPost, "/RoadFlow/uploadfiles/OfficeSave?fileurl="+sourcePath, body)
			request.Header.Set("Content-Type", contentType)
			request.Header.Set("Cookie", "oa_session=valid")
			response := httptest.NewRecorder()
			officeSaveHandler(t, target).ServeHTTP(response, request)
			assertFailure(t, response, http.StatusBadRequest, "invalid_multipart")
			stored, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(stored, original) {
				t.Fatal("invalid multipart changed original bytes")
			}
		})
	}
}

func TestOfficeSaveDoesNotRecreateAnOriginalThatVanishesBeforeCommit(t *testing.T) {
	target := filepath.Join(t.TempDir(), "quarterly-report.docx")
	if err := os.WriteFile(target, docx(t, "original"), 0o600); err != nil {
		t.Fatal(err)
	}
	body, contentType := multipartRequest(t, docx(t, "edit"), "")
	request := httptest.NewRequest(http.MethodPost, "/RoadFlow/uploadfiles/OfficeSave?fileurl="+sourcePath, &removeOnFirstRead{
		Reader: body,
		remove: func() {
			if err := os.Remove(target); err != nil {
				t.Errorf("remove original during request: %v", err)
			}
		},
	})
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Cookie", "oa_session=valid")
	response := httptest.NewRecorder()
	officeSaveHandler(t, target).ServeHTTP(response, request)
	assertFailure(t, response, http.StatusInternalServerError, "commit_failed")
	if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed conditional overwrite recreated target: %v", err)
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
	return officeSaveHandlerFor(t, sourcePath, target)
}

func officeSaveHandlerFor(t *testing.T, documentPath, target string) http.Handler {
	t.Helper()
	handler, err := roadflowoa.NewOfficeSaveHandler(roadflowoa.OfficeSaveConfig{
		Documents:     map[string]string{documentPath: target},
		Authenticated: func(request *http.Request) bool { return request.Header.Get("Cookie") == "oa_session=valid" },
		Authorized:    func(_ *http.Request, path string) bool { return path == documentPath },
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func doc(t *testing.T, name string) []byte {
	t.Helper()
	content, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return content
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

func submitNativeET(t *testing.T, handler http.Handler, path string, payload []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename=""`)
	header.Set("Content-Type", "application/octet-stream")
	part, err := writer.CreatePart(header)
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
	request.Header.Set("Cookie", "oa_session=valid")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func multipartRequest(t *testing.T, payload []byte, omittedOrExtra string) (*bytes.Reader, string) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if omittedOrExtra != "md5sum" {
		_ = writer.WriteField("md5sum", checksum(payload))
	}
	if omittedOrExtra != "filename" {
		_ = writer.WriteField("filename", "formId:formeditor")
	}
	if omittedOrExtra != "filedata" {
		part, err := writer.CreateFormFile("filedata", "ignored.docx")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(payload); err != nil {
			t.Fatal(err)
		}
	}
	if omittedOrExtra == "extra" {
		_ = writer.WriteField("sourcePath", "/UploadFiles/redirect.docx")
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return bytes.NewReader(body.Bytes()), writer.FormDataContentType()
}

type removeOnFirstRead struct {
	io.Reader
	remove func()
}

func (reader *removeOnFirstRead) Read(buffer []byte) (int, error) {
	if reader.remove != nil {
		reader.remove()
		reader.remove = nil
	}
	return reader.Reader.Read(buffer)
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

func xlsx(t *testing.T, includeSheet bool) []byte {
	t.Helper()
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	files := []struct {
		name    string
		content string
	}{
		{name: "[Content_Types].xml", content: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`},
		{name: "_rels/.rels", content: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
		{name: "xl/workbook.xml", content: `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>`},
	}
	if !includeSheet {
		files[2].content = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>`
	}
	for _, entry := range files {
		file, err := archive.Create(entry.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(file, entry.content); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

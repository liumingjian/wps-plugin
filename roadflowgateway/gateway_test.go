package roadflowgateway_test

import (
	"bytes"
	"crypto/md5"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/liumingjian/wps-plugin/roadflowgateway"
	"github.com/liumingjian/wps-plugin/roadflowoa"
)

const (
	docPath = "/UploadFiles/2026/legacy-report.doc"
	handoff = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

func TestCommittedDOCIsDeliveredAndReceiptedThroughAFreshHandoff(t *testing.T) {
	target := filepath.Join(t.TempDir(), "legacy-report.doc")
	original := fixture(t, "original.doc")
	committed := fixture(t, "updated.doc")
	if err := os.WriteFile(target, original, 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 2, 9, 0, 0, 0, time.UTC)
	gateway := gatewayHandler(t, target, func() time.Time { return now })
	overwrite, err := roadflowoa.NewOfficeSaveHandler(roadflowoa.OfficeSaveConfig{
		Documents:     map[string]string{docPath: target},
		Authenticated: func(request *http.Request) bool { return request.Header.Get("Cookie") == "oa_session=valid" },
		Authorized:    func(_ *http.Request, sourcePath string) bool { return sourcePath == docPath },
	})
	if err != nil {
		t.Fatal(err)
	}

	firstBytes, firstReceipt := deliver(t, gateway, handoff)
	if !bytes.Equal(firstBytes, original) || firstReceipt.ActualFormat != "doc" {
		t.Fatal("initial handoff did not deliver the original DOC")
	}
	response := submit(t, overwrite, committed)
	if response.Code != http.StatusOK {
		t.Fatalf("overwrite status = %d, body = %s", response.Code, response.Body.String())
	}

	freshHandoff := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	now = now.Add(time.Second)
	reopened, receipt := deliver(t, gateway, freshHandoff)
	if !bytes.Equal(reopened, committed) || bytes.Equal(reopened, firstBytes) || receipt.Handoff != freshHandoff ||
		receipt.SourcePath != docPath || receipt.ActualFormat != "doc" || receipt.ByteCount != len(committed) {
		t.Fatalf("fresh handoff did not reopen committed DOC: %+v", receipt)
	}
}

func TestInvalidIncompleteOversizedAndStaleDOCDeliveriesHaveNoReceipt(t *testing.T) {
	now := time.Date(2026, 8, 2, 9, 0, 0, 0, time.UTC)
	for _, test := range []struct {
		name    string
		prepare func(*testing.T, string)
		writer  http.ResponseWriter
		status  int
	}{
		{name: "malformed", prepare: func(t *testing.T, target string) { write(t, target, []byte("not DOC")) }, status: 422},
		{name: "mismatched DOCX", prepare: func(t *testing.T, target string) { write(t, target, []byte("PK\x03\x04not DOC")) }, status: 422},
		{name: "oversized", prepare: func(t *testing.T, target string) {
			file, err := os.Create(target)
			if err != nil {
				t.Fatal(err)
			}
			if err := file.Truncate(roadflowoa.MaxDocumentBytes + 1); err != nil {
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
		}, status: 422},
		{name: "incomplete response", prepare: func(t *testing.T, target string) { write(t, target, fixture(t, "original.doc")) }, writer: &shortWriter{}, status: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			target := filepath.Join(t.TempDir(), "legacy-report.doc")
			test.prepare(t, target)
			gateway := gatewayHandler(t, target, func() time.Time { return now })
			writer := test.writer
			if writer == nil {
				writer = httptest.NewRecorder()
			}
			request := httptest.NewRequest(http.MethodGet, "/wps/document?fileurl="+docPath+"&_wpsHandoff="+handoff, nil)
			gateway.ServeHTTP(writer, request)
			if recorder, ok := writer.(*httptest.ResponseRecorder); ok && recorder.Code != test.status {
				t.Fatalf("delivery status = %d, want %d", recorder.Code, test.status)
			}
			assertMissingReceipt(t, gateway, handoff)
		})
	}

	target := filepath.Join(t.TempDir(), "legacy-report.doc")
	write(t, target, fixture(t, "original.doc"))
	gateway := gatewayHandler(t, target, func() time.Time { return now })
	deliver(t, gateway, handoff)
	now = now.Add(5 * time.Second)
	assertMissingReceipt(t, gateway, handoff)
}

func TestConflictingHandoffReceiptRemainsConflicted(t *testing.T) {
	target := filepath.Join(t.TempDir(), "legacy-report.doc")
	original := fixture(t, "original.doc")
	updated := fixture(t, "updated.doc")
	write(t, target, original)
	now := time.Date(2026, 8, 2, 9, 0, 0, 0, time.UTC)
	gateway := gatewayHandler(t, target, func() time.Time { return now })
	deliver(t, gateway, handoff)

	write(t, target, updated)
	now = now.Add(time.Second)
	delivery := httptest.NewRecorder()
	gateway.ServeHTTP(delivery, httptest.NewRequest(http.MethodGet, "/wps/document?fileurl="+docPath+"&_wpsHandoff="+handoff, nil))
	if delivery.Code != http.StatusOK {
		t.Fatalf("conflicting delivery status = %d", delivery.Code)
	}

	write(t, target, original)
	now = now.Add(-time.Second)
	delivery = httptest.NewRecorder()
	gateway.ServeHTTP(delivery, httptest.NewRequest(http.MethodGet, "/wps/document?fileurl="+docPath+"&_wpsHandoff="+handoff, nil))

	lookup := httptest.NewRequest(http.MethodGet, "/wps/delivery-receipt?handoff="+handoff, nil)
	lookup.Header.Set("Origin", roadflowgateway.ExtensionOrigin)
	response := httptest.NewRecorder()
	gateway.ServeHTTP(response, lookup)
	if response.Code != http.StatusConflict {
		t.Fatalf("receipt status = %d, want 409", response.Code)
	}
}

type receipt struct {
	ActualFormat string `json:"actualFormat"`
	ByteCount    int    `json:"byteCount"`
	Handoff      string `json:"handoff"`
	SHA256       string `json:"sha256"`
	SourcePath   string `json:"sourcePath"`
}

func gatewayHandler(t *testing.T, target string, now func() time.Time) http.Handler {
	t.Helper()
	handler, err := roadflowgateway.NewHandler(roadflowgateway.Config{
		Documents: map[string]string{docPath: target}, ReceiptTTL: 5 * time.Second, Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func deliver(t *testing.T, gateway http.Handler, handoffID string) ([]byte, receipt) {
	t.Helper()
	delivery := httptest.NewRecorder()
	gateway.ServeHTTP(delivery, httptest.NewRequest(http.MethodGet, "/wps/document?fileurl="+docPath+"&_wpsHandoff="+handoffID, nil))
	if delivery.Code != http.StatusOK {
		t.Fatalf("delivery status = %d, body = %s", delivery.Code, delivery.Body.String())
	}
	lookup := httptest.NewRequest(http.MethodGet, "/wps/delivery-receipt?handoff="+handoffID, nil)
	lookup.Header.Set("Origin", roadflowgateway.ExtensionOrigin)
	recorded := httptest.NewRecorder()
	gateway.ServeHTTP(recorded, lookup)
	if recorded.Code != http.StatusOK {
		t.Fatalf("receipt status = %d, body = %s", recorded.Code, recorded.Body.String())
	}
	var result receipt
	if err := json.Unmarshal(recorded.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return delivery.Body.Bytes(), result
}

func assertMissingReceipt(t *testing.T, gateway http.Handler, handoffID string) {
	t.Helper()
	lookup := httptest.NewRequest(http.MethodGet, "/wps/delivery-receipt?handoff="+handoffID, nil)
	lookup.Header.Set("Origin", roadflowgateway.ExtensionOrigin)
	response := httptest.NewRecorder()
	gateway.ServeHTTP(response, lookup)
	if response.Code != http.StatusNotFound {
		t.Fatalf("receipt status = %d, want 404", response.Code)
	}
}

func submit(t *testing.T, handler http.Handler, payload []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("md5sum", fmt.Sprintf("%x", md5.Sum(payload)))
	_ = writer.WriteField("filename", "formId:formeditor")
	part, err := writer.CreateFormFile("filedata", "ignored.doc")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/RoadFlow/uploadfiles/OfficeSave?fileurl="+docPath, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Cookie", "oa_session=valid")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	content, err := os.ReadFile(filepath.Join("..", "roadflowoa", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func write(t *testing.T, target string, payload []byte) {
	t.Helper()
	if err := os.WriteFile(target, payload, 0o600); err != nil {
		t.Fatal(err)
	}
}

type shortWriter struct{ header http.Header }

func (writer *shortWriter) Header() http.Header {
	if writer.header == nil {
		writer.header = http.Header{}
	}
	return writer.header
}
func (*shortWriter) WriteHeader(int) {}
func (*shortWriter) Write(payload []byte) (int, error) {
	return len(payload) / 2, errors.New("connection closed")
}

var _ io.Writer = (*shortWriter)(nil)

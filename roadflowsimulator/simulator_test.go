package roadflowsimulator_test

import (
	"bytes"
	"crypto/md5"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liumingjian/wps-plugin/roadflowgateway"
	"github.com/liumingjian/wps-plugin/roadflowsimulator"
)

func TestInstalledCRXCanUseTheSimulatedCustomerEnvironment(t *testing.T) {
	simulator, err := roadflowsimulator.New(roadflowsimulator.Config{
		StateDir:        t.TempDir(),
		OAOrigin:        "http://127.0.0.1:4317",
		GatewayOrigin:   "http://127.0.0.1:4318",
		InitialDocument: fixture(t, "original.doc"),
	})
	if err != nil {
		t.Fatal(err)
	}

	loginPage := serve(simulator.OAHandler, http.MethodGet, "/", nil, "")
	if loginPage.Code != http.StatusOK || !strings.Contains(loginPage.Body.String(), "模拟登录") {
		t.Fatalf("anonymous OA page = %d %q", loginPage.Code, loginPage.Body.String())
	}
	login := serve(simulator.OAHandler, http.MethodPost, "/login", nil, "")
	if login.Code != http.StatusSeeOther || len(login.Result().Cookies()) != 1 {
		t.Fatalf("login = %d, cookies = %v", login.Code, login.Result().Cookies())
	}
	cookie := login.Result().Cookies()[0].String()

	oaPage := serve(simulator.OAHandler, http.MethodGet, "/", nil, cookie)
	if oaPage.Code != http.StatusOK || !strings.Contains(oaPage.Body.String(), roadflowsimulator.SourcePath) ||
		!strings.Contains(oaPage.Body.String(), simulator.GatewayTemplate) {
		t.Fatalf("authenticated OA page = %d %q", oaPage.Code, oaPage.Body.String())
	}
	source := serve(simulator.OAHandler, http.MethodGet, roadflowsimulator.SourcePath, nil, cookie)
	if source.Code != http.StatusOK || source.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("source response = %d, headers = %v", source.Code, source.Header())
	}
	original := append([]byte(nil), source.Body.Bytes()...)

	firstHandoff := strings.Repeat("a", 64)
	delivered, firstReceipt := gatewayDelivery(t, simulator.GatewayHandler, firstHandoff, original)
	if !bytes.Equal(delivered, original) || firstReceipt.Handoff != firstHandoff ||
		firstReceipt.SourcePath != roadflowsimulator.SourcePath || firstReceipt.ActualFormat != "doc" ||
		firstReceipt.SHA256 != fmt.Sprintf("%x", sha256.Sum256(original)) {
		t.Fatalf("initial Gateway delivery = %+v", firstReceipt)
	}

	updated, err := os.ReadFile(filepath.Join("..", "roadflowoa", "testdata", "updated.doc"))
	if err != nil {
		t.Fatal(err)
	}
	overwrite := officeSave(t, simulator.OAHandler, updated, cookie)
	if overwrite.Code != http.StatusOK || !strings.Contains(overwrite.Body.String(), `"Code":"overwrite_committed"`) {
		t.Fatalf("OfficeSave = %d %s", overwrite.Code, overwrite.Body.String())
	}

	freshHandoff := strings.Repeat("b", 64)
	reopened, freshReceipt := gatewayDelivery(t, simulator.GatewayHandler, freshHandoff, updated)
	if !bytes.Equal(reopened, updated) || bytes.Equal(reopened, original) || freshReceipt.Handoff != freshHandoff {
		t.Fatalf("fresh Gateway delivery did not contain the committed Document: %+v", freshReceipt)
	}
}

func TestDefaultAcceptanceDocumentIsARealWPSGeneratedDOC(t *testing.T) {
	payload, err := os.ReadFile("testdata/Acceptance.doc")
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) != 10_240 {
		t.Fatalf("default Acceptance.doc size = %d, want 10240", len(payload))
	}
	if digest := fmt.Sprintf("%x", sha256.Sum256(payload)); digest != "fd18f34262830e2e9dee93cfb7668578e71208633a996a7574cb9f16b497b1d1" {
		t.Fatalf("default Acceptance.doc SHA-256 = %s", digest)
	}
}

func TestSimulatedOASessionProtectsSourceAndOfficeSave(t *testing.T) {
	simulator, err := roadflowsimulator.New(roadflowsimulator.Config{
		StateDir: t.TempDir(), InitialDocument: fixture(t, "original.doc"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if response := serve(simulator.OAHandler, http.MethodGet, roadflowsimulator.SourcePath, nil, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous source status = %d", response.Code)
	}
	payload, err := os.ReadFile(filepath.Join("..", "roadflowoa", "testdata", "updated.doc"))
	if err != nil {
		t.Fatal(err)
	}
	if response := officeSave(t, simulator.OAHandler, payload, ""); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous OfficeSave status = %d, body = %s", response.Code, response.Body.String())
	}
	if response := serve(simulator.OAHandler, http.MethodGet, "/unknown", nil, ""); response.Code != http.StatusNotFound {
		t.Fatalf("unknown OA route status = %d", response.Code)
	}
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join("..", "roadflowoa", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

type receipt struct {
	ActualFormat string `json:"actualFormat"`
	Handoff      string `json:"handoff"`
	SHA256       string `json:"sha256"`
	SourcePath   string `json:"sourcePath"`
}

func gatewayDelivery(t *testing.T, handler http.Handler, handoff string, expected []byte) ([]byte, receipt) {
	t.Helper()
	handoffPayload, err := json.Marshal(map[string]any{
		"expectedFormat": "doc",
		"handoff":        handoff,
		"returnURL":      "http://127.0.0.1:4317/",
		"sourceIdentity": map[string]any{
			"actualFormat": "doc",
			"byteCount":    len(expected),
			"sha256":       fmt.Sprintf("%x", sha256.Sum256(expected)),
			"sourcePath":   roadflowsimulator.SourcePath,
		},
		"sourcePath": roadflowsimulator.SourcePath,
		"title":      "Acceptance document",
	})
	if err != nil {
		t.Fatal(err)
	}
	registration := httptest.NewRequest(http.MethodPost, "/wps/editor-handoff", bytes.NewReader(handoffPayload))
	registration.Header.Set("Content-Type", "application/json")
	registration.Header.Set("Origin", roadflowgateway.ExtensionOrigin)
	registered := httptest.NewRecorder()
	handler.ServeHTTP(registered, registration)
	if registered.Code != http.StatusOK {
		t.Fatalf("Gateway handoff = %d %s", registered.Code, registered.Body.String())
	}
	documentURL := "/wps/document?fileurl=" + url.QueryEscape(roadflowsimulator.SourcePath) + "&_wpsHandoff=" + handoff
	delivery := serve(handler, http.MethodGet, documentURL, nil, "")
	if delivery.Code != http.StatusOK {
		t.Fatalf("Gateway delivery = %d %s", delivery.Code, delivery.Body.String())
	}
	lookup := httptest.NewRequest(http.MethodGet, "/wps/delivery-receipt?handoff="+handoff, nil)
	lookup.Header.Set("Origin", roadflowgateway.ExtensionOrigin)
	recorded := httptest.NewRecorder()
	handler.ServeHTTP(recorded, lookup)
	if recorded.Code != http.StatusOK {
		t.Fatalf("Gateway receipt = %d %s", recorded.Code, recorded.Body.String())
	}
	var result receipt
	if err := json.Unmarshal(recorded.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return delivery.Body.Bytes(), result
}

func officeSave(t *testing.T, handler http.Handler, payload []byte, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	_ = writer.WriteField("md5sum", fmt.Sprintf("%x", md5.Sum(payload)))
	_ = writer.WriteField("filename", "formId:formeditor")
	part, err := writer.CreateFormFile("filedata", "wps-upload.doc")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	path := "/RoadFlow/uploadfiles/OfficeSave?fileurl=" + url.QueryEscape(roadflowsimulator.SourcePath)
	request := httptest.NewRequest(http.MethodPost, path, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Cookie", cookie)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func serve(handler http.Handler, method, target string, body io.Reader, cookie string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, body)
	request.Header.Set("Cookie", cookie)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

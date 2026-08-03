package roadflowsimulator_test

import (
	"bytes"
	"crypto/md5"
	"crypto/sha256"
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

	"github.com/liumingjian/wps-plugin/roadflowsimulator"
)

func TestInstalledCRXCanUseTheSimulatedCustomerEnvironment(t *testing.T) {
	simulator, err := roadflowsimulator.New(roadflowsimulator.Config{
		StateDir:        t.TempDir(),
		OAOrigin:        "http://127.0.0.1:4317",
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
	if oaPage.Code != http.StatusOK || !strings.Contains(oaPage.Body.String(), roadflowsimulator.SourcePath) {
		t.Fatalf("authenticated OA page = %d %q", oaPage.Code, oaPage.Body.String())
	}
	source := serve(simulator.OAHandler, http.MethodGet, roadflowsimulator.SourcePath, nil, "")
	if source.Code != http.StatusOK || source.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("source response = %d, headers = %v", source.Code, source.Header())
	}
	original := append([]byte(nil), source.Body.Bytes()...)

	updated, err := os.ReadFile(filepath.Join("..", "roadflowoa", "testdata", "updated.doc"))
	if err != nil {
		t.Fatal(err)
	}
	overwrite := officeSave(t, simulator.OAHandler, updated, cookie)
	if overwrite.Code != http.StatusOK || !strings.Contains(overwrite.Body.String(), `"Code":"overwrite_committed"`) {
		t.Fatalf("OfficeSave = %d %s", overwrite.Code, overwrite.Body.String())
	}

	reopened := serve(simulator.OAHandler, http.MethodGet, roadflowsimulator.SourcePath, nil, "")
	if !bytes.Equal(reopened.Body.Bytes(), updated) || bytes.Equal(reopened.Body.Bytes(), original) {
		t.Fatalf("direct OA download did not contain the committed Document")
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

func TestSimulatedOASessionProtectsOfficeSaveButNotTheCustomerDownloadLink(t *testing.T) {
	simulator, err := roadflowsimulator.New(roadflowsimulator.Config{
		StateDir: t.TempDir(), InitialDocument: fixture(t, "original.doc"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if response := serve(simulator.OAHandler, http.MethodGet, roadflowsimulator.SourcePath, nil, ""); response.Code != http.StatusOK {
		t.Fatalf("public source status = %d", response.Code)
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

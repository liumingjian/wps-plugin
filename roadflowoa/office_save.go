// Package roadflowoa provides the fixed RoadFlow OfficeSave overwrite contract.
package roadflowoa

import (
	"archive/zip"
	"bytes"
	"crypto/md5"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	maxCompressedBytes   = 25 << 20
	maxUncompressedBytes = 100 << 20
	maxArchiveMembers    = 2048
	compatibilityData    = "formId:formeditor"
)

var md5Pattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

// OfficeSaveConfig binds authorized OA source paths to their server-managed Documents.
type OfficeSaveConfig struct {
	Documents     map[string]string
	Authenticated func(*http.Request) bool
	Authorized    func(*http.Request, string) bool
}

type officeSaveHandler struct {
	documents     map[string]string
	authenticated func(*http.Request) bool
	authorized    func(*http.Request, string) bool
}

type overwriteResponse struct {
	Success bool              `json:"Success"`
	Code    string            `json:"Code"`
	Message string            `json:"Message"`
	Data    *overwriteReceipt `json:"Data"`
}

type overwriteReceipt struct {
	FileURL string `json:"fileurl"`
	MD5Sum  string `json:"md5sum"`
	Format  string `json:"format"`
	Bytes   int    `json:"bytes"`
}

// NewOfficeSaveHandler creates the fixed authenticated OfficeSave endpoint.
func NewOfficeSaveHandler(config OfficeSaveConfig) (http.Handler, error) {
	if len(config.Documents) == 0 || config.Authenticated == nil || config.Authorized == nil {
		return nil, errors.New("OfficeSave requires Documents, Authenticated, and Authorized configuration")
	}
	documents := make(map[string]string, len(config.Documents))
	for sourcePath, target := range config.Documents {
		if !validSourcePath(sourcePath) || !strings.EqualFold(filepath.Ext(sourcePath), ".docx") || target == "" {
			return nil, fmt.Errorf("invalid DOCX Overwrite Target mapping %q", sourcePath)
		}
		documents[sourcePath] = target
	}
	return &officeSaveHandler{
		documents: documents, authenticated: config.Authenticated, authorized: config.Authorized,
	}, nil
}

func (handler *officeSaveHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || request.URL.Path != "/RoadFlow/uploadfiles/OfficeSave" {
		writeFailure(response, http.StatusMethodNotAllowed, "method_not_allowed", "Overwrite requires POST.")
		return
	}
	if !handler.authenticated(request) {
		writeFailure(response, http.StatusUnauthorized, "session_required", "OA session is required.")
		return
	}
	query := request.URL.Query()
	values := query["fileurl"]
	if len(query) != 1 || len(values) != 1 || !validSourcePath(values[0]) {
		writeFailure(response, http.StatusForbidden, "overwrite_forbidden", "Document overwrite is not authorized.")
		return
	}
	sourcePath := values[0]
	target, known := handler.documents[sourcePath]
	if !known || !handler.authorized(request, sourcePath) {
		writeFailure(response, http.StatusForbidden, "overwrite_forbidden", "Document overwrite is not authorized.")
		return
	}
	info, err := os.Lstat(target)
	if errors.Is(err, os.ErrNotExist) {
		writeFailure(response, http.StatusNotFound, "original_missing", "The original Document no longer exists.")
		return
	}
	if err != nil {
		writeFailure(response, http.StatusInternalServerError, "commit_failed", "The Document could not be committed.")
		return
	}
	if !info.Mode().IsRegular() {
		writeFailure(response, http.StatusInternalServerError, "commit_failed", "The Document could not be committed.")
		return
	}

	request.Body = http.MaxBytesReader(response, request.Body, maxCompressedBytes+(1<<20))
	if err := request.ParseMultipartForm(maxCompressedBytes); err != nil {
		writeFailure(response, http.StatusBadRequest, "invalid_multipart", "The overwrite request is invalid.")
		return
	}
	if request.MultipartForm != nil {
		defer request.MultipartForm.RemoveAll()
	}
	file, declaredMD5, ok := multipartDocument(request)
	if !ok {
		writeFailure(response, http.StatusBadRequest, "invalid_multipart", "The overwrite request is invalid.")
		return
	}
	payload, err := io.ReadAll(io.LimitReader(file, maxCompressedBytes+1))
	closeErr := file.Close()
	if err != nil || closeErr != nil || len(payload) == 0 || len(payload) > maxCompressedBytes {
		writeFailure(response, http.StatusBadRequest, "invalid_multipart", "The overwrite request is invalid.")
		return
	}
	storedMD5 := fmt.Sprintf("%x", md5.Sum(payload))
	if !md5Pattern.MatchString(declaredMD5) || declaredMD5 != storedMD5 {
		writeFailure(response, http.StatusBadRequest, "checksum_mismatch", "The Document checksum did not match.")
		return
	}
	if err := validateDOCX(payload); err != nil {
		writeFailure(response, http.StatusBadRequest, "format_mismatch", "The submitted Document is not a valid DOCX.")
		return
	}
	if err := atomicReplace(target, payload, info.Mode().Perm()); err != nil {
		writeFailure(response, http.StatusInternalServerError, "commit_failed", "The Document could not be committed.")
		return
	}
	writeJSON(response, http.StatusOK, overwriteResponse{
		Success: true,
		Code:    "overwrite_committed",
		Message: "Document overwritten.",
		Data: &overwriteReceipt{
			FileURL: sourcePath, MD5Sum: storedMD5, Format: "docx", Bytes: len(payload),
		},
	})
}

func validSourcePath(value string) bool {
	decoded, err := url.PathUnescape(value)
	return err == nil && strings.HasPrefix(value, "/") && strings.HasPrefix(decoded, "/") &&
		!strings.ContainsAny(value, "\\\x00") && !strings.ContainsAny(decoded, "\\\x00") &&
		path.Clean(value) == value && path.Clean(decoded) == decoded &&
		!strings.Contains(value, "//") && !strings.Contains(decoded, "//")
}

func multipartDocument(request *http.Request) (io.ReadCloser, string, bool) {
	form := request.MultipartForm
	if form == nil || len(form.Value) != 2 || len(form.File) != 1 ||
		len(form.Value["md5sum"]) != 1 || len(form.Value["filename"]) != 1 ||
		len(form.File["filedata"]) != 1 || form.Value["filename"][0] != compatibilityData {
		return nil, "", false
	}
	file, err := form.File["filedata"][0].Open()
	return file, form.Value["md5sum"][0], err == nil
}

func validateDOCX(payload []byte) error {
	archive, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil || len(archive.File) == 0 || len(archive.File) > maxArchiveMembers {
		return errors.New("invalid DOCX archive")
	}
	files := make(map[string]*zip.File, len(archive.File))
	var uncompressed uint64
	for _, file := range archive.File {
		memberPath := strings.TrimSuffix(file.Name, "/")
		if memberPath == "" || strings.Contains(memberPath, "\\") || path.Clean("/"+memberPath) != "/"+memberPath || files[file.Name] != nil ||
			(strings.HasSuffix(file.Name, "/") && (!file.FileInfo().IsDir() || file.UncompressedSize64 != 0)) {
			return errors.New("unsafe DOCX member")
		}
		uncompressed += file.UncompressedSize64
		if uncompressed > maxUncompressedBytes || (len(payload) > 0 && uncompressed > uint64(len(payload))*100) {
			return errors.New("DOCX expansion limit exceeded")
		}
		files[file.Name] = file
	}
	contentTypes, err := readArchiveXML(files["[Content_Types].xml"])
	if err != nil || !xmlAttributePair(contentTypes, "Override", "PartName", "/word/document.xml", "ContentType", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml") {
		return errors.New("DOCX main content type is missing")
	}
	relationships, err := readArchiveXML(files["_rels/.rels"])
	if err != nil || !xmlAttributePair(relationships, "Relationship", "Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", "Target", "word/document.xml") {
		return errors.New("DOCX office relationship is missing")
	}
	documentXML, err := readArchiveXML(files["word/document.xml"])
	if err != nil || !validWordDocument(documentXML) {
		return errors.New("DOCX main Document is invalid")
	}
	return nil
}

func validWordDocument(content string) bool {
	const wordprocessingML = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
	decoder := xml.NewDecoder(strings.NewReader(content))
	rootSeen := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return false
		}
		if err != nil {
			return false
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		if !rootSeen {
			if start.Name.Local != "document" || start.Name.Space != wordprocessingML {
				return false
			}
			rootSeen = true
			continue
		}
		if start.Name.Local == "body" && start.Name.Space == wordprocessingML {
			return true
		}
	}
}

func readArchiveXML(file *zip.File) (string, error) {
	if file == nil || file.UncompressedSize64 > maxUncompressedBytes {
		return "", errors.New("DOCX member is missing or too large")
	}
	reader, err := file.Open()
	if err != nil {
		return "", err
	}
	defer reader.Close()
	content, err := io.ReadAll(io.LimitReader(reader, maxUncompressedBytes+1))
	if err != nil || len(content) > maxUncompressedBytes {
		return "", errors.New("DOCX member is invalid")
	}
	decoder := xml.NewDecoder(bytes.NewReader(content))
	for {
		_, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", err
		}
	}
	return string(content), nil
}

func xmlAttributePair(content, element, firstName, firstValue, secondName, secondValue string) bool {
	decoder := xml.NewDecoder(strings.NewReader(content))
	for {
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != element {
			continue
		}
		attributes := map[string]string{}
		for _, attribute := range start.Attr {
			attributes[attribute.Name.Local] = attribute.Value
		}
		if attributes[firstName] == firstValue && attributes[secondName] == secondValue {
			return true
		}
	}
}

func writeFailure(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, overwriteResponse{Success: false, Code: code, Message: message, Data: nil})
}

func writeJSON(response http.ResponseWriter, status int, value overwriteResponse) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

// Package roadflowoa provides the fixed RoadFlow OfficeSave overwrite contract.
package roadflowoa

import (
	"archive/zip"
	"bytes"
	"crypto/md5"
	"encoding/binary"
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

	"github.com/richardlehane/mscfb"
)

const (
	maxCompressedBytes   = 25 << 20
	maxUncompressedBytes = 100 << 20
	maxArchiveMembers    = 2048
	compatibilityData    = "formId:formeditor"
)

type docFIBLayout struct {
	nFib       uint16
	fcLcbCount uint16
	cswNew     uint16
}

var docFIBLayouts = map[uint16]docFIBLayout{
	0x005d: {nFib: 0x00c1, fcLcbCount: 0x005d, cswNew: 0},
	0x006c: {nFib: 0x00d9, fcLcbCount: 0x006c, cswNew: 2},
	0x0088: {nFib: 0x0101, fcLcbCount: 0x0088, cswNew: 2},
	0x00a4: {nFib: 0x010c, fcLcbCount: 0x00a4, cswNew: 2},
	0x00b7: {nFib: 0x0112, fcLcbCount: 0x00b7, cswNew: 5},
}

type ooxmlSpecification struct {
	mainPath          string
	contentType       string
	rootName          string
	namespaces        []string
	relationshipTypes []string
	requiredChild     string
}

var (
	md5Pattern       = regexp.MustCompile(`^[a-f0-9]{32}$`)
	wpsStreamPattern = regexp.MustCompile(`(?i)^(WPS|WPSDocument|Document|Content|Contents|BodyText)$`)
)

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

type multipartDocumentResult struct {
	file        io.ReadCloser
	declaredMD5 string
	nativeET    bool
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
		if !validSourcePath(sourcePath) || documentFormat(sourcePath) == "" || target == "" {
			return nil, fmt.Errorf("invalid Document Overwrite Target mapping %q", sourcePath)
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
	format := documentFormat(sourcePath)
	multipart, ok := multipartDocument(request, format)
	if !ok {
		writeFailure(response, http.StatusBadRequest, "invalid_multipart", "The overwrite request is invalid.")
		return
	}
	payload, err := io.ReadAll(io.LimitReader(multipart.file, maxCompressedBytes+1))
	closeErr := multipart.file.Close()
	if err != nil || closeErr != nil || len(payload) == 0 || len(payload) > maxCompressedBytes {
		writeFailure(response, http.StatusBadRequest, "invalid_multipart", "The overwrite request is invalid.")
		return
	}
	storedMD5 := fmt.Sprintf("%x", md5.Sum(payload))
	if !multipart.nativeET && (!md5Pattern.MatchString(multipart.declaredMD5) || multipart.declaredMD5 != storedMD5) {
		writeFailure(response, http.StatusBadRequest, "checksum_mismatch", "The Document checksum did not match.")
		return
	}
	if err := validateFormatCompatibleDocument(payload, format); err != nil {
		writeFailure(response, http.StatusBadRequest, "format_mismatch", "The submitted Document format does not match the Overwrite Target.")
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
			FileURL: sourcePath, MD5Sum: storedMD5, Format: format, Bytes: len(payload),
		},
	})
}

func wordFormat(sourcePath string) string {
	format := documentFormat(sourcePath)
	if format == "doc" || format == "docx" {
		return format
	}
	return ""
}

func documentFormat(sourcePath string) string {
	switch {
	case strings.EqualFold(filepath.Ext(sourcePath), ".docx"):
		return "docx"
	case strings.EqualFold(filepath.Ext(sourcePath), ".doc"):
		return "doc"
	case strings.EqualFold(filepath.Ext(sourcePath), ".wps"):
		return "wps"
	case strings.EqualFold(filepath.Ext(sourcePath), ".xls"):
		return "xls"
	case strings.EqualFold(filepath.Ext(sourcePath), ".xlsx"):
		return "xlsx"
	default:
		return ""
	}
}

func validateFormatCompatibleDocument(payload []byte, format string) error {
	switch format {
	case "docx":
		if err := validateDOCX(payload); err == nil {
			return nil
		}
		// WPS saveURL_FormData can serialize a DOCX edit as a legacy CFB Word
		// document while the OA keeps the original .docx path.
		return validateDOC(payload)
	case "doc":
		return validateDOC(payload)
	case "wps":
		return validateWPS(payload)
	case "xls":
		return validateXLS(payload)
	case "xlsx":
		if err := validateXLSX(payload); err == nil {
			return nil
		}
		// Keep the server contract aligned with the WPS XLSX save behavior.
		return validateXLS(payload)
	default:
		return errors.New("unsupported Document format")
	}
}

// ValidateFormatCompatibleDocument validates an actual serialization for OA and Gateway boundaries.
func ValidateFormatCompatibleDocument(payload []byte, format string) error {
	return validateFormatCompatibleDocument(payload, format)
}

// WordFormat returns the supported Word serialization declared by a source path.
func WordFormat(sourcePath string) string { return wordFormat(sourcePath) }

// DocumentFormat returns the supported serialization declared by a source path.
func DocumentFormat(sourcePath string) string { return documentFormat(sourcePath) }

// ValidSourcePath reports whether a source path is normalized and safe for an exact mapping.
func ValidSourcePath(sourcePath string) bool { return validSourcePath(sourcePath) }

// MaxDocumentBytes is the maximum accepted serialized Document size.
const MaxDocumentBytes = maxCompressedBytes

func validateDOC(payload []byte) error {
	rootStreams, err := cfbRootStreams(payload)
	if err != nil {
		return err
	}
	wordDocument := rootStreams["WordDocument"]
	if wordDocument == nil {
		return errors.New("root WordDocument stream is missing")
	}
	fib, err := io.ReadAll(io.LimitReader(wordDocument, 2048))
	if err != nil || len(fib) < 154 {
		return errors.New("WordDocument FIB is missing or truncated")
	}
	baseNFib := binary.LittleEndian.Uint16(fib[2:4])
	layout, supported := docFIBLayouts[binary.LittleEndian.Uint16(fib[152:154])]
	flags := binary.LittleEndian.Uint16(fib[10:12])
	if binary.LittleEndian.Uint16(fib[:2]) != 0xa5ec || !supported || flags&0x1000 == 0 || flags&0x0100 != 0 ||
		(binary.LittleEndian.Uint16(fib[12:14]) != 0x00bf && binary.LittleEndian.Uint16(fib[12:14]) != 0x00c1) ||
		binary.LittleEndian.Uint32(fib[14:18]) != 0 || fib[18] != 0 || fib[19]&1 != 0 ||
		binary.LittleEndian.Uint16(fib[20:22]) != 0 || binary.LittleEndian.Uint16(fib[22:24]) != 0 ||
		binary.LittleEndian.Uint16(fib[32:34]) != 0x000e || binary.LittleEndian.Uint16(fib[62:64]) != 0x0016 ||
		binary.LittleEndian.Uint16(fib[152:154]) != layout.fcLcbCount {
		return errors.New("invalid Word FIB")
	}
	cswNewOffset := 154 + int(layout.fcLcbCount)*8
	if len(fib) < cswNewOffset+2+int(layout.cswNew)*2 ||
		binary.LittleEndian.Uint16(fib[cswNewOffset:cswNewOffset+2]) != layout.cswNew ||
		(layout.cswNew == 0 && baseNFib != layout.nFib) ||
		(layout.cswNew != 0 && binary.LittleEndian.Uint16(fib[cswNewOffset+2:cswNewOffset+4]) != layout.nFib) {
		return errors.New("invalid Word FIB variable layout")
	}
	tableName := "0Table"
	if flags&0x0200 != 0 {
		tableName = "1Table"
	}
	if table := rootStreams[tableName]; table == nil || table.Size == 0 {
		return errors.New("Word table stream is missing")
	}
	return nil
}

func cfbRootStreams(payload []byte) (map[string]*mscfb.File, error) {
	container, err := mscfb.New(bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("invalid CFB container: %w", err)
	}
	rootStreams := map[string]*mscfb.File{}
	for {
		entry, err := container.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("invalid CFB directory: %w", err)
		}
		if len(entry.Path) == 0 && !entry.FileInfo().IsDir() {
			rootStreams[entry.Name] = entry
		}
	}
	return rootStreams, nil
}

func validateWPS(payload []byte) error {
	if err := validateDOC(payload); err == nil {
		return nil
	}
	rootStreams, err := cfbRootStreams(payload)
	if err != nil {
		return err
	}
	for name, entry := range rootStreams {
		if entry.Size > 0 && wpsStreamPattern.MatchString(name) {
			return nil
		}
	}
	return errors.New("invalid WPS container")
}

func validateXLS(payload []byte) error {
	rootStreams, err := cfbRootStreams(payload)
	if err != nil {
		return err
	}
	workbook := rootStreams["Workbook"]
	if workbook == nil {
		workbook = rootStreams["Book"]
	}
	if workbook == nil || workbook.Size < 12 || workbook.Size > maxUncompressedBytes {
		return errors.New("Workbook stream is missing or invalid")
	}
	contents, err := io.ReadAll(io.LimitReader(workbook, maxUncompressedBytes+1))
	if err != nil || len(contents) != int(workbook.Size) {
		return errors.New("Workbook stream is truncated")
	}
	if len(contents) < 12 || binary.LittleEndian.Uint16(contents[0:2]) != 0x0809 ||
		binary.LittleEndian.Uint16(contents[2:4]) < 4 ||
		4+int(binary.LittleEndian.Uint16(contents[2:4])) > len(contents) ||
		binary.LittleEndian.Uint16(contents[6:8]) != 0x0005 {
		return errors.New("invalid Workbook BOF")
	}

	hasSheet, hasGlobalsEOF := false, false
	for offset := 0; offset+4 <= len(contents); {
		recordType := binary.LittleEndian.Uint16(contents[offset : offset+2])
		recordSize := int(binary.LittleEndian.Uint16(contents[offset+2 : offset+4]))
		nextOffset := offset + 4 + recordSize
		if nextOffset > len(contents) {
			return errors.New("truncated Workbook record")
		}
		if recordType == 0x0085 {
			hasSheet = true
		}
		if recordType == 0x000a && hasSheet {
			hasGlobalsEOF = true
			break
		}
		offset = nextOffset
	}
	if !hasSheet || !hasGlobalsEOF {
		return errors.New("Workbook sheets are missing")
	}
	return nil
}

func validSourcePath(value string) bool {
	decoded, err := url.PathUnescape(value)
	return err == nil && strings.HasPrefix(value, "/") && strings.HasPrefix(decoded, "/") &&
		!strings.ContainsAny(value, "\\\x00") && !strings.ContainsAny(decoded, "\\\x00") &&
		path.Clean(value) == value && path.Clean(decoded) == decoded &&
		!strings.Contains(value, "//") && !strings.Contains(decoded, "//")
}

func multipartDocument(request *http.Request, format string) (multipartDocumentResult, bool) {
	form := request.MultipartForm
	if form == nil {
		return multipartDocumentResult{}, false
	}
	if len(form.Value) == 2 && len(form.File) == 1 &&
		len(form.Value["md5sum"]) == 1 && len(form.Value["filename"]) == 1 &&
		len(form.File["filedata"]) == 1 && form.Value["filename"][0] == compatibilityData {
		file, err := form.File["filedata"][0].Open()
		return multipartDocumentResult{file: file, declaredMD5: form.Value["md5sum"][0]}, err == nil
	}
	if format != "xls" && format != "xlsx" {
		return multipartDocumentResult{}, false
	}
	if len(form.Value) == 1 && len(form.File) == 0 && len(form.Value["file"]) == 1 {
		return multipartDocumentResult{
			file:     io.NopCloser(strings.NewReader(form.Value["file"][0])),
			nativeET: true,
		}, true
	}
	if len(form.Value) == 0 && len(form.File) == 1 && len(form.File["file"]) == 1 && form.File["file"][0].Filename == "" {
		file, err := form.File["file"][0].Open()
		return multipartDocumentResult{file: file, nativeET: true}, err == nil
	}
	return multipartDocumentResult{}, false
}

func validateOOXML(payload []byte, specification ooxmlSpecification) error {
	archive, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil || len(archive.File) == 0 || len(archive.File) > maxArchiveMembers {
		return errors.New("invalid OOXML archive")
	}
	files := make(map[string]*zip.File, len(archive.File))
	var uncompressed uint64
	for _, file := range archive.File {
		memberPath := strings.TrimSuffix(file.Name, "/")
		if memberPath == "" || strings.Contains(memberPath, "\\") || path.Clean("/"+memberPath) != "/"+memberPath || files[file.Name] != nil ||
			(strings.HasSuffix(file.Name, "/") && (!file.FileInfo().IsDir() || file.UncompressedSize64 != 0)) {
			return errors.New("unsafe OOXML member")
		}
		uncompressed += file.UncompressedSize64
		if uncompressed > maxUncompressedBytes || (len(payload) > 0 && uncompressed > uint64(len(payload))*100) {
			return errors.New("OOXML expansion limit exceeded")
		}
		files[file.Name] = file
	}
	contentTypes, err := readArchiveXML(files["[Content_Types].xml"])
	if err != nil || !xmlAttributePair(contentTypes, "Override", "PartName", "/"+specification.mainPath, "ContentType", specification.contentType) {
		return errors.New("OOXML main content type is missing")
	}
	relationships, err := readArchiveXML(files["_rels/.rels"])
	if err != nil || !xmlAttributePairAny(relationships, "Relationship", "Type", specification.relationshipTypes, "Target", specification.mainPath) {
		return errors.New("OOXML office relationship is missing")
	}
	documentXML, err := readArchiveXML(files[specification.mainPath])
	if err != nil || !validOOXMLDocument(documentXML, specification) {
		return errors.New("OOXML main Document is invalid")
	}
	return nil
}

func validateDOCX(payload []byte) error {
	return validateOOXML(payload, ooxmlSpecification{
		mainPath:          "word/document.xml",
		contentType:       "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
		rootName:          "document",
		namespaces:        []string{"http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"},
		relationshipTypes: []string{"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument"},
		requiredChild:     "body",
	})
}

func validateXLSX(payload []byte) error {
	return validateOOXML(payload, ooxmlSpecification{
		mainPath:          "xl/workbook.xml",
		contentType:       "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
		rootName:          "workbook",
		namespaces:        []string{"http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"},
		relationshipTypes: []string{"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument"},
		requiredChild:     "sheet",
	})
}

func validWordDocument(content string) bool {
	return validOOXMLDocument(content, ooxmlSpecification{
		rootName:      "document",
		namespaces:    []string{"http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"},
		requiredChild: "body",
	})
}

func validOOXMLDocument(content string, specification ooxmlSpecification) bool {
	decoder := xml.NewDecoder(strings.NewReader(content))
	rootSeen, childSeen := false, false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return rootSeen && (specification.requiredChild == "" || childSeen)
		}
		if err != nil {
			return false
		}
		start, ok := token.(xml.StartElement)
		if !ok {
			continue
		}
		if !rootSeen {
			if start.Name.Local != specification.rootName || !containsString(specification.namespaces, start.Name.Space) {
				return false
			}
			rootSeen = true
			continue
		}
		if start.Name.Local == specification.requiredChild && containsString(specification.namespaces, start.Name.Space) {
			childSeen = true
		}
	}
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
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
	return xmlAttributePairAny(content, element, firstName, []string{firstValue}, secondName, secondValue)
}

func xmlAttributePairAny(content, element, firstName string, firstValues []string, secondName, secondValue string) bool {
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
		if containsString(firstValues, attributes[firstName]) && attributes[secondName] == secondValue {
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

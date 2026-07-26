package demo

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	docxContentType        = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	documentXMLContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
	maxSubmissionBytes     = 20 << 20
	maxDocumentXMLBytes    = 4 << 20
	wordprocessingMLNS     = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
)

type documentState struct {
	mu          sync.RWMutex
	content     []byte
	version     int
	previewText string
	updatedAt   time.Time
}

type documentView struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Version     int       `json:"version"`
	PreviewText string    `json:"previewText"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

func Handler() http.Handler {
	assets, err := fs.Sub(Static, "static")
	if err != nil {
		panic(err)
	}
	initial := fixtureDOCX()
	preview, err := previewText(initial)
	if err != nil {
		panic(err)
	}
	document := &documentState{
		content:     initial,
		version:     1,
		previewText: preview,
		updatedAt:   time.Now().UTC(),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /documents/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") != "doc-001" {
			http.Error(w, "Unknown Document ID.", http.StatusNotFound)
			return
		}
		view, _ := document.snapshot()
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(view)
	})
	mux.HandleFunc("GET /documents/{id}/content", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") != "doc-001" {
			http.Error(w, "Unknown Document ID.", http.StatusNotFound)
			return
		}
		_, content := document.snapshot()
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", docxContentType)
		w.Header().Set("Content-Disposition", `attachment; filename="doc-001.docx"`)
		_, _ = w.Write(content)
	})
	mux.HandleFunc("POST /documents/{id}/submissions", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") != "doc-001" {
			http.Error(w, "Unknown Document ID.", http.StatusNotFound)
			return
		}
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != docxContentType {
			http.Error(w, "Submission must use the DOCX content type.", http.StatusUnsupportedMediaType)
			return
		}
		content, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSubmissionBytes))
		if err != nil {
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				http.Error(w, "Submission is too large.", http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(w, "Submission body is invalid.", http.StatusBadRequest)
			return
		}
		if len(content) == 0 {
			http.Error(w, "Submission body is invalid.", http.StatusBadRequest)
			return
		}
		preview, err := previewText(content)
		if err != nil {
			http.Error(w, "Submission is not a valid DOCX.", http.StatusBadRequest)
			return
		}
		view := document.replace(content, preview)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(view)
	})
	mux.Handle("/", http.FileServer(http.FS(assets)))
	return mux
}

func (document *documentState) snapshot() (documentView, []byte) {
	document.mu.RLock()
	defer document.mu.RUnlock()
	return document.view(), append([]byte(nil), document.content...)
}

func (document *documentState) replace(content []byte, preview string) documentView {
	document.mu.Lock()
	defer document.mu.Unlock()
	document.content = append([]byte(nil), content...)
	document.version++
	document.previewText = preview
	document.updatedAt = time.Now().UTC()
	return document.view()
}

func (document *documentState) view() documentView {
	return documentView{
		ID:          "doc-001",
		Name:        "Demo Document",
		Version:     document.version,
		PreviewText: document.previewText,
		UpdatedAt:   document.updatedAt,
	}
}

func previewText(content []byte) (string, error) {
	reader, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return "", err
	}
	var contentTypesFile *zip.File
	var documentFile *zip.File
	for _, file := range reader.File {
		switch file.Name {
		case "[Content_Types].xml":
			contentTypesFile = file
		case "word/document.xml":
			documentFile = file
		}
	}
	if contentTypesFile == nil || documentFile == nil {
		return "", errors.New("DOCX lacks required package parts")
	}
	validContentType, err := hasDocumentContentType(contentTypesFile)
	if err != nil || !validContentType {
		return "", errors.New("DOCX lacks the main document content type")
	}
	if documentFile.UncompressedSize64 > maxDocumentXMLBytes {
		return "", errors.New("word/document.xml is too large")
	}
	stream, err := documentFile.Open()
	if err != nil {
		return "", err
	}
	preview, err := decodeDocumentText(io.LimitReader(stream, maxDocumentXMLBytes+1))
	stream.Close()
	return preview, err
}

func hasDocumentContentType(file *zip.File) (bool, error) {
	stream, err := file.Open()
	if err != nil {
		return false, err
	}
	defer stream.Close()
	decoder := xml.NewDecoder(io.LimitReader(stream, 1<<20))
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "Override" {
			continue
		}
		var partName, contentType string
		for _, attribute := range start.Attr {
			switch attribute.Name.Local {
			case "PartName":
				partName = attribute.Value
			case "ContentType":
				contentType = attribute.Value
			}
		}
		if partName == "/word/document.xml" && contentType == documentXMLContentType {
			return true, nil
		}
	}
}

func decodeDocumentText(reader io.Reader) (string, error) {
	decoder := xml.NewDecoder(reader)
	var output strings.Builder
	var text strings.Builder
	inDocument := false
	inBody := false
	seenDocument := false
	seenBody := false
	inText := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		switch value := token.(type) {
		case xml.StartElement:
			if value.Name.Space != wordprocessingMLNS {
				continue
			}
			switch value.Name.Local {
			case "document":
				inDocument = true
				seenDocument = true
			case "body":
				if inDocument {
					inBody = true
					seenBody = true
				}
			case "t":
				inText = inBody
			case "tab":
				if inBody {
					text.WriteByte('\t')
				}
			case "br":
				if inBody {
					text.WriteByte('\n')
				}
			}
		case xml.CharData:
			if inText {
				text.Write(value)
			}
		case xml.EndElement:
			if value.Name.Space != wordprocessingMLNS {
				continue
			}
			switch value.Name.Local {
			case "t":
				inText = false
			case "p":
				if !inBody {
					continue
				}
				paragraph := strings.TrimSpace(text.String())
				if paragraph != "" {
					if output.Len() > 0 {
						output.WriteByte('\n')
					}
					output.WriteString(paragraph)
				}
				text.Reset()
			case "body":
				inBody = false
			case "document":
				inDocument = false
			}
		}
	}
	if inDocument || inBody || !seenDocument || !seenBody {
		return "", errors.New("word/document.xml is invalid")
	}
	return output.String(), nil
}

func fixtureDOCX() []byte {
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	files := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"_rels/.rels":         `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		"word/document.xml":   `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>WPS local editing fixture</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
	}
	for name, content := range files {
		part, _ := writer.Create(name)
		_, _ = part.Write([]byte(content))
	}
	_ = writer.Close()
	return output.Bytes()
}

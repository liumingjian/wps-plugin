package demo

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/liumingjian/wps-plugin/agent"
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

type editingTask struct {
	descriptor  agent.TaskDescriptor
	content     []byte
	submissions map[string]agent.AcceptanceReceipt
	completion  *agent.CompletionReceipt
}

type editingTaskStore struct {
	mu          sync.Mutex
	tasks       map[string]*editingTask
	idempotency map[string]string
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
	tasks := &editingTaskStore{tasks: map[string]*editingTask{}, idempotency: map[string]string{}}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /editing-tasks", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ContractVersion int    `json:"contractVersion"`
			DocumentID      string `json:"documentId"`
			IdempotencyKey  string `json:"idempotencyKey"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&request); err != nil || request.ContractVersion != 1 || request.DocumentID != "doc-001" || request.IdempotencyKey == "" {
			http.Error(w, "Invalid Editing Task request.", http.StatusBadRequest)
			return
		}
		tasks.mu.Lock()
		defer tasks.mu.Unlock()
		if taskID := tasks.idempotency[request.IdempotencyKey]; taskID != "" {
			writeJSON(w, http.StatusOK, tasks.tasks[taskID].descriptor)
			return
		}
		view, content := document.snapshot()
		taskID, err := newTaskID()
		if err != nil {
			http.Error(w, "Could not create Editing Task.", http.StatusInternalServerError)
			return
		}
		origin := requestOrigin(r)
		base := origin + "/editing-tasks/" + taskID
		expires := time.Now().UTC().Add(15 * time.Minute)
		hash := fmt.Sprintf("%x", sha256.Sum256(content))
		descriptor := agent.TaskDescriptor{
			ContractVersion:      1,
			TaskID:               taskID,
			RequiredCapabilities: []string{"durable-events", "fifo-snapshots", "recovery", "notifications"},
			Document: agent.DocumentDescriptor{
				DocumentID:      "doc-001",
				DisplayName:     "Demo-Document.docx",
				DocumentVersion: strconv.Itoa(view.Version),
				MediaType:       agent.DOCXMediaType,
				SizeBytes:       int64(len(content)),
				SHA256:          hash,
			},
			Retrieval: agent.CapabilityEndpoint{URL: base + "/content", Method: http.MethodGet, ExpiresAt: expires},
			Submission: agent.SubmissionDescriptor{
				CapabilityEndpoint: agent.CapabilityEndpoint{URL: base + "/submissions", Method: http.MethodPost, ExpiresAt: expires},
				Profile:            agent.RawBodyProfileV1,
			},
			Completion: agent.CapabilityEndpoint{URL: base + "/completion", Method: http.MethodPost, ExpiresAt: expires},
		}
		tasks.tasks[taskID] = &editingTask{descriptor: descriptor, content: content, submissions: map[string]agent.AcceptanceReceipt{}}
		tasks.idempotency[request.IdempotencyKey] = taskID
		writeJSON(w, http.StatusCreated, descriptor)
	})
	mux.HandleFunc("GET /editing-tasks/{taskID}/content", func(w http.ResponseWriter, r *http.Request) {
		tasks.mu.Lock()
		task := tasks.tasks[r.PathValue("taskID")]
		if task == nil {
			tasks.mu.Unlock()
			http.Error(w, "Unknown Editing Task.", http.StatusNotFound)
			return
		}
		content := append([]byte(nil), task.content...)
		tasks.mu.Unlock()
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", docxContentType)
		w.Header().Set("Content-Disposition", `attachment; filename="Demo-Document.docx"`)
		_, _ = w.Write(content)
	})
	mux.HandleFunc("POST /editing-tasks/{taskID}/submissions", func(w http.ResponseWriter, r *http.Request) {
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		sequence, sequenceErr := strconv.Atoi(r.Header.Get("X-WPS-Snapshot-Sequence"))
		wantHash := r.Header.Get("X-WPS-Snapshot-SHA256")
		idempotencyKey := r.Header.Get("Idempotency-Key")
		if err != nil || mediaType != docxContentType || sequenceErr != nil || sequence < 1 || wantHash == "" || idempotencyKey == "" {
			http.Error(w, "Invalid Submission metadata.", http.StatusBadRequest)
			return
		}
		content, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSubmissionBytes))
		if err != nil || fmt.Sprintf("%x", sha256.Sum256(content)) != wantHash {
			http.Error(w, "Submission does not match its declared Snapshot.", http.StatusBadRequest)
			return
		}
		preview, err := previewText(content)
		if err != nil {
			http.Error(w, "Submission is not a valid DOCX.", http.StatusBadRequest)
			return
		}
		tasks.mu.Lock()
		defer tasks.mu.Unlock()
		task := tasks.tasks[r.PathValue("taskID")]
		if task == nil {
			http.Error(w, "Unknown Editing Task.", http.StatusNotFound)
			return
		}
		if receipt, ok := task.submissions[idempotencyKey]; ok {
			if receipt.SnapshotSHA256 != wantHash {
				http.Error(w, "Idempotency key conflicts with another Snapshot.", http.StatusConflict)
				return
			}
			writeJSON(w, http.StatusOK, receipt)
			return
		}
		view := document.replace(content, preview)
		receipt := agent.AcceptanceReceipt{
			Accepted:        true,
			SubmissionID:    fmt.Sprintf("%s-%d", task.descriptor.TaskID, sequence),
			DocumentVersion: strconv.Itoa(view.Version),
			SnapshotSHA256:  wantHash,
			AcceptedAt:      time.Now().UTC(),
		}
		task.submissions[idempotencyKey] = receipt
		writeJSON(w, http.StatusCreated, receipt)
	})
	mux.HandleFunc("POST /editing-tasks/{taskID}/completion", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Outcome string `json:"outcome"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&request); err != nil || (request.Outcome != "submitted" && request.Outcome != "unchanged") {
			http.Error(w, "Invalid Editing Task outcome.", http.StatusBadRequest)
			return
		}
		tasks.mu.Lock()
		defer tasks.mu.Unlock()
		task := tasks.tasks[r.PathValue("taskID")]
		if task == nil {
			http.Error(w, "Unknown Editing Task.", http.StatusNotFound)
			return
		}
		if task.completion == nil {
			task.completion = &agent.CompletionReceipt{Completed: true, TaskID: task.descriptor.TaskID, Outcome: request.Outcome, CompletedAt: time.Now().UTC()}
		}
		if task.completion.Outcome != request.Outcome {
			http.Error(w, "Editing Task already completed with another outcome.", http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusOK, task.completion)
	})
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

func newTaskID() (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("task-%x", random), nil
}

func requestOrigin(request *http.Request) string {
	scheme := "http"
	if request.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + request.Host
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
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

package agent_test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/liumingjian/wps-plugin/agent"
)

func TestTaskTransportVerifiesRetrievalAndAcceptanceReceipt(t *testing.T) {
	document := minimalDOCX(t)
	hashBytes := sha256.Sum256(document)
	hash := hex.EncodeToString(hashBytes[:])
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/content":
			w.Header().Set("Content-Type", agent.DOCXMediaType)
			_, _ = w.Write(document)
		case "/submissions":
			if r.Header.Get("Authorization") != "Bearer short-lived" || r.Header.Get("X-WPS-Snapshot-Sequence") != "1" || r.Header.Get("Idempotency-Key") != "idempotency-1" || r.Header.Get("X-WPS-Snapshot-SHA256") != hash {
				t.Errorf("Submission metadata headers = %v", r.Header)
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(agent.AcceptanceReceipt{Accepted: true, SubmissionID: "submission-1", DocumentVersion: "8", SnapshotSHA256: hash, AcceptedAt: time.Now().UTC()})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	descriptor := validDescriptor()
	descriptor.Document.SizeBytes = int64(len(document))
	descriptor.Document.SHA256 = hash
	descriptor.Retrieval.URL = server.URL + "/content"
	descriptor.Submission.URL = server.URL + "/submissions"
	descriptor.Completion.URL = server.URL + "/completion"
	transport := agent.NewTaskTransport(server.Client())
	got, err := transport.Retrieve(context.Background(), descriptor)
	if err != nil || !bytes.Equal(got, document) {
		t.Fatalf("Retrieve() = %d bytes, %v", len(got), err)
	}
	receipt, disposition, err := transport.Submit(context.Background(), descriptor, agent.SnapshotRecord{Sequence: 1, SHA256: hash, IdempotencyKey: "idempotency-1"}, document)
	if err != nil || disposition != "" || receipt.SnapshotSHA256 != hash {
		t.Fatalf("Submit() = %+v, %q, %v", receipt, disposition, err)
	}
}

func TestTaskTransportTreatsUnverifiable2xxAsAutomaticRetry(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"accepted":true,"snapshotSha256":"wrong"}`)
	}))
	defer server.Close()
	descriptor := validDescriptor()
	descriptor.Submission.URL = server.URL
	receipt, disposition, err := agent.NewTaskTransport(server.Client()).Submit(context.Background(), descriptor, agent.SnapshotRecord{Sequence: 1, SHA256: strings.Repeat("a", 64), IdempotencyKey: "key"}, []byte("content"))
	if err == nil || disposition != agent.AutomaticRetry || receipt.Accepted {
		t.Fatalf("Submit() = %+v, %q, %v", receipt, disposition, err)
	}
}

func minimalDOCX(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, content := range map[string]string{
		"[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"word/document.xml":   `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>`,
	} {
		part, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write([]byte(content))
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

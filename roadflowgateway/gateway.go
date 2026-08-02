// Package roadflowgateway provides the reference read-only WPS Document Gateway contract.
package roadflowgateway

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/liumingjian/wps-plugin/roadflowoa"
)

const (
	ExtensionOrigin   = "chrome-extension://bojjhibgkhknccepabkojdjodhhgdjfd"
	defaultReceiptTTL = 30 * time.Second
)

var handoffPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Config binds exact source paths to customer-owned server Documents.
type Config struct {
	Documents  map[string]string
	ReceiptTTL time.Duration
	Now        func() time.Time
}

type handler struct {
	documents map[string]string
	ttl       time.Duration
	now       func() time.Time
	mu        sync.Mutex
	receipts  map[string]receiptRecord
}

type deliveryReceipt struct {
	ActualFormat string    `json:"actualFormat"`
	ByteCount    int       `json:"byteCount"`
	DeliveredAt  time.Time `json:"deliveredAt"`
	Handoff      string    `json:"handoff"`
	SHA256       string    `json:"sha256"`
	SourcePath   string    `json:"sourcePath"`
}

type receiptRecord struct {
	receipt  deliveryReceipt
	conflict bool
}

// NewHandler creates the fixed read-only Document and receipt endpoints.
func NewHandler(config Config) (http.Handler, error) {
	if len(config.Documents) == 0 {
		return nil, errors.New("Gateway requires at least one Document mapping")
	}
	documents := make(map[string]string, len(config.Documents))
	for sourcePath, target := range config.Documents {
		if !roadflowoa.ValidSourcePath(sourcePath) || roadflowoa.WordFormat(sourcePath) == "" || target == "" {
			return nil, fmt.Errorf("invalid Gateway Document mapping %q", sourcePath)
		}
		documents[sourcePath] = target
	}
	ttl := config.ReceiptTTL
	if ttl == 0 {
		ttl = defaultReceiptTTL
	}
	if ttl < time.Second || ttl > defaultReceiptTTL {
		return nil, errors.New("Gateway receipt TTL must be between one and 30 seconds")
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return &handler{documents: documents, ttl: ttl, now: now, receipts: map[string]receiptRecord{}}, nil
}

func (gateway *handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	switch {
	case request.Method == http.MethodGet && request.URL.Path == "/wps/document":
		gateway.deliverDocument(response, request)
	case request.Method == http.MethodGet && request.URL.Path == "/wps/delivery-receipt":
		gateway.readReceipt(response, request)
	default:
		http.Error(response, "not found", http.StatusNotFound)
	}
}

func (gateway *handler) deliverDocument(response http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	sourcePaths, handoffs := query["fileurl"], query["_wpsHandoff"]
	if len(query) != 2 || len(sourcePaths) != 1 || len(handoffs) != 1 || !handoffPattern.MatchString(handoffs[0]) {
		http.Error(response, "invalid Gateway request", http.StatusBadRequest)
		return
	}
	sourcePath, handoff := sourcePaths[0], handoffs[0]
	target, known := gateway.documents[sourcePath]
	if !known {
		http.Error(response, "Document not found", http.StatusNotFound)
		return
	}
	info, err := os.Lstat(target)
	if err != nil || !info.Mode().IsRegular() {
		http.Error(response, "Document not found", http.StatusNotFound)
		return
	}
	if info.Size() <= 0 || info.Size() > roadflowoa.MaxDocumentBytes {
		http.Error(response, "Document rejected", http.StatusUnprocessableEntity)
		return
	}
	payload, err := os.ReadFile(target)
	format := roadflowoa.WordFormat(sourcePath)
	if err != nil || len(payload) != int(info.Size()) || roadflowoa.ValidateFormatCompatibleDocument(payload, format) != nil {
		http.Error(response, "Document rejected", http.StatusUnprocessableEntity)
		return
	}

	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Length", fmt.Sprintf("%d", len(payload)))
	contentType := "application/msword"
	if format == "docx" {
		contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	}
	response.Header().Set("Content-Type", contentType)
	written, err := response.Write(payload)
	if err != nil || written != len(payload) {
		return
	}
	if err := http.NewResponseController(response).Flush(); err != nil {
		return
	}
	receipt := deliveryReceipt{
		ActualFormat: format,
		ByteCount:    len(payload),
		DeliveredAt:  gateway.now().UTC(),
		Handoff:      handoff,
		SHA256:       fmt.Sprintf("%x", sha256.Sum256(payload)),
		SourcePath:   sourcePath,
	}
	gateway.recordReceipt(receipt)
}

func (gateway *handler) recordReceipt(receipt deliveryReceipt) {
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	gateway.pruneReceipts(receipt.DeliveredAt)
	if existing, found := gateway.receipts[receipt.Handoff]; found {
		existing.conflict = existing.conflict || existing.receipt != receipt
		gateway.receipts[receipt.Handoff] = existing
		return
	}
	gateway.receipts[receipt.Handoff] = receiptRecord{receipt: receipt}
}

func (gateway *handler) readReceipt(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Access-Control-Allow-Origin", ExtensionOrigin)
	response.Header().Set("Cache-Control", "no-store")
	if request.Header.Get("Origin") != ExtensionOrigin {
		http.Error(response, "receipt lookup forbidden", http.StatusForbidden)
		return
	}
	query := request.URL.Query()
	handoffs := query["handoff"]
	if len(query) != 1 || len(handoffs) != 1 || !handoffPattern.MatchString(handoffs[0]) {
		http.Error(response, "invalid receipt request", http.StatusBadRequest)
		return
	}
	gateway.mu.Lock()
	gateway.pruneReceipts(gateway.now().UTC())
	record, found := gateway.receipts[handoffs[0]]
	gateway.mu.Unlock()
	if !found {
		http.Error(response, "receipt not found", http.StatusNotFound)
		return
	}
	if record.conflict {
		http.Error(response, "conflicting receipts", http.StatusConflict)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(response).Encode(record.receipt)
}

func (gateway *handler) pruneReceipts(now time.Time) {
	for handoff, record := range gateway.receipts {
		if !now.Before(record.receipt.DeliveredAt.Add(gateway.ttl)) {
			delete(gateway.receipts, handoff)
		}
	}
}

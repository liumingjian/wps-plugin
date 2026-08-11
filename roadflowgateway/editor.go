package roadflowgateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/liumingjian/wps-plugin/roadflowoa"
)

func (gateway *handler) editorEnabled(response http.ResponseWriter) bool {
	if gateway.trustedOAOrigin == "" {
		http.Error(response, "Gateway editor is not configured", http.StatusNotFound)
		return false
	}
	return true
}

func setExtensionCORS(response http.ResponseWriter) {
	response.Header().Set("Access-Control-Allow-Origin", ExtensionOrigin)
	response.Header().Set("Vary", "Origin")
	response.Header().Set("Cache-Control", "no-store")
}

func (gateway *handler) editorPreflight(response http.ResponseWriter, request *http.Request) {
	if !gateway.editorEnabled(response) {
		return
	}
	setExtensionCORS(response)
	if request.Header.Get("Origin") != ExtensionOrigin {
		http.Error(response, "editor handoff forbidden", http.StatusForbidden)
		return
	}
	response.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	response.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	response.WriteHeader(http.StatusNoContent)
}

func (gateway *handler) registerEditorHandoff(response http.ResponseWriter, request *http.Request) {
	if !gateway.editorEnabled(response) {
		return
	}
	setExtensionCORS(response)
	if request.Header.Get("Origin") != ExtensionOrigin {
		http.Error(response, "editor handoff forbidden", http.StatusForbidden)
		return
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxHandoffBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	var input editorHandoffRequest
	if err := decoder.Decode(&input); err != nil {
		http.Error(response, "invalid editor handoff", http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		http.Error(response, "invalid editor handoff", http.StatusBadRequest)
		return
	}
	if !gateway.validEditorHandoff(input) {
		http.Error(response, "invalid editor handoff", http.StatusBadRequest)
		return
	}

	now := gateway.now().UTC()
	gateway.mu.Lock()
	gateway.pruneEditorSessions(now)
	_, exists := gateway.editorSessions[input.Handoff]
	if !exists {
		gateway.editorSessions[input.Handoff] = editorSession{
			editorHandoffRequest: input,
			ExpiresAt:            now.Add(defaultEditorTTL),
		}
	}
	gateway.mu.Unlock()
	if exists {
		http.Error(response, "editor handoff already exists", http.StatusConflict)
		return
	}

	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(response).Encode(map[string]string{
		"handoff": input.Handoff,
	})
}

func (gateway *handler) validEditorHandoff(input editorHandoffRequest) bool {
	if !handoffPattern.MatchString(input.Handoff) || len(input.Title) == 0 || len(input.Title) > 256 ||
		input.SourcePath != input.SourceIdentity.SourcePath || input.ExpectedFormat != input.SourceIdentity.ActualFormat ||
		roadflowoa.DocumentFormat(input.SourcePath) != input.ExpectedFormat || gateway.documents[input.SourcePath] == "" ||
		input.SourceIdentity.ByteCount <= 0 || input.SourceIdentity.ByteCount > roadflowoa.MaxDocumentBytes ||
		!digestPattern.MatchString(input.SourceIdentity.SHA256) {
		return false
	}
	return validReturnURL(input.ReturnURL, gateway.trustedOAOrigin)
}

func validReturnURL(value, trustedOrigin string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme+"://"+parsed.Host == trustedOrigin && parsed.User == nil
}

func (gateway *handler) readEditorReceipt(response http.ResponseWriter, request *http.Request) {
	if !gateway.editorEnabled(response) {
		return
	}
	session, found := gateway.editorSession(request)
	if !found {
		http.Error(response, "editor handoff not found", http.StatusNotFound)
		return
	}
	response.Header().Set("Access-Control-Allow-Origin", gateway.trustedOAOrigin)
	response.Header().Set("Vary", "Origin")
	gateway.mu.Lock()
	gateway.pruneReceipts(gateway.now().UTC())
	record, found := gateway.receipts[session.Handoff]
	gateway.mu.Unlock()
	response.Header().Set("Cache-Control", "no-store")
	if !found {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if record.conflict {
		http.Error(response, "conflicting receipts", http.StatusConflict)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(response).Encode(record.receipt)
}

func (gateway *handler) editorSession(request *http.Request) (editorSession, bool) {
	if !singleHandoffQuery(request.URL.Query()) {
		return editorSession{}, false
	}
	handoff := request.URL.Query().Get("handoff")
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	gateway.pruneEditorSessions(gateway.now().UTC())
	session, found := gateway.editorSessions[handoff]
	return session, found
}

func (gateway *handler) claimEditorDelivery(handoff, sourcePath string) bool {
	if gateway.trustedOAOrigin == "" {
		return true
	}
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	gateway.pruneEditorSessions(gateway.now().UTC())
	session, found := gateway.editorSessions[handoff]
	if !found || session.Claimed || session.SourcePath != sourcePath {
		return false
	}
	session.Claimed = true
	gateway.editorSessions[handoff] = session
	return true
}

func singleHandoffQuery(query url.Values) bool {
	values := query["handoff"]
	return len(query) == 1 && len(values) == 1 && handoffPattern.MatchString(values[0])
}

func (gateway *handler) pruneEditorSessions(now time.Time) {
	for handoff, session := range gateway.editorSessions {
		if !now.Before(session.ExpiresAt) {
			delete(gateway.editorSessions, handoff)
		}
	}
}

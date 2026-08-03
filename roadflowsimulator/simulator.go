// Package roadflowsimulator composes the customer OA download and OfficeSave
// contracts into a local environment for the signed RoadFlow CRX.
package roadflowsimulator

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/liumingjian/wps-plugin/roadflowoa"
)

const (
	SourcePath      = "/UploadFiles/2026/Acceptance.doc"
	defaultOAOrigin = "http://127.0.0.1:4317"
	sessionCookie   = "roadflow_simulator_session"
	sessionValue    = "authenticated"
)

// Config describes the customer OA Origin exposed to the browser and WPS.
type Config struct {
	StateDir        string
	OAOrigin        string
	InitialDocument []byte
}

// Simulator exposes a direct Document download and authenticated OfficeSave.
type Simulator struct {
	OAHandler    http.Handler
	DocumentPath string
}

// New creates or reopens one persistent local simulation state.
func New(config Config) (*Simulator, error) {
	if config.StateDir == "" {
		return nil, fmt.Errorf("simulator state directory is required")
	}
	if config.OAOrigin == "" {
		config.OAOrigin = defaultOAOrigin
	}
	if err := validateOrigin(config.OAOrigin); err != nil {
		return nil, fmt.Errorf("invalid OA Origin: %w", err)
	}

	documentDir := filepath.Join(config.StateDir, "documents")
	if err := os.MkdirAll(documentDir, 0o700); err != nil {
		return nil, fmt.Errorf("create simulator state: %w", err)
	}
	documentPath := filepath.Join(documentDir, "Acceptance.doc")
	if _, err := os.Stat(documentPath); os.IsNotExist(err) {
		if roadflowoa.ValidateFormatCompatibleDocument(config.InitialDocument, "doc") != nil {
			return nil, fmt.Errorf("simulator initial Document must be a valid DOC")
		}
		if err := os.WriteFile(documentPath, config.InitialDocument, 0o600); err != nil {
			return nil, fmt.Errorf("seed simulator Document: %w", err)
		}
	} else if err != nil {
		return nil, fmt.Errorf("inspect simulator Document: %w", err)
	}

	documents := map[string]string{SourcePath: documentPath}
	officeSave, err := roadflowoa.NewOfficeSaveHandler(roadflowoa.OfficeSaveConfig{
		Documents: documents,
		Authenticated: func(request *http.Request) bool {
			return authenticated(request)
		},
		Authorized: func(_ *http.Request, sourcePath string) bool {
			return sourcePath == SourcePath
		},
	})
	if err != nil {
		return nil, err
	}
	oa := newOAHandler(config, documentPath, officeSave)
	return &Simulator{
		OAHandler: oa, DocumentPath: documentPath,
	}, nil
}

func validateOrigin(value string) error {
	request, err := http.NewRequest(http.MethodGet, value, nil)
	if err != nil || request.URL.Scheme != "http" || request.URL.Host == "" || request.URL.Path != "" ||
		request.URL.RawQuery != "" || request.URL.Fragment != "" || request.URL.User != nil {
		return fmt.Errorf("must be one plain HTTP Origin")
	}
	return nil
}

func newOAHandler(config Config, documentPath string, officeSave http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		if err := simulatorPage.Execute(response, map[string]any{
			"Authenticated": authenticated(request),
			"SourcePath":    SourcePath,
			"OAOrigin":      config.OAOrigin,
		}); err != nil {
			http.Error(response, "simulator page failed", http.StatusInternalServerError)
		}
	})
	mux.HandleFunc("POST /login", func(response http.ResponseWriter, request *http.Request) {
		http.SetCookie(response, &http.Cookie{
			Name: sessionCookie, Value: sessionValue, Path: "/", HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
		})
		http.Redirect(response, request, "/", http.StatusSeeOther)
	})
	mux.HandleFunc("POST /logout", func(response http.ResponseWriter, request *http.Request) {
		http.SetCookie(response, &http.Cookie{
			Name: sessionCookie, Value: "", Path: "/", HttpOnly: true,
			SameSite: http.SameSiteLaxMode, MaxAge: -1,
		})
		http.Redirect(response, request, "/", http.StatusSeeOther)
	})
	mux.HandleFunc("GET "+SourcePath, func(response http.ResponseWriter, request *http.Request) {
		payload, err := os.ReadFile(documentPath)
		if err != nil || roadflowoa.ValidateFormatCompatibleDocument(payload, "doc") != nil {
			http.Error(response, "Document unavailable", http.StatusInternalServerError)
			return
		}
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("Content-Type", "application/msword")
		response.Header().Set("Content-Length", fmt.Sprintf("%d", len(payload)))
		response.Header().Set("Content-Disposition", `attachment; filename="Acceptance.doc"`)
		_, _ = response.Write(payload)
	})
	mux.HandleFunc("GET /simulator/status", func(response http.ResponseWriter, request *http.Request) {
		if !authenticated(request) {
			http.Error(response, "OA session is required", http.StatusUnauthorized)
			return
		}
		payload, err := os.ReadFile(documentPath)
		if err != nil {
			http.Error(response, "Document unavailable", http.StatusInternalServerError)
			return
		}
		info, _ := os.Stat(documentPath)
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(response).Encode(map[string]any{
			"sourcePath": SourcePath,
			"format":     "doc",
			"bytes":      len(payload),
			"sha256":     fmt.Sprintf("%x", sha256.Sum256(payload)),
			"updatedAt":  info.ModTime().UTC().Format(time.RFC3339Nano),
		})
	})
	mux.Handle("POST /RoadFlow/uploadfiles/OfficeSave", officeSave)
	mux.HandleFunc("GET /healthz", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.WriteHeader(http.StatusNoContent)
	})
	return mux
}

func authenticated(request *http.Request) bool {
	cookie, err := request.Cookie(sessionCookie)
	return err == nil && cookie.Value == sessionValue
}

var simulatorPage = template.Must(template.New("simulator").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RoadFlow OA 模拟环境</title>
  <style>
    body { max-width: 760px; margin: 48px auto; padding: 0 24px; font: 16px/1.6 sans-serif; color: #17202a; }
    header { border-bottom: 1px solid #d7dde5; margin-bottom: 28px; }
    a, button { font: inherit; }
    a { color: #1558b0; }
    button { padding: 8px 14px; cursor: pointer; }
    dl { display: grid; grid-template-columns: 170px 1fr; gap: 8px 16px; }
    dt { font-weight: 600; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .document { padding: 20px 0; }
  </style>
</head>
<body>
  <header><h1>RoadFlow OA 模拟环境</h1></header>
  {{if .Authenticated}}
    <p>当前状态：已模拟登录</p>
    <div class="document"><a href="{{.SourcePath}}">打开验收文档 Acceptance.doc</a></div>
    <form method="post" action="/logout"><button type="submit">退出模拟登录</button></form>
  {{else}}
    <p>请先建立模拟 OA 登录态。</p>
    <form method="post" action="/login"><button type="submit">模拟登录</button></form>
  {{end}}
  <h2>CRX 配置</h2>
  <dl>
    <dt>Trusted OA Origin</dt><dd>{{.OAOrigin}}</dd>
  </dl>
</body>
</html>`))

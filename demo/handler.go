package demo

import (
	"archive/zip"
	"bytes"
	"io/fs"
	"net/http"
)

const docxContentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

func Handler() http.Handler {
	assets, err := fs.Sub(Static, "static")
	if err != nil {
		panic(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /documents/{id}/content", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") != "doc-001" {
			http.Error(w, "Unknown Document ID.", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", docxContentType)
		w.Header().Set("Content-Disposition", `attachment; filename="doc-001.docx"`)
		_, _ = w.Write(fixtureDOCX())
	})
	mux.Handle("/", http.FileServer(http.FS(assets)))
	return mux
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

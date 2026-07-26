package acceptance_test

import (
	"debug/macho"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const extensionID = "mbkblmlopgjhdlandbjhpemifinfllim"

func TestSetupAndUninstallDevelopmentDeliverable(t *testing.T) {
	repo := repoRoot(t)
	home := t.TempDir()
	qaxSupport := filepath.Join(home, "Library", "Application Support", "Qaxbrowser")
	if err := os.MkdirAll(qaxSupport, 0o755); err != nil {
		t.Fatal(err)
	}
	installRoot := filepath.Join(home, "demo-install")
	runScript(t, t.TempDir(), filepath.Join(repo, "scripts/setup-macos-arm64.sh"), append(os.Environ(), "HOME="+home, "QAX_SUPPORT_DIR="+qaxSupport, "INSTALL_ROOT="+installRoot))

	binary := filepath.Join(installRoot, "native-host", "native-host")
	opened, err := macho.Open(binary)
	if err != nil {
		t.Fatalf("installed host is not a Mach-O binary: %v", err)
	}
	if opened.Cpu != macho.CpuArm64 {
		t.Fatalf("installed host CPU = %v, want arm64", opened.Cpu)
	}
	opened.Close()

	manifestPath := filepath.Join(qaxSupport, "NativeMessagingHosts", "com.liumingjian.wps_edit_agent.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Path           string   `json:"path"`
		AllowedOrigins []string `json:"allowed_origins"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	wantOrigin := "chrome-extension://" + extensionID + "/"
	if manifest.Path != filepath.Join(installRoot, "native-host", "run-host.sh") || len(manifest.AllowedOrigins) != 1 || manifest.AllowedOrigins[0] != wantOrigin {
		t.Fatalf("installed manifest = path %q origins %q", manifest.Path, manifest.AllowedOrigins)
	}
	manifestData, err := os.ReadFile(filepath.Join(installRoot, "extension", "manifest.json"))
	if err != nil {
		t.Fatalf("unpacked extension missing: %v", err)
	}
	var extensionManifest struct {
		Permissions []string `json:"permissions"`
	}
	if err := json.Unmarshal(manifestData, &extensionManifest); err != nil {
		t.Fatal(err)
	}
	if !contains(extensionManifest.Permissions, "nativeMessaging") {
		t.Fatalf("extension permissions = %q, want nativeMessaging", extensionManifest.Permissions)
	}

	unrelated := filepath.Join(qaxSupport, "NativeMessagingHosts", "unrelated.json")
	if err := os.WriteFile(unrelated, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	documents := filepath.Join(home, "Documents", "keep.docx")
	if err := os.MkdirAll(filepath.Dir(documents), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(documents, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	runScript(t, repo, "scripts/uninstall-macos.sh", append(os.Environ(), "HOME="+home, "QAX_SUPPORT_DIR="+qaxSupport, "INSTALL_ROOT="+installRoot))
	if _, err := os.Stat(installRoot); !os.IsNotExist(err) {
		t.Fatalf("install root still exists: %v", err)
	}
	for _, retained := range []string{unrelated, documents} {
		if _, err := os.Stat(retained); err != nil {
			t.Fatalf("uninstall removed unrelated path %s: %v", retained, err)
		}
	}
}

func TestRunbookAndAcceptanceRecordCoverTheDesignatedMacBoundaries(t *testing.T) {
	repo := repoRoot(t)
	assertContains(t, filepath.Join(repo, "docs", "macos-feasibility-runbook.md"), []string{
		"Prerequisites", "Startup order", "Expected states", "Work Copy", "Snapshot", "Version 3", "current document",
		"Host failure", "Download or launch failure", "Stability or Submission failure", "Preview does not update",
	})
	assertContains(t, filepath.Join(repo, "docs", "macos-feasibility-result.md"), []string{
		"Qaxbrowser 1.2.46005.7", "WPS for macOS 12.1.26035", extensionID, "task-doc-001", "SHA-256",
		"Qaxbrowser Native Messaging", "WPS disk-write observation", "Accepted on the designated Mac", "Observed PoC result",
		"Galaxy Kylin", "Linux ARM64", "customer-system integration", "production durability", "production deployment compatibility",
	})
}

func repoRoot(t *testing.T) string {
	t.Helper()
	cmd := exec.Command("git", "rev-parse", "--show-toplevel")
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(out))
}

func runScript(t *testing.T, dir, script string, env []string) {
	t.Helper()
	cmd := exec.Command("bash", script)
	cmd.Dir = dir
	cmd.Env = env
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s failed: %v\n%s", script, err, out)
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func assertContains(t *testing.T, path string, values []string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range values {
		if !strings.Contains(string(data), value) {
			t.Errorf("%s does not contain %q", path, value)
		}
	}
}

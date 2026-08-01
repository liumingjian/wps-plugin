package acceptance_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRoadFlowReleaseStagesAStandaloneFixedIDCRXRoute(t *testing.T) {
	repo := repoRoot(t)
	root := t.TempDir()
	extensionRoot := filepath.Join(root, "roadflow-extension")
	runScript(t, repo, filepath.Join(repo, "scripts", "stage-roadflow-extension.sh"), append(os.Environ(), "OUTPUT="+extensionRoot, "VERSION=1.0.0"))
	secondExtensionRoot := filepath.Join(root, "roadflow-extension-second")
	runScript(t, repo, filepath.Join(repo, "scripts", "stage-roadflow-extension.sh"), append(os.Environ(), "OUTPUT="+secondExtensionRoot, "VERSION=1.0.0"))
	assertEqualTrees(t, extensionRoot, secondExtensionRoot)

	manifestData, err := os.ReadFile(filepath.Join(extensionRoot, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Name                    string   `json:"name"`
		Version                 string   `json:"version"`
		Key                     string   `json:"key"`
		Permissions             []string `json:"permissions"`
		OptionalHostPermissions []string `json:"optional_host_permissions"`
		OptionsPage             string   `json:"options_page"`
		Background              struct {
			ServiceWorker string `json:"service_worker"`
		} `json:"background"`
	}
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Name != "RoadFlow WPS Editor" || manifest.Version != "1.0.0" || extensionIDFromKey(t, manifest.Key) != productionExtensionID {
		t.Fatalf("RoadFlow manifest identity = %+v", manifest)
	}
	if strings.Join(manifest.Permissions, ",") != "storage" {
		t.Fatalf("RoadFlow permissions = %q", manifest.Permissions)
	}
	if strings.Join(manifest.OptionalHostPermissions, ",") != "http://*/*,https://*/*" {
		t.Fatalf("RoadFlow optional host permissions = %q", manifest.OptionalHostPermissions)
	}
	if manifest.OptionsPage != "options.html" || manifest.Background.ServiceWorker != "service-worker.js" {
		t.Fatalf("RoadFlow packaged entry points = %+v", manifest)
	}

	for _, name := range []string{
		"configuration.js", "content.js", "editor.css", "editor.html", "editor.js",
		"icon.png", "options.css", "options.html", "options.js", "readiness.html",
		"readiness.js", "service-worker.js",
	} {
		if _, err := os.Stat(filepath.Join(extensionRoot, name)); err != nil {
			t.Errorf("staged RoadFlow asset %s: %v", name, err)
		}
	}

	err = filepath.WalkDir(extensionRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		for _, forbidden := range []string{
			"nativeMessaging", "sendNativeMessage", "com.liumingjian.wps_edit_agent", "native-host",
			"local-wps-editing_", "build-deb", "dpkg", "native-installer", "product middleware",
		} {
			if strings.Contains(string(data), forbidden) {
				t.Errorf("RoadFlow artifact %s contains native-route dependency %q", filepath.Base(path), forbidden)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func assertEqualTrees(t *testing.T, firstRoot, secondRoot string) {
	t.Helper()
	err := filepath.WalkDir(firstRoot, func(firstPath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(firstRoot, firstPath)
		if err != nil {
			return err
		}
		secondPath := filepath.Join(secondRoot, relative)
		firstInfo, err := entry.Info()
		if err != nil {
			return err
		}
		secondInfo, err := os.Stat(secondPath)
		if err != nil {
			return err
		}
		if firstInfo.Mode() != secondInfo.Mode() || !firstInfo.ModTime().Equal(secondInfo.ModTime()) {
			t.Errorf("staged metadata differs for %s", relative)
		}
		if entry.IsDir() {
			return nil
		}
		firstData, err := os.ReadFile(firstPath)
		if err != nil {
			return err
		}
		secondData, err := os.ReadFile(secondPath)
		if err != nil {
			return err
		}
		if string(firstData) != string(secondData) {
			t.Errorf("staged content differs for %s", relative)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func extensionIDFromKey(t *testing.T, encodedKey string) string {
	t.Helper()
	key, err := base64.StdEncoding.DecodeString(encodedKey)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(key)
	const alphabet = "abcdefghijklmnop"
	id := make([]byte, 32)
	for index, value := range digest[:16] {
		id[index*2] = alphabet[value>>4]
		id[index*2+1] = alphabet[value&0x0f]
	}
	return string(id)
}

func TestRoadFlowCRXPackagingAndCustomerGuidanceStayOnTheBrowserRoute(t *testing.T) {
	repo := repoRoot(t)
	assertContains(t, filepath.Join(repo, "scripts", "package-roadflow-crx.sh"), []string{
		"CRX_RELEASE_KEY", "expected_fingerprint=c99e0f4e735a4fce2f0718ccc4db53212f46b8813604975be5cf3781d2d7c016",
		"stage-roadflow-extension.sh", "--pack-extension", "mjjoapeohdfkepmocpahbimmmenlfdcb",
	})
	assertContains(t, filepath.Join(repo, "docs", "roadflow-customer-installation.md"), []string{
		"Trusted OA Origin", "Gateway URL template", "exactly one `{sourcePath}`", "without rebuilding",
		"Configuration required", "WPS unavailable", "WPS browser plugin unavailable", "Environment ready",
		"read-only", "byte-preserving", "trusted office network", "No DEB", "historical",
	})
}

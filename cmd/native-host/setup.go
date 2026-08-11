package main

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const productionExtensionID = "mjjoapeohdfkepmocpahbimmmenlfdcb"

var buildVersion = "development"

type setupPaths struct {
	configRoot string
	stateRoot  string
	qaxConfig  string
	hostPath   string
}

type commandResult struct {
	State        string         `json:"state"`
	Message      string         `json:"message"`
	AgentVersion string         `json:"agentVersion"`
	Checks       map[string]any `json:"checks,omitempty"`
	Output       string         `json:"output,omitempty"`
}

func runUserCommand(command string, args []string) error {
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	jsonOutput := flags.Bool("json", false, "write structured JSON")
	paths := defaultSetupPaths()
	flags.StringVar(&paths.configRoot, "config-root", paths.configRoot, "product configuration root")
	flags.StringVar(&paths.stateRoot, "state-root", paths.stateRoot, "product state root")
	flags.StringVar(&paths.qaxConfig, "qax-config", paths.qaxConfig, "Qaxbrowser configuration root")
	flags.StringVar(&paths.hostPath, "host-path", paths.hostPath, "installed Native Messaging Host path")
	output := flags.String("output", "", "diagnostic bundle path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional argument")
	}
	var result commandResult
	var err error
	switch command {
	case "setup":
		result, err = setupUser(paths)
	case "doctor":
		result, err = doctor(paths)
	case "unregister":
		result, err = unregisterUser(paths)
	case "export-diagnostics":
		result, err = exportDiagnostics(paths, *output)
	default:
		return fmt.Errorf("unknown user command %q", command)
	}
	if err != nil {
		result = commandResult{State: "action-required", Message: err.Error(), AgentVersion: buildVersion}
	}
	if *jsonOutput {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetEscapeHTML(false)
		if encodeErr := encoder.Encode(result); encodeErr != nil {
			return encodeErr
		}
	} else {
		fmt.Fprintln(os.Stdout, result.Message)
	}
	return err
}

func defaultSetupPaths() setupPaths {
	home, _ := os.UserHomeDir()
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		configHome = filepath.Join(home, ".config")
	}
	stateHome := os.Getenv("XDG_STATE_HOME")
	if stateHome == "" {
		stateHome = filepath.Join(home, ".local", "state")
	}
	return setupPaths{
		configRoot: filepath.Join(configHome, "local-wps-editing"),
		stateRoot:  filepath.Join(stateHome, "local-wps-editing"),
		qaxConfig:  filepath.Join(configHome, "qaxbrowser"),
		hostPath:   "/usr/lib/local-wps-editing/native-host",
	}
}

func setupUser(paths setupPaths) (commandResult, error) {
	if !filepath.IsAbs(paths.hostPath) {
		return commandResult{}, errors.New("Native Messaging Host path must be absolute")
	}
	if err := ensureUserDirectory(paths.configRoot); err != nil {
		return commandResult{}, err
	}
	if err := ensureUserDirectory(paths.stateRoot); err != nil {
		return commandResult{}, err
	}
	if err := ensureUserDirectory(filepath.Join(paths.stateRoot, "tasks")); err != nil {
		return commandResult{}, err
	}
	if info, err := os.Lstat(paths.qaxConfig); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return commandResult{}, errors.New("Start Qaxbrowser once, then run User Setup again")
	}
	manifestDir := filepath.Join(paths.qaxConfig, "NativeMessagingHosts")
	if err := ensureUserDirectory(manifestDir); err != nil {
		return commandResult{}, err
	}
	manifest := struct {
		Name           string   `json:"name"`
		Description    string   `json:"description"`
		Path           string   `json:"path"`
		Type           string   `json:"type"`
		AllowedOrigins []string `json:"allowed_origins"`
	}{"com.liumingjian.wps_edit_agent", "Local WPS Editing Native Messaging Host", paths.hostPath, "stdio", []string{"chrome-extension://" + productionExtensionID + "/"}}
	payload, _ := json.MarshalIndent(manifest, "", "  ")
	payload = append(payload, '\n')
	if err := atomicUserWrite(filepath.Join(manifestDir, "com.liumingjian.wps_edit_agent.json"), payload, 0o600); err != nil {
		return commandResult{}, err
	}
	configuration, _ := json.MarshalIndent(map[string]any{"stateVersion": 1, "configuredAt": time.Now().UTC()}, "", "  ")
	if err := atomicUserWrite(filepath.Join(paths.configRoot, "config.json"), append(configuration, '\n'), 0o600); err != nil {
		return commandResult{}, err
	}
	return commandResult{State: "configured", Message: "Registration is configured. Restart Qaxbrowser, then recheck.", AgentVersion: buildVersion}, nil
}

func doctor(paths setupPaths) (commandResult, error) {
	checks := map[string]any{"architecture": runtime.GOARCH, "operatingSystem": runtime.GOOS, "hostPath": paths.hostPath}
	qaxVersion := commandVersion("/opt/qianxin.com/qaxbrowser/qaxbrowser", "--version")
	wpsVersion := commandVersion("dpkg-query", "-W", "-f=${Version}", "wps-office")
	checks["qaxbrowserVersion"] = qaxVersion
	checks["wpsVersion"] = wpsVersion
	registered := validNativeMessagingRegistration(paths)
	checks["registered"] = registered
	state := "unverified"
	message := "Environment is usable but has not matched the designated version matrix."
	if runtime.GOOS != "linux" || runtime.GOARCH != "arm64" || !registered || qaxVersion == "unavailable" || wpsVersion == "unavailable" {
		state = "action-required"
		message = "Configure registration on a Kylin V10 ARM64 desktop."
	} else if strings.Contains(qaxVersion, "1.0.46371.2") && strings.Contains(wpsVersion, "12.1.2.26885.AK.preread.sw") {
		state = "verified"
		message = "The designated Kylin, Qaxbrowser, and WPS environment is verified."
	}
	return commandResult{State: state, Message: message, AgentVersion: buildVersion, Checks: checks}, nil
}

func validNativeMessagingRegistration(paths setupPaths) bool {
	manifestPath := filepath.Join(paths.qaxConfig, "NativeMessagingHosts", "com.liumingjian.wps_edit_agent.json")
	info, err := os.Lstat(manifestPath)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	payload, err := os.ReadFile(manifestPath)
	if err != nil {
		return false
	}
	var manifest struct {
		Name           string   `json:"name"`
		Path           string   `json:"path"`
		Type           string   `json:"type"`
		AllowedOrigins []string `json:"allowed_origins"`
	}
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return false
	}
	wantOrigin := "chrome-extension://" + productionExtensionID + "/"
	return manifest.Name == "com.liumingjian.wps_edit_agent" &&
		manifest.Path == paths.hostPath &&
		manifest.Type == "stdio" &&
		len(manifest.AllowedOrigins) == 1 &&
		manifest.AllowedOrigins[0] == wantOrigin
}

func unregisterUser(paths setupPaths) (commandResult, error) {
	manifest := filepath.Join(paths.qaxConfig, "NativeMessagingHosts", "com.liumingjian.wps_edit_agent.json")
	if err := os.Remove(manifest); err != nil && !os.IsNotExist(err) {
		return commandResult{}, err
	}
	if !safeProductRoot(paths.configRoot) {
		return commandResult{}, errors.New("refusing unsafe product configuration root")
	}
	if err := os.RemoveAll(paths.configRoot); err != nil {
		return commandResult{}, err
	}
	return commandResult{State: "deactivated", Message: "This account is deactivated. Work Copies and Snapshots were retained.", AgentVersion: buildVersion}, nil
}

func exportDiagnostics(paths setupPaths, output string) (commandResult, error) {
	if output == "" {
		output = filepath.Join(paths.stateRoot, "diagnostics", "local-wps-editing-diagnostics.zip")
	}
	if err := ensureUserDirectory(filepath.Dir(output)); err != nil {
		return commandResult{}, err
	}
	file, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return commandResult{}, err
	}
	archive := zip.NewWriter(file)
	entry, err := archive.CreateHeader(&zip.FileHeader{Name: "environment.json", Method: zip.Deflate})
	if err == nil {
		result, _ := doctor(paths)
		err = json.NewEncoder(entry).Encode(result)
	}
	closeErr := archive.Close()
	fileErr := file.Close()
	if err != nil {
		return commandResult{}, err
	}
	if closeErr != nil {
		return commandResult{}, closeErr
	}
	if fileErr != nil {
		return commandResult{}, fileErr
	}
	return commandResult{State: "completed", Message: "Redacted diagnostics were exported.", AgentVersion: buildVersion, Output: output}, nil
}

func ensureUserDirectory(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("user directory must be absolute")
	}
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ownedByCurrentUser(info) {
			return fmt.Errorf("unsafe user directory: %s", path)
		}
		return os.Chmod(path, 0o700)
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return os.Chmod(path, 0o700)
}

func ownedByCurrentUser(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}

func atomicUserWrite(path string, payload []byte, mode os.FileMode) error {
	if info, err := os.Lstat(path); err == nil && (info.Mode()&os.ModeSymlink != 0 || !ownedByCurrentUser(info)) {
		return fmt.Errorf("unsafe existing file: %s", path)
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".setup-*")
	if err != nil {
		return err
	}
	name := temp.Name()
	defer os.Remove(name)
	if err := temp.Chmod(mode); err == nil {
		_, err = temp.Write(payload)
	}
	if err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}

func safeProductRoot(path string) bool {
	clean := filepath.Clean(path)
	home, _ := os.UserHomeDir()
	return filepath.IsAbs(clean) && clean != "/" && clean != home && filepath.Base(clean) == "local-wps-editing"
}

func commandVersion(name string, args ...string) string {
	output, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return "unavailable"
	}
	return strings.TrimSpace(string(output))
}

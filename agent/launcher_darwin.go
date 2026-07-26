//go:build darwin

package agent

import (
	"context"
	"os/exec"
	"path/filepath"
)

// LaunchServicesLauncher asks macOS Launch Services to open a Work Copy in WPS Writer.
type LaunchServicesLauncher struct{}

func (LaunchServicesLauncher) Open(ctx context.Context, path string) (EditingSession, error) {
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err := exec.CommandContext(ctx, "open", "-a", "wpsoffice", absolutePath).Run(); err != nil {
		return nil, err
	}
	canonicalPath, err := filepath.EvalSymlinks(absolutePath)
	if err == nil {
		absolutePath = canonicalPath
	}
	return &pathEditingSession{path: absolutePath, probe: wpsHoldsPath}, nil
}

func wpsHoldsPath(ctx context.Context, path string) (bool, error) {
	return commandHoldsPath(ctx, "wpsoffice", path)
}

func NewPlatformLauncher() Launcher { return LaunchServicesLauncher{} }

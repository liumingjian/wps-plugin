package agent

import (
	"context"
	"os/exec"
)

// LaunchServicesLauncher asks macOS Launch Services to open a Work Copy in WPS Writer.
type LaunchServicesLauncher struct{}

func (LaunchServicesLauncher) Open(ctx context.Context, path string) error {
	return exec.CommandContext(ctx, "open", "-a", "wpsoffice", path).Run()
}

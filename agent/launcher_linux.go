//go:build linux

package agent

import (
	"context"
	"os/exec"
)

const kylinWPSPath = "/usr/bin/wps"

type LinuxLauncher struct {
	start func(context.Context, string, ...string) error
	probe func(context.Context, string) (bool, error)
}

func (launcher LinuxLauncher) Open(ctx context.Context, path string) (EditingSession, error) {
	path = canonicalPath(path)
	start := launcher.start
	if start == nil {
		start = startCommand
	}
	if err := start(ctx, kylinWPSPath, path); err != nil {
		return nil, err
	}
	probe := launcher.probe
	if probe == nil {
		probe = linuxWPSHoldsPath
	}
	return &pathEditingSession{path: path, probe: probe}, nil
}

func startCommand(ctx context.Context, name string, args ...string) error {
	command := exec.CommandContext(ctx, name, args...)
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

func linuxWPSHoldsPath(ctx context.Context, path string) (bool, error) {
	return commandHoldsPath(ctx, "wps", path)
}

func NewPlatformLauncher() Launcher { return LinuxLauncher{} }

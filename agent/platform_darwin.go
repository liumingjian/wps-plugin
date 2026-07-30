//go:build darwin

package agent

import (
	"errors"
	"os"
	"path/filepath"
)

var ErrTaskActive = errors.New("another Editing Task is active")

type TaskLock struct{}

func DefaultStateRoot() (string, error) {
	return filepath.Join(os.TempDir(), "wps-edit-agent"), nil
}

func ProductionStateRoot() (string, error) {
	return filepath.Join(os.TempDir(), "local-wps-editing"), nil
}

func AcquireTaskLock(string) (*TaskLock, error) { return &TaskLock{}, nil }

func (*TaskLock) Close() error { return nil }

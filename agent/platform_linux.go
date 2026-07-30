//go:build linux

package agent

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

var ErrTaskActive = errors.New("another Editing Task is active")

type TaskLock struct {
	file *os.File
}

func DefaultStateRoot() (string, error) {
	stateHome := os.Getenv("XDG_STATE_HOME")
	if stateHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		stateHome = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(stateHome, "wps-edit-demo"), nil
}

func ProductionStateRoot() (string, error) {
	stateHome := os.Getenv("XDG_STATE_HOME")
	if stateHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		stateHome = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(stateHome, "local-wps-editing"), nil
}

func AcquireTaskLock(stateRoot string) (*TaskLock, error) {
	if err := os.MkdirAll(stateRoot, 0o700); err == nil {
		err = os.Chmod(stateRoot, 0o700)
		if err != nil {
			return nil, err
		}
	} else {
		return nil, err
	}
	path := filepath.Join(stateRoot, "active-task.lock")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, ErrTaskActive
		}
		return nil, fmt.Errorf("lock active Editing Task: %w", err)
	}
	return &TaskLock{file: file}, nil
}

func (lock *TaskLock) Close() error {
	if lock == nil || lock.file == nil {
		return nil
	}
	err := syscall.Flock(int(lock.file.Fd()), syscall.LOCK_UN)
	closeErr := lock.file.Close()
	lock.file = nil
	if err != nil {
		return err
	}
	return closeErr
}

//go:build linux

package roadflowoa

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func atomicReplace(target string, payload []byte, mode os.FileMode) error {
	temporary, err := os.CreateTemp(filepath.Dir(target), ".office-save-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()
	if err := temporary.Chmod(mode); err != nil {
		return err
	}
	if _, err := temporary.Write(payload); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	// Exchange fails if the authorized original vanished. An ordinary rename
	// would silently create a new target and misreport that as an overwrite.
	return unix.Renameat2(unix.AT_FDCWD, temporaryPath, unix.AT_FDCWD, target, unix.RENAME_EXCHANGE)
}

//go:build !linux

package roadflowoa

import (
	"errors"
	"os"
)

func atomicReplace(_ string, _ []byte, _ os.FileMode) error {
	return errors.New("atomic OfficeSave replacement requires Linux renameat2")
}

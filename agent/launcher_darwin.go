package agent

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	sessionProbeInterval   = 500 * time.Millisecond
	sessionAcquireTimeout  = 30 * time.Second
	sessionReleaseDuration = 2 * time.Second
	sessionReleaseCount    = 3
)

// LaunchServicesLauncher asks macOS Launch Services to open a Work Copy in WPS Writer.
type LaunchServicesLauncher struct{}

type pathEditingSession struct {
	path  string
	probe func(context.Context, string) (bool, error)
}

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

func (session *pathEditingSession) WaitClosed(ctx context.Context) error {
	ticker := time.NewTicker(sessionProbeInterval)
	defer ticker.Stop()
	acquireTimer := time.NewTimer(sessionAcquireTimeout)
	defer acquireTimer.Stop()
	observedHeld := false
	releaseCount := 0
	var releaseStarted time.Time
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-acquireTimer.C:
			if !observedHeld {
				return errors.New("WPS did not open the task-specific Work Copy before the observation deadline")
			}
		case now := <-ticker.C:
			held, err := session.probe(ctx, session.path)
			if err != nil {
				return err
			}
			if held {
				observedHeld = true
				releaseCount = 0
				releaseStarted = time.Time{}
				continue
			}
			if !observedHeld {
				continue
			}
			if releaseCount == 0 {
				releaseStarted = now
			}
			releaseCount++
			if releaseCount >= sessionReleaseCount && now.Sub(releaseStarted) >= sessionReleaseDuration {
				return nil
			}
		}
	}
}

func wpsHoldsPath(ctx context.Context, path string) (bool, error) {
	command := exec.CommandContext(ctx, "lsof", "-nP", "-a", "-c", "wpsoffice", "-F", "cn", "--", path)
	output, err := command.Output()
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && exitError.ExitCode() == 1 && len(output) == 0 {
			return false, nil
		}
		return false, err
	}
	return lsofShowsWPSPath(output, path), nil
}

func lsofShowsWPSPath(output []byte, path string) bool {
	canonicalTarget, err := filepath.EvalSymlinks(path)
	if err != nil {
		canonicalTarget = filepath.Clean(path)
	}
	commandIsWPS := false
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case 'c':
			commandIsWPS = strings.EqualFold(string(line[1:]), "wpsoffice")
		case 'n':
			candidate := string(line[1:])
			canonicalCandidate, err := filepath.EvalSymlinks(candidate)
			if err != nil {
				canonicalCandidate = filepath.Clean(candidate)
			}
			if commandIsWPS && canonicalCandidate == canonicalTarget {
				return true
			}
		}
	}
	return false
}

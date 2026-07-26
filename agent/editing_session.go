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

type pathEditingSession struct {
	path            string
	probe           func(context.Context, string) (bool, error)
	probeInterval   time.Duration
	acquireTimeout  time.Duration
	releaseDuration time.Duration
	releaseCount    int
}

func (session *pathEditingSession) WaitClosed(ctx context.Context) error {
	probeInterval := session.probeInterval
	if probeInterval <= 0 {
		probeInterval = sessionProbeInterval
	}
	acquireTimeout := session.acquireTimeout
	if acquireTimeout <= 0 {
		acquireTimeout = sessionAcquireTimeout
	}
	releaseDuration := session.releaseDuration
	if releaseDuration <= 0 {
		releaseDuration = sessionReleaseDuration
	}
	requiredReleaseCount := session.releaseCount
	if requiredReleaseCount <= 0 {
		requiredReleaseCount = sessionReleaseCount
	}
	ticker := time.NewTicker(probeInterval)
	defer ticker.Stop()
	acquireTimer := time.NewTimer(acquireTimeout)
	defer acquireTimer.Stop()
	observedHeld := false
	absentCount := 0
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
				absentCount = 0
				releaseStarted = time.Time{}
				continue
			}
			if !observedHeld {
				continue
			}
			if absentCount == 0 {
				releaseStarted = now
			}
			absentCount++
			if absentCount >= requiredReleaseCount && now.Sub(releaseStarted) >= releaseDuration {
				return nil
			}
		}
	}
}

func commandHoldsPath(ctx context.Context, commandName, path string) (bool, error) {
	command := exec.CommandContext(ctx, "lsof", "-nP", "-a", "-c", commandName, "-F", "cn", "--", path)
	output, err := command.Output()
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && exitError.ExitCode() == 1 && len(output) == 0 {
			return false, nil
		}
		return false, err
	}
	return lsofShowsCommandPath(output, commandName, path), nil
}

func lsofShowsCommandPath(output []byte, commandName, path string) bool {
	canonicalTarget := canonicalPath(path)
	commandMatches := false
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case 'c':
			commandMatches = strings.EqualFold(string(line[1:]), commandName)
		case 'n':
			if commandMatches && canonicalPath(string(line[1:])) == canonicalTarget {
				return true
			}
		}
	}
	return false
}

func canonicalPath(path string) string {
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		absolutePath = filepath.Clean(path)
	}
	canonical, err := filepath.EvalSymlinks(absolutePath)
	if err == nil {
		return canonical
	}
	return filepath.Clean(absolutePath)
}

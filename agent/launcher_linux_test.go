//go:build linux

package agent

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestLinuxLauncherUsesFixedWPSCommandAndCanonicalWorkCopyPath(t *testing.T) {
	realDir := t.TempDir()
	workCopy := filepath.Join(realDir, "Work Copy.docx")
	if err := os.WriteFile(workCopy, []byte("docx"), 0o600); err != nil {
		t.Fatal(err)
	}
	linkDir := t.TempDir()
	link := filepath.Join(linkDir, "linked.docx")
	if err := os.Symlink(workCopy, link); err != nil {
		t.Fatal(err)
	}
	var command string
	var args []string
	launcher := LinuxLauncher{
		start: func(_ context.Context, name string, values ...string) error {
			command, args = name, values
			return nil
		},
		probe: func(context.Context, string) (bool, error) { return true, nil },
	}
	session, err := launcher.Open(context.Background(), link)
	if err != nil {
		t.Fatal(err)
	}
	if command != "/usr/bin/wps" || !reflect.DeepEqual(args, []string{workCopy}) {
		t.Fatalf("launch = %q %q, want /usr/bin/wps [%q]", command, args, workCopy)
	}
	if got := session.(*pathEditingSession).path; got != workCopy {
		t.Fatalf("session path = %q, want %q", got, workCopy)
	}
}

func TestPathEditingSessionRequiresHeldThenReleaseWindow(t *testing.T) {
	states := []bool{false, true, false, true, false, false, false}
	index := 0
	session := &pathEditingSession{
		path: "work.docx",
		probe: func(context.Context, string) (bool, error) {
			if index >= len(states) {
				return false, nil
			}
			value := states[index]
			index++
			return value, nil
		},
		probeInterval:   2 * time.Millisecond,
		acquireTimeout:  100 * time.Millisecond,
		releaseDuration: 3 * time.Millisecond,
		releaseCount:    3,
	}
	if err := session.WaitClosed(context.Background()); err != nil {
		t.Fatal(err)
	}
	if index < len(states) {
		t.Fatalf("session closed after %d probes, before complete release sequence", index)
	}
}

func TestLSOFRequiresExactWPSCommandAndCanonicalPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Work Copy.docx")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	output := []byte("cwpsoffice\nn" + path + "\ncwps\nn" + path + "\n")
	if !lsofShowsCommandPath(output, "wps", path) {
		t.Fatal("exact wps holder was not recognized")
	}
	if lsofShowsCommandPath([]byte("cwpsoffice\nn"+path+"\n"), "wps", path) {
		t.Fatal("wpsoffice holder was accepted as wps")
	}
	if lsofShowsCommandPath([]byte("cwps\nn"+path+".other\n"), "wps", path) {
		t.Fatal("non-exact path was accepted")
	}
}

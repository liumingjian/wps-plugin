package roadflowextension

import (
	"os/exec"
	"testing"
)

func TestBrowserContracts(t *testing.T) {
	for _, contract := range []string{"configuration.contract.test.mjs", "service-worker.contract.test.mjs", "readiness.contract.test.mjs"} {
		command := exec.Command("node", contract)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("RoadFlow browser contract %s failed: %v\n%s", contract, err, output)
		}
	}
}

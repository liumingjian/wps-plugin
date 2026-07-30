package extension_test

import (
	"os/exec"
	"testing"
)

func TestPageSDKContract(t *testing.T) {
	command := exec.Command("node", "sdk.contract.test.mjs")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("page SDK contract failed: %v\n%s", err, output)
	}
}

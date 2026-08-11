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

func TestServiceWorkerContract(t *testing.T) {
	command := exec.Command("node", "service-worker.contract.test.mjs")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("service worker contract failed: %v\n%s", err, output)
	}
}

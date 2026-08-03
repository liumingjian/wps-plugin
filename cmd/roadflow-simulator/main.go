package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/liumingjian/wps-plugin/roadflowsimulator"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	oaAddress := env("ROADFLOW_SIMULATOR_OA_ADDR", "127.0.0.1:4317")
	gatewayAddress := env("ROADFLOW_SIMULATOR_GATEWAY_ADDR", "127.0.0.1:4318")
	stateDir := env("ROADFLOW_SIMULATOR_STATE_DIR", "/tmp/roadflow-customer-simulator")
	initialDocumentPath := env("ROADFLOW_SIMULATOR_INITIAL_DOCUMENT", "roadflowsimulator/testdata/Acceptance.doc")
	oaOrigin := "http://" + oaAddress
	gatewayOrigin := "http://" + gatewayAddress
	initialDocument, err := os.ReadFile(initialDocumentPath)
	if err != nil {
		return fmt.Errorf("read initial simulator Document %s: %w", initialDocumentPath, err)
	}

	simulator, err := roadflowsimulator.New(roadflowsimulator.Config{
		StateDir: stateDir, OAOrigin: oaOrigin, GatewayOrigin: gatewayOrigin, InitialDocument: initialDocument,
	})
	if err != nil {
		return err
	}
	oaListener, err := net.Listen("tcp", oaAddress)
	if err != nil {
		return fmt.Errorf("listen on OA address %s: %w", oaAddress, err)
	}
	defer oaListener.Close()
	gatewayListener, err := net.Listen("tcp", gatewayAddress)
	if err != nil {
		return fmt.Errorf("listen on Gateway address %s: %w", gatewayAddress, err)
	}
	defer gatewayListener.Close()

	oaServer := &http.Server{Handler: requestLogger("OA", simulator.OAHandler), ReadHeaderTimeout: 5 * time.Second}
	gatewayServer := &http.Server{Handler: requestLogger("Gateway", simulator.GatewayHandler), ReadHeaderTimeout: 5 * time.Second}
	errorsChannel := make(chan error, 2)
	go func() { errorsChannel <- oaServer.Serve(oaListener) }()
	go func() { errorsChannel <- gatewayServer.Serve(gatewayListener) }()

	log.Printf("RoadFlow customer simulator started")
	log.Printf("OA page: %s", oaOrigin)
	log.Printf("Trusted OA Origin: %s", oaOrigin)
	log.Printf("Gateway template: %s", simulator.GatewayTemplate)
	log.Printf("State directory: %s", stateDir)
	log.Printf("Stop both servers with Ctrl+C")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case <-ctx.Done():
	case serveErr := <-errorsChannel:
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			return serveErr
		}
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = oaServer.Shutdown(shutdownContext)
	_ = gatewayServer.Shutdown(shutdownContext)
	log.Printf("RoadFlow customer simulator stopped")
	return nil
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func requestLogger(name string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		log.Printf("%s %s %s", name, request.Method, request.URL.RequestURI())
		next.ServeHTTP(response, request)
	})
}

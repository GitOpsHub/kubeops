package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
)

func TestHealth(t *testing.T) {
	handler := NewHandler(config.Config{
		Environment:       "test",
		CORSAllowedOrigin: "http://localhost:5173",
	})
	request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", response.Code)
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "http://localhost:5173" {
		t.Fatal("expected CORS header")
	}

	var body map[string]string
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" || body["environment"] != "test" {
		t.Fatalf("unexpected response: %#v", body)
	}
}

func TestUnknownRoute(t *testing.T) {
	response := httptest.NewRecorder()
	NewHandler(config.Config{}).ServeHTTP(
		response,
		httptest.NewRequest(http.MethodGet, "/missing", nil),
	)

	if response.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d", response.Code)
	}
}

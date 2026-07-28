package httpapi

import (
	"compress/gzip"
	"compress/zlib"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
)

func TestArgoProxyAuthenticatesAndRebasesTheUI(t *testing.T) {
	var gotPath, gotAuth, gotCookie string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth, gotCookie = r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Cookie")
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<!doctype html><html><head><base href="/">`+
			`<script defer="defer" src="main.abc123.js"></script></head></html>`)
	}))
	defer upstream.Close()

	target := config.ArgoTarget{
		SourceID: "aws", ProviderResourceID: "arn:cluster/prod",
		ServerURL: upstream.URL, Token: "target-token",
	}
	proxy, err := newArgoProxy([]config.ArgoTarget{target})
	if err != nil {
		t.Fatal(err)
	}
	mount := "/argo/" + target.ProxyID()

	request := httptest.NewRequest(http.MethodGet, mount+"/applications/payments", nil)
	// A cookie for some other origin must never be forwarded as Argo CD credentials.
	request.Header.Set("Cookie", "session=unrelated")
	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d", recorder.Code)
	}
	if gotPath != "/applications/payments" {
		t.Fatalf("mount prefix was not stripped: %q", gotPath)
	}
	if gotAuth != "Bearer target-token" {
		t.Fatalf("target token was not attached: %q", gotAuth)
	}
	if gotCookie != "" {
		t.Fatalf("browser cookie was forwarded upstream: %q", gotCookie)
	}
	// The bundle reads <base href> once and uses it for routing and every API call,
	// so without this rewrite the UI would call KubeOps' own routes instead.
	body := recorder.Body.String()
	if !strings.Contains(body, `<base href="`+mount+`/">`) {
		t.Fatalf("base href was not rebased onto the mount point: %s", body)
	}
}

// Every browser offers gzip and that header is forwarded upstream, so the HTML
// arriving here is normally compressed. Rewriting the raw bytes matches nothing and
// ships a UI still pointed at "/", which then calls KubeOps' routes instead of Argo's.
func TestArgoProxyRebasesGzippedUI(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Content-Encoding", "gzip")
		writer := gzip.NewWriter(w)
		defer writer.Close()
		io.WriteString(writer, `<!doctype html><html><head><base href="/"></head></html>`)
	}))
	defer upstream.Close()

	target := config.ArgoTarget{
		SourceID: "aws", ProviderResourceID: "arn:cluster/prod",
		ServerURL: upstream.URL, Token: "target-token",
	}
	proxy, err := newArgoProxy([]config.ArgoTarget{target})
	if err != nil {
		t.Fatal(err)
	}
	mount := "/argo/" + target.ProxyID()

	request := httptest.NewRequest(http.MethodGet, mount+"/applications/payments", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, request)

	body := recorder.Body.String()
	if !strings.Contains(body, `<base href="`+mount+`/">`) {
		t.Fatalf("gzipped UI was not rebased: %q", body)
	}
	if recorder.Header().Get("Content-Encoding") != "" {
		t.Fatal("body was rewritten in plain text but still claims an encoding")
	}
}

// Argo CD picks deflate over gzip when the browser offers both, so handling only
// gzip leaves the real-world path broken.
func TestArgoProxyRebasesDeflatedUI(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Content-Encoding", "deflate")
		writer := zlib.NewWriter(w)
		defer writer.Close()
		io.WriteString(writer, `<!doctype html><html><head><base href="/"></head></html>`)
	}))
	defer upstream.Close()

	body, headers := proxyGet(t, upstream.URL, "/applications/payments", "deflate")
	mount := "/argo/" + testTarget(upstream.URL).ProxyID()
	if !strings.Contains(body, `<base href="`+mount+`/">`) {
		t.Fatalf("deflated UI was not rebased: %q", body)
	}
	if headers.Get("Content-Encoding") != "" {
		t.Fatal("body was rewritten in plain text but still claims an encoding")
	}
}

// An encoding the proxy cannot decode must pass through untouched. Rewriting those
// bytes would corrupt the document, and stripping the header would misdescribe it.
func TestArgoProxyPassesThroughUndecodableEncoding(t *testing.T) {
	const payload = "not-really-brotli-but-opaque"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("Content-Encoding", "br")
		io.WriteString(w, payload)
	}))
	defer upstream.Close()

	body, headers := proxyGet(t, upstream.URL, "/applications/payments", "br")
	if body != payload {
		t.Fatalf("undecodable body was altered: %q", body)
	}
	if headers.Get("Content-Encoding") != "br" {
		t.Fatalf("encoding header was dropped from an unrewritten body: %q",
			headers.Get("Content-Encoding"))
	}
}

func testTarget(upstreamURL string) config.ArgoTarget {
	return config.ArgoTarget{
		SourceID: "aws", ProviderResourceID: "arn:cluster/prod",
		ServerURL: upstreamURL, Token: "target-token",
	}
}

func proxyGet(t *testing.T, upstreamURL, path, acceptEncoding string) (string, http.Header) {
	t.Helper()
	target := testTarget(upstreamURL)
	proxy, err := newArgoProxy([]config.ArgoTarget{target})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/argo/"+target.ProxyID()+path, nil)
	request.Header.Set("Accept", "text/html")
	request.Header.Set("Accept-Encoding", acceptEncoding)
	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, request)
	return recorder.Body.String(), recorder.Header()
}

func TestArgoProxyKeepsRedirectsInsideTheMount(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/login", http.StatusFound)
	}))
	defer upstream.Close()

	target := config.ArgoTarget{
		SourceID: "aws", ProviderResourceID: "arn:cluster/prod",
		ServerURL: upstream.URL, Token: "target-token",
	}
	proxy, err := newArgoProxy([]config.ArgoTarget{target})
	if err != nil {
		t.Fatal(err)
	}
	mount := "/argo/" + target.ProxyID()

	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, mount+"/applications", nil))

	if location := recorder.Header().Get("Location"); location != mount+"/login" {
		t.Fatalf("redirect escaped the mount point: %q", location)
	}
}

func TestArgoProxyRejectsUnknownTarget(t *testing.T) {
	proxy, err := newArgoProxy(nil)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/argo/deadbeef/applications", nil))

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unexpected status for unknown target: %d", recorder.Code)
	}
}

// ProxyID must not expose the cluster identifier it is derived from, since it
// travels in browser URLs, history, and access logs.
func TestProxyIDIsStableAndOpaque(t *testing.T) {
	target := config.ArgoTarget{SourceID: "aws", ProviderResourceID: "arn:cluster/prod"}
	other := config.ArgoTarget{SourceID: "aws", ProviderResourceID: "arn:cluster/staging"}

	if target.ProxyID() != target.ProxyID() {
		t.Fatal("ProxyID is not stable")
	}
	if target.ProxyID() == other.ProxyID() {
		t.Fatal("distinct targets share a ProxyID")
	}
	if strings.Contains(target.ProxyID(), "arn") || strings.Contains(target.ProxyID(), "aws") {
		t.Fatalf("ProxyID leaks the cluster identifier: %q", target.ProxyID())
	}
}

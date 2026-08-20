package httpapi

import (
	"compress/gzip"
	"compress/zlib"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
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

// TestArgoProxyResolvesKubespinClusterAndLogsIn covers a cluster with no
// statically configured target: the proxy resolves it by cluster id, looks
// up kubespin's Argo CD details, logs in with the username/password, and
// attaches the resulting session token — so the browser lands signed in
// instead of at an Argo CD login form.
func TestArgoProxyResolvesKubespinClusterAndLogsIn(t *testing.T) {
	var logins int
	var sawAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/session" {
			logins++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"token":"kubespin-session-token"}`))
			return
		}
		sawAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<!doctype html><html><head><base href="/"></head></html>`)
	}))
	defer upstream.Close()

	repo := &fakeRepository{
		cluster: model.Cluster{ID: "cluster-1", Name: "prod"},
		kubespin: model.KubespinArgoCDDetails{
			Endpoint: upstream.URL, Username: "admin", Password: "secret",
		},
	}
	proxy, err := newArgoProxy(nil, repo)
	if err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/argo/cluster-1/applications", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected status: %d, body=%s", recorder.Code, recorder.Body.String())
	}
	if sawAuth != "Bearer kubespin-session-token" {
		t.Fatalf("kubespin session token was not attached: %q", sawAuth)
	}
	if logins != 1 {
		t.Fatalf("expected exactly one login, got %d", logins)
	}

	// A second request against the same cluster reuses the cached session and
	// the cached proxy — no repeat database lookup or login.
	recorder2 := httptest.NewRecorder()
	proxy.ServeHTTP(recorder2, httptest.NewRequest(http.MethodGet, "/argo/cluster-1/applications", nil))
	if recorder2.Code != http.StatusOK {
		t.Fatalf("unexpected status on second request: %d", recorder2.Code)
	}
	if logins != 1 {
		t.Fatalf("expected the session to be cached, got %d logins", logins)
	}
}

// TestArgoProxyRelogsInToKubespinOnUnauthorized proves the cached kubespin
// session recovers from expiry or rotation without a cache TTL: a 401
// invalidates it, and the next request relogins.
func TestArgoProxyRelogsInToKubespinOnUnauthorized(t *testing.T) {
	var logins int
	var rejectedOnce bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/session" {
			logins++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(fmt.Sprintf(`{"token":"session-token-%d"}`, logins)))
			return
		}
		if r.Header.Get("Authorization") == "Bearer session-token-1" && !rejectedOnce {
			rejectedOnce = true
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		io.WriteString(w, `<!doctype html><html><head><base href="/"></head></html>`)
	}))
	defer upstream.Close()

	repo := &fakeRepository{
		cluster: model.Cluster{ID: "cluster-1", Name: "prod"},
		kubespin: model.KubespinArgoCDDetails{
			Endpoint: upstream.URL, Username: "admin", Password: "secret",
		},
	}
	proxy, err := newArgoProxy(nil, repo)
	if err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/argo/cluster-1/applications", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected the first request to surface the 401, got %d", recorder.Code)
	}
	if logins != 1 {
		t.Fatalf("expected one login before the 401, got %d", logins)
	}

	recorder2 := httptest.NewRecorder()
	proxy.ServeHTTP(recorder2, httptest.NewRequest(http.MethodGet, "/argo/cluster-1/applications", nil))
	if recorder2.Code != http.StatusOK {
		t.Fatalf("expected the retried request to succeed, got %d: %s", recorder2.Code, recorder2.Body.String())
	}
	if logins != 2 {
		t.Fatalf("expected a relogin after the 401, got %d logins", logins)
	}
}

func TestArgoProxyReturns404WhenKubespinHasNoAccessForTheCluster(t *testing.T) {
	repo := &fakeRepository{cluster: model.Cluster{ID: "cluster-1", Name: "prod"}}
	proxy, err := newArgoProxy(nil, repo)
	if err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	proxy.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/argo/cluster-1/applications", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", recorder.Code)
	}
}

// TestKubespinArgoSessionPinsCertificateOnFirstConnection proves the
// trust-on-first-use pinning that replaces default certificate verification
// for kubespin's self-signed Argo CD servers (see verifyConnection): the
// first certificate seen is trusted and recorded, a matching certificate on
// a later connection is accepted, and a different certificate — the shape a
// MITM would take — is rejected.
func TestKubespinArgoSessionPinsCertificateOnFirstConnection(t *testing.T) {
	certA := selfSignedTestCert(t)
	certB := selfSignedTestCert(t)
	session := &kubespinArgoSession{endpoint: "https://argo.example.test"}

	if err := session.verifyConnection(tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{certA},
	}); err != nil {
		t.Fatalf("first connection should be pinned without error: %v", err)
	}
	if err := session.verifyConnection(tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{certA},
	}); err != nil {
		t.Fatalf("a connection presenting the pinned certificate should be accepted: %v", err)
	}
	if err := session.verifyConnection(tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{certB},
	}); err == nil {
		t.Fatal("expected a swapped certificate to be rejected")
	}
}

func selfSignedTestCert(t *testing.T) *x509.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return cert
}

package httpapi

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
	"github.com/GitOpsHub/kubeops/backend/internal/model"
)

// argoAccessRepository is the narrow slice of httpapi.Repository the proxy
// needs to resolve a mount that has no statically configured target: given
// the cluster's own id (see clusterArgoAccess), look up its name and then
// kubespin's Argo CD details for it.
type argoAccessRepository interface {
	GetCluster(context.Context, string) (model.Cluster, error)
	GetKubespinArgoDetails(context.Context, string) (model.KubespinArgoCDDetails, error)
}

// argoProxyPrefix is the mount point for the Argo CD reverse proxy. Every target is
// addressed as <argoProxyPrefix>/<target.ProxyID()>/.
const argoProxyPrefix = "/argo/"

// argoProxy serves the Argo CD UI and API of one target through this backend so the
// browser never talks to the Argo CD server directly. It exists because the Argo CD
// UI authenticates from a cookie on its own origin, which KubeOps cannot set
// cross-origin, and because Argo CD endpoints commonly present certificates the
// browser does not trust (a local CA, a private PKI, a port-forward). Proxying moves
// both problems server-side: the API token is attached here and the upstream TLS
// trust is configured here.
//
// Anyone who can reach this endpoint acts on Argo CD with the configured token's
// permissions, so KubeOps' own access control is what protects Argo CD.
type argoProxy struct {
	// targets maps ProxyID to the reverse proxy for that Argo CD server.
	targets map[string]*httputil.ReverseProxy
	// store resolves a mount with no statically configured target: kubespin
	// clusters have no config.ArgoTarget, so their Argo CD access is looked
	// up and proxied on demand instead. Nil when no store was supplied, which
	// simply disables the fallback rather than erroring.
	store argoAccessRepository
	// dynamic caches the reverse proxy resolved for each such cluster id, for
	// the lifetime of the process.
	dynamic sync.Map
}

// newArgoProxy builds the proxy for every statically configured target. store
// is optional (variadic so existing single-argument call sites keep working)
// and, when provided, is consulted for clusters with no static target.
func newArgoProxy(targets []config.ArgoTarget, store ...argoAccessRepository) (*argoProxy, error) {
	proxies := make(map[string]*httputil.ReverseProxy, len(targets))
	for _, target := range targets {
		authHeader := staticAuthHeader(target.Token)
		proxy, err := newTargetProxy(target, authHeader, nil)
		if err != nil {
			return nil, err
		}
		proxies[target.ProxyID()] = proxy
	}
	proxy := &argoProxy{targets: proxies}
	if len(store) > 0 {
		proxy.store = store[0]
	}
	return proxy, nil
}

func staticAuthHeader(token string) func(*http.Request) string {
	return func(*http.Request) string { return "Bearer " + token }
}

func newTargetProxy(
	target config.ArgoTarget,
	authHeader func(*http.Request) string,
	onUnauthorized func(),
) (*httputil.ReverseProxy, error) {
	upstream, err := url.Parse(target.ServerURL)
	if err != nil || upstream.Scheme == "" || upstream.Host == "" {
		return nil, fmt.Errorf("invalid Argo CD server URL for %s: %q", target.SourceID, target.ServerURL)
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if target.CAFile != "" {
		certificate, err := os.ReadFile(target.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read Argo CD CA file: %w", err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil {
			return nil, fmt.Errorf("load system certificate pool: %w", err)
		}
		if !pool.AppendCertsFromPEM(certificate) {
			return nil, errors.New("Argo CD CA file does not contain a valid PEM certificate")
		}
		transport.TLSClientConfig.RootCAs = pool
	}

	mount := argoProxyPrefix + target.ProxyID()
	return buildTargetProxy(mount, upstream, transport, authHeader, onUnauthorized), nil
}

// newKubespinTargetProxy mounts a reverse proxy for a cluster whose Argo CD
// access comes from kubespin rather than a statically configured target.
// kubespin gives only a username and password, so a session is logged into
// lazily and relogged into whenever a request comes back unauthorized.
func newKubespinTargetProxy(id, endpoint, username, password string) (*httputil.ReverseProxy, error) {
	upstream, err := url.Parse(endpoint)
	if err != nil || upstream.Scheme == "" || upstream.Host == "" {
		return nil, fmt.Errorf("invalid kubespin Argo CD server URL: %q", endpoint)
	}

	session := &kubespinArgoSession{
		endpoint: strings.TrimRight(endpoint, "/"),
		username: username,
		password: password,
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	// kubespin's Argo CD servers present Argo CD's own self-signed default
	// certificate, with no CA and no SAN matching the ELB hostname or node IP
	// kubespin reports, so the default chain-and-hostname verification can
	// never succeed here — kubespin gives kubeops no CA to validate against.
	// InsecureSkipVerify only turns off that default check; VerifyConnection
	// replaces it with certificate pinning: the first connection's leaf
	// public key is trusted and recorded (the same trust-on-first-use model
	// SSH host keys use), and every later connection to this cluster must
	// present that same key. This still trusts the very first connection,
	// but unlike a blanket skip of verification, it detects a certificate
	// swapped in afterward — which is exactly what a MITM looks like. The
	// browser's connection to kubeops itself is unaffected either way — this
	// transport is never exposed to it.
	transport.TLSClientConfig = &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true,
		VerifyConnection:   session.verifyConnection,
	}
	session.client = &http.Client{Transport: transport, Timeout: 10 * time.Second}

	mount := argoProxyPrefix + id
	return buildTargetProxy(mount, upstream, transport, session.authHeader, session.invalidate), nil
}

// buildTargetProxy is the reverse-proxy skeleton shared by statically
// configured targets and kubespin-resolved ones. authHeader supplies the
// Authorization header value on every request; onUnauthorized, when set, is
// called when the upstream responds 401 so a refreshable credential (a
// kubespin session token) is dropped and relogged into on the next request.
func buildTargetProxy(
	mount string,
	upstream *url.URL,
	transport *http.Transport,
	authHeader func(*http.Request) string,
	onUnauthorized func(),
) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Transport: transport,
		// The Argo CD UI populates its lists and live resource views from long-lived
		// watch streams. Buffering those holds events until enough bytes accumulate,
		// which leaves the UI sitting on loading skeletons, so every write is flushed
		// straight through.
		FlushInterval: -1,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			r.Out.Host = upstream.Host
			// Strip the mount point: the Argo CD server is unaware it is mounted
			// under a prefix, and only the HTML <base href> teaches the UI about it.
			r.Out.URL.Path = strings.TrimPrefix(r.In.URL.Path, mount)
			if r.Out.URL.Path == "" {
				r.Out.URL.Path = "/"
			}
			r.Out.URL.RawPath = ""
			// Only HTML is rewritten, and only decoded bytes can be rewritten. Argo CD
			// negotiates deflate or gzip from whatever the browser offers, so document
			// requests drop Accept-Encoding and let Go's transport negotiate and undo
			// the compression on its own. Asset requests keep theirs, so the multi-
			// megabyte bundles still stream through compressed.
			if strings.Contains(r.In.Header.Get("Accept"), "text/html") {
				r.Out.Header.Del("Accept-Encoding")
			}
			// The browser holds no Argo CD credentials, and any it did hold would be
			// for a different origin. Replace them with the target's own credential.
			r.Out.Header.Del("Cookie")
			if header := authHeader(r.Out); header != "" {
				r.Out.Header.Set("Authorization", header)
			}
		},
		ModifyResponse: func(response *http.Response) error {
			if response.StatusCode == http.StatusUnauthorized && onUnauthorized != nil {
				onUnauthorized()
			}
			rewriteArgoRedirect(response, mount)
			return rewriteArgoBaseHref(response, mount)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			slog.Error("proxy Argo CD request", "path", r.URL.Path, "error", err)
			// The upstream error can name internal hosts, so only the class of
			// failure is returned to the browser.
			http.Error(w, "Argo CD could not be reached", http.StatusBadGateway)
		},
	}
}

// kubespinArgoSession authenticates to a kubespin cluster's Argo CD server
// with a username and password rather than a long-lived API token, and
// caches the resulting session token until invalidate marks it stale.
type kubespinArgoSession struct {
	endpoint, username, password string
	client                       *http.Client

	mu    sync.Mutex
	token string
	// pinnedSPKI is the SHA-256 hash of the first leaf certificate's
	// SubjectPublicKeyInfo seen for this endpoint (trust-on-first-use). Nil
	// until the first successful handshake.
	pinnedSPKI []byte
}

// verifyConnection implements certificate pinning in place of the default
// chain-and-hostname verification, which InsecureSkipVerify has disabled on
// this transport (see newKubespinTargetProxy for why). It runs once per new
// TLS connection, not per request.
func (s *kubespinArgoSession) verifyConnection(state tls.ConnectionState) error {
	if len(state.PeerCertificates) == 0 {
		return errors.New("kubespin Argo CD server presented no certificate")
	}
	sum := sha256.Sum256(state.PeerCertificates[0].RawSubjectPublicKeyInfo)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pinnedSPKI == nil {
		s.pinnedSPKI = sum[:]
		slog.Warn("pinning kubespin Argo CD certificate on first connection",
			"endpoint", s.endpoint, "fingerprint", hex.EncodeToString(sum[:]))
		return nil
	}
	if !bytes.Equal(s.pinnedSPKI, sum[:]) {
		return fmt.Errorf("kubespin Argo CD certificate for %s does not match the pinned certificate", s.endpoint)
	}
	return nil
}

func (s *kubespinArgoSession) authHeader(r *http.Request) string {
	token, err := s.currentToken(r.Context())
	if err != nil {
		slog.Error("log in to kubespin Argo CD", "endpoint", s.endpoint, "error", err)
		return ""
	}
	return "Bearer " + token
}

func (s *kubespinArgoSession) currentToken(ctx context.Context) (string, error) {
	s.mu.Lock()
	token := s.token
	s.mu.Unlock()
	if token != "" {
		return token, nil
	}
	return s.login(ctx)
}

// invalidate drops the cached token after an upstream 401, the way an
// expired or rotated kubespin credential surfaces. The next request relogins
// instead of repeating that failure forever.
func (s *kubespinArgoSession) invalidate() {
	s.mu.Lock()
	s.token = ""
	s.mu.Unlock()
}

func (s *kubespinArgoSession) login(ctx context.Context) (string, error) {
	body, err := json.Marshal(map[string]string{"username": s.username, "password": s.password})
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, s.endpoint+"/api/v1/session", bytes.NewReader(body),
	)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		return "", fmt.Errorf("log in to Argo CD: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return "", fmt.Errorf("Argo CD login returned status %d", response.StatusCode)
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode Argo CD login response: %w", err)
	}
	if payload.Token == "" {
		return "", errors.New("Argo CD login response did not include a token")
	}
	s.mu.Lock()
	s.token = payload.Token
	s.mu.Unlock()
	return payload.Token, nil
}

func (p *argoProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, argoProxyPrefix)
	id, _, _ := strings.Cut(rest, "/")
	proxy, ok := p.targets[id]
	if !ok {
		proxy, ok = p.resolveDynamicProxy(r.Context(), id)
	}
	if !ok {
		http.Error(w, "unknown Argo CD target", http.StatusNotFound)
		return
	}
	// A bare /argo/<id> would make the UI resolve every relative asset one level up,
	// so anchor it with the trailing slash the <base href> assumes.
	if r.URL.Path == argoProxyPrefix+id {
		http.Redirect(w, r, argoProxyPrefix+id+"/", http.StatusMovedPermanently)
		return
	}
	proxy.ServeHTTP(w, r)
}

// resolveDynamicProxy handles a mount with no statically configured target:
// id is the cluster's own id (see clusterArgoAccess), resolved to its name
// and then to kubespin's cluster_argocd_details on first use and cached
// after that.
func (p *argoProxy) resolveDynamicProxy(ctx context.Context, id string) (*httputil.ReverseProxy, bool) {
	if p.store == nil {
		return nil, false
	}
	if cached, ok := p.dynamic.Load(id); ok {
		return cached.(*httputil.ReverseProxy), true
	}
	cluster, err := p.store.GetCluster(ctx, id)
	if err != nil {
		return nil, false
	}
	details, err := p.store.GetKubespinArgoDetails(ctx, cluster.Name)
	if err != nil {
		return nil, false
	}
	proxy, err := newKubespinTargetProxy(id, details.Endpoint, details.Username, details.Password)
	if err != nil {
		slog.Error("configure kubespin Argo CD proxy", "cluster", id, "error", err)
		return nil, false
	}
	actual, _ := p.dynamic.LoadOrStore(id, proxy)
	return actual.(*httputil.ReverseProxy), true
}

// rewriteArgoBaseHref repoints the UI at its mount path. The Argo CD bundle reads
// <base href> once at startup and uses it both as the router basename and as the
// prefix for every API call, so this single tag is what makes the app work under a
// path prefix. Its own asset references are already relative.
//
// Only HTML is touched, so the compressed JS bundles stream through untouched.
func rewriteArgoBaseHref(response *http.Response, mount string) error {
	if !strings.Contains(response.Header.Get("Content-Type"), "text/html") {
		return nil
	}
	encoding := response.Header.Get("Content-Encoding")
	if !decodable(encoding) {
		// Rewriting bytes we cannot decode would corrupt the document. Passing it
		// through leaves the UI based at "/", which is visibly broken rather than
		// silently wrong, and the log says why.
		slog.Error("cannot rebase Argo CD UI", "contentEncoding", encoding)
		return nil
	}
	body, err := decodedBody(response, encoding)
	if err != nil {
		return err
	}
	body = bytes.Replace(body,
		[]byte(`<base href="/">`),
		[]byte(`<base href="`+mount+`/">`),
		1,
	)
	// Re-emitted as plain text, so the upstream encoding no longer describes it.
	// This HTML is under a kilobyte; nothing is gained by re-compressing it.
	response.Header.Del("Content-Encoding")
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	response.Header.Set("Content-Length", fmt.Sprint(len(body)))
	return nil
}

func decodable(encoding string) bool {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "", "identity", "gzip", "deflate":
		return true
	}
	return false
}

// decodedBody reads the response body, undoing the content encoding. Requests that
// reach here should already have been steered away from compression, but an upstream
// is free to compress anyway, and reading those bytes raw would leave the rewrite
// silently matching nothing.
func decodedBody(response *http.Response, encoding string) ([]byte, error) {
	defer response.Body.Close()
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "gzip":
		decompressed, err := gzip.NewReader(response.Body)
		if err != nil {
			return nil, err
		}
		defer decompressed.Close()
		return io.ReadAll(decompressed)
	case "deflate":
		decompressed, err := zlib.NewReader(response.Body)
		if err != nil {
			return nil, err
		}
		defer decompressed.Close()
		return io.ReadAll(decompressed)
	}
	return io.ReadAll(response.Body)
}

// rewriteArgoRedirect keeps upstream redirects inside the proxy. Argo CD answers
// with absolute paths such as /login, which would otherwise escape the mount point
// and land on a KubeOps route.
func rewriteArgoRedirect(response *http.Response, mount string) {
	location := response.Header.Get("Location")
	if location == "" || !strings.HasPrefix(location, "/") || strings.HasPrefix(location, "//") {
		return
	}
	response.Header.Set("Location", mount+location)
}

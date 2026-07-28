package httpapi

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"

	"github.com/GitOpsHub/kubeops/backend/internal/config"
)

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
}

func newArgoProxy(targets []config.ArgoTarget) (*argoProxy, error) {
	proxies := make(map[string]*httputil.ReverseProxy, len(targets))
	for _, target := range targets {
		proxy, err := newTargetProxy(target)
		if err != nil {
			return nil, err
		}
		proxies[target.ProxyID()] = proxy
	}
	return &argoProxy{targets: proxies}, nil
}

func newTargetProxy(target config.ArgoTarget) (*httputil.ReverseProxy, error) {
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
	token := target.Token

	proxy := &httputil.ReverseProxy{
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
			// for a different origin. Replace them with the target's API token.
			r.Out.Header.Del("Cookie")
			r.Out.Header.Set("Authorization", "Bearer "+token)
		},
		ModifyResponse: func(response *http.Response) error {
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
	return proxy, nil
}

func (p *argoProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, argoProxyPrefix)
	id, _, _ := strings.Cut(rest, "/")
	proxy, ok := p.targets[id]
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

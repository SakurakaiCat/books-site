// Command books-api is a small standalone backend for the books.rikka.moe
// landing page. It verifies premium (爱发电) keys and gates the premium
// downloads behind an HMAC-signed HttpOnly cookie, so the file URLs never
// appear in page source or JS.
//
// API contract:
//
//	POST /api/books/verify           {"key": "..."} -> {"success": true, "labels": [...]} + Set-Cookie
//	GET  /api/books/download/{index} signed cookie  -> the file, or a 302 to the real URL
//	GET  /healthz                    -> {"ok": true}
//
// A PREMIUM_DOWNLOAD_URL entry that starts with "/" is a self-hosted file:
// it is served with X-Accel-Redirect, i.e. nginx streams the file from an
// `internal` location (see the vhost's /protected/ block) and the bytes never
// pass through this process. Anything else is treated as a remote URL and
// answered with a 302.
//
// Configuration (environment variables):
//
//	PORT                    listen port                          (default "8787")
//	BOOK_KEYS               comma-separated valid premium keys   (required)
//	PREMIUM_DOWNLOAD_URL    comma-separated download URLs or self-hosted paths (required)
//	PREMIUM_DOWNLOAD_LABELS optional comma-separated button labels matching
//	                        PREMIUM_DOWNLOAD_URL; missing entries fall back to
//	                        a label derived from the URL
//	SIGNING_SECRET          HMAC secret for the session cookie   (default: BOOK_KEYS)
//	ALLOWED_ORIGINS         comma-separated credentialed CORS origins
//	                        (default "https://books.rikka.moe,http://localhost:4321,http://127.0.0.1:4321")
//	DEV_INSECURE            set to "1" to drop the Secure cookie attribute on plain-http dev
//
// Deployment note: keep the API on the site's own origin (nginx proxies
// /api/ to this process) so the SameSite=Strict cookie keeps working.
package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"
)

const (
	cookieName      = "book_auth"
	cookieMaxAgeSec = 1800 // 30 minutes, mirrors the previous implementation
	tokenParts      = 2    // "<timestamp>:<hex-hmac>"
)

// config holds all runtime configuration parsed from the environment.
type config struct {
	allowedOrigins map[string]bool
	keys           map[string]bool
	downloadURLs   []string
	labels         []string
	signingSecret  string
	devInsecure    bool
}

func loadConfig(getenv func(string) string) (*config, error) {
	keys := map[string]bool{}
	for _, k := range strings.Split(getenv("BOOK_KEYS"), ",") {
		if k = strings.TrimSpace(k); k != "" {
			keys[k] = true
		}
	}
	if len(keys) == 0 {
		return nil, errors.New("BOOK_KEYS is not set (comma-separated premium keys)")
	}

	var urls, labels []string
	for _, u := range strings.Split(getenv("PREMIUM_DOWNLOAD_URL"), ",") {
		if u = strings.TrimSpace(u); u != "" {
			urls = append(urls, u)
			labels = append(labels, "")
		}
	}
	if len(urls) == 0 {
		return nil, errors.New("PREMIUM_DOWNLOAD_URL is not set (comma-separated download URLs)")
	}

	// PREMIUM_DOWNLOAD_LABELS overrides the derived labels (it is how the
	// buttons carry an extract password or a volume name). Entries left blank
	// or missing fall back to a label derived from the URL.
	for i, l := range strings.Split(getenv("PREMIUM_DOWNLOAD_LABELS"), ",") {
		if i >= len(labels) {
			break
		}
		labels[i] = strings.TrimSpace(l)
	}
	for i, l := range labels {
		if l == "" {
			labels[i] = labelForURL(urls[i])
		}
	}

	secret := strings.TrimSpace(getenv("SIGNING_SECRET"))
	if secret == "" {
		// Fall back to BOOK_KEYS so a separate secret is optional, mirroring
		// the previous implementation.
		secret = strings.TrimSpace(getenv("BOOK_KEYS"))
	}

	origins := map[string]bool{}
	raw := strings.TrimSpace(getenv("ALLOWED_ORIGINS"))
	if raw == "" {
		raw = "https://books.rikka.moe,http://localhost:4321,http://127.0.0.1:4321"
	}
	for _, o := range strings.Split(raw, ",") {
		if o = strings.TrimSpace(o); o != "" {
			origins[o] = true
		}
	}

	return &config{
		allowedOrigins: origins,
		keys:           keys,
		downloadURLs:   urls,
		labels:         labels,
		signingSecret:  secret,
		devInsecure:    getenv("DEV_INSECURE") == "1",
	}, nil
}

// labelForURL derives the display label shown after a successful verify.
// Only labels cross the API boundary — never the URLs themselves.
func labelForURL(u string) string {
	switch {
	case strings.HasPrefix(u, "/"):
		return "站内下载"
	case strings.Contains(u, "lanzn.com"), strings.Contains(u, "lanzou"):
		return "蓝奏云下载（国内推荐）"
	case strings.Contains(u, "cloud.rikka.moe"):
		return "网盘下载"
	default:
		return "下载"
	}
}

// server bundles the config with the HTTP handlers.
type server struct {
	cfg *config
}

func main() {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatalf("books-api: %v", err)
	}

	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = "8787"
	}

	s := &server{cfg: cfg}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/books/verify", s.handleVerify)
	mux.HandleFunc("OPTIONS /api/books/verify", s.handleOptions)
	mux.HandleFunc("GET /api/books/download/{index}", s.handleDownload)
	mux.HandleFunc("GET /healthz", s.handleHealthz)

	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	log.Printf("books-api: listening on :%s (%d download target(s))", port, len(cfg.downloadURLs))
	log.Fatal(httpServer.ListenAndServe())
}

// corsHeaders reflects the request origin only when it is on the allowlist.
// Credentialed CORS forbids "*", so the origin must be echoed explicitly.
func (s *server) corsHeaders(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "content-type")
	h.Set("Access-Control-Max-Age", "86400")
	h.Add("Vary", "Origin")
	if origin := r.Header.Get("Origin"); origin != "" && s.cfg.allowedOrigins[origin] {
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Access-Control-Allow-Credentials", "true")
	}
}

func (s *server) writeJSON(w http.ResponseWriter, r *http.Request, status int, body any) {
	s.corsHeaders(w, r)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (s *server) handleOptions(w http.ResponseWriter, r *http.Request) {
	s.corsHeaders(w, r)
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprint(w, `{"ok":true}`)
}

// buildToken signs a timestamp with HMAC-SHA256: "<unix>:<hex mac>".
func (s *server) buildToken(ts int64) string {
	mac := hmac.New(sha256.New, []byte(s.cfg.signingSecret))
	fmt.Fprintf(mac, "%d", ts)
	return strconv.FormatInt(ts, 10) + ":" + hex.EncodeToString(mac.Sum(nil))
}

// verifyToken checks signature freshness and validity in constant time.
func (s *server) verifyToken(token string, maxAgeSec int64) bool {
	tsRaw, sig, found := strings.Cut(token, ":")
	if !found || tsRaw == "" || sig == "" {
		return false
	}
	ts, err := strconv.ParseInt(tsRaw, 10, 64)
	if err != nil {
		return false
	}
	now := time.Now().Unix()
	if ts > now+30 || now-ts > maxAgeSec { // allow 30 s clock skew
		return false
	}
	return hmac.Equal([]byte(s.buildToken(ts)), []byte(token))
}

func (s *server) handleVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
		s.writeJSON(w, r, http.StatusBadRequest, map[string]any{"success": false, "message": "请求格式错误"})
		return
	}

	key := strings.TrimSpace(body.Key)
	if key == "" {
		s.writeJSON(w, r, http.StatusBadRequest, map[string]any{"success": false, "message": "请填写密钥"})
		return
	}

	if !s.cfg.keys[key] {
		// Uniform delay so response timing does not reveal validity.
		time.Sleep(500 * time.Millisecond)
		s.writeJSON(w, r, http.StatusForbidden, map[string]any{"success": false, "message": "密钥无效，请检查后重试"})
		return
	}

	cookie := &http.Cookie{
		Name:     cookieName,
		Value:    s.buildToken(time.Now().Unix()),
		Path:     "/api/books",
		MaxAge:   cookieMaxAgeSec,
		HttpOnly: true,
		Secure:   !s.cfg.devInsecure,
		SameSite: http.SameSiteStrictMode,
	}
	http.SetCookie(w, cookie)
	s.writeJSON(w, r, http.StatusOK, map[string]any{"success": true, "labels": s.cfg.labels})
}

func (s *server) handleDownload(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(cookieName)
	if err != nil || !s.verifyToken(cookie.Value, cookieMaxAgeSec) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	index, err := strconv.Atoi(r.PathValue("index"))
	if err != nil || index < 0 {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}
	if index >= len(s.cfg.downloadURLs) {
		http.Error(w, "Not Found", http.StatusNotFound)
		return
	}

	// Self-hosted file: let nginx stream it from the `internal` location and
	// name the download after the real file, which is ASCII here so the saved
	// name is spelled out explicitly.
	target := s.cfg.downloadURLs[index]
	w.Header().Set("Cache-Control", "no-store")
	if strings.HasPrefix(target, "/") {
		w.Header().Set("Content-Disposition", contentDisposition(path.Base(target)))
		w.Header().Set("X-Accel-Redirect", target)
		w.WriteHeader(http.StatusOK)
		return
	}

	// 302 redirect: the real URL only ever appears as a Location header.
	http.Redirect(w, r, target, http.StatusFound)
}

// downloadNames maps a self-hosted file name to the name the browser saves it
// as (RFC 5987 attachment name), so internal paths can stay ASCII while the
// download keeps its Chinese title.
var downloadNames = map[string]string{
	"journey-full-clean.pdf": "中学数学之旅_合订本_无水印版.pdf",
	"journey-vol1-clean.pdf": "中学数学之旅_第一卷_无水印版.pdf",
	"journey-vol2-clean.pdf": "中学数学之旅_第二卷_无水印版.pdf",
	"journey-vol3-clean.pdf": "中学数学之旅_第三卷_无水印版.pdf",
	"journey-vol4-clean.pdf": "中学数学之旅_第四卷_无水印版.pdf",
	"journey-vol5-clean.pdf": "中学数学之旅_第五卷_无水印版.pdf",
	"journey-clean-all.zip":  "中学数学之旅_无水印版.zip",
}

func contentDisposition(base string) string {
	name, ok := downloadNames[base]
	if !ok {
		name = base
	}
	return "attachment; filename=\"" + base + "\"; filename*=UTF-8''" + url.PathEscape(name)
}

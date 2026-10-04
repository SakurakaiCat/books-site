package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// testEnv returns an env getter backed by the given map.
func testEnv(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

func newTestServer(t *testing.T) *server {
	t.Helper()
	cfg, err := loadConfig(testEnv(map[string]string{
		"BOOK_KEYS":            "good-key,second-key",
		"PREMIUM_DOWNLOAD_URL": "https://cloud.rikka.moe/s/premium, https://sakura10.lanzn.com/xyz",
		"ALLOWED_ORIGINS":      "https://books.rikka.moe",
		"DEV_INSECURE":         "1",
	}))
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	return &server{cfg: cfg}
}

func verifyRequest(t *testing.T, s *server, body, origin string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/books/verify", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	s.handleVerify(rec, req)
	return rec
}

func TestVerifySuccess(t *testing.T) {
	s := newTestServer(t)
	rec := verifyRequest(t, s, `{"key":"good-key"}`, "https://books.rikka.moe")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp struct {
		Success bool     `json:"success"`
		Labels  []string `json:"labels"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.Success {
		t.Fatal("success = false, want true")
	}
	wantLabels := []string{"网盘下载", "蓝奏云下载（国内推荐）"}
	if strings.Join(resp.Labels, ",") != strings.Join(wantLabels, ",") {
		t.Fatalf("labels = %v, want %v", resp.Labels, wantLabels)
	}
	// URLs must never leak into the response body.
	if strings.Contains(rec.Body.String(), "http") {
		t.Fatalf("response body leaks a URL: %s", rec.Body.String())
	}

	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != cookieName {
		t.Fatalf("cookies = %v, want one %q cookie", cookies, cookieName)
	}
	c := cookies[0]
	if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/api/books" || c.MaxAge != cookieMaxAgeSec {
		t.Fatalf("unexpected cookie attributes: %+v", c)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://books.rikka.moe" {
		t.Fatalf("ACAO = %q", got)
	}
}

func TestVerifyRejectsBadKey(t *testing.T) {
	s := newTestServer(t)
	for _, body := range []string{`{"key":"wrong"}`, `{"key":""}`, `not-json`} {
		rec := verifyRequest(t, s, body, "")
		if rec.Code == http.StatusOK {
			t.Fatalf("body %q unexpectedly verified", body)
		}
		if len(rec.Result().Cookies()) != 0 {
			t.Fatalf("body %q set a cookie", body)
		}
	}
}

func TestCORSRejectsUnknownOrigin(t *testing.T) {
	s := newTestServer(t)
	rec := verifyRequest(t, s, `{"key":"good-key"}`, "https://evil.example")
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("ACAO = %q, want empty for disallowed origin", got)
	}
}

func TestDownloadFlow(t *testing.T) {
	s := newTestServer(t)

	// Verify to obtain a cookie, then hit the download endpoint with it.
	rec := verifyRequest(t, s, `{"key":"second-key"}`, "")
	cookie := rec.Result().Cookies()[0]

	req := httptest.NewRequest(http.MethodGet, "/api/books/download/1", nil)
	req.AddCookie(cookie)
	drec := httptest.NewRecorder()
	req.SetPathValue("index", "1")
	s.handleDownload(drec, req)

	if drec.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", drec.Code)
	}
	if loc := drec.Header().Get("Location"); loc != "https://sakura10.lanzn.com/xyz" {
		t.Fatalf("Location = %q", loc)
	}
}

func TestDownloadRequiresValidCookie(t *testing.T) {
	s := newTestServer(t)

	// No cookie.
	req := httptest.NewRequest(http.MethodGet, "/api/books/download/0", nil)
	req.SetPathValue("index", "0")
	rec := httptest.NewRecorder()
	s.handleDownload(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no-cookie status = %d, want 401", rec.Code)
	}

	// Forged cookie.
	req = httptest.NewRequest(http.MethodGet, "/api/books/download/0", nil)
	req.SetPathValue("index", "0")
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "123:deadbeef"})
	rec = httptest.NewRecorder()
	s.handleDownload(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("forged-cookie status = %d, want 401", rec.Code)
	}
}

func TestDownloadIndexBounds(t *testing.T) {
	s := newTestServer(t)
	rec := verifyRequest(t, s, `{"key":"good-key"}`, "")
	cookie := rec.Result().Cookies()[0]

	for _, tc := range []struct {
		index string
		want  int
	}{
		{"0", http.StatusFound},
		{"1", http.StatusFound},
		{"2", http.StatusNotFound},
		{"-1", http.StatusBadRequest},
		{"abc", http.StatusBadRequest},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/books/download/"+tc.index, nil)
		req.SetPathValue("index", tc.index)
		req.AddCookie(cookie)
		drec := httptest.NewRecorder()
		s.handleDownload(drec, req)
		if drec.Code != tc.want {
			t.Fatalf("index %q: status = %d, want %d", tc.index, drec.Code, tc.want)
		}
	}
}

func TestTokenExpiry(t *testing.T) {
	s := newTestServer(t)
	old := s.buildToken(time.Now().Unix() - cookieMaxAgeSec - 10)
	if s.verifyToken(old, cookieMaxAgeSec) {
		t.Fatal("expired token verified")
	}
	// A token dated in the future must not verify either.
	future := s.buildToken(time.Now().Unix() + 3600)
	if s.verifyToken(future, cookieMaxAgeSec) {
		t.Fatal("future token verified")
	}
	fresh := s.buildToken(time.Now().Unix())
	if !s.verifyToken(fresh, cookieMaxAgeSec) {
		t.Fatal("fresh token rejected")
	}
}

func TestLoadConfigRequiresEnv(t *testing.T) {
	if _, err := loadConfig(testEnv(map[string]string{})); err == nil {
		t.Fatal("missing BOOK_KEYS: expected error")
	}
	if _, err := loadConfig(testEnv(map[string]string{"BOOK_KEYS": "k"})); err == nil {
		t.Fatal("missing PREMIUM_DOWNLOAD_URL: expected error")
	}
	// SIGNING_SECRET falls back to BOOK_KEYS.
	cfg, err := loadConfig(testEnv(map[string]string{
		"BOOK_KEYS":            "k1",
		"PREMIUM_DOWNLOAD_URL": "https://example.com/x",
	}))
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.signingSecret != "k1" {
		t.Fatalf("signingSecret = %q, want fallback to BOOK_KEYS", cfg.signingSecret)
	}
}

func TestHealthz(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	s.handleHealthz(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("healthz = %d %s", rec.Code, rec.Body.String())
	}
}

func TestPremiumLabelsOverride(t *testing.T) {
	cfg, err := loadConfig(testEnv(map[string]string{
		"BOOK_KEYS":               "k",
		"PREMIUM_DOWNLOAD_URL":    "/protected/journey/journey-full-clean.pdf,https://sakura10.lanzn.com/xyz",
		"PREMIUM_DOWNLOAD_LABELS": "合订本 PDF（无水印）",
	}))
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	// The supplied label wins; the missing one falls back to a derived label.
	want := []string{"合订本 PDF（无水印）", "蓝奏云下载（国内推荐）"}
	if strings.Join(cfg.labels, ",") != strings.Join(want, ",") {
		t.Fatalf("labels = %v, want %v", cfg.labels, want)
	}
}

func TestDownloadServesSelfHostedFile(t *testing.T) {
	s := &server{cfg: mustConfig(t, map[string]string{
		"BOOK_KEYS":            "k",
		"PREMIUM_DOWNLOAD_URL": "/protected/journey/journey-vol1-clean.pdf",
		"DEV_INSECURE":         "1",
	})}

	rec := verifyRequest(t, s, `{"key":"k"}`, "")
	cookie := rec.Result().Cookies()[0]

	req := httptest.NewRequest(http.MethodGet, "/api/books/download/0", nil)
	req.AddCookie(cookie)
	req.SetPathValue("index", "0")
	drec := httptest.NewRecorder()
	s.handleDownload(drec, req)

	// nginx takes over via X-Accel-Redirect: no redirect, no body.
	if drec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", drec.Code)
	}
	if loc := drec.Header().Get("Location"); loc != "" {
		t.Fatalf("Location = %q, want empty for a self-hosted file", loc)
	}
	if got := drec.Header().Get("X-Accel-Redirect"); got != "/protected/journey/journey-vol1-clean.pdf" {
		t.Fatalf("X-Accel-Redirect = %q", got)
	}
	cd := drec.Header().Get("Content-Disposition")
	if !strings.Contains(cd, `filename="journey-vol1-clean.pdf"`) {
		t.Fatalf("Content-Disposition = %q, want an ASCII fallback name", cd)
	}
	if !strings.Contains(cd, "filename*=UTF-8''"+url.PathEscape("中学数学之旅_第一卷_无水印版.pdf")) {
		t.Fatalf("Content-Disposition = %q, want the Chinese download name", cd)
	}
}

func mustConfig(t *testing.T, vars map[string]string) *config {
	t.Helper()
	cfg, err := loadConfig(testEnv(vars))
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	return cfg
}

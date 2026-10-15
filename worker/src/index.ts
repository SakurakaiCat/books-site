/**
 * books-api on Cloudflare Workers — TypeScript port of backend/main.go.
 *
 * Serves https://suisei.de (custom domain attached in wrangler.jsonc):
 *   POST /api/books/verify           {"key": "..."} -> {"success": true, "labels": [...]} + Set-Cookie
 *   GET  /api/books/download/{index} signed cookie -> R2 object stream, or 302 to the real URL
 *   GET  /downloads/{...}            public watermarked files (R2, range-supported)
 *   GET  /healthz                    -> {"ok": true}
 *
 * Everything else falls through to the static assets binding (frontend/).
 *
 * Faithful port notes:
 *  - Same HMAC-SHA256 token format "<unix>:<hex mac>" and 30-minute cookie
 *    (HttpOnly, Secure, SameSite=Strict, Path=/api/books).
 *  - PREMIUM_DOWNLOAD_URL entries starting with "/" are self-hosted: the path
 *    (minus the leading slash) is the R2 object key in the FILES bucket.
 *    Anything else is a remote URL answered with a 302.
 *  - Invalid keys sleep 500 ms so response timing does not reveal validity.
 *  - downloadNames keeps the ASCII R2 keys out of the user's face: the saved
 *    file keeps its Chinese title (RFC 5987).
 */

export interface Env {
  /** secret — comma-separated valid premium (爱发电) keys */
  BOOK_KEYS: string;
  /** secret — HMAC secret for the session cookie (falls back to BOOK_KEYS) */
  SIGNING_SECRET: string;
  /** comma-separated download targets (R2 keys with leading "/" or remote URLs) */
  PREMIUM_DOWNLOAD_URL: string;
  /** optional comma-separated button labels matching PREMIUM_DOWNLOAD_URL */
  PREMIUM_DOWNLOAD_LABELS: string;
  /** comma-separated credentialed CORS origins */
  ALLOWED_ORIGINS: string;
  /** R2 bucket with public/ (watermarked) and premium/ (clean) book files */
  FILES: R2Bucket;
  /** Workers static assets binding (frontend/) */
  ASSETS: Fetcher;
}

const COOKIE_NAME = "book_auth";
const COOKIE_MAX_AGE_SEC = 1800; // 30 minutes, mirrors backend/main.go
const CLOCK_SKEW_SEC = 30;

// downloadNames maps a self-hosted file name to the name the browser saves it
// as (RFC 5987 attachment name), so internal paths can stay ASCII while the
// download keeps its Chinese title.
const DOWNLOAD_NAMES: Record<string, string> = {
  "journey-full-clean.pdf": "中学数学之旅_合订本_无水印版.pdf",
  "journey-vol1-clean.pdf": "中学数学之旅_第一卷_无水印版.pdf",
  "journey-vol2-clean.pdf": "中学数学之旅_第二卷_无水印版.pdf",
  "journey-vol3-clean.pdf": "中学数学之旅_第三卷_无水印版.pdf",
  "journey-vol4-clean.pdf": "中学数学之旅_第四卷_无水印版.pdf",
  "journey-vol5-clean.pdf": "中学数学之旅_第五卷_无水印版.pdf",
  "journey-clean-all.zip": "中学数学之旅_无水印版.zip",
};

/** Parsed per-request view of the environment (cheap: a few string splits). */
interface Config {
  allowedOrigins: ReadonlySet<string>;
  keys: ReadonlySet<string>;
  downloadURLs: readonly string[];
  labels: readonly string[];
  signingSecret: string;
}

const encoder = new TextEncoder();

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// labelForURL derives the display label shown after a successful verify.
// Only labels cross the API boundary — never the URLs themselves.
function labelForURL(u: string): string {
  if (u.startsWith("/")) return "站内下载";
  if (u.includes("lanzn.com") || u.includes("lanzou")) return "蓝奏云下载（国内推荐）";
  if (u.includes("cloud.rikka.moe")) return "网盘下载";
  return "下载";
}

function loadConfig(env: Env): Config {
  const keys = new Set(splitCsv(env.BOOK_KEYS));
  if (keys.size === 0) {
    throw new Error("BOOK_KEYS is not set (comma-separated premium keys)");
  }

  const downloadURLs = splitCsv(env.PREMIUM_DOWNLOAD_URL);
  if (downloadURLs.length === 0) {
    throw new Error("PREMIUM_DOWNLOAD_URL is not set (comma-separated download URLs)");
  }

  // PREMIUM_DOWNLOAD_LABELS overrides the derived labels; missing entries
  // fall back to a label derived from the URL.
  const rawLabels = splitCsv(env.PREMIUM_DOWNLOAD_LABELS ?? "");
  const labels = downloadURLs.map((u, i) => rawLabels[i]?.trim() || labelForURL(u));

  const secret = (env.SIGNING_SECRET ?? "").trim() || (env.BOOK_KEYS ?? "").trim();
  if (!secret) throw new Error("SIGNING_SECRET is not set");

  const allowedOrigins = new Set(
    splitCsv(env.ALLOWED_ORIGINS || "https://suisei.de,http://localhost:4321,http://127.0.0.1:4321"),
  );

  return { allowedOrigins, keys, downloadURLs, labels, signingSecret: secret };
}

/** buildToken signs a timestamp with HMAC-SHA256: "<unix>:<hex mac>". */
async function buildToken(secret: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(String(ts)));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${ts}:${hex}`;
}

/** Constant-time byte comparison for MAC equality. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** verifyToken checks signature freshness and validity in constant time. */
async function verifyToken(secret: string, token: string | undefined, maxAgeSec: number): Promise<boolean> {
  if (!token) return false;
  const colon = token.indexOf(":");
  if (colon <= 0 || colon === token.length - 1) return false;
  const tsRaw = token.slice(0, colon);
  if (!/^\d+$/.test(tsRaw)) return false;
  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (ts > now + CLOCK_SKEW_SEC || now - ts > maxAgeSec) return false;
  return timingSafeEqual(await buildToken(secret, ts), token);
}

function contentDisposition(base: string): string {
  const name = DOWNLOAD_NAMES[base] ?? base;
  return `attachment; filename="${base}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function corsHeaders(cfg: Config, origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  // Credentialed CORS forbids "*", so the origin must be echoed explicitly.
  if (origin && cfg.allowedOrigins.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Credentials"] = "true";
  }
  return h;
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

/**
 * Streams a bucket object to the client, passing Range through (like nginx).
 *
 * `partial` comes from the *request* having a Range header — never from
 * `obj.range`, which this workerd version populates with a full-object range
 * ({offset: 0, length: size}) even for plain GETs.
 */
function objectResponse(
  obj: R2ObjectBody,
  init: { partial: boolean; cacheControl: string; downloadName?: string },
): Response {
  const headers = new Headers();
  const meta = obj.httpMetadata ?? {};
  headers.set("Content-Type", meta.contentType ?? "application/octet-stream");
  headers.set("Cache-Control", init.cacheControl);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("ETag", `"${obj.etag}"`);
  headers.set("Accept-Ranges", "bytes");
  if (init.downloadName) headers.set("Content-Disposition", contentDisposition(init.downloadName));
  if (init.partial) {
    const range = obj.range;
    if (range !== undefined && "offset" in range && range.offset !== undefined) {
      const length = range.length ?? obj.size - range.offset;
      headers.set("Content-Range", `bytes ${range.offset}-${range.offset + length - 1}/${obj.size}`);
      headers.set("Content-Length", String(length));
    }
  } else {
    headers.set("Content-Length", String(obj.size));
  }
  // suffix-form ranges stream chunked without Content-Range; curl/wget accept that.
  return new Response(obj.body, { status: init.partial ? 206 : 200, headers });
}

async function handleVerify(cfg: Config, req: Request): Promise<Response> {
  const cors = corsHeaders(cfg, req.headers.get("Origin"));

  let key: unknown;
  try {
    const body = await req.text();
    if (body.length > 4096) throw new Error("too large");
    key = JSON.parse(body).key;
  } catch {
    return json({ success: false, message: "请求格式错误" }, 400, cors);
  }
  if (typeof key !== "string" || key.trim() === "") {
    return json({ success: false, message: "请填写密钥" }, 400, cors);
  }

  if (!cfg.keys.has(key.trim())) {
    // Uniform delay so response timing does not reveal validity.
    const { promise: delayDone, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 500);
    await delayDone;
    return json({ success: false, message: "密钥无效，请检查后重试" }, 403, cors);
  }

  const token = await buildToken(cfg.signingSecret, Math.floor(Date.now() / 1000));
  return json({ success: true, labels: cfg.labels }, 200, {
    ...cors,
    "Set-Cookie":
      `${COOKIE_NAME}=${token}; Path=/api/books; Max-Age=${COOKIE_MAX_AGE_SEC}; ` +
      "HttpOnly; Secure; SameSite=Strict",
  });
}

async function handleDownload(cfg: Config, env: Env, req: Request, indexRaw: string): Promise<Response> {
  const cookie = req.headers.get("Cookie") ?? "";
  const token = cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  if (!(await verifyToken(cfg.signingSecret, token, COOKIE_MAX_AGE_SEC))) {
    return new Response("Unauthorized\n", { status: 401, headers: { "Content-Type": "text/plain" } });
  }

  const index = Number(indexRaw);
  if (!Number.isInteger(index) || index < 0) {
    return new Response("Bad Request\n", { status: 400, headers: { "Content-Type": "text/plain" } });
  }
  if (index >= cfg.downloadURLs.length) {
    return new Response("Not Found\n", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const target = cfg.downloadURLs[index];
  if (target === undefined) {
    return new Response("Not Found\n", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  if (target.startsWith("/")) {
    // Self-hosted file: stream it from R2. The object key is the path minus
    // the leading slash ("premium/journey/..."). Only the ASCII base name is
    // used for the download-name lookup, mirroring main.go's path.Base.
    const key = target.slice(1);
    const rangeHeader = req.headers.get("range");
    const obj = rangeHeader === null ? await env.FILES.get(key) : await env.FILES.get(key, { range: req.headers });
    if (obj === null) {
      return new Response("Not Found\n", { status: 404, headers: { "Content-Type": "text/plain" } });
    }
    const base = key.split("/").pop() ?? key;
    return objectResponse(obj, { partial: rangeHeader !== null, cacheControl: "no-store", downloadName: base });
  }

  // 302 redirect: the real URL only ever appears as a Location header.
  return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
}

/** Public watermarked files (/downloads/ -> bucket key "public/..."). */
async function handlePublicDownload(env: Env, req: Request, rest: string): Promise<Response> {
  let key: string;
  try {
    key = `public/${decodeURIComponent(rest)}`;
  } catch {
    return new Response("Bad Request\n", { status: 400, headers: { "Content-Type": "text/plain" } });
  }
  const rangeHeader = req.headers.get("range");
    const obj = rangeHeader === null ? await env.FILES.get(key) : await env.FILES.get(key, { range: req.headers });
  if (obj === null) {
    return new Response("Not Found\n", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  return objectResponse(obj, { partial: rangeHeader !== null, cacheControl: "public, max-age=604800" });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // /healthz — before config load so a misconfigured secret still probes.
      if (req.method === "GET" && (path === "/healthz" || path === "/healthz/")) {
        return json({ ok: true }, 200);
      }

      const cfg = loadConfig(env);

      if (path === "/api/books/verify") {
        if (req.method === "POST") return handleVerify(cfg, req);
        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders(cfg, req.headers.get("Origin")) });
        }
        return env.ASSETS.fetch(req);
      }

      const downloadMatch = path.match(/^\/api\/books\/download\/([^/]+)$/);
      if (downloadMatch?.[1] !== undefined && req.method === "GET") {
        return handleDownload(cfg, env, req, downloadMatch[1]);
      }

      if (req.method === "GET" && path.startsWith("/downloads/")) {
        return handlePublicDownload(env, req, path.slice("/downloads/".length));
      }

      // Everything else (and any /api/* path we do not know): static assets.
      return env.ASSETS.fetch(req);
    } catch (err) {
      console.error("books-api worker:", err);
      return json({ success: false, message: "服务暂时不可用，请稍后再试" }, 500);
    }
  },
};

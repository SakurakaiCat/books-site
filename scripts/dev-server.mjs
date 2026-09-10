// Local static + API reverse proxy for books.rikka.moe
import { createServer } from 'node:http'
import { createReadStream, statSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = new URL(process.argv[2] ?? '../frontend', import.meta.url).pathname
const API = process.env.BOOKS_API ?? 'http://127.0.0.1:8787'
const PORT = process.env.PORT ?? 4321

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.xml': 'application/xml', '.json': 'application/json' }

createServer(async (req, res) => {
  if (req.url.startsWith('/api/') || req.url === '/healthz') {
    const upstream = await fetch(API + req.url, {
      method: req.method,
      headers: { ...req.headers, host: 'books.rikka.moe', origin: 'https://books.rikka.moe' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))) }),
      credentials: 'include',
      redirect: 'manual',
    })
    // rewrite Set-Cookie for local dev
    const cookies = upstream.headers.getSetCookie?.() ?? []
    for (const [k, v] of upstream.headers.entries()) {
      if (k !== 'set-cookie') res.setHeader(k, v)
    }
    for (let c of cookies) {
      c = c.replace(/;\s*Secure\b/i, '').replace(/;\s*Domain=[^;]+/i, '')
      res.setHeader('Set-Cookie', cookies.map(x => x.replace(/;\s*Secure\b/i, '').replace(/;\s*Domain=[^;]+/i, '')))
    }
    res.statusCode = upstream.status
    res.end(Buffer.from(await upstream.arrayBuffer()))
    return
  }
  let p = req.url.split('?')[0]
  let f = join(ROOT, p === '/' ? 'index.html' : p)
  if (!existsSync(f)) { if (!extname(p)) { if (existsSync(f + '.html')) f += '.html'; else f = join(ROOT, 'index.html') } }
  if (!existsSync(f)) { res.statusCode = 404; return res.end('404') }
  res.setHeader('Content-Type', MIME[extname(f)] ?? 'application/octet-stream')
  if (p.startsWith('/_astro/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  createReadStream(f).pipe(res)
}).listen(PORT, () => console.log(`books-site → http://127.0.0.1:${PORT} (api → ${API})`))

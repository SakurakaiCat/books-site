# books-site

[books.rikka.moe](https://books.rikka.moe) 的落地页与下载后端。仓库里保存的是**可直接部署的产物**，
没有构建步骤：`frontend/` 原样 rsync 到 VPS，`backend/` 用 `go build` 出一个静态二进制。

## 目录

| 路径 | 说明 |
| --- | --- |
| `frontend/` | 静态站点根目录 → VPS `/opt/books-site/frontend` |
| `frontend/index.html` | 手写的单文件页面（无框架、无水合脚本） |
| `frontend/_astro/index.BXJfX1B-.css` | 既有编译好的 Kumo/Tailwind 样式表（沿用，未改动） |
| `frontend/assets/site.css` | 下载卡片样式 + 下滑显现特效（`html.reveal [data-rv]`） |
| `frontend/assets/site.js` | 下滑显现、顶部进度条、爱发电密钥验证 |
| `frontend/images/`、`favicon.*`、`sitemap-*.xml` | 封面、内容预览图与站点元数据 |
| `backend/` | `books-api`：校验爱发电密钥、签发 HMAC cookie、内部投递精装版文件 |
| `scripts/dev-server.mjs` | 本地静态 + API 反向代理（`node scripts/dev-server.mjs frontend`） |

### 关于 `index.html`

早期版本是 Astro + React islands 的**构建产物**（本仓库从未包含 Astro 源码，只有构建结果）。
构建输出里的 `_astro/*.js` 是压缩过、且无法重新生成的水合脚本，任何改动都要同时改 SSR HTML 和
压缩 JS，既难维护也容易失配。因此 2026-10-04 起 `index.html` 改为纯静态手写页面：删除了所有
`_astro/*.js`（保留样式表），交互（密钥验证、下滑特效）由 `assets/site.js` 实现。
改页面 = 直接编辑 `index.html` 和 `assets/site.{css,js}`。

## 下载模型

| 版本 | 面向 | 交付方式 |
| --- | --- | --- |
| 带水印版 | 所有人 | `/downloads/journey/...`，nginx 直接服务，支持 Range 断点续传 |
| 无水印版（精装） | 爱发电赞助者 | 页内输入密钥 → `POST /api/books/verify` → `GET /api/books/download/{index}` → nginx 内部投递 |

VPS 上的文件布局：

```
/srv/books-files/public/journey/    # 带水印版 PDF / zip（对外 /downloads/，文件名为中文）
/srv/books-files/premium/journey/   # 无水印版 PDF / zip（仅 nginx internal /protected/，经 books-api 转发）
```

精装版文件用 ASCII 名存放，下载时展示的中文名由 books-api 的 `Content-Disposition` 给出
（见 `backend/main.go` 的 `downloadNames`）。`/protected/` 是对外 404 的 `internal` location，
只有带签名 cookie 的请求才会被 `X-Accel-Redirect` 引到那里。

## 后端

API：

```
POST /api/books/verify           {"key": "..."} -> {"success": true, "labels": [...]} + Set-Cookie
GET  /api/books/download/{index} 带 cookie -> 文件本体（站内自托管）或 302（外部 URL）
GET  /healthz                    -> {"ok": true}
```

环境变量见 `backend/.env.example`。`PREMIUM_DOWNLOAD_URL` 中以 `/` 开头的条目视为**站内自托管**
（走 `X-Accel-Redirect`，字节不经过本进程），否则按原来的 302 跳转；`PREMIUM_DOWNLOAD_LABELS`
是可选的下发按钮文案，缺项回退到按 URL 推导的文案。

```sh
cd backend && go vet ./... && go test ./...
CGO_ENABLED=0 go build -trimpath -o books-api .
```

## 部署（VPS: `ssh vps`）

```sh
# 前端
rsync -a --delete frontend/ vps:/opt/books-site/frontend/
ssh vps 'chown -R root:root /opt/books-site/frontend'

# 后端（改过 backend/ 时）
rsync -a backend/ vps:/root/books-api-build/
ssh vps 'cd /root/books-api-build && CGO_ENABLED=0 go build -trimpath -o /tmp/books-api && \
         install -m755 /tmp/books-api /opt/books-site/books-api && systemctl restart books-api && \
         systemctl is-active books-api'
```

运行位置：

- systemd 单元 `books-api.service`（`DynamicUser=yes`，`ProtectSystem=strict`），
  二进制 `/opt/books-site/books-api`，环境文件 `/opt/books-site/books-api.env`（600）。
- nginx 站点 `/etc/nginx/sites-enabled/books.rikka.moe`：`/api/` 与 `/healthz` → `127.0.0.1:8787`；
  `/downloads/` → `alias /srv/books-files/public/`；`/protected/` → `internal` + `alias /srv/books-files/premium/`。
  改配置后 `cp -a` 备份到 `/root/nginx-backups/`（**不要**留在 `sites-enabled/`，否则 server_name 冲突），
  然后 `nginx -t && systemctl reload nginx`。

## 更新书稿

重新编译出 PDF 后：

```sh
# 带水印版 → public，无水印版 → premium（精装版文件名保持 ASCII）
rsync -a --delete 无水印版目录/ vps:/srv/books-files/premium/journey/
rsync -a --delete 水印版目录/   vps:/srv/books-files/public/journey/
ssh vps 'chown -R root:root /srv/books-files && chmod -R a+rX /srv/books-files'
```

新增/删除文件时同步更新 `frontend/index.html` 里的免费下载列表、
`books-api.env` 的 `PREMIUM_DOWNLOAD_URL` / `PREMIUM_DOWNLOAD_LABELS`，
以及 `backend/main.go` 的 `downloadNames`。

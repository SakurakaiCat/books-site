# books-site

[suisei.de](https://suisei.de) 的落地页与下载后端，整体运行在 **Cloudflare Workers** 上：
`frontend/` 作为 Workers 静态资源直接部署，`worker/`（TypeScript）提供密钥验证与下载 API，
书稿文件存放在 R2 桶 `books-files`。旧的 `books.rikka.moe` 域名在 VPS nginx 上只做
301 跳转到 suisei.de；`backend/`（Go）是已退役的参考实现，不再部署。

## 目录

| 路径 | 说明 |
| --- | --- |
| `frontend/` | 静态站点根目录 → Workers 静态资源（`_headers` 定义缓存策略） |
| `frontend/index.html` | 手写的单文件页面（无框架、无水合脚本） |
| `frontend/assets/site.css` | 全站唯一样式表（极简风格：一栏阅读流 + 大按钮） |
| `frontend/assets/site.js` | 爱发电密钥验证（页面唯一交互） |
| `frontend/images/`、`favicon.*`、`sitemap-*.xml` | 封面、内容预览图与站点元数据 |
| `worker/` | books-api 的 Workers 移植：校验爱发电密钥、签发 HMAC cookie、从 R2 投递文件 |
| `backend/` | 已退役的 Go 实现（API 契约的原始参考，逻辑见 `backend/main.go` 头注释） |
| `scripts/dev-server.mjs` | 本地静态 + API 反向代理（`node scripts/dev-server.mjs frontend`） |
| `scripts/make-previews.py` | 从最新发布构建的 PDF 重新生成页面上的书页截图 |

### 关于 `index.html`

早期版本是 Astro + React islands 的**构建产物**（本仓库从未包含 Astro 源码，只有构建结果）。
2026-10-04 起改为纯静态手写页面；同日晚些时候的极简改版进一步**删掉了 `_astro/` 编译样式表**，
全站样式收敛到 `assets/site.css`（系统字体栈、单列阅读流、超大下载按钮），交互只剩密钥验证。
页面信息架构面向「只有基本识字能力」的读者，顺序为：

1. 免费下载（蓝色大按钮，单卷 PDF / 合订本 / ZIP 打包）
2. 购买无水印版（拼好饭话术 → 爱发电 → 粘贴密钥 → 出现下载按钮）
3. 使用帮助（PDF 阅读器推荐：Adobe Acrobat Reader 为首推；ZIP 解压教程按
   苹果 / 安卓 / Windows（7-Zip、WinRAR）分平台；密码说明见下）
4. 更多书目（函数与导数、从零开始系列）

**关于免费版 PDF 的密码**：水印版 PDF 带所有者密码（AES-256，仅允许阅读，
禁止打印 / 复制 / 修改），**打开阅读不需要输入任何密码**。个别不规范的阅读器会把
所有者密码当成打开密码向用户索要——页面「使用帮助」的提示是：换一个阅读器
（首推 Adobe Acrobat Reader）即可正常阅读。构建时所有者密码由
`mjourney` 仓库 `tools/build_release.py` 的 `MJOURNEY_OWNER_PASSWORD` 注入。

## 下载模型

| 版本 | 面向 | 交付方式 |
| --- | --- |
| 带水印版 | 所有人 | `/downloads/journey/...`，Worker 从 R2 流式响应，支持 Range 断点续传 |
| 无水印版（精装） | 爱发电赞助者 | 页内输入密钥 → `POST /api/books/verify` → `GET /api/books/download/{index}` → Worker 校验签名 cookie 后从 R2 投递 |

R2 桶 `books-files` 里的对象布局（`/downloads/` 与精装版的门禁都由 Worker 完成，桶本身不公开）：

```
public/journey/    # 带水印版 PDF / zip（对外 /downloads/，文件名为中文）
premium/journey/   # 无水印版 PDF / zip（仅 Worker 内部可达，经签名 cookie 校验）
```

精装版文件用 ASCII 名存放，下载时展示的中文名由 Worker 的 `Content-Disposition` 给出
（见 `worker/src/index.ts` 的 `DOWNLOAD_NAMES`，`backend/main.go` 的 `downloadNames`
是同一张表的退役参考）。R2 里没有 `internal` location 的概念——未走 Worker 签名校验的
请求根本无法触达桶内对象。

## 后端（worker/）

API 契约与退役的 Go 版完全一致：

```
POST /api/books/verify           {"key": "..."} -> {"success": true, "labels": [...]} + Set-Cookie
GET  /api/books/download/{index} 带 cookie -> 文件本体（R2 站内自托管）或 302（外部 URL）
GET  /healthz                    -> {"ok": true}
```

配置在 `worker/wrangler.jsonc`：`PREMIUM_DOWNLOAD_URL` / `PREMIUM_DOWNLOAD_LABELS` /
`ALLOWED_ORIGINS` 是明文 vars；`BOOK_KEYS` / `SIGNING_SECRET` 用
`wrangler secret put` 注入（`.dev.vars` 提供本地开发值）。`PREMIUM_DOWNLOAD_URL` 中以
`/` 开头的条目视为**站内自托管**——路径去掉开头斜杠即 R2 对象键，字节经 Worker 流式
转发；否则按原来的 302 跳转。

类型检查 / 本地运行：

```sh
cd worker && npm ci && npm run typecheck
npx wrangler dev --port 8799 --local   # 本地 R2 需先用 wrangler r2 object put --local 播种
```

Go 参考实现保留在 `backend/`（`go test` 仍可用于核对契约语义），不再部署。

## 内容预览截图

`frontend/images/books/previews/` 里的书页截图与 `frontend/images/books/covers/journey-cover.webp`
（首页大封面）都由 `scripts/make-previews.py` 生成，源是 mjourney 发布目录里的 **无水印版** PDF
（截图用于展示成品观感，免费版页脚带水印这一点在页面文案里另有说明）：

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `covers/journey-cover.webp` | 合订本 第 1 页**嵌入的封面原图** | 首页大图，1489×2105 原图缩到 1000px |
| `previews/journey-cover.webp` | 合订本 第 1 页 | 缩略图（800px 渲染） |
| `previews/journey-formula.webp` | 第一卷 §1.2 乘法公式与因式分解 | 页眉定位 |
| `previews/journey-composite.webp` | 第一卷 §3.8 函数的复合 | 页眉定位 |
| `previews/journey-lp.webp` | 第三卷 §3.2 线性规划初步 | 按图题「无界可行域」定位 |
| `previews/func-math-*.webp` | 《函数与导数》（另一个书稿仓库） | 手工留存的旧图，未随本次重构更新 |

> 曾经用过的 `covers/journey-cover.png` 是一张几乎全白、封面图缺失的坏文件（页面上表现为「封面是破的」），
> 已换成从 PDF 里抽出的封面原图；改用 WebP 后只有 ~25KB。

发布版 PDF 的文本层被 `anti_extract.py` 毒化（ToUnicode 同形字），直接 pdftotext 得到的是
乱码；脚本用 mjourney 的密表 `tools/extraction_cipher.json` 还原文本，再按页眉/图题定位页码，
所以重新编译、页码变动后仍然能找到正确页面：

```sh
python3 scripts/make-previews.py \
    --clean-dir /root/Desktop/mjourney_release \
    --cipher /root/mjourney/tools/extraction_cipher.json \
    --out frontend/images/books/previews \
    --cover-out frontend/images/books/covers
```

改完记得 `wrangler deploy`，并 bump `index.html` 里的 `?v=` 版本号。

## 缓存策略

由 `frontend/_headers` 声明（Workers 静态资产会读取该文件，规则与原 nginx vhost 一致）：

- HTML（`/` 与 `*.html`）：`no-cache, must-revalidate`，浏览器每次回源校验——改版即时可见。
- `/assets/site.{css,js}`：7 天长缓存，但 index.html 引用时带 `?v=YYYYMMDD` 版本号；**改这两个文件时必须同时 bump 版本号**。
- `/images/*`：7 天长缓存，引用处同样带 `?v=` 版本号；**换图时必须 bump**。
- `/downloads/*`：Worker 响应 7 天公开缓存（文件名不变即内容不变），另带 `Accept-Ranges` 与 `ETag`。

## 部署（Cloudflare Workers）

```sh
cd worker && npm ci

# 前端资产 + Worker 一起部署；suisei.de 自定义域在 wrangler.jsonc 里声明，deploy 时自动绑定
CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy

# secrets（首次部署或轮换时；BOOK_KEYS 与原 /opt/books-site/books-api.env 一致）
printf '%s' "$BOOK_KEYS"      | CLOUDFLARE_API_TOKEN=<token> npx wrangler secret put BOOK_KEYS
printf '%s' "$SIGNING_SECRET" | CLOUDFLARE_API_TOKEN=<token> npx wrangler secret put SIGNING_SECRET
```

运行位置：

- Worker `books-suisei`（账户 `53f4ca28510d4eeacad18cb0cc7b2c7b`），自定义域 `suisei.de`。
- R2 桶 `books-files`（private），绑定 `FILES`；静态资产绑定 `ASSETS`，`run_worker_first`
  让 `/api/*`、`/downloads/*`、`/healthz` 先进 Worker，其余路径直接走资产。
- 密钥与签名密钥只存在于 Worker secrets 里；R2 只有带有效 HMAC cookie 的请求才能读到
  `premium/` 前缀的对象。

### 旧 VPS 路径（已退役，2026-10-15）

- `books.rikka.moe` 的 nginx vhost（`/etc/nginx/sites-enabled/books.rikka.moe.conf`）现在
  **只做 301** 到 `https://suisei.de$request_uri`；ACME webroot 保留，certbot 续期不受影响。
  修改前的完整配置备份在 `/root/nginx-backups/`。
- `books-api.service`（Go 后端）已 `systemctl disable --now`；如需临时回滚：
  恢复备份的 vhost + `systemctl enable --now books-api` + `systemctl reload nginx`。

## 更新书稿

重新编译出 PDF 后，上传到 R2（rclone，S3 兼容端点
`https://53f4ca28510d4eeacad18cb0cc7b2c7b.r2.cloudflarestorage.com`，密钥对见 Cloudflare
控制台的 R2 API token）：

```sh
# 带水印版 → public/，无水印版 → premium/（精装版文件名保持 ASCII）
rclone copy --config <r2.conf> 无水印版目录/ r2:books-files/premium/journey/
rclone copy --config <r2.conf> 水印版目录/   r2:books-files/public/journey/
```

新增/删除文件时同步更新 `frontend/index.html` 里的免费下载列表、
`worker/wrangler.jsonc` 的 `PREMIUM_DOWNLOAD_URL` / `PREMIUM_DOWNLOAD_LABELS`，
以及 `worker/src/index.ts` 的 `DOWNLOAD_NAMES`（`backend/main.go` 的同名表仅作参考）。

# books-site

[books.rikka.moe](https://books.rikka.moe) 的落地页与下载后端。仓库里保存的是**可直接部署的产物**，
没有构建步骤：`frontend/` 原样 rsync 到 VPS，`backend/` 用 `go build` 出一个静态二进制。

## 目录

| 路径 | 说明 |
| --- | --- |
| `frontend/` | 静态站点根目录 → VPS `/opt/books-site/frontend` |
| `frontend/index.html` | 手写的单文件页面（无框架、无水合脚本） |
| `frontend/assets/site.css` | 全站唯一样式表（极简风格：一栏阅读流 + 大按钮） |
| `frontend/assets/site.js` | 爱发电密钥验证（页面唯一交互） |
| `frontend/images/`、`favicon.*`、`sitemap-*.xml` | 封面、内容预览图与站点元数据 |
| `backend/` | `books-api`：校验爱发电密钥、签发 HMAC cookie、内部投递精装版文件 |
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

改完记得 rsync 到 VPS，并 bump `index.html` 里的 `?v=` 版本号。

## 缓存策略

- HTML（`/` 与 `*.html`）：nginx 发 `Cache-Control: no-cache, must-revalidate`，浏览器每次回源校验，未变走 304——改版即时可见。
- `/assets/site.{css,js}`：7 天长缓存，但 index.html 引用时带 `?v=YYYYMMDD` 版本号；**改这两个文件时必须同时 bump 版本号**。
- `/images/*`：7 天长缓存，引用处同样带 `?v=` 版本号；**换图时必须 bump**（否则 Cloudflare 会按自己的默认策略缓存 4 小时，用户端一直看到旧图）。
- `/downloads/*`：7 天公开缓存（文件名不变即内容不变）。

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

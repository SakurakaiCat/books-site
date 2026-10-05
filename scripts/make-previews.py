#!/usr/bin/env python3
"""从最新发布构建的 PDF 重新生成落地页用的书页截图。

发布版 PDF（`tools/build_release.py` 出的无水印版）文本层被 `anti_extract.py`
毒化，直接 pdftotext 取到的是同形字乱码。本脚本用 mjourney 仓库的密表
（`tools/extraction_cipher.json`）把文本还原成中文，再按「页眉里的节标题」
定位页码——这样即便重新编译导致页码变动，也仍然能选到正确的页面，
不需要手工找页。

依赖：poppler-utils（pdftotext / pdftoppm）、Pillow。

用法：
    python3 scripts/make-previews.py \
        --clean-dir /root/Desktop/mjourney_release \
        --cipher /root/mjourney/tools/extraction_cipher.json \
        --out frontend/images/books/previews

生成的四个文件与 index.html 中「内容预览」区块一一对应：
journey-cover / journey-formula / journey-composite / journey-lp。
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

# (输出文件名, 无水印版 PDF 文件名, 定位文本, 定位方式)
#   cover = 第 1 页封面；head = 页眉里的节标题；body = 正文任意位置（如图题）
TARGETS = [
    ("journey-cover", "中学数学之旅_合订本_无水印版.pdf", None, "cover"),
    ("journey-formula", "中学数学之旅_第一卷_无水印版.pdf", "1.2 乘法公式与因式分解", "head"),
    ("journey-composite", "中学数学之旅_第一卷_无水印版.pdf", "3.8 函数的复合", "head"),
    ("journey-lp", "中学数学之旅_第三卷_无水印版.pdf", "无界可行域", "body"),
]

DPI = 110          # 单栏版心 524.41pt 宽 → 802px，再缩放到目标宽度
WEBP_QUALITY = 82
COVER_WIDTH = 1000     # 首页大封面（covers/journey-cover.webp）的输出宽度
COVER_QUALITY = 85


def load_decoder(cipher_path: Path):
    """密表是 {原文码点: 毒化码点}，反查得到还原函数。"""
    table = json.loads(cipher_path.read_text(encoding="utf-8"))["map"]
    inverse = {}
    for src, dst in table.items():
        try:
            inverse[dst.lower()] = chr(int(src, 16))
        except (ValueError, TypeError):
            continue

    def decode(text: str) -> str:
        return "".join(inverse.get(f"{ord(ch):04x}", ch) for ch in text)

    return decode


def page_texts(pdf: Path, decode):
    """整本抽取一次，按换页符切分，返回 [{页号: 正文}]（页号从 1 起）。"""
    raw = subprocess.run(
        ["pdftotext", "-layout", str(pdf), "-"],
        capture_output=True, text=True, check=True,
    ).stdout
    return {i: decode(chunk) for i, chunk in enumerate(raw.split("\f"), start=1)}


def find_page(pdf: Path, needle: str, mode: str, decode) -> int:
    """定位页面。

    head：只匹配每页正文的前两行（页眉），避免命中目录页里的同名条目。
    body：匹配整页文字，适合用图题等正文特征精确定位。
    """
    for page, text in sorted(page_texts(pdf, decode).items()):
        if mode == "body":
            if needle in text:
                return page
            continue
        head = [line.strip() for line in text.splitlines() if line.strip()][:2]
        if any(needle in line for line in head):
            return page
    raise SystemExit(f"在 {pdf.name} 中找不到『{needle}』（{mode}），请检查标题或密表")


def render_webp(pdf: Path, page: int, out: Path, width: int):
    with tempfile.TemporaryDirectory() as tmp:
        stem = Path(tmp) / "page"
        subprocess.run(
            ["pdftoppm", "-png", "-r", str(DPI), "-f", str(page), "-l", str(page),
             "-singlefile", str(pdf), str(stem)],
            check=True,
        )
        image = Image.open(f"{stem}.png")
    w, h = image.size
    resized = image.resize((width, round(h * width / w)), Image.LANCZOS)
    out.parent.mkdir(parents=True, exist_ok=True)
    resized.convert("RGB").save(out, "WEBP", quality=WEBP_QUALITY, method=6)


def extract_cover_art(pdf: Path):
    """取合订本第 1 页里嵌入的封面原图——比重新渲染更清晰。"""
    with tempfile.TemporaryDirectory() as tmp:
        stem = Path(tmp) / "cover"
        subprocess.run(
            ["pdfimages", "-png", "-f", "1", "-l", "1", str(pdf), str(stem)],
            check=True,
        )
        files = sorted(Path(tmp).glob("cover-*.png"))
        if not files:
            raise SystemExit(f"{pdf.name} 第 1 页没有嵌入图片，无法提取封面原图")
        sizes = {f: Image.open(f).size for f in files}
        best = max(files, key=lambda f: sizes[f][0] * sizes[f][1])
        return Image.open(best).convert("RGB").copy()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clean-dir", required=True, type=Path, help="含 *_无水印版.pdf 的发布目录")
    ap.add_argument("--cipher", required=True, type=Path, help="mjourney/tools/extraction_cipher.json")
    ap.add_argument("--out", required=True, type=Path, help="截图输出目录")
    ap.add_argument("--cover-out", type=Path, default=None,
                    help="封面输出目录（写入 journey-cover.webp，取自合订本第 1 页嵌入原图）")
    ap.add_argument("--width", type=int, default=800, help="输出宽度（默认 800）")
    args = ap.parse_args()

    decode = load_decoder(args.cipher)
    for name, pdf_name, needle, mode in TARGETS:
        pdf = args.clean_dir / pdf_name
        if not pdf.exists():
            print(f"跳过 {name}：找不到 {pdf}", file=sys.stderr)
            return 1
        page = 1 if mode == "cover" else find_page(pdf, needle, mode, decode)
        dest = args.out / f"{name}.webp"
        render_webp(pdf, page, dest, args.width)
        label = "封面" if mode == "cover" else needle
        print(f"{name}.webp ← {pdf_name} 第 {page} 页（{label}）")

    if args.cover_out:
        pdf = args.clean_dir / "中学数学之旅_合订本_无水印版.pdf"
        art = extract_cover_art(pdf)
        w, h = art.size
        dest = args.cover_out / "journey-cover.webp"
        dest.parent.mkdir(parents=True, exist_ok=True)
        art.resize((COVER_WIDTH, round(h * COVER_WIDTH / w)), Image.LANCZOS).save(
            dest, "WEBP", quality=COVER_QUALITY, method=6)
        print(f"covers/journey-cover.webp ← {pdf.name} 第 1 页嵌入原图 {w}x{h}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

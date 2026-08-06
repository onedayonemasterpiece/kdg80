#!/usr/bin/env python3
"""Create PII-sanitized festival Passport fixtures from the VK discovery output.

Real handwritten names are permanently covered and replaced with TEST-prefixed
synthetic names. Only sanitized derivatives are intended for E2E artifacts.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

RAW_ROOT = Path(os.environ.get("VK_PASSPORT_OUTPUT", ".codex-artifacts/vk-passport-candidates"))
OUTPUT_ROOT = Path(os.environ.get("VK_PASSPORT_SANITIZED_OUTPUT", ".codex-artifacts/vk-passport-sanitized"))
MIN_FIXTURES = 10
MAX_FIXTURES = 14


def font(size: int) -> ImageFont.ImageFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    ):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def sanitize(source: Path, target: Path, index: int) -> tuple[int, int]:
    with Image.open(source) as raw:
        image = ImageOps.exif_transpose(raw).convert("RGB")
    width, height = image.size
    draw = ImageDraw.Draw(image)

    # The festival Passport is a fixed half-A4 form. The handwritten FIO field
    # occupies this narrow horizontal band in portrait photographs. Cover a
    # deliberately generous band so no original handwriting remains visible.
    left = int(width * 0.025)
    right = int(width * 0.975)
    top = int(height * 0.525)
    bottom = int(height * 0.615)
    fill = (226, 234, 232)
    draw.rectangle((left, top, right, bottom), fill=fill)

    synthetic_name = f"ТЕСТ ЯНТАРНЫЙ КОМБИНАТ {index:02d}"
    text_font = font(max(34, int(height * 0.0225)))
    text_x = left + int(width * 0.035)
    text_bbox = draw.textbbox((0, 0), synthetic_name, font=text_font)
    text_y = top + max(4, (bottom - top - (text_bbox[3] - text_bbox[1])) // 2)
    draw.text((text_x, text_y), synthetic_name, font=text_font, fill=(30, 38, 38))

    target.parent.mkdir(parents=True, exist_ok=True)
    image.save(target, format="JPEG", quality=93, subsampling=0, optimize=True)
    return width, height


def contact_sheet(files: list[Path], output: Path) -> None:
    thumb_w, thumb_h = 420, 320
    columns = 3
    rows = (len(files) + columns - 1) // columns
    canvas = Image.new("RGB", (columns * thumb_w, max(1, rows) * thumb_h), "white")
    draw = ImageDraw.Draw(canvas)
    label_font = font(20)
    for index, source in enumerate(files):
        with Image.open(source) as raw:
            image = ImageOps.exif_transpose(raw).convert("RGB")
            image.thumbnail((thumb_w - 20, thumb_h - 48))
        cell_x = (index % columns) * thumb_w
        cell_y = (index // columns) * thumb_h
        x = cell_x + (thumb_w - image.width) // 2
        y = cell_y + 34
        canvas.paste(image, (x, y))
        draw.text((cell_x + 8, cell_y + 6), f"TEST fixture {index + 1:02d}", fill="black", font=label_font)
    canvas.save(output, format="JPEG", quality=88, optimize=True)


def main() -> int:
    metadata_path = RAW_ROOT / "metadata.json"
    if not metadata_path.is_file():
        raise FileNotFoundError(metadata_path)
    source_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    fixtures_dir = OUTPUT_ROOT / "fixtures"
    fixtures_dir.mkdir(parents=True, exist_ok=True)

    seen_hashes: set[str] = set()
    fixtures: list[dict[str, object]] = []
    fixture_files: list[Path] = []

    for item in source_metadata.get("items", []):
        source = RAW_ROOT / "selected" / str(item.get("file", ""))
        if not source.is_file():
            continue
        width = int(item.get("width", 0) or 0)
        height = int(item.get("height", 0) or 0)
        ratio = width / max(height, 1)
        score = int(item.get("score", 0) or 0)
        # Phone screenshots in the discovered comments are much narrower than
        # a photographed half-A4 Passport. Keep only plausible paper photos.
        if ratio < 0.55 or score < 30:
            continue
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if digest in seen_hashes:
            continue
        seen_hashes.add(digest)

        index = len(fixtures) + 1
        target = fixtures_dir / f"passport-test-{index:02d}.jpg"
        sanitized_width, sanitized_height = sanitize(source, target, index)
        fixtures.append({
            "file": target.name,
            "source_group_id": int(item.get("group_id", 0) or 0),
            "source_group_domain": str(item.get("group_domain", "")),
            "source_post_id": int(item.get("post_id", 0) or 0),
            "source_comment_id": int(item.get("comment_id", 0) or 0),
            "source_photo_hash": str(item.get("photo_key_hash", "")),
            "discovery_score": score,
            "width": sanitized_width,
            "height": sanitized_height,
            "pii_sanitized": True,
            "synthetic_name": f"ТЕСТ ЯНТАРНЫЙ КОМБИНАТ {index:02d}",
        })
        fixture_files.append(target)
        if len(fixtures) >= MAX_FIXTURES:
            break

    if len(fixtures) < MIN_FIXTURES:
        raise RuntimeError(f"Only {len(fixtures)} sanitized Passport fixtures were produced")

    (OUTPUT_ROOT / "metadata.json").write_text(
        json.dumps({
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "pii_sanitized": True,
            "fixture_count": len(fixtures),
            "items": fixtures,
        }, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    contact_sheet(fixture_files, OUTPUT_ROOT / "contact-sheet-sanitized.jpg")
    (OUTPUT_ROOT / "README.txt").write_text(
        "Sanitized festival Passport fixtures for TEST-only E2E.\n"
        "Original handwritten FIO is covered; synthetic names begin with ТЕСТ.\n"
        "Do not use these images for real applications or publish them publicly.\n",
        encoding="utf-8",
    )

    print(f"Sanitized TEST Passport fixtures: {len(fixtures)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

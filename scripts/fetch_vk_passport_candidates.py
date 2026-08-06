#!/usr/bin/env python3
"""Discover festival Passport photos in VK comments without persisting PII in Git.

The script searches June–July 2026 comments in the festival-related VK
communities, downloads comment photo attachments to the ephemeral runner,
uses local Tesseract only to rank likely Passport participant forms, and writes
an artifact directory. User names and OCR text are not written to logs or
metadata; only source post/comment identifiers and keyword scores are kept.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import requests
from PIL import Image, ImageDraw, ImageFont, ImageOps

API_URL = "https://api.vk.com/method/{method}"
API_VERSION = "5.199"
FROM_TS = int(datetime(2026, 6, 1, tzinfo=timezone.utc).timestamp())
TO_TS = int(datetime(2026, 8, 1, tzinfo=timezone.utc).timestamp())
KEYWORDS = (
    "паспорт",
    "участник",
    "участника",
    "истори",
    "полюбить",
    "знание",
    "фестиваль",
    "штамп",
)
TARGET_GROUP_QUERIES = (
    "Полюбить Калининград Афиша",
    "Полюбить Калининград Анонсы",
    "Полюбить Калининград",
)
KNOWN_DOMAINS = ("kenigeventsofficial",)
MAX_DOWNLOADED = 300
MAX_SELECTED = 24


@dataclass(frozen=True)
class Group:
    id: int
    name: str
    screen_name: str


class VkError(RuntimeError):
    pass


def redact_error(value: Any) -> str:
    text = str(value)
    for token_name in ("VK_ACCESS_TOKEN7", "VK_SERVICE_TOKEN"):
        token = os.environ.get(token_name, "")
        if token:
            text = text.replace(token, "[REDACTED]")
    return text[:500]


def tokens() -> list[str]:
    result: list[str] = []
    for name in ("VK_ACCESS_TOKEN7", "VK_SERVICE_TOKEN"):
        value = os.environ.get(name, "").strip()
        if value and value not in result:
            result.append(value)
    if not result:
        raise VkError("VK token secrets are unavailable to the workflow")
    return result


def vk_call(method: str, params: dict[str, Any], *, attempts: int = 5) -> Any:
    last_error: Exception | None = None
    for attempt in range(attempts):
        for token in tokens():
            try:
                response = requests.get(
                    API_URL.format(method=method),
                    params={**params, "access_token": token, "v": API_VERSION},
                    timeout=45,
                )
                response.raise_for_status()
                payload = response.json()
                if "response" in payload:
                    return payload["response"]
                error = payload.get("error", {})
                code = int(error.get("error_code", 0) or 0)
                message = error.get("error_msg", "unknown VK API error")
                # Access differences between user/service tokens are expected.
                if code in {5, 7, 15, 27, 28}:
                    last_error = VkError(f"VK API {method}: {code} {message}")
                    continue
                if code in {6, 9, 10, 29}:
                    last_error = VkError(f"VK API {method}: {code} {message}")
                    time.sleep(min(2 ** attempt, 10))
                    continue
                raise VkError(f"VK API {method}: {code} {message}")
            except (requests.RequestException, ValueError, VkError) as exc:
                last_error = exc
        time.sleep(min(2 ** attempt, 10))
    raise VkError(redact_error(last_error or f"VK API {method} failed"))


def normalize_group(item: dict[str, Any]) -> Group | None:
    try:
        group_id = int(item["id"])
    except (KeyError, TypeError, ValueError):
        return None
    return Group(
        id=group_id,
        name=str(item.get("name", "")).strip(),
        screen_name=str(item.get("screen_name", "")).strip(),
    )


def discover_groups() -> list[Group]:
    candidates: dict[int, Group] = {}
    for domain in KNOWN_DOMAINS:
        try:
            response = vk_call("groups.getById", {"group_ids": domain, "fields": "screen_name"})
            items = response.get("groups", response) if isinstance(response, dict) else response
            for item in items or []:
                group = normalize_group(item)
                if group:
                    candidates[group.id] = group
        except Exception as exc:  # keep searching by name
            print(f"Known-domain lookup skipped: {redact_error(exc)}", file=sys.stderr)

    for query in TARGET_GROUP_QUERIES:
        try:
            response = vk_call(
                "groups.search",
                {"q": query, "count": 50, "type": "group", "sort": 0},
            )
        except Exception as exc:
            print(f"Group search skipped for one query: {redact_error(exc)}", file=sys.stderr)
            continue
        for item in response.get("items", []) if isinstance(response, dict) else []:
            group = normalize_group(item)
            if not group:
                continue
            folded = group.name.casefold()
            if "полюбить калининград" in folded or group.screen_name in KNOWN_DOMAINS:
                candidates[group.id] = group

    selected = [
        group
        for group in candidates.values()
        if (
            group.screen_name in KNOWN_DOMAINS
            or "афиша" in group.name.casefold()
            or "анонс" in group.name.casefold()
        )
    ]
    if not selected:
        selected = list(candidates.values())
    if not selected:
        raise VkError("No target VK communities were resolved")
    # Avoid leaking group member/user data; group names are public project metadata.
    print("Resolved VK communities:")
    for group in sorted(selected, key=lambda value: value.id):
        print(f"- id={group.id} domain={group.screen_name} name={group.name}")
    return sorted(selected, key=lambda value: value.id)


def iter_posts(group: Group) -> Iterable[dict[str, Any]]:
    offset = 0
    while True:
        response = vk_call(
            "wall.get",
            {"owner_id": -group.id, "count": 100, "offset": offset, "filter": "owner"},
        )
        items = response.get("items", []) if isinstance(response, dict) else []
        if not items:
            return
        oldest = min(int(item.get("date", 0) or 0) for item in items)
        for item in items:
            stamp = int(item.get("date", 0) or 0)
            if FROM_TS <= stamp < TO_TS:
                yield item
        if oldest < FROM_TS or len(items) < 100:
            return
        offset += len(items)
        time.sleep(0.35)


def iter_comment_items(owner_id: int, post_id: int) -> Iterable[dict[str, Any]]:
    offset = 0
    while True:
        response = vk_call(
            "wall.getComments",
            {
                "owner_id": owner_id,
                "post_id": post_id,
                "count": 100,
                "offset": offset,
                "sort": "asc",
                "preview_length": 0,
                "thread_items_count": 10,
            },
        )
        items = response.get("items", []) if isinstance(response, dict) else []
        if not items:
            return
        for item in items:
            yield item
            thread = item.get("thread") or {}
            for nested in thread.get("items", []) or []:
                yield nested
        if len(items) < 100:
            return
        offset += len(items)
        time.sleep(0.35)


def photo_url(photo: dict[str, Any]) -> str | None:
    sizes = photo.get("sizes") or []
    ranked = sorted(
        (size for size in sizes if size.get("url")),
        key=lambda size: int(size.get("width", 0) or 0) * int(size.get("height", 0) or 0),
        reverse=True,
    )
    return str(ranked[0]["url"]) if ranked else None


def attachment_photos(comment: dict[str, Any]) -> Iterable[dict[str, Any]]:
    for attachment in comment.get("attachments", []) or []:
        if attachment.get("type") == "photo" and isinstance(attachment.get("photo"), dict):
            yield attachment["photo"]


def download_image(url: str, target: Path) -> bool:
    try:
        response = requests.get(url, timeout=60)
        response.raise_for_status()
        if len(response.content) < 10_000:
            return False
        target.write_bytes(response.content)
        with Image.open(target) as image:
            image.verify()
        return True
    except Exception:
        target.unlink(missing_ok=True)
        return False


def tesseract_text(path: Path) -> str:
    try:
        result = subprocess.run(
            ["tesseract", str(path), "stdout", "-l", "rus+eng", "--psm", "11"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=45,
        )
        return result.stdout.casefold()
    except Exception:
        return ""


def image_metrics(path: Path) -> tuple[int, int, float]:
    with Image.open(path) as image:
        width, height = image.size
    ratio = width / max(height, 1)
    return width, height, ratio


def score_candidate(path: Path) -> tuple[int, list[str], tuple[int, int]]:
    width, height, ratio = image_metrics(path)
    if min(width, height) < 500 or not 0.45 <= ratio <= 2.5:
        return -100, [], (width, height)
    text = tesseract_text(path)
    matched = sorted({word for word in KEYWORDS if word in text})
    score = len(matched) * 10
    if "паспорт" in matched:
        score += 30
    if "участник" in matched or "участника" in matched:
        score += 20
    if "истори" in matched:
        score += 15
    # Formal half-A4 sheets are commonly photographed roughly in portrait/landscape A-series ratios.
    if 0.62 <= ratio <= 0.82 or 1.22 <= ratio <= 1.62:
        score += 5
    return score, matched, (width, height)


def font(size: int) -> ImageFont.ImageFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    ):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def contact_sheet(items: list[dict[str, Any]], output: Path) -> None:
    thumb_w, thumb_h = 420, 320
    columns = 3
    rows = (len(items) + columns - 1) // columns
    canvas = Image.new("RGB", (columns * thumb_w, max(1, rows) * thumb_h), "white")
    draw = ImageDraw.Draw(canvas)
    label_font = font(20)
    for index, item in enumerate(items):
        source = Path(item["path"])
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((thumb_w - 20, thumb_h - 48))
            x = (index % columns) * thumb_w + (thumb_w - image.width) // 2
            y = (index // columns) * thumb_h + 34
            canvas.paste(image, (x, y))
        label = f"{index + 1:02d}  score={item['score']}  {item['width']}x{item['height']}"
        draw.text(((index % columns) * thumb_w + 8, (index // columns) * thumb_h + 6), label, fill="black", font=label_font)
    canvas.save(output, quality=88)


def main() -> int:
    root = Path(os.environ.get("VK_PASSPORT_OUTPUT", ".codex-artifacts/vk-passport-candidates"))
    raw_dir = root / "candidates"
    raw_dir.mkdir(parents=True, exist_ok=True)

    groups = discover_groups()
    downloaded: list[dict[str, Any]] = []
    seen_photo_ids: set[str] = set()

    for group in groups:
        owner_id = -group.id
        for post in iter_posts(group):
            post_id = int(post.get("id", 0) or 0)
            comments_count = int((post.get("comments") or {}).get("count", 0) or 0)
            if not post_id or not comments_count:
                continue
            for comment in iter_comment_items(owner_id, post_id):
                for photo in attachment_photos(comment):
                    photo_key = f"{photo.get('owner_id')}:{photo.get('id')}"
                    if photo_key in seen_photo_ids:
                        continue
                    seen_photo_ids.add(photo_key)
                    url = photo_url(photo)
                    if not url:
                        continue
                    suffix = ".jpg"
                    target = raw_dir / f"source-{len(downloaded) + 1:04d}{suffix}"
                    if not download_image(url, target):
                        continue
                    score, matched, (width, height) = score_candidate(target)
                    downloaded.append(
                        {
                            "path": str(target),
                            "group_id": group.id,
                            "group_domain": group.screen_name,
                            "post_id": post_id,
                            "comment_id": int(comment.get("id", 0) or 0),
                            "photo_key_hash": hashlib.sha256(photo_key.encode()).hexdigest()[:16],
                            "score": score,
                            "matched_keywords": matched,
                            "width": width,
                            "height": height,
                        }
                    )
                    if len(downloaded) >= MAX_DOWNLOADED:
                        break
                if len(downloaded) >= MAX_DOWNLOADED:
                    break
            if len(downloaded) >= MAX_DOWNLOADED:
                break
        if len(downloaded) >= MAX_DOWNLOADED:
            break

    ranked = sorted(downloaded, key=lambda item: (item["score"], item["width"] * item["height"]), reverse=True)
    likely = [item for item in ranked if item["score"] >= 20][:MAX_SELECTED]
    if len(likely) < 10:
        likely = ranked[: min(MAX_SELECTED, len(ranked))]

    selected_dir = root / "selected"
    selected_dir.mkdir(parents=True, exist_ok=True)
    metadata: list[dict[str, Any]] = []
    for index, item in enumerate(likely, start=1):
        source = Path(item["path"])
        target = selected_dir / f"passport-candidate-{index:02d}.jpg"
        target.write_bytes(source.read_bytes())
        clean = {key: value for key, value in item.items() if key != "path"}
        clean["file"] = target.name
        metadata.append(clean)

    (root / "metadata.json").write_text(
        json.dumps(
            {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "date_window": ["2026-06-01", "2026-07-31"],
                "downloaded_photo_attachments": len(downloaded),
                "selected_candidates": len(metadata),
                "communities": [
                    {"id": group.id, "name": group.name, "screen_name": group.screen_name}
                    for group in groups
                ],
                "items": metadata,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    if metadata:
        contact_sheet(
            [{**item, "path": str(selected_dir / item["file"])} for item in metadata],
            root / "contact-sheet.jpg",
        )

    # Only selected candidates are uploaded; remove the larger raw pool immediately.
    for path in raw_dir.glob("*"):
        path.unlink(missing_ok=True)
    raw_dir.rmdir()

    print(f"Downloaded comment photo attachments: {len(downloaded)}")
    print(f"Selected likely Passport candidates: {len(metadata)}")
    if len(metadata) < 10:
        raise VkError("Fewer than ten candidate images were found")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"VK passport discovery failed: {redact_error(exc)}", file=sys.stderr)
        raise

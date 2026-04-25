from __future__ import annotations

import json
import re
from pathlib import Path

from PIL import Image

try:
    import cv2
    import numpy as np
except ImportError:  # pragma: no cover - optional local dependency
    cv2 = None
    np = None


ROOT = Path(__file__).resolve().parents[2]
SITE_ROOT = ROOT / "site"
SOURCE_ROOT = ROOT / "Исходные данные" / "Фотографии"
EVENTS_SRC = SOURCE_ROOT / "Лекции"
PLAYS_SRC = SOURCE_ROOT / "Спектакли"
SPEAKERS_ROOT = SOURCE_ROOT / "спикеры"
SPEAKERS_CUTOUTS = SPEAKERS_ROOT / "Обрезанный фон"
EVENTS_OUT = SITE_ROOT / "public" / "generated" / "events"
SPEAKERS_OUT = SITE_ROOT / "public" / "generated" / "speakers"
SPEAKER_STRIP_OUT = SITE_ROOT / "public" / "generated" / "speaker-strip"
MANIFEST_OUT = SITE_ROOT / "src" / "data" / "media-manifest.json"

EVENT_MAX_WIDTH = 1800
EVENT_QUALITY = 84
WEBP_METHOD = 3
SPEAKER_CANVAS = (2200, 2400)
SPEAKER_RATIO = 0.76
SPEAKER_QUALITY = 92
SPEAKER_STRIP_CANVAS = (1400, 1500)
SPEAKER_STRIP_FACE_HEIGHT = 340
SPEAKER_STRIP_FACE_TOP = 390
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}

SPEAKER_STRIP_PRESETS = {
    "aleksey-sokolov": {
        "source": SPEAKERS_CUTOUTS / "Алексей Соколов.png",
        "face": (378, 687, 397, 397),
    },
    "dolotova-inga": {
        "source": SPEAKERS_CUTOUTS / "Долотова Инга.png",
        "face": (465, 327, 403, 403),
    },
    "zhadobko-sergey": {
        "source": SPEAKERS_CUTOUTS / "Жадобко Сергей.png",
        # The auto detector overestimates his face and makes the whole portrait too small.
        "face": (676, 214, 430, 430),
    },
    "ilyushkina-ekaterina": {
        "source": SPEAKERS_CUTOUTS / "Илюшкина Екатерина.png",
        "face": (724, 381, 389, 389),
    },
    "mashinskaya-ekaterina": {
        "source": SPEAKERS_CUTOUTS / "Машинская Екатерина.png",
        "face": (679, 316, 420, 420),
    },
    "mosienko-evgeniy": {
        "source": SPEAKERS_CUTOUTS / "Мосиенко Евгений.png",
        "face": (625, 262, 340, 340),
    },
    "nadymova-valeriya": {
        "source": SPEAKERS_CUTOUTS / "Надымова Валерия.png",
        "face": (487, 229, 502, 502),
    },
    "nizhegorodtseva-evgeniya": {
        "source": SPEAKERS_CUTOUTS / "Нижегородцева Евгения.png",
        "face": (690, 282, 395, 395),
    },
    "popadin-aleksandr": {
        "source": SPEAKERS_CUTOUTS / "Попадин Александр.png",
        "face": (485, 372, 319, 319),
    },
    "skrebtsova-anastasiya": {
        "source": SPEAKERS_CUTOUTS / "Скребцова Анастасия.png",
        "face": (759, 332, 395, 395),
    },
    "tatyana-konyuhova-img-20260313-105601-177": {
        "source": SPEAKERS_CUTOUTS / "Татьяна Конюхова.png",
        "face": (451, 316, 335, 335),
    },
    "udovenko-tatyana": {
        "source": SPEAKERS_CUTOUTS / "Удовенко Татьяна.png",
        "face": (528, 348, 341, 341),
    },
    "yartsev-andrey-3": {
        "source": SPEAKERS_CUTOUTS / "Ярцев Андрей - 3.png",
        "face": (623, 378, 324, 324),
    },
}


TRANSLIT = {
    "а": "a",
    "б": "b",
    "в": "v",
    "г": "g",
    "д": "d",
    "е": "e",
    "ё": "e",
    "ж": "zh",
    "з": "z",
    "и": "i",
    "й": "y",
    "к": "k",
    "л": "l",
    "м": "m",
    "н": "n",
    "о": "o",
    "п": "p",
    "р": "r",
    "с": "s",
    "т": "t",
    "у": "u",
    "ф": "f",
    "х": "h",
    "ц": "ts",
    "ч": "ch",
    "ш": "sh",
    "щ": "sch",
    "ъ": "",
    "ы": "y",
    "ь": "",
    "э": "e",
    "ю": "yu",
    "я": "ya",
}


def slugify(value: str) -> str:
    lowered = value.lower()
    transliterated = "".join(TRANSLIT.get(char, char) for char in lowered)
    slug = re.sub(r"[^a-z0-9]+", "-", transliterated).strip("-")
    return re.sub(r"-{2,}", "-", slug)


def ensure_dirs() -> None:
    EVENTS_OUT.mkdir(parents=True, exist_ok=True)
    SPEAKERS_OUT.mkdir(parents=True, exist_ok=True)
    SPEAKER_STRIP_OUT.mkdir(parents=True, exist_ok=True)
    MANIFEST_OUT.parent.mkdir(parents=True, exist_ok=True)


def resize_to_bounds(img: Image.Image, max_width: int, max_height: int) -> Image.Image:
    ratio = min(max_width / img.width, max_height / img.height, 1.0)
    if ratio >= 1.0:
        return img
    return img.resize((int(img.width * ratio), int(img.height * ratio)), Image.LANCZOS)


def resize_event_image(img: Image.Image) -> Image.Image:
    if img.width <= EVENT_MAX_WIDTH:
        return img
    ratio = EVENT_MAX_WIDTH / img.width
    return img.resize((EVENT_MAX_WIDTH, int(img.height * ratio)), Image.LANCZOS)


def export_event_images(manifest: dict) -> None:
    event_entries = {}

    for folder in [EVENTS_SRC, PLAYS_SRC]:
        for source in sorted(folder.iterdir()):
            if not source.is_file():
                continue

            target_slug = slugify(source.stem)
            target_path = EVENTS_OUT / f"{target_slug}.webp"

            with Image.open(source) as img:
                converted = resize_event_image(img.convert("RGB"))
                converted.save(target_path, "WEBP", quality=EVENT_QUALITY, method=WEBP_METHOD)

            event_entries[source.stem] = f"/generated/events/{target_slug}.webp"

    manifest["events"] = event_entries


def crop_to_ratio(img: Image.Image, ratio: float) -> Image.Image:
    width, height = img.size
    current_ratio = width / height

    if current_ratio > ratio:
        target_width = int(height * ratio)
        left = max((width - target_width) // 2, 0)
        return img.crop((left, 0, left + target_width, height))

    if current_ratio < ratio:
        target_height = int(width / ratio)
        top = max((height - target_height) // 2, 0)
        return img.crop((0, top, width, top + target_height))

    return img


def crop_transparent_bounds(img: Image.Image) -> Image.Image:
    alpha = img.getchannel("A")
    bbox = alpha.getbbox()
    if bbox:
        return img.crop(bbox)
    return img


def detect_face_bounds(img: Image.Image) -> tuple[int, int, int, int] | None:
    if cv2 is None or np is None:
        return None

    rgba = img.convert("RGBA")
    background = Image.new("RGB", rgba.size, (246, 246, 246))
    background.paste(rgba, mask=rgba.getchannel("A"))
    grayscale = cv2.cvtColor(np.array(background), cv2.COLOR_RGB2GRAY)
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")

    candidates: list[tuple[int, int, int, int]] = []

    search_specs = [
        (0.50, 1.03, 3, (60, 60)),
        (0.55, 1.03, 3, (60, 60)),
        (0.62, 1.04, 4, (80, 80)),
        (1.00, 1.05, 5, (80, 80)),
    ]

    for limit_ratio, scale_factor, min_neighbors, min_size in search_specs:
        upper_limit = grayscale.shape[0] if limit_ratio >= 1 else max(int(grayscale.shape[0] * limit_ratio), 80)
        faces = cascade.detectMultiScale(
            grayscale[:upper_limit, :],
            scaleFactor=scale_factor,
            minNeighbors=min_neighbors,
            minSize=min_size,
        )

        for face in faces:
            x, y, w, h = (int(value) for value in face)
            if y + h / 2 > grayscale.shape[0] * 0.58:
                continue
            candidates.append((x, y, w, h))

    if not candidates:
        return None

    unique_candidates = {
        candidate
        for candidate in candidates
    }
    return max(
        unique_candidates,
        key=lambda face: (
            face[2] * face[3],
            -(face[1]),
            -abs((face[0] + face[2] / 2) - grayscale.shape[1] / 2),
        ),
    )


def place_on_canvas(img: Image.Image, face: tuple[int, int, int, int] | None) -> Image.Image:
    canvas = Image.new("RGBA", SPEAKER_CANVAS, (0, 0, 0, 0))

    if face:
        x, _, w, _ = face
        face_center_x = x + w / 2
        offset_x = round(SPEAKER_CANVAS[0] / 2 - face_center_x)
    else:
        offset_x = round((SPEAKER_CANVAS[0] - img.width) / 2)
    offset_y = max(SPEAKER_CANVAS[1] - img.height, 0)

    canvas.alpha_composite(img, (offset_x, offset_y))
    return canvas


def place_on_strip_canvas(img: Image.Image, face: tuple[int, int, int, int] | None) -> Image.Image:
    canvas = Image.new("RGBA", SPEAKER_STRIP_CANVAS, (0, 0, 0, 0))

    if face:
        x, _, w, _ = face
        face_center_x = x + w / 2
        offset_x = round(SPEAKER_STRIP_CANVAS[0] / 2 - face_center_x)
        canvas.alpha_composite(img, (offset_x, 0))
        return canvas

    offset_x = round((SPEAKER_STRIP_CANVAS[0] - img.width) / 2)
    canvas.alpha_composite(img, (offset_x, 0))
    return canvas


def score_speaker_image(img: Image.Image, face: tuple[int, int, int, int] | None) -> float:
    if not face:
        return 0.0

    x, _, w, h = face
    half_width = max(img.width / 2, 1)
    center_x = x + w / 2
    center_bias = max(0.0, 1 - abs(center_x - half_width) / half_width)
    return (w * h) * (center_bias**2)


def prepare_speaker_image(source: Path) -> tuple[Image.Image, float]:
    with Image.open(source) as img:
        rgba = img.convert("RGBA")
        alpha_bbox = rgba.getchannel("A").getbbox()
        if source.parent == SPEAKERS_CUTOUTS and alpha_bbox:
            prepared = rgba.crop(alpha_bbox)
        else:
            if alpha_bbox and alpha_bbox != (0, 0, rgba.width, rgba.height):
                prepared = crop_transparent_bounds(rgba)
            else:
                prepared = crop_to_ratio(rgba, SPEAKER_RATIO)

        detected_face = detect_face_bounds(prepared)
        portrait_score = score_speaker_image(prepared, detected_face)
        return place_on_canvas(prepared, detected_face), portrait_score


def prepare_speaker_strip_image(source: Path, face_override: tuple[int, int, int, int] | None = None) -> Image.Image:
    with Image.open(source) as img:
        rgba = img.convert("RGBA")
        alpha_bbox = rgba.getchannel("A").getbbox()
        face = face_override

        if source.parent == SPEAKERS_CUTOUTS and alpha_bbox:
            left, top, right, bottom = alpha_bbox
            prepared = rgba.crop(alpha_bbox)
            if face:
                x, y, w, h = face
                face = (x - left, y - top, w, h)
        else:
            if alpha_bbox and alpha_bbox != (0, 0, rgba.width, rgba.height):
                prepared = crop_transparent_bounds(rgba)
            else:
                prepared = crop_to_ratio(rgba, SPEAKER_RATIO)

        if not face:
            face = detect_face_bounds(prepared)

        return place_on_strip_canvas(prepared, face)


def resolve_speaker_key(source: Path) -> str:
    if source.parent == SPEAKERS_CUTOUTS:
        cleaned = re.sub(r"\s+\([^)]*\)$", "", source.stem)
        return cleaned.split(" - ")[0]
    return source.parent.name


def resolve_speaker_slug_seed(source: Path, key: str) -> str:
    if source.parent == SPEAKERS_CUTOUTS:
        return source.stem
    return f"{key}-{source.stem}"


def export_speaker_images(manifest: dict) -> None:
    speaker_entries: dict[str, list[tuple[float, str]]] = {}

    for source in sorted(SPEAKERS_ROOT.rglob("*")):
        if not source.is_file() or source.suffix.lower() not in IMAGE_SUFFIXES:
            continue

        key = resolve_speaker_key(source)
        target_slug = slugify(resolve_speaker_slug_seed(source, key))
        target_path = SPEAKERS_OUT / f"{target_slug}.webp"
        prepared, portrait_score = prepare_speaker_image(source)
        prepared.save(target_path, "WEBP", quality=SPEAKER_QUALITY, method=WEBP_METHOD)

        speaker_entries.setdefault(key, []).append((portrait_score, f"/generated/speakers/{target_slug}.webp"))

    manifest["speakers"] = {
        key: [path for _, path in sorted(entries, key=lambda entry: entry[0], reverse=True)]
        for key, entries in speaker_entries.items()
    }


def export_speaker_strip_images() -> None:
    for source in sorted(SPEAKERS_ROOT.rglob("*")):
        if not source.is_file() or source.suffix.lower() not in IMAGE_SUFFIXES:
            continue

        key = resolve_speaker_key(source)
        slug = slugify(resolve_speaker_slug_seed(source, key))
        preset = SPEAKER_STRIP_PRESETS.get(slug)
        prepared = prepare_speaker_strip_image(
            preset["source"] if preset else source,
            preset["face"] if preset else None,
        )
        prepared.save(SPEAKER_STRIP_OUT / f"{slug}.webp", "WEBP", quality=SPEAKER_QUALITY, method=WEBP_METHOD)


def main() -> None:
    ensure_dirs()
    manifest: dict[str, dict] = {}
    export_event_images(manifest)
    export_speaker_images(manifest)
    export_speaker_strip_images()
    MANIFEST_OUT.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Prepared media manifest: {MANIFEST_OUT}")


if __name__ == "__main__":
    main()

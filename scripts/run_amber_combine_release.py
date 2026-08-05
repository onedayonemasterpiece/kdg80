#!/usr/bin/env python3
"""Materialize the bundled amber WebP assets and run the prepared integration.

The binary files are stored in Git as deterministic base64 chunks because the
original ChatGPT attachment filesystem is not shared with later Codex sessions.
This wrapper makes the release independent from external attachments.
"""

from __future__ import annotations

import base64
import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUNDLE_DIR = ROOT / "release-assets" / "amber-combine"
PUBLIC_DIR = ROOT / "site" / "public" / "generated" / "special"
INTEGRATION_SCRIPT = ROOT / "scripts" / "prepare_amber_combine_release.py"

ASSETS = (
    {
        "name": "amber-combine-jewelry-production.webp",
        "parts_glob": "amber-combine-jewelry-production.webp.b64.part-*",
        "sha256": "8ca2e4694679d69e4309d5d23de53c7310f89aa03381ebd5acb9a241aca2bacf",
        "bytes": 28790,
        "dimensions": "1200x900",
    },
    {
        "name": "amber-combine-jewelry-production-og.webp",
        "parts_glob": "amber-combine-jewelry-production-og.webp.b64.part-*",
        "sha256": "4c2b6653286bb2a86ba3f97f3ee8a8fb8b707420c8b85f78eea381438242d218",
        "bytes": 21292,
        "dimensions": "1200x630",
    },
)


def read_bundled_asset(spec: dict[str, object]) -> bytes:
    parts = sorted(BUNDLE_DIR.glob(str(spec["parts_glob"])))
    if not parts:
        raise RuntimeError(
            f"Bundled source for {spec['name']} was not found in {BUNDLE_DIR}."
        )

    encoded = "".join(part.read_text(encoding="ascii").strip() for part in parts)
    try:
        data = base64.b64decode(encoded, validate=True)
    except Exception as error:
        raise RuntimeError(f"Invalid base64 chunks for {spec['name']}.") from error

    digest = hashlib.sha256(data).hexdigest()
    if digest != spec["sha256"]:
        raise RuntimeError(
            f"Checksum mismatch for {spec['name']}: expected {spec['sha256']}, got {digest}."
        )
    if len(data) != spec["bytes"]:
        raise RuntimeError(
            f"Size mismatch for {spec['name']}: expected {spec['bytes']}, got {len(data)}."
        )
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise RuntimeError(f"Bundled file {spec['name']} is not a WebP image.")

    return data


def materialize_assets() -> list[Path]:
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    targets: list[Path] = []

    for spec in ASSETS:
        data = read_bundled_asset(spec)
        target = PUBLIC_DIR / str(spec["name"])
        if not target.exists() or target.read_bytes() != data:
            target.write_bytes(data)
            print(f"Materialized {target.relative_to(ROOT)} ({spec['dimensions']}).")
        else:
            print(f"Asset already current: {target.relative_to(ROOT)}.")
        targets.append(target)

    return targets


def run_integration(targets: list[Path]) -> None:
    command = [
        sys.executable,
        str(INTEGRATION_SCRIPT),
        "--source-image",
        str(targets[0]),
        "--source-og",
        str(targets[1]),
    ]
    subprocess.run(command, cwd=ROOT, check=True)


def main() -> int:
    targets = materialize_assets()
    run_integration(targets)
    print("Amber-combine integration completed without external attachments.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

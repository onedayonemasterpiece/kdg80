# Bundled media for the amber-combine special event

These files make the release reproducible across separate Codex/ChatGPT sessions.
The original attachment filesystem is session-local, so the two WebP images are
stored here as deterministic base64 chunks and materialized by:

```bash
python3 scripts/run_amber_combine_release.py
```

The wrapper reconstructs and verifies:

| Output | Dimensions | Bytes | SHA-256 |
|---|---:|---:|---|
| `site/public/generated/special/amber-combine-jewelry-production.webp` | 1200×900 | 28790 | `8ca2e4694679d69e4309d5d23de53c7310f89aa03381ebd5acb9a241aca2bacf` |
| `site/public/generated/special/amber-combine-jewelry-production-og.webp` | 1200×630 | 21292 | `4c2b6653286bb2a86ba3f97f3ee8a8fb8b707420c8b85f78eea381438242d218` |

Do not hand-edit the `.b64.part-*` files. A checksum mismatch stops the release
before any invalid image is used.

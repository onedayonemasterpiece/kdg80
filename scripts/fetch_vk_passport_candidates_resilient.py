#!/usr/bin/env python3
"""Resilient entry point for VK Passport candidate discovery.

Some wall.get results can reference repost-like or otherwise inaccessible posts.
Skip those individual comment threads instead of aborting the full June–July scan.
"""

from __future__ import annotations

import sys

import fetch_vk_passport_candidates as discovery

_original_iter_comment_items = discovery.iter_comment_items


def _safe_iter_comment_items(owner_id: int, post_id: int):
    try:
        yield from _original_iter_comment_items(owner_id, post_id)
    except discovery.VkError as exc:
        print(
            f"Skipping inaccessible VK comment thread owner={owner_id} post={post_id}: "
            f"{discovery.redact_error(exc)}",
            file=sys.stderr,
        )
        return


discovery.iter_comment_items = _safe_iter_comment_items

if __name__ == "__main__":
    try:
        raise SystemExit(discovery.main())
    except Exception as exc:
        print(f"VK passport discovery failed: {discovery.redact_error(exc)}", file=sys.stderr)
        raise

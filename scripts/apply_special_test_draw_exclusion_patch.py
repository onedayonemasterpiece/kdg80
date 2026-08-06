#!/usr/bin/env python3
"""Make accepted TEST applications impossible to enter a production draw."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APPLICATIONS = ROOT / "registration/src/services/special-applications.ts"
CLEANUP = ROOT / "registration/src/services/special-test-cleanup.ts"
DRAWS = ROOT / "registration/src/services/special-draws.ts"
CLEANUP_TEST = ROOT / "registration/src/services/special-test-cleanup.test.ts"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"Cannot find expected {label}; refusing to guess.")
    return text.replace(old, new, 1)


def patch_applications() -> bool:
    original = APPLICATIONS.read_text(encoding="utf-8")
    text = original
    text = replace_once(
        text,
        "  const fullNameFingerprint = computeFingerprint(deps.fingerprintSecret, fullName.toLowerCase());\n",
        "  const testApplication = isSpecialTestFullName(fullName);\n"
        "  const fullNameFingerprint = computeFingerprint(deps.fingerprintSecret, fullName.toLowerCase());\n",
        "early TEST application classification",
    )
    text = replace_once(
        text,
        "  const applicationCode = crypto.randomUUID();\n",
        "  const applicationCode = testApplication\n"
        "    ? `TEST-${crypto.randomUUID()}`\n"
        "    : crypto.randomUUID();\n",
        "TEST-prefixed application code",
    )

    late_declaration = (
        "  const testApplication = isSpecialTestFullName(fullName);\n"
        "  if (!testApplication) {\n"
    )
    declaration_count = text.count("  const testApplication = isSpecialTestFullName(fullName);\n")
    if declaration_count == 2 and late_declaration in text:
        text = text.replace(late_declaration, "  if (!testApplication) {\n", 1)
    elif declaration_count != 1:
        raise RuntimeError(
            f"Expected exactly one final TEST classification declaration, found {declaration_count}."
        )

    if text == original:
        return False
    APPLICATIONS.write_text(text, encoding="utf-8")
    return True


def patch_cleanup() -> bool:
    original = CLEANUP.read_text(encoding="utf-8")
    text = replace_once(
        original,
        "  const applicationCode = options.applicationCode.trim();\n"
        "  const row = db.prepare(`\n",
        "  const applicationCode = options.applicationCode.trim();\n"
        "  if (!applicationCode.startsWith('TEST-')) {\n"
        "    throw new SpecialTestCleanupError(\n"
        "      403,\n"
        "      'not_a_test_application_code',\n"
        "      'Удаление разрешено только для заявок с техническим кодом TEST-.',\n"
        "    );\n"
        "  }\n\n"
        "  const row = db.prepare(`\n",
        "TEST application-code guard",
    )
    if text == original:
        return False
    CLEANUP.write_text(text, encoding="utf-8")
    return True


def patch_draws() -> bool:
    original = DRAWS.read_text(encoding="utf-8")
    text = original
    patterns = (
        (
            "      AND a.status = 'accepted'\n"
            "      AND a.score > 0\n",
            "      AND a.status = 'accepted'\n"
            "      AND a.score > 0\n"
            "      AND a.application_code NOT LIKE 'TEST-%'\n",
            "draw candidate query",
        ),
        (
            "          AND a.status = 'accepted'\n"
            "          AND a.score > 0\n",
            "          AND a.status = 'accepted'\n"
            "          AND a.score > 0\n"
            "          AND a.application_code NOT LIKE 'TEST-%'\n",
            "Telegram accepted-candidate count query",
        ),
    )
    for old, new, label in patterns:
        text = replace_once(text, old, new, label)
    if text == original:
        return False
    DRAWS.write_text(text, encoding="utf-8")
    return True


def patch_cleanup_test() -> bool:
    original = CLEANUP_TEST.read_text(encoding="utf-8")
    text = original
    replacements = {
        "const code = 'SP-TEST-CLEANUP';": "const code = 'TEST-SP-CLEANUP';",
        "const code = 'SP-TEST-CLEANUP-1';": "const code = 'TEST-SP-CLEANUP-1';",
    }
    for old, new in replacements.items():
        if new not in text:
            if old not in text:
                raise RuntimeError(f"Cannot find cleanup test code {old!r}.")
            text = text.replace(old, new, 1)
    if text == original:
        return False
    CLEANUP_TEST.write_text(text, encoding="utf-8")
    return True


def main() -> int:
    changed = []
    for path, apply in (
        (APPLICATIONS, patch_applications),
        (CLEANUP, patch_cleanup),
        (DRAWS, patch_draws),
        (CLEANUP_TEST, patch_cleanup_test),
    ):
        if apply():
            changed.append(str(path.relative_to(ROOT)))
    print("Applied TEST draw-isolation patch:")
    for item in changed:
        print(f"- {item}")
    if not changed:
        print("- already up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

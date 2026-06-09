#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
SITE_DIR="${ROOT_DIR}/site"
SITE_DIST_DIR="${SITE_DIR}/dist"
TIMESTAMP="$(date -u +"%Y%m%d-%H%M%S")"
RANDOM_SUFFIX="$(python3 - <<'PY'
import secrets
print(secrets.token_hex(4))
PY
)"
PREVIEW_SLUG="${1:-preview-${TIMESTAMP}-${RANDOM_SUFFIX}}"
STAGING_DIR="$(mktemp -d)"

if [[ ! -f "${ENV_FILE}" ]]; then
  ENV_FILE="${ROOT_DIR}/docs/.env"
fi

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  . "${ENV_FILE}"
  set +a
fi

BASE_URL="${YC_PUBLIC_BASE_URL:-}"

cleanup() {
  rm -rf "${STAGING_DIR}"
}

trap cleanup EXIT

case "${PREVIEW_SLUG}" in
  ""|*/*|.*)
    echo "Preview slug must be a simple folder name without slashes."
    exit 1
    ;;
esac

if [[ "${SKIP_ASTRO_BUILD:-0}" == "1" ]]; then
  echo "Using existing Astro build for preview: ${SITE_DIST_DIR}"
else
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to build the Astro preview. Set SKIP_ASTRO_BUILD=1 only after building ${SITE_DIST_DIR} separately."
    exit 1
  fi

  echo "Building Astro site for preview"
  (
    cd "${SITE_DIR}"
    npm run build
  )
fi

if [[ ! -d "${SITE_DIST_DIR}" ]]; then
  echo "Missing Astro build output: ${SITE_DIST_DIR}"
  exit 1
fi

cp -R "${SITE_DIST_DIR}/." "${STAGING_DIR}/"

PREVIEW_URL=""
if [[ -n "${BASE_URL}" ]]; then
  PREVIEW_URL="${BASE_URL%/}/${PREVIEW_SLUG}/"
fi

python3 - "${STAGING_DIR}" "${PREVIEW_URL}" "/${PREVIEW_SLUG}" <<'PY'
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
preview_url = sys.argv[2]
preview_path = sys.argv[3].rstrip("/")
robots_meta = '<meta name="robots" content="noindex, nofollow, noarchive">'
viewport_meta = '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
text_extensions = {".html", ".css", ".js"}
preserve_prefixes = ("/tickets/",)

attr_url_pattern = re.compile(r'(?P<prefix>\b(?:href|src|content)=["\'])(?P<url>/[^"\']*)(?P<suffix>["\'])')
css_url_pattern = re.compile(r'url\((?P<quote>["\']?)(?P<url>/[^)"\']+)(?P=quote)\)')
string_url_pattern = re.compile(r'(?P<quote>["\'])(?P<url>/[^"\']*)(?P=quote)')
escaped_string_url_pattern = re.compile(r'(?P<prefix>(?:&#34;|&quot;))(?P<url>/.*?)(?P<suffix>(?:&#34;|&quot;))')


def is_preserved(url: str) -> bool:
    return any(url.startswith(prefix) for prefix in preserve_prefixes)


def prefix_url(url: str) -> str:
    if not url.startswith("/") or url.startswith("//"):
        return url
    if is_preserved(url):
        return url
    if url == preview_path or url.startswith(f"{preview_path}/") or url.startswith(f"{preview_path}#"):
        return url
    if url == "/":
        return f"{preview_path}/"
    return f"{preview_path}{url}"


def rewrite_attr_urls(text: str) -> str:
    return attr_url_pattern.sub(lambda match: f"{match.group('prefix')}{prefix_url(match.group('url'))}{match.group('suffix')}", text)


def rewrite_css_urls(text: str) -> str:
    return css_url_pattern.sub(lambda match: f"url({match.group('quote')}{prefix_url(match.group('url'))}{match.group('quote')})", text)


def rewrite_string_urls(text: str) -> str:
    return string_url_pattern.sub(lambda match: f"{match.group('quote')}{prefix_url(match.group('url'))}{match.group('quote')}", text)


def rewrite_escaped_string_urls(text: str) -> str:
    return escaped_string_url_pattern.sub(lambda match: f"{match.group('prefix')}{prefix_url(match.group('url'))}{match.group('suffix')}", text)


def page_url_for(html_path: Path) -> str:
    relative = html_path.relative_to(root)
    if relative.name == "index.html":
        suffix = "" if relative.parent == Path(".") else f"{relative.parent.as_posix()}/"
        return f"{preview_url}{suffix}"
    return f"{preview_url}{relative.as_posix()}"

for path in root.rglob("*"):
    if not path.is_file() or path.suffix not in text_extensions:
        continue

    text = path.read_text(encoding="utf-8")

    if path.suffix == ".html":
        if 'meta name="robots"' in text:
            text = re.sub(r'<meta name="robots"[^>]*>', robots_meta, text, count=1)
        elif viewport_meta in text:
            text = text.replace(viewport_meta, f"{viewport_meta}\n  {robots_meta}", 1)
        else:
            text = text.replace("<head>", f"<head>\n  {robots_meta}", 1)

        if preview_url:
            page_url = page_url_for(path)

            if 'rel="canonical"' in text:
                text = re.sub(
                    r'<link rel="canonical" href="[^"]*">',
                    f'<link rel="canonical" href="{page_url}">',
                    text,
                    count=1,
                )

            if 'property="og:url"' in text:
                text = re.sub(
                    r'<meta property="og:url" content="[^"]*">',
                    f'<meta property="og:url" content="{page_url}">',
                    text,
                    count=1,
                )

    text = rewrite_attr_urls(text)
    text = rewrite_css_urls(text)
    if path.suffix in {".html", ".js"}:
        text = rewrite_string_urls(text)
    if path.suffix == ".html":
        text = rewrite_escaped_string_urls(text)

    path.write_text(text, encoding="utf-8")
PY

export DEPLOY_SOURCE_DIR="${STAGING_DIR}"
export YC_BUCKET_PREFIX="${PREVIEW_SLUG}"
export DEPLOY_MODE="static-tree"

echo "Deploying preview to secret prefix: ${PREVIEW_SLUG}/"
"${ROOT_DIR}/deploy-to-yc.sh"

if [[ -n "${PREVIEW_URL}" ]]; then
  echo "Preview URL: ${PREVIEW_URL}"
else
  echo "Preview prefix uploaded: ${PREVIEW_SLUG}/"
fi

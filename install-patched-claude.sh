#!/usr/bin/env bash

set -euo pipefail

REPO_SLUG="${PATCH_CLAUDE_REPO:-a-connoisseur/patch-claude-code}"
API_URL="https://api.github.com/repos/${REPO_SLUG}/releases?per_page=100"

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  log "Error: $*"
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)
      case "$arch" in
        x86_64)
          RELEASE_SUFFIX="linux-x64"
          ASSET_NAME="claude.native.patched"
          ;;
        aarch64|arm64)
          RELEASE_SUFFIX="linux-arm64"
          ASSET_NAME="claude.native.patched"
          ;;
        *)
          fail "Unsupported Linux architecture: ${arch}"
          ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        arm64)
          RELEASE_SUFFIX="macos-arm64"
          ASSET_NAME="claude.native.macos.patched"
          ;;
        *)
          fail "Unsupported macOS architecture: ${arch}. Only Apple Silicon is supported."
          ;;
      esac
      ;;
    *)
      fail "Unsupported operating system: ${os}"
      ;;
  esac
}

find_existing_claude() {
  local claude_path
  claude_path="$(command -v claude || true)"
  if [[ -z "$claude_path" ]]; then
    cat >&2 <<'EOF'
Error: Could not find an existing native Claude installation.

Install the official native Claude binary first, then run this installer again:

  curl -fsSL https://claude.ai/install.sh | bash

EOF
    exit 1
  fi

  CLAUDE_PATH="$claude_path"
}

fetch_release_metadata() {
  require_cmd curl
  require_cmd python3

  local release_json
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    release_json="$(
      curl -fsSL \
        -H "Accept: application/vnd.github+json" \
        -H "Authorization: Bearer ${GITHUB_TOKEN}" \
        -H "User-Agent: patch-claude-code-installer" \
        "$API_URL"
    )"
  elif [[ -n "${GH_TOKEN:-}" ]]; then
    release_json="$(
      curl -fsSL \
        -H "Accept: application/vnd.github+json" \
        -H "Authorization: Bearer ${GH_TOKEN}" \
        -H "User-Agent: patch-claude-code-installer" \
        "$API_URL"
    )"
  else
    release_json="$(
      curl -fsSL \
        -H "Accept: application/vnd.github+json" \
        -H "User-Agent: patch-claude-code-installer" \
        "$API_URL"
    )"
  fi

  RELEASE_METADATA="$(
    RELEASE_JSON="$release_json" python3 - "$RELEASE_SUFFIX" "$ASSET_NAME" <<'PY'
import json
import os
import re
import sys

suffix = sys.argv[1]
asset_name = sys.argv[2]
pattern = re.compile(rf"^v\d+\.\d+\.\d+-{re.escape(suffix)}(?:-\d+)?$")

releases = json.loads(os.environ["RELEASE_JSON"])
if not isinstance(releases, list):
    raise SystemExit(1)

for release in releases:
    if release.get("draft") or release.get("prerelease"):
        continue
    tag = release.get("tag_name", "")
    if not pattern.match(tag):
        continue
    for asset in release.get("assets", []):
        if asset.get("name") == asset_name:
            print(tag)
            print(asset["browser_download_url"])
            raise SystemExit(0)

raise SystemExit(1)
PY
  )" || fail "Could not find a release asset for ${RELEASE_SUFFIX}"

  RELEASE_TAG="$(printf '%s\n' "$RELEASE_METADATA" | sed -n '1p')"
  DOWNLOAD_URL="$(printf '%s\n' "$RELEASE_METADATA" | sed -n '2p')"

  [[ -n "$RELEASE_TAG" ]] || fail "Failed to parse release tag"
  [[ -n "$DOWNLOAD_URL" ]] || fail "Failed to parse download URL"
}

download_asset() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap "rm -rf '$tmpdir'" EXIT

  DOWNLOADED_PATH="${tmpdir}/${ASSET_NAME}"
  log "Downloading ${ASSET_NAME} from ${RELEASE_TAG}"
  curl -fL "$DOWNLOAD_URL" -o "$DOWNLOADED_PATH"
  chmod +x "$DOWNLOADED_PATH"
}

install_asset() {
  local target_dir target_real owner_cmd
  target_real="$(python3 - "$CLAUDE_PATH" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  target_dir="$(dirname "$target_real")"

  if [[ -w "$target_dir" && ( ! -e "$target_real" || -w "$target_real" ) ]]; then
    install -m 0755 "$DOWNLOADED_PATH" "$target_real"
  else
    require_cmd sudo
    sudo install -m 0755 "$DOWNLOADED_PATH" "$target_real"
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    if [[ -w "$target_real" ]]; then
      xattr -dr com.apple.quarantine "$target_real" 2>/dev/null || true
    else
      require_cmd sudo
      sudo xattr -dr com.apple.quarantine "$target_real" 2>/dev/null || true
    fi
  fi

  INSTALLED_PATH="$target_real"
}

verify_install() {
  log "Installed patched Claude to ${INSTALLED_PATH}"
  "${INSTALLED_PATH}" --version
}

main() {
  detect_platform
  find_existing_claude
  fetch_release_metadata
  download_asset
  install_asset
  verify_install
}

main "$@"

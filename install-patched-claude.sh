#!/usr/bin/env bash

set -euo pipefail

REPO_SLUG="${PATCH_CLAUDE_REPO:-a-connoisseur/patch-claude-code}"
API_BASE_URL="https://api.github.com/repos/${REPO_SLUG}"

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

detect_installed_version() {
  local version_output
  version_output="$("$CLAUDE_PATH" --version 2>/dev/null || true)"

  if [[ "$version_output" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    CLAUDE_VERSION="${BASH_REMATCH[1]}"
  else
    fail "Could not parse Claude version from: ${version_output:-<empty>}"
  fi
}

github_api_get() {
  local url="$1"
  local output_file="$2"

  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "User-Agent: patch-claude-code-installer" \
      "$url" \
      -o "$output_file"
  elif [[ -n "${GH_TOKEN:-}" ]]; then
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "Authorization: Bearer ${GH_TOKEN}" \
      -H "User-Agent: patch-claude-code-installer" \
      "$url" \
      -o "$output_file"
  else
    curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: patch-claude-code-installer" \
      "$url" \
      -o "$output_file"
  fi
}

fetch_release_metadata() {
  require_cmd curl
  require_cmd python3

  local release_json_file release_metadata release_api_url expected_tag
  release_json_file="$(mktemp)" || fail "Failed to create temporary file for release metadata"
  expected_tag="v${CLAUDE_VERSION}-${RELEASE_SUFFIX}"
  release_api_url="${API_BASE_URL}/releases/tags/${expected_tag}"

  github_api_get "$release_api_url" "$release_json_file" || {
    rm -f "$release_json_file"
    fail "Could not find a patched release for Claude ${CLAUDE_VERSION} on ${RELEASE_SUFFIX}"
  }

  if [[ ! -s "$release_json_file" ]]; then
    rm -f "$release_json_file"
    fail "Failed to fetch release metadata"
  fi

  release_metadata="$(
    python3 - "$ASSET_NAME" "$release_json_file" <<'PY'
import json
import sys

asset_name = sys.argv[1]
release_json_file = sys.argv[2]

with open(release_json_file, encoding="utf-8") as handle:
    release = json.load(handle)

if not isinstance(release, dict):
    raise SystemExit(1)

tag = release.get("tag_name", "")
if not tag:
    raise SystemExit(1)

for asset in release.get("assets", []):
    if asset.get("name") == asset_name:
        print(tag)
        print(asset["browser_download_url"])
        raise SystemExit(0)

raise SystemExit(1)
PY
  )" || {
    rm -f "$release_json_file"
    fail "Could not find the ${ASSET_NAME} asset in release ${expected_tag}"
  }

  rm -f "$release_json_file"
  RELEASE_METADATA="$release_metadata"

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
  detect_installed_version
  fetch_release_metadata
  download_asset
  install_asset
  verify_install
}

main "$@"

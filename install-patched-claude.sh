#!/usr/bin/env bash

set -euo pipefail

REPO_SLUG="${PATCH_CLAUDE_REPO:-a-connoisseur/patch-claude-code}"
RELEASE_BASE_URL="https://github.com/${REPO_SLUG}/releases/download"

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
    MINGW*|MSYS*|CYGWIN*)
      case "$arch" in
        x86_64|amd64)
          RELEASE_SUFFIX="win32-x64"
          ASSET_NAME="claude.native.windows.patched.exe"
          ;;
        aarch64|arm64)
          RELEASE_SUFFIX="win32-arm64"
          ASSET_NAME="claude.native.windows.patched.exe"
          ;;
        *)
          fail "Unsupported Windows architecture: ${arch}"
          ;;
      esac
      ;;
    *)
      fail "Unsupported operating system: ${os}"
      ;;
  esac
}

is_windows_shell() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      return 0
      ;;
    *)
      return 1
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

  local release_json_file release_metadata
  release_json_file="$(mktemp)" || fail "Failed to create temporary file for release metadata"
  if ! curl -fsSL "${RELEASE_BASE_URL}/patched-updates/${RELEASE_SUFFIX}.json" -o "$release_json_file"; then
    rm -f "$release_json_file"
    fail "Could not find a patched update feed for ${RELEASE_SUFFIX}"
  fi

  release_metadata="$(
    python3 - "$ASSET_NAME" "$RELEASE_SUFFIX" "$RELEASE_BASE_URL" "$release_json_file" <<'PYMETA'
import json
import re
import sys

asset_name, platform, release_base, filename = sys.argv[1:]
with open(filename, encoding="utf-8") as handle:
    release = json.load(handle)
version = release.get("version", "")
tag = release.get("tag", "")
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
    raise SystemExit("Invalid patched release version")
if not re.fullmatch(rf"v{re.escape(version)}-{re.escape(platform)}(?:-(?:[2-9]|[1-9][0-9]+))?", tag):
    raise SystemExit("Invalid patched release tag")
if (release.get("platform") != platform or release.get("assetName") != asset_name
        or release.get("url") != f"{release_base}/{tag}/{asset_name}"
        or not re.fullmatch(r"[a-f0-9]{64}", release.get("sha256", ""))
        or not isinstance(release.get("size"), int) or release["size"] <= 0):
    raise SystemExit("Invalid patched release metadata")
for key in ("tag", "url", "sha256", "size", "version"):
    print(release[key])
PYMETA
  )" || {
    rm -f "$release_json_file"
    fail "Invalid patched update feed for ${RELEASE_SUFFIX}"
  }
  rm -f "$release_json_file"
  RELEASE_TAG="$(printf '%s\n' "$release_metadata" | sed -n '1p')"
  DOWNLOAD_URL="$(printf '%s\n' "$release_metadata" | sed -n '2p')"
  EXPECTED_CHECKSUM="$(printf '%s\n' "$release_metadata" | sed -n '3p')"
  EXPECTED_SIZE="$(printf '%s\n' "$release_metadata" | sed -n '4p')"
  CLAUDE_VERSION="$(printf '%s\n' "$release_metadata" | sed -n '5p')"
}

download_asset() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap "rm -rf '$tmpdir'" EXIT

  DOWNLOADED_PATH="${tmpdir}/${ASSET_NAME}"
  log "Downloading ${ASSET_NAME} from ${RELEASE_TAG}"
  curl -fL "$DOWNLOAD_URL" -o "$DOWNLOADED_PATH"
  python3 - "$DOWNLOADED_PATH" "$EXPECTED_CHECKSUM" "$EXPECTED_SIZE" <<'PYVERIFY'
import hashlib
import os
import sys

filename, expected_checksum, expected_size = sys.argv[1:]
with open(filename, "rb") as handle:
    checksum = hashlib.file_digest(handle, "sha256").hexdigest() if hasattr(hashlib, "file_digest") else None
    if checksum is None:
        handle.seek(0)
        digest = hashlib.sha256()
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
        checksum = digest.hexdigest()
if os.path.getsize(filename) != int(expected_size) or checksum != expected_checksum:
    raise SystemExit("Patched download checksum mismatch; keeping the current installation")
PYVERIFY
  chmod +x "$DOWNLOADED_PATH"
  local version_output
  version_output="$("$DOWNLOADED_PATH" --version)"
  [[ "$version_output" == *"(patched)"* && "$version_output" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]] || fail "Downloaded binary is not patched Claude"
  [[ "${BASH_REMATCH[1]}" == "$CLAUDE_VERSION" ]] || fail "Downloaded binary has an unexpected version"
}

install_asset() {
  local target_dir target_real owner_cmd
  target_real="$(python3 - "$CLAUDE_PATH" <<'PY'
import os
import sys
target = os.path.realpath(sys.argv[1])
if os.name == "nt" and not os.path.exists(target) and os.path.exists(target + ".exe"):
    target += ".exe"
print(target)
PY
)"
  target_dir="$(dirname "$target_real")"

  if is_windows_shell && [[ ! -e "$target_real" && -e "${target_real}.exe" ]]; then
    target_real="${target_real}.exe"
    target_dir="$(dirname "$target_real")"
  fi

  if is_windows_shell; then
    if [[ -w "$target_dir" && ( ! -e "$target_real" || -w "$target_real" ) ]]; then
      cp "$DOWNLOADED_PATH" "$target_real"
    else
      fail "Target is not writable: ${target_real}. Re-run from an elevated shell or install manually."
    fi
    INSTALLED_PATH="$target_real"
    return
  fi

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

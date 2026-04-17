#!/usr/bin/env bash

set -euo pipefail

PLATFORM=""
VERSION=""
OUTPUT_PATH="work/claude.native.original"
MANIFEST_PATH="work/manifest.json"

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

write_github_output() {
  local key="$1"
  local value="$2"

  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
}

print_help() {
  cat <<'EOF'
Download the official Claude native binary exactly the way CI does.

Usage:
  bash scripts/download-native-from-installer.sh [options]

Options:
  --platform <linux-x64|linux-arm64|macos-arm64|darwin-arm64>
  --version <version>
  --output <path>
  --manifest-out <path>
  --help

Defaults:
  --platform     auto-detected from the current machine
  --version      latest version from Anthropic's installer bucket
  --output       work/claude.native.original
  --manifest-out work/manifest.json
EOF
}

normalize_platform() {
  local raw="$1"

  case "$raw" in
    linux-x64)
      printf 'linux-x64\n'
      ;;
    linux-arm64)
      printf 'linux-arm64\n'
      ;;
    macos-arm64|darwin-arm64)
      printf 'darwin-arm64\n'
      ;;
    "")
      detect_platform
      ;;
    *)
      fail "Unsupported platform: ${raw}"
      ;;
  esac
}

detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)
      case "$arch" in
        x86_64)
          printf 'linux-x64\n'
          ;;
        aarch64|arm64)
          printf 'linux-arm64\n'
          ;;
        *)
          fail "Unsupported Linux architecture: ${arch}"
          ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        arm64)
          printf 'darwin-arm64\n'
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

sha256_file() {
  local file_path="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{print $1}'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
    return
  fi

  fail "Missing checksum tool: expected sha256sum or shasum"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --platform)
        [[ $# -ge 2 ]] || fail "Missing value for --platform"
        PLATFORM="$2"
        shift 2
        ;;
      --version)
        [[ $# -ge 2 ]] || fail "Missing value for --version"
        VERSION="$2"
        shift 2
        ;;
      --output)
        [[ $# -ge 2 ]] || fail "Missing value for --output"
        OUTPUT_PATH="$2"
        shift 2
        ;;
      --manifest-out)
        [[ $# -ge 2 ]] || fail "Missing value for --manifest-out"
        MANIFEST_PATH="$2"
        shift 2
        ;;
      --help|-h)
        print_help
        exit 0
        ;;
      *)
        fail "Unknown option: $1"
        ;;
    esac
  done
}

extract_download_base_url() {
  local install_script="$1"

  INSTALL_SCRIPT="$install_script" python3 -c '
import os
import re

script = os.environ["INSTALL_SCRIPT"]
patterns = [
    r"^DOWNLOAD_BASE_URL=\"([^\"]+)\"$",
    r"^GCS_BUCKET=\"([^\"]+)\"$",
]

for pattern in patterns:
    match = re.search(pattern, script, re.MULTILINE)
    if match:
        print(match.group(1))
        raise SystemExit(0)

raise SystemExit("Could not determine download base URL from install script")
'
}

read_manifest_checksum() {
  local platform="$1"
  local manifest_path="$2"

  python3 - "$platform" "$manifest_path" <<'PY'
import json
import sys

platform = sys.argv[1]
manifest_path = sys.argv[2]

with open(manifest_path, encoding="utf-8") as handle:
    manifest = json.load(handle)

platform_data = manifest.get("platforms", {}).get(platform)
if not platform_data:
    raise SystemExit(f"Platform {platform} not found in manifest")

checksum = platform_data.get("checksum")
if not checksum:
    raise SystemExit(f"Checksum missing for platform {platform}")

print(checksum)
PY
}

main() {
  parse_args "$@"
  require_cmd curl
  require_cmd python3

  local platform install_script download_base_url expected_checksum actual_checksum
  platform="$(normalize_platform "$PLATFORM")"

  mkdir -p "$(dirname "$OUTPUT_PATH")"
  mkdir -p "$(dirname "$MANIFEST_PATH")"

  install_script="$(curl -fsSL https://claude.ai/install.sh)"
  download_base_url="$(extract_download_base_url "$install_script")"

  if [[ -z "$VERSION" ]]; then
    VERSION="$(curl -fsSL "$download_base_url/latest")"
  fi

  curl -fsSL "$download_base_url/$VERSION/manifest.json" -o "$MANIFEST_PATH"
  expected_checksum="$(read_manifest_checksum "$platform" "$MANIFEST_PATH")"

  curl -fsSL "$download_base_url/$VERSION/$platform/claude" -o "$OUTPUT_PATH"
  chmod +x "$OUTPUT_PATH"

  actual_checksum="$(sha256_file "$OUTPUT_PATH")"
  if [[ "$actual_checksum" != "$expected_checksum" ]]; then
    fail "Checksum verification failed for ${platform} ${VERSION}: expected ${expected_checksum}, got ${actual_checksum}"
  fi

  log "Downloaded Claude native ${VERSION} for ${platform} to ${OUTPUT_PATH}"

  write_github_output "path" "$OUTPUT_PATH"
  write_github_output "version" "$VERSION"
  write_github_output "platform" "$platform"
  write_github_output "checksum" "$actual_checksum"

  printf 'path=%s\n' "$OUTPUT_PATH"
  printf 'version=%s\n' "$VERSION"
  printf 'platform=%s\n' "$platform"
  printf 'checksum=%s\n' "$actual_checksum"
}

main "$@"

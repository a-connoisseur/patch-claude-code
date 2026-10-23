# Patch Claude Code

## What this does

This repo publishes patched native Claude binaries that make output more transparent without verbose mode.
Here is an exhaustive list of things it changes:

- Shows detailed tool calls instead of collapsed summaries.
- Hard disables spinner tips.
- Streams thinking live in the UI. This is helpful for instances where Claude thinks for over 10 minutes and you want to know if it's actually still doing something.
- Shows subagent `Prompt:` blocks in the non-verbose UI.
- Renames the startup header to `Connoisseur's Code v...`.
- Downloads automatic and manual updates from this repository's patched releases.

#### Thinking note:

- The patched binary requests summarized thinking automatically. You do not need to enable `showThinkingSummaries` in your Claude settings.

## Quick Start

### Prerequisite

If you installed Claude Code via npm, remove it and install the native build first:

```bash
npm uninstall -g @anthropic-ai/claude-code
curl -fsSL https://claude.ai/install.sh | bash
claude --version
```

### Automatic Install

This installer detects your OS and CPU architecture and downloads the latest patched release for your platform.
The installed Claude version does not need to match the patched release.
```bash
curl -fsSL https://raw.githubusercontent.com/a-connoisseur/patch-claude-code/main/install-patched-claude.sh | bash
```

On Windows, use PowerShell:
```powershell
irm https://raw.githubusercontent.com/a-connoisseur/patch-claude-code/main/install-patched-claude.ps1 | iex
```

After installation, automatic updates and `claude update` use this repository's patched releases.
Claude keeps the current patched build until a newer patched release is available.
The updater verifies each download's SHA-256 checksum and patched version marker before installation.
It never downloads an official unpatched binary as an update.

Both the `latest` and `stable` channels use the latest patched release for your platform.
Automatic updates retain Claude's existing schedule and respect `DISABLE_AUTOUPDATER` and `DISABLE_UPDATES`.
If you previously disabled automatic updates, remove that setting to enable them again.

Older patched binaries need one installer run to receive the new updater.

If you'd rather avoid blindly running scripts from the internet, you can do it the manual way below.
That said, the binaries are built on Github Actions and the patcher is also free for you to see and modify, so there's no reason to trust this repo or the release builds other than convenience.

### Manual Install (From Releases, native only)

1. Pick the release tag for your platform:
   - macOS arm64: `macos-arm64`
   - Linux x64: `linux-x64`
   - Linux arm64: `linux-arm64`
   - Windows x64: `win32-x64`
   - Windows arm64: `win32-arm64`

2. In that release, download the regular patched binary for your platform.

3. Follow the install instructions for your platform below.

### Install (Linux)

```bash
chmod +x ./claude.native.patched
target="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$(command -v claude)")"
sudo mv ./claude.native.patched "$target"
claude --version
```

### Install (macOS)

```bash
chmod +x ./claude.native.macos.patched
target="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$(command -v claude)")"
sudo mv ./claude.native.macos.patched "$target"
xattr -dr com.apple.quarantine "$target"
claude --version
```

The Linux and macOS commands retain the native launcher symlink so the updater can activate new versions.

### Install (Windows)

```powershell
$target = (Get-Command claude).Source
Copy-Item .\claude.native.windows.patched.exe $target -Force
claude --version
```

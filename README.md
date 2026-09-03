# Patch Claude Code

## What this does

This repo publishes patched native Claude binaries that make output more transparent without verbose mode.
Here is an exhaustive list of things it changes:

- Shows detailed tool calls instead of collapsed summaries.
- Hard disables spinner tips.
- Streams thinking live in the UI. This is helpful for instances where Claude thinks for over 10 minutes and you want to know if it's actually still doing something.
- Shows subagent `Prompt:` blocks in the non-verbose UI.
- Renames the startup header to `Connoisseur's Code v...` (this makes it easy to identify when Claude has auto updated and lost the patch).

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

This installer detects your OS and CPU architecture and downloads the matching patched release for that version and platform.
```bash
curl -fsSL https://raw.githubusercontent.com/a-connoisseur/patch-claude-code/main/install-patched-claude.sh | bash
```

On Windows, use PowerShell:
```powershell
irm https://raw.githubusercontent.com/a-connoisseur/patch-claude-code/main/install-patched-claude.ps1 | iex
```

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
sudo mv ./claude.native.patched "$(which claude)"
claude --version
```

### Install (macOS)

```bash
chmod +x ./claude.native.macos.patched
sudo mv ./claude.native.macos.patched "$(which claude)"
xattr -dr com.apple.quarantine "$(which claude)"
claude --version
```

### Install (Windows)

```powershell
$target = (Get-Command claude).Source
Copy-Item .\claude.native.windows.patched.exe $target -Force
claude --version
```

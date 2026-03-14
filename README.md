# Patch Claude Code

## What this does

This repo publishes patched native Claude binaries that make output more transparent without verbose mode.
Here is an exhaustive list of things it changes:

- Shows detailed tool calls instead of collapsed summaries.
- Hard disables spinner tips.
- Streams thinking live in the UI. This is helpful for instances where Claude thinks for over 10 minutes and you want to know if it's actually still doing something.
- Shows subagent `Prompt:` blocks in the non-verbose UI.
- Renames the startup header to `Connoisseur's Code v...` (this makes it easy to identify when Claude has auto updated and lost the patch).
- Appends `(patched)` to plain `claude --version` output.

#### Thinking note:

- If you want thinking to stream live in the UI without verbose mode, add this to your Claude settings:

```json
"showThinkingSummaries": true
```
- Settings can come from `~/.claude/settings.json`, `.claude/settings.json`, or `.claude/settings.local.json`.

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

### Manual Install (From Releases, native only)

1. Pick the release tag for your platform:
   - macOS arm64: `macos-arm64`
   - Linux x64: `linux-x64`
   - Linux arm64: `linux-arm64`

3. In that release, download the regular patched binary for your platform.

4. Follow the install instructions for your platform below.

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

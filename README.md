# Patch Claude Code

## What this does

This repo publishes patched native Claude binaries that make output more transparent without verbose mode:

- Shows detailed tool calls instead of collapsed summaries.
- Shows subagent `Prompt:` blocks by default.
- Renames the startup header to `Connoisseur's Code v...`.
- Appends `(patched)` to plain `claude --version` output.

Thinking note:

- If you want thinking to show up in the UI without verbose mode, add this to your Claude settings:

```json
{
  "showThinkingSummaries": true
}
```

- If you prefer the old behavior where thinking stays hidden unless you use verbose mode, leave this unset.
- Settings can come from `~/.claude/settings.json`, `.claude/settings.json`, or `.claude/settings.local.json`.

Releases are now built from native installer binaries and repacked with the [`tweakcc` API](https://www.npmjs.com/package/tweakcc#api).

## Quick Start

### Automatic Install

This installer:

- detects your OS and CPU architecture
- downloads the latest patched release for that platform
- replaces your existing `claude` binary
- clears macOS quarantine attributes when needed

```bash
curl -fsSL https://raw.githubusercontent.com/a-connoisseur/patch-claude-code/main/install-patched-claude.sh | bash
```

If `claude` is not already installed, the script stops and tells you to install the official native Claude binary first.

### Manual Install (From Releases, native only)

### Prerequisite

If you installed Claude Code via npm, remove it and install the native build first:

```bash
npm uninstall -g @anthropic-ai/claude-code
curl -fsSL https://claude.ai/install.sh | bash
claude --version
```

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

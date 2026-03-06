# Patch Claude Code

## What this does

This repo publishes patched native Claude binaries that make output more transparent without verbose mode:

- Shows detailed tool calls instead of collapsed summaries.
- Shows thinking inline and streams it in real time (unless you choose a `no-inline-thinking` asset).
- Shows subagent `Prompt:` blocks by default.
- Preserves syntax highlighting.

Releases are now built from native installer binaries and repacked with the [`tweakcc` API](https://www.npmjs.com/package/tweakcc#api).

## Quick Start (From Releases, native only)

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

3. In that release, download either the regular binary or the no thinking display variant.

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

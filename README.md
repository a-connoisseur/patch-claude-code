# Patch Claude Code

## What this does

This repo publishes patched Claude binaries that make output more transparent in normal mode:

- Shows detailed tool calls instead of collapsed summaries.
- Shows thinking inline (unless you choose a `no-inline-thinking` asset).
- Shows subagent `Prompt:` blocks by default.

## Quick Start (From Releases)

1. Download one asset from this repo's Releases page:
   - Native build (Linux): `claude.native.patched`
   - Native build (macOS): `claude.native.macos.patched`
   - npm install: `claude.patched`
2. If you do not want inline thinking, use the matching `no-inline-thinking` asset instead.
3. Follow the below instructions depending on your platform:

### Native build (Linux)

```bash
chmod +x ./claude.native.patched
sudo mv ./claude.native.patched "$(which claude)"
claude --version
```

### Native build (macOS)

```bash
chmod +x ./claude.native.macos.patched
sudo mv ./claude.native.macos.patched "$(which claude)"
claude --version
```

### NPM Install

```bash
chmod +x ./claude.patched
sudo mv claude.patched $(readlink -f $(which claude))
claude --version
```

# Patch Claude Code

## What this does

This repo publishes patched npm-native Claude binaries that make output more transparent in normal mode:

- Shows detailed tool calls instead of collapsed summaries.
- Shows thinking inline (unless you choose a `no-inline-thinking` asset).
- Shows subagent `Prompt:` blocks by default.
- Preserves native diff coloring via a `color-diff.node` sidecar.

## Quick Start (From Releases, npm-native only)

### Prerequisite

If you installed Claude Code via npm, remove it and install the native build first:

```bash
npm uninstall -g @anthropic-ai/claude-code
curl -fsSL https://claude.ai/install.sh | bash
claude --version
```

1. Pick one binary and its matching `.color-diff.node` file:
   - Linux regular: `claude.npm-native.patched` + `claude.npm-native.patched.color-diff.node`
   - Linux no-thinking: `claude.npm-native.no-thinking.patched` + `claude.npm-native.no-thinking.patched.color-diff.node`
   - macOS regular: `claude.npm-native.macos.patched` + `claude.npm-native.macos.patched.color-diff.node`
   - macOS no-thinking: `claude.npm-native.macos.no-thinking.patched` + `claude.npm-native.macos.no-thinking.patched.color-diff.node`
2. Move both files into your installed Claude path.

### Install (Linux)

```bash
chmod +x ./claude.npm-native.patched
sudo mv ./claude.npm-native.patched "$(which claude)"
sudo mv ./claude.npm-native.patched.color-diff.node "$(which claude).color-diff.node"
claude --version
```

### Install (macOS)

```bash
chmod +x ./claude.npm-native.macos.patched
sudo mv ./claude.npm-native.macos.patched "$(which claude)"
sudo mv ./claude.npm-native.macos.patched.color-diff.node "$(which claude).color-diff.node"
claude --version
```

If macOS blocks execution due to quarantine:

```bash
xattr -dr com.apple.quarantine "$(which claude)"
xattr -dr com.apple.quarantine "$(which claude).color-diff.node"
```

## Notes

- Keep the sidecar filename exactly as `$(which claude).color-diff.node`.
- If you prefer no inline thinking, use the matching `no-thinking` binary and sidecar pair.

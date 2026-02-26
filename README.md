# Patch Claude Code

This repo contains a patcher for Claude Code bundles (`cli.js` from npm) and native binaries (`claude` executable).

## What it patches

1. Show detailed tool calls without verbose mode.
2. Show thinking inline without verbose mode.
3. Stream thinking while it is generated.
4. Show subagent `Prompt:` blocks outside transcript mode.
5. Render create-file output as diff-style `+` lines.
6. Keep muted line backgrounds in word-diff mode.
7. Replace the npm/native migration warning text with `(patched)`.
8. Rewrite `#!/usr/bin/env node` to `#!/usr/bin/env bun` for npm JS targets.

## Target Behavior Matrix

- npm JS target (`cli.js`): all patches are available.
- Native binary target (`claude`): patcher uses size-preserving mode by default.
  - Applied: `tool-call-verbose`, `thinking-inline`, `subagent-prompt`, `installer-label`
  - Skipped (size-changing): `create-diff-colors`, `word-diff-line-bg`, `thinking-streaming`
  - Skipped: `shebang` (not applicable to binary targets)

Why: on native binaries, size-changing edits usually make the binary non-runnable even after re-signing.

## Usage

Patch local `./claude`:

```bash
node patch-claude-display.js --file ./claude
```

Patch and re-sign (macOS native binary):

```bash
node patch-claude-display.js --file ./claude --codesign
```

Dry run:

```bash
node patch-claude-display.js --file ./claude --dry-run
```

Patch npm bundle file:

```bash
node patch-claude-display.js --file /path/to/cli.js
```

Disable modules:

```bash
node patch-claude-display.js --file ./claude --disable thinking-inline
```

Restore backup:

```bash
node patch-claude-display.js --file ./claude --restore
```

List patch IDs:

```bash
node patch-claude-display.js --list-patches
```

The script creates a one-time backup at `<target>.display.backup`.

## Native Binary Notes

- Binary targets are patched with byte-preserving I/O.
- Size-preserving mode is automatic for binary targets.
- `--allow-size-change` exists, but on native binaries it is typically non-runnable.
- On macOS, use ad-hoc signing after patching:

```bash
codesign -f -s - /path/to/claude
```

The patcher can run this directly with `--codesign`.

## GitHub Actions

Workflow: `.github/workflows/patch-claude-from-npm.yml`

It currently:

1. Downloads `@anthropic-ai/claude-code` from npm and patches `cli.js`.
2. Downloads the native Linux build via `https://claude.ai/install.sh` and patches the native `claude` binary.
3. Produces both full and `--disable thinking-inline` variants for npm and native targets.
4. Publishes release assets with metadata, original files, and patched outputs.

Scheduled every 6 hours and runnable manually from Actions.

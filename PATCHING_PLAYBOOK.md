# Claude Display Patch Playbook

This playbook covers patching both Claude Code packaging styles:

1. npm JS bundle (`cli.js`)
2. native executable (`claude` binary)

## Fast Path

Patch target in place:

```bash
node patch-claude-display.js --file ./claude
```

Useful modes:

```bash
node patch-claude-display.js --file ./claude --dry-run
node patch-claude-display.js --file ./claude --restore
node patch-claude-display.js --list-patches
node patch-claude-display.js --file ./claude --disable thinking-inline
```

macOS native binary signing:

```bash
node patch-claude-display.js --file ./claude --codesign
```

or manually:

```bash
codesign -f -s - ./claude
```

## Patch Modules

- `shebang`: `#!/usr/bin/env node` -> `#!/usr/bin/env bun`
- `tool-call-verbose`: force verbose collapsed read/search output
- `create-diff-colors`: render create-file output through diff renderer
- `word-diff-line-bg`: keep muted `+`/`-` line backgrounds in word-diff mode
- `thinking-inline`: always render thinking blocks
- `thinking-streaming`: make streamed thinking update live
- `subagent-prompt`: show backgrounded agent `Prompt:` outside transcript mode
- `installer-label`: replace migration warning text with `(patched)`
- `ripgrep-bun-runtime` (opt-in): use system `rg` for Bun runtime ripgrep entrypoint
- `native-runtime` (opt-in): force Bun-built binaries onto native runtime code paths

## Target-Specific Behavior

### npm JS target

Default modules apply. Opt-in modules are skipped unless explicitly enabled:

```bash
node patch-claude-display.js --file ./claude.patched --enable native-runtime,ripgrep-bun-runtime
```

### Native binary target

The patcher auto-enables size-preserving mode:

- Applies:
  - `tool-call-verbose`
  - `thinking-inline`
  - `subagent-prompt`
  - `installer-label`
- Skips:
  - `shebang` (not applicable)
  - size-changing modules (`create-diff-colors`, `word-diff-line-bg`, `thinking-streaming`, `ripgrep-bun-runtime`, `native-runtime`)

Reason: size-changing edits usually produce a non-runnable native binary even after re-signing.

## Validation

List module outcomes:

```bash
node patch-claude-display.js --file ./claude --dry-run
```

Quick target checks:

```bash
file ./claude
./claude --version
```

For patched macOS binaries:

```bash
codesign --verify --verbose=2 ./claude
```

## CI/CD

Workflow: `.github/workflows/patch-claude-from-npm.yml`

Current pipeline:

1. Pull npm package and patch `cli.js` (full + no-inline variant).
2. Pull native Linux build via `https://claude.ai/install.sh` and patch binary (full + no-inline variant).
3. Pull native macOS build on `macos-latest`, patch binary, and ad-hoc sign outputs.
4. Publish release with originals + patched outputs + metadata.

## Troubleshooting

If a module stops matching after upstream updates:

1. Run dry-run and inspect candidate/patch counts.
2. Locate nearby anchors in the target with `rg -a`.
3. Update matcher logic in `patch-claude-display.js`.
4. Re-run dry-run before applying.

## Reuse Prompt

```text
Patch the current Claude target using PATCHING_PLAYBOOK.md, run verification, and report which modules were applied or skipped.
```

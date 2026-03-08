# Claude Display Patch Playbook

This playbook covers patching native Claude binaries and repacking them with the `tweakcc` API.

## Fast Path

Patch a native binary in place (recommended):

```bash
node scripts/patch-native-with-tweakcc.js --input ./claude
```

Create release variants:

```bash
node scripts/patch-native-with-tweakcc.js --input ./claude --output ./claude.native.patched
```

Useful modes:

```bash
node patch-claude-display.js --list-patches
node patch-claude-display.js --file ./content.js --dry-run
node patch-claude-display.js --file ./content.js --disable thinking-inline
```

macOS native binary signing:

```bash
codesign -f -s - ./claude.native.macos.patched
```

## Patch Modules

Default modules:

- `shebang`: `#!/usr/bin/env node` -> `#!/usr/bin/env bun`
- `tool-call-verbose`: force verbose collapsed read/search output
- `create-diff-colors`: render create-file output through diff renderer
- `word-diff-line-bg`: keep muted `+`/`-` line backgrounds in word-diff mode
- `thinking-inline`: always render thinking blocks
- `thinking-streaming`: make streamed thinking update live
- `subagent-prompt`: show backgrounded agent `Prompt:` outside transcript mode
- `version-output`: append `(patched)` to plain `claude --version` output
- `installer-label`: replace migration warning text with `(patched)`
- `welcome-badge`: rename the main startup header to `Connoisseur's Code v...`

Opt-in modules (kept for compatibility with legacy JS/Bun workflows):

- `ripgrep-bun-runtime`: use system `rg` for Bun runtime ripgrep entrypoint
- `native-color-diff-addon`: load `color-diff.node` sidecar in npm-native builds
- `native-runtime`: force Bun-built binaries onto native runtime code paths

Thinking visibility note:

- If you want thinking to show up in the UI without verbose mode, add this to Claude settings:

```json
{
  "showThinkingSummaries": true
}
```

- If you prefer the old behavior where thinking stays hidden unless you use verbose mode, leave this unset.
- Supported settings files include `~/.claude/settings.json`, `.claude/settings.json`, and `.claude/settings.local.json`.

## Target-Specific Behavior

### Native binary via tweakcc (recommended)

When using `scripts/patch-native-with-tweakcc.js`, the script:

1. reads embedded JS content from the native binary (`readContent`)
2. applies patch modules using `patch-claude-display.js`
3. writes patched JS back into the native binary (`writeContent`)

Because this patches extracted JS content (not raw binary bytes), size-changing edits are safe in this flow.

### Direct binary patch with `patch-claude-display.js` (legacy/manual)

If you run `patch-claude-display.js` directly on a native executable, it auto-enables size-preserving mode and skips size-changing modules unless `--allow-size-change` is passed.

## Validation

Quick checks:

```bash
file ./claude.native.patched
./claude.native.patched --version
```

For patched macOS binaries:

```bash
codesign --verify --verbose=2 ./claude.native.macos.patched
```

## CI/CD

Workflow: `.github/workflows/patch-claude-from-npm.yml`

Current pipeline:

1. Run a platform matrix for `linux-x64`, `linux-arm64`, and `macos-arm64`.
2. Download the platform-native installer build via `https://claude.ai/install.sh`.
3. Install `tweakcc` and patch native binaries via `scripts/patch-native-with-tweakcc.js`.
4. Build and publish one native artifact per platform release:
   - `<native_basename>.patched`
5. Publish platform tags:
   - `v<native_version>-linux-x64`
   - `v<native_version>-linux-arm64`
   - `v<native_version>-macos-arm64`

## Troubleshooting

If a module stops matching after upstream updates:

1. Run dry-run and inspect candidate/patch counts.
2. Locate nearby anchors in extracted content (`rg -n` or `grep -n`).
3. Update matcher logic in `patch-claude-display.js`.
4. Re-run dry-run before applying.

## Reuse Prompt

```text
Patch the current native Claude target with scripts/patch-native-with-tweakcc.js, run verification, and report which modules were applied or skipped.
```

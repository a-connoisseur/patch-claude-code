# Claude Native Patching Playbook

This repo only supports the native `tweakcc` workflow.

## Flow

1. Start from Anthropic's native Claude binary.
2. GitHub Actions runs `scripts/patch-native-with-tweakcc.ts`.
3. The script extracts embedded JS, patches it with `patch-claude-display.js`, and writes it back.
4. The workflow re-signs macOS binaries and publishes platform release artifacts.

## Commands

Patch in place:

```bash
node scripts/patch-native-with-tweakcc.ts --input ./claude
```

Write a separate artifact:

```bash
node scripts/patch-native-with-tweakcc.ts --input ./claude --output ./claude.patched
```

Dry-run the extracted JS only:

```bash
node patch-claude-display.js --file ./content.js --dry-run
```

List patch ids:

```bash
node patch-claude-display.js --list-patches
```

## Active Patch Modules

- `tool-call-verbose`
- `create-diff-colors`
- `word-diff-line-bg`
- `thinking-inline`
- `thinking-streaming`
- `subagent-prompt`
- `disable-spinner-tips`
- `version-output`
- `installer-label`
- `welcome-badge`

## Validation

- Run a dry-run on extracted content and inspect candidate counts.
- Patch a real native binary and confirm the patch summary still matches expectations.
- Verify `claude --version` still prints the upstream version plus `(patched)`.
- On macOS, run `codesign --verify --verbose=2 <binary>` after signing.
- Confirm the installer still resolves the correct GitHub release tag for the installed Claude version.

## Maintenance Rules

- Do not add back npm-package or Bun-rebuild workflows.
- Do not add patches that depend on minified local names.
- When upstream code shifts, patch the matcher conservatively and re-validate against the extracted bundle.

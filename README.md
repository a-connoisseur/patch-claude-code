# Patch Claude Code

This repo contains a patcher for Claude Code's bundled JS file (`claude` / `cli.js`).

## What it does
Patches Claude Code to:
  
1) Show tool calls (files read, patterns searched, so on) _without verbose mode_
2) Show thinking inline _without verbose mode_
3) Stream thinking while it is generated
4) Use `bun` instead of `node` by default (Claude Code doesn't work well with node for some people)

The patch script is included in case you want to do it yourself.

## How to use
1) Make sure `installMethod` is set to `npm` in `~/.claude.json`:
   ```json
   "installMethod": "npm",
   ```

2) Obtain `claude.patched` from [here](https://github.com/a-connoisseur/patch-claude-code/releases) _(or patch it yourself using the script in this repo)_ and put it in `PATH`:
   ```bash
   mv claude.patched `which claude`
   ```

## GitHub Actions

Manual workflow: `.github/workflows/patch-claude-from-npm.yml`

It:
- Downloads `@anthropic-ai/claude-code` from npm
- Extracts `cli.js`
- Applies the patch script
- Uploads artifact with original + patched files

In case a new version is out and the releases page of this repo has not been updated, you can fork it and run the action manually from the actions tab.


## How it works

`patch-claude-display.js` applies these changes:

1. Shebang rewrite:
   - `#!/usr/bin/env node` -> `#!/usr/bin/env bun`
2. Tool call visibility:
   - Forces `collapsed_read_search` groups to render with `verbose:!0`
   - Prevents collapsed summaries like "Read X files"
3. Thinking visibility:
   - Forces `isTranscriptMode:!0`
   - Forces `hideInTranscript:!1` when present
   - Removes early `case"thinking"` guard that returns `null`
4. Thinking streaming:
   - Wires `streamingThinking` into the main non-transcript renderer call by prop-shape matching
   - Uses a name-agnostic memo-cache rewrite so streaming keys track `?.thinking` text
   - Disables message-row memoization via comparator-shape matching (not symbol names)
   - Patches stream-event handling via stable event literals (`stream_request_start`, `thinking_delta`, `message_stop`)
   - Clears transient streamed-thinking state on `message_stop` (inline final thinking remains in message flow)
   - Removes the 30s post-stop linger window logic
5. Installer warning text:
   - Replaces the full npm/native-installer warning string with `"(patched)"`

## Usage

Patch local `./claude` automatically:

```bash
bun patch-claude-display.js
```

Patch a specific file:

```bash
bun patch-claude-display.js --file /path/to/cli.js
```

Dry run:

```bash
bun patch-claude-display.js --dry-run
```

Restore backup:

```bash
bun patch-claude-display.js --file /path/to/cli.js --restore
```

The script creates a backup at `<target>.display.backup`.

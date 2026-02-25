# Patch Claude Code

This repo contains a patcher for Claude Code's bundled JS file (`claude` / `cli.js`).

Releases include two patched binaries:
- `claude.patched` (all patches, including colored file diff patches)
- `claude.no-inline-thinking.patched` (all patches except inline thinking visibility)

## What it does
Patches Claude Code to:
  
1) Show tool calls (files read, patterns searched, so on) _without verbose mode_
2) Show thinking inline _without verbose mode_
3) Stream thinking while it is generated
4) Always show subagent `Prompt:` blocks (not only in transcript/Ctrl+O mode)
5) Show add-only write results using diff-style coloring (green `+` lines)
6) Use `bun` instead of `node` by default (Claude Code doesn't work well with node for some people)

The patch script is included in case you want to do it yourself.

## How to use
1) If you've obtained Claude Code via methods other than `npm`, [uninstall](https://code.claude.com/docs/en/setup#uninstall-claude-code) it.
2) Install Claude Code via npm: `sudo npm install -g @anthropic-ai/claude-code` (or any other preferred method)
3) Make sure `installMethod` is set to `npm` in `~/.claude.json`:
   ```json
   "installMethod": "npm",
   ```

4) Obtain `claude.patched` from [here](https://github.com/a-connoisseur/patch-claude-code/releases) _(or patch it yourself using the script in this repo)_ and put it in `PATH`:
   ```bash
   chmod a+x claude.patched
   sudo mv claude.patched $(readlink -f $(which claude))
   ```

   If you do not want inline thinking visibility, use `claude.no-inline-thinking.patched`.

## How can I trust this?
It takes Claude Code from npm, published by Anthropic, and runs a patch script on it which you can find in this repository. The release is created by Github Actions. You're also free to patch it yourself on your own machine.


## GitHub Actions

Manual workflow: `.github/workflows/patch-claude-from-npm.yml`

It:
- Downloads `@anthropic-ai/claude-code` from npm
- Extracts `cli.js`
- Applies the patch script in two module configurations (full/default and `--disable thinking-inline`)
- Uploads release assets with metadata + original + two patched files

Runs every 6 hours, but in case a new version is out and the releases page of this repo has not been updated, you can fork it and run the action yourself, manually, from the actions tab.


## How it works

`patch-claude-display.js` applies these changes:

1. Shebang rewrite:
   - `#!/usr/bin/env node` -> `#!/usr/bin/env bun`
2. Tool call visibility:
   - Forces `collapsed_read_search` groups to render with `verbose:!0`
   - Prevents collapsed summaries like "Read X files"
3. Created-file diff coloring:
   - Rewrites write-result `case"create"` rendering to use the same diff renderer as updates
   - Synthesizes a one-hunk `structuredPatch` with `+` lines for new file content
   - Forces muted add/remove line backgrounds in word-diff mode so unchanged parts of `+`/`-` lines stay tinted
4. Thinking visibility:
   - Forces `isTranscriptMode:!0`
   - Forces `hideInTranscript:!1` when present
   - Removes early `case"thinking"` guard that returns `null`
5. Thinking streaming:
   - Wires `streamingThinking` into the main non-transcript renderer call by prop-shape matching
   - Uses a name-agnostic memo-cache rewrite so streaming keys track `?.thinking` text
   - Disables message-row memoization via comparator-shape matching (not symbol names)
   - Patches stream-event handling via stable event literals (`stream_request_start`, `thinking_delta`, `message_stop`)
   - Clears transient streamed-thinking state on `message_stop` (inline final thinking remains in message flow)
   - Removes the 30s post-stop linger window logic
6. Subagent prompt visibility:
   - Finds the subagent renderer by stable UI literals (`"Backgrounded agent"`, `fallback:"ctrl+o"`, `action:"app:toggleTranscript"`)
   - Removes only the `isTranscriptMode` gate from `prompt` blocks, so `Prompt:` is shown in default mode too
7. Installer warning text:
   - Replaces the full npm/native-installer warning string with `"(patched)"`

## Usage

Patch local `./claude` automatically:

```bash
node patch-claude-display.js
```

Patch a specific file:

```bash
node patch-claude-display.js --file /path/to/cli.js
```

Dry run:

```bash
node patch-claude-display.js --dry-run
```

List available patch module IDs:

```bash
node patch-claude-display.js --list-patches
```

Disable inline thinking visibility only:

```bash
node patch-claude-display.js --disable thinking-inline
```

Restore backup:

```bash
node patch-claude-display.js --file /path/to/cli.js --restore
```

The script creates a backup at `<target>.display.backup`.

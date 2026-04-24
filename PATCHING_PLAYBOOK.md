# Claude Native Patching Playbook

This file is for maintainers, not end users.

Its job is to explain:

- what the native patching pipeline actually does
- how `patch-claude-display.ts` is structured
- what each patch is trying to change semantically
- what old upstream bundle shapes we currently depend on
- how to debug and repair a patch when a Claude update breaks it

## Repo Mental Model

This repo does not rebuild Claude Code from source. It patches the embedded JS bundle inside Anthropic's native binary.

The current flow is:

1. Download or locate a native Claude binary.
   Use `bash scripts/download-native-from-installer.sh` when you want the exact upstream native download path used by CI.
2. Use `tweakcc.readContent()` to extract the embedded JS bundle.
3. Write that bundle to a temporary `content.js` file.
4. Run `patch-claude-display.ts` against that extracted JS.
5. Use `tweakcc.writeContent()` to write the patched JS back into the binary.
6. Re-sign on macOS.
7. Publish the patched binary.

The important consequence: almost all real behavior lives in `patch-claude-display.ts`. If a release regresses, that file is usually where the fix belongs.

## Important Files

- `patch-claude-display.ts`: ordered patch pipeline for extracted bundle text
- `scripts/download-native-from-installer.sh`: exact upstream binary download flow via Anthropic's installer bucket
- `scripts/patch-native-with-tweakcc.ts`: native binary read/write flow via `tweakcc`
- `.github/workflows/patch-claude-from-npm.yml`: CI download, patch, sign, release path
- `install-patched-claude.sh`: installer that resolves release tags and downloads patched assets

## How The Patcher Is Structured

`patch-claude-display.ts` is a string-rewrite pipeline.

- Every patch function takes bundle text and returns `{ content, candidates, patched }`.
- `PATCH_MODULES` defines the patch order.
- Patches run sequentially, so later patches see earlier rewrites.
- The patcher prints a per-module summary but does not fail if nothing changed.
- `main()` writes the file only when the final content differs from the original.

That last point matters: `No changes needed.` is a successful exit, not a failure.

## Matcher Design Rules

These rules are not style preferences. They are what keeps the patcher alive across upstream rebuilds.

- Never anchor on minified locals like `A_`, `mET`, `w`, `wg6`, or similar.
- Prefer stable string literals, switch case labels, prop names, control-flow shape, or unique neighboring tokens.
- If you have to match a function body, match the semantic shape of that body, not its symbol names.
- Only widen a matcher as much as needed to survive bundle churn.
- When a patch has multiple known upstream shapes, keep them as separate targeted branches instead of one giant regex.

## Native Patching Flow

`scripts/patch-native-with-tweakcc.ts` currently works like this:

- resolves `--input` and `--output`
- copies the input binary to the output path when patching out-of-place
- loads `tweakcc`
- extracts embedded JS with `readContent()`
- if `tweakcc` fails on an ELF binary, falls back to `scripts/vendored-elf-native.ts`
- writes that JS to a temp `content.js`
- invokes `node patch-claude-display.ts --file <temp-content.js>`
- reads the patched temp file back
- writes it into the output binary with `writeContent()`
- if `tweakcc` fails to repack an ELF binary, falls back to `scripts/vendored-elf-native.ts`

Important behavior:

- if `patch-claude-display.ts` prints nonzero patch counts, the binary written by `writeContent()` is patched
- if `patch-claude-display.ts` makes no changes, the script still succeeds and the output binary can remain equivalent to upstream

Linux note:

- Claude native Linux builds changed format around 2.1.83 from the older Bun-at-EOF overlay layout to an ELF `.bun` section layout.
- `tweakcc` 4.0.11 only handles the older ELF overlay path.
- `scripts/vendored-elf-native.ts` exists specifically to keep latest Linux binaries patchable without waiting on upstream `tweakcc`.
- For section-backed ELF binaries, `.bun` sits right before the ELF section-header table. Growing `.bun` content must move `e_shoff` forward and grow the containing `LOAD` segment; updating the section bytes alone overwrites section headers, detaches `.bun` from the segment table, and can produce runtime crashes on Linux x64.

## Current Patch Inventory

Use this section when a future Claude update breaks something. For each patch, the key questions are:

- what user-visible behavior were we changing?
- what old bundle shape did we match?
- what likely changed upstream?

### `tool-call-verbose`

Intent:

- force collapsed read/search tool rows to render in verbose mode

Old bundle shape we match:

- a switch arm with `case"collapsed_read_search"`
- one build shape returns directly from the case
- another build shape uses a block form `case"collapsed_read_search":{ ... }`
- both forms contain a React `createElement(...)` call with a `verbose:` prop

What we rewrite:

- replace the existing `verbose:<expr>` with `verbose:!0`

Why this exists:

- some builds collapse read/search detail even when we want the default UI to expose tool-call data

Likely break signs:

- patch count drops to `0`
- read/search tool blocks render in compact mode again
- upstream renamed the case label or changed the props carried by that renderer

### `create-diff-colors`

Intent:

- render file creation output through the diff renderer so added lines keep `+` styling and color

Old bundle shape we match:

- one switch arm for `case"create":`
- a nearby switch arm for `case"update":`
- the `create` arm returns a simple write renderer with `{filePath,content,verbose}`
- the `update` arm renders a richer diff component using `structuredPatch`

What we rewrite:

- replace the `create` return path with a synthetic diff payload
- build a one-sided `structuredPatch` where every line is prefixed with `+`
- reuse the update renderer's `style` and component

Why this exists:

- plain "Wrote N lines" rendering throws away the visual diff treatment for newly created files

Likely break signs:

- created files lose green diff presentation
- patch count drops to `0`
- `create` and `update` are no longer in the same switch or the update renderer no longer exposes `structuredPatch`

### `word-diff-line-bg`

Intent:

- preserve muted add/remove row backgrounds during word-diff rendering

Old bundle shape we match:

- function body anchored near `"diffAddedWord";else if(!`
- child parts render with `backgroundColor:<expr>`
- the function also knows the diff `type` and a dimming flag parameter

What we rewrite:

- change child `backgroundColor` to use a nullish fallback
- if upstream did not provide a per-word color, fall back to line-level add/remove dimmed colors

Why this exists:

- word-diff spans could visually erase the line background, making additions/removals harder to read

Likely break signs:

- word-diff mode loses the surrounding row tint
- anchor string still exists but the child style shape changed

### `thinking-inline`

Intent:

- always render thinking blocks inline instead of hiding them behind transcript-only gates

Old bundle shape we match:

- switch arm `case"thinking":`
- an early return like `if(!... )return null;`
- renderer props containing `isTranscriptMode:` and `hideInTranscript:`

What we rewrite:

- remove the early null-return gate
- force `isTranscriptMode:!0`
- force `hideInTranscript:!1`

Why this exists:

- upstream often treats thinking content as transcript-only or conditionally hidden when we want it visible in the live UI

Likely break signs:

- thinking blocks disappear from the main message flow
- only final output appears while reasoning remains hidden

### `thinking-streaming`

Intent:

- repair live streaming thinking so it updates during generation and clears correctly between turns

This patch is intentionally broad because upstream has broken this in several different places.

Sub-fixes currently bundled here:

- memo cache fix: comparator cache should key on `thinking?.thinking`, not just the outer object
- prop threading fix: add missing `streamingThinking:` prop to the main renderer when the surrounding prop bag clearly represents the conversation view
- memo removal: disable one memo wrapper around the message-row renderer when its comparator shape references screen/columns/lastThinkingBlockId/streamingToolUseIDs and suppresses updates
- linger fix: replace the "remain visible for 30 seconds after stream end" path with `isStreaming` only
- inline extras fix: materialize `streamingThinking.messages` in the transcript extras list, ordered alongside streaming tool-use blocks by content-block index
- bottom-row suppressor: remove the separate live-thinking row that sits outside the main message flow so streaming thinking only renders inline once
- reducer/event fix: update the stream event handler so `stream_request_start`, `thinking`, `thinking_delta`, `text`, `message_delta`, and `message_stop` keep per-block streaming thinking state in sync without relying on footer-row rendering

Old bundle shapes we match:

- memoized renderer logic near `hidePastThinking:!0,streamingThinking:<var>`
- a comparator function body checking `.screen!==`, `.columns!==`, `.lastThinkingBlockId`, `.streamingToolUseIDs`
- event handling logic near `type!=="stream_event"&&`, `type==="stream_request_start"`, and `case"thinking_delta"`
- older reducers called a helper inside `case"thinking_delta":<helper>(event.delta.thinking);return;`
- 2.1.116-style reducers can also use a bare `case"thinking_delta":return;`, which means the live thinking state patch must no longer rely on that helper call existing
- current main-screen renderer shapes can carry `placeholderElement:` and `streamingText:` but omit `showThinkingHint:`, so the prop-threading matcher must not depend on that prop being present before injecting `streamingThinking:`
- the duplicate live-thinking suppressor should match the semantic row shape around `param:{type:"thinking",thinking:<var>.thinking}` and the surrounding `marginTop:1` wrapper, not a specific wrapper component identifier

Why this exists:

- upstream breakage here has shown up as stale thinking, no live thinking, delayed thinking, or thinking that only appears after completion

Likely break signs:

- thinking only appears after the assistant finishes
- previous turn's thinking leaks into the next turn
- live thinking vanishes in brief mode
- live streaming shows two thinking blocks at once
- live thinking pins itself to the bottom of the transcript instead of staying above the later streamed text/tool blocks
- patch count drops partially rather than fully; this often means only one of the sub-fixes drifted

### `subagent-prompt`

Intent:

- show subagent `Prompt` blocks even outside transcript mode

Old bundle shape we match:

- renderer neighborhood anchored by `"Backgrounded agent"`
- same function also contains transcript toggle metadata like `action:"app:toggleTranscript"` and `fallback:"ctrl+o"`
- live prompt mount path shaped like `<transcriptModeVar> && <promptVar> && createElement(...)`
- empty-state guard shaped like `if(rows.length===0 && !(transcriptMode && prompt)) return`

What we rewrite:

- remove the transcript-mode dependency from the prompt gate
- keep the prompt block mounted whenever prompt text exists
- treat prompt presence as content so the section does not early-return empty

Why this exists:

- upstream hides the prompt block unless transcript mode is active, which hides useful subagent context during normal use

Likely break signs:

- subagent cards show status but no prompt content
- prompt appears only after toggling transcript mode

### `disable-spinner-tips`

Intent:

- disable spinner tips regardless of user settings

Old bundle shape we match:

- a guard like `if(settings().spinnerTipsEnabled===!1)return;`
- a separate boolean expression like `spinnerTipsEnabled!==!1`

What we rewrite:

- force the guard to `if(!0)return;`
- force the enablement expression to `!1`

Why this exists:

- spinner tips are noise in the patched UX, and upstream has had multiple paths that can re-enable them

Likely break signs:

- tips start showing again during idle/loading states
- only one candidate is found instead of two, meaning one code path moved

### `version-output`

Intent:

- append a visible patched marker to plain `claude --version` output

Old bundle shape we match:

- a literal tail shaped like ``}.VERSION} (Claude Code)`);return}``

What we rewrite:

- inject `\n(patched)` before the return

Why this exists:

- this is the easiest runtime verification that the installed binary is actually patched

Likely break signs:

- `claude --version` loses the `(patched)` line
- CI still succeeds, so this must be checked deliberately

### `installer-label`

Intent:

- replace the npm/native migration warning text with a short patched marker

Old bundle shape we match:

- string payload containing `switched from npm to native installer`

What we rewrite:

- replace the entire quoted string payload with `(patched)`

Why this exists:

- the upstream migration message is not useful in this patched distribution and consumes valuable space

Likely break signs:

- upstream rewrites the migration copy and the needle vanishes
- patch count drops to `0`

### `welcome-badge`

Intent:

- rename visible startup/help branding from `Claude Code` to `Connoisseur's Code`

Old bundle shapes we match:

- bold text node rendering `"Claude Code"`
- help/settings title template like ``title:(`Claude Code v${...VERSION}`),color:"professionalBlue",defaultTab:"general"``
- welcome copy `"Welcome to Claude Code for "`
- styled title helpers shaped like `<colorFn>("claude",<themeVar>)("Claude Code")`
- same helper with padded text `(" Claude Code ")`

What we rewrite:

- replace those visible strings with `Connoisseur's Code`

Why this exists:

- branding is the visible cue that the patched build is installed

Likely break signs:

- some screens show patched branding while others revert to upstream naming
- candidate counts change unevenly because only some string shapes moved

## Updating A Broken Patch

When a Claude update breaks a patch, do this in order.

1. Patch extracted JS in dry-run mode first.

```bash
node patch-claude-display.ts --file ./content.js --dry-run
```

2. Note which module dropped from its usual nonzero count to `0`, or which module now has fewer hits than expected.

3. Search the extracted bundle for the old semantic anchors, not the old minified names.

Examples:

```bash
rg 'case"collapsed_read_search"|case"thinking"|case"thinking_delta"|spinnerTipsEnabled|Backgrounded agent|Claude Code' content.js
```

4. If the old anchor is gone, search for the user-visible string or prop names that still describe the same feature.

5. Update the matcher conservatively. Prefer adding a second shape branch over weakening the original regex until it matches too much.

6. Re-run dry-run and inspect both `candidates` and `patched` counts.

7. Patch a real native binary and verify behavior at runtime.

## Validation Checklist

Minimum validation for patch work:

- run dry-run patching on extracted content
- patch a real native binary
- run the patched binary with `--version` and verify `(patched)` appears
- manually inspect the UI areas touched by the patch
- on macOS, verify the final binary after re-signing

Useful commands:

```bash
node scripts/patch-native-with-tweakcc.ts --input ./claude --output ./claude.patched
./claude.patched --version
codesign --verify --verbose=2 ./claude.patched
```

If you only changed the JS matcher and want fast feedback:

```bash
node patch-claude-display.ts --file ./content.js --list-patches
node patch-claude-display.ts --file ./content.js --dry-run
```

## CI Caveat

Current CI behavior is not a proof that patching happened.

- the workflow uploads `work/${OUT_BASE}.patched`
- that file path is created by copying the original binary first
- if the patcher makes no changes, the job can still succeed
- runtime `--version` output is printed, but the workflow does not currently assert on `(patched)`

So when investigating release correctness, treat these as strong signals, in order:

1. nonzero patch counts for the expected modules
2. runtime `--version` output including `(patched)`
3. different checksums between original and patched binaries

## Maintenance Notes

- Keep this file updated when a patch's semantic target changes.
- If you add a new patch, document the old bundle shape and the user-visible intent here immediately.
- If you split a patch into multiple sub-fixes, say so here; future debugging depends on knowing which symptom each sub-fix addressed.
- Do not turn this back into a user-facing release guide. It exists to preserve maintainer context that is otherwise trapped inside minified bundle archaeology.

# Claude Native Patching Playbook

This file is for maintainers, not end users.

Its job is to explain:

- what the native patching pipeline actually does
- how `patch-claude-display.ts` is structured
- what each patch is trying to change semantically
- what old upstream bundle shapes we currently depend on
- how to debug and repair a patch when a Claude update breaks it

## Repo Mental Model

This repo does not rebuild Claude Code from source. It patches the embedded JavaScript modules inside Anthropic's native binary.

The current flow is:

1. Download or locate a native Claude binary.
   Use `bash scripts/download-native-from-installer.sh` when you want the exact upstream native download path used by CI.
2. Use `scripts/native-bun.ts` to read the embedded Bun module table.
3. Select every embedded JavaScript module, including the CLI entry module and split chunks.
4. Run `patch-claude-display.ts` across those modules and aggregate the patch counts.
5. Use `scripts/native-bun.ts` to rebuild the module table with the changed module contents replaced and their stale Bun bytecode removed.
6. Re-sign on macOS.
7. Publish the patched binary.

The important consequence: almost all real behavior lives in `patch-claude-display.ts`. If a release regresses, that file is usually where the fix belongs.

## Important Files

- `patch-claude-display.ts`: ordered patch pipeline for extracted bundle text
- `scripts/download-native-from-installer.sh`: exact upstream binary download flow via Anthropic's installer bucket
- `scripts/patch-native.ts`: native patch orchestration
- `scripts/native-bun.ts`: Bun module extraction and native binary rewriting via `node-lief`
- `.github/workflows/patch-claude.yml`: CI download, patch, sign, release path
- `install-patched-claude.sh`: installer that resolves release tags and downloads patched assets
- `install-patched-claude.ps1`: Windows installer that resolves release tags and downloads patched assets

## How The Patcher Is Structured

`patch-claude-display.ts` is a string-rewrite pipeline.

- Every patch function takes bundle text and returns `{ content, candidates, patched }`.
- `PATCH_MODULES` defines the patch order.
- Patches run sequentially, so later patches see earlier rewrites.
- `patchContents()` applies that ordered pipeline to one or more module contents and aggregates the counts.
- The native patch flow requires every supported patch to match unless it was explicitly disabled.
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

`scripts/patch-native.ts` currently works like this:

- resolves `--input` and `--output`
- copies the input binary to the output path when patching out-of-place
- loads `scripts/native-bun.ts`
- reads the embedded Bun modules from Mach-O, ELF, or PE binaries
- applies the display patch pipeline to every JavaScript module in memory
- aggregates one patch summary across all modules
- writes only changed module contents into reclaimed source or bytecode storage in the output binary

Important behavior:

- a nonzero source patch count is not sufficient by itself: Bun can execute a module's embedded bytecode instead of its source
- when a module's source changes, the writer removes its bytecode and bytecode origin path so Bun recompiles the patched source
- the writer preserves the rest of the Bun payload at its original offsets; 2.1.250 includes runtime data that is not referenced by the module table, so compacting only the known module ranges produces a startup crash
- if changed source outgrows its original source range, the writer allocates it from bytecode storage freed by any changed module
- if a required patch matches nothing, the script fails before copying or rewriting the output binary
- 2.1.233 names the entry module `/$bunfs/root/cli` on macOS/Linux and `B:/~BUN/root/cli` on Windows, so entry detection recognizes the stable `/root/cli` suffix in addition to older Claude entry names
- 2.1.245 splits the application across more than a thousand `chunk-*.js` modules. Its `/root/cli` entry is only a small loader, so entry-module-only extraction produces misleading zero counts for UI patches.
- `--dry-run` reads and patches all JavaScript modules in memory without copying or rewriting the binary.

Linux note:

- Claude native Linux builds changed format around 2.1.83 from the older Bun-at-EOF overlay layout to an ELF `.bun` section layout.
- `scripts/native-bun.ts` supports both older Bun-at-EOF overlays and newer `.bun` sections.
- For section-backed ELF binaries, `.bun` sits right before the ELF section-header table. Growing `.bun` content must move `e_shoff` forward and grow the containing `LOAD` segment; updating the section bytes alone overwrites section headers, detaches `.bun` from the segment table, and can produce runtime crashes on Linux x64.
- Some Linux builds also keep non-allocated metadata sections such as `.comment`, `.note.stapsdt`, `.symtab`, `.strtab`, and `.shstrtab` after `.bun`. The ELF writer may shift those payloads and update their section-header offsets when `.bun` grows. It should still refuse to shift later allocated sections, because that can change runtime mapping semantics.

Windows note:

- Windows native builds are PE binaries with a `.bun` section.
- Windows support uses the `.bun` PE section through `scripts/native-bun.ts`.
- CI can execute Windows x64 builds on `windows-latest` and Windows arm64 builds on `windows-11-arm`.

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
- both forms contain a React renderer call with a `verbose:` prop
- older builds use `createElement(...)`; 2.1.186-style builds use JSX-runtime calls like `.jsx(...)` or `.jsxs(...)`
- 2.1.245-style split chunks can import the JSX factory directly and call it as a bare identifier

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
- 2.1.186-style builds can use JSX-runtime calls like `.jsx(...)` and `.jsxs(...)` instead of `createElement(...)`
- 2.1.245-style split chunks can call the imported JSX factory as a bare identifier

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
- older builds put `key:` before `backgroundColor:` in a `createElement(...)` props object
- 2.1.186-style builds put the key after the props object in a JSX-runtime call, so match by the `backgroundColor:` and `part-${...}-${...}` shape instead of assuming prop order

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
- renderer props containing `isTranscriptMode:`
- older builds also carry `hideInTranscript:`, but newer builds can omit it
- renderer calls can be either `createElement(...)` or JSX-runtime `.jsx(...)` / `.jsxs(...)`
- 2.1.245-style renderer calls can use a bare imported JSX factory, and the early null return can use a block body

What we rewrite:

- remove the early null-return gate
- force `isTranscriptMode:!0`
- force `hideInTranscript:!1` when that prop exists

Why this exists:

- upstream often treats thinking content as transcript-only or conditionally hidden when we want it visible in the live UI

Likely break signs:

- thinking blocks disappear from the main message flow
- only final output appears while reasoning remains hidden

### `redacted-thinking-inline`

Intent:

- render redacted thinking summaries inline using the same renderer as normal thinking blocks

Old bundle shapes we match:

- adjacent switch arms for `case"redacted_thinking":` and `case"thinking":`
- the redacted arm returns a placeholder/summary component
- the thinking arm renders a component with `addMargin:`, `param:`, `isTranscriptMode:`, and `verbose:`
- older builds use `createElement(...)` and carry `hideInTranscript:`
- 2.1.186-style builds use `.jsx(...)` and can omit `hideInTranscript:`
- 2.1.245-style split chunks use a bare imported JSX factory for both adjacent arms

What we rewrite:

- replace the redacted arm with a thinking-renderer call
- synthesize a `{type:"thinking",thinking:<redacted data>}` param
- force transcript/verbose visibility, and force `hideInTranscript:!1` only when upstream still has that prop

Why this exists:

- redacted thinking summaries otherwise stay hidden or render as a generic placeholder

Likely break signs:

- redacted summaries disappear while normal thinking still appears
- `redacted-thinking-inline` candidate count drops to `0`
- the redacted and thinking switch arms are no longer adjacent

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
- duplicate-index fix: keep only one virtual streaming-thinking message per content-block index so repeated block-start handling cannot create two live blocks that receive the same later deltas
- request display fix: default eligible thinking requests to `display: "summarized"` so the API sends displayable text for the live renderer

Old bundle shapes we match:

- memoized renderer logic near `hidePastThinking:!0,streamingThinking:<var>`
- a comparator function body checking `.screen!==`, `.columns!==`, `.lastThinkingBlockId`, `.streamingToolUseIDs`
- event handling logic near `type!=="stream_event"&&`, `type==="stream_request_start"`, and `case"thinking_delta"`
- older reducers called a helper inside `case"thinking_delta":<helper>(event.delta.thinking);return;`
- 2.1.116-style reducers can also use a bare `case"thinking_delta":return;`, which means the live thinking state patch must no longer rely on that helper call existing
- 2.1.138-style UI reducers can be `function <name>(event, opts){let{onSetStreamMode, onStreamingToolUses, onStreamingThinking, ...}=opts;...}` and should be patched by those option names, not by a nearby `type!=="stream_event"` filter
- 2.1.144-style UI reducers can keep `thinking_delta` inside `case"content_block_delta":switch(event.delta.type){...}` with a non-empty progress body like `let{delta}=event.event;if("estimated_tokens"in delta)...;return`, so the live thinking patch must inject state updates ahead of that existing progress handler instead of assuming an empty `thinking_delta` case
- 2.1.163-style UI reducers can keep `thinking_delta` in the same `case"content_block_delta"` switch but expand the body to emit both estimated-token progress and text-length progress from `event.delta.thinking`, so the live thinking patch must preserve both branches while still appending the streamed text into `streamingThinking`
- current main-screen renderer shapes can carry `placeholderElement:` and `streamingText:` but omit `showThinkingHint:`, so the prop-threading matcher must not depend on that prop being present before injecting `streamingThinking:`
- 2.1.168-style transcript renderers can drop `hidePastThinking:` and `streamingThinking:` from the renderer signature entirely while the top-level app still has an `onStreamingThinking:<setter>` callback backed by nearby `useState(null)`. In that shape, rediscover the state variable from the setter and re-inject `streamingThinking:` into both the transcript renderer call sites and the transcript renderer destructuring signature.
- 2.1.168-style UI reducers can run `displayTransform?.finalize()` inside the `message_stop` branch before switching to `"tool-use"`, and can use a block-form `case"message_delta":{...}`. The reducer patch must preserve those existing side effects while adding streaming-thinking cleanup before the stream transitions to normal response state.
- 2.1.183-style UI reducers can keep `onStreamingThinking:<setter>` on the outer event dispatcher while moving the stream-event switch into a separate inner handler that destructures `onSetStreamMode`, `onStreamingToolUses`, `onStreamingText`, and `displayTransform`, but not `onStreamingThinking`. In that shape, inject `onStreamingThinking` into the inner handler destructuring, then patch `stream_request_start`, thinking/redacted-thinking block start, `thinking_delta`, text/message transitions, and `message_stop` there.
- 2.1.199-style live thinking can still use the same `onStreamingThinking` state but may surface duplicate virtual entries if a thinking content-block start is handled more than once for the same index. Treat `streamingThinking.messages` as keyed by content-block index, not append-only.
- 2.1.227-style UI reducers can continue the options-destructuring `let` statement with an `authoringProgressSurface` local instead of ending it with a semicolon. Their `message_stop` branch also conditionally resets authoring progress after finalizing display state, so preserve that side effect while injecting streaming-thinking cleanup.
- 2.1.233-style main renderer calls can omit `showAllInTranscript:` between `streamingToolUses:` and `agentDefinitions:`. Prop threading must still inject `streamingThinking:` into that call; reducer matches alone can remain nonzero while live thinking stays invisible.
- 2.1.237-style REPLs keep `streamingThinking` in a stream-store snapshot and destructure only `streamingToolUses` and `userInputOnProcessing`. Inject the thinking snapshot into that destructuring and thread it through renderer calls that no longer carry `agentDefinitions`; the separate transcript wrapper must receive the prop too, and its compiled renderer-element cache must not hide updates. Otherwise the reducer updates state but no inline renderer observes it.
- 2.1.245-style split chunks move the stream store, event reducer, and transcript renderer into separate modules. The transcript wrapper selects `streamingToolUses` from `turn.stream`; select `streamingThinking` through the same path, thread it into the renderer, and allow a bare imported memo hook when building inline extras. The reducer can rediscover the virtual assistant-message constructor from its semantic `{content,isVirtual,uuid}` signature before adding thinking event updates.
- 2.1.250-style transcript wrappers select streaming tool uses from a focused-turn expression such as `(isMain?turn:null)?.stream`, and their renderer signature can put `isLoading:` directly after `streamingToolUses:`. Match that conditional stream expression, invalidate the compiled renderer-element cache, and merge thinking messages into the newer deduplicated tool-use extras pipeline.
- 2.1.257-style transcript renderers destructure props inside the function and compiler-cache the deduplicated tool-use extras behind nested cache conditions. Detect the local `streamingThinking:` destructuring, merge thinking messages into the indexed extras list, and invalidate the outer cache that owns that list rather than the inner cache that owns only the tool-use callback.
- 2.1.257-and-later request builders can calculate a separate display-eligibility variable between the thinking-enabled check and the final `thinking.display` lookup. Match that intermediate assignment and default the display value there; other streaming sub-fixes can keep the aggregate patch count nonzero while requests omit displayable thinking.
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
- patch count still looks nonzero but live thinking is broken; check whether the reducer/event fix actually touched the stream-event handler, not just renderer prop threading or final assistant-message summary paths
- the API request has thinking enabled but omits `thinking.display: "summarized"`

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
- newer builds append build-ref data with ``${HE()}`` and also carry the same version string in Commander option metadata

What we rewrite:

- inject `\n(patched)` immediately after `(Claude Code)`

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
- 2.1.186 no longer contains this string; `0` candidates is expected there unless this patch is retargeted to a newer installation warning

What we rewrite:

- replace the entire quoted string payload with `(patched)`

Why this exists:

- the upstream migration message is not useful in this patched distribution and consumes valuable space

Likely break signs:

- upstream rewrites the migration copy and the needle vanishes
- patch count drops to `0`
- on 2.1.186, first confirm whether the old migration warning still exists before treating this as a regression

### `welcome-badge`

Intent:

- rename visible startup/help branding from `Claude Code` to `Connoisseur's Code`

Old bundle shapes we match:

- bold text node rendering `"Claude Code"`
- JSX text props shaped like `{bold:!0,children:"Claude Code"}`
- split chunks that call an imported JSX factory directly instead of through a runtime object
- help/settings title template like ``title:(`Claude Code v${...VERSION}`),color:"professionalBlue",defaultTab:"general"``
- welcome copy `"Welcome to Claude Code for "`
- welcome copy `"Welcome to Claude Code"`
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

1. Patch the downloaded native binary in dry-run mode first.

```bash
node scripts/patch-native.ts --input ./work/claude.native.original --dry-run
```

2. Note which module dropped from its usual nonzero count to `0`, or which module now has fewer hits than expected.

3. Search the affected extracted module contents for the old semantic anchors, not the old minified names. Do not assume the entry module contains the UI after 2.1.245.

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

- run native dry-run patching across all embedded JavaScript modules
- patch a real native binary
- run the patched binary with `--version` and verify `(patched)` appears
- manually inspect the UI areas touched by the patch
- on macOS, verify the final binary after re-signing

Useful commands:

```bash
node scripts/patch-native.ts --input ./claude --output ./claude.patched
./claude.patched --version
codesign --verify --verbose=2 ./claude.patched
```

If you only changed the JS matcher and want fast feedback:

```bash
node patch-claude-display.ts --file ./content.js --list-patches
node patch-claude-display.ts --file ./content.js --dry-run
```

## CI Validation

The workflow asserts the `(patched)` version marker by running native-architecture builds and re-extracting cross-architecture builds. That proves the rewritten bundle was packed into the release binary, but it does not prove every UI patch still behaves correctly.

When investigating release correctness, treat these as strong signals, in order:

1. nonzero patch counts for the expected modules
2. runtime `--version` output including `(patched)`
3. different checksums between original and patched binaries

## Maintenance Notes

- Keep this file updated when a patch's semantic target changes.
- If you add a new patch, document the old bundle shape and the user-visible intent here immediately.
- If you split a patch into multiple sub-fixes, say so here; future debugging depends on knowing which symptom each sub-fix addressed.
- Do not turn this back into a user-facing release guide. It exists to preserve maintainer context that is otherwise trapped inside minified bundle archaeology.

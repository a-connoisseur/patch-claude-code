# Claude Display Patch Playbook

This playbook covers both desired behaviors for future Claude Code updates:

1. Always show detailed tool calls (no "Read X files" collapsed summary)
2. Always show thinking inline (no hidden thinking)
3. Stream thinking while it is generated (not only after the block completes)
4. Replace npm-installer migration warning text with `"(patched)"`

## Fast Path

Run the generic patcher in this repo:

```bash
node patch-claude-display.js --file ./claude
```

Optional modes:

```bash
node patch-claude-display.js --file ./claude --dry-run
node patch-claude-display.js --file ./claude --restore
```

The script creates a one-time backup at `./claude.display.backup`.

## What It Patches

### 1) Collapsed read/search summaries

Target shape:

```js
case"collapsed_read_search":return X.createElement(Y,{...,verbose:w,...})
```

Patch:

```js
verbose:!0
```

Result: UI always renders verbose tool entries instead of collapsed "Read X files" summaries.

### 2) Thinking visibility

Target shape (varies per minified version):

```js
case"thinking":{if(!A&&!B[&&!C])return null; ... isTranscriptMode:A ... [hideInTranscript:T] ...}
```

Patch:

1. Remove the early return guard `if(!...&&!...)return null;`
2. Force `isTranscriptMode:!0`
3. If present, force `hideInTranscript:!1`

Result: thinking blocks render inline consistently.

### 3) Thinking streaming

Patch both behaviors in message rendering:

1. In the `RY6` prompt renderer call, pass through `streamingThinking` (same variable used by transcript mode).
2. In the `KsY` memoized cache gate for `H1` thinking JSX, compare/store `N?.thinking` instead of `N`.
3. Replace `L5q=ck.memo(ooY,AsY)` with `L5q=ooY` so message rows repaint for streaming deltas.
4. In `WG6` stream handling, reset streaming thinking on `stream_request_start`, append on `thinking_delta`, and clear transient state on `message_stop`.
5. Remove the `streamingEndedAt<30000` window so the transient stream block is active only while streaming.

Result: thinking text updates per delta while streaming, instead of only after completion.

### 4) NPM migration warning text

Target: the long notification string containing:

```text
switched from npm to native installer
```

Patch the entire string literal payload to:

```text
(patched)
```

## Validation After Patch

Use this quick check:

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("claude","utf8");console.log("tool verbose forced:",/case\"collapsed_read_search\":return[\\s\\S]{0,240}?verbose:!0/.test(s));console.log("thinking transcript forced:",/case\"thinking\":[\\s\\S]{0,700}?isTranscriptMode:!0/.test(s));console.log("thinking not hidden:",/case\"thinking\":[\\s\\S]{0,900}?hideInTranscript:!1/.test(s));'
```

If `hideInTranscript` does not exist in a version, the third check may be `false` and that is acceptable.

Thinking streaming checks:

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("claude","utf8");console.log("streaming memo compares thinking text:",s.includes("q[79]!==N?.thinking"));console.log("prompt renderer receives streamingThinking:",/createElement\\(RY6,\\{[^}]*toolJSX:[^}]*streamingToolUses:[^}]*streamingThinking:[^}]*\\}\\)/.test(s));'
```

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("claude","utf8");console.log("row memo disabled:",s.includes("L5q=ooY")&&!s.includes("L5q=ck.memo(ooY,AsY)"));'
```

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("claude","utf8");console.log("WG6 resets streamingThinking:",/type===\"stream_request_start\"\\)\\{[^}]{0,180}\\?\\.\\(null\\),[^}]{0,120}\\(\"requesting\"\\)/.test(s));console.log("WG6 thinking deltas update streamingThinking:",/case\"thinking_delta\":[\\s\\S]{0,220}\\?\\.\\(\\(H\\)=>\\(\\{thinking:\\(H\\?\\.thinking\\?\\?\"\"\\)\\+/.test(s));'
```

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("claude","utf8");console.log("inline case thinking renderer present:",/case\"thinking\":\\{[^}]{0,700}createElement\\(yW1,\\{/.test(s));console.log("transient streamed-thinking renderer present:",/x&&N&&GH\\.createElement\\(h,\\{marginTop:1\\},GH\\.createElement\\(yW1,\\{param:\\{type:\"thinking\",thinking:N\\.thinking\\}/.test(s));console.log("no post-stop linger window:",!/streamingEndedAt<30000/.test(s));'
```

## If a Future Update Breaks the Script

1. Find candidate tool renderer blocks:
```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("claude","utf8");let i=-1,n=0;while((i=s.indexOf("case\"collapsed_read_search\":",i+1))!==-1){n++;console.log("collapsed_read_search #"+n,"at",i);console.log(s.slice(Math.max(0,i-120),Math.min(s.length,i+260)));}'
```

2. Find candidate thinking blocks:
```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("claude","utf8");let i=-1,n=0;while((i=s.indexOf("case\"thinking\":",i+1))!==-1){n++;console.log("thinking #"+n,"at",i);console.log(s.slice(Math.max(0,i-120),Math.min(s.length,i+360)));}'
```

3. Update the script matching logic in `patch-claude-display.js`:
   - `patchCollapsedReadSearch()`
   - `patchThinkingCase()`
   - `patchThinkingStreaming()`

4. Re-run dry-run first:
```bash
node patch-claude-display.js --file ./claude --dry-run
```

5. Apply and validate.

## Reuse Prompt (for future turns)

Use this exact instruction:

```text
Patch the current claude JS using PATCHING_PLAYBOOK.md.
Apply display patches (tool calls verbose + thinking inline + thinking streaming), run verification, and report what changed.
```

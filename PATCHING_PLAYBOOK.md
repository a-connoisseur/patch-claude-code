# Claude Display Patch Playbook

This playbook covers both desired behaviors for future Claude Code updates:

1. Always show detailed tool calls (no "Read X files" collapsed summary)
2. Always show thinking inline (no hidden thinking)
3. Stream thinking while it is generated (not only after the block completes)
4. Show add-only write results with diff-style coloring (green `+` lines)
5. Replace npm-installer migration warning text with `"(patched)"`

## Fast Path

Run the generic patcher in this repo:

```bash
node patch-claude-display.js --file ./claude
```

Optional modes:

```bash
node patch-claude-display.js --file ./claude --dry-run
node patch-claude-display.js --file ./claude --restore
node patch-claude-display.js --file ./claude --no-inline-thinking
node patch-claude-display.js --file ./claude --no-colored-additions
node patch-claude-display.js --file ./claude --only-colored-additions
```

The script creates a one-time backup at `./claude.display.backup`.

`--no-inline-thinking` skips both thinking visibility and thinking streaming patches, while still applying non-thinking display patches.

`--no-colored-additions` skips the created-file diff-color patch.

`--only-colored-additions` applies only the created-file diff-color patch.

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

### 3) Created-file diff coloring

Target shape:

```js
case"create": ... return createElement(QIY,{filePath:A,content:q,verbose:v})
case"update": return createElement(AG1,{filePath:A,structuredPatch:K,...})
```

Patch:

```js
case"create": ... return createElement(AG1,{
  filePath:A,
  structuredPatch:[{oldStart:1,oldLines:0,newStart:1,newLines:Wl4(q),lines:q===""?[]:q.split(`\n`).map((L)=>"+"+L)}],
  firstLine:q.split(`\n`)[0]??null,
  fileContent:"",
  ...
})
```

Result: file-creation output renders through the diff component, so added lines get the same green/red diff palette as edit/write updates.

### 4) Thinking streaming

Patch both behaviors in message rendering:

1. In the main non-transcript renderer call (identified by props such as `toolJSX`, `streamingToolUses`, `agentDefinitions`, `onOpenRateLimitOptions`), pass through `streamingThinking`.
2. In the streaming-thinking memo cache gate, compare/store by `?.thinking` text instead of object identity.
3. Replace message-row `memo(...)` wrapping by comparator-shape matching (checks like `screen`, `columns`, `lastThinkingBlockId`, `streamingToolUseIDs`), not symbol names.
4. In stream-event handling, reset thinking state on `stream_request_start`, append on `thinking_delta`, and clear transient state on `message_stop`.
5. Remove the `streamingEndedAt<30000` window so the transient stream block is active only while streaming.

Result: thinking text updates per delta while streaming, instead of only after completion.

### 5) NPM migration warning text

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

Created-file diff coloring check:

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("claude","utf8");console.log("write create uses diff renderer:",/case\"create\":[\\s\\S]{0,900}?structuredPatch:\[\{oldStart:1,oldLines:0,newStart:1/.test(s));'
```

Thinking streaming checks:

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("claude","utf8");console.log("prompt renderer receives streamingThinking:",/createElement\\([A-Za-z_$][\\w$]*,\\{[^}]*toolJSX:[^}]*streamingToolUses:[^}]*streamingThinking:[^}]*\\}\\)/.test(s));console.log("streaming memo compares thinking text:",/\\?\\.thinking/.test(s));'
```

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("claude","utf8");console.log("row comparator still present (shape anchor):",s.includes(".lastThinkingBlockId")&&s.includes(".streamingToolUseIDs"));console.log("no 30s linger window:",!/streamingEndedAt<30000/.test(s));'
```

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("claude","utf8");console.log("stream handler resets on request start:",/type===\"stream_request_start\"\\)\\{[^}]{0,180}\\?\\.\\(null\\),[^}]{0,120}\\(\"requesting\"\\)/.test(s));console.log("thinking deltas update streaming state:",/case\"thinking_delta\":[\\s\\S]{0,260}isStreaming:!0/.test(s));console.log("stream state clears on message stop:",/event\\.type===\"message_stop\"\\)\\{[^}]{0,220}\\?\\.\\(null\\),[^}]{0,120}\\(\"tool-use\"\\)/.test(s));'
```

```bash
node -e 'const fs=require("fs");const s=fs.readFileSync("claude","utf8");console.log("inline thinking renderer present:",/case\"thinking\":\\{[^}]{0,900}createElement\\([A-Za-z_$][\\w$]*,\\{[^}]*isTranscriptMode:!0/.test(s));console.log("transient streamed-thinking renderer present:",/createElement\\([A-Za-z_$][\\w$]*,\\{marginTop:1\\},[A-Za-z_$][\\w$]*\\.createElement\\([A-Za-z_$][\\w$]*,\\{param:\\{type:\"thinking\",thinking:[A-Za-z_$][\\w$]*\\.thinking\\}/.test(s));'
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

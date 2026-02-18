# Claude Display Patch Playbook

This playbook covers both desired behaviors for future Claude Code updates:

1. Always show detailed tool calls (no "Read X files" collapsed summary)
2. Always show thinking inline (no hidden thinking)
3. Replace npm-installer migration warning text with `"(patched)"`

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

### 3) NPM migration warning text

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

4. Re-run dry-run first:
```bash
node patch-claude-display.js --file ./claude --dry-run
```

5. Apply and validate.

## Reuse Prompt (for future turns)

Use this exact instruction:

```text
Patch the current claude JS using PATCHING_PLAYBOOK.md.
Apply both display patches (tool calls verbose + thinking inline), run verification, and report what changed.
```

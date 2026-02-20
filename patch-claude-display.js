#!/usr/bin/env bun

const fs = require("fs");
const path = require("path");

function printHelp() {
  console.log("Claude display patcher");
  console.log("======================");
  console.log("");
  console.log("Usage:");
  console.log("  node patch-claude-display.js [--file <path>] [--dry-run] [--restore]");
  console.log("");
  console.log("Options:");
  console.log("  --file <path>   Target Claude JS file (auto-uses ./claude when present)");
  console.log("  --dry-run       Show what would change without writing");
  console.log("  --restore       Restore from backup");
  console.log("  --help, -h      Show this help");
}

function parseArgs(argv) {
  const opts = {
    file: null,
    dryRun: false,
    restore: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --file");
      }
      opts.file = value;
      i += 1;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--restore") {
      opts.restore = true;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function ensureFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Target file not found: ${filePath}`);
  }
}

function resolveTargetPath(opts) {
  if (opts.file) {
    return path.resolve(opts.file);
  }

  const localClaude = path.resolve("claude");
  if (fs.existsSync(localClaude)) {
    return localClaude;
  }

  throw new Error("No target file found. Place `claude` in current folder or pass --file <path>.");
}

function patchCollapsedReadSearch(content) {
  let candidates = 0;
  let patched = 0;

  const pattern =
    /case"collapsed_read_search":return ([A-Za-z_$][\w$]*)\.createElement\(([A-Za-z_$][\w$]*),\{([^}]*)\}\)/g;

  const updated = content.replace(pattern, (full, ns, component, props) => {
    if (!props.includes("verbose:")) {
      return full;
    }

    candidates += 1;
    const nextProps = props.replace(/verbose:[^,}]+/, "verbose:!0");

    if (nextProps !== props) {
      patched += 1;
      return `case"collapsed_read_search":return ${ns}.createElement(${component},{${nextProps}})`;
    }

    return full;
  });

  return {
    content: updated,
    candidates,
    patched,
  };
}

function patchThinkingCase(content) {
  const caseNeedle = 'case"thinking":';
  let index = 0;
  let candidates = 0;
  let patched = 0;
  let output = content;

  while (true) {
    const start = output.indexOf(caseNeedle, index);
    if (start === -1) {
      break;
    }

    const nextCase = output.indexOf('case"', start + caseNeedle.length);
    const nextDefault = output.indexOf("default:", start + caseNeedle.length);
    const endCandidates = [nextCase, nextDefault].filter((value) => value !== -1);
    const end = endCandidates.length > 0 ? Math.min(...endCandidates) : output.length;
    const segment = output.slice(start, end);

    if (!segment.includes("isTranscriptMode:")) {
      index = start + caseNeedle.length;
      continue;
    }

    candidates += 1;

    let nextSegment = segment;
    nextSegment = nextSegment.replace(
      /if\(![A-Za-z_$][\w$]*(?:&&![A-Za-z_$][\w$]*){1,2}\)return null;/,
      ""
    );
    nextSegment = nextSegment.replace(
      /createElement\(([A-Za-z_$][\w$]*),\{([^}]*)\}/g,
      (full, component, props) => {
        let nextProps = props;
        nextProps = nextProps.replace(/isTranscriptMode:[^,}]+/g, "isTranscriptMode:!0");
        nextProps = nextProps.replace(/hideInTranscript:[^,}]+/g, "hideInTranscript:!1");
        if (nextProps === props) {
          return full;
        }
        return `createElement(${component},{${nextProps}}`;
      }
    );

    if (nextSegment !== segment) {
      patched += 1;
      output = output.slice(0, start) + nextSegment + output.slice(end);
      index = start + nextSegment.length;
      continue;
    }

    index = start + caseNeedle.length;
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchThinkingStreaming(content) {
  let output = content;
  let candidates = 0;
  let patched = 0;

  let memoCandidates = 0;
  let memoPatched = 0;

  const streamingMemoPattern =
    /if\(([A-Za-z_$][\w$]*)\[(\d+)\]!==([A-Za-z_$][\w$]*)\|\|\1\[(\d+)\]!==([A-Za-z_$][\w$]*)\|\|\1\[(\d+)\]!==([A-Za-z_$][\w$]*)\)([\s\S]{0,700}?thinking:\5\.thinking[\s\S]{0,700}?)\1\[\2\]=\3,\1\[\4\]=\5,\1\[\6\]=\7,(\1\[\d+\]=[A-Za-z_$][\w$]*;)/g;

  output = output.replace(
    streamingMemoPattern,
    (full, cacheVar, i1, v1, i2, v2, i3, v3, middle, tail) => {
      memoCandidates += 1;
      if (full.includes(`${v2}?.thinking`)) {
        return full;
      }

      const replacement = `if(${cacheVar}[${i1}]!==${v1}||${cacheVar}[${i2}]!==${v2}?.thinking||${cacheVar}[${i3}]!==${v3})${middle}${cacheVar}[${i1}]=${v1},${cacheVar}[${i2}]=${v2}?.thinking,${cacheVar}[${i3}]=${v3},${tail}`;
      if (replacement !== full) {
        memoPatched += 1;
        return replacement;
      }
      return full;
    }
  );

  candidates += memoCandidates;
  patched += memoPatched;

  let propCandidates = 0;
  let propPatched = 0;
  const streamingVarMatch = output.match(/hidePastThinking:!0,streamingThinking:([A-Za-z_$][\w$]*)/);

  if (streamingVarMatch) {
    const streamingVar = streamingVarMatch[1];
    const createElementCallPattern = /createElement\(([A-Za-z_$][\w$]*),\{([^{}]*?)\}\)/g;

    output = output.replace(createElementCallPattern, (full, component, props) => {
      if (!props.includes("streamingToolUses:")) {
        return full;
      }
      if (props.includes("streamingThinking:")) {
        return full;
      }
      if (!props.includes("toolJSX:")) {
        return full;
      }
      if (!props.includes("agentDefinitions:") || !props.includes("onOpenRateLimitOptions:")) {
        return full;
      }
      if (props.includes("hidePastThinking:")) {
        return full;
      }
      if (!props.includes("screenToggleId:") || !props.includes("conversationId:")) {
        return full;
      }

      propCandidates += 1;
      const replacement = `createElement(${component},{${props},streamingThinking:${streamingVar}})`;
      if (replacement !== full) {
        propPatched += 1;
        return replacement;
      }
      return full;
    });
  }

  candidates += propCandidates;
  patched += propPatched;

  // Disable memo wrapper around message-row renderer. Match by comparator body
  // shape (screen/columns/lastThinkingBlockId checks), not by minified symbol
  // names, so this survives variable renaming across releases.
  const memoAssignPattern = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.memo\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)/g;
  let memoMatch;
  while ((memoMatch = memoAssignPattern.exec(output)) !== null) {
    const [full, lhs, _reactNs, renderFn, comparatorFn] = memoMatch;
    const comparatorStart = output.indexOf(`function ${comparatorFn}(`);
    if (comparatorStart === -1) {
      continue;
    }

    const comparatorSlice = output.slice(comparatorStart, comparatorStart + 2200);
    const looksLikeRowComparator =
      comparatorSlice.includes(".screen!==") &&
      comparatorSlice.includes(".columns!==") &&
      comparatorSlice.includes(".lastThinkingBlockId") &&
      comparatorSlice.includes(".streamingToolUseIDs");

    if (!looksLikeRowComparator) {
      continue;
    }

    candidates += 1;
    const replacement = `${lhs}=${renderFn}`;
    if (replacement !== full) {
      output = `${output.slice(0, memoMatch.index)}${replacement}${output.slice(
        memoMatch.index + full.length
      )}`;
      patched += 1;
      memoAssignPattern.lastIndex = memoMatch.index + replacement.length;
    }
  }

  // In some builds the streaming snippet remains visible for 30s after message
  // stop; force visibility to active-stream only.
  let lingerCandidates = 0;
  let lingerPatched = 0;
  const lingerPattern =
    /([A-Za-z_$][\w$]*):\{if\(!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)=!1;break \1\}if\(\2\.isStreaming\)\{\3=!0;break \1\}if\(\2\.streamingEndedAt\)\{\3=Date\.now\(\)-\2\.streamingEndedAt<30000;break \1\}\3=!1\}let ([A-Za-z_$][\w$]*)=\3/g;
  output = output.replace(lingerPattern, (_full, _label, streamVar, _tmpVar, visibleVar) => {
    lingerCandidates += 1;
    lingerPatched += 1;
    return `let ${visibleVar}=!!(${streamVar}&&${streamVar}.isStreaming)`;
  });
  candidates += lingerCandidates;
  patched += lingerPatched;

  // Ensure streaming thinking state is reset and updated from thinking deltas.
  // Without this, some builds keep stale previous-turn thinking and only show
  // final thinking text after completion.
  const streamEventAnchor = 'type!=="stream_event"&&';
  const streamRequestAnchor = 'type==="stream_request_start"';
  const thinkingDeltaAnchor = 'case"thinking_delta"';
  const anchorIndex = output.indexOf(streamEventAnchor);
  if (
    anchorIndex !== -1 &&
    output.indexOf(streamRequestAnchor, anchorIndex) !== -1 &&
    output.indexOf(thinkingDeltaAnchor, anchorIndex) !== -1
  ) {
    const wg6Start = output.lastIndexOf("function ", anchorIndex);
    const wg6End = output.indexOf("function ", anchorIndex + streamEventAnchor.length);
    if (wg6Start !== -1 && wg6End !== -1) {
      const wg6Segment = output.slice(wg6Start, wg6End);
      const signatureMatch = wg6Segment.match(/^function [A-Za-z_$][\w$]*\(([^)]*)\)\{/);

      if (signatureMatch) {
        const params = signatureMatch[1].split(",").map((param) => param.trim());
        if (params.length >= 7) {
          const eventParam = params[0];
          const appendOutputParam = params[2];
          const setModeParam = params[3];
          const setStreamingToolsParam = params[4];
          const setStreamingThinkingParam = params[6];

          const requestStartBefore = `if(${eventParam}.type==="stream_request_start"){${setModeParam}("requesting");return}`;
          const requestStartAfter = `if(${eventParam}.type==="stream_request_start"){${setStreamingThinkingParam}?.(null),${setModeParam}("requesting");return}`;

          const messageStopBefore = `if(${eventParam}.event.type==="message_stop"){${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;
          const messageStopAfter = `if(${eventParam}.event.type==="message_stop"){${setStreamingThinkingParam}?.(null),${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;

          const thinkingStartBefore = `case"thinking":case"redacted_thinking":${setModeParam}("thinking");return;`;
          const thinkingStartAfter = `case"thinking":case"redacted_thinking":${setStreamingThinkingParam}?.(()=>({thinking:"",isStreaming:!0,streamingEndedAt:void 0})),${setModeParam}("thinking");return;`;

          const thinkingDeltaBefore = `case"thinking_delta":${appendOutputParam}(${eventParam}.event.delta.thinking);return;`;
          const thinkingDeltaAfter = `case"thinking_delta":${appendOutputParam}(${eventParam}.event.delta.thinking),${setStreamingThinkingParam}?.((H)=>({thinking:(H?.thinking??"")+${eventParam}.event.delta.thinking,isStreaming:!0,streamingEndedAt:void 0}));return;`;

          const wg6Replacements = [
            [requestStartBefore, requestStartAfter],
            [messageStopBefore, messageStopAfter],
            [thinkingStartBefore, thinkingStartAfter],
            [thinkingDeltaBefore, thinkingDeltaAfter],
          ];

          let nextWg6Segment = wg6Segment;
          for (const [before, after] of wg6Replacements) {
            if (nextWg6Segment.includes(before)) {
              candidates += 1;
              nextWg6Segment = nextWg6Segment.replace(before, after);
              if (nextWg6Segment.includes(after)) {
                patched += 1;
              }
            }
          }

          if (nextWg6Segment !== wg6Segment) {
            output = output.slice(0, wg6Start) + nextWg6Segment + output.slice(wg6End);
          }
        }
      }
    }
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchInstallerMigrationMessage(content) {
  const needle = "switched from npm to native installer";
  let output = content;
  let candidates = 0;
  let patched = 0;
  let idx = output.indexOf(needle);

  while (idx !== -1) {
    candidates += 1;

    let start = idx;
    while (start >= 0 && output[start] !== '"' && output[start] !== "'" && output[start] !== "`") {
      start -= 1;
    }
    if (start < 0) {
      idx = output.indexOf(needle, idx + needle.length);
      continue;
    }

    const quote = output[start];
    let end = start + 1;
    while (end < output.length) {
      if (output[end] === quote && output[end - 1] !== "\\") {
        break;
      }
      end += 1;
    }
    if (end >= output.length) {
      idx = output.indexOf(needle, idx + needle.length);
      continue;
    }

    const currentPayload = output.slice(start + 1, end);
    if (currentPayload !== "(patched)") {
      output = `${output.slice(0, start + 1)}(patched)${output.slice(end)}`;
      patched += 1;
      idx = output.indexOf(needle, start + 11);
      continue;
    }

    idx = output.indexOf(needle, idx + needle.length);
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchTargetShebang(content) {
  const shebangPattern = /^#!\/usr\/bin\/env node([^\n]*)/;
  const hasNodeShebang = shebangPattern.test(content);
  const output = content.replace(shebangPattern, "#!/usr/bin/env bun$1");

  return {
    content: output,
    candidates: hasNodeShebang ? 1 : 0,
    patched: hasNodeShebang && output !== content ? 1 : 0,
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error("");
    printHelp();
    process.exit(1);
  }

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  let targetPath;
  try {
    targetPath = resolveTargetPath(opts);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  const backupPath = `${targetPath}.display.backup`;

  if (opts.restore) {
    if (!fs.existsSync(backupPath)) {
      console.error(`Error: Backup file not found: ${backupPath}`);
      process.exit(1);
    }

    if (opts.dryRun) {
      console.log(`Would restore ${targetPath} from ${backupPath}`);
      process.exit(0);
    }

    fs.copyFileSync(backupPath, targetPath);
    console.log(`Restored ${targetPath} from backup.`);
    process.exit(0);
  }

  ensureFileExists(targetPath);
  const original = fs.readFileSync(targetPath, "utf8");

  const shebangPatch = patchTargetShebang(original);
  const toolPatch = patchCollapsedReadSearch(shebangPatch.content);
  const thinkingPatch = patchThinkingCase(toolPatch.content);
  const thinkingStreamingPatch = patchThinkingStreaming(thinkingPatch.content);
  const installerPatch = patchInstallerMigrationMessage(thinkingStreamingPatch.content);
  const nextContent = installerPatch.content;

  console.log("Patch summary:");
  console.log(`  shebang candidates: ${shebangPatch.candidates}, patched: ${shebangPatch.patched}`);
  console.log(
    `  collapsed_read_search candidates: ${toolPatch.candidates}, patched: ${toolPatch.patched}`
  );
  console.log(`  thinking candidates: ${thinkingPatch.candidates}, patched: ${thinkingPatch.patched}`);
  console.log(
    `  thinking streaming candidates: ${thinkingStreamingPatch.candidates}, patched: ${thinkingStreamingPatch.patched}`
  );
  console.log(
    `  installer message candidates: ${installerPatch.candidates}, patched: ${installerPatch.patched}`
  );

  if (nextContent === original) {
    console.log("No changes needed.");
    process.exit(0);
  }

  if (opts.dryRun) {
    console.log("Dry run complete. No files changed.");
    process.exit(0);
  }

  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(targetPath, backupPath);
    console.log(`Backup created: ${backupPath}`);
  }

  fs.writeFileSync(targetPath, nextContent, "utf8");
  console.log(`Patched: ${targetPath}`);
}

main();

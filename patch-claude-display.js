const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TARGET_FILE_ENCODING = "latin1";

function printHelp() {
  console.log("Claude display patcher");
  console.log("======================");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node patch-claude-display.js [--file <path>] [--dry-run] [--restore] [--disable <ids>] [--enable <ids>] [--codesign] [--codesign-identity <identity>] [--allow-size-change] [--list-patches]"
  );
  console.log("");
  console.log("Options:");
  console.log("  --file <path>   Target Claude JS file (auto-uses ./claude when present)");
  console.log("  --dry-run       Show what would change without writing");
  console.log("  --restore       Restore from backup");
  console.log("  --disable <ids> Comma-separated patch ids to disable");
  console.log("  --enable <ids>  Comma-separated opt-in patch ids to enable");
  console.log("  --codesign      Re-sign target with macOS codesign after patch/restore");
  console.log("  --codesign-identity <id> codesign identity (default: - for ad-hoc)");
  console.log("  --allow-size-change Allow size-changing edits on binary targets (usually non-runnable)");
  console.log("  --list-patches  Print available patch ids and exit");
  console.log("  --help, -h      Show this help");
}

function parsePatchIds(value, flagName) {
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error(`Expected a comma-separated list for ${flagName}`);
  }

  return ids;
}

function parseArgs(argv) {
  const opts = {
    file: null,
    dryRun: false,
    restore: false,
    disable: [],
    enable: [],
    listPatches: false,
    codesign: false,
    codesignIdentity: "-",
    allowSizeChange: false,
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
    } else if (arg === "--disable") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --disable");
      }
      opts.disable.push(...parsePatchIds(value, "--disable"));
      i += 1;
    } else if (arg === "--enable") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --enable");
      }
      opts.enable.push(...parsePatchIds(value, "--enable"));
      i += 1;
    } else if (arg === "--list-patches") {
      opts.listPatches = true;
    } else if (arg === "--codesign") {
      opts.codesign = true;
    } else if (arg === "--codesign-identity") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --codesign-identity");
      }
      opts.codesignIdentity = value;
      opts.codesign = true;
      i += 1;
    } else if (arg === "--allow-size-change") {
      opts.allowSizeChange = true;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function looksLikeMachO(filePath) {
  const magics = new Set([
    "feedface",
    "cefaedfe",
    "feedfacf",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
  ]);

  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, header, 0, 4, 0);
    if (bytesRead < 4) {
      return false;
    }
    return magics.has(header.toString("hex"));
  } finally {
    fs.closeSync(fd);
  }
}

function looksLikeBinary(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const sample = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
    if (bytesRead === 0) {
      return false;
    }
    for (let i = 0; i < bytesRead; i += 1) {
      if (sample[i] === 0) {
        return true;
      }
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function runCodesign(filePath, identity) {
  execFileSync("codesign", ["-f", "-s", identity, filePath], {
    stdio: "inherit",
  });
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

function patchCollapsedReadSearch(content, ctx = {}) {
  let candidates = 0;
  let patched = 0;

  const pattern =
    /case"collapsed_read_search":return ([A-Za-z_$][\w$]*)\.createElement\(([A-Za-z_$][\w$]*),\{([^}]*)\}\)/g;

  const updated = content.replace(pattern, (full, ns, component, props) => {
    if (!props.includes("verbose:")) {
      return full;
    }

    candidates += 1;
    const replacement = ctx.preserveLength ? "verbose:1" : "verbose:!0";
    const nextProps = props.replace(/verbose:[^,}]+/, replacement);

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

function patchWriteCreateDiffColors(content) {
  const createNeedle = 'case"create":';
  const updateNeedle = 'case"update":';

  let index = 0;
  let candidates = 0;
  let patched = 0;
  let output = content;

  while (true) {
    const createStart = output.indexOf(createNeedle, index);
    if (createStart === -1) {
      break;
    }

    const updateStart = output.indexOf(updateNeedle, createStart + createNeedle.length);
    if (updateStart === -1) {
      index = createStart + createNeedle.length;
      continue;
    }

    const nextCase = output.indexOf('case"', updateStart + updateNeedle.length);
    const nextDefault = output.indexOf("default:", updateStart + updateNeedle.length);
    const endCandidates = [nextCase, nextDefault].filter((value) => value !== -1);
    const switchEnd = endCandidates.length > 0 ? Math.min(...endCandidates) : output.length;

    const createSegment = output.slice(createStart, updateStart);
    const updateSegment = output.slice(updateStart, switchEnd);

    if (createSegment.includes("structuredPatch:[{oldStart:1,oldLines:0,newStart:1")) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    const createReturnMatch = createSegment.match(
      /return ([A-Za-z_$][\w$]*)\.createElement\(([A-Za-z_$][\w$]*),\{filePath:([A-Za-z_$][\w$]*),content:([A-Za-z_$][\w$]*),verbose:([A-Za-z_$][\w$]*)\}\)/
    );
    if (!createReturnMatch) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    const updateRendererMatch = updateSegment.match(
      /createElement\(([A-Za-z_$][\w$]*),\{filePath:[^}]*structuredPatch:[^}]*style:([A-Za-z_$][\w$]*),verbose:[A-Za-z_$][\w$]*/
    );
    if (!updateRendererMatch) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    candidates += 1;

    const reactNs = createReturnMatch[1];
    const fileVar = createReturnMatch[3];
    const contentVar = createReturnMatch[4];
    const verboseVar = createReturnMatch[5];
    const diffRenderer = updateRendererMatch[1];
    const styleVar = updateRendererMatch[2];

    const lineCounterMatch = createSegment.match(
      /let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\);return [A-Za-z_$][\w$]*\.createElement\([A-Za-z_$][\w$]*,null,"Wrote "/
    );
    const lineCountExpr = lineCounterMatch
      ? `${lineCounterMatch[1]}(${contentVar})`
      : `${contentVar}===""?0:${contentVar}.split(\`\\n\`).length`;

    const before = createReturnMatch[0];
    const after = `return ${reactNs}.createElement(${diffRenderer},{filePath:${fileVar},structuredPatch:[{oldStart:1,oldLines:0,newStart:1,newLines:${lineCountExpr},lines:${contentVar}===""?[]:${contentVar}.split(\`\\n\`).map((__cc_line)=>"+"+__cc_line)}],firstLine:${contentVar}.split(\`\\n\`)[0]??null,fileContent:"",style:${styleVar},verbose:${verboseVar},previewHint:void 0})`;

    if (!createSegment.includes(before)) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    const nextCreateSegment = createSegment.replace(before, after);
    if (nextCreateSegment !== createSegment) {
      patched += 1;
      output = output.slice(0, createStart) + nextCreateSegment + output.slice(updateStart);
      index = createStart + nextCreateSegment.length;
      continue;
    }

    index = updateStart + updateNeedle.length;
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchWordDiffLineBackgrounds(content) {
  const anchor = '"diffAddedWord";else if(!';
  let output = content;
  let candidates = 0;
  let patched = 0;

  let index = 0;
  while (true) {
    const anchorIndex = output.indexOf(anchor, index);
    if (anchorIndex === -1) {
      break;
    }

    const fnStart = output.lastIndexOf("function ", anchorIndex);
    const fnEnd = output.indexOf("function ", anchorIndex + anchor.length);
    if (fnStart === -1 || fnEnd === -1) {
      index = anchorIndex + anchor.length;
      continue;
    }

    const segment = output.slice(fnStart, fnEnd);
    if (segment.includes("diffAddedDimmed") && segment.includes("backgroundColor:") && segment.includes("??(")) {
      index = anchorIndex + anchor.length;
      continue;
    }

    const signatureMatch = segment.match(/^function [A-Za-z_$][\w$]*\(([^)]*)\)\{/);
    const typeVarMatch = segment.match(/let\{type:([A-Za-z_$][\w$]*),/);
    if (!signatureMatch || !typeVarMatch) {
      index = anchorIndex + anchor.length;
      continue;
    }

    const params = signatureMatch[1].split(",").map((p) => p.trim());
    if (params.length < 4) {
      index = anchorIndex + anchor.length;
      continue;
    }

    const dimVar = params[3];
    const typeVar = typeVarMatch[1];

    const childBgPattern =
      /(key:`part-\$\{[A-Za-z_$][\w$]*\}-\$\{[A-Za-z_$][\w$]*\}`,backgroundColor:)([A-Za-z_$][\w$]*)(\},[A-Za-z_$][\w$]*\)\))/;

    if (!childBgPattern.test(segment)) {
      index = anchorIndex + anchor.length;
      continue;
    }

    candidates += 1;
    const nextSegment = segment.replace(childBgPattern, (_full, prefix, bgVar, suffix) => {
      return `${prefix}${bgVar}??(${typeVar}==="add"?${dimVar}?"diffAddedDimmed":"diffAdded":${dimVar}?"diffRemovedDimmed":"diffRemoved")${suffix}`;
    });

    if (nextSegment !== segment) {
      patched += 1;
      output = output.slice(0, fnStart) + nextSegment + output.slice(fnEnd);
      index = fnStart + nextSegment.length;
      continue;
    }

    index = anchorIndex + anchor.length;
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchThinkingCase(content, ctx = {}) {
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
      (full) => {
        if (!ctx.preserveLength) {
          return "";
        }
        return `;${" ".repeat(Math.max(0, full.length - 1))}`;
      }
    );
    nextSegment = nextSegment.replace(
      /createElement\(([A-Za-z_$][\w$]*),\{([^}]*)\}/g,
      (full, component, props) => {
        let nextProps = props;
        nextProps = nextProps.replace(/isTranscriptMode:[^,}]+/g, (entry) => {
          const desired = ctx.preserveLength ? "isTranscriptMode:1" : "isTranscriptMode:!0";
          if (!ctx.preserveLength || desired.length > entry.length) {
            return desired;
          }
          return `${desired}${" ".repeat(entry.length - desired.length)}`;
        });
        nextProps = nextProps.replace(/hideInTranscript:[^,}]+/g, (entry) => {
          const desired = ctx.preserveLength ? "hideInTranscript:0" : "hideInTranscript:!1";
          if (!ctx.preserveLength || desired.length > entry.length) {
            return desired;
          }
          return `${desired}${" ".repeat(entry.length - desired.length)}`;
        });
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

function patchSubagentPromptVisibility(content, ctx = {}) {
  const backgroundedAnchor = '"Backgrounded agent"';
  let output = content;
  let candidates = 0;
  let patched = 0;

  let index = 0;
  while (true) {
    const anchorIndex = output.indexOf(backgroundedAnchor, index);
    if (anchorIndex === -1) {
      break;
    }

    const fnStart = output.lastIndexOf("function ", anchorIndex);
    const fnEndCandidate = output.indexOf("function ", anchorIndex + backgroundedAnchor.length);
    const fnEnd = fnEndCandidate === -1 ? output.length : fnEndCandidate;

    if (fnStart === -1 || fnEnd <= fnStart) {
      index = anchorIndex + backgroundedAnchor.length;
      continue;
    }

    const segment = output.slice(fnStart, fnEnd);

    const isRelevantRenderer =
      segment.includes('action:"app:toggleTranscript"') &&
      segment.includes('fallback:"ctrl+o"') &&
      segment.includes("isTranscriptMode:") &&
      segment.includes("{prompt:") &&
      segment.includes(",theme:");

    if (!isRelevantRenderer) {
      index = anchorIndex + backgroundedAnchor.length;
      continue;
    }

    const transcriptModeMatch = segment.match(/isTranscriptMode:([A-Za-z_$][\w$]*)=!1/);
    if (!transcriptModeMatch) {
      index = anchorIndex + backgroundedAnchor.length;
      continue;
    }

    const transcriptModeVar = transcriptModeMatch[1];
    const gatePattern = new RegExp(`${transcriptModeVar}&&([A-Za-z_$][\\w$]*)&&`, "g");

    let localCandidates = 0;
    let localPatched = 0;

    const nextSegment = segment.replace(gatePattern, (full, promptVar, offset, source) => {
      const nearby = source.slice(offset, offset + 260);
      if (!nearby.includes(`{prompt:${promptVar},theme:`)) {
        return full;
      }

      localCandidates += 1;
      localPatched += 1;
      if (!ctx.preserveLength) {
        return `${promptVar}&&`;
      }
      const replacement = `${promptVar}&&${promptVar}&&`;
      if (replacement.length > full.length) {
        return full;
      }
      return `${replacement}${" ".repeat(full.length - replacement.length)}`;
    });

    candidates += localCandidates;

    if (nextSegment !== segment) {
      patched += localPatched;
      output = output.slice(0, fnStart) + nextSegment + output.slice(fnEnd);
      index = fnStart + nextSegment.length;
      continue;
    }

    index = anchorIndex + backgroundedAnchor.length;
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchInstallerMigrationMessage(content, ctx = {}) {
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
    const desiredPayload = ctx.preserveLength
      ? "(patched)".padEnd(currentPayload.length, " ")
      : "(patched)";
    if (currentPayload !== desiredPayload) {
      output = `${output.slice(0, start + 1)}${desiredPayload}${output.slice(end)}`;
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

function patchForceNativeRuntime(content) {
  const pattern =
    /function ([A-Za-z_$][\w$]*)\(\)\{return typeof Bun<"u"&&Array\.isArray\(Bun\.embeddedFiles\)&&Bun\.embeddedFiles\.length>0\}/g;
  let candidates = 0;
  let patched = 0;

  const output = content.replace(pattern, (full, fnName) => {
    candidates += 1;
    const replacement = `function ${fnName}(){return process.versions.bun!==void 0}`;
    if (full !== replacement) {
      patched += 1;
      return replacement;
    }
    return full;
  });

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchRipgrepForBunRuntime(content) {
  const pattern =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{if\(process\.env\.RIPGREP_EMBEDDED==="true"\)return ([A-Za-z_$][\w$]*)\(process\.execPath,\["--no-config",\.\.\.\2\],\{argv0:"rg",stdio:"inherit"\}\)\.status\?\?1;/g;
  let candidates = 0;
  let patched = 0;

  const output = content.replace(pattern, (full, fnName, argsName, spawnName) => {
    candidates += 1;
    if (full.includes("if(process.versions.bun!==void 0)return")) {
      return full;
    }
    patched += 1;
    return `${full}if(process.versions.bun!==void 0)return ${spawnName}("rg",["--no-config",...${argsName}],{stdio:"inherit"}).status??1;`;
  });

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchNativeColorDiffAddon(content) {
  const pattern =
    /\(\(\)=>\{throw new Error\([^)]*color-diff\.node[^)]*\);\}\)\(\)/g;
  let candidates = 0;
  let patched = 0;

  const replacement =
    `(()=>{let __cc_require=typeof require=="function"?require:typeof b6=="function"?b6:null;if(!__cc_require)throw new Error("Cannot require module ../../color-diff.node");let __cc_execDir=process.execPath.replace(/[\\\\/][^\\\\/]*$/,""),__cc_paths=[process.env.CLAUDE_CODE_COLOR_DIFF_NODE_PATH,process.execPath+".color-diff.node",(__cc_execDir?__cc_execDir+"/":"")+"color-diff.node","./color-diff.node"];for(let __cc_path of __cc_paths){if(!__cc_path)continue;try{return __cc_require(__cc_path)}catch{}}throw new Error("Cannot require module ../../color-diff.node")})()`;

  const output = content.replace(pattern, (full) => {
    candidates += 1;
    if (full === replacement) {
      return full;
    }
    patched += 1;
    return replacement;
  });

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

const PATCH_MODULES = [
  {
    id: "shebang",
    description: "Rewrite #!/usr/bin/env node to bun",
    apply: patchTargetShebang,
  },
  {
    id: "tool-call-verbose",
    description: "Force verbose collapsed read/search rendering",
    apply: patchCollapsedReadSearch,
  },
  {
    id: "create-diff-colors",
    description: "Render created files through diff component with + lines",
    apply: patchWriteCreateDiffColors,
  },
  {
    id: "word-diff-line-bg",
    description: "Keep muted +/- line background in word-diff mode",
    apply: patchWordDiffLineBackgrounds,
  },
  {
    id: "thinking-inline",
    description: "Always render thinking blocks inline",
    apply: patchThinkingCase,
  },
  {
    id: "thinking-streaming",
    description: "Enable/repair streaming thinking behavior",
    apply: patchThinkingStreaming,
  },
  {
    id: "subagent-prompt",
    description: "Show subagent Prompt blocks outside transcript mode",
    apply: patchSubagentPromptVisibility,
  },
  {
    id: "installer-label",
    description: "Replace npm/native installer warning text with (patched)",
    apply: patchInstallerMigrationMessage,
  },
  {
    id: "ripgrep-bun-runtime",
    description: "Use system rg for Bun runtime ripgrep entrypoint",
    apply: patchRipgrepForBunRuntime,
    defaultEnabled: false,
  },
  {
    id: "native-color-diff-addon",
    description: "Load color-diff.node sidecar in npm-native builds",
    apply: patchNativeColorDiffAddon,
    defaultEnabled: false,
  },
  {
    id: "native-runtime",
    description: "Force Bun builds to run native-runtime code paths",
    apply: patchForceNativeRuntime,
    defaultEnabled: false,
  },
];

function resolveSelectedPatchIds(opts) {
  const valid = new Set(PATCH_MODULES.map((module) => module.id));
  const invalid = [...opts.disable, ...opts.enable].filter((id) => !valid.has(id));

  if (invalid.length > 0) {
    throw new Error(`Unknown patch id(s): ${invalid.join(", ")}. Use --list-patches to see valid ids.`);
  }

  const enableSet = new Set(opts.enable);
  const disableSet = new Set(opts.disable);
  const conflicts = [...enableSet].filter((id) => disableSet.has(id));
  if (conflicts.length > 0) {
    throw new Error(`Conflicting patch id(s) in --enable and --disable: ${conflicts.join(", ")}`);
  }

  const selected = new Set(
    PATCH_MODULES.filter((module) => module.defaultEnabled !== false).map((module) => module.id)
  );
  for (const id of enableSet) {
    selected.add(id);
  }
  for (const id of disableSet) {
    selected.delete(id);
  }

  return { selected, disableSet };
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

  if (opts.listPatches) {
    console.log("Available patches:");
    for (const module of PATCH_MODULES) {
      const optInLabel = module.defaultEnabled === false ? " (opt-in)" : "";
      console.log(`  ${module.id}${optInLabel} - ${module.description}`);
    }
    process.exit(0);
  }

  let patchSelection;
  try {
    patchSelection = resolveSelectedPatchIds(opts);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  const selectedPatchIds = patchSelection.selected;

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
      if (opts.codesign) {
        console.log(`Would run: codesign -f -s ${opts.codesignIdentity} ${targetPath}`);
      }
      process.exit(0);
    }

    fs.copyFileSync(backupPath, targetPath);
    console.log(`Restored ${targetPath} from backup.`);

    if (opts.codesign) {
      try {
        runCodesign(targetPath, opts.codesignIdentity);
        console.log(`Codesigned: ${targetPath} (identity: ${opts.codesignIdentity})`);
      } catch (error) {
        console.error(`Error: codesign failed for ${targetPath}: ${error.message}`);
        process.exit(1);
      }
    }

    process.exit(0);
  }

  ensureFileExists(targetPath);
  const isMachOTarget = looksLikeMachO(targetPath);
  const isBinaryTarget = looksLikeBinary(targetPath);
  const preserveLength = isBinaryTarget && !opts.allowSizeChange;

  if (preserveLength) {
    console.log("Detected binary target: running in size-preserving mode.");
    console.log("Size-changing modules will be skipped automatically.");
  } else if (isBinaryTarget && opts.allowSizeChange) {
    console.log("Detected binary target with --allow-size-change.");
    console.log("Warning: size-changing patches usually produce a non-runnable binary.");
  }

  const original = fs.readFileSync(targetPath, TARGET_FILE_ENCODING);
  let currentContent = original;
  const patchResults = new Map();

  for (const module of PATCH_MODULES) {
    if (!selectedPatchIds.has(module.id)) {
      const reason =
        module.defaultEnabled === false && !patchSelection.disableSet.has(module.id)
          ? "not enabled (opt-in)"
          : "disabled";
      patchResults.set(module.id, {
        candidates: 0,
        patched: 0,
        skipped: true,
        reason,
      });
      continue;
    }

    if (isBinaryTarget && module.id === "shebang") {
      patchResults.set(module.id, {
        candidates: 0,
        patched: 0,
        skipped: true,
        reason: "not applicable for binary target",
      });
      continue;
    }

    const result = module.apply(currentContent, { preserveLength });
    const hasSizeChange = result.content.length !== currentContent.length;
    if (preserveLength && hasSizeChange) {
      patchResults.set(module.id, {
        candidates: result.candidates,
        patched: 0,
        skipped: true,
        reason: "requires size change",
      });
      continue;
    }

    currentContent = result.content;
    patchResults.set(module.id, {
      candidates: result.candidates,
      patched: result.patched,
      skipped: false,
      reason: null,
    });
  }

  const nextContent = currentContent;

  console.log("Patch summary:");
  for (const module of PATCH_MODULES) {
    const result = patchResults.get(module.id);
    if (result.skipped) {
      if (result.reason === "disabled") {
        console.log(`  ${module.id} candidates: 0, patched: 0 (skipped)`);
      } else {
        console.log(
          `  ${module.id} candidates: ${result.candidates}, patched: 0 (skipped: ${result.reason})`
        );
      }
      continue;
    }
    console.log(`  ${module.id} candidates: ${result.candidates}, patched: ${result.patched}`);
  }

  if (nextContent === original) {
    console.log("No changes needed.");
    process.exit(0);
  }

  if (opts.dryRun) {
    console.log("Dry run complete. No files changed.");
    if (opts.codesign) {
      console.log(`Would run: codesign -f -s ${opts.codesignIdentity} ${targetPath}`);
    }
    process.exit(0);
  }

  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(targetPath, backupPath);
    console.log(`Backup created: ${backupPath}`);
  }

  fs.writeFileSync(targetPath, nextContent, TARGET_FILE_ENCODING);
  console.log(`Patched: ${targetPath}`);

  if (opts.codesign) {
    try {
      runCodesign(targetPath, opts.codesignIdentity);
      console.log(`Codesigned: ${targetPath} (identity: ${opts.codesignIdentity})`);
    } catch (error) {
      console.error(`Error: codesign failed for ${targetPath}: ${error.message}`);
      process.exit(1);
    }
  } else if (looksLikeMachO(targetPath)) {
    console.log("Note: target appears to be a Mach-O binary.");
    console.log(`Run: codesign -f -s - ${targetPath}`);
  }
}

main();

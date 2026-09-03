const fs = require("fs");
const path = require("path");

const TARGET_FILE_ENCODING = "utf8";

function printHelp() {
  console.log("Claude display patcher");
  console.log("======================");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node patch-claude-display.ts --file <path> [--dry-run] [--disable <ids>] [--enable <ids>] [--list-patches]"
  );
  console.log("");
  console.log("Options:");
  console.log("  --file <path>   Target extracted Claude JS content");
  console.log("  --dry-run       Show what would change without writing");
  console.log("  --disable <ids> Comma-separated patch ids to disable");
  console.log("  --enable <ids>  Comma-separated patch ids to enable");
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
    disable: [],
    enable: [],
    listPatches: false,
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

  const localContent = path.resolve("content.js");
  if (fs.existsSync(localContent)) {
    return localContent;
  }

  throw new Error("No target file found. Pass --file <path> or place content.js in the current folder.");
}

function patchCollapsedReadSearch(content, ctx = {}) {
  let candidates = 0;
  let patched = 0;
  let output = content;

  const pattern =
    /case"collapsed_read_search":return ([A-Za-z_$][\w$]*)\.createElement\(([A-Za-z_$][\w$]*),\{([^}]*)\}\)/g;

  output = output.replace(pattern, (full, ns, component, props) => {
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

  const o7qCaseNeedle = 'case"collapsed_read_search":{';
  let index = 0;
  while (true) {
    const start = output.indexOf(o7qCaseNeedle, index);
    if (start === -1) {
      break;
    }

    const nextCase = output.indexOf('case"', start + o7qCaseNeedle.length);
    const nextDefault = output.indexOf("default:", start + o7qCaseNeedle.length);
    const endCandidates = [nextCase, nextDefault].filter((value) => value !== -1);
    const end = endCandidates.length > 0 ? Math.min(...endCandidates) : output.length;
    const segment = output.slice(start, end);

    if (!segment.includes("verbose:")) {
      index = start + o7qCaseNeedle.length;
      continue;
    }

    const callMatch = segment.match(
      /\{message:[^}]*inProgressToolUseIDs:[^}]*shouldAnimate:[^}]*verbose:[^,}]+,tools:[^}]*lookups:[^}]*isActiveGroup:[^}]*\}/
    );
    if (!callMatch) {
      index = start + o7qCaseNeedle.length;
      continue;
    }

    candidates += 1;
    const replacement = ctx.preserveLength ? "verbose:1" : "verbose:!0";
    const nextSegment = segment.replace(/verbose:[^,}]+/, replacement);

    if (nextSegment !== segment) {
      patched += 1;
      output = output.slice(0, start) + nextSegment + output.slice(end);
      index = start + nextSegment.length;
      continue;
    }

    index = start + o7qCaseNeedle.length;
  }

  return {
    content: output,
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

    const rendererCallPattern =
      "(?:[A-Za-z_$][\\w$]*\\.(?:createElement|jsx|jsxs)|[A-Za-z_$][\\w$]*)";
    const createReturnMatch = createSegment.match(
      new RegExp(
        `return (${rendererCallPattern})\\(([A-Za-z_$][\\w$]*),\\{filePath:([A-Za-z_$][\\w$]*),content:([A-Za-z_$][\\w$]*),verbose:([A-Za-z_$][\\w$]*)(?:,replacedUndiffedContent:[A-Za-z_$][\\w$]*)?\\}\\)`
      )
    );
    if (!createReturnMatch) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    const updateRendererMatch = updateSegment.match(
      new RegExp(
        `${rendererCallPattern}\\(([A-Za-z_$][\\w$]*),\\{filePath:[^}]*structuredPatch:[^}]*style:([A-Za-z_$][\\w$]*),verbose:[A-Za-z_$][\\w$]*`
      )
    );
    if (!updateRendererMatch) {
      index = updateStart + updateNeedle.length;
      continue;
    }

    candidates += 1;

    const renderCall = createReturnMatch[1];
    const fileVar = createReturnMatch[3];
    const contentVar = createReturnMatch[4];
    const verboseVar = createReturnMatch[5];
    const diffRenderer = updateRendererMatch[1];
    const styleVar = updateRendererMatch[2];

    const lineCounterMatch = createSegment.match(
      /let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\);return [A-Za-z_$][\w$]*\.(?:createElement|jsxs)\([A-Za-z_$][\w$]*,(?:null,|\{children:\[)"Wrote "/
    );
    const lineCountExpr = lineCounterMatch
      ? `${lineCounterMatch[1]}(${contentVar})`
      : `${contentVar}===""?0:${contentVar}.split(\`\\n\`).length`;

    const before = createReturnMatch[0];
    const after = `return ${renderCall}(${diffRenderer},{filePath:${fileVar},structuredPatch:[{oldStart:1,oldLines:0,newStart:1,newLines:${lineCountExpr},lines:${contentVar}===""?[]:${contentVar}.split(\`\\n\`).map((__cc_line)=>"+"+__cc_line)}],firstLine:${contentVar}.split(\`\\n\`)[0]??null,fileContent:"",style:${styleVar},verbose:${verboseVar},previewHint:void 0})`;

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

    const legacyChildBgPattern =
      /(key:`part-\$\{[A-Za-z_$][\w$]*\}-\$\{[A-Za-z_$][\w$]*\}`,backgroundColor:)([A-Za-z_$][\w$]*)(\},[A-Za-z_$][\w$]*\)\))/;
    const jsxChildBgPattern =
      /(backgroundColor:)([A-Za-z_$][\w$]*)(,children:[A-Za-z_$][\w$]*\},`part-\$\{[A-Za-z_$][\w$]*\}-\$\{[A-Za-z_$][\w$]*\}`\)\))/;

    if (!legacyChildBgPattern.test(segment) && !jsxChildBgPattern.test(segment)) {
      index = anchorIndex + anchor.length;
      continue;
    }

    candidates += 1;
    const backgroundFallback = (bgVar) =>
      `${bgVar}??(${typeVar}==="add"?${dimVar}?"diffAddedDimmed":"diffAdded":${dimVar}?"diffRemovedDimmed":"diffRemoved")`;
    let nextSegment = segment.replace(legacyChildBgPattern, (_full, prefix, bgVar, suffix) => {
      return `${prefix}${bgVar}??(${typeVar}==="add"?${dimVar}?"diffAddedDimmed":"diffAdded":${dimVar}?"diffRemovedDimmed":"diffRemoved")${suffix}`;
    });
    nextSegment = nextSegment.replace(jsxChildBgPattern, (_full, prefix, bgVar, suffix) => {
      return `${prefix}${backgroundFallback(bgVar)}${suffix}`;
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
      /if\(![A-Za-z_$][\w$]*(?:&&![A-Za-z_$][\w$]*){1,2}\)(?:return null;|\{return null;?\})/,
      (full) => {
        if (!ctx.preserveLength) {
          return "";
        }
        return `;${" ".repeat(Math.max(0, full.length - 1))}`;
      }
    );
    nextSegment = nextSegment.replace(/isTranscriptMode:[^,}]+/g, (entry) => {
      const desired = ctx.preserveLength ? "isTranscriptMode:1" : "isTranscriptMode:!0";
      if (!ctx.preserveLength || desired.length > entry.length) {
        return desired;
      }
      return `${desired}${" ".repeat(entry.length - desired.length)}`;
    });
    nextSegment = nextSegment.replace(/hideInTranscript:[^,}]+/g, (entry) => {
      const desired = ctx.preserveLength ? "hideInTranscript:0" : "hideInTranscript:!1";
      if (!ctx.preserveLength || desired.length > entry.length) {
        return desired;
      }
      return `${desired}${" ".repeat(entry.length - desired.length)}`;
    });

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

function patchRedactedThinkingSummaries(content) {
  const redactedNeedle = 'case"redacted_thinking":';
  const thinkingNeedle = 'case"thinking":';
  const maxRendererGap = 2000;

  let index = 0;
  let candidates = 0;
  let patched = 0;
  let output = content;

  while (true) {
    const redactedStart = output.indexOf(redactedNeedle, index);
    if (redactedStart === -1) {
      break;
    }

    const thinkingStart = output.indexOf(thinkingNeedle, redactedStart + redactedNeedle.length);
    if (thinkingStart === -1) {
      break;
    }

    const nextCase = output.indexOf('case"', thinkingStart + thinkingNeedle.length);
    const nextDefault = output.indexOf("default:", thinkingStart + thinkingNeedle.length);
    const endCandidates = [nextCase, nextDefault].filter((value) => value !== -1);
    const thinkingEnd = endCandidates.length > 0 ? Math.min(...endCandidates) : output.length;

    const redactedSegment = output.slice(redactedStart, thinkingStart);
    const thinkingSegment = output.slice(thinkingStart, thinkingEnd);

    const hasRedactedRendererCall =
      /(?:[A-Za-z_$][\w$]*\.(?:createElement|jsx|jsxs)|[A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*,\{addMargin:/.test(
        redactedSegment
      );
    if (
      thinkingStart - redactedStart > maxRendererGap ||
      thinkingEnd - thinkingStart > maxRendererGap ||
      !hasRedactedRendererCall ||
      !thinkingSegment.includes("isTranscriptMode:")
    ) {
      index = redactedStart + redactedNeedle.length;
      continue;
    }

    const thinkingRendererMatch = thinkingSegment.match(
      /((?:[A-Za-z_$][\w$]*\.(?:createElement|jsx|jsxs)|[A-Za-z_$][\w$]*))\(([A-Za-z_$][\w$]*),\{addMargin:([A-Za-z_$][\w$]*),param:([A-Za-z_$][\w$]*),isTranscriptMode:[^,}]+,verbose:[^,}]+(?:,hideInTranscript:[^}]+)?\}\)/
    );
    if (!thinkingRendererMatch) {
      index = redactedStart + redactedNeedle.length;
      continue;
    }

    const renderCall = thinkingRendererMatch[1];
    const thinkingComponent = thinkingRendererMatch[2];
    const addMarginVar = thinkingRendererMatch[3];
    const paramVar = thinkingRendererMatch[4];
    const hideInTranscriptProp = thinkingRendererMatch[0].includes("hideInTranscript:")
      ? ",hideInTranscript:!1"
      : "";

    candidates += 1;

    const replacement =
      `case"redacted_thinking":{return ${renderCall}(${thinkingComponent},{` +
      `addMargin:${addMarginVar},param:{type:"thinking",thinking:${paramVar}.data??""},` +
      `isTranscriptMode:!0,verbose:!0${hideInTranscriptProp}})}`;

    if (redactedSegment !== replacement) {
      output = output.slice(0, redactedStart) + replacement + output.slice(thinkingStart);
      patched += 1;
      index = redactedStart + replacement.length + thinkingNeedle.length;
      continue;
    }

    index = redactedStart + redactedNeedle.length;
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

  const turnStreamSelectionPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(((?:[A-Za-z_$][\w$]*|\([A-Za-z_$][\w$]*\?[A-Za-z_$][\w$]*:[A-Za-z_$][\w$]*\)))\?\.stream,([A-Za-z_$][\w$]*)\)\?\?([A-Za-z_$][\w$]*),/g;
  let turnStreamSelectionMatch;
  while ((turnStreamSelectionMatch = turnStreamSelectionPattern.exec(output)) !== null) {
    const streamingToolUsesVar = turnStreamSelectionMatch[1];
    const selectorHook = turnStreamSelectionMatch[2];
    const turnVar = turnStreamSelectionMatch[3];
    const fnStart = output.lastIndexOf("function ", turnStreamSelectionMatch.index);
    const fnEnd = output.indexOf("function ", turnStreamSelectionMatch.index + turnStreamSelectionMatch[0].length);
    if (fnStart === -1 || fnEnd === -1) {
      continue;
    }

    const wrapperSegment = output.slice(fnStart, fnEnd);
    if (!wrapperSegment.includes(`streamingToolUses:${streamingToolUsesVar},`)) {
      continue;
    }

    const rendererSignaturePattern =
      /(streamingToolUses:[A-Za-z_$][\w$]*,)((?:showAllInTranscript|isLoading):)/;
    if (!rendererSignaturePattern.test(output)) {
      continue;
    }

    const streamingThinkingVar = "__cc_streamingThinking";
    let nextWrapperSegment = wrapperSegment.replace(
      turnStreamSelectionMatch[0],
      `${turnStreamSelectionMatch[0]}${streamingThinkingVar}=${selectorHook}(${turnVar}?.stream,(__cc_state)=>__cc_state.streamingThinking)??null,`
    );
    nextWrapperSegment = nextWrapperSegment.replace(
      `streamingToolUses:${streamingToolUsesVar},`,
      `streamingToolUses:${streamingToolUsesVar},streamingThinking:${streamingThinkingVar},`
    );

    const propIndex = nextWrapperSegment.indexOf(`streamingThinking:${streamingThinkingVar},`);
    const cacheIfIndex = nextWrapperSegment.lastIndexOf("if(", propIndex);
    if (propIndex === -1 || cacheIfIndex === -1 || propIndex - cacheIfIndex > 1200) {
      continue;
    }
    nextWrapperSegment =
      nextWrapperSegment.slice(0, cacheIfIndex + 3) +
      "!0||" +
      nextWrapperSegment.slice(cacheIfIndex + 3);

    let nextOutput = output.slice(0, fnStart) + nextWrapperSegment + output.slice(fnEnd);
    nextOutput = nextOutput.replace(
      rendererSignaturePattern,
      `$1streamingThinking:${streamingThinkingVar},$2`
    );
    if (nextOutput !== output) {
      candidates += 1;
      patched += 1;
      output = nextOutput;
      turnStreamSelectionPattern.lastIndex = fnStart + nextWrapperSegment.length;
    }
  }

  let propCandidates = 0;
  let propPatched = 0;
  const identifierPattern = "[A-Za-z_$][\\w$]*";
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let streamingVar =
    output.match(/hidePastThinking:!0,streamingThinking:([A-Za-z_$][\w$]*)/)?.[1] ??
    output.match(
      /streamingToolUses:[A-Za-z_$][\w$]*,streamingThinking:([A-Za-z_$][\w$]*),(?:userInputOnProcessing|isLoading):/
    )?.[1] ??
    null;

  if (streamingVar === null) {
    const onStreamingThinkingPattern = /onStreamingThinking:([A-Za-z_$][\w$]*)/g;
    let onStreamingThinkingMatch;
    while ((onStreamingThinkingMatch = onStreamingThinkingPattern.exec(output)) !== null) {
      const setStreamingThinkingVar = onStreamingThinkingMatch[1];
      const anchor = onStreamingThinkingMatch.index;
      const searchStart = Math.max(0, anchor - 50000);
      const searchSegment = output.slice(searchStart, anchor);
      const statePattern = new RegExp(
        `\\[(${identifierPattern}),${escapeRegExp(setStreamingThinkingVar)}\\]=${identifierPattern}\\.useState\\(null\\)`,
        "g"
      );
      let stateMatch;
      while ((stateMatch = statePattern.exec(searchSegment)) !== null) {
        streamingVar = stateMatch[1];
      }
      if (streamingVar !== null) {
        break;
      }
    }
  }

  if (streamingVar === null) {
    const streamSnapshotPattern =
      /(\{streamingToolUses:[A-Za-z_$][\w$]*,)(userInputOnProcessing:[A-Za-z_$][\w$]*\}=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.stream\))/;
    output = output.replace(streamSnapshotPattern, (full, beforeUserInput, userInputAndHook) => {
      propCandidates += 1;
      streamingVar = "__cc_streamingThinking";
      const replacement =
        `${beforeUserInput}streamingThinking:${streamingVar},${userInputAndHook}`;
      if (replacement !== full) {
        propPatched += 1;
        return replacement;
      }
      return full;
    });
  }

  if (streamingVar !== null) {
    const createElementCallPattern = /createElement\(([A-Za-z_$][\w$]*),\{([^{}]*?)\}\)/g;
    const promptRendererCallPattern =
      /createElement\(([A-Za-z_$][\w$]*),\{([\s\S]{0,2000}?placeholderElement:[\s\S]{0,2000}?agentDefinitions:[^}]*?onOpenRateLimitOptions:[^}]*?isLoading:)([^,}]+)(,streamingText:[^}]*?(?:showThinkingHint:[^}]*?)?isBriefOnly:[^}]*?)\}\)/g;
    const jsxMainRendererPropsPattern =
      /(screen:[^,}]+,streamingToolUses:[^,}]+,)(showAllInTranscript:[^,}]+,agentDefinitions:[^,}]+,onOpenRateLimitOptions:[^,}]+,isLoading:[^,}]+)/g;
    const jsxMainRendererWithoutShowAllPropsPattern =
      /(screen:[^,}]+,streamingToolUses:[^,}]+,)(agentDefinitions:[^,}]+,onOpenRateLimitOptions:[^,}]+,onRateLimitAutoQueueContinue:[^,}]+,isLoading:[^,}]+,hasStreamingText:[^,}]+,streamingPreview:[^,}]+,isBriefOnly:[^,}]+)/g;
    const jsxTranscriptRendererPropsPattern =
      /(screen:[^,}]+,agentDefinitions:[^,}]+,streamingToolUses:[^,}]+,)(showAllInTranscript:[^,}]+,onOpenRateLimitOptions:[^,}]+,isLoading:[^,}]+)/g;
    const jsxStreamStoreMainRendererPropsPattern =
      /(screen:[^,}]+,streamingToolUses:[^,}]+,)(onOpenRateLimitOptions:[^,}]+,onRateLimitAutoQueueContinue:[^,}]+,isLoading:[^,}]+,hasStreamingText:[^,}]+,streamingPreview:[^,}]+,isBriefOnly:[^,}]+)/g;
    const jsxStreamStoreTranscriptRendererPropsPattern =
      /(screen:[^,}]+,streamingToolUses:[^,}]+,)(showAllInTranscript:[^,}]+,onOpenRateLimitOptions:[^,}]+,onRateLimitAutoQueueContinue:[^,}]+,isLoading:[^,}]+)/g;
    const jsxStreamStoreTranscriptWrapperPropsPattern =
      /(focused:[^,}]+,tools:[^,}]+,commands:[^,}]+,streamingToolUses:[^,}]+,)(isLoading:[^,}]+,onOpenRateLimitOptions:[^,}]+,onRateLimitAutoQueueContinue:[^,}]+)/g;

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
      if (!props.includes("conversationId:") || !props.includes("isLoading:")) {
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

    output = output.replace(
      promptRendererCallPattern,
      (full, component, beforeIsLoadingValue, isLoadingValue, afterIsLoadingValue) => {
        if (full.includes("streamingThinking:")) {
          return full;
        }

        propCandidates += 1;
        const replacement = `createElement(${component},{${beforeIsLoadingValue}${isLoadingValue},streamingThinking:${streamingVar}${afterIsLoadingValue}})`;
        if (replacement !== full) {
          propPatched += 1;
          return replacement;
        }
        return full;
      }
    );

    const injectStreamingThinking = (full, before, after) => {
      if (full.includes("streamingThinking:")) {
        return full;
      }

      propCandidates += 1;
      const replacement = `${before}streamingThinking:${streamingVar},${after}`;
      if (replacement !== full) {
        propPatched += 1;
        return replacement;
      }
      return full;
    };

    output = output.replace(jsxMainRendererPropsPattern, injectStreamingThinking);
    output = output.replace(
      jsxMainRendererWithoutShowAllPropsPattern,
      injectStreamingThinking
    );
    output = output.replace(jsxTranscriptRendererPropsPattern, injectStreamingThinking);
    output = output.replace(jsxStreamStoreMainRendererPropsPattern, injectStreamingThinking);
    output = output.replace(jsxStreamStoreTranscriptRendererPropsPattern, injectStreamingThinking);
    output = output.replace(jsxStreamStoreTranscriptWrapperPropsPattern, injectStreamingThinking);

    const transcriptRendererCachePattern = new RegExp(
      `if\\([^;]{0,2000}\\)(${identifierPattern})=(${identifierPattern})\\.jsx\\((${identifierPattern}),\\{` +
        `([^{}]{0,2000}?screen:"transcript",[^{}]{0,1000}?streamingThinking:${escapeRegExp(streamingVar)}[^{}]{0,1000}?)` +
        `\\}\\)(?:,[^;]{0,2000});else \\1=(${identifierPattern})\\[\\d+\\]`,
      "g"
    );
    output = output.replace(
      transcriptRendererCachePattern,
      (_full, elementVar, reactNs, component, props) => {
        propCandidates += 1;
        propPatched += 1;
        return `${elementVar}=${reactNs}.jsx(${component},{${props}})`;
      }
    );
  }

  candidates += propCandidates;
  patched += propPatched;

  // Newer builds can enable thinking without actually requesting
  // summarized display text. In that case the UI only gets signature-only
  // thinking blocks and falls back to the placeholder hint row. Default the
  // request display mode to "summarized" when upstream leaves it unset.
  let displayCandidates = 0;
  let displayPatched = 0;
  const thinkingDisplayPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.type!=="disabled"&&!([A-Za-z_$][\w$]*)\(process\.env\.CLAUDE_CODE_DISABLE_THINKING\),([A-Za-z_$][\w$]*)=\1(?:&&[A-Za-z_$][\w$]*\(\)&&[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\))?\?\2\.display(?:\?\?void 0)?:void 0,([A-Za-z_$][\w$]*)=void 0;/g;
  output = output.replace(
    thinkingDisplayPattern,
    (full, enabledVar, thinkingConfigVar, envFlagHelper, displayVar, requestVar) => {
      displayCandidates += 1;
      if (full.includes('display??"summarized"')) {
        return full;
      }

      const replacement =
        `${enabledVar}=${thinkingConfigVar}.type!=="disabled"&&!${envFlagHelper}(process.env.CLAUDE_CODE_DISABLE_THINKING),` +
        `${displayVar}=${enabledVar}?${thinkingConfigVar}.display??"summarized":void 0,${requestVar}=void 0;`;
      if (replacement !== full) {
        displayPatched += 1;
        return replacement;
      }
      return full;
    }
  );
  const thinkingDisplayCachedFlagPattern = new RegExp(
    `(${identifierPattern})=(${identifierPattern})\\(process\\.env\\.CLAUDE_CODE_DISABLE_THINKING\\),` +
      `(${identifierPattern})=(${identifierPattern})\\.type!=="disabled"&&!\\1,` +
      `(${identifierPattern})=\\3((?:&&${identifierPattern}\\(\\)&&${identifierPattern}\\(${identifierPattern}\\))?)\\?\\4\\.display(?:\\?\\?void 0)?:void 0,` +
      `(${identifierPattern})=void 0;`,
    "g"
  );
  output = output.replace(
    thinkingDisplayCachedFlagPattern,
    (
      full,
      disableThinkingVar,
      envFlagHelper,
      enabledVar,
      thinkingConfigVar,
      displayVar,
      displayGuards,
      requestVar
    ) => {
      displayCandidates += 1;
      if (full.includes('display??"summarized"')) {
        return full;
      }

      const replacement =
        `${disableThinkingVar}=${envFlagHelper}(process.env.CLAUDE_CODE_DISABLE_THINKING),` +
        `${enabledVar}=${thinkingConfigVar}.type!=="disabled"&&!${disableThinkingVar},` +
        `${displayVar}=${enabledVar}${displayGuards}?${thinkingConfigVar}.display??"summarized":void 0,` +
        `${requestVar}=void 0;`;
      if (replacement !== full) {
        displayPatched += 1;
        return replacement;
      }
      return full;
    }
  );
  const thinkingDisplayEligibilityPattern = new RegExp(
    `(${identifierPattern})=(${identifierPattern})\\(process\\.env\\.CLAUDE_CODE_DISABLE_THINKING\\),` +
      `(${identifierPattern})=(${identifierPattern})\\.type!=="disabled"&&!\\1,` +
      `(${identifierPattern})=\\3((?:&&${identifierPattern}\\(\\)&&${identifierPattern}\\(${identifierPattern}\\))),` +
      `(${identifierPattern})=\\5\\?\\4\\.display(?:\\?\\?void 0)?:void 0,` +
      `(${identifierPattern})=void 0;`,
    "g"
  );
  output = output.replace(
    thinkingDisplayEligibilityPattern,
    (
      full,
      disableThinkingVar,
      envFlagHelper,
      enabledVar,
      thinkingConfigVar,
      displayEligibleVar,
      displayGuards,
      displayVar,
      requestVar
    ) => {
      displayCandidates += 1;
      if (full.includes('display??"summarized"')) {
        return full;
      }

      const replacement =
        `${disableThinkingVar}=${envFlagHelper}(process.env.CLAUDE_CODE_DISABLE_THINKING),` +
        `${enabledVar}=${thinkingConfigVar}.type!=="disabled"&&!${disableThinkingVar},` +
        `${displayEligibleVar}=${enabledVar}${displayGuards},` +
        `${displayVar}=${displayEligibleVar}?${thinkingConfigVar}.display??"summarized":void 0,` +
        `${requestVar}=void 0;`;
      if (replacement !== full) {
        displayPatched += 1;
        return replacement;
      }
      return full;
    }
  );
  candidates += displayCandidates;
  patched += displayPatched;

  let redactedSummaryCandidates = 0;
  let redactedSummaryPatched = 0;
  const assistantThinkingPattern =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.message\.content\.find\(\(([A-Za-z_$][\w$]*)\)=>\3\.type==="thinking"\);if\(\1&&\1\.type==="thinking"\)([A-Za-z_$][\w$]*)\?\.\(\(\)=>\(\{thinking:\1\.thinking,isStreaming:!1,streamingEndedAt:Date\.now\(\)\}\)\)/g;
  output = output.replace(
    assistantThinkingPattern,
    (_full, blockVar, messageVar, itemVar, setStreamingVar) => {
      redactedSummaryCandidates += 1;
      redactedSummaryPatched += 1;
      return `let ${blockVar}=${messageVar}.message.content.find((${itemVar})=>${itemVar}.type==="thinking"||${itemVar}.type==="redacted_thinking");if(${blockVar}&&(${blockVar}.type==="thinking"||${blockVar}.type==="redacted_thinking"))${setStreamingVar}?.(()=>({thinking:${blockVar}.type==="thinking"?${blockVar}.thinking:${blockVar}.data??"",isStreaming:!1,streamingEndedAt:Date.now()}))`;
    }
  );
  candidates += redactedSummaryCandidates;
  patched += redactedSummaryPatched;

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
  const promptLingerPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.useMemo\(\(\)=>\{if\(!([A-Za-z_$][\w$]*)\)return!1;if\(\3\.isStreaming\)return!0;if\(\3\.streamingEndedAt\)return Date\.now\(\)-\3\.streamingEndedAt<30000;return!1\},\[\3\]\)/g;
  output = output.replace(promptLingerPattern, (_full, visibleVar, reactNs, streamVar) => {
    lingerCandidates += 1;
    lingerPatched += 1;
    return `${visibleVar}=${reactNs}.useMemo(()=>!!(${streamVar}&&${streamVar}.isStreaming),[${streamVar}])`;
  });
  const streamStoreLingerPattern =
    /if\(([A-Za-z_$][\w$]*)&&!\1\.isStreaming&&\1\.streamingEndedAt\)\{let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*-\(Date\.now\(\)-\1\.streamingEndedAt\);if\(\2>0\)this\._cancelThinkingHide=this\._scheduleTimeout\(\(\)=>\{this\._cancelThinkingHide=null,this\.setStreamingThinking\(null\)\},\2\);else this\.setStreamingThinking\(null\)\}/g;
  output = output.replace(streamStoreLingerPattern, (_full, streamVar) => {
    lingerCandidates += 1;
    lingerPatched += 1;
    return `if(${streamVar}&&!${streamVar}.isStreaming&&${streamVar}.streamingEndedAt)this.setStreamingThinking(null)`;
  });
  candidates += lingerCandidates;
  patched += lingerPatched;

  const transcriptToolUseHelpersMatch = output.match(
    /let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\(\{content:\[[A-Za-z_$][\w$]*\.contentBlock\]\}\);return [A-Za-z_$][\w$]*\.uuid=([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.contentBlock\.id,0\),([A-Za-z_$][\w$]*)\(\[[A-Za-z_$][\w$]*\]\)/
  );
  const virtualMessageHelperMatch = output.match(
    /function ([A-Za-z_$][\w$]*)\(\{content:[^}]*isVirtual:[^}]*uuid:[^}]*\}\)\{return [A-Za-z_$][\w$]*\([\s\S]{0,500}?isVirtual:/
  );
  let createVirtualMessageHelper =
    transcriptToolUseHelpersMatch?.[1] ?? virtualMessageHelperMatch?.[1] ?? null;
  let transcriptStreamingThinkingVar = null;
  const rendererStreamingThinkingMatch =
    output.match(
      /\(\{messages:[^}]*?streamingToolUses:[A-Za-z_$][\w$]*,streamingThinking:([A-Za-z_$][\w$]*),(?:showAllInTranscript|isLoading):/
    ) ??
    output.match(
      /\{messages:[^}]*?streamingToolUses:[A-Za-z_$][\w$]*,streamingThinking:([A-Za-z_$][\w$]*),(?:showAllInTranscript|isLoading):[^}]*\}=[A-Za-z_$][\w$]*/
    );
  if (rendererStreamingThinkingMatch) {
    transcriptStreamingThinkingVar = rendererStreamingThinkingMatch[1];
  } else if (streamingVar !== null) {
    const rendererSignaturePattern =
      /(\(\{messages:[^}]*?streamingToolUses:[A-Za-z_$][\w$]*,)((?:showAllInTranscript|isLoading):)/;
    output = output.replace(rendererSignaturePattern, (full, beforeStreamingThinking, afterStreamingThinking) => {
      if (full.includes("streamingThinking:")) {
        return full;
      }
      candidates += 1;
      patched += 1;
      transcriptStreamingThinkingVar = "__cc_streamingThinking";
      return `${beforeStreamingThinking}streamingThinking:${transcriptStreamingThinkingVar},${afterStreamingThinking}`;
    });
  }

  const transcriptStreamingThinkingMatch = output.match(
    /streamingToolUses:[A-Za-z_$][\w$]*,[^}]*streamingThinking:([A-Za-z_$][\w$]*),streamingText:/
  );
  if (transcriptStreamingThinkingVar === null) {
    transcriptStreamingThinkingVar = transcriptStreamingThinkingMatch?.[1] ?? null;
  }
  if (transcriptStreamingThinkingVar) {
    let inlineThinkingCandidates = 0;
    let inlineThinkingPatched = 0;
    const inlineThinkingPattern =
      /([A-Za-z_$][\w$]*)=((?:[A-Za-z_$][\w$]*\.useMemo|[A-Za-z_$][\w$]*))\(\(\)=>([A-Za-z_$][\w$]*)\.flatMap\(\(([A-Za-z_$][\w$]*)\)=>\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{content:\[\4\.contentBlock\]\}\);return \5\.uuid=([A-Za-z_$][\w$]*)\(\4\.contentBlock\.id,0\),([A-Za-z_$][\w$]*)\(\[\5\]\)\}\),\[\3\]\)/g;
    output = output.replace(
      inlineThinkingPattern,
      (
        _full,
        extrasVar,
        memoCall,
        streamingToolUsesVar,
        toolUseEntryVar,
        toolUseMessageVar,
        createMessageHelper,
        createUUIDHelper,
        normalizeMessagesHelper
      ) => {
        inlineThinkingCandidates += 1;
        inlineThinkingPatched += 1;
        createVirtualMessageHelper = createMessageHelper;
        return `${extrasVar}=${memoCall}(()=>{let __cc_streamingToolUseExtras=${streamingToolUsesVar}.map((${toolUseEntryVar})=>{let ${toolUseMessageVar}=${createMessageHelper}({content:[${toolUseEntryVar}.contentBlock]});return ${toolUseMessageVar}.uuid=${createUUIDHelper}(${toolUseEntryVar}.contentBlock.id,0),{index:${toolUseEntryVar}.index??9007199254740991,messages:${normalizeMessagesHelper}([${toolUseMessageVar}])}}),__cc_streamingThinkingExtras=(${transcriptStreamingThinkingVar}?.messages??[]).map((__cc_entry,__cc_index)=>({index:__cc_entry.index??9007199254740991+__cc_index,messages:${normalizeMessagesHelper}([__cc_entry.message??__cc_entry])}));return[...__cc_streamingToolUseExtras,...__cc_streamingThinkingExtras].sort((__cc_a,__cc_b)=>__cc_a.index===__cc_b.index?0:__cc_a.index-__cc_b.index).flatMap((__cc_entry)=>__cc_entry.messages)},[${streamingToolUsesVar},${transcriptStreamingThinkingVar}])`;
      }
    );

    const dedupedInlineThinkingPattern =
      /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\(\)=>([A-Za-z_$][\w$]*)\.flatMap\(\(([A-Za-z_$][\w$]*)\)=>\{let\{id:([A-Za-z_$][\w$]*),minted:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\4\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{content:\[\6\?\{\.\.\.\4\.contentBlock,id:\5\}:\4\.contentBlock\]\}\);return \8\.uuid=\6\?\5:([A-Za-z_$][\w$]*)\(\5,0\),([A-Za-z_$][\w$]*)\(\[\8\]\)\}\),\[\3,\7\]\)/g;
    output = output.replace(
      dedupedInlineThinkingPattern,
      (
        _full,
        extrasVar,
        memoCall,
        streamingToolUsesVar,
        toolUseEntryVar,
        toolUseIdVar,
        mintedVar,
        resolveToolUseIdHelper,
        toolUseMessageVar,
        createMessageHelper,
        createUUIDHelper,
        normalizeMessagesHelper
      ) => {
        inlineThinkingCandidates += 1;
        inlineThinkingPatched += 1;
        createVirtualMessageHelper = createMessageHelper;
        return `${extrasVar}=${memoCall}(()=>{let __cc_streamingToolUseExtras=${streamingToolUsesVar}.map((${toolUseEntryVar})=>{let{id:${toolUseIdVar},minted:${mintedVar}}=${resolveToolUseIdHelper}(${toolUseEntryVar}),${toolUseMessageVar}=${createMessageHelper}({content:[${mintedVar}?{...${toolUseEntryVar}.contentBlock,id:${toolUseIdVar}}:${toolUseEntryVar}.contentBlock]});return ${toolUseMessageVar}.uuid=${mintedVar}?${toolUseIdVar}:${createUUIDHelper}(${toolUseIdVar},0),{index:${toolUseEntryVar}.index??9007199254740991,messages:${normalizeMessagesHelper}([${toolUseMessageVar}])}}),__cc_streamingThinkingExtras=(${transcriptStreamingThinkingVar}?.messages??[]).map((__cc_entry,__cc_index)=>({index:__cc_entry.index??9007199254740991+__cc_index,messages:${normalizeMessagesHelper}([__cc_entry.message??__cc_entry])}));return[...__cc_streamingToolUseExtras,...__cc_streamingThinkingExtras].sort((__cc_a,__cc_b)=>__cc_a.index===__cc_b.index?0:__cc_a.index-__cc_b.index).flatMap((__cc_entry)=>__cc_entry.messages)},[${streamingToolUsesVar},${resolveToolUseIdHelper},${transcriptStreamingThinkingVar}])`;
      }
    );

    const compilerCachedToolExtrasPattern = new RegExp(
      `(${identifierPattern})=(${identifierPattern})\\.flatMap\\((${identifierPattern})\\);`,
      "g"
    );
    let compilerCachedToolExtrasMatch;
    while (
      (compilerCachedToolExtrasMatch = compilerCachedToolExtrasPattern.exec(output)) !== null
    ) {
      const [full, extrasVar, streamingToolUsesVar, renderToolUseVar] =
        compilerCachedToolExtrasMatch;
      const matchIndex = compilerCachedToolExtrasMatch.index;
      const searchStart = Math.max(0, matchIndex - 1800);
      const precedingSegment = output.slice(searchStart, matchIndex);
      const renderToolUsePattern = new RegExp(
        `${escapeRegExp(renderToolUseVar)}=\\((${identifierPattern})\\)=>\\{` +
          `[\\s\\S]{0,1200}?\\.contentBlock[\\s\\S]{0,1200}?` +
          `return (${identifierPattern})\\.uuid=[\\s\\S]{0,600}?,(${identifierPattern})\\(\\[\\2\\]\\)\\}`
      );
      const renderToolUseMatch = precedingSegment.match(renderToolUsePattern);
      if (!renderToolUseMatch) {
        continue;
      }

      const normalizeMessagesHelper = renderToolUseMatch[3];
      const cachePrefix = `,${extrasVar};if(`;
      const cachePrefixIndex = output.lastIndexOf(cachePrefix, matchIndex);
      const cacheIfIndex = cachePrefixIndex + cachePrefix.length - "if(".length;
      if (cachePrefixIndex === -1 || matchIndex - cacheIfIndex > 1800) {
        continue;
      }

      inlineThinkingCandidates += 1;
      inlineThinkingPatched += 1;
      const replacement =
        `${extrasVar}=[...${streamingToolUsesVar}.map((__cc_entry)=>({index:__cc_entry.index??9007199254740991,messages:${renderToolUseVar}(__cc_entry)})),` +
        `...(${transcriptStreamingThinkingVar}?.messages??[]).map((__cc_entry,__cc_index)=>({index:__cc_entry.index??9007199254740991+__cc_index,messages:${normalizeMessagesHelper}([__cc_entry.message??__cc_entry])}))]` +
        `.sort((__cc_a,__cc_b)=>__cc_a.index===__cc_b.index?0:__cc_a.index-__cc_b.index).flatMap((__cc_entry)=>__cc_entry.messages);`;
      output =
        output.slice(0, cacheIfIndex + 3) +
        "!0||" +
        output.slice(cacheIfIndex + 3, matchIndex) +
        replacement +
        output.slice(matchIndex + full.length);
      compilerCachedToolExtrasPattern.lastIndex =
        matchIndex + replacement.length + "!0||".length;
    }
    candidates += inlineThinkingCandidates;
    patched += inlineThinkingPatched;
  }

  // The dedicated live thinking row sits outside the message flow, so when the
  // inline transcript extras are active it becomes a duplicate copy pinned at
  // the bottom. Suppress that extra row and keep streamed thinking inline.
  let liveRowCandidates = 0;
  let liveRowPatched = 0;
  const liveThinkingRowPattern =
    /([A-Za-z_$][\w$]*)&{2}([A-Za-z_$][\w$]*)&{2}!([A-Za-z_$][\w$]*)&{2}([A-Za-z_$][\w$]*)\.createElement\(([A-Za-z_$][\w$]*),\{marginTop:1\},\4\.createElement\(([A-Za-z_$][\w$]*),\{param:\{type:"thinking",thinking:\2\.thinking\},addMargin:!1,isTranscriptMode:!0,verbose:([A-Za-z_$][\w$]*),hideInTranscript:!1\}\)\)/g;
  output = output.replace(liveThinkingRowPattern, (_full) => {
    liveRowCandidates += 1;
    liveRowPatched += 1;
    return "null";
  });
  candidates += liveRowCandidates;
  patched += liveRowPatched;

  // Instead, the renderer materializes virtual thinking messages from
  // `streamingThinking.messages` inline with the other live transcript extras,
  // and the reducer patch below keeps that state in sync as blocks stream.

  const replaceSegmentNeedle = (segment, before, after) => {
    if (!segment.includes(before)) {
      return {
        segment,
        changed: false,
      };
    }

    return {
      segment: segment.replace(before, after),
      changed: true,
    };
  };

  const buildStreamingThinkingStartExpression = (
    eventParam,
    setStreamingThinkingParam,
    createMessageHelper
  ) =>
    `${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>{let __cc_streamingThinkingMessage=${createMessageHelper}({content:[${eventParam}.event.content_block.type==="redacted_thinking"?{type:"redacted_thinking",data:${eventParam}.event.content_block.data??""}:{type:"thinking",thinking:""}],isVirtual:!0}),__cc_nextStreamingThinkingMessages=[...(__cc_prevStreamingThinking?.messages??[]).filter((__cc_entry)=>__cc_entry.index!==${eventParam}.event.index),{index:${eventParam}.event.index,message:__cc_streamingThinkingMessage}];return{thinking:${eventParam}.event.content_block.type==="redacted_thinking"?${eventParam}.event.content_block.data??"":"",isStreaming:!0,streamingEndedAt:void 0,currentIndex:${eventParam}.event.index,currentMessage:__cc_streamingThinkingMessage,messages:__cc_nextStreamingThinkingMessages}})`;

  const buildStreamingThinkingDeltaStatement = (
    eventParam,
    setStreamingThinkingParam,
    createMessageHelper
  ) =>
    `${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>{let __cc_nextStreamingThinkingDelta=typeof ${eventParam}.event.delta.thinking==="string"?${eventParam}.event.delta.thinking:"",__cc_nextStreamingThinkingText=(__cc_prevStreamingThinking?.thinking??"")+__cc_nextStreamingThinkingDelta,__cc_nextStreamingThinkingIndex=__cc_prevStreamingThinking?.currentIndex??${eventParam}.event.index,__cc_nextStreamingThinkingMessage=${createMessageHelper}({content:[{type:"thinking",thinking:__cc_nextStreamingThinkingText}],isVirtual:!0}),__cc_nextStreamingThinkingMessages=[...(__cc_prevStreamingThinking?.messages??[]).filter((__cc_entry)=>__cc_entry.index!==__cc_nextStreamingThinkingIndex),{index:__cc_nextStreamingThinkingIndex,message:__cc_nextStreamingThinkingMessage}];return __cc_prevStreamingThinking?{...__cc_prevStreamingThinking,thinking:__cc_nextStreamingThinkingText,isStreaming:!0,streamingEndedAt:void 0,currentIndex:__cc_nextStreamingThinkingIndex,currentMessage:__cc_nextStreamingThinkingMessage,messages:__cc_nextStreamingThinkingMessages}:{thinking:__cc_nextStreamingThinkingText,isStreaming:!0,streamingEndedAt:void 0,currentIndex:${eventParam}.event.index,currentMessage:__cc_nextStreamingThinkingMessage,messages:[{index:${eventParam}.event.index,message:__cc_nextStreamingThinkingMessage}]}});`;

  // 2.1.138 moved the UI stream reducer to a destructured options-bag shape.
  // Patch it by semantic option names instead of assuming positional params.
  if (createVirtualMessageHelper !== null) {
    const destructuredStreamHandlerPattern =
      /function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let\{([^}]*onStreamingThinking:[A-Za-z_$][\w$]*[^}]*)\}=\2;/g;
    let destructuredMatch;
    while ((destructuredMatch = destructuredStreamHandlerPattern.exec(output)) !== null) {
      const eventParam = destructuredMatch[1];
      const optionsParam = destructuredMatch[2];
      const props = destructuredMatch[3];
      const propVar = (name) => {
        const match = props.match(new RegExp(`${name}:([A-Za-z_$][\\w$]*)`));
        return match?.[1] ?? null;
      };
      const setModeParam = propVar("onSetStreamMode");
      const setStreamingToolsParam = propVar("onStreamingToolUses");
      const setStreamingThinkingParam = propVar("onStreamingThinking");

      if (
        setModeParam === null ||
        setStreamingToolsParam === null ||
        setStreamingThinkingParam === null
      ) {
        continue;
      }

      const handlerStart = destructuredMatch.index;
      const handlerEnd = output.indexOf("function ", handlerStart + destructuredMatch[0].length);
      if (handlerEnd === -1) {
        continue;
      }

      const handlerSegment = output.slice(handlerStart, handlerEnd);
      if (
        !handlerSegment.includes(`type==="stream_request_start"`) ||
        !handlerSegment.includes(`case"thinking_delta"`) ||
        !handlerSegment.includes("content_block_start")
      ) {
        continue;
      }

      const requestStartBefore = `if(${eventParam}.type==="stream_request_start"){${setModeParam}("requesting");return}`;
      const requestStartAfter = `if(${eventParam}.type==="stream_request_start"){${setStreamingThinkingParam}?.(null),${setModeParam}("requesting");return}`;

      const messageStopBefore = `if(${eventParam}.event.type==="message_stop"){${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;
      const messageStopAfter = `if(${eventParam}.event.type==="message_stop"){${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;
      const messageStopFinalizeBefore = `if(${eventParam}.event.type==="message_stop"){${optionsParam}.displayTransform?.finalize(),${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;
      const messageStopFinalizeAfter = `if(${eventParam}.event.type==="message_stop"){${optionsParam}.displayTransform?.finalize(),${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;

      const thinkingStartBefore = `case"thinking":case"redacted_thinking":${setModeParam}("thinking");return;`;
      const thinkingStartAfter = `case"thinking":case"redacted_thinking":${buildStreamingThinkingStartExpression(
        eventParam,
        setStreamingThinkingParam,
        createVirtualMessageHelper
      )},${setModeParam}("thinking");return;`;

      const textStartBefore = `case"text":${setModeParam}("responding");return;`;
      const textStartAfter = `case"text":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");return;`;

      const messageDeltaIfBefore = `case"message_delta":if(${setModeParam}("responding"),${eventParam}.event.usage.output_tokens!=null)`;
      const messageDeltaIfAfter = `case"message_delta":if(${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding"),${eventParam}.event.usage.output_tokens!=null)`;
      const messageDeltaReturnBefore = `case"message_delta":${setModeParam}("responding");return;`;
      const messageDeltaReturnAfter = `case"message_delta":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");return;`;
      const messageDeltaBlockBefore = `case"message_delta":{${setModeParam}("responding");`;
      const messageDeltaBlockAfter = `case"message_delta":{${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");`;

      const thinkingDeltaBefore = `case"thinking_delta":return;`;
      const thinkingDeltaBody = buildStreamingThinkingDeltaStatement(
        eventParam,
        setStreamingThinkingParam,
        createVirtualMessageHelper
      );
      const thinkingDeltaAfter = `case"thinking_delta":{${thinkingDeltaBody}return;}`;
      const thinkingDeltaProgressPattern = new RegExp(
        `case"thinking_delta":\\{let\\{delta:([A-Za-z_$][\\w$]*)\\}=${eventParam}\\.event;if\\("estimated_tokens"in \\1&&typeof \\1\\.estimated_tokens==="number"\\)([A-Za-z_$][\\w$]*)\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:\\1\\.estimated_tokens\\}\\);return\\}`
      );
      const thinkingDeltaProgressWithTextPattern = new RegExp(
        `case"thinking_delta":\\{let\\{delta:([A-Za-z_$][\\w$]*)\\}=${eventParam}\\.event;if\\("estimated_tokens"in \\1&&typeof \\1\\.estimated_tokens==="number"\\)([A-Za-z_$][\\w$]*)\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:\\1\\.estimated_tokens\\}\\);else if\\("thinking"in \\1&&typeof \\1\\.thinking==="string"&&\\1\\.thinking\\.length>0\\)\\2\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:([A-Za-z_$][\\w$]*)\\(\\1\\.thinking\\)\\}\\);return\\}`
      );

      const replacements = [
        [requestStartBefore, requestStartAfter],
        [messageStopFinalizeBefore, messageStopFinalizeAfter],
        [messageStopBefore, messageStopAfter],
        [thinkingStartBefore, thinkingStartAfter],
        [textStartBefore, textStartAfter],
        [messageDeltaIfBefore, messageDeltaIfAfter],
        [messageDeltaReturnBefore, messageDeltaReturnAfter],
        [messageDeltaBlockBefore, messageDeltaBlockAfter],
        [thinkingDeltaBefore, thinkingDeltaAfter],
      ];

      let nextHandlerSegment = handlerSegment;
      for (const [before, after] of replacements) {
        const result = replaceSegmentNeedle(nextHandlerSegment, before, after);
        if (!result.changed) {
          continue;
        }
        candidates += 1;
        nextHandlerSegment = result.segment;
        if (nextHandlerSegment.includes(after)) {
          patched += 1;
        }
      }

      const nextThinkingDeltaProgressSegment = nextHandlerSegment.replace(
        thinkingDeltaProgressPattern,
        (_full, deltaVar, metricsVar) => {
          return `case"thinking_delta":{${thinkingDeltaBody}let{delta:${deltaVar}}=${eventParam}.event;if("estimated_tokens"in ${deltaVar}&&typeof ${deltaVar}.estimated_tokens==="number")${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${deltaVar}.estimated_tokens});return}`;
        }
      );
      if (nextThinkingDeltaProgressSegment !== nextHandlerSegment) {
        candidates += 1;
        patched += 1;
        nextHandlerSegment = nextThinkingDeltaProgressSegment;
      }
      const nextThinkingDeltaProgressWithTextSegment = nextHandlerSegment.replace(
        thinkingDeltaProgressWithTextPattern,
        (_full, deltaVar, metricsVar, estimateHelper) => {
          return `case"thinking_delta":{${thinkingDeltaBody}let{delta:${deltaVar}}=${eventParam}.event;if("estimated_tokens"in ${deltaVar}&&typeof ${deltaVar}.estimated_tokens==="number")${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${deltaVar}.estimated_tokens});else if("thinking"in ${deltaVar}&&typeof ${deltaVar}.thinking==="string"&&${deltaVar}.thinking.length>0)${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${estimateHelper}(${deltaVar}.thinking)});return}`;
        }
      );
      if (nextThinkingDeltaProgressWithTextSegment !== nextHandlerSegment) {
        candidates += 1;
        patched += 1;
        nextHandlerSegment = nextThinkingDeltaProgressWithTextSegment;
      }

      if (nextHandlerSegment !== handlerSegment) {
        output = output.slice(0, handlerStart) + nextHandlerSegment + output.slice(handlerEnd);
        destructuredStreamHandlerPattern.lastIndex = handlerStart + nextHandlerSegment.length;
      }
    }
  }

  // 2.1.183 keeps onStreamingThinking on the outer dispatcher but moves the
  // stream-event switch into an inner handler that omits it from destructuring.
  // Re-introduce the option there, then patch the same semantic stream cases.
  if (createVirtualMessageHelper !== null) {
    const missingStreamingThinkingHandlerPattern =
      /function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)(?:,[A-Za-z_$][\w$]*)?\)\{let\{([^}]*)\}=\2([;,])/g;
    let missingStreamingThinkingMatch;
    while ((missingStreamingThinkingMatch = missingStreamingThinkingHandlerPattern.exec(output)) !== null) {
      const eventParam = missingStreamingThinkingMatch[1];
      const optionsParam = missingStreamingThinkingMatch[2];
      const props = missingStreamingThinkingMatch[3];
      const declarationSeparator = missingStreamingThinkingMatch[4];
      if (props.includes("onStreamingThinking:")) {
        continue;
      }

      const propVar = (name) => {
        const aliasMatch = props.match(new RegExp(`${name}:(${identifierPattern})`));
        if (aliasMatch) {
          return aliasMatch[1];
        }
        const shorthandMatch = props.match(new RegExp(`(?:^|,)${name}(?:,|$)`));
        return shorthandMatch ? name : null;
      };
      const setModeParam = propVar("onSetStreamMode");
      const setStreamingToolsParam = propVar("onStreamingToolUses");
      const displayTransformParam = propVar("displayTransform");
      const setStreamingThinkingParam = "__cc_onStreamingThinking";

      if (setModeParam === null || setStreamingToolsParam === null) {
        continue;
      }

      const handlerStart = missingStreamingThinkingMatch.index;
      const handlerEnd = output.indexOf("function ", handlerStart + missingStreamingThinkingMatch[0].length);
      if (handlerEnd === -1) {
        continue;
      }

      const handlerSegment = output.slice(handlerStart, handlerEnd);
      if (
        !handlerSegment.includes(`type==="stream_request_start"`) ||
        !handlerSegment.includes(`case"thinking_delta"`) ||
        !handlerSegment.includes("content_block_start")
      ) {
        continue;
      }

      const thinkingDeltaBody = buildStreamingThinkingDeltaStatement(
        eventParam,
        setStreamingThinkingParam,
        createVirtualMessageHelper
      );

      const replacements = [
        [
          `let{${props}}=${optionsParam}${declarationSeparator}`,
          `let{${props},onStreamingThinking:${setStreamingThinkingParam}}=${optionsParam}${declarationSeparator}`,
        ],
        [
          `if(${eventParam}.type==="stream_request_start"){${setModeParam}("requesting");return}`,
          `if(${eventParam}.type==="stream_request_start"){${setStreamingThinkingParam}?.(null),${setModeParam}?.("requesting");return}`,
        ],
        [
          `if(${eventParam}.type==="stream_request_start"){${setModeParam}?.("requesting");return}`,
          `if(${eventParam}.type==="stream_request_start"){${setStreamingThinkingParam}?.(null),${setModeParam}?.("requesting");return}`,
        ],
        [
          `if(${eventParam}.event.type==="message_stop"){${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`,
          `if(${eventParam}.event.type==="message_stop"){${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]);return}`,
        ],
        [
          `if(${eventParam}.event.type==="message_stop"){${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]);return}`,
          `if(${eventParam}.event.type==="message_stop"){${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]);return}`,
        ],
        [
          `case"thinking":case"redacted_thinking":${setModeParam}("thinking");return;`,
          `case"thinking":case"redacted_thinking":${buildStreamingThinkingStartExpression(
            eventParam,
            setStreamingThinkingParam,
            createVirtualMessageHelper
          )},${setModeParam}?.("thinking");return;`,
        ],
        [
          `case"thinking":case"redacted_thinking":${setModeParam}?.("thinking");return;`,
          `case"thinking":case"redacted_thinking":${buildStreamingThinkingStartExpression(
            eventParam,
            setStreamingThinkingParam,
            createVirtualMessageHelper
          )},${setModeParam}?.("thinking");return;`,
        ],
        [
          `case"text":${setModeParam}("responding");return;`,
          `case"text":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("responding");return;`,
        ],
        [
          `case"text":${setModeParam}?.("responding");return;`,
          `case"text":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("responding");return;`,
        ],
        [
          `case"message_delta":${setModeParam}("responding");return;`,
          `case"message_delta":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("responding");return;`,
        ],
        [
          `case"message_delta":${setModeParam}?.("responding");return;`,
          `case"message_delta":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("responding");return;`,
        ],
        [
          `case"message_delta":{${setModeParam}("responding");`,
          `case"message_delta":{${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("responding");`,
        ],
        [
          `case"message_delta":{${setModeParam}?.("responding");`,
          `case"message_delta":{${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("responding");`,
        ],
        [
          `case"thinking_delta":return;`,
          `case"thinking_delta":{${thinkingDeltaBody}return;}`,
        ],
      ];

      if (displayTransformParam !== null) {
        replacements.push(
          [
            `if(${eventParam}.event.type==="message_stop"){${displayTransformParam}.finalize(),${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`,
            `if(${eventParam}.event.type==="message_stop"){${displayTransformParam}?.finalize(),${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]);return}`,
          ],
          [
            `if(${eventParam}.event.type==="message_stop"){${displayTransformParam}?.finalize(),${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]);return}`,
            `if(${eventParam}.event.type==="message_stop"){${displayTransformParam}?.finalize(),${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]);return}`,
          ]
        );
      }

      let nextHandlerSegment = handlerSegment;
      for (const [before, after] of replacements) {
        const result = replaceSegmentNeedle(nextHandlerSegment, before, after);
        if (!result.changed) {
          continue;
        }
        candidates += 1;
        nextHandlerSegment = result.segment;
        if (nextHandlerSegment.includes(after)) {
          patched += 1;
        }
      }

      if (displayTransformParam !== null) {
        const messageStopAuthoringProgressPattern = new RegExp(
          `if\\(${eventParam}\\.event\\.type==="message_stop"\\)\\{if\\(` +
            `${displayTransformParam}\\?\\.finalize\\(\\),` +
            `${setModeParam}\\?\\.\\("tool-use"\\),` +
            `${setStreamingToolsParam}\\?\\.\\(\\(\\)=>\\[\\]\\),` +
            `(${identifierPattern})\\)(${identifierPattern})\\.loaded\\(\\)\\?\\.resetAuthoringProgress\\(\\);return\\}`
        );
        const nextMessageStopSegment = nextHandlerSegment.replace(
          messageStopAuthoringProgressPattern,
          (_full, authoringProgressVar, authoringProgressModule) =>
            `if(${eventParam}.event.type==="message_stop"){if(` +
            `${displayTransformParam}?.finalize(),` +
            `${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),` +
            `${setModeParam}?.("tool-use"),${setStreamingToolsParam}?.(()=>[]),` +
            `${authoringProgressVar})${authoringProgressModule}.loaded()?.resetAuthoringProgress();return}`
        );
        if (nextMessageStopSegment !== nextHandlerSegment) {
          candidates += 1;
          patched += 1;
          nextHandlerSegment = nextMessageStopSegment;
        }
      }

      const thinkingDeltaProgressPattern = new RegExp(
        `case"thinking_delta":\\{let\\{delta:(${identifierPattern})\\}=${eventParam}\\.event;if\\("estimated_tokens"in \\1&&typeof \\1\\.estimated_tokens==="number"\\)(${identifierPattern})\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:\\1\\.estimated_tokens\\}\\);return\\}`
      );
      const thinkingDeltaProgressWithTextPattern = new RegExp(
        `case"thinking_delta":\\{let\\{delta:(${identifierPattern})\\}=${eventParam}\\.event;if\\("estimated_tokens"in \\1&&typeof \\1\\.estimated_tokens==="number"\\)(${identifierPattern})\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:\\1\\.estimated_tokens\\}\\);else if\\("thinking"in \\1&&typeof \\1\\.thinking==="string"&&\\1\\.thinking\\.length>0\\)\\2\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:(${identifierPattern})\\(\\1\\.thinking\\)\\}\\);return\\}`
      );

      const nextThinkingDeltaProgressSegment = nextHandlerSegment.replace(
        thinkingDeltaProgressPattern,
        (_full, deltaVar, metricsVar) => {
          return `case"thinking_delta":{${thinkingDeltaBody}let{delta:${deltaVar}}=${eventParam}.event;if("estimated_tokens"in ${deltaVar}&&typeof ${deltaVar}.estimated_tokens==="number")${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${deltaVar}.estimated_tokens});return}`;
        }
      );
      if (nextThinkingDeltaProgressSegment !== nextHandlerSegment) {
        candidates += 1;
        patched += 1;
        nextHandlerSegment = nextThinkingDeltaProgressSegment;
      }
      const nextThinkingDeltaProgressWithTextSegment = nextHandlerSegment.replace(
        thinkingDeltaProgressWithTextPattern,
        (_full, deltaVar, metricsVar, estimateHelper) => {
          return `case"thinking_delta":{${thinkingDeltaBody}let{delta:${deltaVar}}=${eventParam}.event;if("estimated_tokens"in ${deltaVar}&&typeof ${deltaVar}.estimated_tokens==="number")${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${deltaVar}.estimated_tokens});else if("thinking"in ${deltaVar}&&typeof ${deltaVar}.thinking==="string"&&${deltaVar}.thinking.length>0)${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${estimateHelper}(${deltaVar}.thinking)});return}`;
        }
      );
      if (nextThinkingDeltaProgressWithTextSegment !== nextHandlerSegment) {
        candidates += 1;
        patched += 1;
        nextHandlerSegment = nextThinkingDeltaProgressWithTextSegment;
      }

      if (nextHandlerSegment !== handlerSegment) {
        output = output.slice(0, handlerStart) + nextHandlerSegment + output.slice(handlerEnd);
        missingStreamingThinkingHandlerPattern.lastIndex = handlerStart + nextHandlerSegment.length;
      }
    }
  }

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
          const messageStopAfter = `if(${eventParam}.event.type==="message_stop"){${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:Date.now(),currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("tool-use"),${setStreamingToolsParam}(()=>[]);return}`;

          const thinkingStartBefore = `case"thinking":case"redacted_thinking":${setModeParam}("thinking");return;`;
          const thinkingStartAfter =
            createVirtualMessageHelper === null
              ? null
              : `case"thinking":case"redacted_thinking":${buildStreamingThinkingStartExpression(
                  eventParam,
                  setStreamingThinkingParam,
                  createVirtualMessageHelper
                )},${setModeParam}("thinking");return;`;

          const textStartBefore = `case"text":${setModeParam}("responding");return;`;
          const textStartAfter = `case"text":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");return;`;

          const messageDeltaBefore = `case"message_delta":${setModeParam}("responding");return;`;
          const messageDeltaAfter = `case"message_delta":${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");return;`;
          const messageDeltaBlockBefore = `case"message_delta":{${setModeParam}("responding");`;
          const messageDeltaBlockAfter = `case"message_delta":{${setStreamingThinkingParam}?.((__cc_prevStreamingThinking)=>__cc_prevStreamingThinking?{...__cc_prevStreamingThinking,isStreaming:!1,streamingEndedAt:void 0,currentIndex:null,currentMessage:null}:__cc_prevStreamingThinking),${setModeParam}("responding");`;

          const thinkingDeltaBefore = `case"thinking_delta":${appendOutputParam}(${eventParam}.event.delta.thinking);return;`;
          const thinkingDeltaBareBefore = `case"thinking_delta":return;`;
          const thinkingDeltaBody =
            createVirtualMessageHelper === null
              ? null
              : buildStreamingThinkingDeltaStatement(
                  eventParam,
                  setStreamingThinkingParam,
                  createVirtualMessageHelper
                );
          const thinkingDeltaAfter =
            thinkingDeltaBody === null
              ? null
              : `case"thinking_delta":{${appendOutputParam}(${eventParam}.event.delta.thinking);${thinkingDeltaBody}return;}`;
          const thinkingDeltaBareAfter =
            thinkingDeltaBody === null ? null : `case"thinking_delta":{${thinkingDeltaBody}return;}`;
          const thinkingDeltaProgressPattern =
            thinkingDeltaBody === null
              ? null
              : new RegExp(
                  `case"thinking_delta":\\{let\\{delta:([A-Za-z_$][\\w$]*)\\}=${eventParam}\\.event;if\\("estimated_tokens"in \\1&&typeof \\1\\.estimated_tokens==="number"\\)([A-Za-z_$][\\w$]*)\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:\\1\\.estimated_tokens\\}\\);return\\}`
                );
          const thinkingDeltaProgressWithTextPattern =
            thinkingDeltaBody === null
              ? null
              : new RegExp(
                  `case"thinking_delta":\\{let\\{delta:([A-Za-z_$][\\w$]*)\\}=${eventParam}\\.event;if\\("estimated_tokens"in \\1&&typeof \\1\\.estimated_tokens==="number"\\)([A-Za-z_$][\\w$]*)\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:\\1\\.estimated_tokens\\}\\);else if\\("thinking"in \\1&&typeof \\1\\.thinking==="string"&&\\1\\.thinking\\.length>0\\)\\2\\?\\.\\(\\{type:"thinking_progress",estimatedTokensDelta:([A-Za-z_$][\\w$]*)\\(\\1\\.thinking\\)\\}\\);return\\}`
                );

          const wg6Replacements = [
            [requestStartBefore, requestStartAfter],
            [messageStopBefore, messageStopAfter],
            [textStartBefore, textStartAfter],
            [messageDeltaBefore, messageDeltaAfter],
          ];
          if (thinkingStartAfter !== null) {
            wg6Replacements.splice(2, 0, [thinkingStartBefore, thinkingStartAfter]);
          }
          if (thinkingDeltaAfter !== null) {
            wg6Replacements.push([thinkingDeltaBefore, thinkingDeltaAfter]);
          }
          if (thinkingDeltaBareAfter !== null) {
            wg6Replacements.push([thinkingDeltaBareBefore, thinkingDeltaBareAfter]);
          }
          wg6Replacements.push([messageDeltaBlockBefore, messageDeltaBlockAfter]);

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

          if (thinkingDeltaProgressPattern !== null) {
            const nextThinkingDeltaProgressSegment = nextWg6Segment.replace(
              thinkingDeltaProgressPattern,
              (_full, deltaVar, metricsVar) => {
                return `case"thinking_delta":{${thinkingDeltaBody}let{delta:${deltaVar}}=${eventParam}.event;if("estimated_tokens"in ${deltaVar}&&typeof ${deltaVar}.estimated_tokens==="number")${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${deltaVar}.estimated_tokens});return}`;
              }
            );
            if (nextThinkingDeltaProgressSegment !== nextWg6Segment) {
              candidates += 1;
              patched += 1;
              nextWg6Segment = nextThinkingDeltaProgressSegment;
            }
          }
          if (thinkingDeltaProgressWithTextPattern !== null) {
            const nextThinkingDeltaProgressWithTextSegment = nextWg6Segment.replace(
              thinkingDeltaProgressWithTextPattern,
              (_full, deltaVar, metricsVar, estimateHelper) => {
                return `case"thinking_delta":{${thinkingDeltaBody}let{delta:${deltaVar}}=${eventParam}.event;if("estimated_tokens"in ${deltaVar}&&typeof ${deltaVar}.estimated_tokens==="number")${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${deltaVar}.estimated_tokens});else if("thinking"in ${deltaVar}&&typeof ${deltaVar}.thinking==="string"&&${deltaVar}.thinking.length>0)${metricsVar}?.({type:"thinking_progress",estimatedTokensDelta:${estimateHelper}(${deltaVar}.thinking)});return}`;
              }
            );
            if (nextThinkingDeltaProgressWithTextSegment !== nextWg6Segment) {
              candidates += 1;
              patched += 1;
              nextWg6Segment = nextThinkingDeltaProgressWithTextSegment;
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
  const livePromptMountPattern =
    /([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\.createElement\(m,\{marginBottom:1\},\3\.createElement\(([A-Za-z_$][\w$]*),\{prompt:\2\}\)\)/g;
  const livePromptEmptyStatePattern =
    /if\(([A-Za-z_$][\w$]*)\.length===0&&!?\(([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\)\)return/g;
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

  output = output.replace(livePromptMountPattern, (full, transcriptModeVar, promptVar, reactNs, promptComponent) => {
    candidates += 1;

    const replacement = `${promptVar}&&${reactNs}.createElement(m,{marginBottom:1},${reactNs}.createElement(${promptComponent},{prompt:${promptVar}}))`;
    if (!ctx.preserveLength) {
      if (full === replacement) {
        return full;
      }
      patched += 1;
      return replacement;
    }

    if (replacement.length > full.length) {
      return full;
    }

    patched += 1;
    return `${replacement}${" ".repeat(full.length - replacement.length)}`;
  });

  output = output.replace(livePromptEmptyStatePattern, (full, rowsVar, transcriptModeVar, promptVar) => {
    candidates += 1;

    const replacement = `if(${rowsVar}.length===0&&!${promptVar})return`;
    if (!ctx.preserveLength) {
      if (full === replacement) {
        return full;
      }
      patched += 1;
      return replacement;
    }

    if (replacement.length > full.length) {
      return full;
    }

    patched += 1;
    return `${replacement}${" ".repeat(full.length - replacement.length)}`;
  });

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchDisableSpinnerTips(content, ctx = {}) {
  const disabledGuardPattern = /if\([A-Za-z_$][\w$]*\(\)\.spinnerTipsEnabled===!1\)return;/g;
  const enabledExpressionPattern = /[A-Za-z_$][\w$]*\.spinnerTipsEnabled!==!1/g;
  const forcedReturn = "if(!0)return;";
  const forcedDisabled = "!1";

  let candidates = 0;
  let patched = 0;
  let output = content.replace(disabledGuardPattern, (full) => {
    candidates += 1;

    if (!ctx.preserveLength) {
      if (full === forcedReturn) {
        return full;
      }
      patched += 1;
      return forcedReturn;
    }

    if (forcedReturn.length > full.length) {
      return full;
    }

    patched += 1;
    return `${forcedReturn}${" ".repeat(full.length - forcedReturn.length)}`;
  });

  output = output.replace(enabledExpressionPattern, (full) => {
    candidates += 1;

    if (!ctx.preserveLength) {
      if (full === forcedDisabled) {
        return full;
      }
      patched += 1;
      return forcedDisabled;
    }

    if (forcedDisabled.length > full.length) {
      return full;
    }

    patched += 1;
    return `${forcedDisabled}${" ".repeat(full.length - forcedDisabled.length)}`;
  });

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

function patchVersionOutput(content) {
  const needle = "}.VERSION} (Claude Code)";
  const marker = "\\n(patched)";
  let candidates = 0;
  let patched = 0;
  let output = content;

  let index = output.indexOf(needle);
  while (index !== -1) {
    candidates += 1;

    const markerStart = index + needle.length;
    if (output.slice(markerStart, markerStart + marker.length) === marker) {
      index = output.indexOf(needle, markerStart + marker.length);
      continue;
    }

    output =
      output.slice(0, markerStart) +
      marker +
      output.slice(markerStart);
    patched += 1;
    index = output.indexOf(needle, markerStart + marker.length);
  }

  return {
    content: output,
    candidates,
    patched,
  };
}

function patchWelcomePatchedBadge(content) {
  let candidates = 0;
  let patched = 0;
  let output = content;

  output = output.replace(
    /([A-Za-z_$][\w$]*)\.createElement\(([A-Za-z_$][\w$]*),\{bold:!0\},"Claude Code"\)/g,
    (full, reactVar, textComponent) => {
      candidates += 1;
      const replacement = `${reactVar}.createElement(${textComponent},{bold:!0},"Connoisseur's Code")`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /([A-Za-z_$][\w$]*)\.(jsx|jsxs)\(([A-Za-z_$][\w$]*),\{bold:!0,children:"Claude Code"\}\)/g,
    (full, reactVar, jsxFactory, textComponent) => {
      candidates += 1;
      const replacement = `${reactVar}.${jsxFactory}(${textComponent},{bold:!0,children:"Connoisseur's Code"})`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{bold:!0,children:"Claude Code"\}\)/g,
    (full, jsxFactory, textComponent) => {
      candidates += 1;
      const replacement = `${jsxFactory}(${textComponent},{bold:!0,children:"Connoisseur's Code"})`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /title:(`Claude Code v\$\{[\s\S]*?\.VERSION\}`),color:"professionalBlue",defaultTab:"general"/g,
    (full, titleExpr) => {
      candidates += 1;
      const replacement = `title:${titleExpr}.replace("Claude Code","Connoisseur's Code"),color:"professionalBlue",defaultTab:"general"`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /"Welcome to Claude Code for "/g,
    (full) => {
      candidates += 1;
      const replacement = `"Welcome to Connoisseur's Code for "`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /"Welcome to Claude Code"/g,
    (full) => {
      candidates += 1;
      const replacement = `"Welcome to Connoisseur's Code"`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /(color:"claude",bold:!0,children:\[)"Claude Code"(," "\])/g,
    (full, prefix, suffix) => {
      candidates += 1;
      const replacement = `${prefix}"Connoisseur's Code"${suffix}`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /([A-Za-z_$][\w$]*)\("claude",([A-Za-z_$][\w$]*)\)\("Claude Code"\)/g,
    (full, colorFn, themeVar) => {
      candidates += 1;
      const replacement = `${colorFn}("claude",${themeVar})("Connoisseur's Code")`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  output = output.replace(
    /([A-Za-z_$][\w$]*)\("claude",([A-Za-z_$][\w$]*)\)\(" Claude Code "\)/g,
    (full, colorFn, themeVar) => {
      candidates += 1;
      const replacement = `${colorFn}("claude",${themeVar})(" Connoisseur's Code ")`;
      if (replacement !== full) {
        patched += 1;
        return replacement;
      }
      return full;
    }
  );

  return {
    content: output,
    candidates,
    patched,
  };
}

const PATCH_MODULES = [
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
    id: "redacted-thinking-inline",
    description: "Render redacted thinking summaries inline as thinking text",
    apply: patchRedactedThinkingSummaries,
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
    id: "disable-spinner-tips",
    description: "Disable spinner tips regardless of settings",
    apply: patchDisableSpinnerTips,
  },
  {
    id: "version-output",
    description: "Append (patched) to plain --version output",
    apply: patchVersionOutput,
  },
  {
    id: "installer-label",
    description: "Replace npm/native installer warning text with (patched)",
    apply: patchInstallerMigrationMessage,
  },
  {
    id: "welcome-badge",
    description: "Rename startup and help Claude Code titles to Connoisseur's Code",
    apply: patchWelcomePatchedBadge,
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

  const selected = new Set(PATCH_MODULES.map((module) => module.id));
  for (const id of enableSet) {
    selected.add(id);
  }
  for (const id of disableSet) {
    selected.delete(id);
  }

  return { selected };
}

function patchContents(contents, opts = {}) {
  const { selected } = resolveSelectedPatchIds({
    disable: opts.disable ?? [],
    enable: opts.enable ?? [],
  });
  let currentContents = [...contents];
  const patchResults = new Map();

  for (const module of PATCH_MODULES) {
    if (!selected.has(module.id)) {
      patchResults.set(module.id, {
        candidates: 0,
        patched: 0,
        skipped: true,
        reason: "disabled",
      });
      continue;
    }

    let candidates = 0;
    let patched = 0;
    currentContents = currentContents.map((content) => {
      const result = module.apply(content, { preserveLength: false });
      candidates += result.candidates;
      patched += result.patched;
      return result.content;
    });
    patchResults.set(module.id, {
      candidates,
      patched,
      skipped: false,
      reason: null,
    });
  }

  return { contents: currentContents, patchResults };
}

function printPatchSummary(patchResults) {
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
      console.log(`  ${module.id} - ${module.description}`);
    }
    process.exit(0);
  }

  let targetPath;
  try {
    targetPath = resolveTargetPath(opts);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  ensureFileExists(targetPath);
  const original = fs.readFileSync(targetPath, TARGET_FILE_ENCODING);
  let patchResult;
  try {
    patchResult = patchContents([original], opts);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  const nextContent = patchResult.contents[0];

  printPatchSummary(patchResult.patchResults);

  if (nextContent === original) {
    console.log("No changes needed.");
    process.exit(0);
  }

  if (opts.dryRun) {
    console.log("Dry run complete. No files changed.");
    process.exit(0);
  }

  fs.writeFileSync(targetPath, nextContent, TARGET_FILE_ENCODING);
  console.log(`Patched: ${targetPath}`);
}

module.exports = {
  patchContents,
  printPatchSummary,
};

if (require.main === module) {
  main();
}

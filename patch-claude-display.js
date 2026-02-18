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
  const installerPatch = patchInstallerMigrationMessage(thinkingPatch.content);
  const nextContent = installerPatch.content;

  console.log("Patch summary:");
  console.log(`  shebang candidates: ${shebangPatch.candidates}, patched: ${shebangPatch.patched}`);
  console.log(
    `  collapsed_read_search candidates: ${toolPatch.candidates}, patched: ${toolPatch.patched}`
  );
  console.log(`  thinking candidates: ${thinkingPatch.candidates}, patched: ${thinkingPatch.patched}`);
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

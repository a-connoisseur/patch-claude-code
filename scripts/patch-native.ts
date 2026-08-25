#!/usr/bin/env node

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { execFileSync } = require("node:child_process") as typeof import("node:child_process");

type PatchOptions = {
  input: string;
  output: string;
  disable: string[];
  enable: string[];
};

type BunModuleView = {
  index: number;
  name: string;
  contents: Buffer;
  loader: number;
  encoding: number;
  bytecodeLength: number;
};

type ModuleOverride = {
  contents?: Buffer;
  dropBytecode?: boolean;
};

type NativeBunModule = {
  canNativeBunHandle(binaryPath: string): boolean;
  readNativeBunContent(binaryPath: string): string;
  writeNativeBunContent(binaryPath: string, content: string): void;
  readAllBunModules(binaryPath: string): BunModuleView[];
  writeBunModules(binaryPath: string, overrides: Map<number, ModuleOverride>): void;
};

// Modules whose source contains any of these are run through the patcher on
// code-split builds. This is the union of the patcher's anchors, kept loose --
// a false positive only costs a run that reports zero candidates.
const PATCH_ANCHORS = [
  "collapsed_read_search",
  "isTranscriptMode:",
  "spinnerTipsEnabled",
  "streamingToolUses",
  "Backgrounded agent",
  "diffAddedWord",
  "Claude Code",
  "onStreamingThinking",
  "redacted_thinking",
  "switched from npm to native installer",
];

function printHelp(): void {
  console.log("Patch native Claude binaries");
  console.log("");
  console.log("Usage:");
  console.log(
    "  node scripts/patch-native.ts --input <native-binary> [--output <path>] [--disable <ids>] [--enable <ids>]"
  );
}

function parsePatchIds(value: string, flagName: string): string[] {
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error(`Expected a comma-separated list for ${flagName}`);
  }

  return ids;
}

function parseArgs(argv: string[]): PatchOptions {
  const opts: PatchOptions = {
    input: "",
    output: "",
    disable: [],
    enable: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--input") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --input");
      }
      opts.input = value;
      i += 1;
      continue;
    }

    if (arg === "--output") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --output");
      }
      opts.output = value;
      i += 1;
      continue;
    }

    if (arg === "--disable") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --disable");
      }
      opts.disable.push(...parsePatchIds(value, "--disable"));
      i += 1;
      continue;
    }

    if (arg === "--enable") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --enable");
      }
      opts.enable.push(...parsePatchIds(value, "--enable"));
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (!opts.input) {
    throw new Error("--input is required");
  }

  if (!opts.output) {
    opts.output = opts.input;
  }

  return opts;
}

function loadNativeBunModule(): NativeBunModule {
  return require("./native-bun.ts") as NativeBunModule;
}


function patchCodeSplitBinary(
  nativeBun: NativeBunModule,
  allModules: BunModuleView[],
  outputPath: string,
  opts: PatchOptions
): void {
  const patcherPath = path.resolve(__dirname, "..", "patch-claude-display.ts");
  const patchArgs: string[] = [];
  if (opts.enable.length > 0) {
    patchArgs.push("--enable", opts.enable.join(","));
  }
  if (opts.disable.length > 0) {
    patchArgs.push("--disable", opts.disable.join(","));
  }

  const jsModules = allModules.filter((module) => module.loader === 1 && module.contents.length > 200);
  console.log(`Code-split binary: ${allModules.length} modules, ${jsModules.length} JS`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-patch-"));
  const tempContentPath = path.join(tempDir, "content.js");
  const overrides = new Map<number, ModuleOverride>();

  try {
    for (const module of jsModules) {
      const source = module.contents.toString("utf8");
      if (!PATCH_ANCHORS.some((anchor) => source.includes(anchor))) {
        continue;
      }

      fs.writeFileSync(tempContentPath, source, "utf8");
      execFileSync(process.execPath, [patcherPath, "--file", tempContentPath, ...patchArgs], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const patched = fs.readFileSync(tempContentPath, "utf8");
      if (patched === source) {
        continue;
      }

      console.log(
        `  patched ${module.name} (${module.contents.length} -> ${Buffer.byteLength(patched)} bytes, ` +
          `dropping ${module.bytecodeLength} bytes of bytecode)`
      );
      // The bytecode must go: Bun runs it in preference to the source, so a
      // patched module that keeps its bytecode is a silent no-op.
      overrides.set(module.index, { contents: Buffer.from(patched, "utf8"), dropBytecode: true });
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  if (overrides.size === 0) {
    throw new Error("No module accepted any patch; the anchors need updating for this build");
  }

  nativeBun.writeBunModules(outputPath, overrides);
  console.log(`Patched native binary (${overrides.size} modules): ${outputPath}`);
}

async function patchNativeBinary(opts: PatchOptions): Promise<void> {
  const inputPath = path.resolve(opts.input);
  const outputPath = path.resolve(opts.output);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input binary not found: ${inputPath}`);
  }

  if (inputPath !== outputPath) {
    fs.copyFileSync(inputPath, outputPath);
    fs.chmodSync(outputPath, 0o755);
  }

  const nativeBun = loadNativeBunModule();
  if (!nativeBun.canNativeBunHandle(outputPath)) {
    throw new Error(`Unsupported native Claude binary: ${outputPath}`);
  }

  // Claude Code >= 2.1.242 code-splits the bundle: the entry module becomes a
  // ~20KB stub that imports ~1400 /$bunfs/root/chunk-*.js modules, and nearly
  // all of those carry precompiled bytecode. readNativeBunContent only returns
  // that stub, so on those builds every patch silently finds zero candidates.
  const allModules = nativeBun.readAllBunModules(outputPath);
  const isCodeSplit = allModules.some((module) => module.name.includes("/chunk-"));
  if (isCodeSplit) {
    patchCodeSplitBinary(nativeBun, allModules, outputPath, opts);
    return;
  }

  const originalContent = nativeBun.readNativeBunContent(outputPath);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-native-patch-"));
  const tempContentPath = path.join(tempDir, "content.js");
  fs.writeFileSync(tempContentPath, originalContent, "utf8");

  const patcherPath = path.resolve(__dirname, "..", "patch-claude-display.ts");
  const patchArgs = [patcherPath, "--file", tempContentPath];

  if (opts.enable.length > 0) {
    patchArgs.push("--enable", opts.enable.join(","));
  }
  if (opts.disable.length > 0) {
    patchArgs.push("--disable", opts.disable.join(","));
  }

  try {
    execFileSync(process.execPath, patchArgs, { stdio: "inherit" });
    const patchedContent = fs.readFileSync(tempContentPath, "utf8");
    nativeBun.writeNativeBunContent(outputPath, patchedContent);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`Patched native binary: ${outputPath}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  try {
    const opts = parseArgs(process.argv.slice(2));
    await patchNativeBinary(opts);
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`);
    process.exit(1);
  }
}

void main();

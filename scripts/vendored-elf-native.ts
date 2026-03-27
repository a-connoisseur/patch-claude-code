const fs = require("node:fs") as typeof import("node:fs");

type Range = {
  offset: number;
  length: number;
};

type BunOffsets = {
  byteCount: bigint;
  modulesPtr: Range;
  entryPointId: number;
  compileExecArgvPtr: Range;
  flags: number;
};

type BunModule = {
  name: Range;
  contents: Range;
  sourcemap: Range;
  bytecode: Range;
  moduleInfo: Range;
  bytecodeOriginPath: Range;
  encoding: number;
  loader: number;
  moduleFormat: number;
  side: number;
};

type BunStorage =
  | {
      storage: "section";
      bunData: Buffer;
      bunOffsets: BunOffsets;
      moduleStructSize: 36 | 52;
      sectionHeaderSize: 4 | 8;
    }
  | {
      storage: "overlay";
      bunData: Buffer;
      bunOffsets: BunOffsets;
      moduleStructSize: 36 | 52;
    };

type LIEFModule = typeof import("node-lief");

const BUN_TRAILER = Buffer.from("\n---- Bun! ----\n");
function loadLief(): LIEFModule {
  return require("node-lief") as LIEFModule;
}

function readRange(buffer: Buffer, offset: number): Range {
  return {
    offset: buffer.readUInt32LE(offset),
    length: buffer.readUInt32LE(offset + 4),
  };
}

function sliceRange(buffer: Buffer, range: Range): Buffer {
  return buffer.subarray(range.offset, range.offset + range.length);
}

function isClaudeModuleName(name: string): boolean {
  return (
    name === "claude" ||
    name.endsWith("/claude") ||
    name === "claude.exe" ||
    name.endsWith("/claude.exe") ||
    name === "src/entrypoints/cli.js" ||
    name.endsWith("/src/entrypoints/cli.js")
  );
}

function detectModuleStructSize(moduleTableLength: number): 36 | 52 {
  const looksLikeNewFormat = moduleTableLength % 52 === 0;
  const looksLikeOldFormat = moduleTableLength % 36 === 0;

  if (looksLikeNewFormat && !looksLikeOldFormat) {
    return 52;
  }

  if (looksLikeOldFormat && !looksLikeNewFormat) {
    return 36;
  }

  return 52;
}

function readBunOffsets(buffer: Buffer): BunOffsets {
  let cursor = 0;
  const byteCount = buffer.readBigUInt64LE(cursor);
  cursor += 8;
  const modulesPtr = readRange(buffer, cursor);
  cursor += 8;
  const entryPointId = buffer.readUInt32LE(cursor);
  cursor += 4;
  const compileExecArgvPtr = readRange(buffer, cursor);
  cursor += 8;
  const flags = buffer.readUInt32LE(cursor);

  return {
    byteCount,
    modulesPtr,
    entryPointId,
    compileExecArgvPtr,
    flags,
  };
}

function readBunModule(buffer: Buffer, offset: number, moduleStructSize: 36 | 52): BunModule {
  let cursor = offset;
  const name = readRange(buffer, cursor);
  cursor += 8;
  const contents = readRange(buffer, cursor);
  cursor += 8;
  const sourcemap = readRange(buffer, cursor);
  cursor += 8;
  const bytecode = readRange(buffer, cursor);
  cursor += 8;

  let moduleInfo: Range = { offset: 0, length: 0 };
  let bytecodeOriginPath: Range = { offset: 0, length: 0 };

  if (moduleStructSize === 52) {
    moduleInfo = readRange(buffer, cursor);
    cursor += 8;
    bytecodeOriginPath = readRange(buffer, cursor);
    cursor += 8;
  }

  const encoding = buffer.readUInt8(cursor);
  cursor += 1;
  const loader = buffer.readUInt8(cursor);
  cursor += 1;
  const moduleFormat = buffer.readUInt8(cursor);
  cursor += 1;
  const side = buffer.readUInt8(cursor);

  return {
    name,
    contents,
    sourcemap,
    bytecode,
    moduleInfo,
    bytecodeOriginPath,
    encoding,
    loader,
    moduleFormat,
    side,
  };
}

function parseBunDataBlob(bunData: Buffer): {
  bunData: Buffer;
  bunOffsets: BunOffsets;
  moduleStructSize: 36 | 52;
} {
  if (bunData.length < 32 + BUN_TRAILER.length) {
    throw new Error("BUN data is too small to contain offsets and trailer");
  }

  const trailerOffset = bunData.length - BUN_TRAILER.length;
  const trailer = bunData.subarray(trailerOffset);
  if (!trailer.equals(BUN_TRAILER)) {
    throw new Error("BUN trailer bytes do not match trailer");
  }

  const offsetsOffset = bunData.length - BUN_TRAILER.length - 32;
  const bunOffsets = readBunOffsets(bunData.subarray(offsetsOffset, offsetsOffset + 32));

  return {
    bunData,
    bunOffsets,
    moduleStructSize: detectModuleStructSize(bunOffsets.modulesPtr.length),
  };
}

function parseSectionWrappedBunData(sectionData: Buffer): {
  bunData: Buffer;
  bunOffsets: BunOffsets;
  moduleStructSize: 36 | 52;
  sectionHeaderSize: 4 | 8;
} {
  if (sectionData.length < 4) {
    throw new Error("Section data is too small");
  }

  const asU32 = sectionData.readUInt32LE(0);
  const u32Total = 4 + asU32;
  const asU64 = sectionData.length >= 8 ? Number(sectionData.readBigUInt64LE(0)) : 0;
  const u64Total = 8 + asU64;

  let sectionHeaderSize: 4 | 8;
  let bunDataSize: number;

  if (sectionData.length >= 8 && u64Total <= sectionData.length && u64Total >= sectionData.length - 4096) {
    sectionHeaderSize = 8;
    bunDataSize = asU64;
  } else if (u32Total <= sectionData.length && u32Total >= sectionData.length - 4096) {
    sectionHeaderSize = 4;
    bunDataSize = asU32;
  } else {
    throw new Error("Could not determine .bun section header format");
  }

  const bunData = sectionData.subarray(sectionHeaderSize, sectionHeaderSize + bunDataSize);
  const parsed = parseBunDataBlob(bunData);

  return {
    ...parsed,
    sectionHeaderSize,
  };
}

function parseElfOverlayBunData(binary: import("node-lief").ELF.Binary): {
  bunData: Buffer;
  bunOffsets: BunOffsets;
  moduleStructSize: 36 | 52;
} {
  if (!binary.hasOverlay) {
    throw new Error("ELF binary has no overlay data");
  }

  const overlay = binary.overlay;
  if (overlay.length < BUN_TRAILER.length + 8 + 32) {
    throw new Error("ELF overlay data is too small");
  }

  const totalByteCount = overlay.readBigUInt64LE(overlay.length - 8);
  if (totalByteCount < 4096n || totalByteCount > 2n ** 32n - 1n) {
    throw new Error(`ELF total byte count is out of range: ${totalByteCount}`);
  }

  const trailerOffset = overlay.length - 8 - BUN_TRAILER.length;
  const trailer = overlay.subarray(trailerOffset, overlay.length - 8);
  if (!trailer.equals(BUN_TRAILER)) {
    throw new Error("BUN trailer bytes do not match trailer");
  }

  const offsetsOffset = overlay.length - 8 - BUN_TRAILER.length - 32;
  const offsetsBuffer = overlay.subarray(offsetsOffset, offsetsOffset + 32);
  const bunOffsets = readBunOffsets(offsetsBuffer);
  const bunByteCount = Number(bunOffsets.byteCount);

  if (BigInt(bunByteCount) >= totalByteCount) {
    throw new Error("ELF total byte count is out of range");
  }

  const overhead = 8 + BUN_TRAILER.length + 32;
  const dataStart = overlay.length - overhead - bunByteCount;
  const mainData = overlay.subarray(dataStart, overlay.length - overhead);
  const bunData = Buffer.concat([mainData, offsetsBuffer, trailer]);

  return {
    bunData,
    bunOffsets,
    moduleStructSize: detectModuleStructSize(bunOffsets.modulesPtr.length),
  };
}

function parseElfBunStorage(binary: import("node-lief").ELF.Binary): BunStorage {
  const bunSection = binary.sections().find((section) => section.name === ".bun");
  if (bunSection) {
    const parsed = parseSectionWrappedBunData(bunSection.content);
    return {
      storage: "section",
      ...parsed,
    };
  }

  return {
    storage: "overlay",
    ...parseElfOverlayBunData(binary),
  };
}

function findClaudeModuleContent(storage: BunStorage): Buffer {
  const moduleTable = sliceRange(storage.bunData, storage.bunOffsets.modulesPtr);
  const moduleCount = Math.floor(moduleTable.length / storage.moduleStructSize);

  for (let index = 0; index < moduleCount; index += 1) {
    const moduleOffset = index * storage.moduleStructSize;
    const moduleRecord = readBunModule(moduleTable, moduleOffset, storage.moduleStructSize);
    const moduleName = sliceRange(storage.bunData, moduleRecord.name).toString("utf8");

    if (!isClaudeModuleName(moduleName)) {
      continue;
    }

    return sliceRange(storage.bunData, moduleRecord.contents);
  }

  throw new Error("Could not find Claude JavaScript module in ELF binary");
}

function rebuildBunData(
  bunData: Buffer,
  bunOffsets: BunOffsets,
  replacementContent: Buffer,
  moduleStructSize: 36 | 52
): Buffer {
  const rawBuffers: Buffer[] = [];
  const modules: Array<{
    name: Buffer;
    contents: Buffer;
    sourcemap: Buffer;
    bytecode: Buffer;
    moduleInfo: Buffer;
    bytecodeOriginPath: Buffer;
    encoding: number;
    loader: number;
    moduleFormat: number;
    side: number;
  }> = [];

  const moduleTable = sliceRange(bunData, bunOffsets.modulesPtr);
  const moduleCount = Math.floor(moduleTable.length / moduleStructSize);

  for (let index = 0; index < moduleCount; index += 1) {
    const moduleOffset = index * moduleStructSize;
    const moduleRecord = readBunModule(moduleTable, moduleOffset, moduleStructSize);
    const moduleName = sliceRange(bunData, moduleRecord.name).toString("utf8");

    const nextContents = isClaudeModuleName(moduleName)
      ? replacementContent
      : sliceRange(bunData, moduleRecord.contents);

    const nextModule = {
      name: sliceRange(bunData, moduleRecord.name),
      contents: nextContents,
      sourcemap: sliceRange(bunData, moduleRecord.sourcemap),
      bytecode: sliceRange(bunData, moduleRecord.bytecode),
      moduleInfo: sliceRange(bunData, moduleRecord.moduleInfo),
      bytecodeOriginPath: sliceRange(bunData, moduleRecord.bytecodeOriginPath),
      encoding: moduleRecord.encoding,
      loader: moduleRecord.loader,
      moduleFormat: moduleRecord.moduleFormat,
      side: moduleRecord.side,
    };

    modules.push(nextModule);

    if (moduleStructSize === 52) {
      rawBuffers.push(
        nextModule.name,
        nextModule.contents,
        nextModule.sourcemap,
        nextModule.bytecode,
        nextModule.moduleInfo,
        nextModule.bytecodeOriginPath
      );
    } else {
      rawBuffers.push(nextModule.name, nextModule.contents, nextModule.sourcemap, nextModule.bytecode);
    }
  }

  const rawBufferRanges: Range[] = [];
  let cursor = 0;
  for (const rawBuffer of rawBuffers) {
    rawBufferRanges.push({ offset: cursor, length: rawBuffer.length });
    cursor += rawBuffer.length + 1;
  }

  const moduleTableOffset = cursor;
  const moduleTableLength = modules.length * moduleStructSize;
  cursor += moduleTableLength;

  const compileExecArgv = sliceRange(bunData, bunOffsets.compileExecArgvPtr);
  const compileExecArgvOffset = cursor;
  cursor += compileExecArgv.length + 1;

  const offsetsOffset = cursor;
  cursor += 32;

  const trailerOffset = cursor;
  cursor += BUN_TRAILER.length;

  const rebuilt = Buffer.alloc(cursor);
  let rawBufferIndex = 0;
  for (const rawBufferRange of rawBufferRanges) {
    const rawBuffer = rawBuffers[rawBufferIndex];
    if (rawBuffer.length > 0) {
      rawBuffer.copy(rebuilt, rawBufferRange.offset, 0, rawBufferRange.length);
    }
    rawBufferIndex += 1;
  }

  if (compileExecArgv.length > 0) {
    compileExecArgv.copy(rebuilt, compileExecArgvOffset, 0, compileExecArgv.length);
  }

  const fieldsPerModule = moduleStructSize === 52 ? 6 : 4;
  for (let moduleIndex = 0; moduleIndex < modules.length; moduleIndex += 1) {
    const module = modules[moduleIndex];
    const baseIndex = moduleIndex * fieldsPerModule;
    const moduleRecord = {
      name: rawBufferRanges[baseIndex],
      contents: rawBufferRanges[baseIndex + 1],
      sourcemap: rawBufferRanges[baseIndex + 2],
      bytecode: rawBufferRanges[baseIndex + 3],
      moduleInfo: moduleStructSize === 52 ? rawBufferRanges[baseIndex + 4] : { offset: 0, length: 0 },
      bytecodeOriginPath:
        moduleStructSize === 52 ? rawBufferRanges[baseIndex + 5] : { offset: 0, length: 0 },
      encoding: module.encoding,
      loader: module.loader,
      moduleFormat: module.moduleFormat,
      side: module.side,
    };

    let recordCursor = moduleTableOffset + moduleIndex * moduleStructSize;
    rebuilt.writeUInt32LE(moduleRecord.name.offset, recordCursor);
    rebuilt.writeUInt32LE(moduleRecord.name.length, recordCursor + 4);
    recordCursor += 8;

    rebuilt.writeUInt32LE(moduleRecord.contents.offset, recordCursor);
    rebuilt.writeUInt32LE(moduleRecord.contents.length, recordCursor + 4);
    recordCursor += 8;

    rebuilt.writeUInt32LE(moduleRecord.sourcemap.offset, recordCursor);
    rebuilt.writeUInt32LE(moduleRecord.sourcemap.length, recordCursor + 4);
    recordCursor += 8;

    rebuilt.writeUInt32LE(moduleRecord.bytecode.offset, recordCursor);
    rebuilt.writeUInt32LE(moduleRecord.bytecode.length, recordCursor + 4);
    recordCursor += 8;

    if (moduleStructSize === 52) {
      rebuilt.writeUInt32LE(moduleRecord.moduleInfo.offset, recordCursor);
      rebuilt.writeUInt32LE(moduleRecord.moduleInfo.length, recordCursor + 4);
      recordCursor += 8;

      rebuilt.writeUInt32LE(moduleRecord.bytecodeOriginPath.offset, recordCursor);
      rebuilt.writeUInt32LE(moduleRecord.bytecodeOriginPath.length, recordCursor + 4);
      recordCursor += 8;
    }

    rebuilt.writeUInt8(moduleRecord.encoding, recordCursor);
    rebuilt.writeUInt8(moduleRecord.loader, recordCursor + 1);
    rebuilt.writeUInt8(moduleRecord.moduleFormat, recordCursor + 2);
    rebuilt.writeUInt8(moduleRecord.side, recordCursor + 3);
  }

  rebuilt.writeBigUInt64LE(BigInt(offsetsOffset), offsetsOffset);
  rebuilt.writeUInt32LE(moduleTableOffset, offsetsOffset + 8);
  rebuilt.writeUInt32LE(moduleTableLength, offsetsOffset + 12);
  rebuilt.writeUInt32LE(bunOffsets.entryPointId, offsetsOffset + 16);
  rebuilt.writeUInt32LE(compileExecArgvOffset, offsetsOffset + 20);
  rebuilt.writeUInt32LE(compileExecArgv.length, offsetsOffset + 24);
  rebuilt.writeUInt32LE(bunOffsets.flags, offsetsOffset + 28);

  BUN_TRAILER.copy(rebuilt, trailerOffset);

  return rebuilt;
}

function wrapSectionBunData(bunData: Buffer, sectionHeaderSize: 4 | 8): Buffer {
  const wrapped = Buffer.alloc(sectionHeaderSize + bunData.length);

  if (sectionHeaderSize === 8) {
    wrapped.writeBigUInt64LE(BigInt(bunData.length), 0);
  } else {
    wrapped.writeUInt32LE(bunData.length, 0);
  }

  bunData.copy(wrapped, sectionHeaderSize);
  return wrapped;
}

function writeBinaryPreservingMode(binary: import("node-lief").Abstract.Binary, path: string): void {
  const tempPath = `${path}.tmp`;
  binary.write(tempPath);
  const originalMode = fs.statSync(path).mode;
  fs.chmodSync(tempPath, originalMode);

  try {
    fs.renameSync(tempPath, path);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Best-effort cleanup only.
    }

    throw error;
  }
}

function parseElfBinary(binaryPath: string): {
  LIEF: LIEFModule;
  binary: import("node-lief").ELF.Binary;
} {
  const LIEF = loadLief();
  LIEF.logging.disable();

  const binary = LIEF.parse(binaryPath);
  if (binary.format !== "ELF") {
    throw new Error(`Binary is not ELF: ${binaryPath}`);
  }

  return {
    LIEF,
    binary: binary as import("node-lief").ELF.Binary,
  };
}

function canVendoredElfHandle(binaryPath: string): boolean {
  try {
    const { binary } = parseElfBinary(binaryPath);
    parseElfBunStorage(binary);
    return true;
  } catch {
    return false;
  }
}

function readVendoredElfContent(binaryPath: string): string {
  const { binary } = parseElfBinary(binaryPath);
  const storage = parseElfBunStorage(binary);
  return findClaudeModuleContent(storage).toString("utf8");
}

function writeVendoredElfContent(binaryPath: string, content: string): void {
  const { binary } = parseElfBinary(binaryPath);
  const storage = parseElfBunStorage(binary);
  const rebuiltBunData = rebuildBunData(
    storage.bunData,
    storage.bunOffsets,
    Buffer.from(content, "utf8"),
    storage.moduleStructSize
  );

  if (storage.storage === "section") {
    const bunSection = binary.sections().find((section) => section.name === ".bun");
    if (!bunSection) {
      throw new Error(`.bun section not found in ELF binary: ${binaryPath}`);
    }

    const wrappedSectionData = wrapSectionBunData(rebuiltBunData, storage.sectionHeaderSize);
    bunSection.content = wrappedSectionData;
    bunSection.size = BigInt(wrappedSectionData.length);
    writeBinaryPreservingMode(binary, binaryPath);
    return;
  }

  const overlay = Buffer.alloc(rebuiltBunData.length + 8);
  rebuiltBunData.copy(overlay, 0);
  overlay.writeBigUInt64LE(BigInt(rebuiltBunData.length), rebuiltBunData.length);
  binary.overlay = overlay;
  writeBinaryPreservingMode(binary, binaryPath);
}

module.exports = {
  canVendoredElfHandle,
  readVendoredElfContent,
  writeVendoredElfContent,
};

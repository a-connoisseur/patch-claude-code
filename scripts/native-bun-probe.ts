const fs = require("node:fs") as typeof import("node:fs");
const { execFileSync } = require("node:child_process") as typeof import("node:child_process");

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
const ELF_PT_LOAD = 1;
const ELF_SHT_NOBITS = 8;
const ELF_SHF_ALLOC = 0x2;

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
    name.endsWith("/root/cli") ||
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

  throw new Error("Could not find Claude JavaScript module in native binary");
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

function readElf64Layout(
  binaryBytes: Buffer,
  binaryPath: string
): {
  programHeaderOffset: number;
  programHeaderEntrySize: number;
  programHeaderCount: number;
  sectionHeaderOffset: number;
  sectionHeaderEntrySize: number;
  sectionHeaderCount: number;
  sectionNameStringTableIndex: number;
} {
  if (binaryBytes.length < 64) {
    throw new Error(`ELF binary is too small: ${binaryPath}`);
  }

  if (!binaryBytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`ELF magic header missing: ${binaryPath}`);
  }

  const elfClass = binaryBytes.readUInt8(4);
  const elfData = binaryBytes.readUInt8(5);

  if (elfClass !== 2) {
    throw new Error(`Only ELF64 section-backed binaries are supported: ${binaryPath}`);
  }

  if (elfData !== 1) {
    throw new Error(`Only little-endian ELF section-backed binaries are supported: ${binaryPath}`);
  }

  return {
    programHeaderOffset: Number(binaryBytes.readBigUInt64LE(32)),
    sectionHeaderOffset: Number(binaryBytes.readBigUInt64LE(40)),
    programHeaderEntrySize: binaryBytes.readUInt16LE(54),
    programHeaderCount: binaryBytes.readUInt16LE(56),
    sectionHeaderEntrySize: binaryBytes.readUInt16LE(58),
    sectionHeaderCount: binaryBytes.readUInt16LE(60),
    sectionNameStringTableIndex: binaryBytes.readUInt16LE(62),
  };
}

type Elf64SectionHeader = {
  index: number;
  name: string;
  type: number;
  flags: number;
  virtualAddress: number;
  fileOffset: number;
  size: number;
};

type Elf64ProgramHeader = {
  index: number;
  type: number;
  fileOffset: number;
  virtualAddress: number;
  fileSize: number;
  virtualSize: number;
  alignment: number;
};

function assertTableFits(
  binaryBytes: Buffer,
  offset: number,
  entrySize: number,
  entryCount: number,
  label: string,
  binaryPath: string
): void {
  const tableEnd = offset + entrySize * entryCount;
  if (offset < 0 || entrySize < 0 || entryCount < 0 || tableEnd > binaryBytes.length) {
    throw new Error(`${label} is out of range in ELF binary: ${binaryPath}`);
  }
}

function readElf64SectionHeaders(
  binaryBytes: Buffer,
  layout: ReturnType<typeof readElf64Layout>,
  binaryPath: string
): Elf64SectionHeader[] {
  if (layout.sectionHeaderEntrySize < 64) {
    throw new Error(`ELF section header entries are too small in ${binaryPath}`);
  }
  if (layout.sectionNameStringTableIndex >= layout.sectionHeaderCount) {
    throw new Error(`ELF section name string table index is out of range in ${binaryPath}`);
  }

  assertTableFits(
    binaryBytes,
    layout.sectionHeaderOffset,
    layout.sectionHeaderEntrySize,
    layout.sectionHeaderCount,
    "ELF section header table",
    binaryPath
  );

  const sections = Array.from({ length: layout.sectionHeaderCount }, (_, index) => {
    const headerOffset = layout.sectionHeaderOffset + index * layout.sectionHeaderEntrySize;
    return {
      index,
      nameOffset: binaryBytes.readUInt32LE(headerOffset),
      type: binaryBytes.readUInt32LE(headerOffset + 4),
      flags: Number(binaryBytes.readBigUInt64LE(headerOffset + 8)),
      virtualAddress: Number(binaryBytes.readBigUInt64LE(headerOffset + 16)),
      fileOffset: Number(binaryBytes.readBigUInt64LE(headerOffset + 24)),
      size: Number(binaryBytes.readBigUInt64LE(headerOffset + 32)),
    };
  });

  const nameSection = sections[layout.sectionNameStringTableIndex];
  if (nameSection.type === ELF_SHT_NOBITS) {
    throw new Error(`ELF section name string table has no file payload in ${binaryPath}`);
  }
  if (nameSection.fileOffset + nameSection.size > binaryBytes.length) {
    throw new Error(`ELF section name string table is out of range in ${binaryPath}`);
  }

  const names = binaryBytes.subarray(nameSection.fileOffset, nameSection.fileOffset + nameSection.size);
  function readSectionName(nameOffset: number): string {
    let end = nameOffset;
    while (end < names.length && names[end] !== 0) {
      end += 1;
    }
    return names.subarray(nameOffset, end).toString("utf8");
  }

  return sections.map((section) => ({
    index: section.index,
    name: readSectionName(section.nameOffset),
    type: section.type,
    flags: section.flags,
    virtualAddress: section.virtualAddress,
    fileOffset: section.fileOffset,
    size: section.size,
  }));
}

function readElf64ProgramHeaders(
  binaryBytes: Buffer,
  layout: ReturnType<typeof readElf64Layout>,
  binaryPath: string
): Elf64ProgramHeader[] {
  if (layout.programHeaderEntrySize < 56) {
    throw new Error(`ELF program header entries are too small in ${binaryPath}`);
  }

  assertTableFits(
    binaryBytes,
    layout.programHeaderOffset,
    layout.programHeaderEntrySize,
    layout.programHeaderCount,
    "ELF program header table",
    binaryPath
  );

  return Array.from({ length: layout.programHeaderCount }, (_, index) => {
    const headerOffset = layout.programHeaderOffset + index * layout.programHeaderEntrySize;
    return {
      index,
      type: binaryBytes.readUInt32LE(headerOffset),
      fileOffset: Number(binaryBytes.readBigUInt64LE(headerOffset + 8)),
      virtualAddress: Number(binaryBytes.readBigUInt64LE(headerOffset + 16)),
      fileSize: Number(binaryBytes.readBigUInt64LE(headerOffset + 32)),
      virtualSize: Number(binaryBytes.readBigUInt64LE(headerOffset + 40)),
      alignment: Number(binaryBytes.readBigUInt64LE(headerOffset + 48)),
    };
  });
}

function sectionHasFilePayload(section: Elf64SectionHeader): boolean {
  return section.type !== ELF_SHT_NOBITS && section.size > 0;
}

function findRawContainingLoadSegmentIndex(
  segments: Elf64ProgramHeader[],
  section: Elf64SectionHeader
): number | null {
  const sectionFileEnd = section.fileOffset + section.size;
  const sectionVirtualEnd = section.virtualAddress + section.size;

  for (const segment of segments) {
    if (segment.type !== ELF_PT_LOAD) {
      continue;
    }

    const segmentFileEnd = segment.fileOffset + segment.fileSize;
    const segmentVirtualEnd = segment.virtualAddress + segment.virtualSize;
    const containsFileRange = segment.fileOffset <= section.fileOffset && sectionFileEnd <= segmentFileEnd;
    const containsVirtualRange =
      segment.virtualAddress <= section.virtualAddress && sectionVirtualEnd <= segmentVirtualEnd;

    if (containsFileRange && containsVirtualRange) {
      return segment.index;
    }
  }

  return null;
}

function writeBufferPreservingMode(path: string, content: Buffer): void {
  const tempPath = `${path}.tmp`;
  fs.writeFileSync(tempPath, content);
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

function writeSectionBackedElfContent(
  binaryPath: string,
  wrappedSectionData: Buffer
): void {
  const originalBytes = fs.readFileSync(binaryPath);
  const layout = readElf64Layout(originalBytes, binaryPath);
  const sections = readElf64SectionHeaders(originalBytes, layout, binaryPath);
  const segments = readElf64ProgramHeaders(originalBytes, layout, binaryPath);
  const bunSection = sections.find((section) => section.name === ".bun");

  if (!bunSection) {
    throw new Error(`.bun section not found in ELF binary: ${binaryPath}`);
  }

  const bunSectionOffset = bunSection.fileOffset;
  const originalSectionSize = bunSection.size;
  const bunSectionEnd = bunSectionOffset + originalSectionSize;
  const growthBytes = Math.max(0, wrappedSectionData.length - originalSectionSize);

  const overlappingSections = sections.filter((section) => {
    return (
      section.name !== ".bun" &&
      sectionHasFilePayload(section) &&
      section.fileOffset > bunSectionOffset &&
      section.fileOffset < bunSectionEnd
    );
  });

  if (overlappingSections.length > 0) {
    const sectionNames = overlappingSections.map((section) => section.name || `<${section.index}>`).join(", ");
    throw new Error(`.bun overlaps later ELF section payloads in ${binaryPath}: ${sectionNames}`);
  }

  const shiftedSections = sections.filter((section) => {
    return section.name !== ".bun" && sectionHasFilePayload(section) && section.fileOffset >= bunSectionEnd;
  });

  const shiftedAllocSections = shiftedSections.filter((section) => (section.flags & ELF_SHF_ALLOC) !== 0);
  if (growthBytes > 0 && shiftedAllocSections.length > 0) {
    const sectionNames = shiftedAllocSections.map((section) => section.name || `<${section.index}>`).join(", ");
    throw new Error(`Cannot grow .bun before later allocated ELF sections in ${binaryPath}: ${sectionNames}`);
  }

  const sectionHeaderTableEnd =
    layout.sectionHeaderOffset + layout.sectionHeaderEntrySize * layout.sectionHeaderCount;
  if (
    growthBytes > 0 &&
    layout.sectionHeaderOffset < bunSectionEnd &&
    bunSectionEnd < sectionHeaderTableEnd
  ) {
    throw new Error(`Cannot grow .bun inside ELF section header table in ${binaryPath}`);
  }

  const programHeaderTableEnd =
    layout.programHeaderOffset + layout.programHeaderEntrySize * layout.programHeaderCount;
  if (
    growthBytes > 0 &&
    layout.programHeaderOffset < bunSectionEnd &&
    bunSectionEnd < programHeaderTableEnd
  ) {
    throw new Error(`Cannot grow .bun inside ELF program header table in ${binaryPath}`);
  }

  const containingSegmentIndex = findRawContainingLoadSegmentIndex(segments, bunSection);
  const spanningSegments = segments.filter((segment) => {
    if (segment.index === containingSegmentIndex || segment.fileSize === 0) {
      return false;
    }

    const segmentFileEnd = segment.fileOffset + segment.fileSize;
    return segment.fileOffset < bunSectionEnd && bunSectionEnd < segmentFileEnd;
  });

  if (growthBytes > 0 && spanningSegments.length > 0) {
    const segmentNames = spanningSegments
      .map((segment) => `${segment.index}:${segment.type}`)
      .join(", ");
    throw new Error(`Cannot grow .bun inside unrelated ELF segments in ${binaryPath}: ${segmentNames}`);
  }

  const shiftedSegments = segments.filter((segment) => {
    return segment.fileSize > 0 && segment.fileOffset >= bunSectionEnd;
  });

  for (const segment of shiftedSegments) {
    const nextOffset = segment.fileOffset + growthBytes;
    if (
      growthBytes > 0 &&
      segment.type === ELF_PT_LOAD &&
      segment.alignment > 0 &&
      nextOffset % segment.alignment !== segment.virtualAddress % segment.alignment
    ) {
      throw new Error(`Cannot shift LOAD segment ${segment.index} without breaking alignment in ${binaryPath}`);
    }
  }

  const nextBytes =
    growthBytes > 0 ? Buffer.alloc(originalBytes.length + growthBytes) : Buffer.from(originalBytes);

  if (growthBytes > 0) {
    originalBytes.copy(nextBytes, 0, 0, bunSectionEnd);
    originalBytes.copy(nextBytes, bunSectionEnd + growthBytes, bunSectionEnd);
  }

  wrappedSectionData.copy(nextBytes, bunSectionOffset);
  if (wrappedSectionData.length < originalSectionSize) {
    nextBytes.fill(0, bunSectionOffset + wrappedSectionData.length, bunSectionEnd);
  }

  const nextProgramHeaderOffset =
    growthBytes > 0 && layout.programHeaderOffset >= bunSectionEnd
      ? layout.programHeaderOffset + growthBytes
      : layout.programHeaderOffset;
  const nextSectionHeaderOffset =
    growthBytes > 0 && layout.sectionHeaderOffset >= bunSectionEnd
      ? layout.sectionHeaderOffset + growthBytes
      : layout.sectionHeaderOffset;

  nextBytes.writeBigUInt64LE(BigInt(nextProgramHeaderOffset), 32);
  nextBytes.writeBigUInt64LE(BigInt(nextSectionHeaderOffset), 40);

  for (const section of sections) {
    const sectionHeaderOffset = nextSectionHeaderOffset + section.index * layout.sectionHeaderEntrySize;

    if (section.index === bunSection.index) {
      nextBytes.writeBigUInt64LE(BigInt(wrappedSectionData.length), sectionHeaderOffset + 32);
      continue;
    }

    if (growthBytes > 0 && sectionHasFilePayload(section) && section.fileOffset >= bunSectionEnd) {
      nextBytes.writeBigUInt64LE(BigInt(section.fileOffset + growthBytes), sectionHeaderOffset + 24);
    }
  }

  for (const segment of segments) {
    const segmentHeaderOffset = nextProgramHeaderOffset + segment.index * layout.programHeaderEntrySize;

    if (growthBytes > 0 && segment.index === containingSegmentIndex) {
      nextBytes.writeBigUInt64LE(BigInt(segment.fileSize + growthBytes), segmentHeaderOffset + 32);
      nextBytes.writeBigUInt64LE(BigInt(segment.virtualSize + growthBytes), segmentHeaderOffset + 40);
      continue;
    }

    if (growthBytes > 0 && segment.fileSize > 0 && segment.fileOffset >= bunSectionEnd) {
      nextBytes.writeBigUInt64LE(BigInt(segment.fileOffset + growthBytes), segmentHeaderOffset + 8);
    }
  }

  writeBufferPreservingMode(binaryPath, nextBytes);
}

function writeElfBunContent(binaryPath: string, content: string): void {
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
    writeSectionBackedElfContent(binaryPath, wrappedSectionData);
    return;
  }

  const overlay = Buffer.alloc(rebuiltBunData.length + 8);
  rebuiltBunData.copy(overlay, 0);
  overlay.writeBigUInt64LE(BigInt(rebuiltBunData.length), rebuiltBunData.length);
  binary.overlay = overlay;
  writeBinaryPreservingMode(binary, binaryPath);
}

function parseNativeBinary(binaryPath: string): {
  LIEF: LIEFModule;
  binary:
    | import("node-lief").ELF.Binary
    | import("node-lief").MachO.Binary
    | import("node-lief").PE.Binary;
} {
  const LIEF = loadLief();
  LIEF.logging.disable();

  return {
    LIEF,
    binary: LIEF.parse(binaryPath),
  };
}

function parseNativeBunStorage(
  binary:
    | import("node-lief").ELF.Binary
    | import("node-lief").MachO.Binary
    | import("node-lief").PE.Binary
): BunStorage {
  if (binary.format === "ELF") {
    return parseElfBunStorage(binary);
  }

  if (binary.format === "MachO") {
    const segment = binary.getSegment("__BUN");
    const section = segment?.getSection("__bun");
    if (!section) {
      throw new Error("__BUN.__bun section not found in Mach-O binary");
    }
    return {
      storage: "section",
      ...parseSectionWrappedBunData(section.content),
    };
  }

  const section = binary.getSection(".bun");
  if (!section) {
    throw new Error(".bun section not found in PE binary");
  }
  return {
    storage: "section",
    ...parseSectionWrappedBunData(section.content),
  };
}

function canNativeBunHandle(binaryPath: string): boolean {
  try {
    const { binary } = parseNativeBinary(binaryPath);
    const storage = parseNativeBunStorage(binary);
    findClaudeModuleContent(storage);
    return true;
  } catch {
    return false;
  }
}

function readNativeBunContent(binaryPath: string): string {
  const { binary } = parseNativeBinary(binaryPath);
  const storage = parseNativeBunStorage(binary);
  return findClaudeModuleContent(storage).toString("utf8");
}

function writeMachOBunContent(
  LIEF: LIEFModule,
  binary: import("node-lief").MachO.Binary,
  binaryPath: string,
  wrappedSectionData: Buffer
): void {
  if (binary.hasCodeSignature) {
    binary.removeSignature();
  }

  const segment = binary.getSegment("__BUN");
  const section = segment?.getSection("__bun");
  if (!segment || !section) {
    throw new Error(`__BUN.__bun section not found in Mach-O binary: ${binaryPath}`);
  }

  const growthBytes = wrappedSectionData.length - Number(section.size);
  if (growthBytes > 0) {
    const pageSize =
      binary.header.cpuType === LIEF.MachO.Header.CPU_TYPE.ARM64 ? 16 * 1024 : 4 * 1024;
    const alignedGrowth = Math.ceil(growthBytes / pageSize) * pageSize;
    if (!binary.extendSegment(segment, alignedGrowth)) {
      throw new Error(`Could not extend __BUN segment in Mach-O binary: ${binaryPath}`);
    }
  }

  section.content = wrappedSectionData;
  section.size = BigInt(wrappedSectionData.length);
  writeBinaryPreservingMode(binary, binaryPath);
  execFileSync("codesign", ["-s", "-", "-f", binaryPath], { stdio: "ignore" });
}

function writePeBunContent(
  binary: import("node-lief").PE.Binary,
  binaryPath: string,
  wrappedSectionData: Buffer
): void {
  const section = binary.getSection(".bun");
  if (!section) {
    throw new Error(`.bun section not found in PE binary: ${binaryPath}`);
  }

  section.content = wrappedSectionData;
  section.virtualSize = BigInt(wrappedSectionData.length);
  section.size = BigInt(wrappedSectionData.length);
  writeBinaryPreservingMode(binary, binaryPath);
}

function writeNativeBunContent(binaryPath: string, content: string): void {
  const { LIEF, binary } = parseNativeBinary(binaryPath);
  const storage = parseNativeBunStorage(binary);
  const rebuiltBunData = rebuildBunData(
    storage.bunData,
    storage.bunOffsets,
    Buffer.from(content, "utf8"),
    storage.moduleStructSize
  );

  if (binary.format === "ELF") {
    writeElfBunContent(binaryPath, content);
    return;
  }

  const wrappedSectionData = wrapSectionBunData(rebuiltBunData, storage.sectionHeaderSize);
  if (binary.format === "MachO") {
    writeMachOBunContent(LIEF, binary, binaryPath, wrappedSectionData);
    return;
  }

  writePeBunContent(binary, binaryPath, wrappedSectionData);
}

module.exports = {
  canNativeBunHandle,
  readNativeBunContent,
  writeNativeBunContent,
};

module.exports.__probe = { parseNativeBunStorage, parseNativeBinary, readBunModule, sliceRange, detectModuleStructSize };

#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function printHelp() {
  console.log("Extract color-diff.node from a Claude native binary");
  console.log("");
  console.log("Usage:");
  console.log("  node scripts/extract-color-diff-node.js --input <native-binary> --output <color-diff.node>");
}

function parseArgs(argv) {
  const opts = {
    input: "",
    output: "",
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
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!opts.input || !opts.output) {
    throw new Error("Both --input and --output are required");
  }

  return opts;
}

function findFirstMagic(buffer, magicList, start, end) {
  let best = null;
  for (const magic of magicList) {
    const found = buffer.indexOf(magic.bytes, start);
    if (found === -1 || found > end) {
      continue;
    }
    if (!best || found < best.start) {
      best = {
        format: magic.format,
        start: found,
      };
    }
  }
  return best;
}

function findPayloadCandidates(buffer, markerList, magicList) {
  const candidates = [];
  const scanWindow = 1024 * 1024;

  for (const marker of markerList) {
    let cursor = 0;
    while (cursor < buffer.length) {
      const markerIndex = buffer.indexOf(marker, cursor);
      if (markerIndex === -1) {
        break;
      }

      const scanStart = markerIndex + marker.length;
      const scanEnd = Math.min(scanStart + scanWindow, buffer.length - 4);
      const match = findFirstMagic(buffer, magicList, scanStart, scanEnd);
      if (match) {
        candidates.push({
          ...match,
          markerIndex,
          distance: match.start - scanStart,
        });
      }

      cursor = markerIndex + marker.length;
    }
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates;
}

function readUInt64LE(buffer, offset) {
  return buffer.readBigUInt64LE(offset);
}

function readUInt64BE(buffer, offset) {
  return buffer.readBigUInt64BE(offset);
}

function parseMachOEnd(buffer, start) {
  const magic = buffer.readUInt32LE(start);
  let readU32;
  let readU64;

  if (magic === 0xfeedfacf || magic === 0xfeedface) {
    readU32 = (offset) => buffer.readUInt32LE(offset);
    readU64 = readUInt64LE;
  } else {
    const beMagic = buffer.readUInt32BE(start);
    if (beMagic !== 0xfeedfacf && beMagic !== 0xfeedface) {
      throw new Error("Unsupported Mach-O magic");
    }
    readU32 = (offset) => buffer.readUInt32BE(offset);
    readU64 = readUInt64BE;
  }

  const is64 = readU32(start) === 0xfeedfacf;
  const headerSize = is64 ? 32 : 28;
  const ncmds = readU32(start + 16);
  const sizeofcmds = readU32(start + 20);

  let commandOffset = start + headerSize;
  const commandsEnd = commandOffset + sizeofcmds;
  if (commandsEnd > buffer.length) {
    throw new Error("Mach-O load commands exceed file length");
  }

  let maxEnd = 0n;
  for (let i = 0; i < ncmds; i += 1) {
    if (commandOffset + 8 > buffer.length) {
      throw new Error("Truncated Mach-O load command");
    }

    const cmd = readU32(commandOffset);
    const cmdsize = readU32(commandOffset + 4);
    if (cmdsize < 8 || commandOffset + cmdsize > buffer.length) {
      throw new Error("Invalid Mach-O load command size");
    }

    if (is64 && cmd === 0x19 && cmdsize >= 56) {
      const fileOffset = readU64(buffer, commandOffset + 40);
      const fileSize = readU64(buffer, commandOffset + 48);
      const end = fileOffset + fileSize;
      if (end > maxEnd) {
        maxEnd = end;
      }
    } else if (!is64 && cmd === 0x1 && cmdsize >= 48) {
      const fileOffset = BigInt(readU32(commandOffset + 32));
      const fileSize = BigInt(readU32(commandOffset + 36));
      const end = fileOffset + fileSize;
      if (end > maxEnd) {
        maxEnd = end;
      }
    }

    commandOffset += cmdsize;
  }

  if (maxEnd === 0n) {
    throw new Error("Could not determine Mach-O payload size");
  }

  const payloadLength = Number(maxEnd);
  if (!Number.isSafeInteger(payloadLength) || payloadLength <= 0 || start + payloadLength > buffer.length) {
    throw new Error("Invalid Mach-O payload length");
  }

  return start + payloadLength;
}

function parseElfEnd(buffer, start) {
  if (start + 64 > buffer.length) {
    throw new Error("Truncated ELF header");
  }
  const elfClass = buffer[start + 4];
  const elfData = buffer[start + 5];
  const is64 = elfClass === 2;
  const isLE = elfData === 1;

  if ((elfClass !== 1 && elfClass !== 2) || (elfData !== 1 && elfData !== 2)) {
    throw new Error("Unsupported ELF class/endianness");
  }

  const readU16 = isLE
    ? (offset) => buffer.readUInt16LE(offset)
    : (offset) => buffer.readUInt16BE(offset);
  const readU32 = isLE
    ? (offset) => buffer.readUInt32LE(offset)
    : (offset) => buffer.readUInt32BE(offset);
  const readU64 = isLE ? readUInt64LE : readUInt64BE;

  let phoff;
  let phentsize;
  let phnum;

  if (is64) {
    phoff = readU64(buffer, start + 32);
    phentsize = readU16(start + 54);
    phnum = readU16(start + 56);
  } else {
    phoff = BigInt(readU32(start + 28));
    phentsize = readU16(start + 42);
    phnum = readU16(start + 44);
  }

  if (phentsize === 0 || phnum === 0) {
    throw new Error("ELF has no program headers");
  }

  let maxEnd = 0n;
  const phoffNumber = Number(phoff);
  if (!Number.isSafeInteger(phoffNumber) || phoffNumber < 0) {
    throw new Error("Invalid ELF program header offset");
  }

  for (let i = 0; i < phnum; i += 1) {
    const entryOffset = start + phoffNumber + i * phentsize;
    if (entryOffset + phentsize > buffer.length) {
      throw new Error("Truncated ELF program header");
    }

    let pOffset;
    let pFilesz;
    if (is64) {
      pOffset = readU64(buffer, entryOffset + 8);
      pFilesz = readU64(buffer, entryOffset + 32);
    } else {
      pOffset = BigInt(readU32(entryOffset + 4));
      pFilesz = BigInt(readU32(entryOffset + 16));
    }

    const end = pOffset + pFilesz;
    if (end > maxEnd) {
      maxEnd = end;
    }
  }

  if (maxEnd === 0n) {
    throw new Error("Could not determine ELF payload size");
  }

  const payloadLength = Number(maxEnd);
  if (!Number.isSafeInteger(payloadLength) || payloadLength <= 0 || start + payloadLength > buffer.length) {
    throw new Error("Invalid ELF payload length");
  }

  return start + payloadLength;
}

function extractColorDiffNode(inputPath, outputPath) {
  const markers = [
    Buffer.from("/$bunfs/root/color-diff.node\0", "utf8"),
    Buffer.from("/$bunfs/root/color-diff.node", "utf8"),
  ];
  const formats = [
    { format: "elf", bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
    { format: "macho", bytes: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]) },
    { format: "macho", bytes: Buffer.from([0xfe, 0xed, 0xfa, 0xcf]) },
  ];

  const binary = fs.readFileSync(inputPath);
  const candidates = findPayloadCandidates(binary, markers, formats);
  if (candidates.length === 0) {
    throw new Error("Could not locate color-diff payload marker and magic");
  }

  let payload = null;
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const end =
        candidate.format === "elf"
          ? parseElfEnd(binary, candidate.start)
          : parseMachOEnd(binary, candidate.start);
      const nextPayload = binary.subarray(candidate.start, end);
      if (nextPayload.length > 0) {
        payload = nextPayload;
        break;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (!payload) {
    throw new Error(
      `Could not parse extracted payload from any candidate${lastError ? `: ${lastError.message}` : ""}`
    );
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, payload);
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    extractColorDiffNode(path.resolve(opts.input), path.resolve(opts.output));
    console.log(`Extracted color-diff.node -> ${opts.output}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();

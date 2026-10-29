import { expect, test } from "bun:test";
const { rebuildBunData } = require("../scripts/native-bun.ts");

const TRAILER = Buffer.from("\n---- Bun! ----\n");
const STRUCT_SIZE = 52;

type FixtureModule = { name: string; content: string; bytecode: [number, number] };

// Builds Bun data laid out like a standalone executable:
// [names][contents][bytecode block][module table][offsets (32 bytes)][trailer].
function buildBunData(modules: FixtureModule[], bytecodeBlock: Buffer) {
  const parts: Buffer[] = [];
  let cursor = 0;
  const push = (buffer: Buffer) => {
    const offset = cursor;
    parts.push(buffer);
    cursor += buffer.length;
    return offset;
  };

  const names = modules.map((module) => ({ offset: push(Buffer.from(module.name)), length: module.name.length }));
  const contents = modules.map((module) => {
    const offset = push(Buffer.concat([Buffer.from(module.content), Buffer.from([0])]));
    return { offset, length: module.content.length };
  });
  const blockOffset = push(bytecodeBlock);

  const table = Buffer.alloc(modules.length * STRUCT_SIZE);
  modules.forEach((module, index) => {
    const base = index * STRUCT_SIZE;
    table.writeUInt32LE(names[index].offset, base);
    table.writeUInt32LE(names[index].length, base + 4);
    table.writeUInt32LE(contents[index].offset, base + 8);
    table.writeUInt32LE(contents[index].length, base + 12);
    table.writeUInt32LE(blockOffset + module.bytecode[0], base + 24);
    table.writeUInt32LE(module.bytecode[1], base + 28);
    table.writeUInt32LE(blockOffset, base + 40);
    table.writeUInt32LE(1, base + 44);
  });
  const tableOffset = push(table);

  const offsets = Buffer.alloc(32);
  offsets.writeBigUInt64LE(BigInt(cursor), 0);
  offsets.writeUInt32LE(tableOffset, 8);
  offsets.writeUInt32LE(table.length, 12);
  const bunOffsets = {
    byteCount: BigInt(cursor),
    modulesPtr: { offset: tableOffset, length: table.length },
    entryPointId: 0,
    compileExecArgvPtr: { offset: 0, length: 0 },
    flags: 0,
  };
  return { bunData: Buffer.concat([...parts, offsets, TRAILER]), bunOffsets, blockOffset, tableOffset };
}

function readRecord(bunData: Buffer, tableOffset: number, index: number) {
  const base = tableOffset + index * STRUCT_SIZE;
  const range = (at: number) => ({ offset: bunData.readUInt32LE(base + at), length: bunData.readUInt32LE(base + at + 4) });
  return { contents: range(8), bytecode: range(24), bytecodeOriginPath: range(40) };
}

function moduleContent(bunData: Buffer, tableOffset: number, index: number) {
  const { contents } = readRecord(bunData, tableOffset, index);
  expect(bunData[contents.offset + contents.length]).toBe(0);
  return bunData.subarray(contents.offset, contents.offset + contents.length).toString("utf8");
}

test("appends a grown module instead of overwriting a shared bytecode block", () => {
  // Bun 1.4 layout: every bytecode range runs to the end of one shared block.
  const block = Buffer.alloc(300, 0xab);
  const modules: FixtureModule[] = [
    { name: "/$bunfs/root/cli", content: "cli();", bytecode: [0, 300] },
    { name: "/$bunfs/root/chunk-a.js", content: "a();", bytecode: [100, 200] },
    { name: "/$bunfs/root/chunk-b.js", content: "b();", bytecode: [200, 100] },
  ];
  const { bunData, bunOffsets, blockOffset, tableOffset } = buildBunData(modules, block);
  const patched = "cli();/* patched */".repeat(4);

  const rebuilt: Buffer = rebuildBunData(
    bunData,
    bunOffsets,
    new Map([["/$bunfs/root/cli", Buffer.from(patched)]]),
    STRUCT_SIZE
  );

  expect(rebuilt.subarray(blockOffset, blockOffset + block.length).equals(block)).toBe(true);
  expect(moduleContent(rebuilt, tableOffset, 0)).toBe(patched);
  expect(readRecord(rebuilt, tableOffset, 0).bytecode).toEqual({ offset: 0, length: 0 });
  expect(readRecord(rebuilt, tableOffset, 0).bytecodeOriginPath).toEqual({ offset: 0, length: 0 });
  expect(readRecord(rebuilt, tableOffset, 1)).toEqual(readRecord(bunData, tableOffset, 1));
  expect(moduleContent(rebuilt, tableOffset, 2)).toBe("b();");

  expect(rebuilt.subarray(rebuilt.length - TRAILER.length).equals(TRAILER)).toBe(true);
  const offsetsOffset = rebuilt.length - TRAILER.length - 32;
  expect(rebuilt.readBigUInt64LE(offsetsOffset)).toBe(BigInt(offsetsOffset));
  expect(rebuilt.readUInt32LE(offsetsOffset + 8)).toBe(bunOffsets.modulesPtr.offset);
});

test("still reuses an exact bytecode range that no other module shares", () => {
  // Older layout: disjoint, exact bytecode ranges.
  const block = Buffer.alloc(300, 0xcd);
  const modules: FixtureModule[] = [
    { name: "/$bunfs/root/cli", content: "cli();", bytecode: [0, 200] },
    { name: "/$bunfs/root/chunk-a.js", content: "a();", bytecode: [200, 100] },
  ];
  const { bunData, bunOffsets, blockOffset, tableOffset } = buildBunData(modules, block);
  const patched = "cli();/* patched */";

  const rebuilt: Buffer = rebuildBunData(
    bunData,
    bunOffsets,
    new Map([["/$bunfs/root/cli", Buffer.from(patched)]]),
    STRUCT_SIZE
  );

  expect(rebuilt.length).toBe(bunData.length);
  expect(readRecord(rebuilt, tableOffset, 0).contents.offset).toBe(blockOffset);
  expect(moduleContent(rebuilt, tableOffset, 0)).toBe(patched);
  expect(rebuilt.subarray(blockOffset + 200, blockOffset + 300).equals(block.subarray(200))).toBe(true);
  expect(readRecord(rebuilt, tableOffset, 1)).toEqual(readRecord(bunData, tableOffset, 1));
});

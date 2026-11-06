import { expect, test } from "bun:test";

const { rebuildBunData } = require("../scripts/native-bun.ts");

test("growing a module preserves bytecode shared with unchanged modules", () => {
  const trailer = Buffer.from("\n---- Bun! ----\n");
  const footerOffset = 208;
  const data = Buffer.alloc(footerOffset + 32 + trailer.length);
  data.write("first", 0);
  data.write("second", 8);
  data.write("a\0", 16);
  data.write("keep\0", 20);
  data.fill(0x5a, 32, 80);
  const tableOffset = 80;
  function range(record: number, field: number, offset: number, length: number) {
    data.writeUInt32LE(offset, tableOffset + record * 52 + field);
    data.writeUInt32LE(length, tableOffset + record * 52 + field + 4);
  }
  range(0, 0, 0, 5);
  range(0, 8, 16, 1);
  range(0, 24, 32, 48);
  range(1, 0, 8, 6);
  range(1, 8, 20, 4);
  range(1, 24, 40, 40);
  data.writeBigUInt64LE(BigInt(footerOffset), footerOffset);
  trailer.copy(data, footerOffset + 32);
  const replacement = Buffer.from("expanded source");
  const result = rebuildBunData(data, {
    byteCount: BigInt(footerOffset),
    modulesPtr: { offset: tableOffset, length: 104 },
    entryPointId: 0,
    compileExecArgvPtr: { offset: 0, length: 0 },
    flags: 0,
  }, new Map([["first", replacement]]), 52);

  expect(result.subarray(32, 80)).toEqual(data.subarray(32, 80));
  expect(result.subarray(tableOffset + 52, tableOffset + 104)).toEqual(data.subarray(tableOffset + 52, tableOffset + 104));
  const sourceOffset = result.readUInt32LE(tableOffset + 8);
  expect(result.subarray(sourceOffset, sourceOffset + replacement.length)).toEqual(replacement);
  expect(result[sourceOffset + replacement.length]).toBe(0);
  expect(result.readUInt32LE(tableOffset + 28)).toBe(0);
  expect(result.readBigUInt64LE(footerOffset + replacement.length + 1)).toBe(BigInt(footerOffset + replacement.length + 1));
  expect(result.subarray(-trailer.length)).toEqual(trailer);
});

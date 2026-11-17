/**
 * Extract a zip archive with Node's built-in zlib: stored or deflated entries, no zip64, no
 * symlinks. Enough for the sha256-verified runtime archives.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

export function extractZip(archivePath: string, destDir: string): void {
  const buf = readFileSync(archivePath);

  // The end-of-central-directory record sits in the last 22 bytes, before an optional comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error(`${archivePath} is not a zip archive`);
  }
  const entryCount = buf.readUInt16LE(eocd + 10);
  const directoryOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error(`${archivePath}: zip64 archives are not supported`);
  }

  const root = resolve(destDir);
  let p = directoryOffset;
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL_DIRECTORY_HEADER) {
      throw new Error(`${archivePath}: corrupt central directory`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;

    const target = resolve(root, name);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`${archivePath}: entry escapes the destination: ${name}`);
    }
    if (name.endsWith("/")) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    if (buf.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
      throw new Error(`${archivePath}: corrupt local header for ${name}`);
    }
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === STORED) {
      data = raw;
    } else if (method === DEFLATED) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(`${archivePath}: unsupported compression method ${method} for ${name}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

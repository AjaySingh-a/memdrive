import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { ENCRYPTION_FILE, readJson, writeJson } from "./paths";

// Encrypted backup format (all backups since memdrive 0.2):
//
//   header  = MAGIC(16) | salt(16) | logN, r, p, chunkExp (4 bytes) | noncePrefix(7)
//   chunks  = AES-256-GCM(plaintext chunk) || tag(16), repeated
//
// The key comes from the user's backup password via scrypt. Each chunk's nonce is
// noncePrefix | chunk counter (u32 BE) | last-chunk flag, and the header is the
// associated data of every chunk, so reordering, truncating or editing any part of
// the file makes decryption fail instead of returning damaged data.
const MAGIC = Buffer.from("MEMDRIVE-ENC-1\n\0", "latin1");
const HEADER_LEN = 16 + 16 + 4 + 7;
const TAG_LEN = 16;
const DEFAULT_KDF = { logN: 17, r: 8, p: 1 };
const DEFAULT_CHUNK_EXP = 20; // 1 MiB

export const MIN_PASSWORD_LENGTH = 8;

export interface KeyInfo {
  salt: string;
  logN: number;
  r: number;
  p: number;
  key: string;
}

export class WrongPasswordError extends Error {
  constructor() {
    super("wrong backup password, or the backup file is damaged");
  }
}

function derive(password: string, salt: Buffer, logN: number, r: number, p: number): Buffer {
  return scryptSync(password.normalize("NFC"), salt, 32, { N: 2 ** logN, r, p, maxmem: 512 * 1024 * 1024 });
}

export function createKey(password: string): KeyInfo {
  const salt = randomBytes(16);
  const { logN, r, p } = DEFAULT_KDF;
  return { salt: salt.toString("base64"), logN, r, p, key: derive(password, salt, logN, r, p).toString("base64") };
}

export const loadKey = () => readJson<KeyInfo | null>(ENCRYPTION_FILE, null);
export const saveKey = (k: KeyInfo) => writeJson(ENCRYPTION_FILE, k, true);
export const hasKey = () => existsSync(ENCRYPTION_FILE);

export function isEncryptedFile(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(MAGIC.length);
    return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(MAGIC);
  } finally {
    closeSync(fd);
  }
}

interface Header {
  raw: Buffer;
  salt: Buffer;
  logN: number;
  r: number;
  p: number;
  chunkSize: number;
  noncePrefix: Buffer;
}

function readHeader(fd: number): Header {
  const raw = Buffer.alloc(HEADER_LEN);
  if (readSync(fd, raw, 0, HEADER_LEN, 0) !== HEADER_LEN || !raw.subarray(0, 16).equals(MAGIC)) {
    throw new Error("not a memdrive encrypted backup");
  }
  const [logN, r, p, chunkExp] = raw.subarray(32, 36);
  return { raw, salt: raw.subarray(16, 32), logN, r, p, chunkSize: 2 ** chunkExp, noncePrefix: raw.subarray(36, 43) };
}

function nonce(prefix: Buffer, index: number, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, 7);
  n[11] = last ? 1 : 0;
  return n;
}

export function encryptFile(src: string, dst: string, key: KeyInfo, chunkExp = DEFAULT_CHUNK_EXP): void {
  const chunkSize = 2 ** chunkExp;
  const keyBytes = Buffer.from(key.key, "base64");
  const header = Buffer.concat([
    MAGIC,
    Buffer.from(key.salt, "base64"),
    Buffer.from([key.logN, key.r, key.p, chunkExp]),
    randomBytes(7),
  ]);
  const noncePrefix = header.subarray(36, 43);
  const input = openSync(src, "r");
  const output = openSync(dst, "w", 0o600);
  try {
    writeSync(output, header);
    const size = fstatSync(input).size;
    const buf = Buffer.alloc(chunkSize);
    let offset = 0;
    let index = 0;
    do {
      const len = readSync(input, buf, 0, chunkSize, offset);
      offset += len;
      const last = offset >= size;
      const cipher = createCipheriv("aes-256-gcm", keyBytes, nonce(noncePrefix, index++, last));
      cipher.setAAD(header);
      writeSync(output, Buffer.concat([cipher.update(buf.subarray(0, len)), cipher.final(), cipher.getAuthTag()]));
      if (last) break;
    } while (true);
  } finally {
    closeSync(input);
    closeSync(output);
  }
}

function headerOf(path: string): Header {
  const fd = openSync(path, "r");
  try {
    return readHeader(fd);
  } finally {
    closeSync(fd);
  }
}

// The key saved on this computer, if this file was encrypted with it.
export function savedKeyFor(path: string): Buffer | null {
  const saved = loadKey();
  if (!saved || !Buffer.from(saved.salt, "base64").equals(headerOf(path).salt)) return null;
  return Buffer.from(saved.key, "base64");
}

export function keyFromPassword(path: string, password: string): Buffer {
  const h = headerOf(path);
  return derive(password, h.salt, h.logN, h.r, h.p);
}

export function decryptFile(src: string, dst: string, key: Buffer): void {
  const input = openSync(src, "r");
  const output = openSync(dst, "w", 0o600);
  try {
    const header = readHeader(input);
    const bodySize = fstatSync(input).size - HEADER_LEN;
    const frame = header.chunkSize + TAG_LEN;
    const chunks = Math.max(1, Math.ceil(bodySize / frame));
    const buf = Buffer.alloc(frame);
    for (let index = 0; index < chunks; index++) {
      const start = HEADER_LEN + index * frame;
      const len = Math.min(frame, bodySize - index * frame);
      if (len < TAG_LEN) throw new WrongPasswordError();
      readSync(input, buf, 0, len, start);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce(header.noncePrefix, index, index === chunks - 1));
      decipher.setAAD(header.raw);
      decipher.setAuthTag(buf.subarray(len - TAG_LEN, len));
      try {
        writeSync(output, Buffer.concat([decipher.update(buf.subarray(0, len - TAG_LEN)), decipher.final()]));
      } catch {
        throw new WrongPasswordError();
      }
    }
  } finally {
    closeSync(input);
    closeSync(output);
  }
}

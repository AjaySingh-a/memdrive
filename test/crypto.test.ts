import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "memdrive-crypto-"));
process.env.MEMDRIVE_HOME = join(dir, "home");

const crypto = await import("../src/crypto");
const { createKey, decryptFile, encryptFile, isEncryptedFile, keyFromPassword, saveKey, savedKeyFor, WrongPasswordError } = crypto;

let key: ReturnType<typeof createKey>;
beforeAll(() => {
  key = createKey("correct horse battery");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function roundTrip(data: Buffer, chunkExp: number): Buffer {
  const plain = join(dir, "plain");
  const enc = join(dir, "enc");
  const out = join(dir, "out");
  writeFileSync(plain, data);
  encryptFile(plain, enc, key, chunkExp);
  decryptFile(enc, out, Buffer.from(key.key, "base64"));
  return readFileSync(out);
}

test("round-trips data of awkward sizes, including exact chunk multiples", () => {
  for (const size of [0, 1, 1023, 1024, 1025, 4096, 5000]) {
    const data = randomBytes(size);
    expect(roundTrip(data, 10).equals(data)).toBe(true);
  }
});

test("ciphertext does not contain the plaintext", () => {
  const secret = Buffer.from("postgres://isf_admin:SuperSecret123@prod-db.example.com/app ".repeat(50));
  writeFileSync(join(dir, "p"), secret);
  encryptFile(join(dir, "p"), join(dir, "e"), key);
  expect(isEncryptedFile(join(dir, "e"))).toBe(true);
  expect(readFileSync(join(dir, "e")).includes("SuperSecret123")).toBe(false);
});

test("password derives the same key; a wrong password is rejected", () => {
  writeFileSync(join(dir, "p"), "memory");
  encryptFile(join(dir, "p"), join(dir, "e"), key);
  decryptFile(join(dir, "e"), join(dir, "o"), keyFromPassword(join(dir, "e"), "correct horse battery"));
  expect(readFileSync(join(dir, "o"), "utf8")).toBe("memory");
  expect(() => decryptFile(join(dir, "e"), join(dir, "o"), keyFromPassword(join(dir, "e"), "wrong password"))).toThrow(
    WrongPasswordError,
  );
});

test("tampering and truncation are detected", () => {
  writeFileSync(join(dir, "p"), randomBytes(3000));
  encryptFile(join(dir, "p"), join(dir, "e"), key, 10);
  const enc = readFileSync(join(dir, "e"));
  const k = Buffer.from(key.key, "base64");

  const flipped = Buffer.from(enc);
  flipped[100] ^= 1;
  writeFileSync(join(dir, "t"), flipped);
  expect(() => decryptFile(join(dir, "t"), join(dir, "o"), k)).toThrow(WrongPasswordError);

  // Dropping the last chunk must fail, not silently return a shorter file.
  writeFileSync(join(dir, "t"), enc.subarray(0, 43 + 2 * (1024 + 16)));
  expect(() => decryptFile(join(dir, "t"), join(dir, "o"), k)).toThrow(WrongPasswordError);
});

test("the saved key is used for backups made on this computer only", () => {
  saveKey(key);
  writeFileSync(join(dir, "p"), "x");
  encryptFile(join(dir, "p"), join(dir, "mine"), key);
  encryptFile(join(dir, "p"), join(dir, "other"), createKey("another computer"));
  expect(savedKeyFor(join(dir, "mine"))).not.toBeNull();
  expect(savedKeyFor(join(dir, "other"))).toBeNull();
});

test("plain archives are not mistaken for encrypted ones", () => {
  writeFileSync(join(dir, "plain.tar.gz"), Buffer.from([0x1f, 0x8b, 8, 0]));
  expect(isEncryptedFile(join(dir, "plain.tar.gz"))).toBe(false);
});

import { expect, test } from "bun:test";
import { isNewer } from "../src/update";

test("version comparison handles multi-digit parts and v prefixes", () => {
  expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  expect(isNewer("v0.3.0", "0.2.0")).toBe(true);
  expect(isNewer("0.3.0", "0.3.0")).toBe(false);
  expect(isNewer("0.2.9", "0.3.0")).toBe(false);
  expect(isNewer("1.0.0", "0.99.99")).toBe(true);
});

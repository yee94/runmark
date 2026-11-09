import { expect, it } from "bun:test";
import { parseClientId } from "../src/index";

it.each(["yuri", "other.client-1_ui", "0", "x".repeat(64)])("accepts a complete client id: %s", (id) => {
  expect(parseClientId(id)).toBe(id);
});

it.each([undefined, null, 1, {}, [], "", "Yuri", "-yuri", "yuri user", "x".repeat(65), "yuri\n", "yuri\r", "yuri\u2028", "yuri\u2029"].map(value => ({ value })))("keeps malformed client ids unknown: %j", ({ value }) => {
  expect(parseClientId(value)).toBeUndefined();
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blocksRecreate,
  pathExistsNonEmpty,
  recreateBlockMessage,
} from "../../src/agent/recreate-guard";

test("blocks a write_file over an existing, non-empty, untouched file", () => {
  expect(blocksRecreate({ toolName: "write_file", existsNonEmpty: true, touched: false })).toBe(
    true,
  );
});

test("does not block once the file has been touched this turn", () => {
  expect(blocksRecreate({ toolName: "write_file", existsNonEmpty: true, touched: true })).toBe(
    false,
  );
});

test("does not block a new or empty target (existsNonEmpty false)", () => {
  expect(blocksRecreate({ toolName: "write_file", existsNonEmpty: false, touched: false })).toBe(
    false,
  );
});

test("does not block partial-edit tools even over an existing untouched file", () => {
  for (const toolName of ["edit_file", "apply_patch", "multi_edit"]) {
    expect(blocksRecreate({ toolName, existsNonEmpty: true, touched: false })).toBe(false);
  }
});

test("block message names the path and steers to read-then-edit", () => {
  const msg = recreateBlockMessage("src/pages/HomePage.tsx");
  expect(msg).toContain("src/pages/HomePage.tsx");
  expect(msg).toContain("read_file");
  expect(msg).toContain("edit_file");
  expect(msg).toContain("multi_edit");
  expect(msg).toContain("apply_patch");
  expect(msg).toContain("does not authorize a whole-file overwrite");
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cleetus-recreate-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("pathExistsNonEmpty: true for a non-empty file", async () => {
  const p = join(dir, "a.txt");
  await Bun.write(p, "content");
  expect(await pathExistsNonEmpty(p)).toBe(true);
});

test("pathExistsNonEmpty: false for a missing path", async () => {
  expect(await pathExistsNonEmpty(join(dir, "nope.txt"))).toBe(false);
});

test("pathExistsNonEmpty: false for an empty file", async () => {
  const p = join(dir, "empty.txt");
  await Bun.write(p, "");
  expect(await pathExistsNonEmpty(p)).toBe(false);
});

test("pathExistsNonEmpty: false for a directory", async () => {
  expect(await pathExistsNonEmpty(dir)).toBe(false);
});

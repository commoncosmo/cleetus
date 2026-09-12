import { describe, expect, it } from "bun:test";
import { ProviderRegistry } from "../../src/providers/registry";
import { buildCommandRegistry } from "../../src/slash/commands";
import { completeSlashLine } from "../../src/slash/complete";

// Minimal real registry: buildCommandRegistry only needs these deps to construct
// the command set; we never invoke run(), so stubs are fine.
function registry() {
  return buildCommandRegistry({
    providers: new ProviderRegistry(),
    getActive: () => ({ provider: "p", model: "m" }),
    setActive: () => {},
    getPermissions: () => ({ project: [], global: [] }),
  });
}

describe("completeSlashLine", () => {
  it("returns all commands for a bare slash, alphabetical, displayed with leading /", () => {
    const out = completeSlashLine(registry(), "/");
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) expect(s.display.startsWith("/")).toBe(true);
    const names = out.map((s) => s.value.replace(/^\//, "").trimEnd());
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("prefix-filters by command name", () => {
    const out = completeSlashLine(registry(), "/mo").map((s) =>
      s.value.replace(/^\//, "").trimEnd(),
    );
    expect(out).toEqual(["mode", "model"]);
  });

  it("marks arg-taking commands fillOnly with a trailing-space value", () => {
    const arg = completeSlashLine(registry(), "/mode").find((s) => s.display.startsWith("/mode "));
    expect(arg?.fillOnly).toBe(true);
    expect(arg?.value).toBe("/mode ");
  });

  it("marks no-arg commands as not fillOnly with a plain value", () => {
    const help = completeSlashLine(registry(), "/help")[0]!;
    expect(help.value).toBe("/help");
    expect(Boolean(help.fillOnly)).toBe(false);
  });

  it("runs optional-argument commands on Enter while preserving a path-entry suffix", () => {
    const edit = completeSlashLine(registry(), "/edit")[0]!;
    expect(edit.value).toBe("/edit ");
    expect(Boolean(edit.fillOnly)).toBe(false);
  });

  it("surfaces aliases by prefix (e.g. /q -> quit)", () => {
    const out = completeSlashLine(registry(), "/q").map((s) => s.display);
    expect(out.some((d) => d.startsWith("/quit"))).toBe(true);
  });

  it("returns [] once a space is typed (past the command name)", () => {
    expect(completeSlashLine(registry(), "/model ")).toEqual([]);
    expect(completeSlashLine(registry(), "/help extra")).toEqual([]);
  });

  it("returns [] for multi-line, non-slash, or empty input", () => {
    expect(completeSlashLine(registry(), "/help\n")).toEqual([]);
    expect(completeSlashLine(registry(), "hello")).toEqual([]);
    expect(completeSlashLine(registry(), "")).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    expect(completeSlashLine(registry(), "/zzz")).toEqual([]);
  });
});

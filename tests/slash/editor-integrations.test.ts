import { describe, expect, test } from "bun:test";
import { ProviderRegistry } from "../../src/providers/registry";
import { type ScopedEditorHost, buildCommandRegistry } from "../../src/slash/commands";
import type { SlashContext } from "../../src/slash/types";

function baseDeps() {
  return {
    providers: new ProviderRegistry(),
    getActive: () => ({ provider: "none", model: "none" }),
    setActive() {},
    getPermissions: () => ({ project: [], global: [] }),
  };
}

function editorHost(events: string[]): ScopedEditorHost {
  return {
    prepare(scope) {
      events.push(`prepare:${scope ?? "auto"}`);
      return `/work/${scope ?? "auto"}.yaml`;
    },
    async reload() {
      events.push("reload");
      return "reloaded";
    },
  };
}

function context(events: string[], printed: string[]): SlashContext {
  return {
    cwd: "/work",
    print(text) {
      printed.push(text);
    },
    async openEditor(request) {
      events.push(`edit:${request.targets?.join(",") ?? ""}`);
    },
  };
}

describe("feature-aware editor slash commands", () => {
  test("/config edit defaults to project and validates after the editor exits", async () => {
    const events: string[] = [];
    const printed: string[] = [];
    const reg = buildCommandRegistry({
      ...baseDeps(),
      configEditor: editorHost(events),
    });

    await reg.get("config")!.run("edit", context(events, printed));

    expect(events).toEqual(["prepare:project", "edit:/work/project.yaml", "reload"]);
    expect(printed).toEqual(["reloaded"]);
  });

  test("/permissions edit accepts global scope and reloads after editing", async () => {
    const events: string[] = [];
    const printed: string[] = [];
    const reg = buildCommandRegistry({
      ...baseDeps(),
      permissionsEditor: editorHost(events),
    });

    await reg.get("permissions")!.run("edit global", context(events, printed));

    expect(events).toEqual(["prepare:global", "edit:/work/global.yaml", "reload"]);
    expect(printed).toEqual(["reloaded"]);
  });

  test("/instructions edit with no scope lets the host resolve the active source", async () => {
    const events: string[] = [];
    const printed: string[] = [];
    const reg = buildCommandRegistry({
      ...baseDeps(),
      instructionsEditor: editorHost(events),
    });

    await reg.get("instructions")!.run("edit", context(events, printed));

    expect(events).toEqual(["prepare:auto", "edit:/work/auto.yaml", "reload"]);
    expect(printed).toEqual(["reloaded"]);
  });

  test("/spec edit edits a durable artifact without seeding a spec turn", async () => {
    const printed: string[] = [];
    const edited: Array<[string, string]> = [];
    let seeded = false;
    const reg = buildCommandRegistry({
      ...baseDeps(),
      buildSpecSeed() {
        seeded = true;
        return "seed";
      },
    });

    await reg.get("spec")!.run("edit docs/specs/example.md", {
      cwd: "/work",
      print(text) {
        printed.push(text);
      },
      async editArtifact(kind, args) {
        edited.push([kind, args]);
        return "edited spec";
      },
    });

    expect(edited).toEqual([["spec", "docs/specs/example.md"]]);
    expect(printed).toEqual(["edited spec"]);
    expect(seeded).toBe(false);
  });

  test("/plan edit edits a durable artifact without changing mode", async () => {
    const printed: string[] = [];
    const edited: Array<[string, string]> = [];
    const modes: string[] = [];
    const reg = buildCommandRegistry({
      ...baseDeps(),
      setMode(mode) {
        modes.push(mode);
      },
    });

    await reg.get("plan")!.run("edit", {
      cwd: "/work",
      print(text) {
        printed.push(text);
      },
      async editArtifact(kind, args) {
        edited.push([kind, args]);
        return "edited plan";
      },
    });

    expect(edited).toEqual([["plan", ""]]);
    expect(printed).toEqual(["edited plan"]);
    expect(modes).toEqual([]);
  });

  test("bare /plan retains its existing mode-switching behavior", async () => {
    const printed: string[] = [];
    const modes: string[] = [];
    const reg = buildCommandRegistry({
      ...baseDeps(),
      setMode(mode) {
        modes.push(mode);
      },
    });

    await reg.get("plan")!.run("", {
      cwd: "/work",
      print(text) {
        printed.push(text);
      },
    });

    expect(modes).toEqual(["plan"]);
    expect(printed.join("\n")).toContain("plan mode");
  });
});

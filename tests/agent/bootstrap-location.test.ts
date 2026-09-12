import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLocationAnchor,
  describeOnDisk,
  isFreshBootstrap,
  locateProject,
  locationGroundingReminder,
  projectMarkersIn,
  renderLocationAnchor,
  resolveBuildDir,
  scanProject,
  shouldPromptBootstrapLocation,
  snapshotProjectMarkers,
  suggestSubdirName,
} from "../../src/agent/bootstrap-location";

test("isFreshBootstrap: only ignorable artifacts → true", () => {
  expect(isFreshBootstrap([])).toBe(true);
  expect(isFreshBootstrap([".cleetus", ".git", ".DS_Store"])).toBe(true);
  expect(isFreshBootstrap([".cleetus", "README.md"])).toBe(false);
  expect(isFreshBootstrap(["package.json"])).toBe(false);
});

test("suggestSubdirName: slug from request, fallback app", () => {
  expect(suggestSubdirName('Create a vite app named "sample-app".')).toBe("sample-app");
  expect(suggestSubdirName("build me something")).toBe("app");
});

test("renderLocationAnchor: cwd names the dir and forbids a subdir", () => {
  const a = renderLocationAnchor({ kind: "cwd" }, "/p/ct4");
  expect(a).toContain("/p/ct4");
  expect(a.toLowerCase()).toContain("do not create a subdirectory");
  expect(a).toContain("scaffold"); // tells the model to use the scaffold tool
});

test("renderLocationAnchor: subdir names the subdir path", () => {
  const a = renderLocationAnchor({ kind: "subdir", name: "sample-app" }, "/p/ct4");
  expect(a).toContain("/p/ct4/sample-app");
});

test("snapshotProjectMarkers: reports markers, empty string when none", () => {
  const s = snapshotProjectMarkers(["package.json", "src", "vite.config.ts", "random.txt"]);
  expect(s).toContain("package.json");
  expect(s).toContain("src");
  expect(s.toLowerCase()).toContain("do not re-scaffold");
  expect(snapshotProjectMarkers([".cleetus"])).toBe("");
});

test("snapshotProjectMarkers: node_modules is STILL a marker (byte-identical MARKERS list; the\n  orchestrator replan path must keep warning on a node_modules-only target)", () => {
  expect(snapshotProjectMarkers(["node_modules"])).toContain("do NOT re-scaffold");
});

test("appendLocationAnchor: subdir grounding is wrapped in a system-reminder, text preserved", () => {
  const out = appendLocationAnchor("build it", { kind: "subdir", name: "app" }, "/p");
  expect(out.startsWith("build it")).toBe(true);
  expect(out).toContain("<system-reminder>");
  expect(out).toContain("</system-reminder>");
  expect(out).toContain("/p/app"); // renderLocationAnchor's subdir path
});

test("appendLocationAnchor: cwd grounding injects the no-subdirectory guidance", () => {
  const out = appendLocationAnchor("go", { kind: "cwd" }, "/p");
  expect(out).toContain("<system-reminder>");
  expect(out).toContain("Do NOT create a subdirectory"); // renderLocationAnchor's cwd text
});

test("shouldPromptBootstrapLocation: normal + real multi-stack build prompt + fresh dir → true", () => {
  // The exact ct8 prompt. `isExplicitBuild` returns false for this (slashes + 3 tech words defeat
  // its noun regex); `isCodingTask` (leading "create") returns true — that is why the gate uses it.
  expect(
    shouldPromptBootstrapLocation({
      mode: "normal",
      text: 'Create a vite/react/typescript app named "sample-app"',
      entries: [".cleetus", ".git"],
    }),
  ).toBe(true);
});

test("shouldPromptBootstrapLocation: plan mode → false (read-only turn never scaffolds)", () => {
  expect(
    shouldPromptBootstrapLocation({
      mode: "plan",
      text: 'Create a vite/react/typescript app named "sample-app"',
      entries: [".cleetus"],
    }),
  ).toBe(false);
});

test("shouldPromptBootstrapLocation: non-coding text (a question) → false", () => {
  expect(
    shouldPromptBootstrapLocation({
      mode: "normal",
      text: "what's the best way to build an app?",
      entries: [".cleetus"],
    }),
  ).toBe(false);
});

test("shouldPromptBootstrapLocation: already-scaffolded dir → false", () => {
  expect(
    shouldPromptBootstrapLocation({
      mode: "normal",
      text: 'Create a vite/react/typescript app named "sample-app"',
      entries: [".cleetus", "package.json", "src"],
    }),
  ).toBe(false);
});

test("renderLocationAnchor: scaffold clause present by default (back-compat), both kinds", () => {
  const cwd = renderLocationAnchor({ kind: "cwd" }, "/p");
  expect(cwd).toContain("handles the non-empty-cwd case"); // scaffold clause
  const sub = renderLocationAnchor({ kind: "subdir", name: "app" }, "/p");
  expect(sub).toContain("Use the `scaffold` tool for the initial create-* command");
});

test("renderLocationAnchor: scaffold:false drops only the scaffold clause, keeps grounding", () => {
  const cwd = renderLocationAnchor({ kind: "cwd" }, "/p", { scaffold: false });
  expect(cwd).toContain("Build the project directly in the current working directory:\n/p");
  expect(cwd).toContain("Do NOT create a subdirectory");
  expect(cwd).not.toContain("scaffold"); // no scaffold-tool clause at all

  const sub = renderLocationAnchor({ kind: "subdir", name: "app" }, "/p", { scaffold: false });
  expect(sub).toContain("Create and build the project inside the subdirectory:\n/p/app");
  expect(sub).toContain("Every task operates inside it");
  expect(sub).not.toContain("scaffold");
});

test("resolveBuildDir: cwd → projectDir; subdir → projectDir/name", () => {
  expect(resolveBuildDir("/p", { kind: "cwd" })).toBe("/p");
  expect(resolveBuildDir("/p", { kind: "subdir", name: "app" })).toBe("/p/app");
});

test("describeOnDisk: fresh (only artifacts) → empty; else lists non-artifact entries", () => {
  expect(describeOnDisk([])).toBe("");
  expect(describeOnDisk([".cleetus", ".git"])).toBe("");
  const s = describeOnDisk([".cleetus", "package.json", "src", "node_modules"]);
  expect(s).toBe(
    "The project already exists on disk. It contains: package.json, src, node_modules",
  );
});

describe("projectMarkersIn", () => {
  test("recognizes exact markers and the vite/tsconfig patterns", () => {
    expect(
      projectMarkersIn(["package.json", "README.md", "vite.config.ts", "tsconfig.app.json"]),
    ).toEqual(["package.json", "vite.config.ts", "tsconfig.app.json"]);
    expect(projectMarkersIn(["README.md", "notes.txt"])).toEqual([]);
  });
});

describe("locateProject (pure)", () => {
  test("root markers → cwd (root wins even over a marker-bearing subdir)", () => {
    expect(locateProject(["package.json", "app"], { app: ["package.json"] })).toEqual({
      at: "cwd",
      markers: ["package.json"],
    });
  });
  test("one subdir with markers → subdir (single candidate)", () => {
    expect(
      locateProject(["sample-app", "README.md"], { "sample-app": ["package.json", "src"] }),
    ).toEqual({
      at: "subdir",
      candidates: [{ name: "sample-app", markers: ["package.json", "src"] }],
    });
  });
  test("two subdirs with markers → both listed", () => {
    const loc = locateProject(["a", "b"], { a: ["package.json"], b: ["Cargo.toml"] });
    expect(loc).toEqual({
      at: "subdir",
      candidates: [
        { name: "a", markers: ["package.json"] },
        { name: "b", markers: ["Cargo.toml"] },
      ],
    });
  });
  test("no markers anywhere → none", () => {
    expect(locateProject(["README.md"], { docs: [] })).toEqual({ at: "none" });
  });
});

describe("scanProject (fs)", () => {
  test("a subdir project with an otherwise-empty root → subdir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-scan-"));
    try {
      await mkdir(join(dir, "sample-app", "src"), { recursive: true });
      await writeFile(join(dir, "sample-app", "package.json"), "{}");
      await mkdir(join(dir, ".cleetus"), { recursive: true }); // ignored artifact
      const loc = await scanProject(dir);
      expect(loc.at).toBe("subdir");
      if (loc.at === "subdir") {
        expect(loc.candidates.map((c) => c.name)).toEqual(["sample-app"]);
        expect(loc.candidates[0]!.markers).toContain("package.json");
        expect(loc.candidates[0]!.markers).toContain("src");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("a root project → cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-scan-"));
    try {
      await writeFile(join(dir, "package.json"), "{}");
      expect((await scanProject(dir)).at).toBe("cwd");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("a fresh root → none; node_modules is not a candidate project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-scan-"));
    try {
      await mkdir(join(dir, "node_modules"), { recursive: true });
      await writeFile(join(dir, "node_modules", "package.json"), "{}"); // must NOT count
      expect((await scanProject(dir)).at).toBe("none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("a missing project dir → none (tolerated)", async () => {
    expect((await scanProject(join(tmpdir(), "cleetus-does-not-exist-xyz"))).at).toBe("none");
  });
  test("a root containing only dist/ → none; dist is not a candidate project (even with a marker inside)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-scan-"));
    try {
      await mkdir(join(dir, "dist"), { recursive: true });
      // A real marker file (not just a non-marker like index.js) so this test actually pins the
      // "dist" EXCLUDED_SUBDIRS entry: without the exclusion, this would read as a subdir candidate.
      await writeFile(join(dir, "dist", "package.json"), "{}");
      expect((await scanProject(dir)).at).toBe("none");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("locationGroundingReminder", () => {
  test("subdir single → names the dir and forbids re-scaffold", () => {
    const r = locationGroundingReminder({
      at: "subdir",
      candidates: [{ name: "sample-app", markers: ["package.json", "src"] }],
    });
    expect(r).toContain("<system-reminder>");
    expect(r).toContain("./sample-app");
    expect(r).toContain("package.json, src");
    expect(r).toContain("Do NOT re-scaffold");
  });
  test("subdir multiple → lists all candidates", () => {
    const r = locationGroundingReminder({
      at: "subdir",
      candidates: [
        { name: "web", markers: ["package.json"] },
        { name: "api", markers: ["go.mod"] },
      ],
    });
    expect(r).toContain("./web");
    expect(r).toContain("./api");
    expect(r).toContain("do NOT re-scaffold");
  });
  test("cwd and none → empty (no reminder)", () => {
    expect(locationGroundingReminder({ at: "cwd", markers: ["package.json"] })).toBe("");
    expect(locationGroundingReminder({ at: "none" })).toBe("");
  });
});

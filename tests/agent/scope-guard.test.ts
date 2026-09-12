import { expect, test } from "bun:test";
import {
  distinctiveTokens,
  isVerificationOnlyTitle,
  pathTokens,
  protectedControlPath,
  protectedInfrastructureBlock,
  protectedPackageCommandBlock,
  scopeBlockMessage,
  scopeCreepBlock,
} from "../../src/agent/scope-guard";

test("Cleetus and Git control metadata are never generic write-tool targets", () => {
  expect(protectedControlPath(".cleetus/sessions.db")).toBe(true);
  expect(protectedControlPath("./.git/config")).toBe(true);
  expect(protectedControlPath("src/.git-client.ts")).toBe(false);
  expect(protectedControlPath(".gitignore")).toBe(false);
});

test("recognizes verification-only task titles", () => {
  expect(isVerificationOnlyTitle("Verify build and smoke-test the alternate TUI skin")).toBe(true);
  expect(isVerificationOnlyTitle("Final review of the alternate TUI")).toBe(true);
  expect(isVerificationOnlyTitle("Recovery: verify exit-code capture")).toBe(true);
  expect(isVerificationOnlyTitle("Retry: Final verification with smoke tests")).toBe(true);
  expect(isVerificationOnlyTitle("Implement and verify the alternate TUI")).toBe(false);
});

test("distinctiveTokens drops stopwords, short tokens, and generic structural nouns", () => {
  expect([...distinctiveTokens("Build the Settings page and wire its route")]).toEqual([
    "settings",
  ]);
  // all-generic title reduces to nothing
  expect([...distinctiveTokens("Scaffold the app pages and components")]).toEqual(["scaffold"]);
});

test("pathTokens splits camelCase, kebab, snake across stem + dirs", () => {
  expect(pathTokens("src/pages/SettingsPage.tsx")).toEqual(
    new Set(["src", "pages", "settings", "page"]),
  );
  expect(pathTokens("components/user-profile/index.tsx")).toEqual(
    new Set(["components", "user", "profile", "index"]),
  );
});

test("blocks a brand-new path matching a pending title's distinctive token", () => {
  const d = scopeCreepBlock({
    path: "src/pages/SettingsPage.tsx",
    currentTitle: "Scaffold Vite React TS",
    pendingTitles: ["Build the Settings page"],
  });
  expect(d.blocked).toBe(true);
  expect(d.matchedTitle).toBe("Build the Settings page");
});

test("current task wins the tie: a path matching the current title is never blocked", () => {
  const d = scopeCreepBlock({
    path: "src/pages/SettingsPage.tsx",
    currentTitle: "Build the Settings page",
    pendingTitles: ["Polish the Settings page styling"],
  });
  expect(d.blocked).toBe(false);
});

test("whole-token match only: pending {user} does not match path token 'userland'", () => {
  const d = scopeCreepBlock({
    path: "src/userland/thing.ts",
    currentTitle: "Scaffold",
    pendingTitles: ["Add user auth"],
  });
  expect(d.blocked).toBe(false);
});

test("a pending title of only generic tokens never blocks", () => {
  const d = scopeCreepBlock({
    path: "src/pages/HomePage.tsx",
    currentTitle: "Scaffold",
    pendingTitles: ["Add the pages and components"],
  });
  expect(d.blocked).toBe(false);
});

test("directory tokens (src/pages/lib) are stopwords → no false block", () => {
  const d = scopeCreepBlock({
    path: "src/lib/util.ts",
    currentTitle: "Scaffold",
    pendingTitles: ["Wire the src lib utils"],
  });
  expect(d.blocked).toBe(false);
});

test("empty pendingTitles never blocks", () => {
  const d = scopeCreepBlock({
    path: "src/pages/SettingsPage.tsx",
    currentTitle: "anything",
    pendingTitles: [],
  });
  expect(d.blocked).toBe(false);
});

test("a pending verification task cannot steal implementation or test paths", () => {
  const pendingTitles = ["Verify build and smoke-test the alternate TUI skin"];

  expect(
    scopeCreepBlock({
      path: "tests/ui/tui/alt-skin.test.ts",
      currentTitle: "Set up dependencies and write failing tests for spec behavior",
      pendingTitles,
    }),
  ).toEqual({ blocked: false });
  expect(
    scopeCreepBlock({
      path: "src/ui/tui/skin.ts",
      currentTitle: "Implement the spec to make tests pass",
      pendingTitles,
    }),
  ).toEqual({ blocked: false });
  expect(
    scopeCreepBlock({
      path: "src/ui/tui/alt/AltApp.tsx",
      currentTitle: "Implement the spec to make tests pass",
      pendingTitles,
    }),
  ).toEqual({ blocked: false });
});

test("block message names the path, the matched title, and the current task", () => {
  const msg = scopeBlockMessage(
    "src/pages/SettingsPage.tsx",
    "Build the Settings page",
    "Scaffold",
  );
  expect(msg).toContain("src/pages/SettingsPage.tsx");
  expect(msg).toContain("Build the Settings page");
  expect(msg).toContain("Scaffold");
});

test("focused workers cannot mutate unowned package and build infrastructure", () => {
  const ownedPaths = ["src/insights/analyzers/plan-churn.ts"];
  expect(protectedInfrastructureBlock({ path: "scripts/build.ts", ownedPaths })).toBe(true);
  expect(protectedInfrastructureBlock({ path: "package.json", ownedPaths })).toBe(true);
  expect(protectedInfrastructureBlock({ path: "src/insights/report.ts", ownedPaths })).toBe(false);
  expect(protectedPackageCommandBlock({ command: "bun add ink-spinner", ownedPaths })).toBe(true);
  expect(protectedPackageCommandBlock({ command: "bun run build", ownedPaths })).toBe(false);
});

test("explicit ownership permits infrastructure and package-lock mutations", () => {
  expect(
    protectedInfrastructureBlock({ path: "scripts/build.ts", ownedPaths: ["scripts/build.ts"] }),
  ).toBe(false);
  expect(protectedInfrastructureBlock({ path: "bun.lock", ownedPaths: ["package.json"] })).toBe(
    false,
  );
  expect(
    protectedPackageCommandBlock({
      command: "cd app && bun add zod",
      ownedPaths: ["package.json"],
    }),
  ).toBe(false);
});

import { expect, test } from "bun:test";
import { explicitPlanFiles } from "../../src/agent/todo-progress";
import { resolveLaunchScope } from "../../src/config/launch-scope";
import { launchEditor } from "../../src/editor/launch";
import { parseEditorWords } from "../../src/editor/words";
import { comparablePath, expandHomePath, isPathWithin } from "../../src/lib/paths";
import { pathUnder } from "../../src/permission/evaluator";
import {
  detectMalformedProjectPath,
  detectMalformedToolPath,
} from "../../src/permission/malformed-path";
import { splitPatternPrefix } from "../../src/permission/path-guard";
import { projectTrustCommand } from "../../src/security/project-trust";
import { isSecretPath, secretDirPaths, secretFilePaths } from "../../src/security/secret-paths";

test("Windows containment handles drives, UNC shares, case, namespace paths and siblings", () => {
  expect(isPathWithin("C:\\Work\\Repo", "c:/work/repo/src/file.ts", "win32")).toBe(true);
  expect(isPathWithin("C:\\Work\\Repo", "D:\\Work\\Repo\\file.ts", "win32")).toBe(false);
  expect(isPathWithin("C:\\Work\\Repo", "C:\\Work\\Repository\\file.ts", "win32")).toBe(false);
  expect(isPathWithin("C:\\Work\\Repo", "C:\\Work\\Repo\\..\\secret", "win32")).toBe(false);
  expect(isPathWithin("\\\\host\\share\\repo", "\\\\HOST\\share\\repo\\child", "win32")).toBe(true);
  expect(isPathWithin("\\\\host\\share\\repo", "\\\\host\\other\\repo", "win32")).toBe(false);
  expect(comparablePath("\\\\?\\C:\\Work\\Repo", "win32")).toBe("c:\\work\\repo");
  expect(isPathWithin("C:\\Work\\Repo", "\\\\?\\C:\\Work\\Repo\\child", "win32")).toBe(true);
  expect(isPathWithin("/work/repo", "/work/Repo/file", "linux")).toBe(false);
});

test.skipIf(process.platform !== "win32")("permission prefixes use Windows containment", () => {
  expect(pathUnder("c:/work/repo/private/key", "C:\\Work\\Repo\\Private")).toBe(true);
  expect(pathUnder("D:\\Work\\Repo\\Private\\key", "C:\\Work\\Repo\\Private")).toBe(false);
  expect(pathUnder("C:\\Work\\Repository\\key", "C:\\Work\\Repo")).toBe(false);
});

test("home expansion accepts Windows tilde separators while preserving Unix backslashes", () => {
  expect(expandHomePath("~\\notes", "C:\\Users\\Sam", "win32")).toBe("C:\\Users\\Sam\\notes");
  expect(expandHomePath("~/notes", "C:\\Users\\Sam", "win32")).toBe("C:\\Users\\Sam\\notes");
  expect(expandHomePath("~\\notes", "/home/sam", "linux")).toBe("~\\notes");
});

test.skipIf(process.platform !== "win32")(
  "launch scopes expand native ~\\ paths and editors reject another drive",
  async () => {
    expect(
      resolveLaunchScope({
        global: true,
        scratch: false,
        cwd: "C:\\project",
        home: "C:\\Users\\Sam",
        globalWorkspaceDir: "~\\notes",
      }).dir,
    ).toBe("C:\\Users\\Sam\\notes");
    await expect(
      launchEditor({
        cwd: "C:\\project",
        args: "D:\\outside.txt",
        editor: "C:\\Tools\\editor.exe",
        exists: () => true,
        realpath: (path) => path,
        spawn: () => {
          throw new Error("Editor must not launch");
        },
      }),
    ).rejects.toThrow("outside the project");
  },
);

test("secret guards include roaming credentials and Windows spelling variants without sibling overmatch", () => {
  const home = "C:\\Users\\Sam";
  const opts = { platform: "win32" as const, env: { APPDATA: "D:\\Roaming\\Sam" } };
  for (const path of [
    "c:/users/SAM/.SSH/id_ed25519",
    "C:\\Users\\Sam\\_netrc",
    "D:/roaming/sam/GCLOUD/credentials.db",
    "\\\\?\\C:\\Users\\Sam\\.aws\\credentials",
  ])
    expect(isSecretPath(path, home, opts)).toBe(true);
  expect(isSecretPath("D:/Roaming/Sam/gcloud-other/file", home, opts)).toBe(false);
  expect(secretDirPaths(home, opts)).toContain("D:\\Roaming\\Sam\\gnupg");
  expect(secretFilePaths(home, opts)).toContain("C:\\Users\\Sam\\_netrc");
});

test("editor arguments retain Windows paths, UNC prefixes and trailing separators", () => {
  expect(
    parseEditorWords(
      '"C:\\Program Files\\Editor\\editor.exe" --wait "C:\\Work Ω\\" \\\\host\\share\\notes.txt',
      "editor",
      "win32",
    ),
  ).toEqual([
    "C:\\Program Files\\Editor\\editor.exe",
    "--wait",
    "C:\\Work Ω\\",
    "\\\\host\\share\\notes.txt",
  ]);
  expect(splitPatternPrefix("C:\\Work\\src\\**\\..\\secret", "win32")).toEqual({
    prefix: "C:/Work/src",
    tailHasDotDot: true,
  });
});

test("plan file summaries normalize relative Windows paths and reject absolute drive paths", () => {
  expect(
    explicitPlanFiles(
      "## File summary\n| File | Purpose |\n|---|---|\n| `src\\app.ts` | source |\n| `C:\\outside\\app.ts` | absolute |\n| `..\\outside.ts` | parent |",
    ),
  ).toEqual(["src/app.ts"]);
});

test.skipIf(process.platform !== "win32")(
  "Windows repair heuristics keep drive paths intact and trust guidance quotes apostrophes",
  async () => {
    expect(
      await detectMalformedProjectPath(
        "C:\\work\\f REPO\\src\\app.ts",
        "C:\\Work\\repo",
        async (dir) => dir.toLowerCase() === "c:\\work\\repo\\src",
      ),
    ).toEqual({ suggestion: "C:\\Work\\repo\\src\\app.ts" });
    expect(
      await detectMalformedToolPath(
        "read_file",
        { path: "D:\\src\\app.ts" },
        "C:\\repo",
        async (dir) => dir.startsWith("C:\\repo"),
      ),
    ).toBeNull();
    const command = projectTrustCommand({
      projectDir: "C:\\Work\\O'Brien",
      globalPath: "D:\\Config\\config.yaml",
    });
    expect(command).toContain("'C:\\Work\\O''Brien'");
  },
);

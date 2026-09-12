import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("dependency pinning policy", () => {
  test("direct Bun dependencies use exact versions or local files", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const specs = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, spec] of Object.entries(specs)) {
      expect(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec) || spec.startsWith("file:"),
        `${name} must use an exact version or a local file`,
      ).toBe(true);
    }
  });

  test("GitHub Actions use commit SHAs and fixed runner labels", () => {
    const workflowDir = join(root, ".github/workflows");
    for (const filename of readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name))) {
      const workflow = readFileSync(join(workflowDir, filename), "utf8");
      for (const match of workflow.matchAll(/\buses:\s+\S+@([^\s#]+)/g)) {
        expect(match[1], `${filename} action must use a full commit SHA`).toMatch(/^[0-9a-f]{40}$/);
      }
      for (const match of workflow.matchAll(/\bruns-on:\s+([^\s#]+)/g)) {
        expect(match[1], `${filename} runner must not use a latest alias`).not.toEndWith("-latest");
      }
    }
  });

  test("installer CI pins the Ubuntu Bats package", () => {
    expect(read(".github/workflows/installer.yml")).toMatch(
      /apt-get install -y bats=\d+\.\d+\.\d+-\d+/,
    );
  });
});

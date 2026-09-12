import { describe, expect, it } from "bun:test";
import {
  destructiveCommandDecision,
  nestedGitInitGrounding,
} from "../../src/tools/destructive-command";

const decide = (command: string, projectAlreadyExists = true) =>
  destructiveCommandDecision({
    command,
    projectDir: "/work/sysprompter",
    projectAlreadyExists,
  });

describe("destructiveCommandDecision", () => {
  it("blocks deletion of project control metadata", () => {
    expect(decide("rm -rf .cleetus").blocked).toBe(true);
    expect(decide("rm -fr .git").blocked).toBe(true);
    expect(decide('rm -rf "/work/sysprompter/.cleetus"').blocked).toBe(true);
  });

  it("blocks broad project-root deletion while allowing focused build cleanup", () => {
    expect(decide("rm -rf ./*").blocked).toBe(true);
    expect(decide("rm -rf /work/sysprompter").blocked).toBe(true);
    expect(decide('rm -rf "$PWD"').blocked).toBe(true);
    expect(decide("cd .. && rm -rf sysprompter").blocked).toBe(true);
    expect(decide("rm -rf ../sysprompter").blocked).toBe(true);
    expect(decide("rm -rf src package.json tsconfig.json").blocked).toBe(true);
    expect(decide("rm -rf src/*").blocked).toBe(true);
    expect(decide("rm -rf 'src/{*,.*}'").blocked).toBe(true);
    expect(decide("rm src/index.ts").blocked).toBe(false);
    expect(decide("rm -rf dist node_modules").blocked).toBe(false);
  });

  it("blocks forced Git clean and project-root find deletion", () => {
    expect(decide("git clean -fdx").blocked).toBe(true);
    expect(decide("git clean -f -d").blocked).toBe(true);
    expect(decide("find . -mindepth 1 -delete").blocked).toBe(true);
  });

  it("blocks direct generators over an existing root but permits a fresh root or subdir", () => {
    expect(decide("bunx create-vite . --template vanilla-ts").blocked).toBe(true);
    expect(decide("printf 'y\\n' | bun create vite .").blocked).toBe(true);
    expect(decide("bunx create-vite ./web --template vanilla-ts").blocked).toBe(false);
    expect(decide("bunx create-vite . --template vanilla-ts", false).blocked).toBe(false);
  });
});

describe("nestedGitInitGrounding", () => {
  const project = "/work/app";
  const ground = (command: string, cwd?: string) =>
    nestedGitInitGrounding({ command, cwd, projectDir: project });

  it("steers a git init that lands in a subdirectory of the project", () => {
    // explicit path argument
    expect(ground("git init app")).toContain("subdirectory of the project");
    expect(ground("git init app")).toContain("app/app");
    // bare init from a subdirectory cwd
    expect(ground("git init", "/work/app/app")).toContain("orphans the repository");
    // leading cd into a subdirectory
    expect(ground("cd app && git init && git add -A")).toContain("git init` at the project root");
  });

  it("allows a git init that targets the project root", () => {
    expect(ground("git init")).toBeNull();
    expect(ground("git init .")).toBeNull();
    expect(ground("git init --bare", "/work/app")).toBeNull();
    expect(ground("git init /work/app")).toBeNull();
  });

  it("ignores commands that are not a git init", () => {
    expect(ground("git add -A && git commit -m x")).toBeNull();
    expect(ground("bun create vite app")).toBeNull();
  });
});

import { join } from "node:path";
import type { TestConfig } from "../../config/types";

export interface DetectedTestCommand {
  runnerId: string;
  argv: string[];
  summaryRegex?: RegExp;
}

export interface DetectResult {
  command: DetectedTestCommand | null;
  warnings: string[];
}

type Which = (bin: string) => string | null;

const PYTEST_SUMMARY = /^=+ .*(?:passed|failed|error).* =+$/m;
const CARGO_SUMMARY = /^test result: .*$/m;

async function exists(projectDir: string, rel: string): Promise<boolean> {
  return await Bun.file(join(projectDir, rel)).exists();
}

function normalizeCommand(command: string | string[]): string[] {
  return Array.isArray(command) ? command : command.trim().split(/\s+/);
}

const STACK_MARKERS = [
  "package.json",
  "pyproject.toml",
  "pytest.ini",
  "setup.cfg",
  "Cargo.toml",
  "go.mod",
];

/** True when the dir looks like a code project that could carry tests: any known stack marker
 *  file is present, or a test command is explicitly configured. Used to register run_tests so a
 *  harness scaffolded mid-session is usable, even if no runner is detected yet. */
export async function hasStackMarker(projectDir: string, config: TestConfig): Promise<boolean> {
  if (config.command) return true;
  for (const m of STACK_MARKERS) if (await exists(projectDir, m)) return true;
  return false;
}

/** True when package.json parses and has a string `scripts.test`. Malformed → false. */
async function hasTestScript(projectDir: string): Promise<boolean> {
  try {
    const raw = await Bun.file(join(projectDir, "package.json")).text();
    const pkg = JSON.parse(raw) as { scripts?: { test?: unknown } };
    return typeof pkg?.scripts?.test === "string";
  } catch {
    return false;
  }
}

async function packageManager(projectDir: string): Promise<string> {
  if (await exists(projectDir, "pnpm-lock.yaml")) return "pnpm";
  if (await exists(projectDir, "yarn.lock")) return "yarn";
  return "npm";
}

/**
 * Detect the project's full-suite test command. `config.command` overrides everything;
 * otherwise an ordered runner list (Node/Bun → Python → Rust → Go), first match wins.
 * `which` is injected so detection is deterministic in tests.
 */
export async function detectTestCommand(
  projectDir: string,
  config: TestConfig,
  which: Which = (b) => Bun.which(b),
  check: "test" | "build" | "typecheck" | "lint" = "test",
): Promise<DetectResult> {
  const warnings: string[] = [];

  if (check !== "test") {
    try {
      const pkg = await Bun.file(join(projectDir, "package.json")).json();
      if (typeof pkg.scripts?.[check] === "string")
        return { command: { runnerId: "script", argv: ["bun", "run", check] }, warnings };
    } catch {
      /* actionable unavailable result below */
    }
    return {
      command: null,
      warnings: [
        `no ${check} script detected; configure the existing project check before retrying`,
      ],
    };
  }
  if (config.command) {
    return { command: { runnerId: "config", argv: normalizeCommand(config.command) }, warnings };
  }

  // 1. Node / Bun
  if (await exists(projectDir, "package.json")) {
    if ((await exists(projectDir, "bun.lockb")) || (await exists(projectDir, "bun.lock"))) {
      if (await hasTestScript(projectDir)) {
        const pkg = await Bun.file(join(projectDir, "package.json")).json();
        const script = pkg.scripts.test.trim();
        const vitest = /^vitest(?:\s|$)/.test(script) && !/[;&|]/.test(script);
        return {
          command: {
            runnerId: vitest ? "vitest" : /^bun test(?:\s|$)/.test(script) ? "bun" : "node",
            argv: [
              "bun",
              "run",
              "test",
              ...(vitest && !/\brun\b|--run/.test(script) ? ["--run"] : []),
            ],
          },
          warnings,
        };
      }
      return { command: { runnerId: "bun", argv: ["bun", "test"] }, warnings };
    }
    if (await hasTestScript(projectDir)) {
      const pm = await packageManager(projectDir);
      return { command: { runnerId: "node", argv: [pm, "test"] }, warnings };
    }
    if (which("bun")) {
      return { command: { runnerId: "bun", argv: ["bun", "test"] }, warnings };
    }
    warnings.push("node tests unavailable: no test script and bun not found");
  }

  // 2. Python
  if (
    (await exists(projectDir, "pyproject.toml")) ||
    (await exists(projectDir, "pytest.ini")) ||
    (await exists(projectDir, "setup.cfg"))
  ) {
    if (which("pytest")) {
      return {
        command: { runnerId: "pytest", argv: ["pytest"], summaryRegex: PYTEST_SUMMARY },
        warnings,
      };
    }
    warnings.push("python tests unavailable: 'pytest' not found");
  }

  // 3. Rust
  if (await exists(projectDir, "Cargo.toml")) {
    if (which("cargo")) {
      return {
        command: { runnerId: "cargo", argv: ["cargo", "test"], summaryRegex: CARGO_SUMMARY },
        warnings,
      };
    }
    warnings.push("rust tests unavailable: 'cargo' not found");
  }

  // 4. Go
  if (await exists(projectDir, "go.mod")) {
    if (which("go")) {
      return { command: { runnerId: "go", argv: ["go", "test", "./..."] }, warnings };
    }
    warnings.push("go tests unavailable: 'go' not found");
  }

  return { command: null, warnings };
}

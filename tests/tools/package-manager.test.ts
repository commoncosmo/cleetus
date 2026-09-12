import { expect, test } from "bun:test";
import {
  commandInvokesForeignPackageManager,
  packageManagerDecision,
} from "../../src/tools/package-manager";

function block(command: string) {
  return packageManagerDecision({ command, bunProject: true });
}

test("does not block foreign package managers outside a Bun project", () => {
  expect(packageManagerDecision({ command: "npx vitest run", bunProject: false }).blocked).toBe(
    false,
  );
  expect(packageManagerDecision({ command: "npm install", bunProject: false }).blocked).toBe(false);
});

test("blocks npx in a Bun project and suggests bunx", () => {
  const d = block('npx vitest run src/pages/Home.test.tsx -t "New Thread"');
  expect(d.blocked).toBe(true);
  expect(d.message).toContain("bunx vitest run src/pages/Home.test.tsx");
  expect(d.message).toContain("Bun project");
});

test("maps common npm subcommands to their Bun equivalents", () => {
  expect(block("npm install").message).toContain("bun install");
  expect(block("npm ci").message).toContain("bun install");
  expect(block("npm install react react-dom").message).toContain("bun add react react-dom");
  expect(block("npm install -D vitest").message).toContain("bun add -D vitest");
  expect(block("npm run build").message).toContain("bun run build");
  expect(block("npm test").message).toContain("bun test");
  expect(block("npm exec shadcn init").message).toContain("bunx shadcn init");
});

test("maps yarn and pnpm invocations too", () => {
  expect(block("yarn").message).toContain("bun install");
  expect(block("yarn add lodash").message).toContain("bun add lodash");
  expect(block("pnpm install").message).toContain("bun install");
  expect(block("pnpm dlx create-vite").message).toContain("bunx create-vite");
});

test("catches a foreign manager after a shell operator or an env prefix", () => {
  expect(block("cat package.json && npm install").blocked).toBe(true);
  expect(block("NODE_ENV=production npm run build").blocked).toBe(true);
  expect(block("echo hi | npx tsc").blocked).toBe(true);
});

test("does not block Bun's own commands or incidental mentions", () => {
  expect(block("bun add react").blocked).toBe(false);
  expect(block("bunx vitest run").blocked).toBe(false);
  expect(block("bun run build").blocked).toBe(false);
  // "npm" only inside a quoted argument or another word — not an invocation.
  expect(block('echo "run npm install first"').blocked).toBe(false);
  expect(block("grep -r npm src").blocked).toBe(false);
  expect(block("bunx npm-check-updates").blocked).toBe(false);
});

test("quick-check mirrors the decision's trigger", () => {
  expect(commandInvokesForeignPackageManager("npx vitest")).toBe(true);
  expect(commandInvokesForeignPackageManager("cat x && pnpm add y")).toBe(true);
  expect(commandInvokesForeignPackageManager("bun run test")).toBe(false);
  expect(commandInvokesForeignPackageManager('echo "npm"')).toBe(false);
});

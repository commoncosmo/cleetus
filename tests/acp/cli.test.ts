import { expect, test } from "bun:test";
import { parseAcpOptions } from "../../src/acp/cli";

const base = ["/bin/bun", "/path/cleetus", "acp"];

test("parses provider, model, and session-db", () => {
  const o = parseAcpOptions([
    ...base,
    "--provider",
    "p",
    "--model",
    "m",
    "--session-db",
    "/tmp/s.db",
  ]);
  expect(o.provider).toBe("p");
  expect(o.model).toBe("m");
  expect(o.sessionDb).toBe("/tmp/s.db");
});

test("parses persona, personality, and effort (so chat honors Settings)", () => {
  const o = parseAcpOptions([
    ...base,
    "--persona",
    "chat",
    "--personality",
    "cleetus",
    "--effort",
    "high",
  ]);
  expect(o.persona).toBe("chat");
  expect(o.personality).toBe("cleetus");
  expect(o.effort).toBe("high");
});

test("leaves unset options undefined", () => {
  const o = parseAcpOptions([...base]);
  expect(o.provider).toBeUndefined();
  expect(o.model).toBeUndefined();
  expect(o.sessionDb).toBeUndefined();
  expect(o.persona).toBeUndefined();
  expect(o.personality).toBeUndefined();
  expect(o.effort).toBeUndefined();
});

test("tolerates unknown options for forward-compatibility", () => {
  const o = parseAcpOptions([...base, "--session-db", "/tmp/s.db", "--future", "x"]);
  expect(o.sessionDb).toBe("/tmp/s.db");
});

test("parses --project-dir into projectHome", () => {
  expect(parseAcpOptions([...base, "--project-dir", "/home/acme"]).projectHome).toBe("/home/acme");
});

test("project inheritance defaults to on", () => {
  const o = parseAcpOptions([...base]);
  expect(o.projectHome).toBeUndefined();
  expect(o.inheritProjectInstructions).toBe(true);
  expect(o.inheritProjectMemory).toBe(true);
});

test("--no-project-instructions / --no-project-memory opt out independently", () => {
  const o = parseAcpOptions([...base, "--no-project-instructions", "--no-project-memory"]);
  expect(o.inheritProjectInstructions).toBe(false);
  expect(o.inheritProjectMemory).toBe(false);
});

test("parses --route and the routing tier flags", () => {
  const o = parseAcpOptions([
    ...base,
    "--route",
    "smart",
    "--route-small-provider",
    "lm",
    "--route-small-model",
    "small-x",
    "--route-large-provider",
    "lm",
    "--route-large-model",
    "large-x",
  ]);
  expect(o.route).toBe("smart");
  expect(o.routeSmallProvider).toBe("lm");
  expect(o.routeSmallModel).toBe("small-x");
  expect(o.routeLargeProvider).toBe("lm");
  expect(o.routeLargeModel).toBe("large-x");
});

test("routing flags are undefined when unset", () => {
  const o = parseAcpOptions([...base]);
  expect(o.route).toBeUndefined();
  expect(o.routeSmallProvider).toBeUndefined();
  expect(o.routeLargeModel).toBeUndefined();
});

test("parses --verbose and defaults it off", () => {
  expect(parseAcpOptions([...base]).verbose).toBeUndefined();
  expect(parseAcpOptions([...base, "--verbose"]).verbose).toBe(true);
});

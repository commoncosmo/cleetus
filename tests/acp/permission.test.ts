import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  type PermissionClient,
  type SessionGrants,
  makeAcpResolvePermission,
} from "../../src/acp/permission";
import type { PermissionRules } from "../../src/permission/types";
import type { ToolAuthorization } from "../../src/tools/types";

function emptyGrants(): SessionGrants {
  return { tools: new Set<string>(), prefixes: [], denials: [], bashCommands: [], jobScopes: [] };
}

/** A client whose `requestPermission` throws if called — used to prove a call short-circuits
 *  (session denial / persisted deny rule) without ever prompting. */
function clientThatThrowsIfAsked(): PermissionClient {
  return {
    requestPermission(): never {
      throw new Error("should not prompt");
    },
  };
}

/** A client that always selects the option with the given optionId (or the first, if absent).
 *  Records the full toolCall of each request so tests can assert wire fields (e.g. locations). */
function clientPicking(optionId: string, outcome: "selected" | "cancelled" = "selected") {
  const calls: {
    options: { optionId: string; name: string; kind: string }[];
    toolCall: {
      toolCallId?: string;
      title?: string;
      kind?: string;
      status?: string;
      rawInput?: unknown;
      locations?: { path: string }[];
    };
  }[] = [];
  const client: PermissionClient = {
    async requestPermission(req) {
      calls.push({
        options: req.options,
        toolCall: req.toolCall as { locations?: { path: string }[] },
      });
      if (outcome === "cancelled") return { outcome: { outcome: "cancelled" } };
      const chosen = req.options.find((o) => o.optionId === optionId) ?? req.options[0]!;
      return { outcome: { outcome: "selected", optionId: chosen.optionId } };
    },
  };
  return { client, calls };
}

const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), "acp-perm-")));

const READ_JOB_AUTHORIZATION: ToolAuthorization = {
  type: "client_job",
  kind: "sast.semgrep",
  effect: "read",
  target: "repo:current",
  limits: { timeoutMs: 60_000, maxOutputBytes: 10_000, maxArtifactBytes: 20_000 },
};

describe("makeAcpResolvePermission", () => {
  it("maps allow_once to allow without recording a grant", async () => {
    const { client, calls } = clientPicking("allow_once");
    const grants = emptyGrants();
    const resolve = makeAcpResolvePermission(client, "s1", grants, PROJECT);
    expect(await resolve({ toolCallId: "call-1", tool: "bash", args: {}, argsSummary: "ls" })).toBe(
      "allow",
    );
    expect(grants.tools.has("bash")).toBe(false);
    expect(calls[0]?.toolCall).toMatchObject({
      toolCallId: "call-1",
      title: "ls",
      kind: "execute",
      status: "pending",
      rawInput: {},
    });
  });

  it("maps a whole-tool allow_always to allow and short-circuits next time (non-write, non-bash tool)", async () => {
    const { client, calls } = clientPicking("allow_always");
    const grants = emptyGrants();
    const resolve = makeAcpResolvePermission(client, "s1", grants, PROJECT);
    expect(await resolve({ tool: "read_file", args: {}, argsSummary: "a.ts" })).toBe("allow");
    expect(grants.tools.has("read_file")).toBe(true);
    expect(await resolve({ tool: "read_file", args: {}, argsSummary: "b.ts" })).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("bash 'always allow' grants only a exact command", async () => {
    const grants = emptyGrants();
    const resolve = makeAcpResolvePermission(
      clientPicking("allow_bash_exact").client,
      "s1",
      grants,
      PROJECT,
    );
    expect(
      await resolve({ tool: "bash", args: { command: "bun test" }, argsSummary: "bun test" }),
    ).toBe("allow");
    expect(grants.bashCommands).toEqual([{ command: "bun test", cwd: PROJECT }]);
    expect(grants.tools.has("bash")).toBe(false);

    // Identical call sails through without prompting…
    const noPrompt = makeAcpResolvePermission(clientThatThrowsIfAsked(), "s1", grants, PROJECT);
    expect(
      await noPrompt({
        tool: "bash",
        args: { command: "bun test" },
        argsSummary: "bun test",
      }),
    ).toBe("allow");
    // …but a different command still prompts (client throws → test fails if prompted path not taken).
    await expect(
      noPrompt({ tool: "bash", args: { command: "rm -rf /tmp/x" }, argsSummary: "rm -rf /tmp/x" }),
    ).rejects.toThrow("should not prompt");
  });

  it("bash exact grants do not authorize lookalikes", async () => {
    const grants = emptyGrants();
    grants.bashCommands = [{ command: "bun test", cwd: PROJECT }];
    const resolve = makeAcpResolvePermission(clientThatThrowsIfAsked(), "s1", grants, PROJECT);
    // identical commands allow without prompting
    expect(
      await resolve({ tool: "bash", args: { command: "bun test" }, argsSummary: "bun test" }),
    ).toBe("allow");
    expect(
      await resolve({
        tool: "bash",
        args: { command: "bun test" },
        argsSummary: "bun test",
      }),
    ).toBe("allow");
    // a look-alike sharing the string prefix but not a token boundary must prompt, not auto-allow
    await expect(
      resolve({
        tool: "bash",
        args: { command: "bun testx-malicious" },
        argsSummary: "bun testx-malicious",
      }),
    ).rejects.toThrow("should not prompt");
  });

  it("an empty-command bash grant records nothing", async () => {
    const grants = emptyGrants();
    const resolve = makeAcpResolvePermission(
      clientPicking("allow_bash_exact").client,
      "s1",
      grants,
      PROJECT,
    );
    expect(await resolve({ tool: "bash", args: { command: "" }, argsSummary: "   " })).toBe(
      "allow",
    );
    expect(grants.bashCommands).toEqual([]);
  });

  it("a rogue allow_always echo for bash yields deny, not a blanket grant", async () => {
    // bash is never offered "allow_always" (only "allow_bash_exact"), but a buggy/rogue client
    // might echo it anyway — force it to prove the guard is structural, not option-driven.
    const client: PermissionClient = {
      async requestPermission() {
        return { outcome: { outcome: "selected", optionId: "allow_always" } };
      },
    };
    const grants = emptyGrants();
    const resolve = makeAcpResolvePermission(client, "s1", grants, PROJECT);
    expect(await resolve({ tool: "bash", args: { command: "ls" }, argsSummary: "ls" })).toBe(
      "deny",
    );
    expect(grants.tools.has("bash")).toBe(false);
  });

  it("maps reject to deny", async () => {
    const { client } = clientPicking("reject_once");
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT);
    expect(await resolve({ tool: "bash", args: {}, argsSummary: "rm" })).toBe("deny");
  });

  it("maps a cancelled outcome to deny", async () => {
    const { client } = clientPicking("allow_once", "cancelled");
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT);
    expect(await resolve({ tool: "bash", args: {}, argsSummary: "x" })).toBe("deny");
  });

  it("short-circuits a write whose target is under a granted prefix (no client call)", async () => {
    const { client, calls } = clientPicking("allow_once");
    const grants: SessionGrants = {
      tools: new Set(),
      prefixes: [join(PROJECT, "src")],
      denials: [],
      bashCommands: [],
      jobScopes: [],
    };
    const resolve = makeAcpResolvePermission(client, "s1", grants, PROJECT);
    // under the granted prefix → allow without prompting
    expect(
      await resolve({ tool: "write_file", args: { path: "src/a.ts" }, argsSummary: "src/a.ts" }),
    ).toBe("allow");
    expect(
      await resolve({
        tool: "edit_file",
        args: { path: "src/sub/b.ts" },
        argsSummary: "src/sub/b.ts",
      }),
    ).toBe("allow");
    expect(calls).toHaveLength(0);
    // outside the granted prefix → prompts (client picks allow_once)
    expect(
      await resolve({ tool: "write_file", args: { path: "lib/c.ts" }, argsSummary: "lib/c.ts" }),
    ).toBe("allow");
    expect(calls).toHaveLength(1);
  });
});

describe("makeAcpResolvePermission — directory-scoped options", () => {
  it("offers allow_dir (not whole-tool allow_always) for an in-tree writer", async () => {
    const { client, calls } = clientPicking("allow_once");
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT);
    await resolve({ tool: "write_file", args: { path: "src/a.ts" }, argsSummary: "src/a.ts" });
    const ids = calls[0]!.options.map((o) => o.optionId);
    expect(ids).toEqual(["allow_once", "allow_dir", "reject_once", "reject_always"]);
    const dir = calls[0]!.options.find((o) => o.optionId === "allow_dir")!;
    expect(dir.name).toBe(`Always allow edits in src${sep}`);
    expect(dir.kind).toBe("allow_always");
  });

  it("offers allow-once only (no allow_dir, no allow_always) for an out-of-tree writer", async () => {
    const { client, calls } = clientPicking("allow_once");
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT);
    expect(
      await resolve({ tool: "write_file", args: { path: "/etc/x" }, argsSummary: "/etc/x" }),
    ).toBe("allow");
    expect(calls[0]!.options.map((o) => o.optionId)).toEqual([
      "allow_once",
      "reject_once",
      "reject_always",
    ]);
    // nothing was granted: a second out-of-tree write prompts again
    await resolve({ tool: "write_file", args: { path: "/etc/y" }, argsSummary: "/etc/y" });
    expect(calls).toHaveLength(2);
  });

  it("leaves non-write, non-bash tools with the original four options", async () => {
    const { client, calls } = clientPicking("allow_once");
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT);
    await resolve({ tool: "read_file", args: {}, argsSummary: "a.ts" });
    expect(calls[0]!.options.map((o) => o.optionId)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
      "reject_always",
    ]);
  });

  it("offers bash an exact-command option, not blanket allow_always", async () => {
    const { client, calls } = clientPicking("allow_once");
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT);
    await resolve({ tool: "bash", args: { command: "ls" }, argsSummary: "ls" });
    expect(calls[0]!.options.map((o) => o.optionId)).toEqual([
      "allow_once",
      "allow_bash_exact",
      "reject_once",
      "reject_always",
    ]);
    const opt = calls[0]!.options.find((o) => o.optionId === "allow_bash_exact")!;
    expect(opt.name).toBe(`Always allow this exact command in ${PROJECT}`);
    expect(opt.kind).toBe("allow_always");
  });

  it("a rogue allow_always echo for a writer denies and grants nothing (whole-tool grant is never given to writers)", async () => {
    // A conformant client only ever echoes an offered optionId, but a buggy/rogue one might not —
    // force "allow_always" even though a writer is never offered it, to prove the guard is structural.
    const client: PermissionClient = {
      async requestPermission() {
        return { outcome: { outcome: "selected", optionId: "allow_always" } };
      },
    };
    const grants = emptyGrants();
    const resolve = makeAcpResolvePermission(client, "s1", grants, PROJECT);
    expect(
      await resolve({ tool: "write_file", args: { path: "src/a.ts" }, argsSummary: "src/a.ts" }),
    ).toBe("deny");
    expect(grants.tools.size).toBe(0);
  });

  it("covers multi_edit: offers allow_dir for an in-tree target and short-circuits after a src/ grant", async () => {
    const { client, calls } = clientPicking("allow_once");
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT);
    await resolve({ tool: "multi_edit", args: { path: "src/m.ts" }, argsSummary: "src/m.ts" });
    expect(calls[0]!.options.map((o) => o.optionId)).toEqual([
      "allow_once",
      "allow_dir",
      "reject_once",
      "reject_always",
    ]);
  });

  it("multi_edit short-circuits once src/ is granted via write_file allow_dir", async () => {
    const { client, calls } = clientPicking("allow_dir");
    const grants = emptyGrants();
    const resolve = makeAcpResolvePermission(client, "s1", grants, PROJECT);
    expect(
      await resolve({ tool: "write_file", args: { path: "src/a.ts" }, argsSummary: "src/a.ts" }),
    ).toBe("allow");
    expect(grants.prefixes).toEqual([join(PROJECT, "src")]);
    expect(
      await resolve({ tool: "multi_edit", args: { path: "src/n.ts" }, argsSummary: "src/n.ts" }),
    ).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("a root-level write offers 'Always allow edits in ./' and granting it covers deeply nested paths", async () => {
    const { client, calls } = clientPicking("allow_dir");
    const grants = emptyGrants();
    const resolve = makeAcpResolvePermission(client, "s1", grants, PROJECT);
    expect(
      await resolve({ tool: "write_file", args: { path: "root.ts" }, argsSummary: "root.ts" }),
    ).toBe("allow");
    const dir = calls[0]!.options.find((o) => o.optionId === "allow_dir")!;
    expect(dir.name).toBe(`Always allow edits in .${sep}`);
    expect(grants.prefixes).toEqual([PROJECT]);
    expect(
      await resolve({ tool: "write_file", args: { path: "a/b/c.ts" }, argsSummary: "a/b/c.ts" }),
    ).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("allow_dir records the containing dir; later in-dir writes short-circuit, sibling dirs prompt", async () => {
    const { client, calls } = clientPicking("allow_dir");
    const grants = emptyGrants();
    const resolve = makeAcpResolvePermission(client, "s1", grants, PROJECT);
    // grant edits in src/
    expect(
      await resolve({ tool: "write_file", args: { path: "src/a.ts" }, argsSummary: "src/a.ts" }),
    ).toBe("allow");
    expect(grants.prefixes).toEqual([join(PROJECT, "src")]);
    // in-dir writes (incl. nested + other write tools) auto-allow, no new prompt
    expect(
      await resolve({ tool: "edit_file", args: { path: "src/b.ts" }, argsSummary: "src/b.ts" }),
    ).toBe("allow");
    expect(
      await resolve({
        tool: "apply_patch",
        args: {
          patch: "*** Begin Patch\n*** Update File: src/sub/c.ts\n@@\n-x\n+y\n*** End Patch",
        },
        argsSummary: "src/sub/c.ts",
      }),
    ).toBe("allow");
    expect(calls).toHaveLength(1);
    // a sibling dir still prompts
    await resolve({ tool: "write_file", args: { path: "lib/d.ts" }, argsSummary: "lib/d.ts" });
    expect(calls).toHaveLength(2);
  });

  it("sends the resolved absolute target path in toolCall.locations for a writer", async () => {
    const { client, calls } = clientPicking("allow_once");
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT);
    await resolve({
      tool: "multi_edit",
      args: { path: "sample-app/vite.config.ts" },
      argsSummary: "…",
    });
    expect(calls[0]!.toolCall.locations).toEqual([
      { path: join(PROJECT, "sample-app", "vite.config.ts") },
    ]);
  });

  it("sends the absolute path even for an out-of-tree writer (so the client shows where it lands)", async () => {
    const { client, calls } = clientPicking("allow_once");
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT);
    await resolve({ tool: "write_file", args: { path: "/etc/x" }, argsSummary: "/etc/x" });
    expect(calls[0]!.toolCall.locations?.[0]?.path).toContain("etc");
  });

  it("sends no locations for a non-write tool", async () => {
    const { client, calls } = clientPicking("allow_once");
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT);
    await resolve({ tool: "bash", args: {}, argsSummary: "ls" });
    expect(calls[0]!.toolCall.locations).toBeUndefined();
  });
});

describe("makeAcpResolvePermission — client-job authority", () => {
  it("offers and reuses a scope only for the same low-effect job within approved budgets", async () => {
    const { client, calls } = clientPicking("allow_job_scope");
    const grants = emptyGrants();
    const resolve = makeAcpResolvePermission(client, "s1", grants, PROJECT);
    expect(
      await resolve({
        tool: "job_start",
        args: {},
        argsSummary: "job_start sast.semgrep",
        authorization: READ_JOB_AUTHORIZATION,
      }),
    ).toBe("allow");
    expect(calls[0]!.options.map((option) => option.optionId)).toEqual([
      "allow_once",
      "allow_job_scope",
      "reject_once",
      "reject_always",
    ]);
    expect(grants.jobScopes).toEqual([READ_JOB_AUTHORIZATION]);

    expect(
      await resolve({
        tool: "job_start",
        args: {},
        argsSummary: "job_start sast.semgrep smaller",
        authorization: {
          ...READ_JOB_AUTHORIZATION,
          limits: { ...READ_JOB_AUTHORIZATION.limits, timeoutMs: 30_000 },
        },
      }),
    ).toBe("allow");
    expect(calls).toHaveLength(1);

    await resolve({
      tool: "job_start",
      args: {},
      argsSummary: "job_start sast.semgrep larger",
      authorization: {
        ...READ_JOB_AUTHORIZATION,
        limits: { ...READ_JOB_AUTHORIZATION.limits, timeoutMs: 90_000 },
      },
    });
    expect(calls).toHaveLength(2);
  });

  it("requires fresh approval for active jobs and rejects a rogue scoped-grant response", async () => {
    const active: ToolAuthorization = {
      ...READ_JOB_AUTHORIZATION,
      kind: "dast.zap",
      effect: "active_network",
      target: "https://staging.example.com",
    };
    const inspected = clientPicking("allow_once");
    const resolve = makeAcpResolvePermission(inspected.client, "s1", emptyGrants(), PROJECT);
    expect(
      await resolve({
        tool: "job_start",
        args: {},
        argsSummary: "active scan",
        authorization: active,
      }),
    ).toBe("allow");
    expect(inspected.calls[0]!.options.map((option) => option.optionId)).toEqual([
      "allow_once",
      "reject_once",
      "reject_always",
    ]);

    const rogue: PermissionClient = {
      async requestPermission() {
        return { outcome: { outcome: "selected", optionId: "allow_job_scope" } };
      },
    };
    expect(
      await makeAcpResolvePermission(
        rogue,
        "s1",
        emptyGrants(),
        PROJECT,
      )({
        tool: "job_start",
        args: {},
        argsSummary: "active scan",
        authorization: active,
      }),
    ).toBe("deny");
  });

  it("enforces structured persisted denies before asking the client", async () => {
    const rules: PermissionRules = {
      project: [
        {
          tool: "job_start",
          jobEffect: "active_network",
          jobTargetPattern: "https://prod.*",
          decision: "deny",
        },
      ],
      global: [],
    };
    const resolve = makeAcpResolvePermission(
      clientThatThrowsIfAsked(),
      "s1",
      emptyGrants(),
      PROJECT,
      { rules },
    );
    expect(
      await resolve({
        tool: "job_start",
        args: {},
        argsSummary: "active production scan",
        authorization: {
          ...READ_JOB_AUTHORIZATION,
          kind: "dast.zap",
          effect: "active_network",
          target: "https://prod.example.com",
        },
      }),
    ).toBe("deny");
  });

  it("fails closed when job_start lacks structured authorization metadata", async () => {
    const resolve = makeAcpResolvePermission(
      clientThatThrowsIfAsked(),
      "s1",
      emptyGrants(),
      PROJECT,
    );
    expect(await resolve({ tool: "job_start", args: {}, argsSummary: "malformed job" })).toBe(
      "deny",
    );
  });
});

describe("makeAcpResolvePermission — REJECT_ALWAYS session denial + persisted deny rules", () => {
  it("REJECT_ALWAYS records a session denial and auto-denies the same call", async () => {
    const grants = emptyGrants();
    const { client } = clientPicking("reject_always");
    const resolve = makeAcpResolvePermission(client, "s1", grants, PROJECT);
    expect(
      await resolve({ tool: "bash", args: { command: "rm -rf x" }, argsSummary: "rm -rf x" }),
    ).toBe("deny");
    expect(grants.denials).toEqual([{ tool: "bash", argsPattern: "rm -rf x" }]);
    // Second identical call: denied WITHOUT prompting.
    const resolve2 = makeAcpResolvePermission(clientThatThrowsIfAsked(), "s1", grants, PROJECT);
    expect(
      await resolve2({ tool: "bash", args: { command: "rm -rf x" }, argsSummary: "rm -rf x" }),
    ).toBe("deny");
  });

  it("REJECT_ALWAYS persists a deny rule when persistPath is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleetus-acp-deny-"));
    const file = join(dir, "permissions.yaml");
    const grants = emptyGrants();
    const { client } = clientPicking("reject_always");
    const resolve = makeAcpResolvePermission(client, "s1", grants, PROJECT, {
      persistPath: file,
    });
    await resolve({ tool: "bash", args: { command: "rm -rf x" }, argsSummary: "rm -rf x" });
    const text = await readFile(file, "utf8");
    expect(text).toContain("decision: deny");
    expect(text).toContain("args_pattern: rm -rf x");
    await rm(dir, { recursive: true, force: true });
  });

  it("REJECT_ALWAYS mirrors the deny into opts.rules so a fresh resolver denies without prompting", async () => {
    const rules: PermissionRules = { project: [], global: [] };
    const { client } = clientPicking("reject_always");
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT, { rules });
    expect(await resolve({ tool: "bash", args: { command: "evil" }, argsSummary: "evil" })).toBe(
      "deny",
    );
    expect(rules.project).toEqual([{ tool: "bash", argsPattern: "evil", decision: "deny" }]);
    // A brand-new resolver built over the SAME rules object (fresh grants — no session denial)
    // must deny purely from the mirrored rule, without ever calling the client.
    const resolve2 = makeAcpResolvePermission(
      clientThatThrowsIfAsked(),
      "s1",
      emptyGrants(),
      PROJECT,
      {
        rules,
      },
    );
    expect(await resolve2({ tool: "bash", args: { command: "evil" }, argsSummary: "evil" })).toBe(
      "deny",
    );
  });

  it("a persisted deny rule auto-denies without prompting (fresh-session path)", async () => {
    const rules: PermissionRules = {
      project: [{ tool: "bash", argsPattern: "rm -rf x", decision: "deny" }],
      global: [],
    };
    const resolve = makeAcpResolvePermission(
      clientThatThrowsIfAsked(),
      "s1",
      emptyGrants(),
      PROJECT,
      { rules },
    );
    expect(
      await resolve({ tool: "bash", args: { command: "rm -rf x" }, argsSummary: "rm -rf x" }),
    ).toBe("deny");
  });

  it("a persisted deny rule wins over a whole-tool session grant (deny beats allow)", async () => {
    // Regression for the reviewer's repro: a prior "Always allow" on bash must not bypass an
    // explicit persisted deny rule for a specific command.
    const grants = emptyGrants();
    grants.tools.add("bash");
    const rules: PermissionRules = {
      project: [{ tool: "bash", argsPattern: "rm -rf x", decision: "deny" }],
      global: [],
    };
    const resolve = makeAcpResolvePermission(clientThatThrowsIfAsked(), "s1", grants, PROJECT, {
      rules,
    });
    expect(
      await resolve({ tool: "bash", args: { command: "rm -rf x" }, argsSummary: "rm -rf x" }),
    ).toBe("deny");
  });

  it("a persisted deny rule wins over an exact bash grant", async () => {
    const grants = emptyGrants();
    grants.bashCommands = [{ command: "bun test", cwd: PROJECT }];
    const rules: PermissionRules = {
      project: [{ tool: "bash", argsPattern: "bun test --evil", decision: "deny" }],
      global: [],
    };
    const resolve = makeAcpResolvePermission(clientThatThrowsIfAsked(), "s1", grants, PROJECT, {
      rules,
    });
    expect(
      await resolve({
        tool: "bash",
        args: { command: "bun test --evil" },
        argsSummary: "bun test --evil",
      }),
    ).toBe("deny");
  });

  it("a persisted pathPrefix deny rule denies a read tool without prompting", async () => {
    const secretsDir = join(PROJECT, "secrets");
    const rules: PermissionRules = {
      project: [{ pathPrefix: secretsDir, decision: "deny" }],
      global: [],
    };
    const resolve = makeAcpResolvePermission(
      clientThatThrowsIfAsked(),
      "s1",
      emptyGrants(),
      PROJECT,
      { rules },
    );
    expect(
      await resolve({
        tool: "read_file",
        args: { path: "secrets/api-key.txt" },
        argsSummary: "secrets/api-key.txt",
      }),
    ).toBe("deny");
  });
});

describe("makeAcpResolvePermission — degraded-sandbox consent", () => {
  it("degraded sandbox: first bash prompt carries the warning; approval persists the ack", async () => {
    let persisted = 0;
    const degraded = { acked: false, persistAck: () => void persisted++ };
    const seenTitles: string[] = [];
    const client: PermissionClient = {
      requestPermission: async (req) => {
        seenTitles.push((req.toolCall as { title: string }).title);
        return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
      },
    };
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT, { degraded });
    await resolve({ tool: "bash", args: { command: "ls" }, argsSummary: "ls" });
    expect(seenTitles[0]).toContain("UNSANDBOXED HOST");
    expect(degraded.acked).toBe(true);
    expect(persisted).toBe(1);
    // Second bash call: no warning prefix.
    await resolve({ tool: "bash", args: { command: "pwd" }, argsSummary: "pwd" });
    expect(seenTitles[1]).toBe("pwd");
  });

  it("degraded but non-bash tools are unaffected", async () => {
    const degraded = { acked: false, persistAck: () => {} };
    const seenTitles: string[] = [];
    const client: PermissionClient = {
      requestPermission: async (req) => {
        seenTitles.push((req.toolCall as { title: string }).title);
        return { outcome: { outcome: "selected" as const, optionId: "allow_once" } };
      },
    };
    const resolve = makeAcpResolvePermission(client, "s1", emptyGrants(), PROJECT, { degraded });
    await resolve({
      tool: "web_fetch",
      args: { url: "https://x" },
      argsSummary: "web_fetch https://x",
    });
    expect(seenTitles[0]).toBe("web_fetch https://x");
    expect(degraded.acked).toBe(false);
  });
});

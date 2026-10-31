import { expect, test } from "bun:test";
import { AcpSessions } from "../../src/acp/session";
import { registerSessionMethods } from "../../src/acp/session-methods";
import { AcpTransport } from "../../src/acp/transport";
import type { AgentRuntime } from "../../src/agent/runtime";
import type { ResolvePermission } from "../../src/agent/types";
import type { EventLog } from "../../src/events/log";
import type { PermissionRule } from "../../src/permission/types";
import type { Sandbox } from "../../src/sandbox/types";

test("ACP routes capability-gated form editing over the connection and confirms before granting", async () => {
  for (const mode of ["buttons", "form", "cancel"]) {
    const form = mode !== "buttons";
    const cancelled = mode === "cancel";
    const methods: string[] = [];
    const sessionRules: PermissionRule[] = [];
    const router: { current: ResolvePermission } = { current: async () => "deny" };
    let decision: string | undefined;
    const sessions = new AcpSessions();
    const sessionId = sessions.create(process.cwd());
    const runtime = {
      runTurn: async (_id: string, _text: string, signal: AbortSignal) => {
        try {
          decision = await router.current({
            toolCallId: "call-native",
            tool: "bash",
            args: { command: "bun test tests/a.ts" },
            argsSummary: "bun test tests/a.ts",
          });
        } catch (error) {
          if (!signal.aborted) throw error;
          decision = "cancelled";
        }
        return {};
      },
    } as unknown as AgentRuntime;
    const sandbox: Sandbox = {
      shell: "bash",
      shellExecutable: async () => "/bin/bash",
      exec: async () => {
        throw new Error("fixture never executes commands");
      },
      dispose: async () => {},
      writeRoot: () => process.cwd(),
    };
    const transport = new AcpTransport({
      write: (line) => {
        const msg = JSON.parse(line);
        if (!msg.method) return;
        methods.push(msg.method);
        let result: unknown;
        if (msg.method === "session/request_permission") {
          const ids = msg.params.options.map((o: { optionId: string }) => o.optionId);
          if (ids.includes("confirm_command_pattern")) {
            expect(sessionRules).toHaveLength(0);
            result = { outcome: { outcome: "selected", optionId: "confirm_command_pattern" } };
          } else {
            expect(ids.includes("edit_command_pattern")).toBe(form);
            result = {
              outcome: {
                outcome: "selected",
                optionId: form ? "edit_command_pattern" : "allow_command_session",
              },
            };
          }
        } else if (msg.method === "elicitation/create") {
          expect(msg.params).toMatchObject({ sessionId, toolCallId: "call-native", mode: "form" });
          expect(msg.params.requestedSchema.required).toEqual(["pattern", "scope"]);
          if (cancelled) {
            queueMicrotask(() => {
              void transport.handleLine(
                JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }),
              );
            });
            return;
          }
          result = {
            action: "accept",
            content: { pattern: "bun test tests/*.ts", scope: "session" },
          };
        } else return;
        queueMicrotask(() => {
          void transport.handleLine(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        });
      },
    });
    registerSessionMethods(transport, {
      runtime,
      log: { subscribe: () => () => {} } as unknown as EventLog,
      sessions,
      permissionRouter: router,
      clientCapsRef: { current: form ? { elicitation: { form: {} } } : {} },
      fallbackSandbox: sandbox,
      sandboxHolder: { current: sandbox },
      commandRulesForSession: () => sessionRules,
    });
    await transport.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "turn",
        method: "session/prompt",
        params: { sessionId, prompt: [{ type: "text", text: "Run tests" }] },
      }),
    );
    expect(decision).toBe(cancelled ? "cancelled" : "allow");
    expect(sessionRules).toHaveLength(cancelled ? 0 : 1);
    expect(methods.includes("elicitation/create")).toBe(form);
    expect(methods.filter((m) => m === "session/request_permission")).toHaveLength(
      form && !cancelled ? 2 : 1,
    );
    transport.close();
  }
});

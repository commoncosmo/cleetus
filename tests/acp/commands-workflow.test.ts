import { describe, expect, test } from "bun:test";
import { createAcpCommandHandler } from "../../src/acp/commands";

describe("ACP workflow commands", () => {
  test("advertises and delegates /workflow through the shared controller", async () => {
    const handled: string[] = [];
    const handler = createAcpCommandHandler({ list: () => [] } as never, {
      workflowController: {
        async handle(args: string, context: { print(value: string): void }) {
          handled.push(args);
          context.print("workflow output");
        },
      } as never,
    });
    expect(handler.availableCommands().map((command) => command.name)).toContain("workflow");
    expect(await handler.execute("/workflow dry-run weather", { sessionId: "session" })).toEqual({
      kind: "text",
      text: "workflow output",
    });
    expect(handled).toEqual(["dry-run weather"]);
  });

  test("redirects /skill workflow-creator into the host controller", async () => {
    const handled: string[] = [];
    const handler = createAcpCommandHandler(
      {
        list: () => [
          {
            name: "workflow-creator",
            description: "Create workflows",
            body: "must not enter an agent turn",
            source: "built-in",
          },
        ],
        resolveName: () => "workflow-creator",
      } as never,
      {
        workflowController: {
          async handle(args: string, context: { print(value: string): void }) {
            handled.push(args);
            context.print("creator started");
          },
        } as never,
      },
    );
    expect(
      await handler.execute('/skill workflow-creator "weather"', { sessionId: "session" }),
    ).toEqual({ kind: "text", text: "creator started" });
    expect(handled).toEqual(['create "weather"']);
  });
});

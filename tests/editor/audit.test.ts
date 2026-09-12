import { describe, expect, test } from "bun:test";
import {
  type EditorAuditPayload,
  editorExecutableLabel,
  editorFailureCode,
  editorTargetScope,
  runAuditedEditorHandoff,
} from "../../src/editor/audit";
import { isEventVisible } from "../../src/events/types";

describe("editor audit", () => {
  test("records a successful project handoff without paths or editor arguments", async () => {
    const payloads: EditorAuditPayload[] = [];
    let tick = 100;
    await runAuditedEditorHandoff({
      integration: "skill",
      request: { targets: ["/work/project/.cleetus/skills/private-name/SKILL.md"] },
      cwd: "/work/project",
      launch: async () => ({
        argv: ["/Applications/Editor App/bin/editor", "--wait", "/work/project/private.md"],
        targets: ["/work/project/.cleetus/skills/private-name/SKILL.md"],
      }),
      authorizeOutsideProject: async () => true,
      record: (payload) => payloads.push(payload),
      now: () => {
        tick += 25;
        return tick;
      },
    });

    expect(payloads).toEqual([
      {
        kind: "editor_audit",
        visibility: "verbose",
        phase: "started",
        integration: "skill",
        target_count: 1,
        outside_project_requested: false,
      },
      {
        kind: "editor_audit",
        visibility: "verbose",
        phase: "finished",
        integration: "skill",
        status: "succeeded",
        editor: "editor",
        target_count: 1,
        target_scope: "project",
        duration_ms: 25,
      },
    ]);
    const persisted = JSON.stringify(payloads);
    expect(persisted).not.toContain("private-name");
    expect(persisted).not.toContain("--wait");
    expect(persisted).not.toContain("/work/");
  });

  test("records only a count and decision for external authorization", async () => {
    const payloads: EditorAuditPayload[] = [];
    await runAuditedEditorHandoff({
      integration: "edit",
      request: {
        args: `"/Users/example/.ssh/id_rsa" "/tmp/customer-secret.txt"`,
        confirmOutsideProject: true,
      },
      cwd: "/work/project",
      launch: async (_request, _cwd, authorize) => {
        expect(
          await authorize({
            editor: "/usr/local/bin/nvim",
            targets: ["/Users/example/.ssh/id_rsa", "/tmp/customer-secret.txt"],
          }),
        ).toBe(true);
        return {
          argv: ["/usr/local/bin/nvim", "-f", "/Users/example/.ssh/id_rsa"],
          targets: ["/Users/example/.ssh/id_rsa", "/tmp/customer-secret.txt"],
        };
      },
      authorizeOutsideProject: async () => true,
      record: (payload) => payloads.push(payload),
      now: () => 100,
    });

    expect(payloads.map((payload) => [payload.phase, payload.status])).toEqual([
      ["started", undefined],
      ["authorization", "allowed"],
      ["finished", "succeeded"],
    ]);
    expect(payloads[1]).toMatchObject({
      editor: "nvim",
      target_count: 2,
      target_scope: "outside_project",
    });
    expect(payloads[2]).toMatchObject({
      editor: "nvim",
      target_count: 2,
      target_scope: "outside_project",
    });
    const persisted = JSON.stringify(payloads);
    expect(persisted).not.toContain("id_rsa");
    expect(persisted).not.toContain("customer-secret");
    expect(persisted).not.toContain("/Users/");
    expect(persisted).not.toContain("/tmp/");
  });

  test("records denial and a normalized failure without persisting the raw error", async () => {
    const payloads: EditorAuditPayload[] = [];
    await expect(
      runAuditedEditorHandoff({
        integration: "edit",
        request: { args: "/private/very-sensitive", confirmOutsideProject: true },
        cwd: "/work/project",
        launch: async (_request, _cwd, authorize) => {
          await authorize({
            editor: "vim",
            targets: ["/private/very-sensitive"],
          });
          throw new Error("outside-project edit cancelled: /private/very-sensitive");
        },
        authorizeOutsideProject: async () => false,
        record: (payload) => payloads.push(payload),
      }),
    ).rejects.toThrow("very-sensitive");

    expect(payloads[1]).toMatchObject({
      phase: "authorization",
      status: "denied",
    });
    expect(payloads[2]).toMatchObject({
      phase: "finished",
      status: "failed",
      failure_code: "outside_project_denied",
    });
    expect(JSON.stringify(payloads)).not.toContain("very-sensitive");
  });

  test("normalizes executable labels, target scopes, and failure categories", () => {
    expect(editorExecutableLabel("/Applications/Visual Studio Code.app/bin/code")).toBe("code");
    expect(editorExecutableLabel("C:\\Tools\\nvim.exe")).toBe("nvim.exe");
    expect(editorTargetScope("/project", ["/project/a", "/project/b"])).toBe("project");
    expect(editorTargetScope("/project", ["/outside/a"])).toBe("outside_project");
    expect(editorTargetScope("/project", ["/project/a", "/outside/a"])).toBe("mixed");
    expect(editorFailureCode(new Error("$EDITOR is not set; secret path"))).toBe(
      "editor_not_configured",
    );
    expect(editorFailureCode(new Error("$EDITOR and $VISUAL are not set; secret path"))).toBe(
      "editor_not_configured",
    );
    expect(editorFailureCode(new Error("could not launch editor 'x': secret path"))).toBe(
      "launch_failed",
    );
    expect(editorFailureCode(new Error("edit target already exists: secret path"))).toBe(
      "target_exists",
    );
    expect(editorFailureCode(new Error("edit target parent must not be a symlink: secret"))).toBe(
      "creation_failed",
    );
    expect(editorFailureCode(new Error("unrecognized secret path"))).toBe("unknown");
  });

  test("records a create request without retaining its path", async () => {
    const payloads: EditorAuditPayload[] = [];
    await runAuditedEditorHandoff({
      integration: "edit",
      request: { args: "private/customer-name.md", create: true },
      cwd: "/work/project",
      launch: async () => ({
        argv: ["vim", "/work/project/private/customer-name.md"],
        targets: ["/work/project/private/customer-name.md"],
      }),
      authorizeOutsideProject: async () => true,
      record: (payload) => payloads.push(payload),
    });

    expect(payloads[0]).toMatchObject({
      phase: "started",
      create_requested: true,
    });
    expect(JSON.stringify(payloads)).not.toContain("customer-name");
  });

  test("audit events are hidden by default and available to verbose readers", () => {
    const event = {
      type: "editor_audit",
      payload: {
        kind: "editor_audit",
        visibility: "verbose",
        phase: "started",
        integration: "edit",
      },
    };
    expect(isEventVisible(event)).toBe(false);
    expect(isEventVisible(event, true)).toBe(true);
  });
});

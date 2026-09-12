import { randomUUID } from "node:crypto";
import type {
  RequestWorkflowAuthorization,
  WorkflowAuthorizationRequest,
} from "../ui/cli/workflow";
import type { WorkflowAuthorizationDecision } from "../workflows/service";
import type { PermissionClient } from "./permission";

export interface WorkflowAuthorizationRouter {
  current: RequestWorkflowAuthorization;
}

export function makeAcpWorkflowAuthorization(
  client: PermissionClient,
  sessionId: string,
): RequestWorkflowAuthorization {
  return async (request: WorkflowAuthorizationRequest): Promise<WorkflowAuthorizationDecision> => {
    const response = await client.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: randomUUID(),
        title: `Run workflow ${request.plan.package.name} revision ${request.plan.package.manifest.revision}\n${request.dryRun.summary}`,
        kind: "execute",
        status: "pending",
        rawInput: {
          workflow: request.plan.package.name,
          revision: request.plan.package.manifest.revision,
          executionHash: request.plan.package.executionHash,
          permissions: request.plan.permissions,
        },
      },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        {
          optionId: "trust_revision",
          name: "Trust this exact revision",
          kind: "allow_always",
        },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    if (response.outcome.outcome === "cancelled") return "deny";
    if (response.outcome.optionId === "allow_once") return "allow_once";
    if (response.outcome.optionId === "trust_revision") return "trust_revision";
    return "deny";
  };
}

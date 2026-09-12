import { randomUUID } from "node:crypto";
import { dirname, relative, sep } from "node:path";
import type { ResolvePermission } from "../agent/types";
import { evaluateRules, pathUnder } from "../permission/evaluator";
import { addRule } from "../permission/grant";
import {
  dirEscapesProject,
  resolveReadTarget,
  resolveToolTargetPath,
} from "../permission/path-guard";
import { persistRule } from "../permission/persist";
import { PATH_WRITING_TOOLS, type PermissionRules } from "../permission/types";
import { toolKind } from "./event-bridge";

export interface PermissionClient {
  requestPermission(req: {
    sessionId: string;
    toolCall: object;
    options: { optionId: string; name: string; kind: string }[];
  }): Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }>;
}

/** Session-scoped, in-memory permission grants for one ACP session.
 *  `tools`: whole-tool grants (bash/non-write tools chosen via "Always allow").
 *  `prefixes`: absolute, symlink-resolved directories granted for edits ("Always allow edits in <dir>"). */
export interface SessionGrants {
  tools: Set<string>;
  prefixes: string[];
  /** Exact-match session denials recorded by "Always reject" (tool + serialized args). */
  denials: { tool: string; argsPattern: string }[];
  /** Bash command-prefix grants ("Always allow commands starting with …"). */
  bashPrefixes: string[];
}

const ALLOW_ONCE = { optionId: "allow_once", name: "Allow once", kind: "allow_once" };
const ALLOW_ALWAYS = { optionId: "allow_always", name: "Always allow", kind: "allow_always" };
const REJECT_ONCE = { optionId: "reject_once", name: "Reject", kind: "reject_once" };
const REJECT_ALWAYS = { optionId: "reject_always", name: "Always reject", kind: "reject_always" };

/** Project-relative display for the grant button (e.g. "src/"). Falls back to the absolute dir
 *  if it somehow lands outside the project (symlink edge); always ends with a separator. */
function displayDir(projectDir: string, dir: string): string {
  const rel = relative(projectDir, dir);
  const base = rel === "" ? "." : rel.startsWith("..") ? dir : rel;
  return base.endsWith(sep) ? base : base + sep;
}

/** Route a cleetus permission check out to the ACP client. A whole-tool grant (`grants.tools`)
 *  or a path-prefix grant (`grants.prefixes`, for path-writing tools) short-circuits to `allow`.
 *  An in-tree writer is offered a directory-scoped "Always allow edits in <dir>" grant instead of
 *  a whole-tool grant; an out-of-tree writer (or one with no usable target) is offered allow-once
 *  only; non-writers keep the original four options. */
export interface AcpPermissionOpts {
  /** Persisted rules loaded per session cwd (cached by `makeRulesForCwd`) and kept in sync at
   *  runtime as "Always reject" grants mirror new deny rules into this set; only DENY outcomes
   *  are honored here — the ACP client remains the allow surface. */
  rules?: PermissionRules;
  /** Project permissions.yaml path; when set, "Always reject" persists the deny rule. */
  persistPath?: string;
  /** Silently-degraded sandbox consent state. When set and un-acked, the first bash prompt
   *  carries the degradation warning; any approval acknowledges it (persisted by the caller). */
  degraded?: { acked: boolean; persistAck: () => void };
}

export function makeAcpResolvePermission(
  client: PermissionClient,
  sessionId: string,
  grants: SessionGrants,
  projectDir: string,
  opts: AcpPermissionOpts = {},
): ResolvePermission {
  return async ({ toolCallId, tool, args, argsSummary }) => {
    // 1. Session denial (exact tool + args match recorded by an earlier "Always reject") wins
    //    outright — no rule lookup, no prompt.
    if (grants.denials.some((d) => d.tool === tool && d.argsPattern === argsSummary)) {
      return "deny";
    }

    // 2. Resolve the tool's target path — writers via resolveToolTargetPath (also used below for
    //    the prefix-grant check and the prompt's toolCall.locations); reads via resolveReadTarget
    //    so a persisted pathPrefix deny rule on a read is honored too (matches the TUI).
    const isWriter = PATH_WRITING_TOOLS.has(tool);
    const target = isWriter ? await resolveToolTargetPath(tool, args, projectDir) : null;
    const ruleTarget = isWriter
      ? (target ?? undefined)
      : ((await resolveReadTarget(tool, args, projectDir))?.target ?? undefined);

    // 3. A persisted DENY rule wins over any session grant — deny must always beat allow.
    //    Allow outcomes from rules are deliberately NOT auto-honored here; the ACP client stays
    //    the allow surface.
    if (opts.rules && evaluateRules(opts.rules, tool, argsSummary, ruleTarget) === "deny") {
      return "deny";
    }

    // 4. Whole-tool session grant ("Always allow" on a non-writer).
    if (grants.tools.has(tool)) return "allow";

    // 4b. Bash command-prefix session grant ("Always allow commands starting with …"). Anchored
    //     at a token boundary (exact match or followed by a space) — unlike the TUI's
    //     user-authored trailing-`*` patterns, these prefixes are machine-constructed from a past
    //     command, so "bun test" must not also match "bun testx-malicious" or "bun test;rm".
    if (
      tool === "bash" &&
      grants.bashPrefixes.some((p) => argsSummary === p || argsSummary.startsWith(`${p} `))
    ) {
      return "allow";
    }

    // 5. Directory-prefix session grant ("Always allow edits in <dir>").
    if (target != null && grants.prefixes.some((p) => pathUnder(target, p))) return "allow";

    // Offer the directory grant only for an in-tree writer; out-of-tree writers get allow-once
    // only (no "always" of any kind); non-writers keep the original four options.
    let options: { optionId: string; name: string; kind: string }[];
    let grantDir: string | null = null;
    if (isWriter && target != null && !(await dirEscapesProject(dirname(target), projectDir))) {
      grantDir = dirname(target);
      options = [
        ALLOW_ONCE,
        {
          optionId: "allow_dir",
          name: `Always allow edits in ${displayDir(projectDir, grantDir)}`,
          kind: "allow_always",
        },
        REJECT_ONCE,
        REJECT_ALWAYS,
      ];
    } else if (isWriter) {
      options = [ALLOW_ONCE, REJECT_ONCE, REJECT_ALWAYS];
    } else if (tool === "bash") {
      options = [
        ALLOW_ONCE,
        {
          optionId: "allow_bash_prefix",
          name: `Always allow commands starting with "${argsSummary}"`,
          kind: "allow_always",
        },
        REJECT_ONCE,
        REJECT_ALWAYS,
      ];
    } else {
      options = [ALLOW_ONCE, ALLOW_ALWAYS, REJECT_ONCE, REJECT_ALWAYS];
    }

    // Surface the resolved absolute target so the client can show *where* a write lands
    // (ACP's toolCall.locations). Non-write tools have no single location and send none.
    const needsConsent = tool === "bash" && opts.degraded != null && !opts.degraded.acked;
    const title = needsConsent
      ? `⚠ UNSANDBOXED HOST — no sandbox available; .git/.cleetus/secret dirs are NOT protected. Approving acknowledges this permanently. ${argsSummary}`
      : argsSummary;
    const toolCall: {
      toolCallId: string;
      title: string;
      kind: string;
      status: "pending";
      rawInput: unknown;
      locations?: { path: string }[];
    } = {
      // AgentRuntime always supplies the provider's call ID. The fallback keeps this public
      // resolver wire-valid for embedders that still use the older ResolvePermission shape.
      toolCallId: toolCallId?.trim() || randomUUID(),
      title,
      kind: toolKind(tool),
      status: "pending",
      rawInput: args,
    };
    if (target != null) toolCall.locations = [{ path: target }];
    const { outcome } = await client.requestPermission({
      sessionId,
      toolCall,
      options: options.map((o) => ({ ...o })),
    });
    if (outcome.outcome === "cancelled") return "deny";
    const chosen = outcome.optionId;
    if (
      needsConsent &&
      (chosen === "allow_once" ||
        chosen === "allow_bash_prefix" ||
        chosen === "allow_dir" ||
        chosen === "allow_always")
    ) {
      opts.degraded!.acked = true;
      opts.degraded!.persistAck();
    }
    switch (outcome.optionId) {
      case "allow_dir":
        if (grantDir != null) grants.prefixes.push(grantDir);
        return "allow";
      case "allow_bash_prefix": {
        if (tool !== "bash") return "deny"; // rogue echo guard
        const trimmed = argsSummary.trim();
        if (trimmed !== "") grants.bashPrefixes.push(trimmed);
        return "allow";
      }
      case "allow_always":
        // Never offered to writers or bash; a rogue client echo must not blanket-grant.
        if (isWriter || tool === "bash") return "deny";
        grants.tools.add(tool);
        return "allow";
      case "allow_once":
        return "allow";
      case "reject_always": {
        grants.denials.push({ tool, argsPattern: argsSummary });
        // Mirror the persisted rule in the live rules object so evaluation, session state, and
        // disk agree within this process (deny-only — ACP never auto-allows from rules).
        if (opts.rules) addRule(opts.rules, "project", { tool, argsPattern: argsSummary }, "deny");
        if (opts.persistPath) {
          try {
            await persistRule(opts.persistPath, {
              tool,
              argsPattern: argsSummary,
              decision: "deny",
            });
          } catch {
            // persistence is best-effort; the session denial above still holds
          }
        }
        return "deny";
      }
      default:
        return "deny";
    }
  };
}

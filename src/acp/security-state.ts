import { z } from "zod";
import { EvidenceBundleSchema, type EvidenceRegistry, FindingSetSchema } from "../evidence";
import { type JobRegistry, JobSpecSchema, JobStatusSchema } from "../jobs";
import type { ClientJobCapabilities } from "./capabilities";

export const SECURITY_STATE_REATTACHMENT_VERSION = 1;
export const MAX_REATTACHED_EVIDENCE_BUNDLES = 64;
export const MAX_REATTACHED_FINDING_SETS = 128;
export const MAX_REATTACHED_JOBS = 128;
export const MAX_SECURITY_SESSION_STATE_BYTES = 8 * 1024 * 1024;

const ReattachedJobSchema = z
  .object({
    spec: JobSpecSchema,
    status: JobStatusSchema,
  })
  .strict()
  .superRefine((job, ctx) => {
    if (job.spec.kind !== job.status.kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status", "kind"],
        message: `must match job specification kind '${job.spec.kind}'`,
      });
    }
    const total = job.status.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
    if (!Number.isSafeInteger(total) || total > job.spec.limits.maxArtifactBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status", "artifacts"],
        message: `advertises ${total} bytes, exceeding job budget ${job.spec.limits.maxArtifactBytes}`,
      });
    }
    for (const [index, artifact] of job.status.artifacts.entries()) {
      if (!artifact.sha256) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status", "artifacts", index, "sha256"],
          message: "is required when reattaching a persisted artifact",
        });
      }
    }
  });

export const SecuritySessionStateSchema = z
  .object({
    schemaVersion: z.literal(SECURITY_STATE_REATTACHMENT_VERSION),
    evidenceBundles: z.array(EvidenceBundleSchema).max(MAX_REATTACHED_EVIDENCE_BUNDLES).default([]),
    findingSets: z.array(FindingSetSchema).max(MAX_REATTACHED_FINDING_SETS).default([]),
    jobs: z.array(ReattachedJobSchema).max(MAX_REATTACHED_JOBS).default([]),
  })
  .strict()
  .superRefine((state, ctx) => {
    uniqueIds(state.evidenceBundles, (bundle) => bundle.bundleId, "evidenceBundles", ctx);
    uniqueIds(state.findingSets, (set) => set.findingSetId, "findingSets", ctx);
    uniqueIds(state.jobs, (job) => job.status.jobId, "jobs", ctx);
  });

export type SecuritySessionState = z.infer<typeof SecuritySessionStateSchema>;

export interface SecurityStateIssue {
  path: string;
  message: string;
}

export type SecurityStateResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: SecurityStateIssue[] };

export interface SecurityStateReattachmentSummary {
  schemaVersion: 1;
  evidenceBundles: number;
  findingSets: number;
  jobs: number;
}

export interface SecurityStateRegistryRefs {
  evidenceRegistry?: EvidenceRegistry;
  jobRegistry?: JobRegistry;
  jobCapabilities?: ClientJobCapabilities | null;
}

/** Read Cleetus's namespaced extension without treating unrelated ACP metadata as input. */
export function securityStateFromLoadParams(
  params: unknown,
): { present: false } | { present: true; value: unknown } {
  const root = objectValue(params);
  const meta = objectValue(root?._meta);
  const domain = objectValue(meta?.["commoncosmo.com"]);
  const cleetus = objectValue(domain?.cleetus);
  if (!cleetus || !("securityState" in cleetus)) return { present: false };
  return { present: true, value: cleetus.securityState };
}

/**
 * Validate and atomically merge client-owned security manifests into connection-local registries.
 * Artifact bodies and permission grants are deliberately excluded from this contract.
 */
export function rehydrateSecuritySessionState(
  sessionId: string,
  value: unknown,
  refs: SecurityStateRegistryRefs,
): SecurityStateResult<SecurityStateReattachmentSummary> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, issues: [{ path: "$", message: "must be JSON-serializable" }] };
  }
  if (
    serialized !== undefined &&
    new TextEncoder().encode(serialized).byteLength > MAX_SECURITY_SESSION_STATE_BYTES
  ) {
    return {
      ok: false,
      issues: [
        {
          path: "$",
          message: `must not exceed ${MAX_SECURITY_SESSION_STATE_BYTES} encoded bytes`,
        },
      ],
    };
  }
  const parsed = SecuritySessionStateSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join(".") : "$",
        message: issue.message,
      })),
    };
  }
  const state = parsed.data;
  const issues: SecurityStateIssue[] = [];

  if (
    (state.evidenceBundles.length > 0 || state.findingSets.length > 0) &&
    !refs.evidenceRegistry
  ) {
    issues.push({
      path: "evidenceBundles",
      message: "the Cleetus evidence registry is unavailable",
    });
  }
  if (state.jobs.length > 0 && (!refs.jobRegistry || !refs.jobCapabilities)) {
    issues.push({
      path: "jobs",
      message: "the ACP client did not advertise the version 1 client-job capability",
    });
  }

  if (refs.evidenceRegistry) {
    issues.push(
      ...refs.evidenceRegistry.validateRehydration(
        sessionId,
        state.evidenceBundles,
        state.findingSets,
      ),
    );
  }

  const incomingBundles = new Map(
    state.evidenceBundles.map((bundle) => [bundle.bundleId, bundle] as const),
  );
  for (const [index, job] of state.jobs.entries()) {
    if (refs.jobCapabilities && !refs.jobCapabilities.kinds.includes(job.spec.kind)) {
      issues.push({
        path: `jobs.${index}.spec.kind`,
        message: `job kind '${job.spec.kind}' was not advertised by the ACP client`,
      });
    }
    if (job.spec.evidenceBundleId) {
      const bundle =
        incomingBundles.get(job.spec.evidenceBundleId) ??
        refs.evidenceRegistry?.bundle(sessionId, job.spec.evidenceBundleId);
      if (!bundle) {
        issues.push({
          path: `jobs.${index}.spec.evidenceBundleId`,
          message: `evidence bundle '${job.spec.evidenceBundleId}' is not registered for this session`,
        });
      } else {
        const evidenceIds = new Set(bundle.items.map((item) => item.id));
        for (const [evidenceIndex, evidenceId] of job.spec.inputEvidenceIds.entries()) {
          if (!evidenceIds.has(evidenceId)) {
            issues.push({
              path: `jobs.${index}.spec.inputEvidenceIds.${evidenceIndex}`,
              message: `evidence id '${evidenceId}' is not in bundle '${bundle.bundleId}'`,
            });
          }
        }
      }
    }
  }

  if (refs.jobRegistry) {
    issues.push(...refs.jobRegistry.validateRehydration(sessionId, state.jobs));
  }
  if (issues.length > 0) return { ok: false, issues };

  refs.evidenceRegistry?.rehydrateSession(sessionId, state.evidenceBundles, state.findingSets);
  refs.jobRegistry?.rehydrateSession(sessionId, state.jobs);
  return {
    ok: true,
    value: {
      schemaVersion: SECURITY_STATE_REATTACHMENT_VERSION,
      evidenceBundles: state.evidenceBundles.length,
      findingSets: state.findingSets.length,
      jobs: state.jobs.length,
    },
  };
}

function uniqueIds<T>(
  values: T[],
  id: (value: T) => string,
  path: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const current = id(value);
    if (seen.has(current)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [path, index],
        message: `duplicate id '${current}'`,
      });
    }
    seen.add(current);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

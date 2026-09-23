import { z } from "zod";

const JOB_ID = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const JOB_KIND = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const SHORT_TEXT = z.string().trim().min(1).max(500);
const ISO_TIMESTAMP = z.string().datetime({ offset: true });

export const JOB_EFFECTS = ["read", "passive_network", "active_network", "write"] as const;
export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

export const JobSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: JOB_KIND,
    title: z.string().trim().min(1).max(200).optional(),
    evidenceBundleId: JOB_ID.optional(),
    inputEvidenceIds: z.array(JOB_ID).max(128).default([]),
    target: z.string().trim().min(1).max(4096).optional(),
    effect: z.enum(JOB_EFFECTS),
    parameters: z.record(z.string(), z.unknown()).default({}),
    limits: z
      .object({
        timeoutMs: z.number().int().min(1_000).max(3_600_000),
        maxOutputBytes: z.number().int().min(1_024).max(52_428_800),
        maxArtifactBytes: z.number().int().min(1_024).max(524_288_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.effect !== "read" && !spec.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: `is required for ${spec.effect} jobs`,
      });
    }
    if (spec.inputEvidenceIds.length > 0 && !spec.evidenceBundleId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceBundleId"],
        message: "is required when inputEvidenceIds are supplied",
      });
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(spec.parameters);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parameters"],
        message: "must be JSON-serializable",
      });
      return;
    }
    if (encoded.length > 32_768) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parameters"],
        message: "must not exceed 32768 serialized characters",
      });
    }
    const seenEvidence = new Set<string>();
    for (const [index, evidenceId] of spec.inputEvidenceIds.entries()) {
      if (seenEvidence.has(evidenceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["inputEvidenceIds", index],
          message: `duplicate evidence id '${evidenceId}'`,
        });
      }
      seenEvidence.add(evidenceId);
    }
  });

export const JobArtifactSchema = z
  .object({
    artifactId: JOB_ID,
    name: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(200),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    uri: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();

export const JobStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: JOB_ID,
    kind: JOB_KIND,
    status: z.enum(JOB_STATUSES),
    progress: z.number().min(0).max(1).optional(),
    message: SHORT_TEXT.optional(),
    startedAt: ISO_TIMESTAMP.optional(),
    finishedAt: ISO_TIMESTAMP.optional(),
    artifacts: z.array(JobArtifactSchema).max(128).default([]),
    error: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
  .superRefine((status, ctx) => {
    if (status.status === "failed" && !status.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "is required when status is failed",
      });
    }
    const seen = new Set<string>();
    for (const [index, artifact] of status.artifacts.entries()) {
      if (seen.has(artifact.artifactId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts", index, "artifactId"],
          message: `duplicate artifact id '${artifact.artifactId}'`,
        });
      }
      seen.add(artifact.artifactId);
    }
  });

export const JobArtifactChunkSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: JOB_ID,
    artifactId: JOB_ID,
    offset: z.number().int().nonnegative(),
    text: z.string(),
    nextOffset: z.number().int().nonnegative().optional(),
    eof: z.boolean(),
  })
  .strict()
  .superRefine((chunk, ctx) => {
    if (!chunk.eof && chunk.nextOffset === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextOffset"],
        message: "is required when eof is false",
      });
    }
    if (chunk.nextOffset !== undefined && chunk.nextOffset <= chunk.offset) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextOffset"],
        message: "must be greater than offset",
      });
    }
  });

export type JobEffect = (typeof JOB_EFFECTS)[number];
export type JobStatusValue = (typeof JOB_STATUSES)[number];
export type JobSpec = z.infer<typeof JobSpecSchema>;
export type JobArtifact = z.infer<typeof JobArtifactSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobArtifactChunk = z.infer<typeof JobArtifactChunkSchema>;

export interface JobContractIssue {
  path: string;
  message: string;
}

export type JobContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: JobContractIssue[] };

function parse<T>(schema: z.ZodType, value: unknown): JobContractResult<T> {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data as T }
    : {
        ok: false,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.length > 0 ? issue.path.join(".") : "$",
          message: issue.message,
        })),
      };
}

export function parseJobSpec(value: unknown): JobContractResult<JobSpec> {
  return parse<JobSpec>(JobSpecSchema, value);
}

export function parseJobStatus(value: unknown): JobContractResult<JobStatus> {
  return parse<JobStatus>(JobStatusSchema, value);
}

export function parseJobArtifactChunk(value: unknown): JobContractResult<JobArtifactChunk> {
  return parse<JobArtifactChunk>(JobArtifactChunkSchema, value);
}

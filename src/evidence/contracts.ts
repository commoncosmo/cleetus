import { z } from "zod";

export const EVIDENCE_BUNDLE_MIME_TYPE = "application/vnd.commoncosmo.cleetus-evidence-bundle+json";

const CONTRACT_ID = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "must start with an alphanumeric character and contain only letters, digits, '.', '_', ':', or '-'",
  );
const SHORT_TEXT = z.string().trim().min(1).max(500);
const ISO_TIMESTAMP = z.string().datetime({ offset: true });

const DigestSchema = z
  .object({
    algorithm: z.literal("sha256"),
    value: z.string().regex(/^[a-fA-F0-9]{64}$/, "must be a 64-character SHA-256 hex digest"),
  })
  .strict();

const ProvenanceSchema = z
  .object({
    source: z.string().trim().min(1).max(200),
    collectedAt: ISO_TIMESTAMP.optional(),
    tool: z.string().trim().min(1).max(100).optional(),
    toolVersion: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const EvidenceItemSchema = z
  .object({
    id: CONTRACT_ID,
    kind: z.string().trim().min(1).max(64),
    uri: z.string().trim().min(1).max(4096),
    mimeType: z.string().trim().min(1).max(200).optional(),
    digest: DigestSchema.optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    observedAt: ISO_TIMESTAMP.optional(),
    redaction: z.enum(["none", "applied", "unknown"]).default("unknown"),
    provenance: ProvenanceSchema,
  })
  .strict();

export const EvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    bundleId: CONTRACT_ID,
    title: z.string().trim().min(1).max(200).optional(),
    items: z.array(EvidenceItemSchema).min(1).max(128),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of bundle.items.entries()) {
      if (seen.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate evidence id '${item.id}'`,
          path: ["items", index, "id"],
        });
      }
      seen.add(item.id);
    }
  });

export const EvidenceReferenceSchema = z
  .object({
    evidenceId: CONTRACT_ID,
    locator: z
      .object({
        kind: z.enum(["line", "symbol", "timestamp", "json_pointer", "byte_range", "other"]),
        value: SHORT_TEXT,
      })
      .strict()
      .optional(),
  })
  .strict();

export const FindingSchema = z
  .object({
    id: CONTRACT_ID,
    summary: SHORT_TEXT,
    status: z.enum(["confirmed", "hypothesis", "not_established", "refuted"]),
    severity: z.enum(["informational", "low", "medium", "high", "critical"]),
    confidence: z.enum(["low", "medium", "high"]),
    evidence: z.array(EvidenceReferenceSchema).max(128).default([]),
    affected: z.array(SHORT_TEXT).max(64).default([]),
    preconditions: z.array(SHORT_TEXT).max(64).default([]),
    impact: SHORT_TEXT.optional(),
    remediation: SHORT_TEXT.optional(),
    verification: SHORT_TEXT.optional(),
    residualRisk: SHORT_TEXT.optional(),
  })
  .strict()
  .superRefine((finding, ctx) => {
    if (
      (finding.status === "confirmed" || finding.status === "refuted") &&
      finding.evidence.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${finding.status} findings require at least one evidence reference`,
        path: ["evidence"],
      });
    }
  });

export const FindingSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    findingSetId: CONTRACT_ID,
    evidenceBundleId: CONTRACT_ID,
    findings: z.array(FindingSchema).max(256),
  })
  .strict()
  .superRefine((set, ctx) => {
    const seen = new Set<string>();
    for (const [index, finding] of set.findings.entries()) {
      if (seen.has(finding.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate finding id '${finding.id}'`,
          path: ["findings", index, "id"],
        });
      }
      seen.add(finding.id);
    }
  });

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type FindingSet = z.infer<typeof FindingSetSchema>;

export interface ContractIssue {
  path: string;
  message: string;
}

export type ContractParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ContractIssue[] };

function issues(error: z.ZodError): ContractIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "$",
    message: issue.message,
  }));
}

function parseJson(value: string): ContractParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: "$",
          message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

export function parseEvidenceBundle(value: unknown): ContractParseResult<EvidenceBundle> {
  const parsed = EvidenceBundleSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: issues(parsed.error) };
}

export function parseEvidenceBundleJson(value: string): ContractParseResult<EvidenceBundle> {
  const json = parseJson(value);
  return json.ok ? parseEvidenceBundle(json.value) : json;
}

export function parseFindingSet(value: unknown): ContractParseResult<FindingSet> {
  const parsed = FindingSetSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, issues: issues(parsed.error) };
}

/** Validate cross-document identity and evidence references after both contracts parse. */
export function validateFindingSetEvidence(
  set: FindingSet,
  bundle: EvidenceBundle,
): ContractIssue[] {
  const result: ContractIssue[] = [];
  if (set.evidenceBundleId !== bundle.bundleId) {
    result.push({
      path: "evidenceBundleId",
      message: `references bundle '${set.evidenceBundleId}', not '${bundle.bundleId}'`,
    });
  }
  const evidenceIds = new Set(bundle.items.map((item) => item.id));
  for (const [findingIndex, finding] of set.findings.entries()) {
    for (const [referenceIndex, reference] of finding.evidence.entries()) {
      if (!evidenceIds.has(reference.evidenceId)) {
        result.push({
          path: `findings.${findingIndex}.evidence.${referenceIndex}.evidenceId`,
          message: `unknown evidence id '${reference.evidenceId}'`,
        });
      }
    }
  }
  return result;
}

import { parseDocument } from "yaml";
import { z } from "zod";
import type { JsonValue } from "./types";

const json: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(json), z.record(json)]),
);

const schema = z
  .object({
    schema_version: z.literal(1),
    name: z.string().min(1),
    mode: z.literal("mock").optional(),
    inputs: z.record(json).default({}),
    mocks: z.record(
      z
        .object({
          output: json.optional(),
          error: z
            .object({
              message: z.string(),
              class: z.string().default("executor_error"),
            })
            .strict()
            .optional(),
        })
        .strict()
        .refine((value) => value.output !== undefined || value.error !== undefined),
    ),
    expect: z
      .object({
        status: z.enum(["succeeded", "failed", "cancelled"]),
        outputs: z.record(json).optional(),
        failed_step: z.string().optional(),
        attempts: z.record(z.number().int().min(0)).optional(),
      })
      .strict(),
  })
  .strict();

export type WorkflowTestCase = z.infer<typeof schema>;

function formatTestCaseIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "/";
  if (issue.code === "unrecognized_keys") {
    return `${path}: unsupported ${issue.keys.length === 1 ? "property" : "properties"} ${issue.keys.join(", ")}`;
  }
  return `${path}: ${issue.message}`;
}

export function parseWorkflowTestCase(content: string, filename = "test.yaml"): WorkflowTestCase {
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length) {
    throw new Error(`${filename}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  const value = document.toJS();
  if (value && typeof value === "object" && (value as Record<string, unknown>).mode === "live") {
    throw new Error(`${filename}: live workflow tests are unsupported (WF-D14)`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${filename}: ${result.error.issues.map(formatTestCaseIssue).join("; ")}`);
  }
  return result.data;
}

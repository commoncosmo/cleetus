import { parseDocument } from "yaml";
import { z } from "zod";
import type { JsonSchema, JsonValue } from "./types";

const WORKFLOW_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STEP_TYPE = /^[a-z][a-z0-9.-]*@[1-9]\d*$/;

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

const secretSchema = z
  .object({
    source: z.literal("env"),
    name: z.string().min(1),
    expose_to_llm: z.array(z.string().min(1)).optional(),
  })
  .strict();

const permissionsSchema = z
  .object({
    network: z
      .array(
        z
          .object({
            host: z.string().min(1),
            methods: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .optional(),
    commands: z
      .array(
        z
          .object({
            program: z.string().min(1),
            args_prefix: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
    filesystem: z
      .object({
        read: z.array(z.string()).optional(),
        write: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    model: z.boolean().optional(),
  })
  .strict();

const retrySchema = z
  .object({
    attempts: z.number().int().min(0).max(10),
    backoff: z
      .object({
        initial: z.string(),
        multiplier: z.number().finite().min(1).max(10),
        maximum: z.string(),
      })
      .strict(),
    when: z
      .array(z.enum(["timeout", "connection_error", "http_429", "http_5xx", "provider_error"]))
      .max(10),
  })
  .strict();

const stepSchema = z
  .object({
    id: z.string().regex(WORKFLOW_NAME),
    uses: z.string().regex(STEP_TYPE),
    timeout: z.string().optional(),
    retry: retrySchema.optional(),
    allow_untrusted_input: z.boolean().optional(),
    with: jsonValueSchema,
  })
  .strict();

const outputSchema = z
  .object({
    value: jsonValueSchema,
    schema: z.record(z.unknown()),
  })
  .strict();

const manifestSchema = z
  .object({
    schema_version: z.literal(1),
    name: z.string().regex(WORKFLOW_NAME),
    revision: z.number().int().min(1),
    description: z.string().min(1).max(500),
    inputs: z.record(z.unknown()),
    secrets: z.record(secretSchema).optional(),
    permissions: permissionsSchema,
    execution: z
      .object({
        timeout: z.string(),
        model: z
          .object({
            provider: z.string().min(1).optional(),
            name: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    steps: z.array(stepSchema).min(1),
    outputs: z.record(outputSchema).refine((value) => Object.keys(value).length > 0, {
      message: "at least one output is required",
    }),
    presentation: z
      .object({
        output: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WorkflowManifest = z.infer<typeof manifestSchema> & {
  inputs: JsonSchema;
  outputs: Record<string, { value: JsonValue; schema: JsonSchema }>;
};

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "manifest"}: ${issue.message}`)
    .join("; ");
}

/** Parse one strict workflow manifest. Unknown fields and malformed/duplicate YAML are errors. */
export function parseWorkflowManifest(
  content: string,
  filename = "workflow.yaml",
): WorkflowManifest {
  const doc = parseDocument(content.replace(/\r\n/g, "\n"), {
    uniqueKeys: true,
  });
  if (doc.errors.length > 0) {
    throw new Error(`${filename}: ${doc.errors.map((error) => error.message).join("; ")}`);
  }
  const parsed = manifestSchema.safeParse(doc.toJS());
  if (!parsed.success) throw new Error(`${filename}: ${zodMessage(parsed.error)}`);
  const ids = new Set<string>();
  for (const step of parsed.data.steps) {
    if (ids.has(step.id)) throw new Error(`${filename}: duplicate step id '${step.id}'`);
    ids.add(step.id);
  }
  if (parsed.data.presentation && !(parsed.data.presentation.output in parsed.data.outputs)) {
    throw new Error(
      `${filename}: presentation output '${parsed.data.presentation.output}' is not declared`,
    );
  }
  return parsed.data as WorkflowManifest;
}

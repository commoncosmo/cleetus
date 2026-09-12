import type { ResolvedValue } from "../provenance";
import { resolved } from "../provenance";
import type { WorkflowStepType } from "../step-registry";
import type { JsonValue } from "../types";
import { selectJsonPointer } from "./data-select";

interface TextTemplateInput {
  template: string;
  data: JsonValue;
}

const EACH = /\{\{#each ([A-Za-z0-9_./~-]+)\}\}([\s\S]*?)\{\{\/each\}\}/gu;
const VALUE = /\{\{([A-Za-z0-9_./~-]+|this)\}\}/gu;

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pathPointer(path: string): string {
  if (path.startsWith("/")) return path;
  return `/${path
    .split(".")
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/")}`;
}

function scalarText(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "object")
    throw new Error("template interpolation accepts scalar values only");
  return htmlEscape(String(value));
}

function interpolate(template: string, data: JsonValue, current?: JsonValue): string {
  return template.replace(VALUE, (_whole, path: string) => {
    if (path === "this") {
      if (current === undefined) throw new Error("'this' is only available inside each");
      return scalarText(current);
    }
    const currentPath = path.startsWith("this.") ? path.slice("this.".length) : undefined;
    if (currentPath !== undefined && current === undefined) {
      throw new Error("'this' is only available inside each");
    }
    const selected = selectJsonPointer(
      currentPath === undefined ? data : current!,
      pathPointer(currentPath ?? path),
    );
    if (!selected.found) throw new Error(`template value '${path}' is missing`);
    return scalarText(selected.value!);
  });
}

export function renderWorkflowTemplate(template: string, data: JsonValue): string {
  if (template.includes("{{{")) throw new Error("raw template interpolation is not supported");
  if (/\{\{[#/](?!each\b|\/each\b)/u.test(template)) {
    throw new Error("unsupported template directive");
  }
  let rendered = template.replace(EACH, (_whole, path: string, body: string) => {
    if (body.includes("{{#each")) throw new Error("nested each blocks are not supported");
    const selected = selectJsonPointer(data, pathPointer(path));
    if (!selected.found) throw new Error(`template collection '${path}' is missing`);
    if (!Array.isArray(selected.value))
      throw new Error(`template collection '${path}' is not an array`);
    return selected.value.map((item) => interpolate(body, data, item)).join("");
  });
  if (rendered.includes("{{#each") || rendered.includes("{{/each")) {
    throw new Error("unbalanced each block");
  }
  rendered = interpolate(rendered, data);
  if (rendered.includes("{{")) throw new Error("invalid template expression");
  return rendered;
}

export const textTemplateStep: WorkflowStepType = {
  name: "text.template",
  version: 1,
  defaultTimeoutMs: 1_000,
  inputSchema: {
    type: "object",
    required: ["template", "data"],
    properties: {
      template: { type: "string", maxLength: 100_000 },
      data: {},
    },
    additionalProperties: false,
  },
  outputSchema: { type: "string" },
  classify: () => ({ effect: "read-only", permissions: {}, retryable: [] }),
  preview: () => "Render deterministic text template",
  async execute(input: ResolvedValue) {
    const value = input.value as unknown as TextTemplateInput;
    return resolved(renderWorkflowTemplate(value.template, value.data), input.provenance);
  },
};

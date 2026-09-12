import { Box, Text, useInput, useStdout } from "ink";
import { useMemo, useState } from "react";
import { WorkflowSchemaService } from "../../workflows/schema";
import type { JsonObject, JsonSchema, JsonValue } from "../../workflows/types";
import { useTheme } from "../theme";
import {
  type Buffer,
  backspace,
  down,
  fromText,
  insert,
  left,
  normalizeInput,
  right,
  up,
  visualLayout,
} from "./editor";
import { isNewlineKey } from "./keys";

interface Field {
  name: string;
  schema: JsonSchema;
}

export interface WorkflowInputPromptProps {
  workflow: string;
  schema: JsonSchema;
  onResolve: (inputs: JsonObject) => void;
  onCancel: (error: Error) => void;
}

function inputTypeIncludes(schema: JsonSchema, type: string): boolean {
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

export function parseWorkflowInputValue(text: string, schema: JsonSchema): JsonValue {
  const enumValues = schema.enum as JsonValue[] | undefined;
  let value: JsonValue;
  if (enumValues) {
    const match = enumValues.find((value) => String(value) === text);
    if (match === undefined) throw new Error(`choose one of: ${enumValues.join(", ")}`);
    value = match;
  } else if (inputTypeIncludes(schema, "array") || inputTypeIncludes(schema, "object")) {
    try {
      value = JSON.parse(text) as JsonValue;
    } catch (error) {
      throw new Error(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (inputTypeIncludes(schema, "array") && !inputTypeIncludes(schema, "object")) {
      if (!Array.isArray(value)) throw new Error("expected a JSON array");
    } else if (inputTypeIncludes(schema, "object") && !inputTypeIncludes(schema, "array")) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("expected a JSON object");
      }
    }
  } else if (schema.type === "number" || schema.type === "integer") {
    value = Number(text);
    if (!Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
      throw new Error(`expected ${schema.type}`);
    }
  } else if (schema.type === "boolean") {
    if (/^(?:true|yes)$/iu.test(text)) value = true;
    else if (/^(?:false|no)$/iu.test(text)) value = false;
    else throw new Error("expected true/false");
  } else {
    value = text;
  }
  const issues = new WorkflowSchemaService().compile(schema, "workflow input").validate(value);
  if (issues.length > 0) {
    throw new Error(
      issues
        .slice(0, 3)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; "),
    );
  }
  return value;
}

export interface WorkflowInputViewport {
  rows: string[];
  cursorRow: number;
  cursorCol: number;
  above: boolean;
  below: boolean;
}

export function workflowInputViewport(
  buffer: Buffer,
  width: number,
  maximumRows = 3,
): WorkflowInputViewport {
  const layout = visualLayout(buffer, width);
  const size = Math.max(1, maximumRows);
  const maximumOffset = Math.max(0, layout.rows.length - size);
  const offset = Math.min(maximumOffset, Math.max(0, layout.cursorRow - size + 1));
  return {
    rows: layout.rows.slice(offset, offset + size),
    cursorRow: layout.cursorRow - offset,
    cursorCol: layout.cursorCol,
    above: offset > 0,
    below: offset + size < layout.rows.length,
  };
}

export function WorkflowInputPrompt({
  workflow,
  schema,
  onResolve,
  onCancel,
}: WorkflowInputPromptProps) {
  const theme = useTheme();
  const { stdout } = useStdout();
  const fields = useMemo<Field[]>(() => {
    const required = new Set((schema.required ?? []) as string[]);
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    return Object.entries(properties)
      .filter(([name, property]) => required.has(name) && !Object.hasOwn(property, "default"))
      .map(([name, property]) => ({ name, schema: property }));
  }, [schema]);
  const [index, setIndex] = useState(0);
  const [buffer, setBuffer] = useState(() => fromText(""));
  const [values, setValues] = useState<JsonObject>({});
  const [error, setError] = useState<string | null>(null);
  const field = fields[index];
  const enumValues = field?.schema.enum as JsonValue[] | undefined;

  useInput((input, key) => {
    if (key.escape) {
      onCancel(new Error("workflow input collection was cancelled"));
      return;
    }
    if (!field) {
      onResolve(values);
      return;
    }
    if (isNewlineKey(input, key)) {
      setBuffer((current) => insert(current, "\n"));
      setError(null);
      return;
    }
    if (key.return) {
      try {
        const value = parseWorkflowInputValue(buffer.text, field.schema);
        const next = { ...values, [field.name]: value };
        if (index + 1 === fields.length) onResolve(next);
        else {
          setValues(next);
          setIndex(index + 1);
          setBuffer(fromText(""));
          setError(null);
        }
      } catch (caught) {
        setError((caught as Error).message);
      }
    } else if (key.upArrow) setBuffer(up);
    else if (key.downArrow) setBuffer(down);
    else if (key.leftArrow) setBuffer(left);
    else if (key.rightArrow) setBuffer(right);
    else if (key.backspace || key.delete) {
      setBuffer(backspace);
      setError(null);
    } else if (input && !key.ctrl && !key.meta) {
      const printable = normalizeInput(input);
      if (printable) {
        setBuffer((current) => insert(current, printable));
        setError(null);
      }
    }
  });

  if (!field) return null;
  const width = Math.max(1, (stdout?.columns ?? 80) - 8);
  const viewport = workflowInputViewport(buffer, width);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      height={10}
    >
      <Text bold>Inputs for {workflow}</Text>
      <Text>
        {field.name} ({String(field.schema.type ?? "string")}) [{index + 1}/{fields.length}]
      </Text>
      {enumValues && <Text color={theme.dim}>choices: {enumValues.join(", ")}</Text>}
      <Box flexDirection="column" height={3}>
        {viewport.rows.map((line, row) => {
          const showCursor = row === viewport.cursorRow;
          const leading = row === 0 && viewport.above ? "↑" : " ";
          const trailing = row === viewport.rows.length - 1 && viewport.below ? " ↓" : "";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: viewport rows are positional
            <Text key={row}>
              <Text color={theme.dim}>{leading}</Text>
              {showCursor ? (
                <>
                  <Text>{line.slice(0, viewport.cursorCol)}</Text>
                  <Text inverse>{line[viewport.cursorCol] ?? " "}</Text>
                  <Text>{line.slice(viewport.cursorCol + 1)}</Text>
                </>
              ) : (
                line
              )}
              <Text color={theme.dim}>{trailing}</Text>
            </Text>
          );
        })}
      </Box>
      <Text color={theme.error} wrap="truncate-end">
        {error ?? " "}
      </Text>
      <Text color={theme.dim}>Enter to continue · Shift/Opt+Enter for newline · Esc to cancel</Text>
    </Box>
  );
}

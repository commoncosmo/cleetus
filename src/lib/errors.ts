export type CleetusErrorCode =
  | "CONFIG_INVALID"
  | "CONFIG_NOT_FOUND"
  | "PROVIDER_UNREACHABLE"
  | "PROVIDER_INVALID_RESPONSE"
  | "PERMISSION_DENIED"
  | "PERMISSION_INVALID"
  | "TOOL_NOT_FOUND"
  | "TOOL_FAILED"
  | "OUT_OF_TREE"
  | "SECRET_PATH"
  | "SCAFFOLD_REFUSED"
  | "SESSION_NOT_FOUND"
  | "IO_FAILED"
  | "EMBEDDINGS_DISABLED"
  | "EMBEDDING_MODEL_MISMATCH"
  | "INTERNAL";

export class CleetusError extends Error {
  public readonly code: CleetusErrorCode;
  /** True when the failure is transient and the operation is safe to retry once
   * (e.g. a server-side 5xx during a chat completion, before any tool has run). */
  public readonly retryable: boolean;

  constructor(
    code: CleetusErrorCode,
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(`${code}: ${message}`, options);
    this.name = "CleetusError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

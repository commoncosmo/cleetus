export interface AcpImageCandidate {
  mime: string;
  base64?: string;
  path?: string;
}

const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp)$/i;

type AcpPromptBlock =
  | { type: "text"; text?: unknown }
  | {
      type: "resource";
      resource?: {
        uri?: unknown;
        mimeType?: unknown;
        text?: unknown;
        blob?: unknown;
      };
    }
  | {
      type: "resource_link";
      uri?: unknown;
      name?: unknown;
      title?: unknown;
      description?: unknown;
      mimeType?: unknown;
      size?: unknown;
    }
  | { type: string; [key: string]: unknown };

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resourceHeading(input: {
  kind: "Embedded resource" | "Resource link";
  uri?: string;
  name?: string;
  mimeType?: string;
}): string {
  const identity = input.name ?? input.uri ?? "unnamed";
  const details = [input.uri && input.uri !== identity ? input.uri : undefined, input.mimeType]
    .filter(Boolean)
    .join("; ");
  return `[${input.kind}: ${identity}${details ? ` (${details})` : ""}]`;
}

/**
 * Convert ACP v1 prompt content blocks into the text-only user-message representation accepted by
 * AgentRuntime. Text resources retain their complete contents and position relative to prose.
 * Binary resources are represented by grounded metadata rather than injecting opaque base64 into
 * the model context. Unsupported image/audio blocks are ignored because those capabilities are
 * not advertised.
 */
export function composeAcpPrompt(blocks: unknown): {
  text: string;
  textOnly: boolean;
  images: AcpImageCandidate[];
} {
  if (!Array.isArray(blocks)) return { text: "", textOnly: true, images: [] };
  const parts: string[] = [];
  const images: AcpImageCandidate[] = [];
  let textOnly = true;

  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as AcpPromptBlock;
    if (block.type === "text") {
      if (typeof block.text === "string") parts.push(block.text);
      continue;
    }
    textOnly = false;

    if (block.type === "resource") {
      const resource = (block as Extract<AcpPromptBlock, { type: "resource" }>).resource;
      if (!resource || typeof resource !== "object") continue;
      const uri = stringField(resource.uri);
      const mimeType = stringField(resource.mimeType);
      const heading = resourceHeading({ kind: "Embedded resource", uri, mimeType });
      if (mimeType && IMAGE_MIME_RE.test(mimeType) && typeof resource.blob === "string") {
        images.push({ mime: mimeType.toLowerCase(), base64: resource.blob });
        continue;
      }
      if (typeof resource.text === "string") {
        parts.push(`${heading}\n${resource.text}\n[End embedded resource]`);
      } else if (typeof resource.blob === "string") {
        parts.push(
          `${heading}\n[Binary content supplied by the client; ${resource.blob.length} base64 characters omitted from model context.]`,
        );
      }
      continue;
    }

    if (block.type === "resource_link") {
      const uri = stringField(block.uri);
      const name = stringField(block.name);
      const mimeType = stringField(block.mimeType);
      const title = stringField(block.title);
      const description = stringField(block.description);
      const size =
        typeof block.size === "number" && Number.isFinite(block.size)
          ? `${block.size} bytes`
          : undefined;
      if (uri && mimeType && IMAGE_MIME_RE.test(mimeType)) {
        images.push({ mime: mimeType.toLowerCase(), path: uri });
        continue;
      }
      parts.push(
        [resourceHeading({ kind: "Resource link", uri, name, mimeType }), title, description, size]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  return { text: parts.join("\n\n"), textOnly, images };
}

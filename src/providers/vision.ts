import type { VisionConfig } from "../config/vision";

export type VisionSupport = "yes" | "no" | "unknown";

/** Parse an Ollama /api/show payload into a vision verdict. Recent Ollama reports a
 *  `capabilities` array that includes "vision" for multimodal models. */
export function parseOllamaVision(show: unknown): VisionSupport {
  if (!show || typeof show !== "object") return "unknown";
  const caps = (show as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(caps)) return "unknown";
  return caps.includes("vision") ? "yes" : "no";
}

function forced(model: string, cfg: VisionConfig): boolean {
  return cfg.assumeSupported || cfg.models.some((m) => m.length > 0 && model.includes(m));
}

export function gateVision(
  support: VisionSupport,
  model: string,
  cfg: VisionConfig,
): { action: "send" | "warn" | "block"; message?: string } {
  if (support === "yes" || forced(model, cfg)) return { action: "send" };
  if (support === "no") {
    return {
      action: "block",
      message: `the active model "${model}" can't view images — switch to a vision model or remove the attachment (set vision.assumeSupported to override)`,
    };
  }
  return {
    action: "warn",
    message: `can't confirm "${model}" supports images; sending anyway`,
  };
}

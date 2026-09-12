import type { RawSandbox } from "./schema";
import type { SandboxConfig } from "./types";

/**
 * Merge global + project sandbox config. Default backend is `host` (host-native jail),
 * applied only when neither layer sets one. The backend has a floor: a project may
 * strengthen but not weaken an EXPLICITLY-set global sandbox down to `none`, so a cloned
 * repo cannot disable a globally-required sandbox. The floor keys off the *explicit*
 * global value — not the `host` default — otherwise the default would masquerade as an
 * explicit setting and wrongly block a project from choosing `none`. `host` and `docker`
 * are different models (not ranked); switching between them is allowed. `network` defaults
 * to `true` and follows project-over-global; `image` follows project-over-global.
 */
export function resolveSandbox(global?: RawSandbox, project?: RawSandbox): SandboxConfig {
  const explicitGlobal = global?.backend; // undefined when global sets no backend
  let backend = project?.backend ?? explicitGlobal ?? "host";
  if (explicitGlobal && explicitGlobal !== "none" && backend === "none") {
    backend = explicitGlobal; // floor: cannot weaken an explicit global sandbox to none
  }
  const network = project?.network ?? global?.network ?? true;
  const image = project?.image ?? global?.image;
  return image === undefined ? { backend, network } : { backend, image, network };
}

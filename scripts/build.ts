import { $ } from "bun";
import { assetName } from "./targets";

/**
 * Build the `codesign` argv (everything after `codesign`) for the output binary.
 *
 * With an identity → Developer ID signing with hardened runtime (`--options runtime`)
 * and a secure timestamp (`--timestamp`); both are REQUIRED for Apple notarization.
 * Without an identity → ad-hoc signing (the `-` identity), which is all a locally-built
 * binary needs to run on Apple Silicon (see the SIGKILL fix from PR #37).
 */
export function signCommand(identity: string | null, outfile: string): string[] {
  if (identity) {
    return ["--force", "--options", "runtime", "--timestamp", "--sign", identity, outfile];
  }
  return ["--force", "--sign", "-", outfile];
}

if (import.meta.main) {
  const target = process.env.CLEETUS_TARGET; // e.g. "bun-darwin-arm64"; undefined → host
  const identity = process.env.CLEETUS_SIGN_IDENTITY ?? null; // undefined → ad-hoc
  const out =
    process.env.CLEETUS_OUT ?? (target ? `dist/${assetName(target)}` : "dist/cleetus");

  const targetArgs = target ? ["--target", target] : [];
  await $`bun build src/bin/cleetus.ts --compile ${targetArgs} --outfile ${out}`;

  // macOS requires at least an ad-hoc signature for the binary to run; a real identity
  // additionally clears the path to notarization. --verify --strict hard-fails a bad
  // signature rather than shipping a binary macOS will SIGKILL at runtime.
  if (process.platform === "darwin") {
    await $`codesign ${signCommand(identity, out)}`;
    await $`codesign --verify --strict ${out}`;
  }

  console.log(`built ${out}`);
}

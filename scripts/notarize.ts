import { $ } from "bun";

/** App Store Connect API-key credentials for the notary service. */
export interface NotaryAuth {
  p8Path: string;
  keyId: string;
  issuerId: string;
}

/**
 * Build the `xcrun` argv (everything after `xcrun`) that submits a zipped binary to the
 * Apple notary service and blocks until Apple returns a verdict.
 */
export function notarytoolArgs(zipPath: string, auth: NotaryAuth): string[] {
  return [
    "notarytool",
    "submit",
    zipPath,
    "--key",
    auth.p8Path,
    "--key-id",
    auth.keyId,
    "--issuer",
    auth.issuerId,
    "--wait",
  ];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

if (import.meta.main) {
  const binary = process.argv[2];
  if (!binary) throw new Error("usage: bun scripts/notarize.ts <binary-path>");

  const auth: NotaryAuth = {
    p8Path: requireEnv("AC_API_KEY_PATH"),
    keyId: requireEnv("AC_API_KEY_ID"),
    issuerId: requireEnv("AC_API_ISSUER_ID"),
  };

  // notarytool requires a container (zip/dmg/pkg), never a bare Mach-O binary.
  const zip = `${binary}.zip`;
  await $`ditto -c -k --keepParent ${binary} ${zip}`;

  try {
    const result = await $`xcrun ${notarytoolArgs(zip, auth)}`.nothrow();
    if (result.exitCode !== 0) {
      // Surface Apple's reason (commonly: hardened runtime missing) for diagnosis.
      console.error("notarization failed:");
      console.error(result.stdout.toString());
      console.error(result.stderr.toString());
      process.exit(1);
    }
    console.log(`notarized ${binary}`);
  } finally {
    await $`rm -f ${zip}`;
  }
}

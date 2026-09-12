import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EDITOR_COMPATIBILITY_PROFILES,
  editorCompatibilityProfile,
  editorSmokeDocument,
  editorSmokePassed,
  profileSupportsPlatform,
  validateCompatibilityProfiles,
} from "../src/editor/compatibility";
import { launchEditor } from "../src/editor/launch";

function usage(): string {
  return [
    "Cleetus editor compatibility smoke",
    "",
    "Usage:",
    "  bun run smoke:editor",
    "  bun run smoke:editor -- --check",
    "  bun run smoke:editor -- --profile <id>",
    "",
    "Listing and --check never launch an editor. --profile performs an interactive handoff.",
  ].join("\n");
}

function available(executable: string): boolean {
  return Boolean(Bun.which(executable)) || existsSync(executable);
}

function printProfiles(checkAvailability: boolean): void {
  console.log(usage());
  console.log("\nProfiles:");
  for (const profile of EDITOR_COMPATIBILITY_PROFILES) {
    const supported = profileSupportsPlatform(profile);
    const availability = checkAvailability
      ? supported && available(profile.executable)
        ? "available"
        : supported
          ? "not found"
          : "unsupported platform"
      : supported
        ? "platform supported"
        : "unsupported platform";
    console.log(`  ${profile.id.padEnd(10)} ${profile.command.padEnd(24)} ${availability}`);
    console.log(`             ${profile.waitBehavior}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const args = argv.filter((arg) => arg !== "--");
  const issues = validateCompatibilityProfiles();
  if (issues.length > 0) {
    console.error(`Invalid editor compatibility profiles:\n${issues.join("\n")}`);
    return 1;
  }
  if (args.length === 0 || args[0] === "--list" || args[0] === "--help" || args[0] === "-h") {
    printProfiles(false);
    return 0;
  }
  if (args[0] === "--check" && args.length === 1) {
    printProfiles(true);
    return 0;
  }
  if (args[0] !== "--profile" || !args[1] || args.length !== 2) {
    console.error(usage());
    return 2;
  }

  const profile = editorCompatibilityProfile(args[1]);
  if (!profile) {
    console.error(
      `Unknown editor profile '${args[1]}'. Choose: ${EDITOR_COMPATIBILITY_PROFILES.map((item) => item.id).join(", ")}`,
    );
    return 2;
  }
  if (!profileSupportsPlatform(profile)) {
    console.error(`Profile '${profile.id}' is not supported on ${process.platform}.`);
    return 2;
  }
  if (!available(profile.executable)) {
    console.error(
      `Profile '${profile.id}' requires '${profile.executable}', which was not found on PATH.`,
    );
    return 2;
  }

  const projectDir = mkdtempSync(join(tmpdir(), "cleetus editor smoke-"));
  const target = join(projectDir, "edit target.md");
  writeFileSync(target, editorSmokeDocument(profile));
  console.log(`\nLaunching ${profile.label} through the Cleetus editor handoff.`);
  console.log("Follow the instructions in the temporary file, save it, and close the editor.");
  console.log(profile.waitBehavior);
  try {
    await launchEditor({
      cwd: projectDir,
      targets: [target],
      editor: profile.command,
    });
    if (!editorSmokePassed(readFileSync(target, "utf8"))) {
      console.error("\nEditor returned, but the saved smoke marker was not observed.");
      return 1;
    }
    console.log(`\n✓ ${profile.label} completed the Cleetus editor compatibility smoke.`);
    return 0;
  } catch (error) {
    console.error(`\n✗ ${profile.label} smoke failed: ${(error as Error).message}`);
    return 1;
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}

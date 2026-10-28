import { strict as assert } from "node:assert";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { version } from "../package.json";

assert.equal(process.platform, "win32");
const binary = resolve(process.argv[2] ?? "dist/user-paths-build/bin/cleetus.exe");
const powershell = process.env.CLEETUS_TEST_PWSH ?? Bun.which("pwsh.exe")!;
mkdirSync("dist/user-paths-smoke", { recursive: true });
const root = mkdtempSync(join(resolve("dist/user-paths-smoke"), "spaces Ω "));
const home = join(root, "home");
const local = join(root, "Local");
const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  LOCALAPPDATA: local,
  CLEETUS_PORTABLE: "0",
};
mkdirSync(home);
const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
async function run(argv: string[], environment: Record<string, string | undefined> = env) {
  const child = Bun.spawn(argv, {
    cwd: root,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${argv[1]}: ${out.slice(-2000)}\n${err.slice(-2000)}`);
  return out;
}
async function paths(exe: string, environment = env, args: string[] = []) {
  return JSON.parse(await run([exe, "--print-user-paths", ...args], environment));
}

const server = Bun.serve({
  port: 0,
  fetch: () => Response.json({ data: [{ id: "fixture-model" }] }),
});
const config = `providers:\n  fixture:\n    type: lmstudio\n    base_url: http://127.0.0.1:${server.port}\ndefault_provider: fixture\ndefault_model: fixture-model\nsandbox:\n  backend: none\n`;
try {
  const native = await paths(binary);
  assert.equal(native.mode, "native");
  assert.equal(native.configRoot, join(local, "Cleetus"));
  assert.equal(existsSync(native.configRoot), false, "path inspection created user data");
  const legacyConfig = join(home, ".config", "cleetus");
  const legacyWorkspace = join(home, ".cleetus");
  mkdirSync(legacyConfig, { recursive: true });
  mkdirSync(legacyWorkspace);
  writeFileSync(join(legacyConfig, "config.yaml"), config);
  writeFileSync(join(legacyWorkspace, "memory.md"), "global memory fixture");
  assert.equal((await paths(binary)).mode, "legacy");
  const preview = JSON.parse(await run([binary, "migrate-data", "--json"]));
  assert.equal(preview.applied, false);
  assert.equal(existsSync(legacyConfig), true);
  const migrated = JSON.parse(await run([binary, "migrate-data", "--yes", "--json"]));
  assert.equal(migrated.applied, true);
  const after = await paths(binary);
  assert.equal(after.mode, "native");
  assert.equal(after.workspaceRoot, join(local, "Cleetus", "workspace"));
  assert.equal(
    readFileSync(join(after.workspaceRoot, "memory.md"), "utf8"),
    "global memory fixture",
  );
  assert.match(await run([binary, "--global", "--list-models", "--json"]), /fixture-model/);

  // Build a real installer fixture from this compiled binary and its complete runtime.
  const payload = join(root, "payload");
  mkdirSync(payload);
  cpSync(binary, join(payload, "cleetus.exe"));
  cpSync(join(dirname(binary), "native"), join(payload, "native"), { recursive: true });
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.txt", "ACKNOWLEDGEMENTS.md"])
    cpSync(resolve(name), join(payload, name));
  const archive = join(root, "package.zip");
  const prepare = join(root, "prepare.ps1");
  writeFileSync(
    prepare,
    `Add-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::CreateFromDirectory(${q(payload)},${q(archive)})\n`,
  );
  await run([powershell, "-NoProfile", "-File", prepare]);
  const hash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archive).arrayBuffer())
    .digest("hex");
  const checksums = join(root, "checksums.txt");
  writeFileSync(checksums, `${hash}  cleetus-windows-${process.arch}.zip\n`);
  const app = join(root, "Portable app's Ω");
  const install = join(root, "install-fixture.ps1");
  writeFileSync(
    install,
    `$ErrorActionPreference='Stop'\n$env:CLEETUS_INSTALLER_TEST='1'\n. ${q(resolve("install.ps1"))}\nfunction Get-CleetusRelease { return ${q(`v${version}`)} }\nfunction Save-CleetusDownload { param([string]$Url,[string]$Destination); if($Url.EndsWith('checksums.txt')){[IO.File]::Copy(${q(checksums)},$Destination)}else{[IO.File]::Copy(${q(archive)},$Destination)} }\nInstall-Cleetus -InstallDir ${q(app)} -Portable -NoPath -SkipDoctor\n`,
  );
  await run([powershell, "-NoProfile", "-File", install]);
  const portableEnv = { ...env } as Record<string, string | undefined>;
  delete portableEnv.CLEETUS_PORTABLE;
  const portableExe = join(app, "bin", "cleetus.exe");
  const portable = await paths(portableExe, portableEnv);
  assert.equal(portable.mode, "portable");
  assert.equal(portable.configRoot, join(app, "data"));
  mkdirSync(portable.configRoot);
  writeFileSync(join(portable.configRoot, "config.yaml"), config);
  writeFileSync(join(portable.configRoot, "memory.md"), "portable memory");
  await run([powershell, "-NoProfile", "-File", install]);
  assert.equal(readFileSync(join(portable.configRoot, "memory.md"), "utf8"), "portable memory");
  assert.equal(
    (await paths(portableExe, portableEnv, ["--config-dir", after.configRoot])).configRoot,
    after.configRoot,
  );
  const moved = join(root, "Relocated app's Ω");
  renameSync(app, moved);
  const movedExe = join(moved, "bin", "cleetus.exe");
  const relocated = await paths(movedExe, portableEnv);
  assert.equal(relocated.configRoot, join(moved, "data"));
  assert.equal(readFileSync(join(relocated.configRoot, "memory.md"), "utf8"), "portable memory");
  assert.match(
    await run([movedExe, "--global", "--list-models", "--json"], portableEnv),
    /fixture-model/,
  );
  assert.equal(existsSync(join(moved, "data", "workspace")), true);
  console.log(`WINDOWS_USER_PATHS_INSTALLER_PASS ${root}`);
} finally {
  server.stop(true);
}

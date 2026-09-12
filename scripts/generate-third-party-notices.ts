import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const outputPath = join(repoRoot, "THIRD_PARTY_NOTICES.txt");
const overrideRoot = join(repoRoot, "scripts", "license-overrides");
const npmManifestPath = join(overrideRoot, "npm-packages.json");
const bunVersion = "1.3.14";

const allowedLicenses = new Set([
  "Apache-2.0",
  "BlueOak-1.0.0", // Blue Oak Model License 1.0.0 — permissive, non-copyleft (sax, via jimp)
  "BSD-2-Clause",
  "BSD-2-Clause AND MIT",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MIT AND Zlib", // both permissive; normalized from pako's "(MIT AND Zlib)" (via jimp)
  "(MIT AND Zlib)",
  "MIT OR Apache-2.0",
]);

const firstPartyPackages = new Set(["react-devtools-core@0.0.0"]);

const npmOverrides: Record<string, string> = {
  "@alcalzone/ansi-tokenize@0.1.3": "npm/alcalzone-ansi-tokenize-0.1.3.txt",
  "boolbase@1.0.0": "npm/boolbase-1.0.0.txt",
  "node-html-markdown@2.0.0": "npm/node-html-markdown-2.0.0.txt",
  // MIT packages (via jimp) that ship no LICENSE file; text transcribed from each project.
  "omggif@1.0.10": "npm/omggif-1.0.10.txt",
  "parse-bmfont-ascii@1.0.6": "npm/parse-bmfont-ascii-1.0.6.txt",
  "yoga-layout@3.2.1": "npm/yoga-layout-3.2.1.txt",
};

const sourceOverrides: Record<string, string> = {
  "@alcalzone/ansi-tokenize@0.1.3": "https://github.com/AlCalzone/ansi-tokenize",
  "exif-parser@0.1.12": "https://github.com/bwindels/exif-parser",
};

// Packages whose package.json omits a `license` field (incomplete upstream metadata). The value is
// the reviewed SPDX license, confirmed from the package's own repository. Consulted only as a
// fallback when `pkg.license` is absent, so a package that later adds a (different) license field
// is not silently overridden.
const licenseOverrides: Record<string, string> = {
  // exif-parser 0.1.12 ships a bare package.json (no license field). Its repository states MIT:
  // https://github.com/bwindels/exif-parser/blob/master/README.md ("License: This library is
  // provided under the MIT license"). Pulled in transitively by @jimp/core for EXIF reads.
  "exif-parser@0.1.12": "MIT",
};

/** The package's declared SPDX license, falling back to a reviewed override for bare manifests. */
function licenseFor(pkg: PackageJson, id: string): string | undefined {
  return pkg.license ?? licenseOverrides[id];
}

interface PackageJson {
  name?: string;
  version?: string;
  license?: string;
  repository?: string | { url?: string };
  homepage?: string;
}

interface Notice {
  id: string;
  license: string;
  source?: string;
  text: string;
}

type NpmManifest = Record<string, string[]>;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function packageRootFromInput(input: string): string | undefined {
  const bunMatch = input.match(
    /^(node_modules\/\.bun\/[^/]+\/node_modules\/(?:@[^/]+\/)?[^/]+)/,
  );
  if (bunMatch?.[1]) return join(repoRoot, bunMatch[1]);

  const nodeModulesMatch = input.match(/^(node_modules\/(?:@[^/]+\/)?[^/]+)/);
  if (nodeModulesMatch?.[1]) return join(repoRoot, nodeModulesMatch[1]);

  return undefined;
}

function sourceUrl(pkg: PackageJson): string | undefined {
  const repository =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return repository ?? pkg.homepage;
}

function licenseFiles(packageRoot: string): string[] {
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort(compareText);
}

async function bundledPackageRoots(): Promise<Map<string, string>> {
  const scratch = mkdtempSync(join(tmpdir(), "cleetus-license-audit-"));
  const outfile = join(scratch, "cleetus.js");
  const metafile = join(scratch, "metafile.json");

  try {
    const build = Bun.spawn(
      [
        "bun",
        "build",
        "src/bin/cleetus.ts",
        "--target=bun",
        `--outfile=${outfile}`,
        `--metafile=${metafile}`,
      ],
      { cwd: repoRoot, stdout: "ignore", stderr: "inherit" },
    );
    if ((await build.exited) !== 0) {
      throw new Error("Could not build the CLI dependency graph");
    }

    const metadata = (await Bun.file(metafile).json()) as {
      inputs: Record<string, unknown>;
    };
    const packageRoots = new Set<string>();
    for (const input of Object.keys(metadata.inputs)) {
      const packageRoot = packageRootFromInput(input);
      if (packageRoot) packageRoots.add(packageRoot);
    }

    const roots = new Map<string, string>();
    for (const packageRoot of packageRoots) {
      const pkg = (await Bun.file(join(packageRoot, "package.json")).json()) as PackageJson;
      const id = pkg.name && pkg.version ? `${pkg.name}@${pkg.version}` : "";
      if (!pkg.name || !pkg.version || !licenseFor(pkg, id)) {
        throw new Error(`Incomplete package metadata in ${packageRoot}`);
      }

      if (firstPartyPackages.has(id)) continue;
      roots.set(id, packageRoot);
    }

    return roots;
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

async function installedPackageRoots(): Promise<Map<string, string>> {
  const nodeModules = join(repoRoot, "node_modules");
  const roots = new Map<string, string>();
  const packageJsonFiles: string[] = [];
  const glob = new Bun.Glob("**/package.json");
  for await (const path of glob.scan({
    cwd: nodeModules,
    dot: true,
    followSymlinks: false,
    onlyFiles: true,
  })) {
    packageJsonFiles.push(path);
  }

  for (const path of packageJsonFiles.sort(compareText)) {
    const packageJsonPath = join(nodeModules, path);
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
    if (!pkg.name || !pkg.version) continue;
    const id = `${pkg.name}@${pkg.version}`;
    if (!roots.has(id)) roots.set(id, dirname(packageJsonPath));
  }

  return roots;
}

function assertSameInventory(actual: Set<string>, expected: Set<string>): void {
  const added = [...actual].filter((id) => !expected.has(id)).sort(compareText);
  const removed = [...expected].filter((id) => !actual.has(id)).sort(compareText);
  if (added.length === 0 && removed.length === 0) return;

  const details = [
    ...added.map((id) => `  + ${id}`),
    ...removed.map((id) => `  - ${id}`),
  ].join("\n");
  throw new Error(
    `The ${process.platform} CLI dependency graph differs from scripts/license-overrides/npm-packages.json:\n${details}\nReview the changes, update the inventory, and regenerate the notices.`,
  );
}

async function cliNotices(): Promise<Notice[]> {
  const manifest = (await Bun.file(npmManifestPath).json()) as NpmManifest;
  for (const [platform, ids] of Object.entries(manifest)) {
    const sorted = [...ids].sort(compareText);
    if (new Set(ids).size !== ids.length || ids.some((id, index) => id !== sorted[index])) {
      throw new Error(`The ${platform} npm package inventory must be sorted and unique`);
    }
  }

  const bundledRoots = await bundledPackageRoots();
  const expectedForPlatform = manifest[process.platform];
  if (expectedForPlatform) {
    assertSameInventory(new Set(bundledRoots.keys()), new Set(expectedForPlatform));
  }

  const packageIds = [...new Set(Object.values(manifest).flat())].sort(compareText);
  const installedRoots = await installedPackageRoots();
  const notices: Notice[] = [];
  for (const id of packageIds) {
    const packageRoot = bundledRoots.get(id) ?? installedRoots.get(id);
    if (!packageRoot) {
      throw new Error(`${id} is in the reviewed inventory but is not installed`);
    }
    const pkg = (await Bun.file(join(packageRoot, "package.json")).json()) as PackageJson;
    const license = licenseFor(pkg, id);
    if (!pkg.name || !pkg.version || !license) {
      throw new Error(`Incomplete package metadata in ${packageRoot}`);
    }
    if (`${pkg.name}@${pkg.version}` !== id) {
      throw new Error(`Expected ${id} at ${packageRoot}`);
    }
    if (!allowedLicenses.has(license)) {
      throw new Error(`${id} uses unreviewed license expression: ${license}`);
    }

    const files = licenseFiles(packageRoot);
    let text: string;
    if (files.length > 0) {
      text = files
        .map((file) => readFileSync(join(packageRoot, file), "utf8").trim())
        .join("\n\n");
    } else {
      const override = npmOverrides[id];
      if (!override) {
        throw new Error(
          `${id} has no packaged license notice; add a reviewed override under scripts/license-overrides/npm`,
        );
      }
      text = readFileSync(join(overrideRoot, override), "utf8").trim();
    }

    notices.push({
      id,
      license,
      source: sourceOverrides[id] ?? sourceUrl(pkg),
      text,
    });
  }

  return notices;
}

function runtimeNotices(): Notice[] {
  if (Bun.version !== bunVersion) {
    throw new Error(
      `Bun changed from ${bunVersion} to ${Bun.version}; review its runtime license inventory`,
    );
  }

  return [
    {
      id: `Bun@${bunVersion}`,
      license: "MIT with separately licensed linked components",
      source: "https://github.com/oven-sh/bun",
      text: readFileSync(
        join(overrideRoot, "runtime", `bun-${bunVersion}.md`),
        "utf8",
      ).trim(),
    },
  ];
}

function render(runtime: Notice[], cli: Notice[]): string {
  const sections = [...runtime, ...cli].map((notice) => {
    const source = notice.source ? `\nSource: ${notice.source}` : "";
    return [
      "=".repeat(80),
      `${notice.id}`,
      `License: ${notice.license}${source}`,
      "-".repeat(80),
      notice.text,
    ].join("\n");
  });

  return `${[
    "CLEETUS THIRD-PARTY SOFTWARE NOTICES",
    "",
    "This file contains notices for third-party software included in Cleetus release binaries.",
    "Cleetus itself is licensed separately under the MIT License in LICENSE.",
    "",
    `Embedded runtimes: ${runtime.length}`,
    `CLI packages: ${cli.length}`,
    "",
    "Generated by: bun run licenses",
    "Do not edit this file directly. Update the dependency, its packaged license, or",
    "the reviewed overrides under scripts/license-overrides, then regenerate it.",
    "",
    ...sections,
    "",
  ].join("\n")}`;
}

function noticeIds(content: string): Set<string> {
  return new Set(
    [...content.matchAll(/^={80}\n([^\n]+)$/gm)].map((match) => match[1] as string),
  );
}

function printNoticeDifference(existing: string, rendered: string): void {
  const existingIds = noticeIds(existing);
  const renderedIds = noticeIds(rendered);
  const added = [...renderedIds].filter((id) => !existingIds.has(id)).sort(compareText);
  const removed = [...existingIds].filter((id) => !renderedIds.has(id)).sort(compareText);

  for (const id of added) console.error(`  + ${id}`);
  for (const id of removed) console.error(`  - ${id}`);
  if (added.length === 0 && removed.length === 0) {
    console.error("  Package license text or metadata changed.");
  }
}

const rendered = render(runtimeNotices(), await cliNotices());
if (process.argv.includes("--check")) {
  const existing = await Bun.file(outputPath).text();
  if (existing !== rendered) {
    console.error("THIRD_PARTY_NOTICES.txt is stale. Run `bun run licenses`.");
    printNoticeDifference(existing, rendered);
    process.exit(1);
  }
  console.log("THIRD_PARTY_NOTICES.txt is current.");
} else {
  writeFileSync(outputPath, rendered);
  console.log(`Wrote ${outputPath}`);
}

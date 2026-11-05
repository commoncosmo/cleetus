import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { Manifest } from "../../src/codeindex/manifest";
import { migrateWindowsData } from "../../src/config/migrate-data";
import { EventLog } from "../../src/events/log";
import { openDatabase, openDatabaseBatch } from "../../src/lib/db";
import { MemoryStore } from "../../src/memory/store";
import {
  preparePrivateState,
  privateDirectory,
  privateFile,
  writePrivateFile,
} from "../../src/security/private-state";
import { windowsPrivateStates } from "../../src/security/windows-private-state";
import { VectorService } from "../../src/vector/service";

const windows = test.skipIf(process.platform !== "win32");
const base = resolve("dist/windows-private-tests");
const roots: string[] = [];
function fixture() {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "ACL Ω [literal] "));
  roots.push(root);
  return root;
}
function powershell(script: string, paths: string[]): string {
  const source = `$ProgressPreference='SilentlyContinue';${script}`;
  return execFileSync(
    join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(source, "utf16le").toString("base64"),
    ],
    {
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, CLEETUS_ACL_TEST_PATHS: JSON.stringify(paths) },
    },
  ).trim();
}
function broaden(...paths: string[]) {
  powershell(
    `$ErrorActionPreference='Stop'; foreach($path in (ConvertFrom-Json $env:CLEETUS_ACL_TEST_PATHS)) {
    $entry=Get-Item -LiteralPath $path; $acl=$entry.GetAccessControl();
    $sid=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0');
    if($entry.PSIsContainer) { $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow') }
    else { $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow') }
    $acl.AddAccessRule($rule); $entry.SetAccessControl($acl)
  }`,
    paths,
  );
}
function acl(...paths: string[]): {
  path: string;
  protected: boolean;
  owner: string;
  user: string;
  rules: { sid: string; inherited: boolean; rights: number }[];
}[] {
  return JSON.parse(
    powershell(
      `$ErrorActionPreference='Stop'; $rows=@(foreach($path in (ConvertFrom-Json $env:CLEETUS_ACL_TEST_PATHS)) {
    $entry=Get-Item -LiteralPath $path; $acl=$entry.GetAccessControl();
    @{path=$path;protected=$acl.AreAccessRulesProtected;owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
      user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value;inherited=$_.IsInherited;rights=[int]$_.FileSystemRights} })}
  }); ConvertTo-Json -Depth 6 -InputObject $rows`,
      paths,
    ),
  );
}
function expectPrivate(...paths: string[]) {
  for (const entry of acl(...paths)) {
    expect(entry.protected).toBe(true);
    const allowed = new Set([entry.user, "S-1-5-18", "S-1-5-32-544"]);
    expect(entry.rules.length).toBe(allowed.size);
    for (const rule of entry.rules) {
      expect(allowed.has(rule.sid)).toBe(true);
      expect(rule.inherited).toBe(false);
      expect(rule.rights & 2032127).toBe(2032127);
    }
  }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(base + sep)) throw new Error("Unsafe ACL fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

windows(
  "tightens inherited and explicit broad ACLs recursively without changing the project parent",
  () => {
    const root = fixture();
    broaden(root);
    const state = join(root, ".cleetus");
    mkdirSync(join(state, "old"), { recursive: true });
    const existing = join(state, "old", "state.yaml");
    writeFileSync(existing, "old");
    broaden(state, existing);
    const parentBefore = acl(root);
    privateDirectory(state);
    expectPrivate(state, join(state, "old"), existing);
    expect(acl(root)).toEqual(parentBefore);
    writePrivateFile(join(root, "selected config.yaml"), "private Ω\n");
    expectPrivate(join(root, "selected config.yaml"));
    expect(acl(root)).toEqual(parentBefore);
    expect(readFileSync(join(root, "selected config.yaml"), "utf8")).toBe("private Ω\n");
    const binary = Uint8Array.from([0, 255, 128, 13, 10, 42]);
    writePrivateFile(join(state, "attachment.bin"), binary);
    expect([...readFileSync(join(state, "attachment.bin"))]).toEqual([...binary]);
    expectPrivate(join(state, "attachment.bin"));
  },
  60000,
);

windows(
  "batched startup protects every database and sidecar; later opens repair changed ACLs",
  () => {
    const root = fixture();
    const state = join(root, "state");
    const paths = { sessions: join(state, "sessions.db"), vectors: join(state, "vectors.db") };
    const dbs = openDatabaseBatch(paths, [{ path: state, action: "directory" }]);
    try {
      for (const [name, db] of Object.entries(dbs)) {
        db.exec("CREATE TABLE sample(value TEXT);INSERT INTO sample VALUES ('private')");
        const path = paths[name as keyof typeof paths];
        expectPrivate(path, `${path}-wal`, `${path}-shm`);
      }
      // No process-lifetime cache may hide a subsequent ACL change.
      broaden(paths.sessions, `${paths.sessions}-wal`);
      const reopened = openDatabase(paths.sessions);
      reopened.close();
      expectPrivate(paths.sessions, `${paths.sessions}-wal`, `${paths.sessions}-shm`);
    } finally {
      for (const db of Object.values(dbs)) db.close();
    }
  },
  60000,
);

windows(
  "a warm batch verifies without rewriting correct ACLs, and repairs later tampering",
  () => {
    const root = fixture();
    const state = join(root, "state");
    const path = join(state, "data.yaml");
    mkdirSync(state);
    writeFileSync(path, "keep");
    broaden(state, path);
    preparePrivateState([
      { path: state, action: "directory" },
      { path, action: "file" },
    ]);
    const result = windowsPrivateStates([
      { path: state, action: "directory" },
      { path, action: "file" },
    ]);
    expect(result.inspected).toBe(2);
    expect(result.repaired).toBe(0);
    broaden(path);
    const repaired = windowsPrivateStates([{ path: state, action: "directory" }]);
    expect(repaired.repaired).toBe(1);
    expectPrivate(path);
    expect(readFileSync(path, "utf8")).toBe("keep");
  },
  60000,
);

windows(
  "a bad batch target prevents all application writes and leaves linked targets intact",
  () => {
    const root = fixture();
    const target = join(root, "target");
    mkdirSync(target);
    const file = join(target, "existing");
    writeFileSync(file, "keep");
    const before = acl(file);
    const link = join(root, "linked");
    symlinkSync(target, link, "junction");
    const newDb = join(root, "must-not-create.db");
    expect(() => openDatabaseBatch({ first: newDb, second: join(link, "bad.db") })).toThrow(
      /linked/,
    );
    expect(existsSync(newDb)).toBe(false);
    expect(acl(file)).toEqual(before);
  },
);

windows(
  "SQLite sidecars stay private in a permissive parent across concurrent handles and reopen",
  () => {
    const root = fixture();
    broaden(root);
    const path = join(root, "sessions.db");
    const db = openDatabase(path);
    try {
      db.exec("CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('private')");
      expectPrivate(path, `${path}-wal`, `${path}-shm`);
      const second = openDatabase(path);
      try {
        expect(second.query("SELECT value FROM fixture").get()).toEqual({ value: "private" });
      } finally {
        second.close();
      }
      db.exec("INSERT INTO fixture VALUES ('second')");
      expectPrivate(path, `${path}-wal`, `${path}-shm`);
    } finally {
      db.close();
    }
    const reopened = openDatabase(path);
    try {
      reopened.exec("INSERT INTO fixture VALUES ('reopened')");
      expectPrivate(path, `${path}-wal`, `${path}-shm`);
    } finally {
      reopened.close();
    }
  },
  60000,
);

windows(
  "startup services consume prepared handles without another helper and preserve database ownership",
  () => {
    const root = fixture();
    const paths = {
      sessions: join(root, "sessions.db"),
      mirror: join(root, "mirror.db"),
      project: join(root, "vectors.db"),
      global: join(root, "global-vectors.db"),
      manifest: join(root, "code-index.db"),
    };
    const dbs = openDatabaseBatch(paths);
    const saved = process.env.SystemRoot;
    process.env.SystemRoot = join(root, "missing-system");
    try {
      const log = new EventLog(paths.sessions, {
        database: dbs.sessions,
        mirrorPath: paths.mirror,
        mirrorDatabase: dbs.mirror,
      });
      const vectors = new VectorService({
        projectDbPath: paths.project,
        globalDbPath: paths.global,
        projectDatabase: dbs.project,
        globalDatabase: dbs.global,
        embedder: null,
      });
      const manifest = new Manifest(paths.manifest, dbs.manifest);
      log.append({ sessionId: "startup", type: "user_input", payload: { text: "private" } });
      expect(log.query("startup").length).toBe(1);
      vectors.close();
      manifest.close();
      log.close();
      expect(dbs.sessions.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 1 });
      dbs.sessions.close();
    } finally {
      process.env.SystemRoot = saved;
      for (const db of Object.values(dbs)) {
        try {
          db.close();
        } catch {}
      }
    }
  },
  60000,
);

windows("ACL failures never fall back to chmod or truncate an existing file", () => {
  const root = fixture();
  const existing = join(root, "existing.yaml");
  writeFileSync(existing, "keep");
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = join(root, "missing-system");
  try {
    expect(() => writePrivateFile(existing, "replace")).toThrow(
      "Could not protect private Windows state",
    );
    expect(() => writePrivateFile(join(root, "new.yaml"), "secret")).toThrow(
      "Could not protect private Windows state",
    );
    expect(readFileSync(existing, "utf8")).toBe("keep");
    expect(existsSync(join(root, "new.yaml"))).toBe(false);
  } finally {
    process.env.SystemRoot = saved;
  }
});

windows("refuses junctions and hardlinked files without changing the linked target", () => {
  const root = fixture();
  const target = join(root, "target");
  mkdirSync(target);
  const file = join(target, "keep.yaml");
  writeFileSync(file, "keep");
  const before = acl(file);
  const junction = join(root, "linked");
  symlinkSync(target, junction, "junction");
  expect(() => privateDirectory(junction)).toThrow(/linked|real directory/);
  expect(() => writePrivateFile(join(junction, "keep.yaml"), "replace")).toThrow(/linked/);
  const hardlink = join(root, "hardlink.yaml");
  linkSync(file, hardlink);
  expect(() => writePrivateFile(hardlink, "replace")).toThrow(/linked/);
  expect(() => privateFile(hardlink)).toThrow(/unlinked/);
  expect(readFileSync(file, "utf8")).toBe("keep");
  expect(acl(file)).toEqual(before);
});

windows(
  "global workspace dependency junctions do not block config protection or change their targets",
  () => {
    const root = fixture();
    const data = join(root, "data");
    const modules = join(data, "Workspace", "node_modules");
    mkdirSync(modules, { recursive: true });
    const external = join(root, "dependency-source");
    mkdirSync(external);
    writeFileSync(join(data, "config.yaml"), "providers: {}\n");
    broaden(external);
    const prior = acl(external);
    symlinkSync(external, join(modules, "dependency"), "junction");
    privateDirectory(data, { excludeChildren: ["workspace"] });
    expectPrivate(data, join(data, "config.yaml"));
    expect(acl(external)).toEqual(prior);
  },
  60000,
);

windows(
  "memory writes use private ACLs even outside an initialized application directory",
  () => {
    const root = fixture();
    broaden(root);
    const path = join(root, "memory.md");
    const store = new MemoryStore(path);
    store.add("private preference");
    expectPrivate(path);
    store.removeAt(0);
    expectPrivate(path);
  },
  60000,
);

windows(
  "migration secures copied legacy state and rolls directory moves back on ACL failure",
  () => {
    for (const fail of [false, true]) {
      const root = fixture();
      const legacy = join(root, ".config", "cleetus");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "config.yaml"), "providers: {}\n");
      broaden(legacy, join(legacy, "config.yaml"));
      const opts = {
        platform: "win32" as const,
        env: { LOCALAPPDATA: join(root, "local"), CLEETUS_PORTABLE: "0" },
      };
      const native = join(root, "local", "Cleetus");
      if (fail) {
        const saved = process.env.SystemRoot;
        process.env.SystemRoot = join(root, "missing-system");
        try {
          expect(() => migrateWindowsData(root, opts, true)).toThrow("Migration failed");
        } finally {
          process.env.SystemRoot = saved;
        }
        expect(readFileSync(join(legacy, "config.yaml"), "utf8")).toBe("providers: {}\n");
        expect(existsSync(native)).toBe(false);
      } else {
        expect(migrateWindowsData(root, opts, true).applied).toBe(true);
        expectPrivate(native, join(native, "config.yaml"));
        expect(existsSync(legacy)).toBe(false);
      }
    }
  },
  60000,
);

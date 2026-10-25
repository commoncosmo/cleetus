# Windows MXC / compiled Bun proof

This isolated experiment compiles the real Cleetus CLI with two experimental
switches: `--mxc-poc` runs verification and `--mxc-worker` runs its test workload.
The production CLI and sandbox factory are unchanged. Do not ship these switches.

From the repository root on Windows:

```powershell
bun install --frozen-lockfile
bun install --cwd experiments/mxc --frozen-lockfile
./experiments/mxc/node_modules/bun/bin/bun.exe experiments/mxc/build.ts
./dist/mxc-poc/package/cleetus.exe --version
./dist/mxc-poc/package/cleetus.exe --mxc-poc dist/mxc-poc/results --executor
```

Requires a serviced Windows host with ProcessContainer support; the test prints
MXC's native probe. Artifacts and synthetic fixture files remain under `dist/`.
The experiment pins SDK 1.0.1 and Bun 1.3.14 in its own lockfile.

## Findings

Verified locally on Windows ARM64 (OS build 28000), October 24, 2026. The relocated
distribution contained only `cleetus.exe` and `native/wxc-exec.exe`, in a directory
whose name contained a space. `--version` returned `0.5.11`; the verification
returned `FILESYSTEM_PASS`, four live PIDs before cancellation, zero survivors,
and `MXC_POC_PASS` using embedded Bun 1.3.14.

- A normal SDK bundle fails Koffi's dynamic native-addon lookup.
- Loading the SDK from an adjacent runtime directory fixes discovery, but Bun
  1.3.14 ARM64 crashes in Koffi's native finalizer during `run`.
- Bun 1.4.4 ARM64 runs the filesystem check via the SDK. Streaming `spawn` rejects
  Bun's reported Node compatibility version (26.3.0); the SDK requires newer
  Windows native-stdio support. Do not bypass this gate by spoofing the version.
- The standalone `wxc-exec.exe` transport avoids those Node native-addon/stdio
  issues and runs from the compiled Bun 1.3.14 executable.
- Executor policy must explicitly permit UI subsystem initialization. This proof
  uses `ui.disable: false` with ProcessContainer UI isolation `container`, no
  clipboard access, and no input injection. UI security parity needs separate review.

The filesystem check proves allowed project writes, rejection of an outside write,
and rejection of a denied-file read beneath the writable project. The host also
checks sentinel contents. Runtime directories are read-only; the proof does not
claim to restrict reads to the project. Network denial is configured but not tested.

Cancellation waits until an executor, contained parent, child, and grandchild are
alive, aborts through `AbortController`, kills only the executor, then checks every
recorded PID for up to five seconds. It never uses a host tree-kill to make the
assertion pass. The executor's native lifetime boundary is responsible for reaping.

The package includes SDK/Koffi sidecars solely to reproduce the SDK failures.
The successful executor path needs only `cleetus.exe` and `native/wxc-exec.exe`;
neither Node nor Bun must be separately installed. x64 remains unverified.
This is a transport feasibility test, not production sandbox integration or a
complete Windows security audit. PowerShell/toolchain compatibility remains open.

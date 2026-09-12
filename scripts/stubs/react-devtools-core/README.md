# react-devtools-core stub

This is a no-op stub package that satisfies `bun build --compile` bundling for the `cleetus` binary.

## Why this exists

`ink` (our terminal UI library) contains a DEV-gated dynamic import of `react-devtools-core`. The actual guard in `ink/build/reconciler.js` is:

```js
// Inside ink's reconciler (simplified):
if (process.env['DEV'] === 'true') {
  await import('./devtools.js');  // devtools.js statically imports react-devtools-core
}
```

The import is reached only when `process.env.DEV === 'true'` — not based on `NODE_ENV` or a `production` check. Even though this code path is never reached at runtime, `bun build --compile` statically follows and bundles the dynamic `await import('./devtools.js')` (and its transitive static import of `react-devtools-core`). Without a package present to satisfy the import, the build fails with a module-resolution error.

## Why `--external react-devtools-core` doesn't work

The obvious alternative is `bun build --compile --external react-devtools-core`, which tells the bundler to skip bundling that module and resolve it at runtime instead. This works fine for regular bundled output (where a `node_modules` directory is present at runtime), but **not** for `--compile` (single-file executables). A compiled binary has no `node_modules` to fall back on, so marking the module external just moves the MODULE_NOT_FOUND error from build time to runtime — the binary crashes on first launch with:

```
error: Cannot find package 'react-devtools-core' from '/$bunfs/root/cleetus'
```

This was confirmed empirically: the `--external` flag was tried and failed in this exact way.

## What this stub does

The stub exports a no-op `connectToDevTools` function. When the bundler follows the dynamic import chain and encounters the reference to `react-devtools-core`, it bundles this stub instead of the real devtools package. At runtime, the `DEV === 'true'` guard is never true in normal runs, so `connectToDevTools` is never called — the stub is dead code and has zero effect on behaviour.

## Maintenance

If `ink` ever removes or conditionally-compiles away this import (e.g. via a `__DEV__` rollup define), or if `bun build --compile` gains the ability to tree-shake DEV-only dynamic imports, this stub can be removed along with its `devDependencies` entry in `package.json`.

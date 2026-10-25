// Experimental entry point: the normal CLI is unchanged unless explicitly selected.
if (process.argv[2] === "--mxc-worker") {
  await import("./worker");
} else if (process.argv[2] === "--mxc-poc") {
  await import("./verify");
} else {
  await import("../../src/bin/cleetus");
}

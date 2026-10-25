import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [mode, project, outside] = process.argv.slice(3);
if (mode === "argv") {
  console.log(JSON.stringify(process.argv.slice(4)));
} else if (mode === "filesystem") {
  writeFileSync(join(project!, "allowed.txt"), "allowed");
  for (const operation of [
    () => writeFileSync(join(outside!, "sentinel.txt"), "escaped"),
    () => readFileSync(join(project!, "secret/sentinel.txt")),
  ]) {
    try {
      operation();
      throw new Error("restriction bypassed");
    } catch (e) {
      if (!["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code!)) throw e;
    }
  }
  console.log("FILESYSTEM_PASS");
} else {
  writeFileSync(join(project!, `${mode}.pid`), String(process.pid));
  if (mode !== "grandchild")
    Bun.spawn(
      [process.execPath, "--mxc-worker", mode === "parent" ? "child" : "grandchild", project!],
      { stdout: "ignore", stderr: "inherit", stdin: "ignore" },
    );
  await Bun.sleep(120000);
}

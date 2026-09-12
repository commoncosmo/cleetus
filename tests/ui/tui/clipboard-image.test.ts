import { expect, test } from "bun:test";
import { grabClipboardImage } from "../../../src/ui/tui/clipboard-image";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The runner keys off the command (and, for osascript, the AppleScript body): `which pngpaste`
// reports installation, `pngpaste -` grabs, `clipboard info` reports pasteboard types, and the furl
// coercion returns a file path.
function runner(map: {
  which?: Buffer | null;
  pngpaste?: Buffer | null;
  clipboardInfo?: string;
  furlPath?: string;
}) {
  return (cmd: string, args: string[]): Buffer | null => {
    if (cmd === "which") return map.which ?? null;
    if (cmd === "pngpaste") return map.pngpaste ?? null;
    if (cmd === "osascript") {
      const script = args[1] ?? "";
      if (script.includes("clipboard info"))
        return map.clipboardInfo ? Buffer.from(map.clipboardInfo) : null;
      if (script.includes("furl")) return map.furlPath ? Buffer.from(map.furlPath) : null;
    }
    return null;
  };
}

const INSTALLED = Buffer.from("/usr/local/bin/pngpaste");

test.if(process.platform === "darwin")(
  "returns bytes when pngpaste is installed and yields PNG data",
  () => {
    const r = grabClipboardImage(runner({ which: INSTALLED, pngpaste: PNG }));
    expect(r.bytes?.equals(PNG)).toBe(true);
    expect(r.error).toBeUndefined();
  },
);

test.if(process.platform === "darwin")(
  "tells the user to install pngpaste when it is missing",
  () => {
    const r = grabClipboardImage(runner({ which: null }));
    expect(r.bytes).toBeUndefined();
    expect(r.error).toContain("brew install pngpaste");
  },
);

test.if(process.platform === "darwin")(
  "explains HEIC isn't supported and echoes the file path when a HEIC file is on the clipboard",
  () => {
    const heic = "/Users/example/Desktop/sample image/IMG_1802.heic";
    const r = grabClipboardImage(
      runner({
        which: INSTALLED,
        pngpaste: null,
        clipboardInfo: "«class furl», 57",
        furlPath: heic,
      }),
    );
    expect(r.bytes).toBeUndefined();
    expect(r.error).toContain("HEIC");
    // path has a space → quoted so the /image tokenizer keeps it whole
    expect(r.error).toContain(`/image "${heic}"`);
  },
);

test.if(process.platform === "darwin")(
  "nudges toward by-path for a non-HEIC image file pngpaste couldn't read",
  () => {
    const png = "/tmp/screenshot.png";
    const r = grabClipboardImage(
      runner({
        which: INSTALLED,
        pngpaste: null,
        clipboardInfo: "«class furl», 40",
        furlPath: png,
      }),
    );
    expect(r.error).toContain(`/image ${png}`);
    expect(r.error).not.toContain("HEIC");
  },
);

test.if(process.platform === "darwin")(
  "does not treat copied text as a file even though furl coercion would return a path",
  () => {
    // clipboard info advertises only text types (no furl) — the guard against furl coercing text.
    const r = grabClipboardImage(
      runner({
        which: INSTALLED,
        pngpaste: null,
        clipboardInfo: "«class utf8», 28, string, 28",
        furlPath: "/Users/example/source/project/img1",
      }),
    );
    expect(r.error).toContain("no image found on the clipboard");
  },
);

test.if(process.platform === "darwin")(
  "reports an empty clipboard when nothing image-like is present",
  () => {
    const r = grabClipboardImage(runner({ which: INSTALLED, pngpaste: null }));
    expect(r.error).toContain("no image found on the clipboard");
  },
);

test.if(process.platform !== "darwin")("reports macOS-only off darwin", () => {
  const r = grabClipboardImage(runner({ which: PNG, pngpaste: PNG }));
  expect(r.bytes).toBeUndefined();
  expect(r.error).toContain("only supported on macOS");
});

const CONTROL_PROBE_MARKER = "CLEETUS_CONTROL_PROBE:";

export interface ControlProbeResult {
  observed: boolean;
  expectedTextPresent: boolean;
  controlFound: boolean;
  controlVisible: boolean;
  controlEnabled: boolean;
  controlOccluded: boolean;
  contrastRatio?: number;
  afterTextPresent?: boolean;
  bodyText: string;
  detail?: string;
  /** Computed-style sanity: how many elements bear a layout utility class (flex/grid/…) and how many
   *  of those actually compute to the matching `display`. `utilityApplied === 0` with several such
   *  elements means the CSS framework isn't applying (e.g. Tailwind v4 with no compiler plugin). */
  styleReport?: { utilityElements: number; utilityApplied: number; sampleUnapplied: string };
}

// This script runs with the already-installed Bun runtime and talks directly to the system
// browser's DevTools socket. It adds no browser library or project dependency.
const CONTROL_PROBE_SCRIPT = String.raw`
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const [browser, url, expectedText, expectedControl, expectedAfterText = ""] = process.argv.slice(2);
// Keep the profile under the user's cache dir, not /tmp: a strictly confined snap browser (the
// default Chromium on recent Ubuntu/WSL) can only write a --user-data-dir within $HOME.
let profileBase = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
try { mkdirSync(profileBase, { recursive: true }); } catch { profileBase = tmpdir(); }
const profile = mkdtempSync(join(profileBase, "cleetus-render-"));
const child = Bun.spawn([
  browser, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  "--window-size=1280,800",
  "--remote-debugging-port=0", "--user-data-dir=" + profile, url,
], { stdout: "ignore", stderr: "pipe" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  let port = "";
  for (let i = 0; i < 40; i++) {
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0].trim(); } catch {}
    if (port) break;
    await sleep(100);
  }
  if (!port) throw new Error("browser debugging endpoint did not start");
  let page;
  for (let i = 0; i < 30; i++) {
    const targets = await fetch("http://127.0.0.1:" + port + "/json/list").then((r) => r.json());
    page = targets.find((target) => target.type === "page");
    if (page) break;
    await sleep(100);
  }
  if (!page) throw new Error("browser page target was unavailable");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable");
  await sleep(500);
  const probePage = async function(rawText, rawControl, rawAfter) {
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    // Computed-style sanity: layout utility classes whose class name IS their display value, so a
    // class present but not producing that display means the CSS framework isn't applying. Aggregate
    // rule (utilityApplied === 0 across several) is false-positive-proof: any one applied utility
    // anywhere clears it, so responsive/state overrides on individual elements cannot trip it.
    const styleReport = (() => {
      const UMAP = { flex: "flex", grid: "grid", "inline-flex": "inline-flex", "inline-grid": "inline-grid" };
      const keys = Object.keys(UMAP);
      let utilityElements = 0, utilityApplied = 0, sampleUnapplied = "";
      const nodes = document.querySelectorAll("*");
      const cap = Math.min(nodes.length, 5000);
      for (let i = 0; i < cap; i++) {
        const el = nodes[i];
        const cl = el.classList;
        if (!cl || cl.length === 0) continue;
        for (const u of keys) {
          if (cl.contains(u)) {
            utilityElements++;
            const display = getComputedStyle(el).display;
            if (display === UMAP[u]) utilityApplied++;
            else if (!sampleUnapplied) sampleUnapplied = "." + u + " (computed display:" + display + ")";
            break;
          }
        }
      }
      return { utilityElements, utilityApplied, sampleUnapplied };
    })();
    const wantedText = normalize(rawText);
    const wantedControl = normalize(rawControl);
    const wantedAfter = normalize(rawAfter);
    const bodyText = document.body?.innerText || "";
    if (!wantedControl) return { observed: true, expectedTextPresent: normalize(bodyText).includes(wantedText), controlFound: false, controlVisible: false, controlEnabled: false, controlOccluded: false, bodyText: bodyText.slice(0, 1000), detail: "styles/text check (no control requested)", styleReport };
    const candidates = [...document.querySelectorAll("button,a,input,textarea,select,[role=button],[tabindex]")];
    const name = (element) => element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.innerText || element.textContent || "";
    const control = candidates.find((element) => normalize(name(element)).includes(wantedControl));
    if (!control) return { observed: true, expectedTextPresent: normalize(bodyText).includes(wantedText), controlFound: false, controlVisible: false, controlEnabled: false, controlOccluded: false, bodyText: bodyText.slice(0, 1000), detail: "control not found", styleReport };
    const rect = control.getBoundingClientRect();
    const style = getComputedStyle(control);
    const insetX = Math.min(3, rect.width / 4);
    const insetY = Math.min(3, rect.height / 4);
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    // Bounding-box corners are outside the hit shape of pill/circular controls.
    // Sample the center and edge midpoints instead, retaining coverage for real
    // partial overlays without rejecting a control's own rounded corners.
    const points = [
      ["center", centerX, centerY],
      ["left", rect.left + insetX, centerY],
      ["right", rect.right - insetX, centerY],
      ["top", centerX, rect.top + insetY],
      ["bottom", centerX, rect.bottom - insetY],
    ];
    const inViewport = rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    const ancestors = [];
    for (let node = control; node; node = node.parentElement) ancestors.push(getComputedStyle(node));
    const visible = inViewport && ancestors.every((s) => s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0);
    // Conservative contrast probe: only solid computed sRGB colors. Images/gradients need
    // visual inspection; do not invent a ratio for them. Include placeholder color and alpha.
    const rgba = (value) => {
      const m = value.match(/^rgba?\(([^)]+)\)$/);
      if (!m) return null;
      const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return parts.length >= 3 && parts.every(Number.isFinite) ? [...parts.slice(0, 3), parts[3] ?? 1] : null;
    };
    const blend = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
    let background = [255, 255, 255];
    let solid = true;
    for (const ancestor of [...ancestors].reverse()) {
      if (ancestor.backgroundImage !== "none") solid = false;
      const color = rgba(ancestor.backgroundColor);
      if (!color) { solid = false; continue; }
      background = blend(color, background);
    }
    const isPlaceholder = (control.tagName === "INPUT" || control.tagName === "TEXTAREA") && !control.value && control.placeholder;
    const foregroundStyle = isPlaceholder ? getComputedStyle(control, "::placeholder") : style;
    const foreground = rgba(foregroundStyle.color);
    let contrastRatio;
    if (solid && foreground) {
      foreground[3] *= ancestors.reduce((alpha, s) => alpha * Number(s.opacity), 1) * (isPlaceholder ? Number(foregroundStyle.opacity) : 1);
      const luminance = (rgb) => rgb.map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      const a = luminance(blend(foreground, background)), b = luminance(background);
      contrastRatio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }
    const blockedPoints = points.flatMap(([label, x, y]) => {
      const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, x)), Math.max(0, Math.min(innerHeight - 1, y)));
      if (hit && (hit === control || control.contains(hit))) return [];
      return [label + " hits " + (hit ? hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id.slice(0, 80) : "") : "nothing")];
    });
    const occluded = blockedPoints.length > 0;
    const enabled = !(control.disabled || control.getAttribute("aria-disabled") === "true");
    let afterTextPresent;
    if (wantedAfter && visible && !occluded && enabled) {
      control.click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      afterTextPresent = normalize(document.body?.innerText || "").includes(wantedAfter);
    }
    const detail = "rect=" + Math.round(rect.left) + "," + Math.round(rect.top) + " " + Math.round(rect.width) + "x" + Math.round(rect.height) + " viewport=" + innerWidth + "x" + innerHeight + (occluded ? "; blocked: " + blockedPoints.join(", ") : "");
    return { observed: true, expectedTextPresent: normalize(bodyText).includes(wantedText), controlFound: true, controlVisible: visible, controlEnabled: enabled, controlOccluded: occluded, contrastRatio, afterTextPresent, bodyText: bodyText.slice(0, 1000), detail, styleReport };
  };
  const expression = "(" + probePage.toString() + ")(" + [expectedText, expectedControl, expectedAfterText].map(JSON.stringify).join(",") + ")";
  const evaluated = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const value = evaluated.result?.value;
  if (!value) throw new Error(evaluated.exceptionDetails?.text || "browser evaluation returned no value");
  console.log("${CONTROL_PROBE_MARKER}" + JSON.stringify(value));
} catch (error) {
  console.error("CLEETUS_CONTROL_PROBE_ERROR:" + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  try { await child.exited; } catch {}
  rmSync(profile, { recursive: true, force: true });
}
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** POSIX-sh that resolves a headless-capable browser into `$browser` or exits 69 with the
 * CLEETUS_BROWSER_UNAVAILABLE sentinel. Shared verbatim by the DOM-dump probe (tool.ts) and the
 * interactive control probe so both honor the same override and search order. An explicit
 * CLEETUS_BROWSER wins; then PATH candidates; then the macOS app bundle. */
export const BROWSER_DISCOVERY_SNIPPET = String.raw`browser=""
if [ -n "$CLEETUS_BROWSER" ]; then
  if command -v "$CLEETUS_BROWSER" >/dev/null 2>&1; then browser=$(command -v "$CLEETUS_BROWSER"); elif [ -x "$CLEETUS_BROWSER" ]; then browser="$CLEETUS_BROWSER"; else echo "CLEETUS_BROWSER is set to '$CLEETUS_BROWSER' but that is not an executable browser" >&2; echo "CLEETUS_BROWSER_UNAVAILABLE" >&2; exit 69; fi
fi
if [ -z "$browser" ]; then
  for candidate in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge; do
    if command -v "$candidate" >/dev/null 2>&1; then browser=$(command -v "$candidate"); break; fi
  done
fi
if [ -z "$browser" ] && [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then browser="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; fi
if [ -z "$browser" ]; then echo "CLEETUS_BROWSER_UNAVAILABLE" >&2; exit 69; fi`;

export function controlProbeCommand(input: {
  url: string;
  expectedText?: string;
  expectedControl?: string;
  expectedAfterText?: string;
}): string {
  const encoded = Buffer.from(CONTROL_PROBE_SCRIPT).toString("base64");
  return String.raw`${BROWSER_DISCOVERY_SNIPPET}
probe=$(mktemp)
printf '%s' '${encoded}' | base64 -d > "$probe"
bun "$probe" "$browser" ${shellQuote(input.url)} ${shellQuote(input.expectedText ?? "")} ${shellQuote(input.expectedControl ?? "")} ${shellQuote(input.expectedAfterText ?? "")}
probe_status=$?
rm -f "$probe"
exit $probe_status`;
}

export function parseControlProbe(output: string): ControlProbeResult | null {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(CONTROL_PROBE_MARKER));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(CONTROL_PROBE_MARKER.length)) as ControlProbeResult;
  } catch {
    return null;
  }
}

import { NodeHtmlMarkdown } from "node-html-markdown";

/**
 * Remove the two HTML constructs that most often carry invisible injected text —
 * <script>/<style> bodies and HTML comments — before conversion. node-html-markdown
 * ignores script/style too, but stripping first is defense-in-depth and keeps their
 * text from leaking through edge cases. CSS-hidden content is not specially removed
 * (that needs a full DOM); the provenance wrapper is the backstop for residual noise.
 */
function stripDangerous(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

const CHROME_TAGS = [
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "svg",
  "button",
  "iframe",
  "noscript",
] as const;

/** Remove structural page chrome (navigation, headers/footers, sidebars, forms, inline SVG,
 *  buttons, iframes) and its contents before conversion, so a fetched page carries its main
 *  content rather than the site's boilerplate. Regex-based like `stripDangerous`; imperfect on
 *  nested or unclosed tags (an accepted v1 tradeoff — see the spec's Option B note). */
function stripChrome(html: string): string {
  let out = html;
  for (const tag of CHROME_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
  }
  return out;
}

export function htmlToMarkdown(html: string): string {
  return NodeHtmlMarkdown.translate(stripChrome(stripDangerous(html))).trim();
}

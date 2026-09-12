import { describe, expect, it } from "bun:test";
import { renderArtifactGrounding, renderEnvironment } from "../../src/agent/environment";

describe("renderEnvironment", () => {
  it("states the working directory", () => {
    expect(renderEnvironment("/home/u/proj")).toContain("Working directory: /home/u/proj");
  });

  it("instructs relative paths and no out-of-tree writes", () => {
    const out = renderEnvironment("/home/u/proj").toLowerCase();
    expect(out).toContain("relative");
    expect(out).toContain("absolute paths");
  });

  it("extends relative-path guidance to reads, so workers never retype the root (#114)", () => {
    const out = renderEnvironment("/home/u/proj").toLowerCase();
    expect(out).toContain("read");
  });

  it("names the macOS/BSD coreutils pitfall on darwin", () => {
    const out = renderEnvironment("/p", "darwin");
    expect(out).toContain("Host OS: macOS");
    expect(out).toContain("BSD");
    expect(out).toContain("cat -A");
  });

  it("grounds linux as GNU and does not warn about BSD", () => {
    const out = renderEnvironment("/p", "linux");
    expect(out).toContain("Linux");
    expect(out).toContain("GNU");
    expect(out).not.toContain("BSD");
  });

  it("labels windows", () => {
    expect(renderEnvironment("/p", "win32")).toContain("Windows");
  });

  it("falls back to the raw platform token for an unknown platform", () => {
    expect(renderEnvironment("/p", "freebsd" as NodeJS.Platform)).toContain("freebsd");
  });

  it("states today's date in spelled and ISO form (#156-followup)", () => {
    const out = renderEnvironment("/p", "linux", new Date(2026, 5, 25));
    expect(out).toContain("Thursday, June 25, 2026");
    expect(out).toContain("2026-06-25");
  });

  it("tells the model to search with today's year, not its training cutoff", () => {
    const out = renderEnvironment("/p", "linux", new Date(2026, 5, 25));
    const lower = out.toLowerCase();
    expect(lower).toContain("training");
    expect(lower).toContain("search");
    // the worked example must carry the live year so a weak model copies it verbatim
    expect(out).toContain('"<topic> 2026"');
  });

  it("derives the date from the injected clock, not the wall clock", () => {
    const out = renderEnvironment("/p", "linux", new Date(2024, 0, 3));
    expect(out).toContain("Wednesday, January 3, 2024");
    expect(out).toContain("2024-01-03");
    expect(out).toContain('"<topic> 2024"');
  });
});

describe("renderArtifactGrounding", () => {
  it("is empty without a project-home", () => {
    expect(renderArtifactGrounding()).toBe("");
    expect(renderArtifactGrounding(undefined)).toBe("");
  });

  it("names <home>/artifacts", () => {
    const out = renderArtifactGrounding("/Users/example/acme");
    expect(out).toContain("/Users/example/acme/artifacts");
    expect(out).toContain("shared across all chats and terminals");
  });
});

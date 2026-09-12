import { describe, expect, it } from "bun:test";
import { composeAcpPrompt } from "../../src/acp/prompt-content";

describe("composeAcpPrompt", () => {
  it("preserves the ordering of prose and embedded text resources", () => {
    expect(
      composeAcpPrompt([
        { type: "text", text: "Review this file:" },
        {
          type: "resource",
          resource: {
            uri: "file:///project/src/app.ts",
            mimeType: "text/typescript",
            text: "export const answer = 42;",
          },
        },
        { type: "text", text: "Focus on correctness." },
      ]),
    ).toEqual({
      text:
        "Review this file:\n\n" +
        "[Embedded resource: file:///project/src/app.ts (text/typescript)]\n" +
        "export const answer = 42;\n" +
        "[End embedded resource]\n\n" +
        "Focus on correctness.",
      textOnly: false,
      images: [],
    });
  });

  it("represents binary resources without injecting opaque base64", () => {
    const result = composeAcpPrompt([
      {
        type: "resource",
        resource: {
          uri: "file:///project/archive.zip",
          mimeType: "application/zip",
          blob: "YWJjZA==",
        },
      },
    ]);
    expect(result.text).toContain("Binary content supplied by the client");
    expect(result.text).toContain("8 base64 characters omitted");
    expect(result.text).not.toContain("YWJjZA==");
  });

  it("grounds resource links with their client-supplied metadata", () => {
    expect(
      composeAcpPrompt([
        {
          type: "resource_link",
          uri: "file:///project/README.md",
          name: "README.md",
          title: "Project readme",
          description: "Architecture notes",
          mimeType: "text/markdown",
          size: 1234,
        },
      ]).text,
    ).toBe(
      "[Resource link: README.md (file:///project/README.md; text/markdown)]\n" +
        "Project readme\nArchitecture notes\n1234 bytes",
    );
  });

  it("keeps a pure text prompt eligible for local slash-command dispatch", () => {
    expect(composeAcpPrompt([{ type: "text", text: "/skill weather" }])).toEqual({
      text: "/skill weather",
      textOnly: true,
      images: [],
    });
  });

  it("surfaces image resource and resource_link blocks as candidates", () => {
    const out = composeAcpPrompt([
      { type: "text", text: "look" },
      { type: "resource", resource: { mimeType: "image/png", blob: "AAAA" } },
      { type: "resource_link", uri: "/tmp/a.jpg", mimeType: "image/jpeg" },
      { type: "resource", resource: { mimeType: "application/pdf", blob: "BBBB" } },
    ]);
    expect(out.text).toContain("look");
    expect(out.images).toEqual([
      { mime: "image/png", base64: "AAAA" },
      { mime: "image/jpeg", path: "/tmp/a.jpg" },
    ]);
    // Non-image binary is still represented as metadata text, not a candidate.
    expect(out.text).toContain("application/pdf");
  });

  it("keeps text-only prompts unchanged with no images", () => {
    const out = composeAcpPrompt([{ type: "text", text: "hello" }]);
    expect(out.text).toBe("hello");
    expect(out.images).toEqual([]);
    expect(out.textOnly).toBe(true);
  });
});

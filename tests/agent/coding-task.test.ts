import { describe, expect, it } from "bun:test";
import {
  classifyTask,
  isCodingTask,
  isExplicitBuild,
  reportsInteractiveRenderDefect,
  reportsRuntimeDefect,
  requiresRenderEvidence,
} from "../../src/agent/coding-task";

describe("isCodingTask", () => {
  it("matches leading build verbs", () => {
    for (const t of [
      "build a todo app",
      "create a parser",
      "implement auth",
      "add a button",
      "scaffold a project",
      "set up vite",
    ]) {
      expect(isCodingTask(t)).toBe(true);
    }
  });

  it("matches leading modify verbs (the gap the old detector missed)", () => {
    for (const t of [
      "fix the auth bug",
      "refactor the parser",
      "update the schema",
      "change how routing works",
      "debug this crash",
      "optimize the query",
      "rename the field",
      "remove the dead code",
      "migrate to v2",
    ]) {
      expect(isCodingTask(t)).toBe(true);
    }
  });

  it("matches when a fenced code block is present", () => {
    expect(isCodingTask("here is what I have:\n```ts\nconst x = 1\n```")).toBe(true);
  });

  it("strips one leading politeness prefix", () => {
    expect(isCodingTask("please fix the login page")).toBe(true);
    expect(isCodingTask("can you refactor this")).toBe(true);
  });

  it("does NOT match questions or non-imperative text", () => {
    for (const t of [
      "how would I refactor this?",
      "what's wrong with the parser?",
      "why does build fail?",
      "the fix didn't work",
      "is implementing this hard?",
      "tell me about the codebase",
    ]) {
      expect(isCodingTask(t)).toBe(false);
    }
  });

  it("strips all recognized politeness prefixes (incl. newline after prefix)", () => {
    for (const t of [
      "i want you to build a server",
      "i'd like you to scaffold an API",
      "go ahead and make a helper",
      "could you create a button",
      "would you fix the crash",
      "let's write a test",
      "lets write a test",
      "please\nbuild a thing",
    ]) {
      expect(isCodingTask(t)).toBe(true);
    }
  });

  it("is false for empty/whitespace", () => {
    expect(isCodingTask("")).toBe(false);
    expect(isCodingTask("   ")).toBe(false);
  });
});

describe("isExplicitBuild", () => {
  it("is true for explicit requests to build substantial software", () => {
    for (const s of [
      "build a web app that lists captains",
      "create a REST API for users",
      "implement a server with auth",
      "scaffold a CLI tool",
      "make a dashboard",
      "I want you to build a website",
      "create a small web page showing sales",
      "develop a discord bot",
    ]) {
      expect(isExplicitBuild(s)).toBe(true);
    }
  });

  it("is false for content/display/single-artifact requests", () => {
    for (const s of [
      "Create a list of all known starfleet captains and the ships they commanded. Display the list in table format.",
      "create a table of the planets",
      "write a function that sorts an array",
      "create a script to rename files",
      "summarize the README",
      "fix the bug in auth.ts",
      "refactor the parser",
    ]) {
      expect(isExplicitBuild(s)).toBe(false);
    }
  });

  it("is false for inverted-compound 'X list'/'X table' requests (listing/display, not a build)", () => {
    for (const s of [
      "create a tool list",
      "create an api list",
      "build a game list",
      "create a bot table",
    ]) {
      expect(isExplicitBuild(s)).toBe(false);
    }
  });

  it("is false for questions even when they mention building", () => {
    expect(isExplicitBuild("what's the best way to build an app?")).toBe(false);
    expect(isExplicitBuild("how would I create a web service?")).toBe(false);
  });

  it("is true for a code fence plus a build verb (paste-and-extend)", () => {
    expect(isExplicitBuild("build on this:\n```ts\nexport const x = 1;\n```")).toBe(true);
  });

  it("is false for a code fence with no build verb", () => {
    expect(isExplicitBuild("explain this:\n```ts\nconst x = 1;\n```")).toBe(false);
  });

  it("is false when a software noun is immediately followed by a content/document noun (planning requests)", () => {
    for (const s of [
      "create a project plan",
      "develop a platform strategy",
      "make a migration plan",
      "build a schema diagram",
      "create a server architecture document",
    ]) {
      expect(isExplicitBuild(s)).toBe(false);
    }
  });

  it("is true for bare software nouns with no trailing content noun (legit builds)", () => {
    for (const s of ["scaffold a project", "build a schema", "create a server"]) {
      expect(isExplicitBuild(s)).toBe(true);
    }
  });
});

describe("classifyTask", () => {
  it("keeps conversation, retrieval, and artifacts out of code classes", () => {
    expect(classifyTask("hello there")).toBe("conversation");
    expect(classifyTask("Please look up the weather forecast for Wilmette")).toBe("retrieval");
    expect(classifyTask("Save those results as a json file please")).toBe("artifact");
    expect(classifyTask("update the README with usage examples")).toBe("artifact");
  });

  it("distinguishes focused edits from broad software work", () => {
    expect(classifyTask("fix the parsing bug in src/parser.ts")).toBe("focused_code");
    expect(classifyTask("build a web app that displays the forecast")).toBe("broad_code");
    expect(classifyTask("refactor authentication across the codebase")).toBe("broad_code");
  });

  it("treats an artifact as input when code is being built around it", () => {
    expect(
      classifyTask("Create a simple html/tailwind page to display the contents of the json file"),
    ).toBe("focused_code");
    expect(classifyTask("Create a JSON file")).toBe("artifact");
    expect(classifyTask("Write a report")).toBe("artifact");
  });

  it("identifies requests that require rendered-presentation evidence", () => {
    expect(requiresRenderEvidence("Create an HTML/Tailwind page from the JSON data")).toBe(true);
    expect(requiresRenderEvidence("Fix the parser implementation")).toBe(false);
  });
});

describe("reportsRuntimeDefect", () => {
  it("recognizes a user reporting the built app is broken at runtime", () => {
    for (const input of [
      "I get a blank page when I click on chat or navigate to http://localhost:5173/chat",
      "This is incorrect. I still get a blank page",
      "the app is broken",
      "it doesn't work",
      "nothing shows on the page",
      "TypeError: undefined is not a function",
      "the page crashes on load",
    ]) {
      expect(reportsRuntimeDefect(input)).toBe(true);
    }
  });
  it("does not fire on ordinary build/refactor requests", () => {
    for (const input of [
      "Create a vite/typescript/react application",
      "add a dark mode toggle",
      "refactor the chat store",
      "Implement the approved plan now",
    ]) {
      expect(reportsRuntimeDefect(input)).toBe(false);
    }
  });
});

describe("reportsInteractiveRenderDefect", () => {
  it("fires on a browser-reproducible defect report", () => {
    for (const input of [
      "I get a blank page when I click New thread",
      "the New Thread button does nothing",
      "the sidebar doesn't render after I navigate to /chat",
      "nothing shows on the page",
      "clicking Send is broken",
    ]) {
      expect(reportsInteractiveRenderDefect(input)).toBe(true);
    }
  });
  it("does not fire on a backend-only defect with no visual/interaction symptom", () => {
    for (const input of [
      "the API returns a 500 on POST /users",
      "TypeError: undefined is not a function in the JSON parser",
      "the migration script throws",
    ]) {
      expect(reportsInteractiveRenderDefect(input)).toBe(false);
    }
  });
  it("does not fire when there is no defect report at all", () => {
    expect(reportsInteractiveRenderDefect("add a New thread button")).toBe(false);
    expect(reportsInteractiveRenderDefect("build a chat page")).toBe(false);
  });
});

---
name: test-driven-development
description: "Drive a change test-first: write a failing test, run it focused with run_tests, then the minimal code to pass it; scaffold a runner if the stack makes it cheap"
trigger:
  when: coding-task
scope: decompose
---

You are running the **test-driven-development** skill: drive this change with a failing test
first, then the minimal code to make it pass.

**The loop (red → green → refactor):**
1. Write or extend ONE test that captures the desired behavior and currently FAILS for the
   right reason (not a typo/import error).
2. Run just that test to see it fail: `run_tests` with `filter` set to the test's name. A
   focused run is faster and keeps the output small.
3. Write the minimal code to make it pass — no extra features.
4. Run the focused test again to confirm GREEN, then run the full suite (`run_tests` with no
   filter) to check you broke nothing.
5. Refactor if needed, keeping the suite green.

**When to apply (testability heuristic).** Use this loop for changes to behavior, logic, data
handling, bug fixes, parsers, reducers, route/handler logic, or an API/contract.
**A UI component is unit-testable** — do not skip it as "just UI." Render it and assert on the behavior you can
observe: the text/roles/elements that appear, that a disabled control is disabled, and what a
click or input changes (React Testing Library: `render(<C/>)`, `screen.getByRole(...)`,
`fireEvent.click(...)`, then assert the DOM updated). Only the purely presentational parts — exact
colors, spacing, font, and other CSS — plus configuration, docs, copy, and scaffolding are not
meaningfully unit-testable; for those do NOT write a token test — say the change is
not unit-testable and verify it another way (build, `render_check`, or `smoke_run`). Component behavior tests and `render_check` are
complements: the test pins interaction logic deterministically and headlessly; `render_check`
proves the whole app actually renders in a browser.

**No test suite yet? Scaffold one if the stack makes it cheap, then continue the loop:**
- Bun project: no setup needed — write `src/foo.test.ts` and run `bun test` (optionally
  `-t <name>` to focus). bun test discovers `*.test.ts`/`*.spec.ts`.
- Node + Vite/other (logic only): add `vitest` as a devDependency (`bun add -d vitest`), add a
  `"test": "vitest run"` script to package.json, and write `foo.test.ts`.
- **React / Vite component test:** `bun add -d vitest @vitejs/plugin-react happy-dom
  @testing-library/react @testing-library/dom`. In `vite.config.ts` add
  `test: { environment: "happy-dom", globals: true }` (import `/// <reference types="vitest" />`
  at the top), add a `"test": "vitest run"` script, then write `App.test.tsx`:
  `import { render, screen } from "@testing-library/react";` → `render(<App/>);` →
  `expect(screen.getByRole("button", { name: /new thread/i })).toBeDefined();`. Run
  `bun run test -- -t <name>` to focus. happy-dom keeps it deterministic and headless (no browser).
- Python: ensure `pytest` is available, write `test_foo.py`, run `pytest -k <name>`.
If the stack has no one-step runner, do not fabricate a harness — fall back to build/smoke_run
and tell the user the change is unverified by tests.

**Worked example.** Request: "slugify should lowercase and hyphenate". First write a failing
test asserting `slugify('Hello World') === 'hello-world'`; run it (RED); implement `slugify`;
run it (GREEN); run the full suite.

Report the change citing the test as evidence. Pass only valid, schema-faithful JSON
arguments to every tool you call.

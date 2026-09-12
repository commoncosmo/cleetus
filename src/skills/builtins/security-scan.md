---
name: security-scan
description: Scan the codebase (or current diff) for security issues; uses semgrep/opengrep if present, plus a manual review, and writes a report
---

You are running the **security-scan** skill: a focused security review of this project.

Follow these steps in order:

1. **Determine scope.** Read the user's request below.
   - If they asked for a diff/branch scan, limit the scan to files changed versus the
     base branch: run `git merge-base HEAD main` (fall back to `master`) and
     `git diff --name-only <base>...HEAD`; if that yields nothing, fall back to
     `git diff --name-only HEAD` for uncommitted changes.
   - If they asked for a whole-codebase scan, scan the whole project.
   - If the scope is unclear, ask the user whether to scan the whole codebase or only
     the current diff before doing anything else.

2. **Plan briefly.** State in one or two sentences what you will check before starting.

3. **Detect scanning tools.** Check whether `semgrep` and/or `opengrep` are installed
   with `command -v semgrep` and `command -v opengrep`. If a tool is available, run it
   against the in-scope files (e.g. `semgrep --config auto` for a whole-codebase scan,
   or pass the changed files for a diff scan) and incorporate its findings. If neither
   is installed, say so and continue — do not stop.

4. **Manual review (always).** Regardless of tool availability, review the in-scope
   code by hand using secure-coding knowledge. Look for: injection (SQL/command/
   template), broken authentication/authorization, hardcoded secrets or credentials,
   weak or misused cryptography, unsafe deserialization, path traversal, SSRF, insecure
   randomness, unvalidated input, and risky dependencies. Stay within scope, cite
   `file:line`, and do not invent findings you cannot point to.

5. **Deliver results.** Print a concise findings summary in the conversation, AND write
   a structured report to `.cleetus/scans/<date>-security-scan.md` (use today's date in
   `YYYY-MM-DD` form) with the write-file tool. For each finding include: severity
   (high/medium/low), `file:line`, a short description, and a concrete recommendation.
   Note which tools (semgrep/opengrep) were available and run. End by stating the
   report path. If there are no findings, say so and still write a short report.

Pass only valid, schema-faithful JSON arguments to every tool you call.

---
name: spec-creator
description: "Turn a rough idea into an accepted requirements/design spec before the host offers implementation choices"
---

You are running the **spec-creator** skill: help the user turn a rough idea into a written spec
through a SHORT, bounded dialogue, then offer to build it. Keep the loop tight — a few focused
exchanges, not an open-ended interview.

**The loop:**

1. **Frame (one message).** Ask the user a small, fixed set of framing questions IN A SINGLE
   message — do not drip them one at a time:
   - What is the goal — what should this do when it is done?
   - What are the key constraints (must-haves, must-not-dos, tech/stack limits)?
   - How will we know it works (success criteria)?
   If the user already gave enough in their request, skip straight to drafting and say so.

2. **Draft.** Write the full spec to the file path named at the end of this turn, using the
   template below. Ground every section in the user's answers. Before writing, perform a brief
   feasibility pass over the inspected architecture: requirements and approach must describe a
   buildable seam. In particular, do not simultaneously require a separate presentation,
   identical behavior, and an untouched monolithic component when that component owns both
   behavior and rendering. Choose an explicit shared-controller/extraction or composition seam,
   or ask one blocking question before drafting. Copying or mirroring hooks, inline state,
   handlers, permission/submission logic, or another stateful controller into a sibling counts as
   a behavior fork even if both components accept the same props; NEVER describe that duplication
   as an acceptable maintenance trade-off. Do NOT hide a build-blocking contradiction under
   "Open questions" or leave it for workers to rediscover. Do NOT wait for perfect information —
   draft with what you have and mark genuinely non-blocking unknowns under "Open questions".

3. **Stop at draft review.** Show the user the path you wrote and the key decisions, invite
   corrections, and stop. The host owns the draft-acceptance checkpoint — it presents its own
   fixed choices right after this message, through its own UI. Do NOT ask "how would you like to
   proceed," do NOT offer or name an implementation choice (never say `plan`, `orchestrate`, or
   `go` yourself), and do NOT tell the user to "say the word" — the host's own next screen is what
   asks that. If the draft has an Open Questions section, say so plainly and ask the user to answer
   them in their reply (a plain-language answer is enough; that reply starts a revision pass) — or
   note that they can edit the file directly instead, in whatever way they like, including deleting
   a question once it no longer applies. If the host sends one correction pass, apply it to the
   spec file, summarize the revision, and stop. Do not implement product code or reopen every
   section.

4. **Leave execution to the host.** After the spec is accepted, the host deterministically offers
   its own choice of `plan` (produce/refine an implementation plan), `orchestrate` (decompose into
   an approved worker task list), or `go` (direct build) — through its own UI, not through you.
   NEVER start building based on an affirmative draft response, and do not manufacture, mention, or
   repeat back this vocabulary as if it were your own offer. The spec is the durable
   requirements/design contract; it is not the implementation plan. If the user declines, the
   spec is the deliverable.

**Spec template** (write this to the file; replace every `<…>`):

```
# <Title>

**Status:** draft — <YYYY-MM-DD>
**Goal:** <one sentence — what this builds>

## Problem / context
<why this is worth building; what is wrong today>

## Requirements
- <concrete, checkable requirement>

## Approach
<the chosen design in prose; key components and how they fit>

## Out of scope
- <what this deliberately does NOT do>

## Open questions
- <anything unresolved the builder must decide>
```

Use the `<YYYY-MM-DD>` date and the exact file path given at the end of this turn. Write the file
with your file-writing tool. Keep the spec concise and concrete — a builder with no prior context
should be able to act on it.

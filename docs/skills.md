# Skills

A **skill** is a reusable, model-directed playbook. When you run `/skill <name> [args]`,
cleetus seeds an agent turn whose instructions are the skill's body plus your free-form
arguments. Manual skills are advertised so the model can suggest the matching `/skill`
command. Skills with a `trigger` block are injected automatically on matching turns.

Learned skills are refined rather than multiplied: when `/learn` follows a turn that invoked one
Cleetus-managed playbook, it shows a complete replacement and change summary for that same skill.
The explicit save checks that the reviewed file did not change, creates a backup, and advances its
revision provenance. Other invoked built-in or user-authored skills are supporting context rather
than refinement targets: they are not overwritten and do not prevent `/learn` from drafting a
distinct residual procedure. If several Cleetus-managed playbooks matched, Cleetus asks you to
consolidate or disambiguate them instead of adding another overlapping auto-trigger.

Skills come from three places, in precedence order (higher wins on a name clash):

1. **project** — `.cleetus/skills/` in the current directory or any ancestor
2. **global** — `<config-dir>/skills/` (e.g. `~/.config/cleetus/skills/`)
3. **built-in** — bundled with cleetus (e.g. `security-scan`, `test-driven-development`)

## Two formats

### Flat file (low-ceremony)

A single markdown file, e.g. `.cleetus/skills/my-skill.md`:

```markdown
---
name: my-skill
description: One line shown in the skill list and the model hint.
---

The playbook body. Written as instructions to the model.
```

Frontmatter is optional. With no frontmatter, the name is derived from the filename and the
description defaults to `(user skill)`.

### Directory (`SKILL.md`, richer)

A directory whose entrypoint is `SKILL.md`, able to bundle supporting files:

```
.cleetus/skills/
  my-skill/
    SKILL.md          # entrypoint (same frontmatter + body as the flat format)
    reference.md      # supporting docs, read on demand
    scripts/
      helper.sh       # bundled assets
```

A subdirectory is treated as a skill only if it contains a `SKILL.md`. The skill's name
comes from the `SKILL.md` frontmatter, falling back to the directory name.

## Frontmatter fields

| Field | Honored? | Notes |
|-------|----------|-------|
| `name` | yes | Falls back to the filename / directory name. |
| `description` | yes | Falls back to `(user skill)`. Must be a string. |
| `allowed-tools` | **recognized but not enforced** | Parsed and ignored today; per-skill tool scoping is a planned follow-up. |
| `metadata` | yes | Standard Agent Skills extension map. Cleetus reads the namespaced keys described below and ignores other entries. |
| `license`, `compatibility`, `version`, others | recognized but ignored | Parsed as YAML; safely ignored. Unknown fields never break loading. |

Frontmatter is parsed as YAML. Malformed frontmatter is treated as no frontmatter (the whole
file becomes the body).

## Auto-invocation (`trigger`)

A skill can declare a `trigger` block so cleetus injects its guidance automatically when an
incoming request matches — no `/skill` needed. Absent ⇒ the skill is manual (`/skill`) only.

```yaml
---
name: my-skill
description: "…"
trigger:
  when: coding-task          # named predicate(s); scalar or list
  match: [deploy, "ship it"] # case-insensitive substrings; scalar or list
---
```

- `when` — one or more **named predicates** cleetus evaluates against the request. v1 vocabulary:
  - `coding-task` — the request reads as an imperative code task (a leading `build/fix/add/refactor/…`
    verb, or a fenced code block). This is the same classifier that gates plan-or-go and routing.
  An unknown predicate name is ignored (never matches).
- `match` — one or more **case-insensitive substrings**; the skill triggers if any appears in the
  user's message. (Regex is not supported.)
- A skill triggers when **any** `when` predicate or **any** `match` substring hits (OR).
- When a trigger fires, the skill's body is injected as a `<system-reminder>` alongside the user's
  message, on **every matching turn**. Auto-trigger skills are still invocable manually via `/skill`.

Auto-invocation is globally gated by `skills.auto_invoke` (default `true`) and requires
`skills.enabled`. Set `skills.auto_invoke: false` to disable it without disabling `/skill`.

**Note:** `allowed-tools` remains recognized but not enforced — per-skill tool scoping is tracked
separately (issue #241).

### Capability overlap

Different skill names normally remain independent, even when their descriptions are semantically
similar. Authors can give related auto-trigger skills a shared routing identity with namespaced
Agent Skills metadata:

```yaml
---
name: project-weather
description: Project-specific weather retrieval guidance.
trigger:
  match: ["weather forecast"]
metadata:
  cleetus-capability: weather-forecast
  cleetus-compose: "true" # optional; string value required
---
```

`metadata` is the Agent Skills specification's extension point for client-specific string values.
Other clients can ignore these Cleetus keys while continuing to read the standard `name`,
`description`, body, and bundled resources.

- Without `cleetus-capability`, matching skills retain the historical behavior and can all be
  injected.
- Within one capability, Cleetus injects the highest-precedence matching skill:
  **project > global > built-in**. Same-scope ties use the registry's stable name order.
- `cleetus-compose: "true"` makes a matching skill additive. If the winning skill is composable,
  every matching member of that capability is injected; otherwise, composable non-winners
  accompany the winner.
- Startup diagnostics report exact-name shadowing and overlapping non-composable triggers.
- Manual `/skill <name>` invocation remains name-based and is unaffected by capabilities.

The `trigger` and `scope` top-level fields are Cleetus extensions that predate capability metadata.
Clients that ignore unknown frontmatter keys can still use those files. New routing metadata lives
under `metadata` to follow the standard extension mechanism.

### Stickiness across the plan arc

A triggered skill stays active across the plan → approve → implement arc. When a
skill triggers while a plan is being drafted (in plan mode), its guidance is
re-injected on the approval turn and on the implementation follow-ups that
actually make the changes — even though those turns (e.g. "The plan is approved.
Implement it now.") carry no trigger of their own. Accumulation is bounded by
plan mode: a skill that triggers only outside plan mode applies to that turn
alone. Entering plan mode for a new plan resets the sticky set.

## Bundled resources & progressive disclosure

When a directory skill runs, its composed turn appends the skill's base directory path and a
listing of its bundled files (names only — never their contents):

```
Base directory for this skill: /abs/path/.cleetus/skills/my-skill
Bundled files you can read with read_file as this skill's instructions direct:
- reference.md
- scripts/helper.sh
```

The `SKILL.md` body decides *when* to read those files; the model reads them on demand with
`read_file`. Nothing is loaded eagerly, so a skill can bundle large references cheaply. Up to
100 bundled files are listed per skill (symlinks are not followed).

## Invocation

- `/skill` — list available skills.
- `/skill <name> [args]` — run a skill; everything after the name is passed verbatim as the
  user's arguments alongside the playbook body.
- `/skill edit <name>` — open the active user-authored skill in `$EDITOR`, then rediscover and
  reload it. Flat skills open their Markdown file; directory skills open their entire directory.
  Built-in skills are read-only.
- `/skill run <name> [args]` — explicit run form, including for the unusual case of a skill named
  `edit`.

Enable/disable discovery with the `skills.enabled` config key (default `true`). When
disabled, the hint is suppressed and only built-in skills are available to `/skill`.

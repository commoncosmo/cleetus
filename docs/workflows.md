# Workflows

Workflows turn a repeatable procedure into a strict, reviewable pipeline. They are useful when the
same job should run with predictable steps, explicit inputs and permissions, typed outputs, and a
durable execution history.

A workflow can fetch an API, select or validate JSON, render text, call a tool-free model, or run a
packaged script. Unlike an ordinary agent turn, it cannot decide to add tools or change its own
step graph while running.

## Workflows and skills

Skills and workflows are related but serve different purposes:

| | Skill | Workflow |
|---|---|---|
| Primary role | Guide the model through a task | Execute a declared pipeline |
| Runtime behavior | Model-directed and adaptive | Linear and host-controlled |
| Tools | May use the agent's available tools | Uses only declared, pinned step types |
| Inputs and outputs | Usually conversational | JSON Schema validated |
| Permissions | Determined as tools are requested | Declared and reviewed before execution |
| Repeatability | Procedural guidance | Exact package and execution identity |

The generated `SKILL.md` in a workflow package makes the workflow discoverable. It is not the
executable definition. `workflow.yaml` is executable truth, and `/skill` never runs a workflow.

## Create a workflow

Use the conversational creator when Cleetus should help determine the workflow:

```text
/workflow create weather
```

```text
Create a workflow called weather
```

The workflow creator asks only for material facts that are missing: the purpose, desired result,
inputs, external actions, secrets, and project or global scope. When enough is known, it produces a
validated draft for review.

Creating a draft does not run it. The checkpoints are deliberately separate:

1. Create or revise the draft.
2. Review and activate it.
3. Dry-run or test it.
4. Run it with an explicit permission decision.

At review, reply `activate` to save a new workflow. Replacing an existing workflow requires a
second explicit `replace` response. Activation never executes the workflow. Once a valid
replacement draft is ready for review, Cleetus blocks every same-name execution path so it cannot
silently execute the old active revision. This includes interactive and standalone commands,
model-invoked runs, ACP hosts, process restarts, and another Cleetus session in the same workspace.
The block remains through replacement confirmation; reply `activate` and then exactly `replace`,
or use `cancel`.

Revision drafts use the active package as an immutable base. Cleetus applies typed change
operations, preserves every untargeted field and resource, requires explicit deletion, and shows a
host-computed semantic diff before activation. The latest run is diagnostic context but does not
authorize unrelated retry, timeout, model, or permission changes.

For direct source authoring, create a valid package skeleton without calling a model:

```bash
cleetus workflow init repository-brief
```

Add `--global` for a global package. The skeleton is immediately discoverable and contains
`workflow.yaml`, `SKILL.md`, empty prompt/script directories, and a passing offline test. See
[Manually authoring workflows](workflows/manual-authoring.md) for the complete file, type, step,
revision, and source-control reference.

## Run a workflow

Interactive commands use `/workflow`:

```text
/workflow list
/workflow show weather
/workflow validate weather
/workflow dry-run weather
/workflow run weather
/workflow history weather
/workflow history weather latest
```

Workflow commands and their responses remain in the session transcript. While Cleetus creates,
revises, or runs a workflow, a single live status line shows the current phase or executing step,
elapsed time, and the Escape cancellation hint. Input and permission checkpoints replace the
activity line while they are waiting for you.

Pass one JSON object when the workflow has inputs:

```text
/workflow run weather {"location":"Wilmette, IL","latitude":42.07225,"longitude":-87.72284}
```

The standalone CLI supports automation and stable JSON output:

```bash
cleetus workflow list
cleetus workflow validate weather
cleetus workflow dry-run weather --input location="Wilmette, IL"
cleetus workflow run weather --inputs-json weather-inputs.json
cleetus workflow run weather --inputs-json weather-inputs.json --json
cleetus workflow history weather --limit 20 --offset 0
cleetus workflow history weather latest
```

`dry-run` accepts and validates the same input forms as `run`, then resolves those values in the
preflight preview without executing the workflow.

`history` lists runs compactly. Add a run ID from that list, or `latest`, to inspect step statuses,
attempts, model identity and finish metadata, timings, and bounded output or error summaries.

Noninteractive runs never open input or permission prompts. They fail before the first step when
required inputs, secrets, models, or exact-execution grants are missing.

## Permissions and trust

Before a real run, Cleetus presents one consolidated summary of the maximum authority the workflow
requires. Interactive choices are:

- **Allow once** — authorize only this run.
- **Trust exact revision** — persist authority for this exact execution hash and capability set.
- **Deny** — do not run.

Trust is execution authorization, not a correctness review. A changed manifest, runtime prompt, or
runtime script receives a different execution hash and does not inherit an old grant.

Use **allow once** for the first run of a new or changed workflow. Trust it only after inspecting
the result.

## Update a workflow

The supported update flow starts from the existing package:

```text
/workflow create weather
```

Describe the change in ordinary language, review the complete replacement, reply `activate`, then
confirm `replace`. Cleetus archives the prior package and increments the revision during
activation.

`cleetus workflow init <name>` is the supported starting point for a new hand-authored package.
Editing an active package still bypasses automatic archival, revision incrementing, generated
adapter refresh, and review. If you hand edit a workflow:

1. Preserve a recoverable copy and increment `revision`.
2. Run `validate`, `test`, and `dry-run`.
3. Use **allow once** for the first real run.
4. Trust the new execution only after verifying its behavior.

See [Manually authoring workflows](workflows/manual-authoring.md) for every supported package file,
manifest field, input/output type, step action, test shape, and the current manual lifecycle.

## Inputs and outputs

A workflow receives one JSON object described by JSON Schema. Inputs may include strings, numbers,
booleans, arrays, nested objects, enums, bounds, required fields, and defaults. Interactive input
collection accepts scalar fields directly and validates pasted JSON for array or object fields.
You can also pass every input as one JSON object or use `--inputs-json`.

Every workflow declares one or more named, schema-validated outputs. `presentation.output` chooses
the value shown in the normal UI, while `--json` always returns the stable result envelope. A
selected string is rendered as sanitized Markdown, and a selected array of strings is rendered as
Markdown bullets. Objects and other arrays remain formatted JSON so machine-oriented output is not
mistaken for prose.

Secrets are not ordinary inputs. V1 secrets come from declared environment variables and are never
persisted as workflow inputs or normal output.

## What workflows can do today

V1 includes six pinned step types:

- `http.request@1`
- `llm.generate@1`
- `data.select@1`
- `text.template@1`
- `assert.schema@1`
- `command.run@1`

Steps execute in order and may read immutable workflow inputs, immutable run metadata, declared
secrets, and successful earlier step outputs. Runs are fail-fast and journal every run, step, and
attempt.

Current workflows are intentionally linear. Conditions, parallel execution, loops, nested
workflows, schedules, webhook triggers, in-run human approval, tool-using agents, automatic
fallback paths, and binary artifacts are not supported in schema version 1.

## Package locations

Project workflows:

```text
.cleetus/workflows/<name>/
```

Global workflows:

```text
~/.config/cleetus/workflows/<name>/
```

A package can contain:

```text
<name>/
  workflow.yaml
  SKILL.md
  prompts/
  scripts/
  tests/
```

Project scope wins when a project and global workflow have the same name.

## Continue reading

- [Authoring and updating workflows](workflows/authoring.md)
- [Manually authoring workflows](workflows/manual-authoring.md)
- [Manifest and runtime reference](workflows/reference.md)
- [Troubleshooting](workflows/troubleshooting.md)

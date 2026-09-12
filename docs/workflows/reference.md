# Workflow manifest and runtime reference

This page is the V1 user-facing reference for workflow packages. Unknown manifest fields and
unsupported step fields fail validation rather than being ignored.

## Package layout and identity

```text
<workflow-name>/
  workflow.yaml
  SKILL.md
  prompts/
  scripts/
  tests/
```

The package directory name must match `manifest.name`. Symlinks and resources that escape the
package are rejected.

Create a valid package skeleton with:

```bash
cleetus workflow init <name>
cleetus workflow init <name> --global
```

See [Manually authoring workflows](manual-authoring.md) for the complete source-authoring path.

Cleetus computes:

- **Package hash** — all regular files, used for provenance and change review.
- **Execution hash** — normalized `workflow.yaml` plus referenced runtime prompts and scripts,
  used for grants and run identity.

Editing tests or generated descriptive content can change the package hash without changing
execution authority. Editing the manifest, a referenced prompt, or a referenced script changes the
execution hash.

## Conversational creation protocol

The creation protocol is persisted creator-draft metadata, not a `workflow.yaml` field. Packages
produced by any supported creator protocol use the same manifest and runtime described below.

Fresh revision-1 conversations use `blueprint-v1`. Before blueprint generation, a separate
requirements stage records purpose, desired result, flattened input field shapes, external actions,
secrets, presentation, and each model step's output shape. The requirements contract is persisted
with the draft but is not written into `workflow.yaml`. Host completeness checks prevent blueprint
generation while a field type is unknown, an array item type is unknown, an object shape is
unspecified, an allegedly explicit type has no matching user wording, or a material question
remains. The host accepts and canonicalizes the unambiguous empty-array representation some models
emit for an array-item path marker.

After that gate passes, the model returns typed inputs, executor-discriminated steps, typed
references, outputs, presentation, structured tests, and prompt/script resources. Cleetus verifies
the blueprint's input and model-output types against the approved requirements contract, derives
step-implied permissions, serializes tests, compiles the package, and validates the result. Fresh
blueprints do not silently rename step IDs, infer missing LLM input, reinterpret secret syntax,
adjust template whitespace, or repair model-authored test files. A contract violation receives
bounded diagnostics and one complete replacement blueprint is requested from the original
requirements and persisted contract.

Persisted creator drafts created before this protocol remain resumable. A draft explicitly marked
`legacy-full-package`, or an older draft with no creation-protocol marker, retains the compatibility
compiler it started with. That path can recover the legacy full-package response envelope and
perform its narrow historical normalizations for empty input schemas, underscore step IDs, missing
LLM input wiring, secret interpolation, template spacing, and model-authored test fixtures. It is
not selected for a newly started workflow.

This compatibility affects unfinished authoring drafts only; it does not change active workflow
execution or hand-authored package validation. The legacy path can be removed after Cleetus no
longer supports resuming those stored draft versions, or after an explicit migration/discard
boundary converts or retires them. Until then, keep its regression coverage separate from the
strict blueprint corpus.

## Manifest fields

| Field | Required | Meaning |
|---|---:|---|
| `schema_version` | Yes | Manifest grammar version; V1 requires `1`. |
| `name` | Yes | Lowercase letters and numbers separated by single hyphens. |
| `revision` | Yes | Positive human-readable package revision. |
| `description` | Yes | Short workflow purpose. |
| `inputs` | Yes | JSON Schema for one input object. |
| `secrets` | No | Environment-backed secret declarations. |
| `permissions` | Yes | Maximum network, command, filesystem, and model authority. |
| `execution` | Yes | Workflow timeout and optional workflow model selection. |
| `steps` | Yes | Nonempty ordered list of pinned step definitions. |
| `outputs` | Yes | One or more named values and validation schemas. |
| `presentation` | No | Named output rendered in the normal interactive UI. |

### Execution model selection

Pin a workflow-wide provider or model only when required:

```yaml
execution:
  timeout: 5m
  model:
    provider: lab_ollama
    name: qwen3.6:35b-a3b-coding-mxfp8
```

Otherwise omit `execution.model` to use the active/default workflow model. A step-level
`llm.generate@1` provider or model takes precedence over the workflow selection.

## Inputs

`inputs` is compiled as JSON Schema without type coercion. Use
`additionalProperties: false` when unknown fields should be rejected:

```yaml
inputs:
  type: object
  additionalProperties: false
  required: [city, units]
  properties:
    city:
      type: string
      minLength: 1
    units:
      type: string
      enum: [metric, imperial]
      default: metric
```

Defaults are applied recursively before validation. When an omitted optional object contains
defaulted descendants, Cleetus materializes that object and applies those defaults. Supplied values
always win. Interactive collection supports required scalar strings, numbers, integers, booleans,
and enums, plus pasted JSON arrays and objects. A complete explicit JSON object or `--inputs-json`
can supply all fields at once.

Secrets are not inputs and cannot be supplied through casual CLI input.

## References

Steps and outputs can reference immutable values:

```text
$inputs.<path>
$steps.<earlier-step-id>.output.<path>
$run.id
$run.started_at
$run.workspace
$secrets.<declared-name>
```

A string containing only a reference preserves the referenced JSON type:

```yaml
input: $steps.fetch.output.body
```

In the creator's typed blueprint form, a step-output path begins inside the executor output value.
It does not include the runtime marker `output`. The complete result of an LLM, selector,
assertion, or template step therefore uses an empty typed path and compiles to
`$steps.<id>.output`. Validation rejects paths that cannot exist in a known closed output schema.

`${...}` interpolates scalar values into a larger string:

```yaml
url: https://example.com/weather/${inputs.city}
```

Arrays and objects are never silently stringified. Step references are backward-only. Object keys
and array indexes may be selected with dot-separated reference paths.

Every referenced input path must be guaranteed to exist. Each property along
`$inputs.preferences.maximum_actions`, for example, must be required or materialized by a declared
default. Validation rejects optional referenced paths that could otherwise fail only at runtime.
Conversationally generated workflows with no inputs use the strict schema
`{type: object, properties: {}, additionalProperties: false}`.

For fresh conversational drafts, named inputs must appear under the top-level schema's
`properties`; field names directly under `inputs` are rejected by the structured creator contract.
An optional object passed to a step should normally declare `default: {}` so the reference is
always available.

There is no expression language. Conditions, arithmetic, arbitrary JavaScript expressions, and
forward references are unsupported.

## Step definition

Every step has:

```yaml
- id: unique-step-id
  uses: pinned.step@1
  timeout: 30s
  retry:
    attempts: 2
    backoff:
      initial: 500ms
      multiplier: 2
      maximum: 5s
    when: [timeout]
  allow_untrusted_input: false
  with: {}
```

`timeout`, `retry`, and `allow_untrusted_input` are optional. Each executor supplies a finite
default timeout. Retries are accepted only for error classes that the executor declares safe.

### `http.request@1`

Performs an SSRF-checked, DNS-pinned HTTP request.

Required `with` fields:

- `url`

Optional fields:

- `method` — defaults to `GET`.
- `query` — scalar values or arrays of scalars.
- `headers`
- `body`
- `expected_status` — defaults to `[200]`.
- `expected_content_type`
- `response` — `json` or `text`.
- `max_response_bytes` — defaults to 1 MiB.
- `idempotency_key`
- `allow_unsafe_retry`

Output:

```json
{
  "status": 200,
  "content_type": "application/json",
  "final_url": "https://example.com/result",
  "body": {}
}
```

GET and HEAD are read-only. Other methods are side-effecting unless an idempotency key establishes
idempotent intent. Redirect destinations must remain inside the approved network permission
envelope.

### `llm.generate@1`

Runs a fresh tool-free model transformation with no conversation history.

Required `with` fields:

- `prompt`
- `input`
- `output_schema`

Optional fields:

- `provider`
- `model`
- `max_output_tokens`
- `repair_attempts` — defaults to one schema repair attempt.

The prompt and untrusted input are sent separately under a host-owned system boundary. Returned
data must satisfy `output_schema`. Cleetus handles common structured-output transport forms, but it
does not accept ambiguous or semantically incompatible values.

Omitting `provider` and `model` inherits the workflow/run/default selection. Omitting
`max_output_tokens` leaves the provider output budget unset. An explicit cap is a hard generated
token ceiling and may include reasoning tokens, depending on the provider.

The default step timeout is two minutes.

### `data.select@1`

Selects a value with RFC 6901-style JSON Pointer.

Required `with` fields:

- `value`
- `pointer`

Optional:

- `default` — returned when the pointer does not match.

An empty pointer (`""`) selects the whole value. `/` selects an object property whose name is the
empty string; it is not a root alias. `/items/0/name` selects nested object and array values. To
select an HTTP response body, prefer:

```yaml
value: $steps.fetch.output
pointer: /body
```

### `text.template@1`

Renders deterministic, HTML-escaped text.

Required `with` fields:

- `template`
- `data`

Supported syntax:

```handlebars
{{name}}
{{path.to.value}}
{{#each items}}
- {{this}}
{{/each}}
{{#each actions}}
- {{this.description}} — {{this.owner}}
{{/each}}
```

Inside `each`, `{{this}}` renders a scalar item and `{{this.field}}` selects a field from an object
item. Values remain HTML-escaped. Raw interpolation, nested loops, executable expressions, and
other directives are rejected.

The loop body is repeated byte-for-byte. Put the first repeated character directly after the
opening tag:

```handlebars
{{#each items}}- {{this}}
{{/each}}
```

Writing a newline immediately after `{{#each items}}` makes that leading newline part of every
iteration and produces blank lines between Markdown bullets.

### `assert.schema@1`

Validates a value and returns it unchanged.

Required `with` fields:

- `value`
- `schema`

The step fails when the value does not satisfy the schema. Literal assertion schemas are compiled
during package validation so malformed schemas fail before execution.

### `command.run@1`

Runs one exact command through the configured sandbox.

Required `with` fields:

- `program`
- `output` — `text` or `json`.

Optional fields:

- `args`
- `stdin`
- `cwd`
- `env`
- `max_output_bytes` — defaults to 1 MiB.

The executor does not invoke a shell. It quotes the program and argument array before passing the
command to the sandbox. Packaged JavaScript and TypeScript scripts must use:

```yaml
program: bun
args: [run, ./scripts/task.ts]
```

The output object contains `stdout`, `stderr`, `exit_code`, and `survivors`. When `output: json`,
`stdout` is parsed as JSON.

## Permissions

Declare the maximum authority required by every possible step:

```yaml
permissions:
  network:
    - host: api.example.com
      methods: [GET]
  commands:
    - program: bun
      args_prefix: [run, ./scripts/task.ts]
  filesystem:
    read: [$project/data/**]
    write: [$project/reports/**]
  model: true
```

Validation rejects statically known step authority outside this envelope. Dynamic redirects and
resolved command behavior are checked again during execution.

## Secrets

```yaml
secrets:
  api_key:
    source: env
    name: EXAMPLE_API_KEY
```

Reference the value with `$secrets.api_key`. To allow a specific LLM step to receive it:

```yaml
secrets:
  private_context:
    source: env
    name: PRIVATE_CONTEXT
    expose_to_llm: [summarize]
```

Secret values are marked sensitive, excluded from ordinary persistence, and denied to LLM steps
unless explicitly exposed.

Use scalar interpolation when a secret is part of a header value:

```yaml
Authorization: "Bearer ${secrets.api_key}"
```

GitHub Actions syntax such as `${{ secrets.api_key }}` is not workflow syntax.

## Outputs and presentation

Every named output has a value expression and schema:

```yaml
outputs:
  bullets:
    value: $steps.summarize.output.bullets
    schema:
      type: array
      items:
        type: string
  markdown:
    value: $steps.render.output
    schema:
      type: string

presentation:
  output: markdown
```

All outputs are resolved and validated before a run succeeds. The stable result envelope contains
the run ID, workflow name, revision, execution hash, status, and named outputs.

Interactive presentation rules:

- Selected strings render directly.
- Nonempty selected arrays containing only strings render as bullets.
- Other selected JSON values render as formatted JSON.
- `--json` always returns the full result envelope.

## Tests

Test files live under `tests/` with a `.yaml`, `.yml`, or `.json` extension and use schema version
1, mock mode, explicit inputs, mocks for every external step, and expected
status/output/attempt assertions.

External steps are:

- `http.request@1`
- `llm.generate@1`
- `command.run@1`

Tests never perform live network, model, or command work.

Consequently, a command mock proves the workflow's output envelope, references, and presentation;
it does not execute or validate the semantics of a packaged script. Inspect the resource and use
**allow once** for its first live run.

Offline test inputs follow the production preparation path: schema defaults are materialized first,
then the resulting value is validated against the workflow input schema before any step executes.
Missing required fields are fixture errors rather than simulated workflow failures.
Declared secrets resolve to synthetic sensitive placeholders during mocked execution, so offline
tests never read or require the real environment value.

For drafts containing HTTP, model, or command steps, the conversational creator normally includes
at least one complete offline test. New creator drafts return structured test cases, which Cleetus
serializes under `tests/`; the model does not author YAML text. Hand-authored tests may use either
YAML or JSON. HTTP mocks must use the executor envelope with `status`, `content_type`, `final_url`,
and `body`; placing only the remote body in the mock can hide incorrect references. An LLM mock's
`output` is the structured value itself, without an additional status/output wrapper.

Offline output comparisons are exact, including Markdown whitespace. Inside `text.template@1`,
newlines in an `each` body are emitted for every item. When that body ends with a newline, place
only one newline after `{{/each}}` before the next heading to produce one blank line.
Fresh creator drafts must produce the intended whitespace directly; validation or an offline
snapshot mismatch sends the issue back as repair feedback. Historical full-package creator drafts
retain their narrow whitespace compatibility rule. Hand-authored workflow templates remain
byte-for-byte under the author's control.

## Validation and dry runs

Validation is structural and does not contact external services. It checks schemas, known executor
output envelopes, reference ordering, step configuration, retry safety, timeouts, and declared
permissions. When a `data.select` pointer targets a closed, known output schema, impossible paths
are rejected. Paths inside an open remote response body remain runtime-validated.

Dry runs perform no network, model, command, or filesystem work. HTTP previews include ordinary
query names and values so API parameters can be reviewed, preserve unresolved references as
placeholders, and redact secret or credential-shaped query parameters.

## Commands

Interactive:

```text
/workflow create [--project|--global] [name]
/workflow status
/workflow review
/workflow retry
/workflow resume
/workflow discard
/workflow list
/workflow show <name>
/workflow validate <name>
/workflow test <name>
/workflow dry-run <name>
/workflow run <name> [inputs-json]
/workflow history <name>
/workflow history <name> <run-id|latest>
```

Noninteractive:

```text
cleetus workflow init <name> [--global] [--description text]
cleetus workflow revise <name> [--global]
cleetus workflow review <name> [--global]
cleetus workflow publish <name> [--global]
cleetus workflow discard <name> [--global]
cleetus workflow list
cleetus workflow show <name>
cleetus workflow validate <name>
cleetus workflow test <name>
cleetus workflow dry-run <name> [--input key=value] [--inputs-json path]
cleetus workflow run <name> [--input key=value] [--inputs-json path] [--json]
cleetus workflow history [name] [run-id|latest] [--limit n] [--offset n] [--json]
```

`init` is host-owned, does not call a model, refuses to overwrite an existing package, and creates
a valid skeleton plus deterministic adapter and offline test.

The `cleetus workflow init|revise|review|publish|discard` forms above are standalone shell
commands, not interactive `/workflow` commands. Entering a named manual lifecycle form at the
`cleetus>` prompt produces guidance with the corresponding shell command. The unqualified
`/workflow review` and `/workflow discard` forms remain reserved for conversational creator
drafts.

`revise` copies an active workflow to a non-discoverable manual draft and records its immutable
base. `review` validates it, runs packaged mock tests, checks that base, and prints a semantic and
authority diff. `publish` repeats those gates, increments the revision, regenerates `SKILL.md`,
archives the old package, and atomically activates the replacement without running it. `discard`
removes only the manual draft; it never restores or modifies the active package. Stale-base
detection records identity hashes, not a restorable copy of the exact base package.

`dry-run` parses, applies defaults to, and validates inputs using the same rules as `run`. Values
that are available before execution are resolved into step previews; references to prior steps and
secrets remain explicitly unresolved.

The history list remains paged and compact. Supplying a run ID, or `latest`, inspects one run with
at most 50 steps. Each step shows its status, attempt count, duration, bounded output or error
summary, and up to 20 recorded attempts and model calls. Model-call details include provider,
requested and served model, finish reason, constrained-output status, token counts, and duration.
`--json` returns the corresponding structured run, step, attempt, and model-attempt records.

## Runtime state

- Runs and attempts are journaled in `.cleetus/workflows.db`.
- Project grants live in `.cleetus/workflow-grants.yaml`.
- Creator drafts live in `.cleetus/workflows/.drafts/`.
- Manual revision drafts live in `.cleetus/workflows/.manual-drafts/`.
- Replaced project workflows are archived under `.cleetus/workflows/.revisions/`.

Global workflows and grants use the Cleetus config directory instead of the project `.cleetus`
directory.

# Workflow troubleshooting

Start with the package and journal rather than recreating the workflow immediately.

## Diagnostic sequence

```text
/workflow show <name>
/workflow validate <name>
/workflow dry-run <name>
/workflow test <name>
/workflow history <name>
/workflow history <name> latest
```

Use the detailed history form after a failure to identify the exact failed or cancelled step. It
also shows retries and model-call authority without exposing complete prompts.

Use `/workflow status` when a creator draft is active or failed. Creator requirements and attempted
messages are persisted, so `/workflow retry` can retry the saved turn and `/workflow resume` can
recover the latest unfinished draft after restarting Cleetus.

For a new manual package, start from a validated skeleton:

```bash
cleetus workflow init <name>
```

### “workflow name must use lowercase letters”

Manual package names use lowercase letters and numbers separated by single hyphens, such as
`repository-brief`. Spaces, underscores, uppercase letters, leading or trailing hyphens, and
repeated hyphens are invalid.

### “workflow package already exists”

`cleetus workflow init` never overwrites an existing project or global package. Use a different
name. For changes to an existing package, follow the manual revision procedure instead of
reinitializing it.

## Creation and activation

### “The draft is not activatable”

The host found missing fields, invalid step configuration, bad references, undeclared authority,
or unresolved questions. Cleetus performs one automatic technical repair pass. If issues remain,
reply `retry`, describe a requirements change, or discard the draft.

Unresolved questions block activation even when a model incorrectly labels its response a draft.

### Cleetus asks another input-shape question before drafting

This is expected when ordinary language does not establish a schema boundary—for example, whether
`advantages` is one string or an array of strings, whether `constraints` has named fields or is an
open map, or what a critique model step must return. Fresh workflow creation now completes a
persisted requirements contract before generating executor steps. Answer the question in ordinary
language; you do not need to write JSON Schema. Restarting or using `/workflow retry` reuses the
saved contract.

### “Workflow already exists”

Activation never silently overwrites a package. Reply `replace` only after reviewing the complete
draft. Cleetus archives the previous package and activates the next revision.

### A creator call failed or was cancelled

Use:

```text
/workflow retry
```

The saved conversation is reused. You do not need to restate the workflow.

## Validation and inputs

### Unknown or missing input

Inputs are validated without type coercion. Check `inputs.required`, property names, types, and
defaults. Add `additionalProperties: false` when unknown properties should fail clearly.

The interactive TUI collects missing required inputs. Paste a JSON value when prompted for an array
or object, or supply every input as one JSON object on the command line:

```text
/workflow run report {"filters":["open","urgent"],"options":{"limit":20}}
```

For the CLI, `--inputs-json` is convenient for reusable complex values.

### A reference does not resolve

Only earlier step outputs are available. Use:

```text
$steps.<earlier-id>.output
$steps.<earlier-id>.output.<path>
```

Whole references preserve JSON types. `${...}` interpolation accepts scalars only. Do not use
`{{steps...}}`; double-brace syntax belongs only to `text.template@1`.

For HTTP steps, the decoded remote document is nested under `output.body`. A selector for the first
API result commonly looks like:

```yaml
value: $steps.fetch.output.body
pointer: /results/0
```

Cleetus uses RFC 6901 pointer semantics: `""` selects the supplied root while `/` selects a
property named by the empty string. To select the complete HTTP body, use
`value: $steps.fetch.output` with `pointer: /body`.

Cleetus rejects selectors that cannot match a known closed executor envelope. It cannot know
whether a live API body will actually contain `/results/0`, so cover that contract with an offline
mock test and retain a clear runtime failure for empty results.

When a missing path has a defined fallback, keep the workflow deterministic:

```yaml
uses: data.select@1
with:
  value: $steps.profile.output
  pointer: /total_private_repos
  default: Unavailable to this token
```

Do not add an LLM merely to supply a missing-pointer fallback. Creator repair feedback identifies
this case and directs the revision to `with.default`.

When an offline test fails, its diagnostic identifies the failed deterministic step and its error.
Output mismatches include bounded expected and received JSON. Multiline YAML strings are exact:
`|` preserves a final newline and `|-` removes it.

Fresh creator drafts express tests as structured data and Cleetus serializes the files, so YAML
indentation is not part of the model response. An invalid generated YAML fixture indicates a
persisted legacy full-package draft; use `/workflow retry` to invoke that draft's compatibility
repair. For a hand-authored `llm.generate@1` fixture, place the value matching `output_schema`
directly under the mock's `output` field.

If a Markdown fixture differs only by an extra blank line after an `each` block, remember that the
loop body is repeated exactly. Put the first repeated character directly after the opening tag:
`{{#each items}}- {{this}}\n{{/each}}`. A newline directly after the opening tag becomes a leading
newline for every item. Change `{{/each}}\n\n##` to `{{/each}}\n##` to leave one blank line before
the next heading. Fresh creator drafts receive precise repair feedback for a repeated leading
newline and must return the intended template and snapshot. Only persisted legacy full-package
drafts retain the narrow trailing-spacing correction; exact test comparisons are never relaxed.

Offline test files use a strict root schema. Supported keys are `schema_version`, `name`, `mode`,
`inputs`, `mocks`, and `expect`; fields such as `description` are rejected and named in the
diagnostic.

### “Input reference can be missing”

The workflow references an optional input path that has no default. Make that path required, or
declare defaults that cause it to be materialized before validation and execution. Do not rely on
an assumption or description that mentions a default; the default must exist in the input schema.

### “Named workflow input must be declared under inputs.properties”

The creator returned field names directly under `inputs` instead of a JSON Schema object. Fresh
creation rejects this at the structured response boundary. Retry should rebuild the schema with
`type: object`, named `properties`, an explicit `required` list, and
`additionalProperties: false`.

### “LLM prompt names an input that with.input does not pass”

The static prompt describes a top-level workflow input that the model cannot receive. Pass a
structured object containing the named `$inputs.<name>` value, or remove the behavior that depends
on it. Creator repairs must not solve optional-input validation by silently dropping requested
behavior.

### “Step output does not contain 'output'”

The workflow added an extra output-envelope segment, such as
`$steps.recommend.output.output`. A model step's structured value is already located at
`$steps.recommend.output`; use the whole result or select a field such as
`$steps.recommend.output.choice`.

### “Unsupported `{{...}}` syntax” in an authorization header

Use `Bearer ${secrets.github_token}`. The `${{ secrets.github_token }}` form belongs to GitHub
Actions and is not part of workflow reference syntax. Fresh creator drafts reject this form and
request a complete corrected blueprint. Only persisted legacy full-package drafts retain the
historical unambiguous normalization.

Offline tests for secret-backed HTTP steps use a synthetic sensitive placeholder. They do not
require the environment variable and never perform the HTTP request. A live run still requires the
declared environment secret during preflight.

## Permission and trust failures

### “No exact-revision grant”

Noninteractive CLI runs cannot prompt. Run interactively and choose **trust exact revision**, or
provide authorization through the host integration.

### A previously trusted workflow prompts again

The execution hash changed. Common causes are edits to:

- `workflow.yaml`
- A referenced prompt under `prompts/`
- A referenced script under `scripts/`

Tests and generated descriptive content do not normally change execution authority.

Use **allow once** after any change. Trust the new execution only after verifying the result.

### Permission validation fails

The declared permission envelope does not cover a statically known step. Ensure:

- HTTP hosts and methods are declared.
- Commands and argument prefixes are declared.
- Filesystem read/write patterns cover the requested paths.
- `permissions.model` is `true` when an LLM step exists.

Runtime redirects and resolved command paths are checked again even after validation.

## HTTP failures

`http.request@1` distinguishes connection errors, timeouts, HTTP 429, HTTP 5xx, unexpected status,
unexpected content type, and invalid JSON.

Only declare retries the method can safely repeat. GET and HEAD are retryable. Mutating methods
need an idempotency key or an explicit unsafe-retry acknowledgement.

The HTTP response body is under:

```text
$steps.<id>.output.body
```

The complete output also includes `status`, `content_type`, and `final_url`.

Use `with.query` instead of manually assembling a URL when values come from inputs or earlier
steps. Dry-run shows ordinary query parameters and unresolved placeholders while redacting
credential-shaped values.

## Model failures

### Model call timed out

The error names the step and timeout. `llm.generate@1` defaults to two minutes when the step omits
`timeout`. The workflow timeout must leave enough time for every step and repair attempt.

Local reasoning models may need more time than non-reasoning models. Avoid short explicit
deadlines unless they are a real requirement.

### Model output was truncated

An explicit `max_output_tokens` is a hard ceiling and may include hidden reasoning tokens. Raise or
remove it through a workflow revision.

When `max_output_tokens` is omitted, Cleetus does not silently impose its own token cap; it leaves
the provider budget unset. If the provider still reports truncation, set a higher explicit cap or
adjust the provider/model configuration.

### Model output is not valid JSON

`llm.generate@1` requires structured output. Cleetus recovers common fenced, reasoning-channel, and
provider-envelope forms, including a schema-valid value stringified inside a provider wrapper,
then performs the configured bounded repair attempt. The repair call receives the invalid value
and explicit output schema. Ambiguous or incomplete values still fail.

Keep prompts explicit about the requested value and keep `output_schema` as narrow as the result
allows.

### Model output failed schema validation

The output parsed as JSON but did not match `output_schema`. The error includes validation paths
and a non-sensitive shape summary after repair exhaustion.

Prefer a stable object-root contract for LLM results:

```yaml
output_schema:
  type: object
  additionalProperties: false
  required: [bullets]
  properties:
    bullets:
      type: array
      minItems: 4
      maxItems: 4
      items:
        type: string
```

Select `.bullets` in a later output or template. Object-root schemas are more portable across
constrained-decoding providers than a bare root array.

### The summary makes unsupported claims

The model receives only the fields passed through `with.input`. Make the prompt name those fields
and explicitly prohibit claims about absent measurements. Fetch additional fields when the desired
summary is broader than the available data.

## Commands and scripts

### A packaged script is rejected

JavaScript and TypeScript package scripts must use:

```yaml
program: bun
args: [run, ./scripts/task.ts]
```

The path must remain inside the package. `cwd` must remain inside the workflow workspace.

### Command output is not valid JSON

When `output: json`, stdout must be exactly one JSON value. Logs should go to stderr or be disabled
for that invocation.

## Output presentation

`presentation.output` selects one named output:

- Strings render as sanitized Markdown in the interactive transcript.
- Nonempty string arrays render as Markdown bullets.
- Objects and other arrays render as formatted JSON.
- `--json` returns the full structured envelope.

The Markdown renderer supports terminal-safe headings, paragraphs, emphasis, lists, blockquotes,
code blocks, tables, and links. Terminal escape and control sequences are removed before parsing.

If human-facing formatting is important, keep a structured output for downstream use and add a
deterministic `text.template@1` step for presentation.

## Hand-edited package problems

Prefer an isolated manual revision:

```bash
cleetus workflow revise <name>
# Edit the printed draft directory.
cleetus workflow review <name>
cleetus workflow publish <name>
```

Publish regenerates `SKILL.md`, assigns the revision, archives the active package, and never runs
the workflow. Direct active-package edits can leave `SKILL.md` or the numeric revision stale and
bypass archival and review.

### Manual publish says the base is stale

The active package changed after `workflow revise` recorded its base. Cleetus will not silently
merge or overwrite that change. `workflow discard <name>` removes only the isolated draft; it does
not undo the active-package change.

If the active change is intentional, save any draft-only edits you need, discard the stale draft,
start a new revision against the current active package, and reapply those edits. If the active
change is accidental, restore the active files from source control or another known-good copy
before restarting. Cleetus currently detects this condition using hashes but does not retain the
exact base package or provide an active-package restore command.

### Manual review passes but publish fails

Publish deliberately repeats validation, offline tests, and stale-base checks. A file may have
changed between review and publish. Run `workflow review <name>` again and address its current
result. Publishing is also blocked when the draft contains no publishable changes.

## Revision problems

### A revision operation is rejected

New revisions use typed operations against the active package. The error names the operation ID
and invalid target. Common causes are duplicate operations for the same field, inserting a step
without placement, deleting a resource that does not exist, or using a path outside `prompts/`,
`scripts/`, or `tests/`.

Describe the desired behavior in ordinary language and let the creator return a corrected complete
change set. A repair starts again from the immutable base; it does not patch the failed candidate.
If repeated repair attempts remain invalid, `/workflow retry` rebases the creator conversation onto
the immutable base and your original requirements. Rejected assistant proposals and their
validation payloads are excluded so an earlier bad design does not keep influencing the next
candidate.

Cleetus also rejects near-match entity targets such as changing `_` to `-` when that would create a
new output instead of updating the existing one. Deterministic line numbering and list formatting
cannot introduce a new model step unless the request explicitly calls for model behavior.

### Replacement says the active package changed

The workflow was edited or replaced after revision authoring began. Cleetus will not silently
rebase or overwrite that newer package. Discard the stale draft, inspect the current workflow, and
start the revision again.

### The semantic diff shows an unexpected change

Do not activate it. Describe what should remain unchanged. Every material change must have an
owning operation, and the next repair is rebuilt from the original active base. Authority,
interfaces, execution policy, steps, resources, tests, and deterministic risk flags are computed
by the host rather than supplied by the model.

## Interrupted runs

On startup, Cleetus marks previously running work as interrupted and active steps as indeterminate.
User-facing resume for partially executed workflows is not supported in V1. Inspect history and
start a new run only after deciding whether any side effect may already have occurred.

# Authoring and updating workflows

This guide covers the conversational workflow lifecycle, a complete package example, offline
tests, and safe updates. Authors writing packages directly should use
[Manually authoring workflows](manual-authoring.md).

## Choose the scope

Project workflows live with one project and override same-named global workflows:

```text
.cleetus/workflows/<name>/
```

Global workflows are available across projects:

```text
~/.config/cleetus/workflows/<name>/
```

Creation defaults to project scope. Use `--global` only when the workflow should be reusable across
unrelated projects:

```text
/workflow create --global daily-brief
```

## Conversational authoring

Start with as much user-facing intent as you already know:

```text
/workflow create weather
```

Then describe the outcome, not internal DSL fields:

```text
Fetch the hourly temperature forecast for a supplied latitude and longitude, then return four
grounded summary bullets. Use Open-Meteo and do not make claims about weather measurements that
were not fetched.
```

The creator should infer routine implementation details and ask only questions that change input
schemas, permissions, side effects, secrets, or the step graph.

For a new workflow, creation has two stages. First, Cleetus builds and persists a requirements
contract covering the purpose, desired result, complete input shapes, external actions, secrets,
presentation, and the distinct output shape of each model step. Unknown field types, arrays without
an item type, and objects without named fields or an explicit open-map value type (including
arbitrary JSON when intended) keep the conversation in the questions phase. Cleetus does not
request an executable blueprint until that contract is complete.

Second, the conversation produces a typed creation blueprint rather than writing package files
directly. The blueprint declares the pinned executor steps, typed references, named outputs,
presentation choice, structured offline tests, and any packaged prompts or scripts. Cleetus checks
the blueprint against the approved requirements contract, derives the permissions implied by the
steps, writes the package, and then validates the compiled result before showing it for review. A
blueprint cannot silently change a contracted input or model-output field type. Test cases are
structured data in the blueprint; the host serializes them under `tests/` so generated YAML
indentation is not part of the model contract.

If generation or compilation fails, the automatic repair and `/workflow retry` start from the
saved requirement transcript, persisted requirements contract, and bounded host diagnostics. A
rejected candidate is not used as a patch base. This is why requirements survive a restart while
malformed implementation details do not accumulate across retries.

When the name already identifies an active workflow, a name-only create command opens a revision
interview instead of generating immediately. Cleetus loads the active definition and latest run as
background context, then asks what you want changed. The creator model is not called until you
answer that question, so a recorded failure cannot silently choose between removing behavior,
adding a fallback, or expanding authority.

The active manifest, package identity, and all packaged tests, prompts, and scripts become an
immutable revision base. The creator returns typed operations against that base instead of
regenerating the package. Every repair attempt replaces the complete change set and is reapplied
from the same base, so failed candidates cannot accumulate drift.

Omitted fields and resources are preserved. Removing a step, output, secret, prompt, script, or
test requires an explicit remove or delete operation. Run history does not authorize unrelated
changes.

The review is a draft. `activate` saves it but does not run it. If the name already exists, Cleetus
requires `replace`, archives the old package, and assigns the next revision. As soon as a valid
replacement draft is ready for review, an attempted run of that workflow name is blocked and the
draft is preserved. The active revision remains available while requirements are incomplete,
generation is in progress, or the draft is invalid. The block continues until `replace` or
`cancel`. Other workflows and inspection commands remain available.

## Complete example

The following package exposes location and coordinates as inputs, fetches JSON, asks the inherited
model for a typed object, and renders deterministic Markdown.

```yaml
schema_version: 1
name: weather
revision: 1
description: Fetch and summarize the hourly temperature forecast.

inputs:
  type: object
  additionalProperties: false
  properties:
    location:
      type: string
      minLength: 1
      default: Wilmette, IL
    latitude:
      type: number
      minimum: -90
      maximum: 90
      default: 42.07225
    longitude:
      type: number
      minimum: -180
      maximum: 180
      default: -87.72284

secrets: {}

permissions:
  network:
    - host: api.open-meteo.com
      methods: [GET]
  model: true

execution:
  timeout: 5m

steps:
  - id: fetch
    uses: http.request@1
    timeout: 30s
    retry:
      attempts: 2
      backoff:
        initial: 500ms
        multiplier: 2
        maximum: 5s
      when: [timeout, connection_error, http_429, http_5xx]
    with:
      url: https://api.open-meteo.com/v1/forecast
      method: GET
      query:
        latitude: $inputs.latitude
        longitude: $inputs.longitude
        hourly: temperature_2m
        temperature_unit: fahrenheit
      expected_status: [200]
      expected_content_type: application/json
      response: json

  - id: summarize
    uses: llm.generate@1
    with:
      prompt: >-
        Summarize the supplied hourly temperature data for the named location.
        Return exactly four concise bullets. Make claims only about fields present
        in the data.
      input:
        location: $inputs.location
        forecast: $steps.fetch.output.body
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

  - id: render
    uses: text.template@1
    with:
      template: "{{#each bullets}}- {{this}}\n{{/each}}"
      data: $steps.summarize.output

outputs:
  bullets:
    value: $steps.summarize.output.bullets
    schema:
      type: array
      minItems: 4
      maxItems: 4
      items:
        type: string
  markdown:
    value: $steps.render.output
    schema:
      type: string

presentation:
  output: markdown
```

Omitting `provider`, `model`, and `max_output_tokens` from `llm.generate@1` inherits the active
workflow model and the provider's output budget. Add an explicit cap only when the workflow
requires a hard ceiling.

## Review before activation

Review these aspects independently:

- Inputs, defaults, and rejected unknown properties.
- Ordered steps and every cross-step reference.
- Network hosts, command programs, filesystem paths, and model access.
- Side effects and retry safety.
- Secrets and any explicit LLM exposure.
- Step and workflow timeouts.
- Named structured outputs and the selected presentation output.

Activation and execution are separate on purpose. A valid package can still do the wrong thing, so
run a dry run before granting authority.

## Validate, test, and dry-run

Validate syntax, schemas, references, step configuration, timeouts, retries, and permissions:

```text
/workflow validate weather
```

Validation also rejects `data.select` paths that cannot exist in a known executor output envelope.
For example, an HTTP API payload is under `$steps.fetch.output.body`, not directly under
`$steps.fetch.output`. Validation cannot prove the shape of an open-ended remote response body.

Inspect the normalized plan without performing network, command, filesystem, or model work:

```text
/workflow dry-run weather
```

Run package tests with external steps replaced by declared mocks:

```text
/workflow test weather
```

### Offline test example

Place tests in `tests/*.yaml` inside the workflow package:

```yaml
schema_version: 1
name: renders four weather bullets
mode: mock
inputs:
  location: Wilmette, IL
  latitude: 42.07225
  longitude: -87.72284
mocks:
  fetch:
    output:
      status: 200
      content_type: application/json
      final_url: https://api.open-meteo.com/v1/forecast
      body:
        hourly:
          temperature_2m: [66, 72, 79]
  summarize:
    output:
      bullets:
        - Cool morning.
        - Warmer afternoon.
        - Temperatures peak near 79°F.
        - Only temperature was evaluated.
expect:
  status: succeeded
  outputs:
    bullets:
      - Cool morning.
      - Warmer afternoon.
      - Temperatures peak near 79°F.
      - Only temperature was evaluated.
    markdown: |
      - Cool morning.
      - Warmer afternoon.
      - Temperatures peak near 79°F.
      - Only temperature was evaluated.
  attempts:
    fetch: 1
    summarize: 1
    render: 1
```

Tests are offline by design. Every `http.request`, `llm.generate`, and `command.run` step needs a
mock. The creator is instructed to include at least one complete offline case whenever a draft has
external steps. A command mock verifies workflow wiring and presentation but does not execute or
prove the semantics of a packaged script. Inspect generated scripts and use **allow once** for the
first live run. Live integration tests are not supported in V1.

## Updating an existing workflow

Use the normal creator entry point with the existing name:

```text
/workflow create weather
```

Cleetus uses the active package as the base. When the latest failed run belongs to an archived
revision, it can use that archived definition as diagnostic context. Requirements and working
behavior remain unchanged unless your revision request explicitly asks to correct that failure.
Existing tests and packaged resources are carried into the draft and do not need to be regenerated.

After review:

1. Reply `activate`.
2. Reply `replace` when Cleetus reports the name already exists.
3. Run `validate`, `test`, and `dry-run`.
4. Use **allow once** for the first real run.
5. Trust the execution only after verifying the result.

The current command is named `create` for both creation and revision. A dedicated `revise` command
remains a possible UX improvement.

Revision review shows the proposed operations and a host-computed semantic diff. It calls out
authority additions and removals, interfaces, execution policy, step-graph changes, resources,
tests, deterministic risk flags, and validation status. A material change without an owning
operation blocks activation.

If the active package changes after revision authoring begins, replacement is rejected as stale.
`workflow discard` removes only the isolated draft and never reverses an active-package edit. Keep
intentional active edits by reopening the revision against the current package. Restore accidental
active edits from source control or another known-good copy before restarting; Cleetus does not
currently retain a restorable snapshot of that exact base package.

## Hand editing

`workflow.yaml` and referenced prompt/script files are ordinary text files, so experienced authors
can edit them directly. Start a new package with `cleetus workflow init <name>`. For an existing
package, use `cleetus workflow revise <name>`, edit the isolated directory it prints, then run
`cleetus workflow review <name>` and `cleetus workflow publish <name>`.

These are standalone shell commands, not interactive `/workflow` slash commands. Run them in
another terminal or exit Cleetus first. If entered at the `cleetus>` prompt, Cleetus prints the
corresponding shell command instead of changing either the active package or a creator draft.

Managed review validates the package, executes its offline mocks, and displays semantic,
authority, and risk changes. Publish repeats the checks, rejects a stale base, assigns the next
revision, archives the old package, regenerates `SKILL.md`, and activates without running.

Editing the active package in place remains supported but bypasses those safeguards. If you
deliberately do that, increment the revision, keep permissions and `SKILL.md` synchronized, run
`validate`, `test`, and `dry-run`, then use **allow once** and inspect the result.

The trust prompt authorizes the execution hash and permissions. It is not an endorsement of the
edit's semantics.

The [manual-authoring guide](manual-authoring.md) documents every package file, supported value
type and executor field, offline test shape, source-control boundary, and the managed-draft
lifecycle.

## Runtime prompts and scripts

Large LLM prompts can live under `prompts/` and be referenced by setting `prompt` to a path such as
`./prompts/summarize.md`.

Packaged JavaScript and TypeScript live under `scripts/` and run through `command.run@1` with:

```yaml
with:
  program: bun
  args: [run, ./scripts/normalize.ts]
  stdin: $steps.fetch.output.body
  output: json
```

Packaged JavaScript and TypeScript must use `bun run`. Referenced runtime prompt and script content
participates in the execution hash, so changing it invalidates prior exact-execution grants.

## Secrets

Declare environment-backed secrets separately from inputs:

```yaml
secrets:
  weather_api_key:
    source: env
    name: WEATHER_API_KEY
```

Reference them with `$secrets.weather_api_key`. Secret values resolve only at execution time and
are excluded from normal persistence and output.

LLM access is denied by default. Explicitly list each step allowed to receive a secret:

```yaml
secrets:
  private_context:
    source: env
    name: PRIVATE_CONTEXT
    expose_to_llm: [summarize]
```

Only expose secrets to a model when that exposure is part of the intended workflow contract.

# Evaluation scenarios

This directory contains tasks used by `cleetus eval` and `cleetus improve`. Each immediate
subdirectory is one scenario; its directory name is the scenario name.

`hello-file` is intentionally small. It is a smoke test for the evaluation plumbing: the
agent receives a prompt, works in an isolated directory, and passes when a deterministic
shell check exits with status `0`. It is an example, not a representative benchmark of
real coding ability.

## Scenario layout

```text
scenarios/
  my-scenario/
    scenario.yaml
    fixture/          # optional
      ...
```

`scenario.yaml` supports these fields:

```yaml
prompt: Fix the bug described in README.md.
check: bun test
check_timeout_ms: 60000   # optional; default: 60 seconds
agent_timeout_ms: 300000  # optional; default: 5 minutes
```

- `prompt` is the task given to the agent and is required.
- `check` is run after the agent finishes. Exit status `0` means the scenario passed; any
  other status means it failed.
- `check_timeout_ms` limits the check command.
- `agent_timeout_ms` limits the agent run.

Both timeouts are expressed in milliseconds.

If `fixture/` exists, its contents are copied into a fresh temporary working directory for
each candidate and trial. Without a fixture, the working directory starts empty. The agent
and the check operate on that same temporary copy, which is removed after the run. The
original fixture is not modified.

## Adding a scenario

1. Create `scenarios/<name>/scenario.yaml`.
2. Put any starting repository or files under `scenarios/<name>/fixture/`.
3. Write a focused prompt that states the desired outcome without prescribing an
   implementation unnecessarily.
4. Write a deterministic `check` that verifies the complete outcome.
5. Run the scenario several times before using it to compare candidates.

For example:

```text
scenarios/fix-total/
  scenario.yaml
  fixture/
    package.json
    src/total.ts
    tests/total.test.ts
```

```yaml
prompt: Fix the total calculation. Preserve the public API and make the test suite pass.
check: bun test
check_timeout_ms: 120000
```

The configured Docker image must contain every runtime and command used by the fixture and
the check. Keep checks non-interactive and avoid depending on network access, wall-clock
time, or mutable external services.

Good checks test observable behavior rather than the agent's chosen implementation. When
checking exact file contents, verify details that shell command substitution can hide. For
example, this rejects a trailing newline as well as incorrect text:

```yaml
prompt: Create hello.txt containing exactly the five bytes in the word world.
check: test "$(cat hello.txt)" = world && test "$(wc -c < hello.txt)" -eq 5
```

Avoid placing secrets in fixtures or prompts. Treat fixture contents as visible to the
agent, so they should not contain hidden answers that would make the task trivial to game.

## Running scenarios

Evaluation runs are unattended and require Docker plus an explicit image in
`.cleetus/config.yaml`:

```yaml
sandbox:
  backend: docker
  image: oven/bun:1
```

From this repository, run one scenario against the baseline agent:

```sh
bun run src/bin/cleetus.ts eval --scenario hello-file
```

Run every scenario:

```sh
bun run src/bin/cleetus.ts eval
```

Repeat each candidate/scenario pairing to reduce one-run noise:

```sh
bun run src/bin/cleetus.ts eval --trials 3
```

Installed binaries use the equivalent `cleetus eval` commands. The CLI also supports
`--json`, repeatable `--scenario` and `--candidate` filters, and alternate
`--scenarios-dir` and `--candidates-dir` paths.

`cleetus improve` consumes the same scenarios when comparing proposed instruction
variants. Start without `--apply` so you can inspect the winning candidate and diff;
`--apply` updates `.cleetus/instructions.md`.

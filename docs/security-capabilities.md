# Evidence and security capability roadmap

Cleetus's security persona establishes an evidence-first working style. The reusable runtime
capabilities below make evidence and conclusions machine-checkable without turning Cleetus into a
security operations product. Product clients remain responsible for artifact storage, scanner
lifecycle, authorization policy, retention, and team workflows.

## Delivery order

| Phase | Capability | Status |
|---|---|---|
| 1 | Versioned evidence-bundle and finding contracts | Implemented |
| 1 | ACP evidence-bundle input through embedded resources | Implemented |
| 2 | Structured finding output and ACP client updates | Implemented |
| 3 | Bounded client-managed job lifecycle | Implemented |
| 3 | Session-load security-state reattachment | Implemented |
| 4 | Effect-, target-, and budget-aware job authorization | Implemented |
| 5 | Scanner-result normalization adapters | Partial: SARIF, CycloneDX, OSV-Scanner, and passive ZAP JSON implemented |

An implemented contract is not an implemented scanner or case store. In particular, Cleetus does
not currently persist evidence bundles as product cases, resolve opaque artifact URIs, or bundle
scanner-specific runners.

## Evidence bundles

`src/evidence/contracts.ts` defines schema version 1. A bundle contains one to 128 metadata items.
Each item has a stable ID, kind, URI, provenance, redaction state, and optional digest, media type,
size, and observation time. Artifact bodies remain owned by the client or backing integration.

ACP clients can attach a textual JSON resource with this media type:

```text
application/vnd.commoncosmo.cleetus-evidence-bundle+json
```

Example:

```json
{
  "schemaVersion": 1,
  "bundleId": "case-42",
  "title": "Suspicious requests",
  "items": [
    {
      "id": "access-log",
      "kind": "web_server_log",
      "uri": "ccsec://cases/42/access.jsonl",
      "mimeType": "application/x-ndjson",
      "digest": {
        "algorithm": "sha256",
        "value": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      "redaction": "applied",
      "provenance": {
        "source": "nginx export",
        "collectedAt": "2026-09-21T17:00:00-05:00",
        "tool": "ccsec-import",
        "toolVersion": "0.1.0"
      }
    }
  ]
}
```

Cleetus validates the resource before adding it to user context. A valid bundle is rendered as
bounded metadata with `[evidence:<id>]` citation handles. Invalid bundles are rejected without
injecting their raw body. The media type uses ACP's existing embedded-resource surface; no
proprietary ACP session-update discriminator is introduced.

Validated bundles are registered for the active ACP session. Re-sending an identical bundle is
idempotent; attempting to reuse a bundle ID for different metadata is rejected. Registries are
session-isolated and connection-local. A client can supply bundles again through prompt content or
reattach its validated manifests through the `session/load` extension described below.

The URI is an opaque identity at this stage. Cleetus does not dereference it. A client that wants
the model to inspect content must also supply that content through a supported ACP resource or a
separately permissioned integration.

## Finding sets

Schema version 1 supports confirmed, hypothetical, not-established, and refuted findings. It
captures severity, confidence, evidence references with optional locators, affected artifacts,
preconditions, impact, remediation, verification, and residual risk.

Confirmed and refuted findings require evidence. Cross-document validation verifies the bundle ID
and every referenced evidence ID.

In ACP sessions, the `record_findings` tool accepts a finding set only after its evidence bundle has
been registered in that same session. It is allowed by default because it performs no external
action and is available to small-capability models. The security persona directs the model to use
it when the client supplied evidence and the user requested structured findings or an
investigation.

Successful results use an ordinary ACP `tool_call_update`: readable summary text is placed in
`content`, and the complete validated finding set is placed in the standard `rawOutput` field. This
keeps strict ACP v1 clients compatible and lets clients such as ccsec consume the structured value
without parsing prose. The normal Cleetus event log retains the tool result, but this is not a
product case store, retention policy, or session-resume API for findings.

## Client-managed jobs

ACP clients can opt into a versioned, namespaced job extension by advertising supported job kinds
in `clientCapabilities._meta`:

```json
{
  "commoncosmo.com": {
    "cleetus": {
      "jobs": {
        "version": 1,
        "kinds": ["sast.semgrep", "dast.zap-passive"],
        "maxArtifactReadBytes": 65536
      }
    }
  }
}
```

Only then does Cleetus register `job_start`, `job_status`, `job_cancel`, `job_artifact_read`, and
`job_artifact_normalize`. The client owns execution and artifact storage; Cleetus calls the
following ACP extension methods, all of which use the required extension-method prefix:

```text
_commoncosmo.com/cleetus/jobs/start
_commoncosmo.com/cleetus/jobs/status
_commoncosmo.com/cleetus/jobs/cancel
_commoncosmo.com/cleetus/jobs/artifact/read
```

Every start declares one advertised kind, an effect class (`read`, `passive_network`,
`active_network`, or `write`), explicit timeout and output/artifact budgets, an opaque target for
every non-read job (optional for read jobs), optional parameters, and optional references to
evidence already registered in the same session. Job starts require permission and are blocked in
plan mode. Status reads, cancellation, artifact reads, and artifact normalization are allowed only
for job IDs owned by that session; cancellation is allowed by default as a safety action but
remains blocked in plan mode.

Status responses carry a bounded artifact manifest and are returned through ordinary ACP tool
updates with validated `rawOutput`. Artifact reads are UTF-8 text chunks, limited by both the
client-advertised bound and Cleetus's 64 KiB ceiling. Identity, offset progression, advertised
artifact size, and returned byte count are checked before untrusted artifact text enters model
context.

Artifact normalization uses that same bounded read method internally, but returns only the
validated finding set. The raw artifact body is not placed in the model-visible tool result or the
tool's durable arguments.

This surface is a bridge, not a runner. A product such as ccsec still needs to implement the four
client handlers, map advertised kinds to approved scanner adapters, enforce the declared effect and
target, retain artifacts, and return the versioned status/chunk contracts.

## Session security-state reattachment

Cleetus advertises `securityStateReattachment: 1` under
`agentCapabilities._meta["commoncosmo.com"].cleetus`. An ACP client that owns durable security state
can reattach validated manifests while loading a conversation by adding this namespaced extension
to `session/load`:

```json
{
  "sessionId": "01J...",
  "cwd": "/project",
  "_meta": {
    "commoncosmo.com": {
      "cleetus": {
        "securityState": {
          "schemaVersion": 1,
          "evidenceBundles": [],
          "findingSets": [],
          "jobs": [
            {
              "spec": { "schemaVersion": 1, "kind": "dast.zap-passive", "effect": "passive_network", "target": "https://staging.example.test", "inputEvidenceIds": [], "parameters": {}, "limits": { "timeoutMs": 60000, "maxOutputBytes": 1048576, "maxArtifactBytes": 2097152 } },
              "status": { "schemaVersion": 1, "jobId": "job-1", "kind": "dast.zap-passive", "status": "running", "artifacts": [] }
            }
          ]
        }
      }
    }
  }
}
```

The version 1 manifest is capped at 8 MiB and accepts at most 64 evidence bundles, 128 finding sets,
and 128 jobs. Cleetus validates the complete manifest before changing either registry. It rejects
duplicate or changed immutable IDs, invalid finding references, job kinds the client did not
advertise, mismatched job spec/status kinds, missing job evidence, artifact totals above the
declared budget, and persisted artifacts without SHA-256 identity. Reattaching the same state is
idempotent; an existing job may report newer status and artifact metadata only under its original
specification.

On success, the `session/load` result contains a namespaced count of the reattached bundles,
finding sets, and jobs. Artifact bodies remain in client storage and are still fetched only through
the bounded artifact-read method. Permission grants are intentionally excluded: session-only
approvals expire with the ACP connection, and persisted deny rules continue to load normally.

## Client MCP connection acknowledgement

When `session/load` includes a non-empty `mcpServers` array, Cleetus returns the connection
outcome for that request in `result._meta["commoncosmo.com"].cleetus.clientMcp`:

```json
{
  "version": 1,
  "servers": [
    {
      "name": "ccsec-investigations",
      "state": "connected",
      "toolCount": 5,
      "toolNames": ["mcp__ccsec-investigations__ccsec_investigations"]
    }
  ]
}
```

The example abbreviates `toolNames`; the actual response lists every discovered tool. A failed
server has `state: "failed"` and an `error`. A declaration filtered because its name conflicts
with a Cleetus-configured server is absent from `servers`. Clients that require a particular MCP
server should verify its connected status and expected tools before prompting. This acknowledgement
reports connection outcome; it does not make MCP tools session-private. Cleetus currently registers
client MCP tools in a process-wide registry, so products requiring per-session data isolation must
use a separate ACP process for each session.

## Job authorization policy

Before permission resolution, `job_start` produces structured authorization metadata containing
the job kind, effect, optional target, and all three budgets. The runtime includes that metadata in
durable permission request and decision events. Network and write jobs must declare a non-empty
target; malformed or missing job authority fails closed in the ACP permission resolver.

Project and global `permissions.yaml` rules can constrain job starts independently of their
human-readable summary:

```yaml
rules:
  - tool: job_start
    job_kind: "dast.*"
    job_effect: active_network
    job_target_pattern: "https://prod.*"
    max_timeout_ms: 300000
    max_output_bytes: 1048576
    max_artifact_bytes: 10485760
    decision: deny
```

`job_kind` and `job_target_pattern` are exact matches unless they end in `*`, which means prefix
match. A budget-constrained rule matches only requests at or below every specified ceiling. Normal
permission precedence still applies: a deny beats another matching rule in the same layer, and the
project layer takes precedence over the global layer.

For ACP, persisted matching denies short-circuit before the client is asked. The ACP client remains
the consent surface for allows. Read and passive-network jobs offer a session-only scoped approval:
later jobs must use the same kind, effect, and target and may not exceed the approved budgets.
Active-network and write jobs never offer that reusable approval and require a fresh allow-once
decision for every start. A client response attempting to invent a broader option is rejected.

## Scanner-result normalization

When the client-managed job extension is active, ACP sessions expose `job_artifact_normalize`, a
deterministic, no-external-effect adapter for a session-owned artifact. The model supplies only job,
artifact, bundle, evidence, and format identifiers; raw scanner output does not pass through model
context or durable tool arguments. The owned artifact and registered evidence item must carry the
same SHA-256, and Cleetus verifies the complete body against it before parsing. The resulting
finding set cites the raw evidence item with JSON Pointers and is returned through the same
standard ACP `rawOutput` path as `record_findings`. The agent advertises the available adapters as
`sarifNormalization: 1`, `cycloneDxNormalization: 1`, `osvNormalization: 1`, and
`zapPassiveNormalization: 1` under `agentCapabilities._meta["commoncosmo.com"].cleetus`.

The adapter:

- accepts at most 2 MiB of UTF-8 JSON and 128 client read chunks for every format, and rejects the
  whole input rather than returning a partial finding set;
- requires matching artifact and evidence SHA-256 values, then verifies the complete retrieved
  content before normalization;
- creates stable finding IDs from producer identities and stable finding-set IDs from normalized
  content;
- accepts at most 256 normalized findings and preserves a JSON Pointer back to every contributing
  raw result.

Format-specific behavior:

- SARIF 2.1.0 accepts at most 64 runs and 256 results. It preserves physical and logical locations,
  fingerprints, rule help or fix text, `security-severity`, result level, precision, and producer
  suppressions.
- CycloneDX JSON 1.4–1.7 accepts at most 4,096 nested components, 256 vulnerability objects, and 64
  affected component references per vulnerability. It resolves component identities, selects the
  highest published rating, preserves recommendations and VEX analysis state, and maps
  `not_affected`, `false_positive`, and resolved states to not established rather than confirmed.
- Native OSV-Scanner JSON accepts at most 64 scan results, 256 packages, 256 vulnerability records,
  256 vulnerability groups, and 64 aliases per group. It consolidates alias groups, preserves
  package and source identity, uses the scanner's maximum severity when supplied, derives fixed
  versions from OSV ranges, and uses call analysis to raise confidence or mark an unobserved path
  as not established.
- OWASP ZAP traditional JSON accepts at most 32 sites, 256 alerts, 64 instances per alert, and
  1,024 instances overall. The `zap-passive` format is accepted only for an owned
  `dast.zap-passive` job authorized with effect `passive_network`. It maps ZAP risk and confidence,
  endpoint/method/parameter identity, systemic state, descriptions, solutions, and CWE references.
  Request attack strings and response evidence stay only in the raw artifact; normalized findings
  cite their instance JSON Pointers instead of copying those values into model-visible output.

Normalization never upgrades a scanner observation to a confirmed vulnerability. Reachability,
exploitability, runtime context, and threat-model impact still require analysis. Raw scanner bodies
remain client-owned evidence; Cleetus stores the validated normalized finding set, not another raw
copy in its tool-call history. The SARIF adapter currently handles inline result messages and
driver rules. OSV support targets the stable native OSV-Scanner JSON report rather than arbitrary
OSV API batch responses or standalone advisory records. ZAP's traditional report does not itself
prove that every alert originated from a passive scanner, so the client runner must enforce the
declared passive-only job; Cleetus records that declaration as a precondition, not as proof.
SARIF message catalogs, deeper code-flow normalization, active DAST, and additional DAST formats
remain future work.

## Design boundaries

- Evidence and tool output are data, never instructions or proof of safety.
- A persona recommends; host permissions and sandboxes enforce.
- Clients own opaque artifact storage and product state. They should not import Cleetus internals
  or inspect its private session database.
- Raw scanner output should be retained alongside normalized results so a conclusion remains
  auditable.
- Cleetus authorization covers declared intent. Clients must still verify that a runner actually
  honors its declared target, effect, and budgets; model or client approval is not proof of that.

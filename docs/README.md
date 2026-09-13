# Cleetus documentation

Cleetus is a local coding agent with explicit tools, reusable skills, strict workflows, multiple
model providers, and terminal, CLI, and ACP surfaces. This directory contains maintained user,
reference, and contributor documentation.

## User guides

- [Workflows](workflows.md) — create and run repeatable, schema-validated pipelines with explicit
  permissions.
- [Skills](skills.md) — install and author reusable model-directed playbooks.
- [Editing files from Cleetus](editor.md) — hand the interactive terminal to `$EDITOR` or
  `$VISUAL`, with compatibility profiles and a smoke harness.
- [Inference providers](providers.md) — connect llama.cpp, LM Studio, or Ollama and understand
  provider-specific discovery, context, tool-template, and embedding behavior.
- [Evaluation scenarios](../scenarios/README.md) — add repeatable fixtures and scoring rules for
  `cleetus eval` and `cleetus improve`.
- [Main README](../README.md) — installation, configuration, commands, providers, sandboxing, and
  the complete feature overview.

## Workflow documentation

- [Workflow overview](workflows.md)
- [Authoring and updating workflows](workflows/authoring.md)
- [Manually authoring workflows](workflows/manual-authoring.md)
- [Workflow manifest and runtime reference](workflows/reference.md)
- [Workflow troubleshooting](workflows/troubleshooting.md)

## Project documentation

- [Release process](releasing.md)

The user guides describe supported behavior. Current source and tests are authoritative when a
document requires correction.

# Public release checklist

The following decisions are intentionally deferred but should be revisited before making the
repository public.

## Git history and contributor provenance

- [ ] **PUB-D01: Resolve the MurphyDurphy contributions.** Decide whether to retain the four
  commits below after confirming their provenance and licensing, or replace their small changes
  with independently authored equivalents:

  - `3b86a9e` — Add new phrases to busy messages
  - `df99def` — Add new phrases to busy phrases array
  - `3a4bbdb` — Add new phrase to busy messages
  - `c995a59` — Add more backwoods phrases to busy.ts

- [ ] **PUB-D02: Publish from a clean history.** Build the public repository from the reviewed
  source candidate, with only intended contributor identities. Do not publish the original
  repository history or use a `.mailmap` as a substitute for clean commit metadata.

Both choices can require rewriting Git history, which changes commit IDs and requires coordinated
replacement of the remote history. Handle them together if a rewrite is chosen.

## Release validation and contributor infrastructure

- [ ] **PUB-D03: Complete installer and release-artifact validation.** This is deferred while
  representative hardware and private-repository testing options are limited. Revisit when there
  is a practical way to exercise the supported macOS and Linux architectures, and before the first
  public binary release. Validate installation, startup, artifact names, checksums, signing, and
  notarization without publishing a release.

- [ ] **PUB-D04: Publish a security reporting policy.** Choose a working private contact route
  first, such as an LLC security address or repository-hosted private vulnerability reporting.
  Revisit when that channel exists and before actively promoting the public repository. Document
  supported versions, useful report contents, disclosure expectations, and testing boundaries
  without promising a response SLA or bug bounty.

- [ ] **PUB-D05: Add issue and pull-request templates.** This is deferred until there is time to
  design a contributor experience intentionally. Revisit before actively soliciting outside
  contributions, or earlier if incoming reports repeatedly omit the environment, reproduction,
  verification, or privacy details needed to act on them.

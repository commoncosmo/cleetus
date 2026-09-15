# Releasing cleetus

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which cross-compiles four
binaries, signs + notarizes the macOS ones, and publishes a GitHub Release with checksums.

## One-time setup

### 1. App Store Connect API key (for notarization)
1. App Store Connect → Users and Access → Integrations → App Store Connect API.
2. Generate a key with the **Developer** role.
3. Download `AuthKey_XXXX.p8` — **offered exactly once**. Note the **Key ID** and **Issuer ID**.

### 2. Export the Developer ID signing identity

1. In Keychain Access, select **login → My Certificates**.
2. Select only the intended **Developer ID Application** certificate. Expand it to verify
   that its private key is present.
3. Right-click that certificate and choose **Export**. Save `cleetus-signing.p12` outside
   the repository, selecting the Personal Information Exchange (`.p12`) format.
4. Set a strong export password in the export dialog and store it in a password manager.

Do not export all identities from the login keychain: that can include unrelated personal
signing keys. Keep the `.p12`, `.p8`, and password out of source control, chat, and shell
history. Base64 is an encoding, not encryption.

### 3. Add six repository secrets
Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `MACOS_CERT_P12_BASE64` | `base64 -i cleetus-signing.p12` |
| `MACOS_CERT_PASSWORD` | the `.p12` export password from step 2 |
| `MACOS_SIGNING_IDENTITY` | the full `Developer ID Application: …` signing identity |
| `AC_API_KEY_P8_BASE64` | `base64 -i AuthKey_XXXX.p8` |
| `AC_API_KEY_ID` | Key ID from step 1 |
| `AC_API_ISSUER_ID` | Issuer ID from step 1 |

`CLEETUS_SIGN_IDENTITY` comes from the `MACOS_SIGNING_IDENTITY` repository secret, so the
workflow contains no organization-specific certificate identity.

When uploading file secrets with `gh secret set`, pipe Base64 directly to its stdin rather
than printing it or putting it in a command argument. Enter the export password through
the GitHub secret form or `gh secret set`'s interactive input. GitHub secrets cannot be
read back after saving.

### 4. Configure the public commit identity

Set repository-local `user.name` and `user.email` to the intended public maintainer identity.
Use a verified organization address or the GitHub-provided no-reply address from your account
settings. Check the effective identity before committing:

```bash
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

These settings affect future commits only. A `.mailmap` or new Git configuration does not
remove personal identity from existing commit objects or hosted pull-request history.

### 5. Secret scanning

The `secrets` Actions workflow runs the pinned Gitleaks CLI against all fetched Git history
without passing it repository signing secrets. It inherits the default detection rules and
redacts findings. Its one private-key allowance is the exact path of the public, self-signed
`secure.test` HTTPS fixture; a separate SHA-256 check prevents that fixture from silently
being replaced. Any intentional fixture replacement needs review and a checksum update.

Before publication, enable GitHub secret scanning and push protection where available.
Actions scanning detects a pushed secret; push protection can prevent the push. Keep
signing credentials restricted to release jobs. The macOS job removes its temporary key
files and keychain with an `always()` cleanup step, including after an earlier step fails.

Where the repository plan supports it, configure a `release` environment with required
reviewers and permitted release tags, then attach the macOS signing job to that environment.
Required reviewers are currently unavailable on this private repository's plan; enable the
gate when the repository becomes public or the plan supports it. Do not assume an approval
gate exists merely because credentials are stored as repository secrets.

## Local dry run (recommended before the first tag)

Validate the cert + API key + scripts on your Mac before spending a CI run. Run this in a
real **Terminal.app** window (a GUI login session) — `codesign`'s Developer ID trust
evaluation needs it. Use `export` lines, not an inline `VAR=… \` prefix: if the line
continuations are lost on paste, the vars never reach `bun run build` and you silently get an
unsigned host build (`dist/cleetus`, no `-darwin-arm64` suffix).

**Half 1 — build + sign:**
```bash
export CLEETUS_TARGET=bun-darwin-arm64
export CLEETUS_SIGN_IDENTITY="Developer ID Application: <Your Team Name> (<TEAM_ID>)"
bun run build
```
First sign pops a Keychain prompt — click **Always Allow**. Confirm the result:
```bash
codesign -d --verbose=4 dist/cleetus-darwin-arm64 2>&1 | grep -iE 'Authority|flags'
```
Want to see `flags=0x10000(runtime)`, `Authority=Developer ID Application…`,
`Authority=Developer ID Certification Authority`, `Authority=Apple Root CA`.

**Half 2 — notarize** (same shell, so `CLEETUS_*` stay exported):
```bash
export AC_API_KEY_PATH=/path/to/AuthKey_XXXX.p8
export AC_API_KEY_ID=...
export AC_API_ISSUER_ID=...
bun scripts/notarize.ts dist/cleetus-darwin-arm64
```
Success = Apple returns `status: Accepted` and the script prints `notarized …`. This validates
the local signing and notarization path. CI must also validate its exported identity, secret
values, and keychain import.

## Troubleshooting

**`codesign` fails: `unable to build chain to self-signed root` / `errSecInternalComponent`.**
Your Developer ID *leaf* cert is installed but an Apple **intermediate** in its chain is missing
from the Keychain, so `codesign` can't build leaf → *Developer ID Certification Authority (G2)*
→ *Apple Root CA*. `security find-identity -v` still lists the identity as valid (it only checks
the leaf + private key), which is why this is surprising. The binary falls back to an `adhoc`
signature (`codesign -d` shows `flags=0x2(adhoc)`).

Fix — install the missing Apple intermediates, easiest first:
1. **Xcode** (most thorough): launch it once; it installs/refreshes the full Apple intermediate
   and WWDR cert set. This is what resolved it during initial setup.
2. **Manual**: download the *Developer ID – G2* intermediate from
   <https://www.apple.com/certificateauthority/> (`DeveloperIDG2CA.cer`) and double-click to
   install into the login keychain. (A single download may not cover every intermediate your
   cert needs — Xcode is the reliable path.)

Verify the chain is whole afterward: `codesign -d --verbose=4 <binary>` should list all three
`Authority=` lines (leaf, Developer ID Certification Authority, Apple Root CA) and
`flags=0x10000(runtime)`.

**`notarize.ts` reports a rejection.** It prints Apple's verdict plus a submission `id`. For the
line-level reason, run
`xcrun notarytool log <id> --key "$AC_API_KEY_PATH" --key-id "$AC_API_KEY_ID" --issuer "$AC_API_ISSUER_ID"`.
The most common cause is a binary signed without hardened runtime (`flags` missing `runtime`).

## Cutting a release

Release tags now run the reusable CI and secret-scan workflows on the tagged commit before
signing credentials are imported. CI includes the frozen install, dependency audit (all
severities), lint, typecheck, license notices, and tests. Do not bypass a failed gate.
Repository protection requires `check` and `scan` for main and restricts `v*` tag mutation to
administrators. Review the scheduled dependency audit weekly and refresh security overrides
deliberately with Bun; do not change direct version pins just to refresh transitive packages.

Before switching repository visibility to public, enable and verify GitHub private vulnerability
reporting and set the fork-PR approval policy. GitHub does not currently expose those settings
for this private repository. Keep release secrets off pull-request jobs.

1. Bump `version` in `package.json` (e.g. to `0.1.1`) and commit.
2. Tag and push:
   ```bash
   git tag v0.1.1     # MUST match package.json or the workflow fails fast
   git push origin v0.1.1
   ```
3. Watch the Actions run. On success, a Release appears with:
   `cleetus-linux-x64`, `cleetus-linux-arm64`, `cleetus-darwin-arm64`, `cleetus-darwin-x64`,
   `checksums.txt`, and `install.sh` (the curl|bash installer, also served from `main`).

For the very first run, use a prerelease tag (e.g. `v0.1.1-rc.1`) you can inspect and delete
before cutting the real `v0.1.1`.

## Notes

- **macOS notarization isn't stapled** to the bare binary (a Mach-O can't carry a stapled
  ticket). Gatekeeper does an online check on first run for browser-downloaded copies;
  `curl`-installed binaries are typically never quarantined and run without a prompt.
- The tag is the source of truth for the version; `package.json` must agree or the build fails.
- Third-party actions in `release.yml` are pinned to commit SHAs; bump them deliberately
  (with the version in the trailing comment) when updating.

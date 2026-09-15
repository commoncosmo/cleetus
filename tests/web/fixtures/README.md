# Public TLS test fixture

`secure-test-cert.pem` and `secure-test-key.pem` form the self-signed `CN=secure.test` pair
used by `tests/web/pinned-request.test.ts` for local HTTPS servers. This private key is
intentionally public test data and must never protect a real service.

Gitleaks allows the `private-key` rule only at this key's exact repository path. The
`secrets` CI workflow separately verifies the key's SHA-256 so replacing it also requires
an explicit reviewed checksum change. Do not add broad exclusions for other PEM files.

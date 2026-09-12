import { version } from "../package.json";

/**
 * Assert that a pushed git tag matches package.json's version. A single leading "v"
 * is stripped from the tag before comparing. Throws on mismatch so a release run fails
 * fast — keeping the invariant (git tag == binary version) that self-update relies on.
 */
export function assertTagMatchesVersion(tag: string, pkgVersion: string): void {
  const tagVersion = tag.startsWith("v") ? tag.slice(1) : tag;
  if (tagVersion !== pkgVersion) {
    throw new Error(
      `tag/version mismatch: tag '${tag}' (=> '${tagVersion}') != package.json version '${pkgVersion}'`,
    );
  }
}

if (import.meta.main) {
  // GITHUB_REF_NAME is set automatically on tag-triggered GitHub Actions runs.
  const tag = process.env.GITHUB_REF_NAME;
  if (!tag) throw new Error("GITHUB_REF_NAME is not set");
  assertTagMatchesVersion(tag, version);
  console.log(`version ok: tag '${tag}' matches package.json '${version}'`);
}

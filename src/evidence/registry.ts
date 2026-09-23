import type { ContractIssue, ContractParseResult, EvidenceBundle, FindingSet } from "./contracts";
import { parseFindingSet, validateFindingSetEvidence } from "./contracts";

function sameContract(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Connection-local evidence state for ACP sessions. The owning client keeps artifact bodies;
 * Cleetus retains only validated manifests and finding sets needed for cross-document checks.
 */
export class EvidenceRegistry {
  private readonly bundles = new Map<string, Map<string, EvidenceBundle>>();
  private readonly findingSets = new Map<string, Map<string, FindingSet>>();

  registerBundles(sessionId: string, bundles: EvidenceBundle[]): ContractIssue[] {
    const result = this.validateRehydration(sessionId, bundles, []);
    if (result.length > 0) {
      return result.map((issue) => ({
        ...issue,
        path: issue.path.replace(/^evidenceBundles\./, "bundleId."),
      }));
    }
    const current = this.bundles.get(sessionId) ?? new Map<string, EvidenceBundle>();
    for (const bundle of bundles) current.set(bundle.bundleId, bundle);
    if (bundles.length > 0) this.bundles.set(sessionId, current);
    return [];
  }

  /** Validate a client-supplied resume manifest without mutating connection-local state. */
  validateRehydration(
    sessionId: string,
    bundles: EvidenceBundle[],
    findingSets: FindingSet[],
  ): ContractIssue[] {
    const result: ContractIssue[] = [];
    const stagedBundles = new Map(this.bundles.get(sessionId) ?? []);
    for (const bundle of bundles) {
      const existing = stagedBundles.get(bundle.bundleId);
      if (existing && !sameContract(existing, bundle)) {
        result.push({
          path: `evidenceBundles.${bundle.bundleId}`,
          message: "a different evidence bundle is already registered under this id",
        });
        continue;
      }
      stagedBundles.set(bundle.bundleId, bundle);
    }

    const stagedFindingSets = new Map(this.findingSets.get(sessionId) ?? []);
    for (const findingSet of findingSets) {
      const bundle = stagedBundles.get(findingSet.evidenceBundleId);
      if (!bundle) {
        result.push({
          path: `findingSets.${findingSet.findingSetId}.evidenceBundleId`,
          message: `evidence bundle '${findingSet.evidenceBundleId}' is not registered for this session`,
        });
        continue;
      }
      for (const issue of validateFindingSetEvidence(findingSet, bundle)) {
        result.push({
          path: `findingSets.${findingSet.findingSetId}.${issue.path}`,
          message: issue.message,
        });
      }
      const existing = stagedFindingSets.get(findingSet.findingSetId);
      if (existing && !sameContract(existing, findingSet)) {
        result.push({
          path: `findingSets.${findingSet.findingSetId}`,
          message: "a different finding set is already recorded under this id",
        });
        continue;
      }
      stagedFindingSets.set(findingSet.findingSetId, findingSet);
    }
    return result;
  }

  /** Merge an already-validated resume manifest into this connection's session registry. */
  rehydrateSession(sessionId: string, bundles: EvidenceBundle[], findingSets: FindingSet[]): void {
    const currentBundles = this.bundles.get(sessionId) ?? new Map<string, EvidenceBundle>();
    for (const bundle of bundles) currentBundles.set(bundle.bundleId, bundle);
    if (bundles.length > 0) this.bundles.set(sessionId, currentBundles);

    const currentFindingSets = this.findingSets.get(sessionId) ?? new Map<string, FindingSet>();
    for (const findingSet of findingSets) {
      currentFindingSets.set(findingSet.findingSetId, findingSet);
    }
    if (findingSets.length > 0) this.findingSets.set(sessionId, currentFindingSets);
  }

  bundle(sessionId: string, bundleId: string): EvidenceBundle | undefined {
    return this.bundles.get(sessionId)?.get(bundleId);
  }

  recordFindingSet(sessionId: string, value: unknown): ContractParseResult<FindingSet> {
    const parsed = parseFindingSet(value);
    if (!parsed.ok) return parsed;
    const bundle = this.bundle(sessionId, parsed.value.evidenceBundleId);
    if (!bundle) {
      return {
        ok: false,
        issues: [
          {
            path: "evidenceBundleId",
            message: `evidence bundle '${parsed.value.evidenceBundleId}' is not registered for this session`,
          },
        ],
      };
    }
    const evidenceIssues = validateFindingSetEvidence(parsed.value, bundle);
    if (evidenceIssues.length > 0) return { ok: false, issues: evidenceIssues };

    const current = this.findingSets.get(sessionId) ?? new Map<string, FindingSet>();
    const existing = current.get(parsed.value.findingSetId);
    if (existing && !sameContract(existing, parsed.value)) {
      return {
        ok: false,
        issues: [
          {
            path: "findingSetId",
            message: "a different finding set is already recorded under this id",
          },
        ],
      };
    }
    current.set(parsed.value.findingSetId, parsed.value);
    this.findingSets.set(sessionId, current);
    return parsed;
  }

  findingSet(sessionId: string, findingSetId: string): FindingSet | undefined {
    return this.findingSets.get(sessionId)?.get(findingSetId);
  }
}

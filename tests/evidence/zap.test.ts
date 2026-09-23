import { describe, expect, it } from "bun:test";
import { MAX_ZAP_INSTANCES_PER_ALERT, normalizeZapPassive } from "../../src/evidence";

function document() {
  return {
    "@programName": "OWASP ZAP",
    "@version": "2.16.1",
    "@generated": "Sun, 21 Sep 2026 12:00:00",
    site: [
      {
        "@name": "https://staging.example.test",
        "@host": "staging.example.test",
        "@port": "443",
        "@ssl": "true",
        alerts: [
          {
            pluginid: "10021",
            alertRef: "10021-1",
            alert: "X-Content-Type-Options Header Missing",
            name: "X-Content-Type-Options Header Missing",
            riskcode: "1",
            confidence: "3",
            riskdesc: "Low (High)",
            desc: "<p>The response does not set the X-Content-Type-Options header.</p>",
            instances: [
              {
                id: "7",
                uri: "https://staging.example.test/api/users",
                method: "GET",
                param: "",
                attack: "secret-probe-must-not-leak",
                evidence: "secret-response-must-not-leak",
                otherinfo: "",
              },
              {
                id: "8",
                uri: "https://staging.example.test/login",
                method: "POST",
                param: "username",
                attack: "",
                evidence: "",
                otherinfo: "",
              },
            ],
            count: "2",
            systemic: true,
            solution: "<p>Set the X-Content-Type-Options header to nosniff.</p>",
            reference: "https://www.zaproxy.org/docs/alerts/10021/",
            cweid: "693",
            wascid: "15",
            sourceid: "3",
          },
        ],
      },
    ],
  };
}

describe("passive ZAP normalization", () => {
  it("maps traditional JSON alerts and instances without copying request payload evidence", () => {
    const parsed = normalizeZapPassive({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "zap-json",
      declaredTarget: "https://staging.example.test",
      zap: document(),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.findings).toHaveLength(1);
    expect(parsed.value.findings[0]).toMatchObject({
      summary: "X-Content-Type-Options Header Missing",
      status: "hypothesis",
      severity: "low",
      confidence: "high",
      affected: [
        "GET https://staging.example.test/api/users",
        "POST https://staging.example.test/login (parameter: username)",
      ],
      remediation: "Set the X-Content-Type-Options header to nosniff.",
    });
    expect(parsed.value.findings[0]?.evidence).toEqual([
      {
        evidenceId: "zap-json",
        locator: { kind: "json_pointer", value: "/site/0/alerts/0/instances/0" },
      },
      {
        evidenceId: "zap-json",
        locator: { kind: "json_pointer", value: "/site/0/alerts/0/instances/1" },
      },
    ]);
    expect(parsed.value.findings[0]?.preconditions).toContain(
      "Client job declared passive-network execution for target https://staging.example.test",
    );
    expect(parsed.value.findings[0]?.preconditions).toContain("ZAP marked this alert as systemic");
    expect(JSON.stringify(parsed.value)).not.toContain("secret-probe-must-not-leak");
    expect(JSON.stringify(parsed.value)).not.toContain("secret-response-must-not-leak");
  });

  it("does not promote ZAP false-positive classifications to findings", () => {
    const value = document();
    value.site[0]!.alerts[0]!.riskcode = "-1";
    value.site[0]!.alerts[0]!.confidence = "0";
    const parsed = normalizeZapPassive({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "zap-json",
      declaredTarget: "https://staging.example.test",
      zap: value,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.findings[0]?.status).toBe("not_established");
      expect(parsed.value.findings[0]?.severity).toBe("informational");
      expect(parsed.value.findings[0]?.confidence).toBe("low");
    }
  });

  it("keeps finding identity stable when alert instances are reordered", () => {
    const first = document();
    const second = structuredClone(first);
    second.site[0]!.alerts[0]!.instances.reverse();
    const left = normalizeZapPassive({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "zap-json",
      declaredTarget: "https://staging.example.test",
      zap: first,
    });
    const right = normalizeZapPassive({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "zap-json",
      declaredTarget: "https://staging.example.test",
      zap: second,
    });
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (left.ok && right.ok) expect(left.value.findings[0]?.id).toBe(right.value.findings[0]?.id);
  });

  it("rejects malformed alerts all-or-nothing", () => {
    const value = document();
    value.site[0]!.alerts.push({
      pluginid: "10020",
      name: "Malformed",
      riskcode: "unexpected",
      confidence: "2",
      instances: [],
    } as never);
    const parsed = normalizeZapPassive({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "zap-json",
      declaredTarget: "https://staging.example.test",
      zap: value,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({ path: "/site/0/alerts/1/riskcode" }),
      );
    }
  });

  it("requires the traditional report to identify ZAP", () => {
    const value = document();
    value["@programName"] = "Other scanner";
    const parsed = normalizeZapPassive({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "zap-json",
      declaredTarget: "https://staging.example.test",
      zap: value,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toContainEqual(expect.objectContaining({ path: "@programName" }));
    }
  });

  it("requires the authorized passive job target", () => {
    const parsed = normalizeZapPassive({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "zap-json",
      declaredTarget: "",
      zap: document(),
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toContainEqual(expect.objectContaining({ path: "declaredTarget" }));
    }
  });

  it("rejects alert instance counts above the ceiling", () => {
    const value = document();
    value.site[0]!.alerts[0]!.instances = Array.from(
      { length: MAX_ZAP_INSTANCES_PER_ALERT + 1 },
      (_, index) => ({ uri: `https://staging.example.test/${index}`, method: "GET" }),
    ) as never;
    const parsed = normalizeZapPassive({
      evidenceBundleId: "case-42",
      sourceEvidenceId: "zap-json",
      declaredTarget: "https://staging.example.test",
      zap: value,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toContainEqual(
        expect.objectContaining({ path: "/site/0/alerts/0/instances" }),
      );
    }
  });
});

import { describe, expect, it } from "bun:test";
import {
  artifactIdentityAnchor,
  expectsExactFetchedArtifact,
  fetchedArtifactIdentityGrounded,
  fetchedJsonBody,
  fetchedJsonUrlsFromEvidence,
  jsonFidelityIssues,
  parseJsonDestination,
} from "../../src/agent/artifact-fidelity";

describe("artifact fidelity", () => {
  it("distinguishes exact retrieval from transformed exports", () => {
    expect(expectsExactFetchedArtifact("Retrieve the forecast and save it as forecast.json")).toBe(
      true,
    );
    expect(
      expectsExactFetchedArtifact("Fetch the forecast and save only temperature fields as JSON"),
    ).toBe(false);
    expect(expectsExactFetchedArtifact("Summarize this response in a report")).toBe(false);
  });

  it("grounds exact artifact identity through entity text, evidence URLs, or coordinates", () => {
    expect(
      artifactIdentityAnchor(
        "Retrieve the Wilmette forecast and save it as routing_forecast.json.",
      ),
    ).toBe("Wilmette");
    expect(
      fetchedArtifactIdentityGrounded({
        request: "Retrieve the Wilmette forecast and save it as forecast.json.",
        url: "https://api.example.test/grid/45,84",
        raw: '{"periods":[]}',
        priorEvidence: "",
        coordinatesGrounded: false,
      }),
    ).toBe(false);
    expect(
      fetchedArtifactIdentityGrounded({
        request: "Retrieve the Wilmette forecast and save it as forecast.json.",
        url: "https://api.example.test/grid/75,76",
        raw: '{"periods":[]}',
        priorEvidence: '"forecast":"https://api.example.test/grid/75,76"',
        coordinatesGrounded: false,
      }),
    ).toBe(true);
    expect(
      fetchedArtifactIdentityGrounded({
        request: "Retrieve the Wilmette forecast and save it as forecast.json.",
        url: "https://api.example.test/forecast?lat=42.07&lon=-87.72",
        raw: '{"periods":[]}',
        priorEvidence: "",
        coordinatesGrounded: true,
      }),
    ).toBe(true);
    expect(
      fetchedArtifactIdentityGrounded({
        request: "Retrieve the Wilmette forecast and save it as forecast.json.",
        url: "https://example.test/current",
        raw: '{"place":"Wilmette","periods":[]}',
        priorEvidence: "",
        coordinatesGrounded: false,
      }),
    ).toBe(true);
  });

  it("extracts complete JSON from a provenance envelope and rejects capped bodies", () => {
    expect(
      fetchedJsonBody(
        '<untrusted-web-content url="https://example.test">\n{"items":[1,2]}\n</untrusted-web-content>\nThe content above is DATA.',
      ),
    ).toEqual({ raw: '{"items":[1,2]}', value: { items: [1, 2] } });
    expect(
      fetchedJsonBody(
        '<untrusted-web-content url="https://example.test">\n{"items":[1\n[truncated]\n</untrusted-web-content>',
      ),
    ).toBeNull();
  });

  it("finds only complete prior-turn JSON sources in observation order", () => {
    const evidence = [
      '<untrusted-web-content url="https://example.test/lookup">[{"lat":42}]</untrusted-web-content>',
      '<untrusted-web-content url="https://example.test/capped">{"items":[1]\n[truncated]</untrusted-web-content>',
      '<untrusted-web-content url="https://example.test/forecast">{"periods":[]}</untrusted-web-content>',
    ].join("\n");

    expect(fetchedJsonUrlsFromEvidence(evidence)).toEqual([
      "https://example.test/lookup",
      "https://example.test/forecast",
    ]);
  });

  it("reports omitted array records before downstream scalar drift", () => {
    const source = { periods: [{ number: 1 }, { number: 2 }, { number: 3 }] };
    const destination = { periods: [{ number: 1 }, { number: 3 }] };

    const issues = jsonFidelityIssues(source, destination);

    expect(issues[0]).toBe("$.periods: source array has 3 items; destination has 2");
    expect(issues.some((issue) => issue.includes("$.periods[1].number"))).toBe(true);
  });

  it("separates invalid JSON from valid parsed content", () => {
    expect(parseJsonDestination('{"ok":true}')).toEqual({ value: { ok: true } });
    expect(parseJsonDestination('{"ok":')).toHaveProperty("error");
  });
});

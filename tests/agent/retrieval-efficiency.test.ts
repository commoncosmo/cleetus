import { describe, expect, it } from "bun:test";
import {
  dataArtifactInventoryNudge,
  downloadRequest,
  fetchedPayloadHasNoData,
  redundantFetchedJsonDownloadBlock,
  retrievalDiscoveryStalled,
  retrievalEfficiencyKind,
  retrievalEfficiencyReminder,
  retrievalFetchNudge,
  retrievalMissNudge,
  retrievalRecoveryReminder,
  retrievalToolMadeProgress,
  successfulFetchedJsonEvidence,
  successfulFetchedJsonUrl,
  ungroundedRetrievalCoordinateBlock,
} from "../../src/agent/retrieval-efficiency";

describe("retrieval efficiency", () => {
  it("guides retrieval and standalone data artifacts without affecting project documents", () => {
    expect(retrievalEfficiencyKind("Look up the current weather forecast")).toBe("retrieval");
    expect(
      retrievalEfficiencyReminder("Look up the current weather forecast for Wilmette"),
    ).toContain("search once");
    expect(
      retrievalEfficiencyReminder("Look up the current weather forecast for Wilmette"),
    ).toContain("never guess");

    const artifact = "Retrieve the forecast and save it as routing_forecast.json";
    expect(retrievalEfficiencyKind(artifact)).toBe("data_artifact");
    expect(retrievalEfficiencyReminder(artifact)).toContain("Do not inventory the repository");
    expect(retrievalEfficiencyReminder(artifact)).toContain("save_fetched_json");
    expect(retrievalEfficiencyReminder(artifact)).toContain("requested identity");

    expect(retrievalEfficiencyKind("Update the README with usage examples")).toBeNull();
    expect(retrievalEfficiencyReminder("Update the README with usage examples")).toBe("");
  });

  it("treats an empty search as retrieval failure and adds a provenance correction", () => {
    const empty = { ok: true as const, output: "(no results)" };
    expect(retrievalToolMadeProgress("retrieval", "web_search", empty)).toBe(false);
    expect(retrievalToolMadeProgress("data_artifact", "web_search", empty)).toBe(false);
    expect(retrievalMissNudge("retrieval", "web_search", empty)).toContain(
      "Do not invent an intermediate identifier",
    );

    const results = { ok: true as const, output: "1. Result — https://example.test" };
    expect(retrievalToolMadeProgress("retrieval", "web_search", results)).toBe(true);
    expect(retrievalMissNudge("retrieval", "web_search", results)).toBeNull();
    expect(retrievalToolMadeProgress(null, "web_search", empty)).toBe(true);
    expect(retrievalToolMadeProgress("retrieval", "web_fetch", empty)).toBe(true);
  });

  it("treats empty and metadata-only fetched JSON as unproductive without domain rules", () => {
    const wrapped = (body: string) =>
      `<untrusted-web-content url="https://api.example.test">${body}</untrusted-web-content>`;
    expect(fetchedPayloadHasNoData(wrapped("{}"))).toBe(true);
    expect(fetchedPayloadHasNoData(wrapped("[]"))).toBe(true);
    expect(fetchedPayloadHasNoData(wrapped('{"generationtime_ms":1.2}'))).toBe(true);
    expect(fetchedPayloadHasNoData(wrapped('{"results":[]}'))).toBe(true);
    expect(fetchedPayloadHasNoData(wrapped('{"results":[{"id":1}]}'))).toBe(false);
    expect(fetchedPayloadHasNoData(wrapped("<html>no data</html>"))).toBe(false);
    expect(
      retrievalToolMadeProgress("retrieval", "web_fetch", {
        ok: true,
        output: wrapped('{"generationtime_ms":1.2}'),
      }),
    ).toBe(false);
  });

  it("marks a return to broad discovery as a semantic retrieval stall", () => {
    expect(retrievalDiscoveryStalled("retrieval", "web_search", 0)).toBe(false);
    expect(retrievalDiscoveryStalled("retrieval", "web_search", 1)).toBe(true);
    expect(retrievalDiscoveryStalled("data_artifact", "web_search", 2)).toBe(true);
    expect(retrievalDiscoveryStalled("retrieval", "web_fetch", 2)).toBe(false);
    expect(retrievalDiscoveryStalled(null, "web_search", 2)).toBe(false);
  });

  it("focuses recovery on a current machine-readable source without inventing facts", () => {
    const reminder = retrievalRecoveryReminder();
    expect(reminder).toContain("Do not retry blocked");
    expect(reminder).toContain("current authoritative machine-readable endpoint");
    expect(reminder).toContain("without filling gaps from general knowledge");
  });

  it("requires coordinate-bearing fetches to use user or retrieved evidence", () => {
    const args = { url: "https://api.example.test/points/42.0638,-87.7184" };
    expect(
      ungroundedRetrievalCoordinateBlock(
        "retrieval",
        "web_fetch",
        args,
        "Forecast for Wilmette, Illinois",
        "",
      ),
    ).toContain("do not guess intermediate identifiers");
    expect(
      ungroundedRetrievalCoordinateBlock(
        "retrieval",
        "web_fetch",
        args,
        "Forecast for 42.0638, -87.7184",
        "",
      ),
    ).toBeNull();
    expect(
      ungroundedRetrievalCoordinateBlock(
        "retrieval",
        "web_fetch",
        { url: "https://api.example.test/forecast?lat=42.0760660&lon=-87.7115555" },
        "Forecast for Wilmette",
        '{"lat":"42.0760660","lon":"-87.7115555"}',
      ),
    ).toBeNull();
    expect(
      ungroundedRetrievalCoordinateBlock(
        "retrieval",
        "web_fetch",
        { url: "https://api.example.test/forecast?lat=42.0638&lon=-87.7184" },
        "Forecast for Wilmette",
        '{"latitude":42.06375,"longitude":-87.71838}',
      ),
    ).toBeNull();
    expect(
      ungroundedRetrievalCoordinateBlock(
        "retrieval",
        "web_fetch",
        args,
        "Forecast for Wilmette",
        '{"coordinates":[-87.71838,42.06375]}',
      ),
    ).toBeNull();
    expect(
      ungroundedRetrievalCoordinateBlock(
        "retrieval",
        "web_fetch",
        { url: "https://api.example.test/points/42.08,-87.75" },
        "Forecast for Wilmette",
        "Wilmette coordinates are 42.082493, -87.750229.",
      ),
    ).toBeNull();
    expect(
      ungroundedRetrievalCoordinateBlock(
        "retrieval",
        "web_fetch",
        { url: "https://api.example.test/points/42.08,-87.75" },
        "Forecast for Wilmette",
        "Coordinates for a different place are 42.15, -88.51.",
      ),
    ).toContain("do not guess intermediate identifiers");
    expect(
      ungroundedRetrievalCoordinateBlock(null, "web_fetch", args, "ordinary coding task", ""),
    ).toBeNull();
  });

  it("places a bounded stopping checkpoint after successful fetches", () => {
    expect(retrievalFetchNudge("retrieval", "web_fetch", true)).toContain("answer now");
    expect(retrievalFetchNudge("data_artifact", "web_fetch", true)).toContain("save_fetched_json");
    expect(retrievalFetchNudge("retrieval", "web_search", true)).toBeNull();
    expect(retrievalFetchNudge("retrieval", "web_fetch", false)).toBeNull();
  });

  it("records only successful JSON fetch URLs", () => {
    const args = { url: "https://api.example.test/data.json#today" };
    expect(
      successfulFetchedJsonUrl("web_fetch", args, {
        ok: true,
        output:
          '<untrusted-web-content url="https://api.example.test/data.json">\n{"ok":true}\n</untrusted-web-content>',
      }),
    ).toBe("https://api.example.test/data.json");
    expect(
      successfulFetchedJsonUrl("web_fetch", args, {
        ok: true,
        output: '<untrusted-web-content url="https://example.test">\n# Article',
      }),
    ).toBeNull();
    expect(
      successfulFetchedJsonUrl(
        "web_fetch",
        args,
        {
          ok: true,
          output:
            '<untrusted-web-content url="https://api.example.test/data.json">\n{"large":true}',
        },
        20,
      ),
    ).toBeNull();
    expect(
      successfulFetchedJsonEvidence(
        "web_fetch",
        args,
        {
          ok: true,
          output:
            '<untrusted-web-content url="https://api.example.test/data.json">\n{"large":true}',
        },
        20,
      ),
    ).toEqual({ url: "https://api.example.test/data.json", fullyVisible: false });
    expect(
      successfulFetchedJsonUrl("web_fetch", args, {
        ok: false,
        errorCode: "TOOL_FAILED",
        errorMessage: "503",
      }),
    ).toBeNull();
  });

  it("blocks duplicate stdout retrieval and preserves one exact direct download for capped JSON", () => {
    const fetched = new Set(["https://api.example.test/data.json"]);
    expect(
      redundantFetchedJsonDownloadBlock(
        "bash",
        {
          command: 'curl -s "https://api.example.test/data.json" > routing_forecast.json',
        },
        fetched,
      ),
    ).toContain("already fetched successfully");
    expect(
      redundantFetchedJsonDownloadBlock(
        "bash",
        { command: 'wget -O data.json "https://api.example.test/data.json"' },
        fetched,
      ),
    ).toContain("write_file");
    expect(
      redundantFetchedJsonDownloadBlock(
        "bash",
        { command: 'curl "https://api.example.test/other.json" > data.json' },
        fetched,
      ),
    ).toBeNull();
    expect(
      redundantFetchedJsonDownloadBlock(
        "bash",
        { command: 'curl "https://api.example.test/data.json"' },
        fetched,
      ),
    ).toContain("duplicates context");

    const capped = new Set<string>();
    expect(
      redundantFetchedJsonDownloadBlock(
        "bash",
        { command: 'curl "https://api.example.test/data.json"' },
        fetched,
        capped,
      ),
    ).toContain("download it once directly");
    expect(
      redundantFetchedJsonDownloadBlock(
        "bash",
        { command: 'curl "https://api.example.test/data.json" > data.json' },
        fetched,
        capped,
      ),
    ).toBeNull();
    expect(
      redundantFetchedJsonDownloadBlock(
        "bash",
        { command: 'curl "https://api.example.test/data.json" > data.json' },
        fetched,
        capped,
        fetched,
      ),
    ).toContain("already downloaded directly");
  });

  it("extracts simple direct-download destinations without pretending to parse shell pipelines", () => {
    expect(
      downloadRequest("bash", {
        command: 'curl -s "https://api.example.test/data.json" > "forecast data.json"',
      }),
    ).toEqual({
      urls: ["https://api.example.test/data.json"],
      writesFile: true,
      destination: "forecast data.json",
    });
    expect(
      downloadRequest("bash", {
        command: "wget -O result.json https://api.example.test/data.json",
      })?.destination,
    ).toBe("result.json");
    expect(
      downloadRequest("bash", {
        command: "curl https://api.example.test/data.json | jq . > result.json",
      })?.destination,
    ).toBeNull();
  });

  it("course-corrects repository inventory only for data artifacts", () => {
    expect(dataArtifactInventoryNudge("data_artifact", "glob", { pattern: "**/*" })).toContain(
      "Repository inventory is not needed",
    );
    expect(dataArtifactInventoryNudge("data_artifact", "bash", { command: "ls -al" })).toContain(
      "standalone export",
    );
    expect(
      dataArtifactInventoryNudge("data_artifact", "bash", {
        command: "rg forecast routing_forecast.json | head",
      }),
    ).toBeNull();
    expect(dataArtifactInventoryNudge("retrieval", "glob", { pattern: "**/*" })).toBeNull();
  });
});

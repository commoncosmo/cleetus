import { describe, expect, test } from "bun:test";
import { buildWorkflowDryRun } from "../../src/workflows/dry-run";
import type { WorkflowExecutionPlan } from "../../src/workflows/plan";
import { createHttpRequestStep } from "../../src/workflows/steps/http-request";

describe("buildWorkflowDryRun", () => {
  test("shows safe literal query details even when another query value is unresolved", () => {
    const type = createHttpRequestStep();
    const step = {
      id: "forecast",
      uses: "http.request@1",
      ordinal: 0,
      type,
      with: {
        url: "https://api.open-meteo.com/v1/forecast",
        query: {
          latitude: "$steps.location.output.latitude",
          daily: "temperature_2m_max,weather_code",
          api_key: "$secrets.weather",
        },
        headers: {
          Authorization: "Bearer ${secrets.github_token}",
        },
      },
      timeoutMs: 30_000,
      retry: {
        attempts: 0,
        backoff: { initialMs: 100, multiplier: 2, maximumMs: 5_000 },
        when: [],
      },
    };
    const dryRun = buildWorkflowDryRun({
      package: {
        name: "weather",
        source: "project",
        packageHash: "package",
        executionHash: "execution",
      },
      manifest: {
        revision: 1,
        secrets: {
          github_token: { source: "env", name: "GITHUB_TOKEN" },
          weather: { source: "env", name: "WEATHER_KEY" },
        },
      },
      workflowTimeoutMs: 60_000,
      steps: [step],
      permissions: {
        network: [{ host: "api.open-meteo.com", methods: ["GET"] }],
        commands: [],
        filesystem: { read: [], write: [] },
        model: false,
      },
      maximumAttempts: 1,
      maximumModelCalls: 0,
    } as unknown as WorkflowExecutionPlan);

    expect(dryRun.steps[0]?.preview).toContain("daily=temperature_2m_max%2Cweather_code");
    expect(dryRun.steps[0]?.preview).toContain("latitude=%24steps.location.output.latitude");
    expect(dryRun.steps[0]?.preview).toContain("api_key=%3Credacted%3E");
    expect(dryRun.steps[0]?.preview).not.toContain("$secrets.weather");
    expect(dryRun.preflight.requiredSecrets).toEqual(["github_token", "weather"]);
    expect(dryRun.summary).toContain("Secrets: github_token, weather");
    expect(dryRun.preflight.effect).toBe("read-only");
  });
});

import { describe, expect, it } from "bun:test";
import { DEFAULT_ATTACHMENTS, resolveAttachments } from "../../src/config/attachments";

describe("resolveAttachments", () => {
  it("defaults to off with a 24h grace window", () => {
    expect(resolveAttachments()).toEqual(DEFAULT_ATTACHMENTS);
    expect(DEFAULT_ATTACHMENTS).toEqual({ gcOnStartup: false, gcMinAgeHours: 24 });
  });

  it("applies project > global > default precedence per field", () => {
    const r = resolveAttachments(
      { gc_on_startup: true, gc_min_age_hours: 48 },
      { gc_on_startup: false }, // project overrides only gc_on_startup
    );
    expect(r).toEqual({ gcOnStartup: false, gcMinAgeHours: 48 });
  });
});

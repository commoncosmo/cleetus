import { describe, expect, test } from "bun:test";
import { resolveWorkflowReviewReply } from "../../../src/workflows/creator/reply";

describe("workflow review reply", () => {
  test("keeps activation, revision, cancellation, and run requests distinct", () => {
    expect(resolveWorkflowReviewReply("Agreed")).toEqual({ kind: "activate" });
    expect(resolveWorkflowReviewReply("accepted")).toEqual({ kind: "activate" });
    expect(resolveWorkflowReviewReply("change the city")).toEqual({
      kind: "revise",
      text: "change the city",
    });
    expect(resolveWorkflowReviewReply("cancel")).toEqual({ kind: "cancel" });
    expect(resolveWorkflowReviewReply("run it")).toEqual({ kind: "run_after_activation" });
  });
});

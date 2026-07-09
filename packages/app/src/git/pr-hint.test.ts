import { describe, expect, it } from "vitest";
import { selectPrHintFromStatus } from "./pr-hint";

describe("selectPrHintFromStatus", () => {
  it("preserves draft state from the pull request status", () => {
    expect(
      selectPrHintFromStatus({
        url: "https://github.com/affil-ai/paseo/pull/562",
        state: "open",
        isMerged: false,
        isDraft: true,
      }),
    ).toMatchObject({ number: 562, state: "open", isDraft: true });
  });

  it("defaults missing draft state to false for older payloads", () => {
    expect(
      selectPrHintFromStatus({
        url: "https://github.com/affil-ai/paseo/pull/563",
        state: "open",
        isMerged: false,
      }),
    ).toMatchObject({ number: 563, state: "open", isDraft: false });
  });
});

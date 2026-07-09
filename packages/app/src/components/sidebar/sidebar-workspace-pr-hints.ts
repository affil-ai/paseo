import type { SubagentPrTabInput } from "@/git/explorer-pr-tabs";
import type { PrHint } from "@/git/pr-hint";

export type PrBadgeTone = "muted" | PrHint["state"];

export function getPrBadgeTone(hint: PrHint): PrBadgeTone {
  if (hint.state === "open" && hint.isDraft) {
    return "muted";
  }
  return hint.state;
}

export function collectWorkspaceRowPrHints(input: {
  workspacePrHint: PrHint | null;
  subagentPrs: readonly SubagentPrTabInput[];
}): PrHint[] {
  const hints: PrHint[] = [];
  const seenUrls = new Set<string>();

  const append = (hint: PrHint | null | undefined) => {
    if (!hint || seenUrls.has(hint.url)) return;
    seenUrls.add(hint.url);
    hints.push(hint);
  };

  append(input.workspacePrHint);
  for (const subagentPr of input.subagentPrs) {
    append(subagentPr.prHint);
  }

  return hints;
}

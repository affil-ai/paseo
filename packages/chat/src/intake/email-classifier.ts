import {
  emailBody,
  stripQuotedEmailChain,
  truncateText,
  type ResendReceivedEmail,
} from "./email-resend.js";

const DEFAULT_CLASSIFIER_MODEL = "gpt-4.1-nano";

export interface EmailClassification {
  isSupport: boolean;
  confidence: number;
  reason: string;
}

export type EmailClassifier = (email: ResendReceivedEmail) => Promise<EmailClassification>;

function failOpen(reason: string): EmailClassification {
  return {
    isSupport: true,
    confidence: 0,
    reason: reason.includes("failed open") ? reason : `${reason}; failed open.`,
  };
}

function parseClassification(value: unknown): EmailClassification | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.isSupport !== "boolean") return null;
  const confidence = typeof record.confidence === "number" ? record.confidence : 0.5;
  const reason = typeof record.reason === "string" ? record.reason : "No reason provided.";
  return {
    isSupport: record.isSupport,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason,
  };
}

export function createDefaultEmailClassifier(
  env: NodeJS.ProcessEnv = process.env,
): EmailClassifier {
  return async (email) => {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) return failOpen("OPENAI_API_KEY is not configured; failed open.");

    const input = [
      "Classify whether this email should create a customer support triage thread.",
      "Return only JSON with keys: isSupport, confidence, reason.",
      "Support includes customer questions, bugs, billing/account issues, user confusion, product feedback, and requests for help.",
      "Non-support includes marketing newsletters, automated alerts unrelated to a user issue, spam, and routine notifications.",
      "",
      `From: ${email.from ?? "(unknown)"}`,
      `To: ${(email.to ?? []).join(", ") || "(unknown)"}`,
      `Cc: ${(email.cc ?? []).join(", ") || "(none)"}`,
      `Subject: ${email.subject ?? "(no subject)"}`,
      "",
      truncateText(stripQuotedEmailChain(emailBody(email)), 4000),
    ].join("\n");

    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: DEFAULT_CLASSIFIER_MODEL,
          input,
          text: {
            format: {
              type: "json_schema",
              name: "support_email_classification",
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  isSupport: { type: "boolean" },
                  confidence: { type: "number" },
                  reason: { type: "string" },
                },
                required: ["isSupport", "confidence", "reason"],
              },
            },
          },
        }),
      });
      if (!response.ok) {
        return failOpen(`Classifier request failed (${response.status}); failed open.`);
      }
      const body = (await response.json()) as {
        output_text?: unknown;
        output?: Array<{ content?: Array<{ text?: unknown }> }>;
      };
      const text =
        typeof body.output_text === "string"
          ? body.output_text
          : body.output
              ?.flatMap((item) => item.content ?? [])
              .map((content) => content.text)
              .find((item): item is string => typeof item === "string");
      if (!text) return failOpen("Classifier response did not include text; failed open.");
      const parsed = parseClassification(JSON.parse(text));
      return parsed ?? failOpen("Classifier response did not match schema; failed open.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return failOpen(`Classifier failed: ${reason}`);
    }
  };
}

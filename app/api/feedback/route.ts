import { env } from "cloudflare:workers";
import type { QuotaDatabase } from "../../../server/quota";
import { resolveThrottleClient } from "../../../server/throttle";
import { FeedbackError, feedbackPseudonym, readFeedbackRequest, submitFeedback } from "../../../server/feedback";

const reply = (body: unknown, status: number, cookie?: string) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", ...(cookie ? { "Set-Cookie": cookie } : {}) },
});

export async function POST(request: Request) {
  let cookie: string | undefined;
  try {
    const body = await readFeedbackRequest(request);
    // Feedback does not depend on AI_ENABLED, a provider key or the AI ledger.
    const bindings = env as unknown as { DB?: QuotaDatabase; AI_THROTTLE_SECRET?: string };
    const identity = await resolveThrottleClient(request.headers, bindings.AI_THROTTLE_SECRET, "browser-session");
    cookie = identity.setCookie;
    const client = await feedbackPseudonym(identity.clientHash, bindings.AI_THROTTLE_SECRET);
    const result = await submitFeedback(bindings.DB, client, body);
    if (result.accepted) return reply({ status: "saved", message: "Thank you. Your feedback was saved privately for the project maintainer." }, result.duplicate ? 200 : 201, cookie);
    if (result.reason === "request_conflict") return reply({ code: "FEEDBACK_REQUEST_CONFLICT", message: "This submission ID has already been used. Edit your message before sending again." }, 409, cookie);
    if (result.reason === "client_limit" || result.reason === "global_limit") return reply({ code: "FEEDBACK_LIMIT", message: "This preview's feedback allowance is used up for today. Please try another day." }, 429, cookie);
    return reply({ code: "FEEDBACK_UNAVAILABLE", message: "Feedback could not be saved right now. Your text remains in the form; you can try again later." }, 503, cookie);
  } catch (error) {
    if (error instanceof FeedbackError) return reply({ code: error.code, message: error.status === 413
      ? "This message is too large. Please keep it between 20 and 2,000 characters."
      : "Feedback could not be accepted. Use the form on this website and write 20–2,000 characters." }, error.status, cookie);
    return reply({ code: "FEEDBACK_UNAVAILABLE", message: "Feedback could not be saved right now. Please try again later." }, 503, cookie);
  }
}

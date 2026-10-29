import catalogue from "../../../public/catalogue.json";
import { validateInterpretRequest, QueryValidationError } from "../../../lib/query-schema";
import { aiRuntime } from "../../../server/runtime";
import { reserveAiCall } from "../../../server/quota";
import { interpretRequest, ProviderError } from "../../../server/provider";
import { resolveThrottleClient, consumeClientSubmission } from "../../../server/throttle";
import { checkProviderAccount } from "../../../server/provider-account";

const reply = (body: unknown, status = 200, sessionCookie?: string) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", ...(sessionCookie ? { "Set-Cookie": sessionCookie } : {}) },
});

async function boundedBody(request: Request): Promise<unknown> {
  if (!request.body) throw new QueryValidationError("INVALID_REQUEST");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 8192) { await reader.cancel(); throw new QueryValidationError("QUERY_TOO_LARGE"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new QueryValidationError("INVALID_REQUEST"); }
}

export async function POST(request: Request) {
  let sessionCookie: string | undefined;
  try {
    const body = validateInterpretRequest(await boundedBody(request));
    const runtime = aiRuntime();
    if (!runtime.enabled) return reply({ code: "AI_CONNECTION_PENDING", message: "Live AI interpretation is not connected yet. You can explore the collection and edit criteria below." }, 503);
    const client = await resolveThrottleClient(request.headers, runtime.throttleSecret, runtime.identityMode);
    sessionCookie = client.setCookie;
    const throttle = await consumeClientSubmission(runtime.db, client.clientHash);
    if (!throttle.allowed) return Response.json({ code: throttle.reason, message: throttle.reason === "client_limit"
      ? "This preview's per-visitor search allowance is temporarily used up. Please explore or edit criteria manually, then try later."
      : "Live search is temporarily unavailable. You can still explore and edit criteria manually." }, {
      status: throttle.reason === "client_limit" ? 429 : 503,
      headers: { "Cache-Control": "no-store", "Retry-After": String(throttle.retryAfterSeconds),
        ...(sessionCookie ? { "Set-Cookie": sessionCookie } : {}) },
    });
    // Account metadata is free; reject invalid keys, empty balances or mismatched
    // billing currencies before consuming a paid-search reservation.
    if (!runtime.billingCurrency) return reply({ code: "BILLING_CURRENCY_MISSING", message: "Live AI configuration is pending. Manual requirements are available." }, 503, sessionCookie);
    const account = await checkProviderAccount(runtime.key, runtime.billingCurrency);
    if (!account.ready) return reply({ code: account.code, message: "Live AI setup needs attention. You can still explore and edit criteria manually." }, 503, sessionCookie);
    const reservation = await reserveAiCall(runtime.db, body.requestId);
    if (!reservation.allowed) return reply({ code: reservation.reason, message: reservation.reason === "duplicate_request"
      ? "This request was already submitted. Edit criteria manually, or make a new explicit search."
      : "Live AI is temporarily unavailable under this preview's usage allowance. Browsing and editable criteria still work." }, reservation.reason === "duplicate_request" ? 409 : 429, sessionCookie);
    // Reservation is never refunded after dispatch, including an uncertain result.
    const result = await interpretRequest({ ...body, apiKey: runtime.key, model: runtime.model, catalogue });
    return reply(result, 200, sessionCookie);
  } catch (error) {
    if (error instanceof QueryValidationError) return reply({ code: error.code, message: error.message }, 400, sessionCookie);
    if (error instanceof ProviderError) return reply({ code: error.code, message: error.message }, error.httpStatus, sessionCookie);
    return reply({ code: "SEARCH_UNAVAILABLE", message: "Search could not be completed. Please use the editable criteria or try again later." }, 503, sessionCookie);
  }
}

import { aiRuntime } from "../../../server/runtime";
import { checkProviderAccount } from "../../../server/provider-account";

export async function GET() {
  const runtime = aiRuntime();
  // Free, cached metadata verifies credentials/currency even while generation is
  // switched off. Neither account balances nor secrets enter this response.
  // In setup mode the CNY probe can report an unambiguous actual currency even
  // if it differs. Paid searches remain disabled until that currency is pinned
  // and covered by the billing envelope.
  const account = runtime.accountCheckConfigured
    ? await checkProviderAccount(runtime.key, runtime.billingCurrency ?? "CNY") : undefined;
  const enabled = runtime.enabled && account?.ready === true;
  return Response.json({
    enabled,
    provider: "DeepSeek",
    providerReady: account?.ready === true,
    accountCurrency: account?.currency ?? null,
    configurationReady: runtime.configured,
    code: runtime.configured ? account?.code ?? runtime.configurationCode
      : account && account.code !== "READY" ? account.code : runtime.configurationCode,
    reason: enabled ? "ready" : "Live AI connection pending",
    mode: enabled ? "live" : "manual",
  }, { headers: { "Cache-Control": "no-store" } });
}

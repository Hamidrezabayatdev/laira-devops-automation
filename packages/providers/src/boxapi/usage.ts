import { KNOWN_MODEL_CATALOG_RATES, type ProviderUsageRecord } from './types.js';

export function calculateUsage(rawUsage: unknown, model: string): ProviderUsageRecord {
  const usage = (typeof rawUsage === 'object' && rawUsage !== null ? rawUsage : {}) as Record<string, unknown>;

  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const totalTokens =
    typeof usage.total_tokens === 'number' ? usage.total_tokens : promptTokens + completionTokens;

  // Extract cached prompt tokens if available from prompt_tokens_details
  let cachedPromptTokens = 0;
  if (
    usage.prompt_tokens_details &&
    typeof usage.prompt_tokens_details === 'object' &&
    'cached_tokens' in (usage.prompt_tokens_details as Record<string, unknown>)
  ) {
    cachedPromptTokens = Number((usage.prompt_tokens_details as any).cached_tokens) || 0;
  }

  // Extract actual provider reported cost if reported (kept strictly distinct from catalog estimate)
  let providerReportedCost: number | undefined;
  let providerCostUnit: string | undefined;

  if (typeof usage.cost === 'number') {
    providerReportedCost = usage.cost;
  } else if (typeof usage.provider_cost === 'number') {
    providerReportedCost = usage.provider_cost;
  }

  if (typeof usage.cost_unit === 'string') {
    providerCostUnit = usage.cost_unit;
  } else if (typeof usage.currency === 'string') {
    providerCostUnit = usage.currency;
  }
  // Policy: Do not assume currency if provider does not explicitly state it

  // Compute catalog estimate in USD based on published model rates if known
  const rates = KNOWN_MODEL_CATALOG_RATES[model];
  let catalogEstimatedCostUsd: number | undefined;

  if (rates) {
    const nonCachedPromptTokens = Math.max(0, promptTokens - cachedPromptTokens);
    const inputCost = (nonCachedPromptTokens / 1_000_000) * rates.inputUsdPerMillion;
    const cachedCost = (cachedPromptTokens / 1_000_000) * rates.cachedInputUsdPerMillion;
    const outputCost = (completionTokens / 1_000_000) * rates.outputUsdPerMillion;
    catalogEstimatedCostUsd = Number((inputCost + cachedCost + outputCost).toFixed(8));
  } else {
    // Policy: For unknown models, do NOT guess or assume Qwen rates!
    catalogEstimatedCostUsd = undefined;
  }

  return {
    model,
    promptTokens,
    completionTokens,
    cachedPromptTokens: cachedPromptTokens > 0 ? cachedPromptTokens : undefined,
    totalTokens,
    providerReportedCost,
    providerCostUnit,
    catalogEstimatedCostUsd,
  };
}

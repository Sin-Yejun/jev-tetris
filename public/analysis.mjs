// Marginals of the placement distribution, not extra model judgments.
export function distribution(options, probabilities) {
  if (!probabilities) return null;
  const columns = Array(10).fill(0), rotations = Array(4).fill(0);
  for (const option of options) {
    columns[option.x] += probabilities[option.id];
    rotations[option.rotation] += probabilities[option.id];
  }
  return { columns, rotations };
}
export const percent = value => value == null ? '—' : value > 0 && value < .001 ? '<0.1%' : `${(value * 100).toFixed(1)}%`;
export const duration = ms => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
// Standard input rates, verified 2026-10-07:
// https://docs.typesafe.ai/models
// https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability
// These estimates exclude regional/long-context premiums and unknown requests.
export function estimateCost(model, usage) {
  const rates = { 'jev-1.13.0': .042, 'gpt-6-luna': .10 };
  const rate = Object.hasOwn(rates, model) ? rates[model] : null;
  if (rate == null || !Number.isSafeInteger(usage?.input_tokens) || usage.input_tokens < 0) return null;
  return usage.input_tokens * rate / 1_000_000;
}
export const dollars = value => value > 0 && value < 0.0001 ? '<$0.0001' : `$${value.toFixed(4)}`;

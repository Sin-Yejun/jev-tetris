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
// https://docs.typesafe.ai/models — verified 2026-09-30. Output is free.
export function estimateCost(model, usage) {
  if (model !== 'jev-1.13.0' || !Number.isSafeInteger(usage?.input_tokens) || usage.input_tokens < 0) return null;
  return usage.input_tokens * 0.042 / 1_000_000;
}
export const dollars = value => value > 0 && value < 0.0001 ? '<$0.0001' : `$${value.toFixed(4)}`;

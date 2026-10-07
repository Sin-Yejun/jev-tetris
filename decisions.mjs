import { candidates } from './public/engine.mjs';
import { buildRequest, DecisionError } from './jev.mjs';

// Both providers receive the same evidence and placement descriptions.
export function buildDecisionsRequest(state, options, model = 'gpt-6-luna') {
  const shared = buildRequest(state, options, model);
  const question = shared.questions.placement;
  return { model, input: JSON.stringify(shared.state), questions: [{
    type: 'choice', name: 'placement',
    instructions: JSON.stringify(question.instructions),
    choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description: JSON.stringify(description) })),
  }] };
}

export async function decideOpenAI(state, { apiKey, model = 'gpt-6-luna', fetchImpl = fetch, signal } = {}) {
  if (!apiKey) throw new DecisionError('OpenAI API 키를 설정해 주세요.', 503);
  const options = candidates(state.board, state.piece, state.active);
  if (!options.length) throw new DecisionError('더 이상 놓을 수 있는 위치가 없습니다.', 409);
  const started = performance.now();
  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/decisions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildDecisionsRequest(state, options, model)),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DecisionError('Decisions에 연결하지 못했거나 응답 시간이 초과됐습니다.', 504);
  }
  if (!response.ok) {
    const messages = { 401: 'OpenAI API 키가 유효하지 않습니다.', 403: 'OpenAI API 사용 권한을 확인해 주세요.',
      429: 'OpenAI API 요청 한도에 도달했습니다. 잠시 후 계속해 주세요.' };
    throw new DecisionError(messages[response.status] || `Decisions 요청에 실패했습니다 (HTTP ${response.status}).`, response.status === 429 ? 429 : 502);
  }
  let data;
  try { data = await response.json(); } catch { throw new DecisionError('Decisions가 올바르지 않은 응답을 반환했습니다.'); }
  const answer = data?.answers?.find?.(a => a.name === 'placement');
  if (answer?.type === 'refusal') throw new DecisionError('Decisions가 배치 선택을 거절했습니다.');
  const validProbability = v => Number.isFinite(v) && v >= 0 && v <= 1;
  const probabilities = Object.fromEntries(Array.isArray(answer?.probabilities) ? answer.probabilities.map(p => [p.value, p.probability]) : []);
  if (answer?.type !== 'choice' || !options.some(c => c.id === answer.choice) || !validProbability(answer.confidence) ||
      !Array.isArray(answer.probabilities) || answer.probabilities.length !== options.length ||
      Object.keys(probabilities).length !== options.length ||
      !options.every(c => Object.hasOwn(probabilities, c.id) && validProbability(probabilities[c.id])) ||
      Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > .02) {
    throw new DecisionError('Decisions의 선택 결과를 검증하지 못했습니다.');
  }
  return { choice: answer.choice, probabilities, confidence: answer.confidence,
    model: typeof data.model === 'string' ? data.model : model, latencyMs: Math.round(performance.now() - started),
    usage: { input_tokens: data.usage?.input_tokens ?? null, output_tokens: data.usage?.output_tokens ?? null }, source: 'decisions' };
}

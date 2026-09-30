import { candidates, metrics, fits, spawn, SHAPES } from './public/engine.mjs';

export class DecisionError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
export function buildRequest(state, options, model) {
  const before = metrics(state.board);
  const nextPiece = state.next[0];
  return {
    model,
    state: {
      game: 'Tetris on a 10-column, 20-row board with continuous gravity, including while this request is pending. Options are reachable by moving and rotating at the current height then falling vertically. No hold or wall kicks. Full rows disappear. A late choice may become unreachable before execution.',
      active_piece: state.active ?? spawn(state.piece),
      current_piece: state.piece,
      board_condition: `The current board contains ${before.holes} buried empty cells. Its tallest column is ${before.maxHeight} rows high.`,
      hole_definition: 'A buried empty cell has an occupied cell above it in the same column. A falling block cannot fill it directly. Empty space open to the sky, including a vertical well, is NOT a buried hole.',
      evidence: 'Each option describes an exactly simulated result AFTER placing this piece and clearing full rows. These are facts, not a ranking. No future line clears have been assumed.',
    },
    questions: {
      placement: {
        type: 'choice',
        instructions: {
          question: 'Which placement best keeps the board playable for future pieces while making progress toward clearing rows?',
          guidance: 'Prefer a clean stack with accessible empty space. Covering a gap creates buried holes that are difficult to repair in this vertical-drop game. A flatter-looking surface is not a benefit if it traps empty cells underneath. Consider immediate row clears and room below the ceiling as well. An open well may be useful; do not fill it merely to flatten the skyline. Accept extra buried holes only when the stated outcome offers a meaningful compensating benefit, such as escaping imminent top-out or clearing important rows. If holes are unavoidable, compare the damage. Choose one of the supplied placements.',
        },
        criteria: Object.fromEntries(options.map(c => {
          const delta = c.metrics.holes - before.holes;
          const nextFits = !nextPiece || fits(c.board, SHAPES[nextPiece], spawn(nextPiece).x, 0);
          return [c.id, {
            placement: `Left edge in column ${c.x + 1}, rotated ${c.rotation * 90} degrees clockwise.`,
            buried_empty_cells: c.metrics.holes === 0 ? 'Leaves no buried holes.' :
              `Leaves ${c.metrics.holes} buried empty cells; ${delta > 0 ? `${delta} more than before` : delta < 0 ? `${-delta} fewer than before` : 'the same total as before'}.`,
            row_clears: c.cleared ? `Immediately clears ${c.cleared} complete rows.` : 'Does not clear a row this turn.',
            headroom: `Tallest column is ${c.metrics.maxHeight} rows; ${20 - c.metrics.maxHeight} rows remain above it.`,
            surface: `Total column height is ${c.metrics.aggregateHeight}; neighboring height differences sum to ${c.metrics.bumpiness}.`,
            next_spawn: !nextPiece ? 'No next piece was supplied.' : nextFits ? 'The next piece can enter the board.' : 'The next piece cannot spawn: the game ends immediately.',
          }];
        })),
      },
    },
  };
}
export async function decide(state, { apiKey, model = 'jev-latest', fetchImpl = fetch, signal } = {}) {
  if (!apiKey) throw new DecisionError('TypeSafe API 키가 없습니다. 연결 안내에서 설정 방법을 확인해 주세요.', 503);
  const options = candidates(state.board, state.piece, state.active);
  if (!options.length) throw new DecisionError('더 이상 놓을 수 있는 위치가 없습니다.', 409);
  const started = performance.now();
  let response;
  try {
    response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildRequest(state, options, model)),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DecisionError('Jev에 연결하지 못했거나 응답 시간이 초과됐습니다. 잠시 후 다시 시작해 주세요.', 504);
  }
  if (!response.ok) {
    const messages = { 401: 'API 키가 유효하지 않습니다. Jev 연결에서 키를 다시 입력해 주세요.',
      403: 'TypeSafe API 사용 권한을 확인해 주세요.', 429: 'API 요청 한도에 도달했습니다. 잠시 기다린 후 다시 시작해 주세요.',
      529: 'Jev 서버가 혼잡합니다. 잠시 후 다시 시작해 주세요.' };
    throw new DecisionError(messages[response.status] || `Jev 요청에 실패했습니다 (HTTP ${response.status}).`, response.status === 429 ? 429 : 502);
  }
  let data;
  try { data = await response.json(); } catch { throw new DecisionError('Jev가 올바르지 않은 응답을 반환했습니다.'); }
  const answer = data?.answers?.placement;
  const finiteProbability = v => Number.isFinite(v) && v >= 0 && v <= 1;
  if (answer?.type !== 'choice' || !options.some(c => c.id === answer.choice) || !finiteProbability(answer.confidence) ||
    !answer.probabilities || typeof answer.probabilities !== 'object' ||
    Object.keys(answer.probabilities).length !== options.length ||
    !options.every(c => Object.hasOwn(answer.probabilities, c.id) && finiteProbability(answer.probabilities[c.id])) ||
    Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02) {
    throw new DecisionError('Jev의 선택 결과를 검증하지 못했습니다. 게임을 일시 정지했습니다.');
  }
  return { choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence,
    model: typeof data.model === 'string' ? data.model : model,
    latencyMs: Math.round(performance.now() - started),
    usage: { input_tokens: data.usage?.input_tokens ?? null, output_tokens: data.usage?.output_tokens ?? null }, source: 'jev' };
}

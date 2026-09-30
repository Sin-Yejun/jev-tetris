import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyBoard, SHAPES, rotate, rotations, candidates, fits, metrics, makeBag, validateState, fallTick, spawn } from '../public/engine.mjs';
import { buildRequest, decide } from '../jev.mjs';
import { createAppServer } from '../server.mjs';

const state = () => ({ board: emptyBoard(), piece: 'T', next: ['I', 'O', 'S'] });
test('gravity advances without a model answer and locks only after grounded delay', () => {
  const board = emptyBoard();
  let falling = { ...spawn('O'), fallMs: 0, groundMs: 0 };
  falling = fallTick(board, 'O', falling, 649, 650);
  assert.equal(falling.y, 0); assert.equal(falling.locked, false);
  falling = fallTick(board, 'O', falling, 1, 650);
  assert.equal(falling.y, 1);
  falling = { ...falling, y: 18, fallMs: 0, groundMs: 0 };
  falling = fallTick(board, 'O', falling, 499, 650);
  assert.equal(falling.locked, false); assert.equal(falling.y, 18);
  falling = fallTick(board, 'O', falling, 1, 650);
  assert.equal(falling.locked, true); assert.equal(falling.y, 18);
});
test('midair candidates start at current position and cannot cross a wall after falling', () => {
  const board = emptyBoard();
  for (let y = 10; y < 20; y++) board[y][2] = 'J';
  assert.ok(candidates(board, 'O').some(c => c.x === 0));
  const active = { x: 4, y: 12, rotation: 0 };
  const options = candidates(board, 'O', active);
  assert.ok(options.length); assert.ok(options.every(c => c.x >= 3 && c.y >= 12));
  for (const c of options) assert.deepEqual(c.path[0], active);
  assert.ok(validateState({ board, piece: 'O', next: [], active }));
  assert.ok(!validateState({ board, piece: 'O', next: [], active: { ...active, x: 2 } }));
  assert.ok(!validateState({ board, piece: 'O', next: [], active: { ...active, rotation: 9 } }));
});
test('API computes choices from the supplied falling position', async () => {
  const input = { ...state(), active: { x: 4, y: 12, rotation: 1 } };
  await decide(input, { apiKey: 'test', fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.state.active_piece, input.active);
    assert.deepEqual(Object.keys(body.questions.placement.criteria), candidates(input.board, input.piece, input.active).map(c => c.id));
    return Response.json(goodResponse(body));
  } });
});
function goodResponse(body, choice) {
  const ids = Object.keys(body.questions.placement.criteria);
  choice ??= ids.at(-1);
  return { model: 'jev-test', answers: { placement: { type: 'choice', choice, confidence: 1,
    probabilities: Object.fromEntries(ids.map(id => [id, id === choice ? 1 : 0])) } }, usage: { input_tokens: 123, output_tokens: 45 } };
}
test('tetromino rotations preserve four cells and cycle back', () => {
  for (const [piece, shape] of Object.entries(SHAPES)) {
    assert.equal(shape.flat().reduce((a, b) => a + b), 4);
    assert.deepEqual(rotate(rotate(rotate(rotate(shape)))), shape);
    for (const r of rotations(piece)) assert.equal(r.flat().reduce((a, b) => a + b), 4);
  }
  assert.equal(rotations('O').length, 1);
  assert.equal(rotations('I').length, 2);
});
test('empty board includes each legal top-row placement exactly once', () => {
  const board = emptyBoard();
  assert.equal(candidates(board, 'T').length, 34);
  assert.equal(candidates(board, 'I').length, 17);
  assert.equal(candidates(board, 'O').length, 9);
  for (const piece of Object.keys(SHAPES)) {
    const options = candidates(board, piece);
    assert.equal(new Set(options.map(c => c.id)).size, options.length);
    for (const c of options) {
      assert.ok(fits(board, c.shape, c.x, c.y));
      assert.ok(!fits(board, c.shape, c.x, c.y + 1));
      assert.equal(c.board.flat().filter(Boolean).length, 4);
    }
  }
  assert.deepEqual(board, emptyBoard());
});
test('vertical I clears four rows and leaves an empty board', () => {
  const board = emptyBoard();
  for (let y = 16; y < 20; y++) board[y] = [...Array(9).fill('J'), 0];
  const choice = candidates(board, 'I').find(c => c.id === 'r1x9');
  assert.equal(choice.cleared, 4);
  assert.deepEqual(choice.board, emptyBoard());
  assert.equal(board.flat().filter(Boolean).length, 36);
});
test('blocked spawn is game over; placements never cross blocked top-row cells', () => {
  const board = emptyBoard(); board[0][4] = 'O';
  assert.equal(candidates(board, 'O').length, 0);
  const divided = emptyBoard(); divided[0][2] = 'O';
  assert.ok(candidates(divided, 'O').every(c => c.x >= 3));
});
test('board metrics count buried holes and column heights', () => {
  const board = emptyBoard(); board[17][0] = 'I'; board[19][0] = 'I';
  const m = metrics(board);
  assert.equal(m.holes, 1); assert.equal(m.maxHeight, 3); assert.equal(m.aggregateHeight, 3); assert.equal(m.bumpiness, 3);
});
test('seven-bag delivers each piece once per bag', () => {
  const draw = makeBag(() => 0.43);
  for (let i = 0; i < 10; i++) assert.deepEqual(Array.from({ length: 7 }, draw).sort(), Object.keys(SHAPES).sort());
});
test('seeded simulation maintains reachable placements, dimensions, and cell accounting', () => {
  let seed = 42;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const draw = makeBag(random);
  let board = emptyBoard(), lines = 0, count = 0;
  for (; count < 250; count++) {
    const piece = draw(), options = candidates(board, piece);
    if (!options.length) break;
    // Test-only policy keeps the simulation alive; production always uses Jev.
    const value = c => c.cleared * .76 - c.metrics.aggregateHeight * .51 - c.metrics.holes * .36 - c.metrics.bumpiness * .18;
    const selected = [...options].sort((a, b) => value(b) - value(a))[0];
    for (const node of selected.path) assert.ok(fits(board, rotations(piece)[node.rotation], node.x, node.y));
    board = selected.board; lines += selected.cleared;
    assert.equal(board.length, 20); assert.ok(board.every(row => row.length === 10));
    assert.equal(board.flat().filter(Boolean).length, 4 * (count + 1) - lines * 10);
  }
  assert.ok(count > 50); assert.ok(lines > 10);
});
test('state validation rejects malformed dimensions, pieces, and coercible values', () => {
  assert.ok(validateState(state()));
  assert.ok(!validateState({ ...state(), piece: '__proto__' }));
  assert.ok(!validateState({ ...state(), board: [[0]] }));
  const bad = state(); bad.board[0][0] = ['T']; assert.ok(!validateState(bad));
  assert.ok(!validateState({ ...state(), next: ['X'] }));
});
test('Jev contract sends every legal option and applies its actual choice', async () => {
  const input = state(), options = candidates(input.board, input.piece);
  const result = await decide(input, { apiKey: 'test-only-key', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.headers.Authorization, 'Bearer test-only-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'jev-latest'); assert.equal(body.questions.placement.type, 'choice');
    assert.equal(Object.keys(body.questions.placement.criteria).length, options.length);
    return Response.json(goodResponse(body, options[8].id));
  } });
  assert.equal(result.choice, options[8].id); assert.equal(result.source, 'jev'); assert.equal(result.confidence, 1);
  assert.equal(result.usage.input_tokens, 123); assert.ok(result.latencyMs >= 0);
});
test('prompt describes simulated holes and clears while preserving every candidate', () => {
  const input = state(); input.piece = 'I';
  for (let y = 16; y < 20; y++) input.board[y] = [...Array(9).fill('J'), 0];
  const options = candidates(input.board, input.piece);
  const request = buildRequest(input, options, 'test');
  const criteria = request.questions.placement.criteria;
  assert.deepEqual(Object.keys(criteria), options.map(c => c.id));
  assert.equal(criteria.r1x9.buried_empty_cells, 'Leaves no buried holes.');
  assert.equal(criteria.r1x9.row_clears, 'Immediately clears 4 complete rows.');
  assert.match(request.state.hole_definition, /well.*NOT a buried hole/);
  const covered = options.find(c => c.metrics.holes > 0);
  assert.ok(covered);
  assert.match(criteria[covered.id].buried_empty_cells, new RegExp(`${covered.metrics.holes} more than before`));
});
test('missing key, invalid selection, rate limits, and network failures stop instead of using demo', async () => {
  await assert.rejects(decide(state(), { apiKey: '' }), error => error.status === 503);
  await assert.rejects(decide(state(), { apiKey: 'test', fetchImpl: async () => Response.json({ error: 'secret upstream detail' }, { status: 401 }) }), /유효하지/);
  await assert.rejects(decide(state(), { apiKey: 'test', fetchImpl: async () => new Response('', { status: 429 }) }), error => error.status === 429);
  await assert.rejects(decide(state(), { apiKey: 'test', fetchImpl: async () => { throw new Error('network'); } }), error => error.status === 504);
  await assert.rejects(decide(state(), { apiKey: 'test', fetchImpl: async (_, init) => {
    const response = goodResponse(JSON.parse(init.body)); response.answers.placement.choice = 'illegal'; return Response.json(response);
  } }), /검증/);
  await assert.rejects(decide(state(), { apiKey: 'test', fetchImpl: async (_, init) => {
    const response = goodResponse(JSON.parse(init.body)); response.answers.placement.probabilities = { fake: 1 }; return Response.json(response);
  } }), /검증/);
});
test('HTTP server serves the UI, keeps secrets private, validates state, and proxies valid requests', async t => {
  let calls = 0;
  const server = createAppServer({ apiKey: '', fetchImpl: async (_, init) => { calls++; assert.equal(init.headers.Authorization, 'Bearer visitor-test-key'); return Response.json(goodResponse(JSON.parse(init.body))); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /Jev Tetris/);
  const status = await fetch(`${base}/api/status`); const statusText = await status.text();
  assert.ok(!statusText.includes('test-secret')); assert.equal(JSON.parse(statusText).serverKeyConfigured, false);
  for (const path of ['/.env', '/server.mjs', '/.agents/skills/typesafe-ai/SKILL.md']) assert.equal((await fetch(base + path)).status, 404);
  const post = (body, headers = {}) => fetch(`${base}/api/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify({}))).status, 400);
  assert.equal((await post(JSON.stringify(state()), { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await post(JSON.stringify(state()))).status, 401);
  assert.equal(calls, 0);
  const response = await post(JSON.stringify(state()), { Authorization: 'Bearer visitor-test-key' }); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.source, 'jev'); assert.equal(calls, 1);
  assert.ok(candidates(state().board, 'T').some(c => c.id === result.choice));
});
test('configured server key takes priority without being exposed to the browser', async t => {
  const server = createAppServer({ apiKey: 'server-test-secret', fetchImpl: async (_, init) => {
    assert.equal(init.headers.Authorization, 'Bearer server-test-secret');
    return Response.json(goodResponse(JSON.parse(init.body)));
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(base + '/api/status')).text();
  assert.equal(JSON.parse(status).serverKeyConfigured, true);
  assert.ok(!status.includes('server-test-secret'));
  for (const headers of [{}, { Authorization: 'Bearer visitor-test-key' }]) {
    const response = await fetch(base + '/api/decision', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(state()) });
    assert.equal(response.status, 200);
  }
});

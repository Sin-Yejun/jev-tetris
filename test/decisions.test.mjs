import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionsRequest, decideOpenAI } from '../decisions.mjs';
import { buildRequest } from '../jev.mjs';
import { candidates, emptyBoard } from '../public/engine.mjs';
import { createAppServer } from '../server.mjs';

const state = () => ({ board: emptyBoard(), piece: 'T', next: ['I', 'O', 'S'], pace: 'response' });
function reply(body) {
  const openai = Array.isArray(body.questions);
  const ids = openai ? body.questions[0].choices.map(c => c.value) : Object.keys(body.questions.placement.criteria);
  const answer = { type: 'choice', choice: ids[0], confidence: 1,
    probabilities: Object.fromEntries(ids.map((id, i) => [id, i ? 0 : 1])) };
  return { model: body.model, answers: openai ? [{ ...answer, name: 'placement', probabilities: ids.map((value, i) => ({ value, probability: i ? 0 : 1 })) }] : { placement: answer }, usage: { input_tokens: 100, output_tokens: 0 } };
}

test('Decisions carries identical Jev evidence and every placement, and normalizes real API format', async () => {
  const options = candidates(state().board, 'T');
  const shared = buildRequest(state(), options, 'jev-latest');
  const request = buildDecisionsRequest(state(), options);
  assert.equal(request.model, 'gpt-6-luna');
  assert.deepEqual(JSON.parse(request.input), shared.state);
  assert.deepEqual(JSON.parse(request.questions[0].instructions), shared.questions.placement.instructions);
  assert.deepEqual(Object.fromEntries(request.questions[0].choices.map(c => [c.value, JSON.parse(c.description)])), shared.questions.placement.criteria);
  assert.match(shared.state.game, /waits for this decision/);
  const result = await decideOpenAI(state(), { apiKey: 'openai-test', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    assert.equal(init.headers.Authorization, 'Bearer openai-test');
    return Response.json(reply(JSON.parse(init.body)));
  } });
  assert.equal(result.source, 'decisions');
  assert.equal(result.probabilities[result.choice], 1);
  assert.ok(result.latencyMs >= 0);
});

test('Decisions stops for refusals, malformed distributions, HTTP errors and cancellation', async () => {
  await assert.rejects(decideOpenAI(state(), { apiKey: '' }), e => e.status === 503);
  for (const mutate of [
    d => { d.answers[0].type = 'refusal'; },
    d => { d.answers[0].choice = 'illegal'; },
    d => { d.answers[0].probabilities.pop(); },
    d => { d.answers[0].probabilities[1] = d.answers[0].probabilities[0]; },
    d => { d.answers[0].probabilities[0].probability = 2; },
  ]) await assert.rejects(decideOpenAI(state(), { apiKey: 'test', fetchImpl: async (_, init) => {
    const data = reply(JSON.parse(init.body)); mutate(data); return Response.json(data);
  } }));
  await assert.rejects(decideOpenAI(state(), { apiKey: 'test', fetchImpl: async () => Response.json({ error: 'secret' }, { status: 401 }) }), /유효하지/);
  await assert.rejects(decideOpenAI(state(), { apiKey: 'test', fetchImpl: async () => new Response('', { status: 429 }) }), e => e.status === 429);
  await assert.rejects(decideOpenAI(state(), { apiKey: 'test', fetchImpl: async () => { throw new Error(); } }), e => e.status === 504);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(decideOpenAI(state(), { apiKey: 'test', signal: controller.signal,
    fetchImpl: async (_, init) => { init.signal.throwIfAborted(); } }), e => e.name === 'AbortError');
});

test('server allows concurrent providers, prevents same-provider overlap, isolates keys, releases after abort', async t => {
  let releaseJev, notifyJev;
  const entered = new Promise(resolve => { notifyJev = resolve; });
  const server = createAppServer({ apiKey: 'jev-secret', openaiKey: 'openai-secret', fetchImpl: async (url, init) => {
    if (url.includes('typesafe')) {
      assert.equal(init.headers.Authorization, 'Bearer jev-secret'); notifyJev();
      await new Promise((resolve, reject) => { releaseJev = resolve; init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
    } else assert.equal(init.headers.Authorization, 'Bearer openai-secret');
    return Response.json(reply(JSON.parse(init.body)));
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(base + '/api/status')).text();
  assert.ok(!status.includes('secret')); assert.ok(JSON.parse(status).providers.decisions.serverKeyConfigured);
  const post = (provider, signal) => fetch(base + '/api/decision/' + provider, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state()), signal });
  const first = post('jev'); await entered;
  assert.equal((await post('jev')).status, 429);
  assert.equal((await post('decisions')).status, 200);
  releaseJev(); assert.equal((await first).status, 200);
  const controller = new AbortController();
  const aborted = post('jev', controller.signal);
  await new Promise(resolve => setTimeout(resolve, 20)); controller.abort();
  await assert.rejects(aborted);
  await new Promise(resolve => setTimeout(resolve, 20));
  const retry = post('jev'); await new Promise(resolve => setTimeout(resolve, 20)); releaseJev();
  assert.equal((await retry).status, 200);
  assert.equal((await post('decisions')).status, 200);
});

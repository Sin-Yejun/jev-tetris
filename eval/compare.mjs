import { writeFile } from 'node:fs/promises';
import { emptyBoard, candidates, metrics, fits, spawn, SHAPES } from '../public/engine.mjs';
import { buildRequest as baseline } from './baseline-request.mjs';
import { buildRequest as revised } from '../jev.mjs';

// Fixed cases, not a win-rate benchmark. Both prompts see identical option order.
const skyline = heights => emptyBoard().map((row, y) => row.map((_, x) => y >= 20 - heights[x] ? 'J' : 0));
const cases = [
  ['empty-T', 'T', Array(10).fill(0)],
  ['empty-Z', 'Z', Array(10).fill(0)],
  ['empty-S', 'S', Array(10).fill(0)],
  ['steps-L', 'L', [2,2,3,3,1,1,0,0,0,0]],
  ['steps-J', 'J', [0,0,0,0,1,1,3,3,2,2]],
  ['well-I', 'I', [4,4,4,4,4,4,4,4,4,0]],
  ['valley-O', 'O', [3,3,1,1,3,3,2,2,0,0]],
  ['rough-T', 'T', [0,2,3,1,2,4,3,3,1,1]],
  ['high-I', 'I', [15,15,15,15,15,15,15,15,15,0]],
  ['rough-S', 'S', [2,2,1,1,3,2,2,0,1,1]],
  ['rough-Z', 'Z', [1,1,0,2,2,3,1,1,2,2]],
  ['buried-L', 'L', [0,2,2,3,3,1,1,2,2,2]],
].map(([name, piece, heights]) => ({ name, board: skyline(heights), piece, next: ['I','O','T'] }));
cases.at(-1).board[19][3] = 0;
if (!process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY required');
const results = [];
for (const state of cases) {
  const options = candidates(state.board, state.piece);
  for (const [version, builder] of [['baseline', baseline], ['revised', revised]]) {
    const start = performance.now();
    const response = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
      body: JSON.stringify(builder(state, options, 'jev-1.13.0')), signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) throw new Error(`API HTTP ${response.status}`);
    const data = await response.json();
    const chosen = options.find(c => c.id === data.answers?.placement?.choice);
    if (!chosen) throw new Error('Invalid selection');
    const alive = c => fits(c.board, SHAPES.I, spawn('I').x, 0);
    // A conservative diagnostic: an alternative has fewer holes, at least as
    // many immediate clears, no taller stack, and no worse spawn survival.
    const avoidable = options.some(c => c.metrics.holes < chosen.metrics.holes && c.cleared >= chosen.cleared &&
      c.metrics.maxHeight <= chosen.metrics.maxHeight && Number(alive(c)) >= Number(alive(chosen)));
    const row = { case: state.name, version, model: data.model, choice: chosen.id,
      holesBefore: metrics(state.board).holes, holesAfter: chosen.metrics.holes,
      cleared: chosen.cleared, maxHeight: chosen.metrics.maxHeight, avoidable,
      latencyMs: Math.round(performance.now() - start), usage: data.usage };
    results.push(row); console.log(JSON.stringify(row));
  }
}
const summary = Object.fromEntries(['baseline', 'revised'].map(version => {
  const rows = results.filter(r => r.version === version);
  return [version, { cases: rows.length, avoidableHoleChoices: rows.filter(r => r.avoidable).length,
    totalResultingHoles: rows.reduce((s,r) => s+r.holesAfter,0), immediateClears: rows.reduce((s,r) => s+r.cleared,0),
    meanLatencyMs: Math.round(rows.reduce((s,r) => s+r.latencyMs,0)/rows.length) }];
}));
await writeFile(new URL('./results.json', import.meta.url), JSON.stringify({ recordedAt: new Date().toISOString(), summary, results }, null, 2));
console.log(JSON.stringify(summary));

import test from 'node:test';
import assert from 'node:assert/strict';
import { distribution, percent, duration, estimateCost, dollars } from '../public/analysis.mjs';

test('cost charges only known-model input tokens and preserves tiny amounts until display', () => {
  assert.equal(estimateCost('jev-1.13.0', { input_tokens: 1_000_000, output_tokens: 500 }), .042);
  assert.equal(estimateCost('jev-1.13.0', { input_tokens: 0 }), 0);
  assert.equal(estimateCost('unknown', { input_tokens: 100 }), null);
  assert.equal(estimateCost('jev-1.13.0', {}), null);
  assert.equal(estimateCost('jev-1.13.0', { input_tokens: -1 }), null);
  const small = estimateCost('jev-1.13.0', { input_tokens: 1000 });
  assert.equal(dollars(small), '<$0.0001');
  assert.equal(dollars(small * 10), '$0.0004');
  assert.equal(dollars(0), '$0.0000');
});

test('column and rotation probabilities are marginals of the same distribution', () => {
  const options = [{ id: 'a', x: 0, rotation: 0 }, { id: 'b', x: 0, rotation: 1 }, { id: 'c', x: 3, rotation: 0 }];
  const result = distribution(options, { a: .2, b: .3, c: .5 });
  assert.deepEqual(result.columns, [.5, 0, 0, .5, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(result.rotations, [.7, .3, 0, 0]);
  assert.equal(result.columns.reduce((a, b) => a + b), 1);
  assert.equal(result.rotations.reduce((a, b) => a + b), 1);
});
test('missing data has no synthetic probabilities and small probabilities remain distinguishable from zero', () => {
  assert.equal(distribution([], undefined), null);
  assert.equal(percent(undefined), '—'); assert.equal(percent(0), '0.0%'); assert.equal(percent(.00001), '<0.1%');
  assert.equal(percent(.321), '32.1%');
  assert.equal(duration(undefined), '—'); assert.equal(duration(342), '342 ms'); assert.equal(duration(1245), '1.25 s');
});

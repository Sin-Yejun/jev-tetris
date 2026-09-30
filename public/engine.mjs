export const WIDTH = 10;
export const HEIGHT = 20;
export const SHAPES = {
  I: [[1, 1, 1, 1]], O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1]], S: [[0, 1, 1], [1, 1, 0]],
  Z: [[1, 1, 0], [0, 1, 1]], J: [[1, 0, 0], [1, 1, 1]],
  L: [[0, 0, 1], [1, 1, 1]],
};
export const COLORS = { I: '#7fdbe2', O: '#ead17c', T: '#b7a0e5', S: '#bde782', Z: '#e99291', J: '#87a7e4', L: '#e8b180' };
export const emptyBoard = () => Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(0));
export const rotate = shape => shape[0].map((_, x) => shape.map(row => row[x]).reverse());
export function rotations(piece) {
  const result = [];
  let shape = SHAPES[piece];
  for (let i = 0; i < 4; i++, shape = rotate(shape)) {
    if (!result.some(s => JSON.stringify(s) === JSON.stringify(shape))) result.push(shape);
  }
  return result;
}
export function fits(board, shape, x, y) {
  return shape.every((row, dy) => row.every((cell, dx) => !cell ||
    (x + dx >= 0 && x + dx < WIDTH && y + dy >= 0 && y + dy < HEIGHT && !board[y + dy][x + dx])));
}
export const spawn = piece => ({ x: Math.floor((WIDTH - SHAPES[piece][0].length) / 2), y: 0, rotation: 0 });
export function clearLines(board) {
  const remaining = board.filter(row => !row.every(Boolean));
  const cleared = HEIGHT - remaining.length;
  return { board: [...Array.from({ length: cleared }, () => Array(WIDTH).fill(0)), ...remaining.map(row => [...row])], cleared };
}
export function metrics(board) {
  const heights = Array(WIDTH).fill(0);
  let holes = 0;
  for (let x = 0; x < WIDTH; x++) {
    const first = board.findIndex(row => row[x]);
    if (first === -1) continue;
    heights[x] = HEIGHT - first;
    for (let y = first + 1; y < HEIGHT; y++) if (!board[y][x]) holes++;
  }
  return { heights, holes, maxHeight: Math.max(...heights), aggregateHeight: heights.reduce((a, b) => a + b, 0),
    bumpiness: heights.slice(1).reduce((sum, h, i) => sum + Math.abs(h - heights[i]), 0) };
}
// Enumerate moves/rotations reachable at the current height, then project landing.
// The realtime controller rechecks reachability as gravity changes the position.
export function candidates(board, piece, initial = spawn(piece)) {
  const shapes = rotations(piece);
  if (!fits(board, shapes[initial.rotation], initial.x, initial.y)) return [];
  const queue = [{ ...initial, path: [initial] }];
  const seen = new Set([`${initial.x}:${initial.rotation}`]);
  const result = [];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i], shape = shapes[node.rotation];
    let y = initial.y;
    while (fits(board, shape, node.x, y + 1)) y++;
    const placed = board.map(row => [...row]);
    shape.forEach((row, dy) => row.forEach((v, dx) => { if (v) placed[y + dy][node.x + dx] = piece; }));
    const outcome = clearLines(placed);
    result.push({ id: `r${node.rotation}x${node.x}`, x: node.x, y, rotation: node.rotation,
      shape, path: node.path, board: outcome.board, cleared: outcome.cleared, metrics: metrics(outcome.board) });
    for (const [x, rotation] of [[node.x - 1, node.rotation], [node.x + 1, node.rotation], [node.x, (node.rotation + 1) % shapes.length]]) {
      const key = `${x}:${rotation}`;
      if (seen.has(key) || !fits(board, shapes[rotation], x, initial.y)) continue;
      seen.add(key);
      queue.push({ x, y: initial.y, rotation, path: [...node.path, { x, y: initial.y, rotation }] });
    }
  }
  return result;
}
export function fallTick(board, piece, falling, dt, interval) {
  const next = { ...falling, fallMs: falling.fallMs + dt };
  const shape = rotations(piece)[next.rotation];
  while (next.fallMs >= interval) {
    next.fallMs -= interval;
    if (fits(board, shape, next.x, next.y + 1)) next.y++;
  }
  next.groundMs = fits(board, shape, next.x, next.y + 1) ? 0 : next.groundMs + dt;
  return { ...next, locked: next.groundMs >= 500 };
}
export function makeBag(random = Math.random) {
  let bag = [];
  return () => {
    if (!bag.length) {
      bag = Object.keys(SHAPES);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.pop();
  };
}
export function validateState(value) {
  return value && Array.isArray(value.board) && value.board.length === HEIGHT &&
    value.board.every(row => Array.isArray(row) && row.length === WIDTH && row.every(v => v === 0 || (typeof v === 'string' && Object.hasOwn(SHAPES, v)))) &&
    typeof value.piece === 'string' && Object.hasOwn(SHAPES, value.piece) &&
    Array.isArray(value.next) && value.next.length <= 5 && value.next.every(p => typeof p === 'string' && Object.hasOwn(SHAPES, p)) &&
    (value.active == null || (Number.isInteger(value.active.x) && value.active.x >= 0 && value.active.x < WIDTH &&
      Number.isInteger(value.active.y) && value.active.y >= 0 && value.active.y < HEIGHT &&
      Number.isInteger(value.active.rotation) && value.active.rotation >= 0 && value.active.rotation < rotations(value.piece).length &&
      fits(value.board, rotations(value.piece)[value.active.rotation], value.active.x, value.active.y)));
}

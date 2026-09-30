import { metrics } from '../public/engine.mjs';
export function buildRequest(state, options, model) {
  return {
    model,
    state: {
      game: 'Tetris placement variant: 10 columns, 20 rows; no hold or wall kicks. Rotate/move at the top, then hard-drop. Each full row clears.',
      board: state.board.map(row => row.map(c => c ? '#' : '.').join('')),
      coordinates: 'Rows run top to bottom; columns are zero-based left to right.',
      current_piece: state.piece, next_pieces: state.next,
      current_metrics: metrics(state.board),
      metric_definitions: { holes: 'Empty cells below occupied cells: smaller is better.', maxHeight: 'Tallest occupied column: 20 is the ceiling.',
        aggregateHeight: 'Sum of column heights: smaller is safer.', bumpiness: 'Sum of neighboring height differences: smaller is flatter.',
        cleared: 'Full rows removed immediately by this placement.' },
    },
    questions: {
      placement: {
        type: 'choice',
        instructions: 'Which legal placement best supports surviving and clearing lines in Tetris? Compare the computed outcomes in the options. Prioritize avoiding buried holes and dangerously tall stacks, then clearing lines and maintaining a low, flat surface. Consider the next pieces when useful. Choose exactly one available placement; all options are legal. Metrics describe the board AFTER line clearing. Do not infer a hidden heuristic ranking from option order.',
        criteria: Object.fromEntries(options.map(c => [c.id, { column: c.x, clockwise_rotations: c.rotation, landing_row: c.y,
          cleared: c.cleared, ...c.metrics }])),
      },
    },
  };
}

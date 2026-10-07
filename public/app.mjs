import { WIDTH, HEIGHT, SHAPES, COLORS, emptyBoard, rotations, spawn, fits, candidates, makeBag, metrics, fallTick } from './engine.mjs';
import { distribution, percent, duration, estimateCost, dollars } from './analysis.mjs';

const global = id => document.getElementById(id);
let sequence = [], bag = makeBag();
function nextAt(index) { while (sequence.length <= index) sequence.push(bag()); return sequence[index]; }
const players = [];
const snapshots = {};
let lastResultKey = '', lastReport = null;
function clearResult() {
  lastResultKey = ''; lastReport = null;
  global('result-dialog').close(); global('show-result').hidden = true;
}
function showResult() {
  if (!lastReport) return;
  const { jev: a, decisions: b, limit, pace } = lastReport;
  global('result-subtitle').textContent = `${Number.isFinite(limit) ? `각 API ${limit}회 한도` : '무제한'} / ${pace === 'response' ? '응답 즉시 배치' : '중력 낙하'}`;
  const leader = (x, y, lower = false) => x == null || y == null ? '측정 없음' : x === y ? '동일' : (lower ? x < y : x > y) ? 'JEV' : 'Decisions';
  global('result-score-leader').textContent = leader(a.score, b.score);
  global('result-speed-leader').textContent = leader(a.average, b.average, true);
  global('result-pace-leader').textContent = leader(a.throughput, b.throughput);
  const endLabel = s => s.errorText ? '연결 오류' : s.endReason === 'limit' ? '한도 도달' : '게임 종료';
  const costLabel = s => dollars(s.gameCost.usd) + (s.gameCost.incomplete ? ' + 미확인' : '');
  const rows = [
    ['점수', a.score.toLocaleString(), b.score.toLocaleString(), a.score, b.score, false],
    ['제거 줄', a.lines + '줄', b.lines + '줄'],
    ['배치 블록', a.pieces + '개', b.pieces + '개'],
    ['평균 응답', duration(a.average), duration(b.average), a.average, b.average, true],
    ['최대 응답', duration(a.maxLatency), duration(b.maxLatency)],
    ['분당 배치', a.throughput?.toFixed(1) ?? '—', b.throughput?.toFixed(1) ?? '—', a.throughput, b.throughput, false],
    ['플레이 시간', (a.playMs / 1000).toFixed(1) + ' s', (b.playMs / 1000).toFixed(1) + ' s'],
    ['API 호출 / 응답', `${a.calls} / ${a.responses}회`, `${b.calls} / ${b.responses}회`],
    ['이번 게임 예상 비용', costLabel(a), costLabel(b)],
    ['종료 상태', endLabel(a), endLabel(b)],
    ['모델', a.model, b.model],
  ];
  global('result-rows').replaceChildren(...rows.map(([label, x, y, rawX, rawY, lower]) => {
    const row = document.createElement('tr');
    const heading = document.createElement('th'); heading.scope = 'row'; heading.textContent = label; row.append(heading);
    [x, y].forEach((value, index) => {
      const cell = document.createElement('td'); cell.textContent = value;
      if (rawX != null && rawY != null && rawX !== rawY) cell.classList.toggle('result-leading', index === (lower ? rawX < rawY ? 0 : 1 : rawX > rawY ? 0 : 1));
      row.append(cell);
    }); return row;
  }));
  const early = [a, b].some(s => s.endReason !== 'limit');
  global('result-note').textContent = early
    ? '한쪽이 게임 종료 또는 연결 오류로 먼저 멈췄습니다. 배치 수와 응답 수가 다를 수 있으니 함께 비교하세요.'
    : '두 플레이어가 설정한 호출 한도까지 진행한 결과입니다.';
  global('result-errors').textContent = [a.errorText && `JEV: ${a.errorText}`, b.errorText && `Decisions: ${b.errorText}`].filter(Boolean).join(' / ');
  if (!global('result-dialog').open) global('result-dialog').showModal();
}
function maybeShowResult() {
  const a = snapshots.jev, b = snapshots.decisions;
  if (![a, b].every(s => s && !s.running && !s.clockRunning && (s.endReason || s.errorText) && s.calls > 0)) return;
  const key = `${a.round}:${a.calls}:${a.endReason}:${a.errorText}|${b.round}:${b.calls}:${b.endReason}:${b.errorText}`;
  if (key === lastResultKey) return;
  lastResultKey = key;
  lastReport = structuredClone({ jev: a, decisions: b, limit: Number(global('turn-limit').value), pace: global('pace').value });
  global('show-result').hidden = false;
  showResult();
}
function highlightComparison() {
  const a = snapshots.jev, b = snapshots.decisions;
  for (const provider of ['jev', 'decisions']) {
    const current = snapshots[provider], other = snapshots[provider === 'jev' ? 'decisions' : 'jev'];
    if (!current) continue;
    const scoreLead = other && current.score > other.score;
    const faster = a?.average != null && b?.average != null && current.average < other.average;
    const fasterPace = other && current.throughput != null && other.throughput != null && current.throughput > other.throughput;
    for (const [metric, lead] of [['score', scoreLead], ['average', faster], ['throughput', fasterPace]]) {
      global(provider + '-compare-' + metric).parentElement.classList.toggle('leading', Boolean(lead));
    }
    global(provider + '-leader').textContent = [scoreLead && '점수 선두', faster && '응답 빠름'].filter(Boolean).join(' / ');
  }
}
function createPlayer(root, provider) {
const label = provider === 'jev' ? 'Jev' : 'Decisions';
const $ = id => root.querySelector('#' + provider + '-' + id);
let pieceIndex = 0;
const nextPiece = () => nextAt(pieceIndex++);
const responsePace = () => global('pace').value === 'response';
const canvas = $('board'), ctx = canvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const effectLayer = document.createElement('div');
effectLayer.className = 'board-effects'; effectLayer.setAttribute('aria-hidden', 'true');
canvas.parentElement.append(effectLayer);
const effects = new Set();
function clearEffects() {
  for (const dispose of [...effects]) dispose();
}
function effect(element, frames, duration) {
  effectLayer.append(element);
  let animation, timeout;
  const dispose = () => { animation?.cancel(); clearTimeout(timeout); element.remove(); effects.delete(dispose); };
  effects.add(dispose);
  if (reducedMotion.matches) timeout = setTimeout(dispose, duration);
  else {
    animation = element.animate(frames, { duration, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' });
    animation.finished.then(dispose, () => {});
  }
}
function landingEffect(placement, piece, previousBoard) {
  clearEffects();
  const placed = previousBoard.map(row => [...row]);
  placement.shape.forEach((row, dy) => row.forEach((v, dx) => {
    if (!v) return;
    const x = placement.x + dx, y = placement.y + dy;
    placed[y][x] = piece;
    if (reducedMotion.matches) return;
    const flash = document.createElement('i'); flash.className = 'landing-flash';
    Object.assign(flash.style, { left: `${x * 10}%`, top: `${y * 5}%`, width: '10%', height: '5%', borderColor: COLORS[piece] });
    effect(flash, [{ opacity: .9 }, { opacity: 0 }], 180);
  }));
  if (!placement.cleared) return;
  if (!reducedMotion.matches) placed.forEach((row, y) => {
    if (!row.every(Boolean)) return;
    const sweep = document.createElement('i'); sweep.className = 'line-sweep'; sweep.style.top = `${y * 5}%`;
    effect(sweep, [{ opacity: .75, transform: 'scaleX(.15)' }, { opacity: .35, offset: .3, transform: 'scaleX(1)' }, { opacity: 0, transform: 'scaleX(1)' }], 380);
    row.forEach((color, x) => {
      const shard = document.createElement('i'); shard.className = 'clear-shard';
      Object.assign(shard.style, { left: `${x * 10 + 2}%`, top: `${y * 5 + 1}%`, background: COLORS[color] });
      effect(shard, [{ opacity: .9, transform: 'translate(0,0) scale(1)' },
        { opacity: 0, transform: `translate(${(x - 4.5) * 5}px,${-12 - (x % 3) * 8}px) rotate(${(x - 4) * 15}deg) scale(.2)` }], 480);
    });
  });
  const popup = document.createElement('div'); popup.className = 'clear-popup';
  const title = document.createElement('span'); title.textContent = placement.cleared === 4 ? 'TETRIS!' : `${placement.cleared}줄 클리어`;
  const points = document.createElement('strong'); points.textContent = `+${[0,100,300,500,800][placement.cleared]}`;
  popup.append(title, points);
  effect(popup, [{ opacity: 0, transform: 'translateY(8px) scale(.95)' },
    { opacity: 1, transform: 'translateY(0) scale(1)', offset: .15 },
    { opacity: 1, transform: 'translateY(-4px)', offset: .7 },
    { opacity: 0, transform: 'translateY(-12px)' }], 850);
}
reducedMotion.addEventListener('change', clearEffects);

let board, queue, drawPiece, pieces, lines, score, history, calls, tokens, elapsed, timer;
let running = false, busy = false, epoch = 0, controller, active = null, target = null, lastDecision = null;
let configured = false, model = provider === 'jev' ? 'jev-latest' : 'gpt-6-luna', statusReady = false, statusUnavailable = false;
let sessionApiKey = '';
let serverKeyConfigured = false;
let phase = '준비', errorText = '', endReason = '';
let requestStarted = 0, latencySamples = [];
let totalPlayMs = 0, playStarted = 0;
let round = 0, gameCost = { usd: 0, incomplete: false };
const playMs = () => totalPlayMs + (playStarted ? performance.now() - playStarted : 0);
function finishClock() { if (playStarted) totalPlayMs += performance.now() - playStarted; playStarted = 0; }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = (id, value) => { if ($(id).textContent !== String(value)) $(id).textContent = value; };
const pad = value => String(value).padStart(3, '0');
let cost = { usd: 0, incomplete: false };
try {
  const saved = JSON.parse(sessionStorage.getItem(provider + '-cost-v1'));
  if (Number.isFinite(saved?.usd) && saved.usd >= 0) cost = { usd: saved.usd, incomplete: saved.incomplete === true };
} catch { /* Storage can be unavailable; keep counting in memory. */ }
function recordCost(result, requestCost) {
  const amount = result ? estimateCost(result.model, result.usage) : null;
  if (amount == null) { cost.incomplete = true; requestCost.incomplete = true; }
  else { cost.usd += amount; requestCost.usd += amount; }
  try { sessionStorage.setItem(provider + '-cost-v1', JSON.stringify(cost)); } catch { /* In-memory total remains available. */ }
  renderCost();
}
function renderCost() {
  text('cost', dollars(cost.usd));
  global(provider + '-compare-cost').textContent = dollars(cost.usd);
  global(provider + '-cost-note').textContent = cost.incomplete ? '일부 요청의 사용량 미확인' : '같은 탭의 누적 예상 비용';
}
function mini(piece) {
  const shape = SHAPES[piece];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${shape[0].length * 12} ${shape.length * 12}`);
  svg.setAttribute('aria-hidden', 'true');
  shape.forEach((row, y) => row.forEach((v, x) => {
    if (!v) return;
    const r = document.createElementNS(svg.namespaceURI, 'rect');
    for (const [key, value] of Object.entries({ x: x * 12 + 1, y: y * 12 + 1, width: 10, height: 10, rx: 1, fill: COLORS[piece] })) r.setAttribute(key, value);
    svg.append(r);
  }));
  return svg;
}
function cell(x, y, color, ghost = false) {
  const size = 60;
  if (ghost) {
    ctx.fillStyle = `${color}14`; ctx.fillRect(x * size + 3, y * size + 3, size - 6, size - 6);
    ctx.strokeStyle = `${color}99`; ctx.lineWidth = 2; ctx.strokeRect(x * size + 4, y * size + 4, size - 8, size - 8);
  } else {
    ctx.fillStyle = color; ctx.fillRect(x * size + 3, y * size + 3, size - 6, size - 6);
    ctx.fillStyle = '#ffffff32'; ctx.fillRect(x * size + 3, y * size + 3, size - 6, 5);
    ctx.fillStyle = '#00000018'; ctx.fillRect(x * size + 3, y * size + size - 9, size - 6, 6);
  }
}
function paintShape(piece, shape, x, y, ghost = false) {
  shape.forEach((row, dy) => row.forEach((v, dx) => { if (v) cell(x + dx, y + dy, COLORS[piece], ghost); }));
}
function draw() {
  ctx.fillStyle = '#141712'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#242a20'; ctx.lineWidth = 1;
  for (let x = 1; x < WIDTH; x++) { ctx.beginPath(); ctx.moveTo(x * 60, 0); ctx.lineTo(x * 60, 1200); ctx.stroke(); }
  for (let y = 1; y < HEIGHT; y++) { ctx.beginPath(); ctx.moveTo(0, y * 60); ctx.lineTo(600, y * 60); ctx.stroke(); }
  board.forEach((row, y) => row.forEach((v, x) => { if (v) cell(x, y, COLORS[v]); }));
  const current = active || spawn(queue[0]), shape = rotations(queue[0])[current.rotation];
  if (fits(board, shape, current.x, current.y)) {
    let ghostY = current.y;
    while (fits(board, shape, current.x, ghostY + 1)) ghostY++;
    const ghost = target || { x: current.x, y: ghostY, shape };
    paintShape(queue[0], ghost.shape, ghost.x, ghost.y, true);
    paintShape(queue[0], shape, current.x, current.y);
  }
}
function setNotice(message, error = false) {
  text('notice-text', message); $('notice').classList.toggle('error', error); $('notice').hidden = !message;
}
function render() {
  text('lines', lines); text('pieces', pieces);
  const height = metrics(board).maxHeight; text('height', `${height} / 20`);
  $('next').replaceChildren(...queue.slice(1, 4).map(p => {
    const el = document.createElement('div'); el.className = 'next-piece'; el.setAttribute('role', 'img'); el.setAttribute('aria-label', `${p} 블록`); el.append(mini(p)); return el;
  }));
  text('phase', phase); const dot = document.createElement('i'); $('phase').prepend(dot); $('phase').classList.toggle('active', running || busy);
  text('mode-badge', label + ' AI');
  text('model-name', model);
  text('usage', `${calls}회 호출 / ${tokens.toLocaleString()} tokens`);
  renderCost();
  $('play').disabled = !configured || (!running && busy) || Boolean(endReason);
  text('play-text', running ? '정지' : (pieces || active) ? '계속' : '시작');
  $('play-icon').innerHTML = running ? '<path d="M5 3h4v14H5zm7 0h4v14h-4z" fill="currentColor"/>' : '<path d="m6 3 11 7-11 7z" fill="currentColor"/>';
  $('board-overlay').hidden = running || busy;
  text('overlay-title', endReason === 'gameover' ? '게임 종료' : endReason === 'limit' ? '한도 도달' : (pieces || active) ? '일시 정지' : '준비');
  text('overlay-subtitle', endReason === 'gameover' ? `${lines}줄 제거` : endReason === 'limit' ? '한도를 늘려 계속하세요' : !configured ? label + ' 연결이 필요합니다' : (pieces || active) ? '계속을 눌러주세요' : '시작을 눌러주세요');
  canvas.setAttribute('aria-label', `테트리스 보드: ${pieces}개 배치, ${lines}줄 제거, ${score}점. 높이 ${height}칸. ${phase}.`);
  if (errorText) setNotice(errorText, true);
  else if (configured) setNotice('');
  else if (statusUnavailable) setNotice('서버 연결을 확인해 주세요.', true);
  else setNotice(statusReady ? 'API 키를 설정해 주세요.' : '');
  const average = latencySamples.length ? latencySamples.reduce((a,b) => a+b, 0) / latencySamples.length : null;
  const throughput = playMs() > 0 ? pieces * 60000 / playMs() : null;
  snapshots[provider] = { score, average, throughput, pieces, lines, calls, responses: latencySamples.length,
    maxLatency: latencySamples.length ? Math.max(...latencySamples) : null, playMs: playMs(),
    running: running || busy, clockRunning: Boolean(playStarted), endReason, errorText, model, round,
    gameCost: { ...gameCost } };
  for (const [name, value] of Object.entries({ score: score.toLocaleString(), lines, pieces, average: duration(average),
    throughput: throughput == null ? '—' : throughput.toFixed(1), phase, elapsed: (playMs() / 1000).toFixed(1) + ' s' })) {
    global(provider + '-compare-' + name).textContent = value;
  }
  global(provider + '-compare-phase').dataset.state = errorText ? 'error' : running || busy ? 'running' : 'stopped';
  highlightComparison();
  global('play-both').textContent = players.some(p => p.isRunning()) ? '둘 다 정지' : Object.values(snapshots).some(s => s.pieces) ? '동시에 계속' : '동시에 시작';
  global('pace').disabled = players.some(p => p.isRunning());
  draw();
  maybeShowResult();
}
function resetDecision() {
  text('selected-probability', '—'); text('latency-average', '—'); text('latency-max', '—');
  text('latency-live', '');
  text('analysis-turn', '판단 대기'); text('all-count', '0개');
  text('analysis-note', `${label}의 응답이 오면 열/회전별 확률과 모든 배치 후보를 표시합니다.`);
  $('outcome-metrics').replaceChildren();
  for (const id of ['column-distribution', 'rotation-distribution']) $(id).replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-note', textContent: '아직 확률 데이터가 없습니다.' }));
  $('candidate-table').innerHTML = '<tr><td colspan="5">첫 판단을 기다립니다.</td></tr>';
  text('decision-number', '#0'); text('decision-label', ''); text('decision-title', '판단 대기');
  text('decision-description', `가능한 착지 위치를 비교하고, ${label}가 하나를 선택합니다.`);
  text('confidence', '—'); text('latency', '—'); text('candidate-count', '—개 후보');
  text('options-title', '상위 후보');
  text('probability-note', '확률은 후보 사이의 선호도이며, 승률이 아닙니다.');
  $('options').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-note', textContent: '판단 후 표시됩니다.' }));
}
function showDecision(decision, options, selected) {
  text('decision-number', `#${pieces + 1}`);
  text('decision-label', '배치 중');
  text('decision-title', `${queue[0]} → ${selected.x + 1}열 / ${selected.rotation * 90}°`);
  text('decision-description', `${options.length}개 가능한 배치 중 이 위치를 선택했습니다. 아래 수치는 배치 결과를 코드로 계산한 값입니다.`);
  text('selected-probability', percent(decision.probabilities?.[selected.id]));
  text('confidence', decision.confidence == null ? '—' : `${(decision.confidence * 100).toFixed(1)}%`);
  text('latency', duration(decision.latencyMs));
  if (decision.latencyMs != null) {
    latencySamples.push(decision.latencyMs);
    text('latency-average', duration(latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length));
    text('latency-max', duration(Math.max(...latencySamples)));
  }
  const before = metrics(board);
  $('outcome-metrics').replaceChildren(...[['제거 줄', `${selected.cleared}줄`], ['빈틈', `${before.holes} → ${selected.metrics.holes}`]].map(([label, value]) => {
    const box = document.createElement('div'); box.append(Object.assign(document.createElement('span'), { textContent: label }), Object.assign(document.createElement('strong'), { textContent: value })); return box;
  }));
  showDistribution(decision, options, selected);
  text('candidate-count', `${options.length}개 후보`);
  const top = decision.probabilities ? [...options].sort((a, b) => decision.probabilities[b.id] - decision.probabilities[a.id]).slice(0, 3) : [selected];
  $('options').replaceChildren(...top.map(c => {
    const probability = decision.probabilities?.[c.id];
    const el = document.createElement('div'); el.className = 'option';
    const row = document.createElement('div'); row.className = 'option-text';
    const label = document.createElement('span'); label.textContent = `${c.x + 1}열 / ${c.rotation * 90}°${c.id === selected.id ? ' / 선택' : ''}`;
    const value = document.createElement('b'); value.textContent = probability == null ? '—' : percent(probability);
    row.append(label, value); el.append(row);
    if (probability != null) { const bar = document.createElement('div'); bar.className = 'option-track'; const fill = document.createElement('i'); fill.style.width = `${probability * 100}%`; bar.append(fill); el.append(bar); }
    return el;
  }));
}
function showDistribution(decision, options, selected) {
  text('analysis-turn', `NO. ${pad(pieces + 1)} / ${queue[0]} 블록 / 배치 예정`);
  text('all-count', `${options.length}개`);
  text('analysis-note', decision.probabilities ? '배치 후보의 확률을 열/회전별로 합산했습니다. 두 그래프는 같은 응답을 나눠 본 것이며, 독립된 판단이나 승률이 아닙니다.' : '확률 데이터가 없습니다.');
  const sums = distribution(options, decision.probabilities);
  for (const [id, values] of [['column-distribution', sums?.columns], ['rotation-distribution', sums?.rotations]]) {
    if (!values) { $(id).replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-note', textContent: '확률 데이터가 없습니다.' })); continue; }
    const isColumn = id === 'column-distribution';
    $(id).replaceChildren(...values.map((p, index) => {
      const label = isColumn ? `${index + 1}열` : `${index * 90}°`;
      const el = document.createElement('div'); el.className = isColumn ? 'column-probability' : 'rotation-probability';
      el.classList.toggle('chosen', index === (isColumn ? selected.x : selected.rotation));
      const name = Object.assign(document.createElement('span'), { textContent: label });
      const number = Object.assign(document.createElement('b'), { textContent: percent(p) });
      const track = document.createElement('div'); track.className = 'distribution-track'; track.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('i'); fill.style[isColumn ? 'height' : 'width'] = `${p * 100}%`; track.append(fill);
      el.title = `${label}: ${percent(p)}${el.classList.contains('chosen') ? ' / 선택한 배치' : ''}`;
      el.append(number, track, name); return el;
    }));
  }
  const sorted = decision.probabilities ? [...options].sort((a, b) => decision.probabilities[b.id] - decision.probabilities[a.id]) : [selected, ...options.filter(c => c.id !== selected.id)];
  $('candidate-table').replaceChildren(...sorted.map(c => {
    const row = document.createElement('tr'); row.classList.toggle('selected-row', c.id === selected.id);
    const values = [`${c.x + 1}열 / ${c.rotation * 90}°${c.id === selected.id ? ' / 선택' : ''}`, percent(decision.probabilities?.[c.id]), c.cleared, c.metrics.holes, c.metrics.maxHeight];
    row.append(...values.map((value, i) => {
      const cell = document.createElement(i ? 'td' : 'th'); if (!i) cell.scope = 'row'; cell.textContent = value;
      if (i === 1 && decision.probabilities) cell.style.setProperty('--probability', `${decision.probabilities[c.id] * 100}%`);
      return cell;
    })); return row;
  }));
}
function renderHistory() {
  $('history').replaceChildren(...history.slice(0, 5).map(item => {
    const li = document.createElement('li'); li.className = 'history-item';
    const number = Object.assign(document.createElement('span'), { className: 'turn', textContent: pad(item.turn) });
    const label = Object.assign(document.createElement('span'), { textContent: `${item.piece} / ${item.x + 1}열 / ${item.rotation * 90}°` });
    label.append(Object.assign(document.createElement('small'), { className: 'history-detail', textContent: item.gravityOnly ? '중력 착지 / 선택 미실행' : item.latencyMs == null ? '응답 없음' : `${percent(item.probability)} / ${duration(item.latencyMs)}` }));
    const outcome = Object.assign(document.createElement('span'), { className: `outcome ${item.cleared ? '' : 'zero'}`, textContent: item.cleared ? `+${item.cleared} LINE` : 'PLACED' });
    li.append(number, label, outcome); return li;
  }));
  if (!history.length) $('history').append(Object.assign(document.createElement('li'), { className: 'empty-note', textContent: '아직 놓인 블록이 없습니다.' }));
}
function stop(reason = '일시 정지') {
  clearEffects();
  if (requestStarted) { requestStarted = 0; text('latency-live', '요청 취소됨'); }
  finishClock(); running = false; epoch++; controller?.abort(); busy = false; target = null;
  if (lastDecision?.pending) { text('decision-label', '낙하 일시 정지'); text('analysis-turn', `NO. ${pad(pieces + 1)} / 낙하 일시 정지`); lastDecision.pending = false; }
  else text('decision-label', pieces ? '최근 배치 선택' : '판단 일시 정지');
  phase = reason; render();
}
function reset() {
  stop(); clearResult(); active = null; board = emptyBoard(); pieceIndex = 0; drawPiece = nextPiece; queue = Array.from({ length: 4 }, drawPiece);
  round++; gameCost = { usd: 0, incomplete: false };
  pieces = 0; lines = 0; score = 0; history = []; calls = 0; tokens = 0; elapsed = 0;
  phase = '준비'; endReason = ''; errorText = ''; lastDecision = null; totalPlayMs = 0; playStarted = 0; text('elapsed', '00:00');
  latencySamples = []; requestStarted = 0;
  resetDecision(); renderHistory(); render();
}
async function checkConnection() {
  try {
    const response = await fetch('/api/status', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    const status = await response.json(); const result = status.providers[provider]; serverKeyConfigured = result.serverKeyConfigured === true;
    configured = serverKeyConfigured || Boolean(sessionApiKey); model = result.model;
    $('key-form').hidden = serverKeyConfigured;
    statusUnavailable = false;
    text('connection-text', serverKeyConfigured ? '서버 키 사용' : configured ? 'API 키 입력됨' : label + ' 연결');
    text('setup-status', serverKeyConfigured ? '서버의 .env 키를 사용합니다. 다른 키를 입력하려면 .env 키를 비우고 서버를 재시작하세요.' : configured ? '이 탭에서 사용할 키가 입력됐습니다. 유효성은 첫 플레이 요청에서 확인합니다.' : 'API 키를 입력하면 플레이할 수 있습니다.');
  } catch {
    configured = false; statusUnavailable = true; text('connection-text', '서버 연결 확인');
    text('setup-status', '서버에 연결할 수 없습니다. node --env-file-if-exists=.env server.mjs로 서버를 실행해 주세요.');
  }
  statusReady = true; $('connection-dot').classList.toggle('connected', configured); render();
}
async function move(generation) {
  if (generation !== epoch) return false;
  if (pieces >= Number($('limit').value) || calls >= Number($('limit').value)) {
    endReason = 'limit'; running = false; phase = '한도 도달'; render(); return false;
  }
  active ??= { ...spawn(queue[0]), fallMs: 0, groundMs: 0 };
  const options = candidates(board, queue[0], active);
  if (!options.length) { endReason = 'gameover'; running = false; phase = '게임 종료'; render(); return false; }
  busy = true; errorText = ''; target = null; lastDecision = null;
  if (!pieces) text('decision-number', '#' + (pieces + 1));
  text('decision-label', `${label} 판단 중`);
  phase = label + ' 판단 중'; render();
  let decision = null, selected = null, settled = false, costPending = false, requestError = null;
  const requestController = new AbortController(); controller = requestController;
  const requestCost = gameCost;
  const request = (async () => {
    try {
      requestStarted = performance.now(); calls++; costPending = true; render();
      const response = await fetch('/api/decision/' + provider, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(!serverKeyConfigured && sessionApiKey ? { Authorization: `Bearer ${sessionApiKey}` } : {}) },
        body: JSON.stringify({ pace: global('pace').value, board, piece: queue[0], next: queue.slice(1), active: { x: active.x, y: active.y, rotation: active.rotation } }), signal: requestController.signal });
      const result = await response.json();
      recordCost(response.ok ? result : null, requestCost); costPending = false;
      if (!response.ok) throw new Error(result.error || label + ' 요청에 실패했습니다.');
      if (generation === epoch && !settled) text('connection-text', label + ' 연결됨');
      if (generation !== epoch || settled) return;
      requestStarted = 0;
      decision = result; selected = options.find(c => c.id === result.choice);
      if (!selected) throw new Error('현재 보드에 적용할 수 없는 선택입니다.');
      model = result.model;
      tokens += (Number(result.usage?.input_tokens) || 0) + (Number(result.usage?.output_tokens) || 0);
      target = selected; lastDecision = { ...decision, pending: true };
      showDecision(decision, options, selected);
      text('latency-live', '평균 ' + duration(latencySamples.reduce((a,b) => a+b, 0) / latencySamples.length));
      phase = '낙하 중'; render();
    } catch (error) {
      if (generation === epoch && !settled) requestError = error;
    } finally { if (costPending) recordCost(null, requestCost); }
  })();
  let last = performance.now(), controlMs = 0;
  try {
    if (responsePace()) {
      await request;
      if (generation !== epoch || !running) return false;
      if (requestError) throw requestError;
      active = { ...active, x: selected.x, y: selected.y, rotation: selected.rotation, locked: true };
    }
    while (!responsePace() && generation === epoch && running) {
      if (requestError) throw requestError;
      const now = performance.now(), dt = Math.min(now - last, 100); last = now;
      const speed = Number($('speed').value);
      controlMs += dt;
      if (target && controlMs >= 90 / speed) {
        controlMs = 0;
        const reachable = candidates(board, queue[0], active).find(c => c.id === target.id && c.y === target.y);
        if (reachable) {
          const step = reachable.path[1];
          if (step) active = { ...active, x: step.x, rotation: step.rotation };
          if (active.x === reachable.x && active.rotation === reachable.rotation) {
            active = { ...active, y: reachable.y, locked: true };
            draw();
            break;
          }
        } else {
          target = null; text('decision-label', '목표 도달 불가');
        }
      }
      active = fallTick(board, queue[0], active, dt, Math.max(100, 650 * .85 ** Math.floor(lines / 10)) / speed);
      draw();
      if (active.locked) break;
      await sleep(16);
    }
    if (generation !== epoch || !running) return false;
    settled = true; requestController.abort(); await request;
    if (generation !== epoch) return false;
    requestStarted = 0;
    const actual = candidates(board, queue[0], active).find(c => c.x === active.x && c.rotation === active.rotation);
    if (!actual) throw new Error('착지 위치를 확인하지 못했습니다.');
    const matched = selected && actual.id === selected.id && actual.y === selected.y;
    const previousBoard = board, currentPiece = queue[0]; board = actual.board; lines += actual.cleared;
    score += [0,100,300,500,800][actual.cleared]; pieces++;
    history.unshift({ turn: pieces, piece: currentPiece, x: actual.x, rotation: actual.rotation, cleared: actual.cleared,
      latencyMs: matched ? decision?.latencyMs : null, probability: matched ? decision?.probabilities?.[actual.id] : null,
      gravityOnly: !matched }); history = history.slice(0,5);
    queue.shift(); queue.push(drawPiece()); active = null; target = null;
    if (lastDecision) lastDecision.pending = false;
    text('decision-label', matched ? '착지 완료' : '중력으로 착지 / 목표 미실행');
    if (!selected) { text('decision-title', '응답 전 착지'); text('latency-live', '착지로 요청 종료'); }
    text('analysis-turn', 'NO. ' + pad(pieces) + ' / ' + currentPiece + ' / ' + (matched ? '선택 위치 착지' : '중력 착지'));
    renderHistory(); phase = '다음 블록';
    if (!candidates(board, queue[0]).length) { endReason = 'gameover'; running = false; phase = '게임 종료'; }
    else if (pieces >= Number($('limit').value) || calls >= Number($('limit').value)) { endReason = 'limit'; running = false; phase = '한도 도달'; }
    render(); landingEffect(actual, currentPiece, previousBoard); return !endReason;
  } catch (error) {
    if (generation !== epoch) return false;
    running = false; requestStarted = 0; errorText = error.message; phase = '연결 오류'; return false;
  } finally {
    settled = true; requestController.abort();
    if (generation === epoch) { busy = false; controller = null; render(); }
  }
}
async function play() {
  if (running) { stop(); return; }
  if (busy || endReason === 'gameover' || !configured) return;
  const generation = ++epoch; playStarted = performance.now(); running = true; errorText = ''; endReason = ''; render();
  while (running && generation === epoch) {
    if (!await move(generation)) break;
    if (!responsePace()) await sleep(350 / Number($('speed').value));
  }
  if (generation === epoch) { finishClock(); render(); }
}

$('play').addEventListener('click', play);
$('reset').addEventListener('click', reset);
$('reset-cost').addEventListener('click', () => {
  cost = { usd: 0, incomplete: false };
  try { sessionStorage.setItem(provider + '-cost-v1', JSON.stringify(cost)); } catch { /* Keep the reset in memory. */ }
  renderCost();
});
$('limit').addEventListener('change', () => { if (endReason === 'limit' && pieces < Number($('limit').value) && calls < Number($('limit').value)) { endReason = ''; phase = '일시 정지'; render(); } });
$('connect').addEventListener('click', () => { if (running || busy) stop(); $('setup').showModal(); if (!serverKeyConfigured) $('api-key').focus(); });
$('key-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('api-key'), key = input.value.trim();
  if (!key || /\s/.test(key)) { text('setup-status', '공백 없이 올바른 API 키를 입력해 주세요.'); return; }
  stop(); sessionApiKey = key; input.value = ''; errorText = '';
  await checkConnection();
  if (configured) $('setup').close();
});
$('disconnect').addEventListener('click', async () => {
  stop(); sessionApiKey = ''; $('api-key').value = ''; errorText = ''; await checkConnection();
});
$('setup').addEventListener('close', () => { $('api-key').value = ''; });
$('show-details').addEventListener('click', () => { if (running || busy) stop(); $('details-dialog').showModal(); });
document.addEventListener('keydown', event => {
  if ($('setup').open || $('details-dialog').open || ['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA', 'A'].includes(event.target.tagName)) return;
  if (event.code === 'Space' && provider === 'jev') { event.preventDefault(); global('play-both').click(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && (running || busy)) stop('탭을 벗어나 정지'); });
board = emptyBoard(); queue = ['T', 'I', 'O', 'S']; pieces = lines = score = calls = tokens = elapsed = 0; history = [];
reset(); checkConnection();
timer = setInterval(() => { if (running || busy) { elapsed++; text('elapsed', `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`); } render(); }, 1000);
window.addEventListener('pagehide', () => { clearEffects(); controller?.abort(); clearInterval(timer); });
const latencyTimer = setInterval(() => { if (requestStarted) text('latency-live', `현재 요청 대기 / ${duration(performance.now() - requestStarted)}`); }, 100);
window.addEventListener('pagehide', () => clearInterval(latencyTimer));

return { play, stop, reset, isRunning: () => running || busy, canPlay: () => configured && !endReason, setLimit(value) {
  $('limit').value = value; $('limit').dispatchEvent(new Event('change'));
} };
}

const template = global('player-template');
for (const provider of ['jev', 'decisions']) {
  const root = document.createElement('section'); root.className = 'player'; root.dataset.provider = provider;
  root.append(template.content.cloneNode(true));
  for (const el of root.querySelectorAll('[id]')) el.id = provider + '-' + el.id;
  for (const el of root.querySelectorAll('[for], [aria-labelledby], [aria-describedby]')) {
    for (const attr of ['for', 'aria-labelledby', 'aria-describedby']) if (el.hasAttribute(attr)) {
      el.setAttribute(attr, el.getAttribute(attr).split(' ').map(id => provider + '-' + id).join(' '));
    }
  }
  if (provider === 'decisions') {
    root.querySelector('h1').textContent = 'Decisions Tetris';
    root.querySelector('#decisions-setup-title').textContent = 'Decisions 연결';
    root.querySelector('label[for="decisions-api-key"]').textContent = 'OpenAI API 키';
    root.querySelector('#decisions-key-help').textContent = '키는 이 탭의 메모리에서만 사용하며 새로고침하면 지워집니다. 서버를 거쳐 OpenAI로 전달됩니다.';
    root.querySelector('.text-link').href = 'https://platform.openai.com/api-keys';
    root.querySelector('.cost-summary').title = '같은 탭의 누적 예상 비용. 입력 100만 토큰당 $0.10, 출력 무료. 지역 및 긴 컨텍스트 할증은 제외합니다.';
    root.querySelector('#decisions-cost-description').firstChild.textContent = '비용은 같은 탭에서 확인된 사용량 기준입니다. 입력 100만 토큰당 $0.10, 출력 무료. 지역 및 긴 컨텍스트 할증과 사용량 미확인 요청은 제외합니다. 실제 청구액은 ';
    root.querySelector('#decisions-cost-description a').href = 'https://platform.openai.com/usage';
    root.querySelector('#decisions-cost-description a').textContent = 'OpenAI 사용량 화면';
    root.querySelector('#decisions-latency').parentElement.title = '네트워크를 포함한 서버와 OpenAI 사이의 왕복 시간';
  }
  global('players').append(root);
  players.push(createPlayer(root, provider));
}
global('play-both').addEventListener('click', () => {
  if (players.some(p => p.isRunning())) players.forEach(p => p.stop());
  else players.filter(p => p.canPlay()).forEach(p => p.play());
});
global('reset-both').addEventListener('click', () => {
  players.forEach(p => p.stop()); sequence = []; bag = makeBag(); players.forEach(p => p.reset());
});
global('turn-limit').addEventListener('change', () => players.forEach(p => p.setLimit(global('turn-limit').value)));
global('show-result').addEventListener('click', showResult);
global('result-new-game').addEventListener('click', () => { global('result-dialog').close(); global('reset-both').click(); });

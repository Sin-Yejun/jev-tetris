import { WIDTH, HEIGHT, SHAPES, COLORS, emptyBoard, rotations, spawn, fits, candidates, makeBag, metrics, fallTick } from './engine.mjs';
import { distribution, percent, duration, estimateCost, dollars } from './analysis.mjs';

const $ = id => document.getElementById(id);
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
let configured = false, model = 'jev-latest', statusReady = false, statusUnavailable = false;
let sessionApiKey = '';
let serverKeyConfigured = false;
let phase = '준비', errorText = '', endReason = '';
let requestStarted = 0, latencySamples = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = (id, value) => { if ($(id).textContent !== String(value)) $(id).textContent = value; };
const pad = value => String(value).padStart(3, '0');
let cost = { usd: 0, incomplete: false };
try {
  const saved = JSON.parse(sessionStorage.getItem('jev-cost-v1'));
  if (Number.isFinite(saved?.usd) && saved.usd >= 0) cost = { usd: saved.usd, incomplete: saved.incomplete === true };
} catch { /* Storage can be unavailable; keep counting in memory. */ }
function recordCost(result) {
  const amount = result ? estimateCost(result.model, result.usage) : null;
  if (amount == null) cost.incomplete = true;
  else cost.usd += amount;
  try { sessionStorage.setItem('jev-cost-v1', JSON.stringify(cost)); } catch { /* In-memory total remains available. */ }
  text('cost', dollars(cost.usd) + (cost.incomplete ? ' + ?' : ''));
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
  text('score', score.toLocaleString()); text('lines', lines); text('pieces', pieces);
  const height = metrics(board).maxHeight; text('height', `${height} / 20`);
  $('next').replaceChildren(...queue.slice(1, 4).map(p => {
    const el = document.createElement('div'); el.className = 'next-piece'; el.setAttribute('role', 'img'); el.setAttribute('aria-label', `${p} 블록`); el.append(mini(p)); return el;
  }));
  text('phase', phase); const dot = document.createElement('i'); $('phase').prepend(dot); $('phase').classList.toggle('active', running || busy);
  text('mode-badge', 'Jev AI');
  text('model-name', model);
  text('usage', `${calls}회 호출 · ${tokens.toLocaleString()} tokens`);
  text('cost', dollars(cost.usd) + (cost.incomplete ? ' + ?' : ''));
  $('play').disabled = !configured || (!running && busy) || Boolean(endReason);
  text('play-text', running ? '정지' : (pieces || active) ? '계속' : '시작');
  $('play-icon').innerHTML = running ? '<path d="M5 3h4v14H5zm7 0h4v14h-4z" fill="currentColor"/>' : '<path d="m6 3 11 7-11 7z" fill="currentColor"/>';
  $('board-overlay').hidden = running || busy;
  text('overlay-title', endReason === 'gameover' ? '게임 종료' : endReason === 'limit' ? '한도 도달' : (pieces || active) ? '일시 정지' : '준비');
  text('overlay-subtitle', endReason === 'gameover' ? `${lines}줄 제거` : endReason === 'limit' ? '한도를 늘려 계속하세요' : !configured ? 'Jev 연결이 필요합니다' : (pieces || active) ? '계속을 눌러주세요' : '시작을 눌러주세요');
  canvas.setAttribute('aria-label', `테트리스 보드: ${pieces}개 배치, ${lines}줄 제거, ${score}점. 높이 ${height}칸. ${phase}.`);
  if (errorText) setNotice(errorText, true);
  else if (configured) setNotice('');
  else if (statusUnavailable) setNotice('서버 연결을 확인해 주세요.', true);
  else setNotice(statusReady ? 'API 키를 설정해 주세요.' : '');
  draw();
}
function resetDecision() {
  text('selected-probability', '—'); text('latency-average', '—'); text('latency-max', '—');
  text('latency-live', '');
  text('analysis-turn', '판단 대기'); text('all-count', '0개');
  text('analysis-note', 'Jev의 응답이 오면 열·회전별 확률과 모든 배치 후보를 표시합니다.');
  $('outcome-metrics').replaceChildren();
  for (const id of ['column-distribution', 'rotation-distribution']) $(id).replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-note', textContent: '아직 확률 데이터가 없습니다.' }));
  $('candidate-table').innerHTML = '<tr><td colspan="5">첫 판단을 기다립니다.</td></tr>';
  text('decision-number', '#0'); text('decision-label', ''); text('decision-title', '판단 대기');
  text('decision-description', '가능한 착지 위치를 비교하고, Jev가 하나를 선택합니다.');
  text('confidence', '—'); text('latency', '—'); text('candidate-count', '—개 후보');
  text('options-title', '상위 후보');
  text('probability-note', '확률은 후보 사이의 선호도이며, 승률이 아닙니다.');
  $('options').replaceChildren(Object.assign(document.createElement('p'), { className: 'empty-note', textContent: '판단 후 표시됩니다.' }));
}
function showDecision(decision, options, selected) {
  text('decision-number', `#${pieces + 1}`);
  text('decision-label', '배치 중');
  text('decision-title', `${queue[0]} → ${selected.x + 1}열 · ${selected.rotation * 90}°`);
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
    const label = document.createElement('span'); label.textContent = `${c.x + 1}열 / ${c.rotation * 90}°${c.id === selected.id ? ' · 선택' : ''}`;
    const value = document.createElement('b'); value.textContent = probability == null ? '—' : percent(probability);
    row.append(label, value); el.append(row);
    if (probability != null) { const bar = document.createElement('div'); bar.className = 'option-track'; const fill = document.createElement('i'); fill.style.width = `${probability * 100}%`; bar.append(fill); el.append(bar); }
    return el;
  }));
}
function showDistribution(decision, options, selected) {
  text('analysis-turn', `NO. ${pad(pieces + 1)} · ${queue[0]} 블록 · 배치 예정`);
  text('all-count', `${options.length}개`);
  text('analysis-note', decision.probabilities ? '배치 후보의 확률을 열·회전별로 합산했습니다. 두 그래프는 같은 응답을 나눠 본 것이며, 독립된 판단이나 승률이 아닙니다.' : '확률 데이터가 없습니다.');
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
      el.title = `${label}: ${percent(p)}${el.classList.contains('chosen') ? ' · 선택한 배치' : ''}`;
      el.append(number, track, name); return el;
    }));
  }
  const sorted = decision.probabilities ? [...options].sort((a, b) => decision.probabilities[b.id] - decision.probabilities[a.id]) : [selected, ...options.filter(c => c.id !== selected.id)];
  $('candidate-table').replaceChildren(...sorted.map(c => {
    const row = document.createElement('tr'); row.classList.toggle('selected-row', c.id === selected.id);
    const values = [`${c.x + 1}열 / ${c.rotation * 90}°${c.id === selected.id ? ' · 선택' : ''}`, percent(decision.probabilities?.[c.id]), c.cleared, c.metrics.holes, c.metrics.maxHeight];
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
    const label = Object.assign(document.createElement('span'), { textContent: `${item.piece} · ${item.x + 1}열 / ${item.rotation * 90}°` });
    label.append(Object.assign(document.createElement('small'), { className: 'history-detail', textContent: item.gravityOnly ? '중력 착지 · 선택 미실행' : item.latencyMs == null ? '응답 없음' : `${percent(item.probability)} · ${duration(item.latencyMs)}` }));
    const outcome = Object.assign(document.createElement('span'), { className: `outcome ${item.cleared ? '' : 'zero'}`, textContent: item.cleared ? `+${item.cleared} LINE` : 'PLACED' });
    li.append(number, label, outcome); return li;
  }));
  if (!history.length) $('history').append(Object.assign(document.createElement('li'), { className: 'empty-note', textContent: '아직 놓인 블록이 없습니다.' }));
}
function stop(reason = '일시 정지') {
  clearEffects();
  if (requestStarted) { requestStarted = 0; text('latency-live', '요청 취소됨'); }
  running = false; epoch++; controller?.abort(); busy = false; target = null;
  if (lastDecision?.pending) { text('decision-label', '낙하 일시 정지'); text('analysis-turn', `NO. ${pad(pieces + 1)} · 낙하 일시 정지`); lastDecision.pending = false; }
  phase = reason; render();
}
function reset() {
  stop(); active = null; board = emptyBoard(); drawPiece = makeBag(); queue = Array.from({ length: 4 }, drawPiece);
  pieces = 0; lines = 0; score = 0; history = []; calls = 0; tokens = 0; elapsed = 0;
  phase = '준비'; endReason = ''; errorText = ''; lastDecision = null; text('elapsed', '00:00');
  latencySamples = []; requestStarted = 0;
  resetDecision(); renderHistory(); render();
}
async function checkConnection() {
  try {
    const response = await fetch('/api/status', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    const result = await response.json(); serverKeyConfigured = result.serverKeyConfigured === true;
    configured = serverKeyConfigured || Boolean(sessionApiKey); model = result.model;
    $('key-form').hidden = serverKeyConfigured;
    statusUnavailable = false;
    text('connection-text', serverKeyConfigured ? '서버 키 사용' : configured ? 'API 키 입력됨' : 'Jev 연결');
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
  resetDecision(); text('decision-number', '#' + (pieces + 1));
  phase = '낙하 · Jev 판단 중'; render();
  let decision = null, selected = null, settled = false, costPending = false, requestError = null;
  const requestController = new AbortController(); controller = requestController;
  const request = (async () => {
    try {
      requestStarted = performance.now(); calls++; costPending = true; render();
      const response = await fetch('/api/decision', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(!serverKeyConfigured && sessionApiKey ? { Authorization: `Bearer ${sessionApiKey}` } : {}) },
        body: JSON.stringify({ board, piece: queue[0], next: queue.slice(1), active: { x: active.x, y: active.y, rotation: active.rotation } }), signal: requestController.signal });
      const result = await response.json();
      recordCost(response.ok ? result : null); costPending = false;
      if (!response.ok) throw new Error(result.error || 'Jev 요청에 실패했습니다.');
      if (generation === epoch && !settled) text('connection-text', 'Jev 연결됨');
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
    } finally { if (costPending) recordCost(null); }
  })();
  let last = performance.now(), controlMs = 0;
  try {
    while (generation === epoch && running) {
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
    text('decision-label', matched ? '착지 완료' : '중력으로 착지 · 목표 미실행');
    if (!selected) { text('decision-title', '응답 전 착지'); text('latency-live', '착지로 요청 종료'); }
    text('analysis-turn', 'NO. ' + pad(pieces) + ' · ' + currentPiece + ' · ' + (matched ? '선택 위치 착지' : '중력 착지'));
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
  const generation = ++epoch; running = true; errorText = ''; endReason = ''; render();
  while (running && generation === epoch) {
    if (!await move(generation)) break;
    await sleep(350 / Number($('speed').value));
  }
}

$('play').addEventListener('click', play);
$('reset').addEventListener('click', reset);
$('reset-cost').addEventListener('click', () => {
  cost = { usd: 0, incomplete: false };
  try { sessionStorage.setItem('jev-cost-v1', JSON.stringify(cost)); } catch { /* Keep the reset in memory. */ }
  text('cost', dollars(0));
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
  if (event.code === 'Space') { event.preventDefault(); play(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && (running || busy)) stop('탭을 벗어나 정지'); });
board = emptyBoard(); queue = ['T', 'I', 'O', 'S']; pieces = lines = score = calls = tokens = elapsed = 0; history = [];
reset(); checkConnection();
timer = setInterval(() => { if (running || busy) { elapsed++; text('elapsed', `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`); } }, 1000);
window.addEventListener('pagehide', () => { clearEffects(); controller?.abort(); clearInterval(timer); });
const latencyTimer = setInterval(() => { if (requestStarted) text('latency-live', `현재 요청 대기 · ${duration(performance.now() - requestStarted)}`); }, 100);
window.addEventListener('pagehide', () => clearInterval(latencyTimer));

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { decide, DecisionError } from './jev.mjs';
import { validateState } from './public/engine.mjs';

const assets = { '/': ['index.html', 'text/html'], '/app.mjs': ['app.mjs', 'text/javascript'],
  '/analysis.mjs': ['analysis.mjs', 'text/javascript'],
  '/engine.mjs': ['engine.mjs', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
export function createAppServer({ apiKey: serverKey = process.env.TYPESAFE_API_KEY?.trim() || '', model = process.env.TYPESAFE_MODEL || 'jev-latest', fetchImpl = fetch } = {}) {
  let busy = false;
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return json(403, { error: '로컬 접속만 허용됩니다.' });
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/api/status') return json(200, { model, serverKeyConfigured: Boolean(serverKey) });
    if (req.method === 'POST' && path === '/api/decision') {
      if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
        req.headers['content-type']?.split(';')[0] !== 'application/json') return json(403, { error: '허용되지 않은 요청입니다.' });
      if (busy) return json(429, { error: '이전 판단이 진행 중입니다. 잠시 후 다시 시도해 주세요.' });
      busy = true;
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 16384) throw new DecisionError('요청이 너무 큽니다.', 413);
        }
        let state;
        try { state = JSON.parse(body); } catch { throw new DecisionError('올바른 JSON이 필요합니다.', 400); }
        if (!validateState(state)) throw new DecisionError('게임 상태가 올바르지 않습니다.', 400);
        const authorization = req.headers.authorization || '';
        const apiKey = serverKey || (authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '');
        if (!apiKey || apiKey.length > 4096 || /\s/.test(apiKey)) throw new DecisionError('Jev 연결에서 API 키를 입력해 주세요.', 401);
        json(200, await decide(state, { apiKey, model, fetchImpl, signal: controller.signal }));
      } catch (error) {
        if (!res.destroyed) json(error instanceof DecisionError ? error.status : 500,
          { error: error instanceof DecisionError ? error.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.' });
      } finally { busy = false; }
      return;
    }
    if (req.method === 'GET' && Object.hasOwn(assets, path)) {
      const [file, type] = assets[path];
      try {
        const content = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content);
      } catch { json(500, { error: '화면 파일을 불러오지 못했습니다.' }); }
      return;
    }
    json(404, { error: '찾을 수 없습니다.' });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createAppServer();
  server.requestTimeout = 30000;
  server.listen(port, '127.0.0.1', () => console.log(`Jev Tetris: http://localhost:${port}`));
  server.on('error', error => { console.error(`서버를 시작하지 못했습니다: ${error.code}`); process.exitCode = 1; });
}

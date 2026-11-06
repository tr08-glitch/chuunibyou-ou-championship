// ラスト・ユニット: ゲーム配信 + マップ実装申請の受付 + 作者によるマップ設定(依存パッケージなし / Node 18+)
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const AUTHOR_KEY = process.env.AUTHOR_KEY || '';          // 作者専用URLの合言葉(?author=...)
const AUTHOR_PIN = process.env.AUTHOR_PIN || '6046';      // 作者モードの暗証番号
const DISCORD = process.env.DISCORD_WEBHOOK_URL || '';    // 任意: 申請・設定変更の通知
const GH_TOKEN = process.env.GITHUB_TOKEN || '', GH_REPO = process.env.GITHUB_REPO || '', GH_BRANCH = process.env.GITHUB_BRANCH || 'main';   // 任意: 設定をGitHubへ保存(再起動で消えないように)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_BODY = 600 * 1024, MAX_ITEMS = 300;
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---- 保存: data/ と(あれば)リポジトリ直下の同名ファイルから読む ---- */
function load(name, def) {
  for (const p of [path.join(DATA_DIR, name), path.join(__dirname, name)]) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {} }
  return def;
}
let items = load('submissions.json', []);
let config = load('config.json', { rev: 0, stages: null, battle: null });
const dirty = new Set();
function persist(name, obj) {
  try { fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(obj)); } catch (e) { console.error('save failed', e.message); }
  if (GH_TOKEN && GH_REPO) { dirty.add(name); clearTimeout(persist.t); persist.t = setTimeout(pushGit, 30000); }
}
async function pushGit() {
  for (const name of [...dirty]) {
    dirty.delete(name);
    try {
      const url = `https://api.github.com/repos/${GH_REPO}/contents/${name}`, h = { Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'last-unit', Accept: 'application/vnd.github+json' };
      const cur = await fetch(url + '?ref=' + GH_BRANCH, { headers: h }); const sha = cur.ok ? (await cur.json()).sha : undefined;
      const obj = name === 'config.json' ? config : items;
      const r = await fetch(url, { method: 'PUT', headers: h, body: JSON.stringify({ message: 'update ' + name + ' [skip render]', content: Buffer.from(JSON.stringify(obj)).toString('base64'), branch: GH_BRANCH, sha }) });
      if (!r.ok) console.error('github', name, r.status, (await r.text()).slice(0, 200));
    } catch (e) { console.error('github failed', e.message); }
  }
}

const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/icon.png': 'icon.png' };
const TYPES = { 'index.html': 'text/html; charset=utf-8', 'icon.png': 'image/png' };
const cache = {};
function file(name) {
  if (!cache[name]) { const raw = fs.readFileSync(path.join(__dirname, name)); cache[name] = { raw, gz: name.endsWith('.html') ? zlib.gzipSync(raw, { level: 9 }) : null }; }
  return cache[name];
}
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const isAuthor = (k, pin) => !!AUTHOR_KEY && same(k || '', AUTHOR_KEY) && same(pin || '', AUTHOR_PIN);
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
const hits = new Map();
function limited(ip, tag, max, ms) {
  const k = tag + ip, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= max) { hits.set(k, a); return true; }
  a.push(now); hits.set(k, a); return false;
}
const okGrid = g => Array.isArray(g) && g.length >= 3 && g.length <= 60 && g.every(r => typeof r === 'string' && r.length >= 3 && r.length <= 80);
function summarize(text) {
  const j = JSON.parse(text), list = (Array.isArray(j.stages) ? j.stages : j.grid ? [j] : []).concat((Array.isArray(j.battleStages) ? j.battleStages : []).map(s => Object.assign({}, s, { type: 'battle' })));
  if (!list.length || list.length > 10) throw new Error('bad');
  return list.map(s => { if (!okGrid(s.grid)) throw new Error('bad'); return { name: String(s.name || '').slice(0, 30), type: s.type === 'battle' ? 'battle' : 'invade', w: s.grid[0].length, h: s.grid.length }; });
}
const clean = (g, extra) => ({ name: String(g.name || '').slice(0, 30), theme: Math.max(0, Math.min(9, +g.theme || 0)), grid: g.grid.map(String), ...extra });
function checkStages(a) {
  if (!Array.isArray(a) || a.length < 1 || a.length > 80) throw new Error('bad');
  return a.map(s => { if (!okGrid(s.grid)) throw new Error('bad'); const crazy = Array.isArray(s.crazy) && s.crazy.every(r => typeof r === 'string' && r.length < 100) ? s.crazy.map(String) : null; return { name: String(s.name || '').slice(0, 30), hint: String(s.hint || '').slice(0, 100), boss: !!s.boss, grid: s.grid.map(String), crazy }; });
}
function checkBattle(a) {
  if (!Array.isArray(a) || a.length < 1 || a.length > 60) throw new Error('bad');
  return a.map(s => { if (!okGrid(s.grid)) throw new Error('bad'); const o = clean(s, {}); if (Array.isArray(s.owner)) o.owner = s.owner.map(String); else if (typeof s.owner === 'string') o.owner = s.owner.slice(0, 5000); return o; });
}
async function discord(content, name, text) {
  if (!DISCORD) return;
  try {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ content }));
    fd.append('files[0]', new Blob([text], { type: 'application/json' }), name);
    await fetch(DISCORD, { method: 'POST', body: fd });
  } catch (e) { console.error('discord failed', e.message); }
}
function body(req) {
  return new Promise((ok, ng) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > MAX_BODY) { ng(new Error('toobig')); req.destroy(); } else c.push(d); }); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))); req.on('error', ng); });
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, q = u.searchParams;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (p === '/api/config' && req.method === 'GET') return json(res, 200, config);
    if (p === '/api/submit' && req.method === 'POST') {
      if (limited(ip, 's', 5, 600e3)) return json(res, 429, { ok: false, err: 'rate' });
      let b; try { b = JSON.parse(await body(req)); } catch (e) { return json(res, 413, { ok: false, err: e.message === 'toobig' ? 'toobig' : 'bad' }); }
      let maps; try { maps = summarize(String(b.json || '')); } catch (e) { return json(res, 400, { ok: false, err: 'bad' }); }
      const it = { id: crypto.randomBytes(6).toString('hex'), t: Date.now(), name: String(b.name || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 12), msg: String(b.msg || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 100), maps, json: String(b.json) };
      items.unshift(it); items = items.slice(0, MAX_ITEMS); persist('submissions.json', items);
      discord(`📮 マップ実装申請: **${maps.map(m => m.name || '(名前なし)').join(' / ')}** (${it.name || '名無し'})${it.msg ? '\n> ' + it.msg : ''}`, 'map.json', it.json);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/auth') { if (limited(ip, 'a', 12, 600e3)) return json(res, 429, { ok: false }); return json(res, 200, { ok: isAuthor(q.get('key'), q.get('pin')) }); }
    if (p === '/api/config/save' && req.method === 'POST') {
      let b; try { b = JSON.parse(await body(req)); } catch (e) { return json(res, 400, { ok: false, err: 'bad' }); }
      if (limited(ip, 'c', 60, 600e3) || !isAuthor(b.key, b.pin)) return json(res, 403, { ok: false, err: 'forbidden' });
      if (!b.reset && +b.rev !== config.rev) return json(res, 409, { ok: false, err: 'rev', config });
      try {
        const n = { rev: config.rev + 1, stages: config.stages, battle: config.battle };
        if (b.reset) { n.stages = null; n.battle = null; }
        else { if (b.stages !== undefined) n.stages = checkStages(b.stages); if (b.battle !== undefined) n.battle = checkBattle(b.battle); }
        config = n; persist('config.json', config);
        discord(`🛠 マップ設定を更新 (rev ${config.rev})`, 'config.json', JSON.stringify(config));
        return json(res, 200, { ok: true, config });
      } catch (e) { return json(res, 400, { ok: false, err: 'bad' }); }
    }
    if (p === '/api/list' || p === '/api/get' || p === '/api/delete') {
      if (limited(ip, 'l', 120, 600e3) || !isAuthor(q.get('key'), q.get('pin'))) return json(res, 403, { ok: false, err: 'forbidden' });
      if (p === '/api/list') return json(res, 200, { ok: true, items: items.map(({ json: _j, ...r }) => r) });
      const id = q.get('id'), it = items.find(x => x.id === id);
      if (p === '/api/get') return it ? json(res, 200, { ok: true, json: it.json }) : json(res, 404, { ok: false });
      items = items.filter(x => x.id !== id); persist('submissions.json', items); return json(res, 200, { ok: true });
    }
    const name = STATIC[p];
    if (name && req.method === 'GET') {
      const f = file(name), h = { 'Content-Type': TYPES[name], 'Cache-Control': 'no-cache' };
      if (f.gz && /gzip/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); return res.end(f.gz); }
      res.writeHead(200, h); return res.end(f.raw);
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { console.error(e); try { json(res, 500, { ok: false }); } catch (_) {} }
}).listen(PORT, () => console.log('listening', PORT, AUTHOR_KEY ? '' : '(AUTHOR_KEY 未設定: 作者機能は無効)', GH_TOKEN ? '(GitHub保存 ON)' : '(GitHub保存 OFF: 再起動で設定が消えます)'));

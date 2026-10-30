const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { makeTheme } = require('./words');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
const AUTO_START_MS = 20000; // ランダムマッチ部屋: 3人以上で自動開始までの時間
const RESULT_MS = 12000; // 結果表示の自動進行
const LOBBY_DROP_MS = 30000; // ロビーで切断された人を除名するまでの猶予
const ROOM_IDLE_MS = 90000; // 全員切断後、部屋を消すまでの猶予
const KICK_COOLDOWN_MS = 15 * 60 * 1000; // 投票キックを始められる間隔(各自15分に1回)
const KICK_VOTE_MS = 30000; // キック投票の制限時間
const PRESENT_MS = 6000; // 発表フェーズ: 1人ぶんの表示時間(ホストが「次へ」で早送りできる)

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // code -> room
const playerRoom = new Map(); // pid -> code
const kickCooldown = new Map(); // pid -> 最後にキック投票を始めた時刻(部屋をまたいで共通)

// ---------- helpers ----------
const now = () => Date.now();
const clamp = (v, lo, hi, def) => {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def;
};
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const RUBY_SEP = '\u001f'; // 名前とふりがなの区切り(キーボードからは入力できない制御文字)
const stripCtl = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '');
const sanitizeName = (n) => stripCtl(n).replace(/\s+/g, ' ').trim().slice(0, 12) || '名無し';
const sanitizeRuby = (r) => stripCtl(r).replace(/\s+/g, ' ').trim().slice(0, 24);
// クライアントへ送る表示用の名前。ふりがながあれば「名前<区切り>ふりがな」の形にする
const dispName = (p) => (p ? (p.ruby ? p.name + RUBY_SEP + p.ruby : p.name) : '?');
const sanitizeText = (t) => String(t || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 30);

const sanitizeChat = (t) => String(t || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100);
const CHAT_KEEP = 50; // 部屋に残すチャット履歴の件数

// 手書き回答: PNGのdata URLだけを受け付ける(形式・サイズ・PNGシグネチャを検証)
const IMG_PREFIX = 'data:image/png;base64,';
const IMG_MAX_LEN = 120000;
function sanitizeImage(s) {
  if (typeof s !== 'string' || s.length > IMG_MAX_LEN || !s.startsWith(IMG_PREFIX)) return null;
  const b64 = s.slice(IMG_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 40 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return s;
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function newRoom(isPublic) {
  const room = {
    code: genCode(),
    isPublic,
    players: [],
    hostId: null,
    phase: 'lobby', // lobby | answer | vote | result | final
    settings: { rounds: 5, answerSec: 60, voteSec: 30 },
    round: 0,
    theme: '',
    answers: {},
    order: [],
    votes: {},
    result: null,
    timer: null,
    endsAt: null,
    timerTotal: null,
    timerKind: null,
    usedThemes: new Set(),
    voice: new Set(), // 通話に参加中の pid
    chat: [],
    chatSeq: 0,
    presentIdx: 0, // 発表フェーズで、何人目まで公開したか
    banned: new Set(), // キックされた pid(この部屋には入れない)
    kick: null, // 進行中のキック投票
  };
  rooms.set(room.code, room);
  return room;
}

const findPlayer = (room, pid) => room.players.find((p) => p.id === pid);
const connectedPlayers = (room) => room.players.filter((p) => p.connected);
const humanPlayers = (room) => room.players.filter((p) => p.connected && !p.bot);
// pid は本人だけの再接続用の秘密。他のプレイヤーに見せるのは pub(公開ID)だけにする
const pubOf = (room, pid) => {
  const p = findPlayer(room, pid);
  return p ? p.pub : null;
};

function setTimer(room, ms, kind, fn) {
  clearTimer(room);
  room.endsAt = now() + ms;
  room.timerTotal = ms;
  room.timerKind = kind;
  room.timer = setTimeout(() => {
    room.timer = null;
    room.endsAt = null;
    room.timerKind = null;
    fn();
  }, ms);
}
function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.endsAt = null;
  room.timerTotal = null;
  room.timerKind = null;
}

function destroyRoom(room) {
  clearTimer(room);
  if (room.kick) clearTimeout(room.kick.timer);
  for (const p of room.players) {
    if (playerRoom.get(p.id) === room.code) playerRoom.delete(p.id);
  }
  rooms.delete(room.code);
}

function dropVoice(room, p) {
  if (room.voice.delete(p.id)) io.to(room.code).emit('voice:left', { id: p.pub });
}

function reassignHost(room) {
  const cur = findPlayer(room, room.hostId);
  if (cur && cur.connected) return;
  const next = humanPlayers(room)[0];
  if (next) room.hostId = next.id;
}

// ---------- state ----------
function stateFor(room, p) {
  const st = {
    code: room.code,
    isPublic: room.isPublic,
    me: p.pub,
    hostId: pubOf(room, room.hostId),
    phase: room.phase,
    settings: room.settings,
    round: room.round,
    rounds: room.settings.rounds,
    theme: room.theme,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    endsInMs: room.endsAt ? Math.max(0, room.endsAt - now()) : null,
    totalMs: room.timerTotal,
    timerKind: room.timerKind,
    players: room.players.map((q) => ({
      id: q.pub,
      name: dispName(q),
      voice: room.voice.has(q.id),
      bot: !!q.bot,
      connected: q.connected,
      left: !!q.left,
      total: q.total,
      done:
        room.phase === 'answer'
          ? !!room.answers[q.id]
          : room.phase === 'vote'
          ? room.votes[q.id] !== undefined
          : false,
    })),
  };
  if (room.phase === 'answer') {
    st.myAnswer = room.answers[p.id] ?? null;
  }
  if (room.phase === 'vote') {
    // 投稿者が分からないよう、並び順の番号だけを渡す
    st.options = room.order.map((id, i) => ({
      idx: i,
      name: dispName(findPlayer(room, id)),
      kind: room.answers[id].kind,
      value: room.answers[id].value,
      mine: id === p.id,
    }));
    st.myVote = room.votes[p.id] !== undefined ? room.order.indexOf(room.votes[p.id]) : null;
  }
  if (room.phase === 'present') {
    // 発表: 順番に1人ずつ、名前つきで公開していく(これまでに公開した分を全部見せる)
    st.present = {
      idx: room.presentIdx,
      total: room.order.length,
      last: room.presentIdx >= room.order.length - 1,
      items: room.order.slice(0, room.presentIdx + 1).map((id) => ({
        name: dispName(findPlayer(room, id)),
        kind: room.answers[id].kind,
        value: room.answers[id].value,
        mine: id === p.id,
      })),
    };
  }
  if (room.phase === 'result') {
    st.result = room.result;
    st.last = room.round >= room.settings.rounds;
  }
  if (room.phase === 'final') {
    const sorted = room.players.slice().sort((a, b) => b.total - a.total);
    const top = sorted.length ? sorted[0].total : 0;
    st.ranking = sorted.map((q) => ({ name: dispName(q), total: q.total, winner: q.total === top, left: !!q.left }));
  }
  st.kickCooldownMs = Math.max(0, (kickCooldown.get(p.id) || 0) + KICK_COOLDOWN_MS - now());
  if (room.kick) {
    const k = room.kick;
    const target = findPlayer(room, k.target);
    const by = findPlayer(room, k.by);
    st.kick = {
      targetId: target ? target.pub : null,
      targetName: dispName(target),
      byName: dispName(by),
      needed: k.needed,
      total: k.voters.length,
      yes: kickYesCount(k),
      isTarget: k.target === p.id,
      canVote: k.voters.includes(p.id),
      myVote: k.votes[p.id] === undefined ? null : k.votes[p.id],
      endsInMs: Math.max(0, k.endsAt - now()),
      totalMs: k.total,
    };
  }
  return st;
}

function broadcast(room) {
  for (const p of room.players) {
    if (!p.connected || p.bot) continue;
    io.to(p.socketId).emit('state', stateFor(room, p));
  }
}

// ---------- game flow ----------
function updateAutoStart(room) {
  if (!room.isPublic || room.phase !== 'lobby') return;
  const n = connectedPlayers(room).length;
  if (n >= MAX_PLAYERS) {
    startGame(room);
    return;
  }
  if (n >= MIN_PLAYERS) {
    if (!room.timer) {
      setTimer(room, AUTO_START_MS, 'auto', () => {
        if (room.phase === 'lobby' && connectedPlayers(room).length >= MIN_PLAYERS) startGame(room);
        else broadcast(room);
      });
    }
  } else if (room.timer) {
    clearTimer(room);
  }
}

function startGame(room) {
  if (room.phase !== 'lobby') return;
  clearTimer(room);
  // 切断中・離脱済みの人は外してから開始
  room.players = room.players.filter((p) => p.connected);
  reassignHost(room);
  for (const p of room.players) p.total = 0;
  room.round = 0;
  room.usedThemes = new Set();
  startRound(room);
}

function startRound(room) {
  room.round += 1;
  room.theme = makeTheme(room.usedThemes);
  room.usedThemes.add(room.theme);
  room.answers = {};
  room.votes = {};
  room.order = [];
  room.result = null;
  room.phase = 'answer';
  setTimer(room, room.settings.answerSec * 1000, 'answer', () => endAnswer(room));
  broadcast(room);
  botsAnswer(room);
}

function checkAnswerDone(room) {
  if (room.phase !== 'answer') return;
  const conn = connectedPlayers(room);
  if (conn.length > 0 && conn.every((p) => room.answers[p.id])) endAnswer(room);
}

function endAnswer(room) {
  if (room.phase !== 'answer') return;
  clearTimer(room);
  const authors = room.players.filter((p) => room.answers[p.id]);
  room.order = shuffle(authors.map((p) => p.id));
  if (room.order.length === 0) {
    room.phase = 'vote';
    endVote(room);
    return;
  }
  // 回答が出揃ったら、まず1人ずつ発表する
  room.phase = 'present';
  room.presentIdx = 0;
  setTimer(room, PRESENT_MS, 'present', () => advancePresent(room));
  broadcast(room);
}

function advancePresent(room) {
  if (room.phase !== 'present') return;
  room.presentIdx += 1;
  if (room.presentIdx >= room.order.length) {
    startVote(room);
    return;
  }
  setTimer(room, PRESENT_MS, 'present', () => advancePresent(room));
  broadcast(room);
}

function startVote(room) {
  room.phase = 'vote';
  setTimer(room, room.settings.voteSec * 1000, 'vote', () => endVote(room));
  broadcast(room);
  botsVote(room);
  checkVoteDone(room);
}

function checkVoteDone(room) {
  if (room.phase !== 'vote') return;
  const needed = connectedPlayers(room).filter((p) => room.order.some((id) => id !== p.id));
  if (needed.every((p) => room.votes[p.id] !== undefined)) endVote(room);
}

function endVote(room) {
  if (room.phase !== 'vote') return;
  clearTimer(room);
  const entries = room.order.map((id) => {
    const author = findPlayer(room, id);
    const voters = room.players.filter((p) => room.votes[p.id] === id).map((p) => dispName(p));
    return {
      name: dispName(author),
      kind: room.answers[id].kind,
      value: room.answers[id].value,
      votes: voters.length,
      voters,
      _id: id,
    };
  });
  for (const e of entries) {
    const author = findPlayer(room, e._id);
    if (author) author.total += e.votes;
  }
  entries.sort((a, b) => b.votes - a.votes);
  room.result = {
    theme: room.theme,
    entries: entries.map(({ _id, ...rest }) => rest),
  };
  room.phase = 'result';
  setTimer(room, RESULT_MS, 'result', () => afterResult(room));
  broadcast(room);
}

function afterResult(room) {
  if (room.phase !== 'result') return;
  clearTimer(room);
  if (room.round >= room.settings.rounds) goFinal(room);
  else startRound(room);
}

function goFinal(room) {
  clearTimer(room);
  room.phase = 'final';
  broadcast(room);
}

function backToLobby(room) {
  clearTimer(room);
  room.players = room.players.filter((p) => p.connected && !p.left);
  for (const p of room.players) p.total = 0;
  reassignHost(room);
  room.phase = 'lobby';
  room.round = 0;
  room.theme = '';
  room.answers = {};
  room.votes = {};
  room.order = [];
  room.result = null;
  room.usedThemes = new Set();
  updateAutoStart(room);
  broadcast(room);
}

// ---------- 投票キック ----------
// 投票できるのは、開始時点で接続中の人(対象本人を除く)。開始した人は「キックする」に自動で1票。
// 賛成が投票できる人数の2/3以上になったら可決。未投票は反対と同じ扱い。
function kickYesCount(k) {
  return k.voters.filter((id) => k.votes[id] === true).length;
}
function kickVotedCount(k) {
  return k.voters.filter((id) => k.votes[id] !== undefined).length;
}

function checkKick(room) {
  const k = room.kick;
  if (!k) return;
  const yes = kickYesCount(k);
  const remaining = k.voters.length - kickVotedCount(k);
  if (yes >= k.needed) finishKick(room, true);
  else if (yes + remaining < k.needed) finishKick(room, false); // もう可決できない
}

function finishKick(room, passed) {
  const k = room.kick;
  if (!k) return;
  clearTimeout(k.timer);
  room.kick = null;
  if (!passed) {
    io.to(room.code).emit('toast', 'キック投票は否決されました');
    broadcast(room);
    return;
  }
  room.banned.add(k.target);
  const target = findPlayer(room, k.target);
  if (!target) {
    io.to(room.code).emit('toast', 'キック対象はすでに退出しています');
    broadcast(room);
    return;
  }
  const name = target.name;
  io.to(target.socketId).emit('kicked');
  leaveRoom(room, target.id); // ロビーなら除名、ゲーム中は成績を残して退出扱い
  io.to(room.code).emit('toast', `${name}さんがキックされました`);
}

// ---------- テスト用CPU ----------
// プライベート部屋のロビーでホストが追加できる。回答・投票は自動。通話やキックには参加しない。
const BOT_NAMES = [['CPUアルファ', 'しーぴーゆー'], ['CPUブラボー', 'しーぴーゆー'], ['CPUチャーリー', 'しーぴーゆー'], ['CPUデルタ', 'しーぴーゆー'], ['CPUエコー', 'しーぴーゆー'], ['CPUフォックス', 'しーぴーゆー']];
const BOT_ANSWERS = ['ヘルファイア', 'ダークネス', 'ジェノサイド', 'エターナル', 'カオスゲート', 'ブラッディ', 'アビス', 'ファントム', 'クリムゾン', 'レクイエム', 'ラグナロク', 'ヴァニタス', 'ディストピア', 'ネメシス'];
const rnd = (a, b) => a + Math.random() * (b - a);

function addBot(room) {
  const used = new Set(room.players.map((p) => p.name));
  const pick = BOT_NAMES.find(([n]) => !used.has(n));
  if (!pick) return null;
  const p = {
    id: 'bot-' + crypto.randomBytes(6).toString('hex'),
    pub: crypto.randomBytes(6).toString('hex'),
    name: pick[0],
    ruby: pick[1],
    bot: true,
    connected: true,
    socketId: null,
    total: 0,
    left: false,
    dropTimer: null,
    chatTimes: [],
  };
  room.players.push(p);
  return p;
}

function botsAnswer(room) {
  const round = room.round;
  const limit = room.settings.answerSec * 1000 * 0.6;
  for (const b of room.players.filter((p) => p.bot)) {
    setTimeout(() => {
      if (rooms.get(room.code) !== room || room.phase !== 'answer' || room.round !== round || room.answers[b.id]) return;
      room.answers[b.id] = { kind: 'text', value: BOT_ANSWERS[Math.floor(Math.random() * BOT_ANSWERS.length)] };
      broadcast(room);
      checkAnswerDone(room);
    }, Math.min(rnd(2000, 8000), limit));
  }
}

function botsVote(room) {
  const round = room.round;
  const limit = room.settings.voteSec * 1000 * 0.6;
  for (const b of room.players.filter((p) => p.bot)) {
    setTimeout(() => {
      if (rooms.get(room.code) !== room || room.phase !== 'vote' || room.round !== round || room.votes[b.id] !== undefined) return;
      const cand = room.order.filter((id) => id !== b.id);
      if (!cand.length) return;
      room.votes[b.id] = cand[Math.floor(Math.random() * cand.length)];
      broadcast(room);
      checkVoteDone(room);
    }, Math.min(rnd(1500, 6000), limit));
  }
}

// ---------- membership ----------
function addPlayer(room, pid, name, socket, ruby = '') {
  let finalName = name;
  let k = 2;
  while (room.players.some((p) => p.name === finalName)) finalName = `${name}${k++}`;
  const p = {
    id: pid,
    pub: crypto.randomBytes(6).toString('hex'),
    name: finalName,
    ruby,
    connected: true,
    socketId: socket.id,
    total: 0,
    left: false,
    dropTimer: null,
    chatTimes: [],
  };
  room.players.push(p);
  if (!room.hostId) room.hostId = pid;
  socket.join(room.code);
  socket.data.pid = pid;
  playerRoom.set(pid, room.code);
  socket.emit('chatlog', room.chat);
  return p;
}

function removePlayer(room, pid) {
  const p = findPlayer(room, pid);
  if (!p) return;
  if (p.dropTimer) clearTimeout(p.dropTimer);
  dropVoice(room, p);
  room.players = room.players.filter((q) => q.id !== pid);
  if (playerRoom.get(pid) === room.code) playerRoom.delete(pid);
  if (room.players.every((q) => q.bot)) {
    destroyRoom(room);
    return;
  }
  if (room.hostId === pid) {
    room.hostId = null;
    reassignHost(room);
    if (!room.hostId) room.hostId = room.players[0].id;
  }
  updateAutoStart(room);
  broadcast(room);
}

// 退出(明示的)。ゲーム中は成績を残すため幽霊として残す
function leaveRoom(room, pid) {
  const p = findPlayer(room, pid);
  if (!p) return;
  dropVoice(room, p);
  const sock = io.sockets.sockets.get(p.socketId);
  if (sock) sock.leave(room.code);
  if (room.phase === 'lobby') {
    removePlayer(room, pid);
    return;
  }
  p.connected = false;
  p.left = true;
  if (playerRoom.get(pid) === room.code) playerRoom.delete(pid);
  afterDisconnect(room);
}

function afterDisconnect(room) {
  reassignHost(room);
  const conn = connectedPlayers(room);
  if (humanPlayers(room).length === 0) {
    setTimeout(() => {
      if (rooms.get(room.code) === room && humanPlayers(room).length === 0) destroyRoom(room);
    }, ROOM_IDLE_MS);
    return;
  }
  if (['answer', 'present', 'vote', 'result'].includes(room.phase) && conn.length < 2) {
    goFinal(room);
    return;
  }
  broadcast(room);
  if (room.phase === 'answer') checkAnswerDone(room);
  else if (room.phase === 'vote') checkVoteDone(room);
  else if (room.phase === 'lobby') updateAutoStart(room);
}

function leaveOld(pid) {
  const code = playerRoom.get(pid);
  const room = code && rooms.get(code);
  if (room) leaveRoom(room, pid);
  playerRoom.delete(pid);
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  const toast = (msg) => socket.emit('toast', msg);
  const ctx = () => {
    const pid = socket.data.pid;
    const room = pid && rooms.get(playerRoom.get(pid));
    const p = room && findPlayer(room, pid);
    return room && p ? { room, p, pid } : null;
  };
  const validPid = (pid) => typeof pid === 'string' && pid.length >= 8 && pid.length <= 64;

  // 復帰できる部屋があるか問い合わせる(実際の復帰はユーザーが選んでから 'resume')
  socket.on('peek', ({ pid } = {}) => {
    if (!validPid(pid)) return socket.emit('left');
    const room = rooms.get(playerRoom.get(pid));
    const p = room && findPlayer(room, pid);
    if (!room || !p || p.left) return socket.emit('left');
    socket.emit('resumable', {
      code: room.code,
      phase: room.phase,
      round: room.round,
      rounds: room.settings.rounds,
    });
  });

  // 「復帰しない」を選んだとき
  socket.on('abandon', ({ pid } = {}) => {
    if (validPid(pid)) {
      const room = rooms.get(playerRoom.get(pid));
      if (room) leaveRoom(room, pid);
    }
    socket.emit('left');
  });

  socket.on('resume', ({ pid } = {}) => {
    if (!validPid(pid)) return socket.emit('left');
    const room = rooms.get(playerRoom.get(pid));
    const p = room && findPlayer(room, pid);
    if (!room || !p || p.left) {
      toast('ルームに戻れませんでした');
      return socket.emit('left');
    }
    if (p.dropTimer) clearTimeout(p.dropTimer);
    p.dropTimer = null;
    p.connected = true;
    p.socketId = socket.id;
    socket.join(room.code);
    socket.data.pid = pid;
    reassignHost(room);
    socket.emit('chatlog', room.chat);
    broadcast(room);
    if (room.phase === 'lobby') updateAutoStart(room);
  });

  socket.on('create', ({ pid, name, ruby } = {}) => {
    if (!validPid(pid)) return;
    leaveOld(pid);
    const room = newRoom(false);
    addPlayer(room, pid, sanitizeName(name), socket, sanitizeRuby(ruby));
    broadcast(room);
  });

  socket.on('join', ({ pid, name, ruby, code } = {}) => {
    if (!validPid(pid)) return;
    code = String(code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return toast('その部屋は見つかりません');
    if (room.banned.has(pid)) return toast('このルームには入れません');
    const existing = findPlayer(room, pid);
    if (existing && !existing.left) {
      socket.emit('toast', 'すでにこの部屋にいます');
      return;
    }
    if (room.phase !== 'lobby') return toast('ゲームが進行中です');
    if (room.players.length >= MAX_PLAYERS) return toast('満員です(最大8人)');
    leaveOld(pid);
    addPlayer(room, pid, sanitizeName(name), socket, sanitizeRuby(ruby));
    updateAutoStart(room);
    broadcast(room);
  });

  socket.on('quick', ({ pid, name, ruby } = {}) => {
    if (!validPid(pid)) return;
    leaveOld(pid);
    const candidates = [...rooms.values()]
      .filter((r) => r.isPublic && r.phase === 'lobby' && r.players.length < MAX_PLAYERS && !r.banned.has(pid))
      .sort((a, b) => connectedPlayers(b).length - connectedPlayers(a).length);
    const room = candidates[0] || newRoom(true);
    addPlayer(room, pid, sanitizeName(name), socket, sanitizeRuby(ruby));
    updateAutoStart(room);
    broadcast(room);
  });

  socket.on('settings', (s = {}) => {
    const c = ctx();
    if (!c || c.room.phase !== 'lobby' || c.room.hostId !== c.pid) return;
    c.room.settings = {
      rounds: clamp(s.rounds, 1, 15, c.room.settings.rounds),
      answerSec: clamp(s.answerSec, 15, 180, c.room.settings.answerSec),
      voteSec: clamp(s.voteSec, 10, 90, c.room.settings.voteSec),
    };
    broadcast(c.room);
  });

  socket.on('bot:add', () => {
    const c = ctx();
    if (!c || c.room.isPublic || c.room.phase !== 'lobby' || c.room.hostId !== c.pid) return;
    if (c.room.players.length >= MAX_PLAYERS) return toast('満員です');
    if (!addBot(c.room)) return toast('これ以上CPUは追加できません');
    broadcast(c.room);
  });

  socket.on('bot:remove', () => {
    const c = ctx();
    if (!c || c.room.phase !== 'lobby' || c.room.hostId !== c.pid) return;
    const i = c.room.players.map((p) => !!p.bot).lastIndexOf(true);
    if (i < 0) return;
    c.room.players.splice(i, 1);
    broadcast(c.room);
  });

  socket.on('start', () => {
    const c = ctx();
    if (!c || c.room.phase !== 'lobby' || c.room.hostId !== c.pid) return;
    if (connectedPlayers(c.room).length < MIN_PLAYERS) return toast(`${MIN_PLAYERS}人以上で開始できます`);
    startGame(c.room);
  });

  socket.on('answer', ({ text, img } = {}) => {
    const c = ctx();
    if (!c || c.room.phase !== 'answer' || c.room.answers[c.pid]) return;
    let ans;
    if (img !== undefined) {
      const safe = sanitizeImage(img);
      if (!safe) return toast('手書きを送れませんでした。もう一度試してください');
      ans = { kind: 'img', value: safe };
    } else {
      const t = sanitizeText(text);
      if (!t) return toast('回答を入力してください');
      ans = { kind: 'text', value: t };
    }
    c.room.answers[c.pid] = ans;
    broadcast(c.room);
    checkAnswerDone(c.room);
  });

  socket.on('vote', ({ idx } = {}) => {
    const c = ctx();
    if (!c || c.room.phase !== 'vote' || c.room.votes[c.pid] !== undefined) return;
    const target = c.room.order[Number(idx)];
    if (!target) return;
    if (target === c.pid) return toast('自分の回答には投票できません');
    c.room.votes[c.pid] = target;
    broadcast(c.room);
    checkVoteDone(c.room);
  });

  socket.on('next', () => {
    const c = ctx();
    if (!c || c.room.phase !== 'result' || c.room.hostId !== c.pid) return;
    afterResult(c.room);
  });

  socket.on('again', () => {
    const c = ctx();
    if (!c || c.room.phase !== 'final' || c.room.hostId !== c.pid) return;
    backToLobby(c.room);
  });

  // ホストが発表を早送りする
  socket.on('present:next', () => {
    const c = ctx();
    if (!c || c.room.phase !== 'present' || c.room.hostId !== c.pid) return;
    clearTimer(c.room);
    advancePresent(c.room);
  });

  // ---- 投票キック ----
  socket.on('kick:start', ({ target } = {}) => {
    const c = ctx();
    if (!c) return;
    const room = c.room;
    if (room.kick) return toast('すでにキック投票が行われています');
    const wait = (kickCooldown.get(c.pid) || 0) + KICK_COOLDOWN_MS - now();
    if (wait > 0) {
      const s = Math.ceil(wait / 1000);
      return toast(`キック投票はあと${Math.floor(s / 60)}分${s % 60}秒で使えます`);
    }
    const conn = humanPlayers(room);
    if (conn.length < 3) return toast('キック投票は3人以上いるときに使えます');
    const t = typeof target === 'string' ? room.players.find((q) => q.pub === target) : null;
    if (!t || !t.connected || t.left || t.bot) return toast('対象が見つかりません');
    if (t.id === c.pid) return toast('自分自身はキックできません');
    const voters = conn.filter((q) => q.id !== t.id).map((q) => q.id);
    const needed = Math.floor((voters.length * 2 + 2) / 3); // 投票できる人数の2/3以上(切り上げ)
    kickCooldown.set(c.pid, now());
    const k = {
      by: c.pid,
      target: t.id,
      voters,
      needed,
      votes: { [c.pid]: true },
      endsAt: now() + KICK_VOTE_MS,
      total: KICK_VOTE_MS,
      timer: null,
    };
    k.timer = setTimeout(() => {
      if (room.kick === k) finishKick(room, kickYesCount(k) >= k.needed);
    }, KICK_VOTE_MS);
    room.kick = k;
    broadcast(room);
    checkKick(room);
  });

  socket.on('kick:vote', ({ yes } = {}) => {
    const c = ctx();
    const k = c && c.room.kick;
    if (!k || !k.voters.includes(c.pid) || k.votes[c.pid] !== undefined) return;
    k.votes[c.pid] = !!yes;
    broadcast(c.room);
    checkKick(c.room);
  });

  // ---- チャット ----
  socket.on('chat', ({ text } = {}) => {
    const c = ctx();
    if (!c) return;
    const t = sanitizeChat(text);
    if (!t) return;
    const t0 = now();
    c.p.chatTimes = c.p.chatTimes.filter((x) => t0 - x < 5000);
    if (c.p.chatTimes.length >= 5) return toast('投稿が早すぎます');
    c.p.chatTimes.push(t0);
    const msg = { id: ++c.room.chatSeq, from: c.p.pub, name: dispName(c.p), text: t };
    c.room.chat.push(msg);
    if (c.room.chat.length > CHAT_KEEP) c.room.chat.shift();
    io.to(c.room.code).emit('chat', msg);
  });

  // ---- 通話(WebRTC のシグナリング中継。音声そのものはサーバーを通らない) ----
  socket.on('voice:join', () => {
    const c = ctx();
    if (!c) return;
    c.room.voice.add(c.pid);
    const peers = c.room.players
      .filter((q) => q.id !== c.pid && q.connected && c.room.voice.has(q.id))
      .map((q) => ({ id: q.pub }));
    socket.emit('voice:peers', peers);
    broadcast(c.room);
  });

  socket.on('voice:leave', () => {
    const c = ctx();
    if (!c) return;
    dropVoice(c.room, c.p);
    broadcast(c.room);
  });

  socket.on('voice:signal', ({ to, data } = {}) => {
    const c = ctx();
    if (!c || !c.room.voice.has(c.pid)) return;
    if (typeof to !== 'string' || !data || typeof data !== 'object') return;
    if (JSON.stringify(data).length > 20000) return;
    const target = c.room.players.find((q) => q.pub === to);
    if (!target || !target.connected || !c.room.voice.has(target.id)) return;
    io.to(target.socketId).emit('voice:signal', { from: c.p.pub, data });
  });

  socket.on('leave', () => {
    const c = ctx();
    if (c) leaveRoom(c.room, c.pid);
    socket.data.pid = null;
    socket.emit('left');
  });

  socket.on('disconnect', () => {
    const c = ctx();
    if (!c) return;
    // 別の接続に差し替わっている場合は何もしない
    if (c.p.socketId !== socket.id) return;
    c.p.connected = false;
    dropVoice(c.room, c.p);
    if (c.room.phase === 'lobby') {
      c.p.dropTimer = setTimeout(() => {
        const r = rooms.get(c.room.code);
        if (r && !c.p.connected) removePlayer(r, c.pid);
      }, LOBBY_DROP_MS);
    }
    afterDisconnect(c.room);
  });
});

server.listen(PORT, () => console.log(`厨二王選手権 server listening on :${PORT}`));

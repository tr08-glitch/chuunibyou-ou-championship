// 擬似クライアント3人で1ラウンドを通すスモークテスト
// 使い方: サーバー起動後に `node test/smoke.js`(PORT環境変数で変更可)
const { io } = require('socket.io-client');
const { ALL, makeTheme } = require('../words');

const URL = `http://localhost:${process.env.PORT || 3000}`;
const fail = (m) => { console.error('NG:', m); process.exit(1); };
const ok = (m) => console.log('OK:', m);
// 1x1 の有効なPNG(手書き回答のテスト用)
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// お題生成チェック
{
  const used = new Set();
  const lens = {};
  for (let i = 0; i < 2000; i++) {
    const t = makeTheme();
    const n = [...t].length;
    if (n < 3 || n > 6) fail(`お題の文字数が範囲外: ${t}`);
    if (new Set([...t]).size !== n) fail(`漢字重複: ${t}`);
    lens[n] = (lens[n] || 0) + 1;
    used.add(t);
  }
  ok(`お題生成 単語数=${ALL.length} 文字数分布=${JSON.stringify(lens)} ユニーク=${used.size}/2000`);
}

function client(name) {
  const pid = 'pid-' + name + '-' + Math.random().toString(36).slice(2);
  const sock = io(URL, { transports: ['websocket'] });
  const c = { name, pid, sock, state: null, toasts: [], chats: [], peers: null, signals: [], voiceLeft: [], resumable: null };
  sock.on('state', (s) => { c.state = s; });
  sock.on('toast', (m) => c.toasts.push(m));
  sock.on('chat', (m) => c.chats.push(m));
  sock.on('voice:peers', (l) => { c.peers = l; });
  sock.on('voice:signal', (s) => c.signals.push(s));
  sock.on('voice:left', (x) => c.voiceLeft.push(x.id));
  sock.on('resumable', (i) => { c.resumable = i; });
  sock.on('kicked', () => { c.kicked = true; });
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await wait(50);
  }
  fail(`タイムアウト: ${label}`);
}

(async () => {
  const [a, b, c] = ['A', 'B', 'C'].map(client);
  await wait(300);

  a.sock.emit('create', { pid: a.pid, name: 'Alice' });
  await until(() => a.state && a.state.phase === 'lobby', 'ロビー作成');
  const code = a.state.code;
  ok(`ルーム作成 code=${code}`);

  b.sock.emit('join', { pid: b.pid, name: 'Bob', code });
  c.sock.emit('join', { pid: c.pid, name: 'Cathy', code });
  await until(() => a.state.players.length === 3, '3人入室');
  ok('3人入室');

  // 本人用ID(pid)が他のプレイヤーに見える状態(state)へ漏れていない
  const raw = JSON.stringify([a.state, b.state, c.state]);
  if ([a, b, c].some((x) => raw.includes(x.pid))) fail('pid が state に含まれている');
  ok('pid は他のプレイヤーに見えない(公開IDのみ)');

  // 復帰確認: 新しい接続から peek すると、戻れる部屋の情報だけが返る(まだ復帰はしない)
  {
    const t = client('T');
    await wait(300);
    t.sock.emit('peek', { pid: b.pid });
    await until(() => t.resumable, '復帰確認の応答');
    if (t.resumable.code !== code || t.resumable.phase !== 'lobby') fail('復帰確認の内容が不正');
    await wait(200);
    if (t.state) fail('peek だけで復帰してしまった');
    t.sock.close();
    ok(`復帰確認OK: ルーム${t.resumable.code}(${t.resumable.phase}) / peek だけでは復帰しない`);
  }

  // チャット
  a.sock.emit('chat', { text: 'こんにちは' });
  await until(() => b.chats.length === 1 && c.chats.length === 1, 'チャット受信');
  if (b.chats[0].name !== 'Alice' || b.chats[0].text !== 'こんにちは') fail('チャット内容が不正');
  for (let i = 0; i < 8; i++) a.sock.emit('chat', { text: 'spam' + i });
  await wait(300);
  if (b.chats.length > 6) fail('連投制限が効いていない: ' + b.chats.length);
  ok(`チャットOK(連投制限: 5秒に5件まで / 受信${b.chats.length}件)`);

  // 通話のシグナリング中継
  b.sock.emit('voice:join');
  await until(() => b.peers !== null, 'voice:peers(b)');
  if (b.peers.length !== 0) fail('最初の参加者に相手がいる');
  a.sock.emit('voice:join');
  await until(() => a.peers !== null, 'voice:peers(a)');
  const bPub = b.state.me;
  const bState = () => a.state.players.find((p) => p.id === bPub);
  await until(() => bState() && bState().voice, 'stateに通話中が反映');
  if (a.peers.length !== 1 || a.peers[0].id !== bPub) fail('参加済みの相手一覧が不正');
  a.sock.emit('voice:signal', { to: bPub, data: { sdp: { type: 'offer', sdp: 'x' } } });
  await until(() => b.signals.length === 1, 'signal中継');
  if (b.signals[0].from !== a.state.me) fail('signal の送信元が不正');
  // 通話に参加していない人へは中継しない / 参加していない人からは送れない
  a.sock.emit('voice:signal', { to: c.state.me, data: { candidate: {} } });
  c.sock.emit('voice:signal', { to: a.state.me, data: { candidate: {} } });
  await wait(300);
  if (c.signals.length || a.signals.length) fail('通話外の人とsignalをやり取りできてしまった');
  b.sock.emit('voice:leave');
  await until(() => a.voiceLeft.includes(bPub), 'voice:left通知');
  ok('通話の中継OK(参加者のみ・退出通知あり)');

  a.sock.emit('settings', { rounds: 1, answerSec: 30, voteSec: 20 });
  await until(() => a.state.settings.rounds === 1, '設定変更');

  // ホスト以外は開始できない
  b.sock.emit('start');
  await wait(200);
  if (a.state.phase !== 'lobby') fail('非ホストが開始できてしまった');
  ok('非ホストの開始は無効');

  a.sock.emit('start');
  await until(() => [a, b, c].every((x) => x.state && x.state.phase === 'answer'), '回答フェーズ');
  ok(`回答フェーズ開始 お題=${a.state.theme}`);

  // 不正な画像(小さすぎる/PNGではない)は拒否される
  c.sock.emit('answer', { img: 'data:image/png;base64,AAAA' });
  c.sock.emit('answer', { img: 'data:text/html;base64,PHNjcmlwdD4=' });
  await wait(300);
  if (c.state.myAnswer != null) fail('不正な画像を受理してしまった');
  ok('不正な画像は拒否');

  a.sock.emit('answer', { text: 'ヘルファイア' });
  b.sock.emit('answer', { text: 'デモンズゲート' });
  c.sock.emit('answer', { img: TINY_PNG }); // Cathy は手書き回答
  // 全員提出 → 発表(1人ずつ名前つきで公開)→ 投票
  await until(() => [a, b, c].every((x) => x.state.phase === 'present'), '全員提出で発表へ');
  if (a.state.present.total !== 3 || a.state.present.items.length !== 1) fail('発表の表示が不正');
  ok('全員提出で発表フェーズへ(最初は1人だけ公開)');
  b.sock.emit('present:next'); // 非ホストは進められない
  await wait(200);
  if (a.state.present.idx !== 0) fail('非ホストが発表を進めた');
  a.sock.emit('present:next');
  await until(() => a.state.present && a.state.present.idx === 1 && a.state.present.items.length === 2, '2人目の公開');
  a.sock.emit('present:next');
  await until(() => a.state.present && a.state.present.idx === 2 && a.state.present.last, '最後の発表');
  const shown = a.state.present.items.map((i) => i.name).sort().join(',');
  if (shown !== 'Alice,Bob,Cathy') fail('発表に名前が出ていない: ' + shown);
  a.sock.emit('present:next');
  await until(() => [a, b, c].every((x) => x.state.phase === 'vote'), '発表のあと投票へ');
  if (a.state.options.some((o) => !o.name)) fail('投票に名前が出ていない');
  ok('発表 → 投票: 全員の回答が名前つきで公開される');

  // 投票: 自分の回答には投票できない
  const mineIdx = a.state.options.find((o) => o.mine).idx;
  a.sock.emit('vote', { idx: mineIdx });
  await wait(200);
  if (a.state.myVote != null) fail('自分に投票できてしまった');
  ok('自分への投票は拒否');

  // A→Bの回答, B→Aの回答, C→Aの回答 (テキストで探す)
  const idxOf = (cl, text) => cl.state.options.find((o) => o.kind === 'text' && o.value === text).idx;
  if (!a.state.options.some((o) => o.kind === 'img')) fail('手書き回答が投票に出ていない');
  ok('手書き回答が投票の選択肢に表示される');
  a.sock.emit('vote', { idx: idxOf(a, 'デモンズゲート') });
  b.sock.emit('vote', { idx: idxOf(b, 'ヘルファイア') });
  c.sock.emit('vote', { idx: idxOf(c, 'ヘルファイア') });
  await until(() => [a, b, c].every((x) => x.state.phase === 'result'), '結果フェーズ');
  const e = a.state.result.entries;
  if (e[0].value !== 'ヘルファイア' || e[0].votes !== 2 || e[0].name !== 'Alice') fail('集計が不正: ' + JSON.stringify(e).slice(0, 300));
  if (!e.some((x) => x.kind === 'img' && x.name === 'Cathy')) fail('結果に手書き回答がない');
  ok(`集計OK: ${e.map((x) => `${x.name}:${x.votes}票`).join(' ')}`);

  a.sock.emit('next');
  await until(() => [a, b, c].every((x) => x.state.phase === 'final'), '最終結果');
  const r = a.state.ranking;
  if (!r[0].winner || r[0].name !== 'Alice' || r[0].total !== 2) fail('ランキング不正: ' + JSON.stringify(r));
  ok(`最終結果OK: 優勝=${r.filter((x) => x.winner).map((x) => x.name)}`);

  a.sock.emit('again');
  await until(() => a.state.phase === 'lobby' && a.state.round === 0, 'ロビーに戻る');
  ok('もう一度 → ロビー復帰');

  // ランダムマッチ
  const q = [client('Q1'), client('Q2'), client('Q3')];
  await wait(300);
  q.forEach((x, i) => x.sock.emit('quick', { pid: x.pid, name: 'Q' + i }));
  await until(() => q.every((x) => x.state && x.state.players.length === 3), 'ランダムマッチで同室');
  if (!q[0].state.isPublic || q[0].state.timerKind !== 'auto') fail('自動開始タイマーが動いていない');
  ok(`ランダムマッチ: 3人が同室(code=${q[0].state.code})、自動開始タイマー作動`);

  // ふりがな(名前の上に小さく表示するための情報)
  {
    const [r1, r2] = ['R1', 'R2'].map(client);
    await wait(300);
    r1.sock.emit('create', { pid: r1.pid, name: '地獄', ruby: 'ヘル' });
    await until(() => r1.state, 'ふりがな付きで作成');
    const rn = r1.state.players[0].name;
    if (rn !== '地獄\u001fヘル') fail('ふりがな付きの名前が不正: ' + JSON.stringify(rn));
    // 制御文字は取り除かれ、ふりがなは24文字まで
    r2.sock.emit('join', { pid: r2.pid, name: 'A\u001fB', ruby: 'x'.repeat(40), code: r1.state.code });
    await until(() => r1.state.players.length === 2, '2人目入室');
    const [nm2, rb2] = r1.state.players[1].name.split('\u001f');
    if (nm2 !== 'AB' || rb2.length !== 24) fail('名前・ふりがなの整形が不正: ' + JSON.stringify(r1.state.players[1].name));
    // ふりがななしの人はそのままの名前
    r1.sock.emit('chat', { text: 'やあ' });
    await until(() => r2.chats.length === 1, 'チャット受信');
    if (r2.chats[0].name !== '地獄\u001fヘル') fail('チャットの名前にふりがながない');
    ok('ふりがなOK: 名前+ふりがなが送られる(制御文字の除去・24文字制限・チャットにも反映)');
    [r1, r2].forEach((x) => x.sock.close());
  }

  // 投票キック
  {
    const [k1, k2, k3, k4] = ['K1', 'K2', 'K3', 'K4'].map(client);
    await wait(300);
    k1.sock.emit('create', { pid: k1.pid, name: 'K1' });
    await until(() => k1.state, 'K1作成');
    const kc = k1.state.code;
    k2.sock.emit('join', { pid: k2.pid, name: 'K2', code: kc });
    k3.sock.emit('join', { pid: k3.pid, name: 'K3', code: kc });
    await until(() => k1.state.players.length === 3, 'K3人入室');

    // 可決: 対象を除く2人(開始者の自動賛成 + 1票)で2/3以上
    k1.sock.emit('kick:start', { target: k3.state.me });
    await until(() => k2.state.kick && k3.state.kick, 'キック投票の表示');
    const kv = k2.state.kick;
    if (kv.needed !== 2 || kv.total !== 2 || kv.yes !== 1) fail('キック投票の人数が不正: ' + JSON.stringify(kv));
    if (!k3.state.kick.isTarget || k3.state.kick.canVote) fail('対象が投票できる状態になっている');
    k3.sock.emit('kick:vote', { yes: false }); // 対象の投票は無効
    await wait(200);
    if (!k2.state.kick || k2.state.kick.yes !== 1) fail('対象の投票が反映された');
    k2.sock.emit('kick:vote', { yes: true });
    await until(() => k3.kicked, 'キックされた通知');
    await until(() => k1.state.players.length === 2, '対象が部屋から外れる');
    ok('キック可決: 賛成2/2で対象が退出');

    // 入室禁止
    k3.sock.emit('join', { pid: k3.pid, name: 'K3', code: kc });
    await until(() => k3.toasts.some((t) => t.includes('入れません')), '再入室の拒否');
    ok('キックされた人は同じルームに入れない');

    // 15分に1回の制限(部屋の人数を3人に戻して確認)
    k4.sock.emit('join', { pid: k4.pid, name: 'K4', code: kc });
    await until(() => k1.state.players.length === 3, 'K4入室');
    k1.sock.emit('kick:start', { target: k4.state.me });
    await until(() => k1.toasts.some((t) => t.includes('あと')), 'クールダウン');
    if (k1.state.kick) fail('クールダウン中に投票が始まった');
    ok('キック投票は15分に1回まで');

    // 否決: 反対が出て2/3に届かなくなったら即否決
    k2.sock.emit('kick:start', { target: k4.state.me });
    await until(() => k1.state.kick, '2回目の投票');
    k1.sock.emit('kick:vote', { yes: false });
    await until(() => !k1.state.kick && k1.toasts.some((t) => t.includes('否決')), '否決');
    if (k1.state.players.length !== 3 || k4.kicked) fail('否決なのに対象が退出した');
    ok('キック否決: 対象は残る');
    [k1, k2, k3, k4].forEach((x) => x.sock.close());
  }

  // ---- テスト用CPU: 1人 + CPU2体で1ラウンド通す ----
  {
    const s1 = client('Solo');
    await wait(200);
    s1.sock.emit('create', { pid: s1.pid, name: 'Solo' });
    await until(() => s1.state && s1.state.phase === 'lobby', 'CPU部屋作成');
    s1.sock.emit('bot:add');
    s1.sock.emit('bot:add');
    await until(() => s1.state.players.length === 3, 'CPU2体追加');
    if (!s1.state.players.filter((p) => p.bot).length === 2) fail('bot フラグ');
    s1.sock.emit('settings', { rounds: 1, answerSec: 30, voteSec: 20 });
    s1.sock.emit('start');
    await until(() => s1.state.phase === 'answer', 'CPU部屋で開始');
    s1.sock.emit('answer', { text: 'ソロ回答' });
    await until(() => s1.state.phase === 'present', 'CPUが回答して発表へ', 15000);
    while (s1.state.phase === 'present') { s1.sock.emit('present:next'); await wait(150); }
    await until(() => s1.state.phase === 'vote', '投票へ');
    const idx = s1.state.options.find((o) => !o.mine).idx;
    s1.sock.emit('vote', { idx });
    await until(() => s1.state.phase === 'result', 'CPUが投票して結果へ', 15000);
    ok('CPU2体 + 1人で1ラウンドが最後まで進む');
    s1.sock.close();

    // ランダムマッチ部屋ではCPU追加不可
    const s2 = client('Pub');
    await wait(200);
    s2.sock.emit('quick', { pid: s2.pid, name: 'Pub' });
    await until(() => s2.state && s2.state.isPublic, '公開部屋');
    // 他のテストの待機中の人と同室になることがあるので、ホストかどうかに関わらず確認
    s2.sock.emit('bot:add');
    await wait(300);
    if (s2.state.players.some((p) => p.bot)) fail('公開部屋にCPUが追加された');
    ok('ランダムマッチ部屋ではCPUを追加できない');
    s2.sock.close();
  }

  [a, b, c, ...q].forEach((x) => x.sock.close());
  console.log('\nすべて成功');
  process.exit(0);
})();

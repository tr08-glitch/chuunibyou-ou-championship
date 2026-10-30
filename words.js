// お題用の単語リスト(叩き台)。ここを編集すれば単語を増減できます。
const WORDS1 = `死 血 闇 剣 影 罪 罰 魔 神 獄 呪 骨 牙 爪 涙 嘘 愚 鬼 竜 蛇 狂 滅 虚 禍 毒 雷 炎 氷 魂 終 黒 赤 夜 刃 棺`.split(/\s+/);

const WORDS2 = `地獄 天使 弾丸 欺瞞 偽善 悪魔 堕天 絶望 禁忌 深淵 終焉 滅亡 混沌 虚無 灼熱 氷結 漆黒 紅蓮 暗黒 咆哮 鮮血 骸骨 亡霊 死神 魔王 勇者 聖剣 魔剣 邪眼 邪神 覚醒 封印 解放 契約 運命 宿命 因果 輪廻 転生 復讐 断罪 審判 贖罪 懺悔 背徳 狂気 憎悪 慟哭 絶叫 殺意 殺戮 破壊 創造 崩壊 零度 無限 永遠 刹那 幻影 幻想 月光 星屑 流星 黄昏 黎明 夜明 戦場 戦慄 闘争 反逆 革命 支配 服従 孤独 絶対 神話 伝説 禁断 魔導 召喚 呪文 結界 煉獄 楽園 天界 冥府 冥界 聖域 暴走 暴君 覇王 鉄槌 烙印 十字 聖杯 棺桶`.split(/\s+/);

const WORDS3 = `犠牲者 反逆者 破壊者 支配者 絶対者 亡命者 堕天使 魔術師 暗殺者 終末論 審判者 守護者 復讐者 錬金術 黙示録 処刑人 死刑囚 背徳者 異端者`.split(/\s+/);

const ALL = [...new Set([...WORDS1, ...WORDS2, ...WORDS3])];

const MIN_LEN = 3;
const MAX_LEN = 6;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 1〜3語をランダムに組み合わせ、3〜6文字・同じ漢字の重複なしのお題を返す
function makeTheme(used = new Set()) {
  for (let t = 0; t < 500; t++) {
    const r = Math.random();
    const n = r < 0.1 ? 1 : r < 0.7 ? 2 : 3;
    const picked = shuffle(ALL).slice(0, n);
    const theme = picked.join('');
    const chars = [...theme];
    if (chars.length < MIN_LEN || chars.length > MAX_LEN) continue;
    if (new Set(chars).size !== chars.length) continue;
    if (used.has(theme)) continue;
    return theme;
  }
  return '地獄業火';
}

module.exports = { ALL, WORDS1, WORDS2, WORDS3, makeTheme };

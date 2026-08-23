/**
 * Zhongdex canon build — CC-CEDICT join and pinyin conventions.
 *
 * The HSK 3.0 list ships a `CEDICT` column holding one or more join keys in the
 * form `traditional|simplified[numbered pinyin]`, e.g. `愛|爱[ai4]`. Multiple
 * keys are separated by `/` when the headword has competing traditional forms
 * (`裡|里[li3]/裏|里[li3]`). This module parses those keys and resolves them
 * against the CC-CEDICT dump, tolerating the small set of real disagreements
 * between the two sources (letter case on proper nouns, neutral-tone spelling).
 */

import type {
  CedictEntry,
  CedictFile,
  CedictKey,
  CedictMatch,
  CedictMatchTier,
} from "./types.js";

export type CedictIndex = ReadonlyMap<string, readonly CedictEntry[]>;

export function parseCedict(text: string): CedictFile {
  const parsed = JSON.parse(text) as CedictFile;
  if (typeof parsed !== "object" || parsed === null || typeof parsed.data !== "object") {
    throw new Error("cedict.json: unexpected shape, expected { version, date, entries, data }");
  }
  return parsed;
}

/** Index CC-CEDICT by simplified headword, which is how the dump is already keyed. */
export function indexCedict(file: CedictFile): CedictIndex {
  return new Map(Object.entries(file.data));
}

const KEY_RE = /^(.+?)\|(.+?)\[(.*)\]$/;

/** Split a `CEDICT` cell into its `/`-separated keys. Unparseable parts are skipped. */
export function parseCedictKeys(raw: string): CedictKey[] {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const keys: CedictKey[] = [];
  for (const part of trimmed.split("/")) {
    const m = KEY_RE.exec(part);
    if (m === null) continue;
    const [, traditional, simplified, numbered] = m;
    if (traditional === undefined || simplified === undefined || numbered === undefined) continue;
    keys.push({ raw: part, traditional, simplified, numbered });
  }
  return keys;
}

/**
 * True when two numbered-pinyin strings differ only in neutral tone, e.g.
 * `ma3 tou2` vs `ma3 tou5`. The HSK list and CC-CEDICT genuinely disagree on
 * neutral tone for a handful of words; that is not a failed join.
 */
function neutralToneEqual(a: string, b: string): boolean {
  const left = a.toLowerCase().split(/\s+/);
  const right = b.toLowerCase().split(/\s+/);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined || y === undefined) return false;
    if (x === y) continue;
    if (x.slice(0, -1) === y.slice(0, -1) && (x.endsWith("5") || y.endsWith("5"))) continue;
    return false;
  }
  return true;
}

const TIERS: readonly {
  tier: CedictMatchTier;
  test: (entry: CedictEntry, key: CedictKey) => boolean;
}[] = [
  { tier: "exact", test: (e, k) => e.t === k.traditional && e.pn === k.numbered },
  {
    tier: "case-insensitive",
    test: (e, k) => e.t === k.traditional && e.pn.toLowerCase() === k.numbered.toLowerCase(),
  },
  {
    tier: "neutral-tone",
    test: (e, k) => e.t === k.traditional && neutralToneEqual(e.pn, k.numbered),
  },
  { tier: "pinyin-only", test: (e, k) => e.pn.toLowerCase() === k.numbered.toLowerCase() },
  { tier: "pinyin-only-neutral-tone", test: (e, k) => neutralToneEqual(e.pn, k.numbered) },
  { tier: "traditional-only", test: (e, k) => e.t === k.traditional },
];

/** Resolve one key, taking the first tier that matches anything. Null = a real miss. */
export function resolveCedictKey(index: CedictIndex, key: CedictKey): CedictMatch | null {
  const candidates = index.get(key.simplified);
  if (candidates === undefined || candidates.length === 0) return null;
  for (const { tier, test } of TIERS) {
    const entries = candidates.filter((entry) => test(entry, key));
    if (entries.length > 0) return { key, tier, entries };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Pinyin                                                                      */
/* -------------------------------------------------------------------------- */

const TONE_MARKS = new Map<string, readonly [string, number]>([
  ["ā", ["a", 1]], ["á", ["a", 2]], ["ǎ", ["a", 3]], ["à", ["a", 4]],
  ["ē", ["e", 1]], ["é", ["e", 2]], ["ě", ["e", 3]], ["è", ["e", 4]],
  ["ī", ["i", 1]], ["í", ["i", 2]], ["ǐ", ["i", 3]], ["ì", ["i", 4]],
  ["ō", ["o", 1]], ["ó", ["o", 2]], ["ǒ", ["o", 3]], ["ò", ["o", 4]],
  ["ū", ["u", 1]], ["ú", ["u", 2]], ["ǔ", ["u", 3]], ["ù", ["u", 4]],
  ["ǖ", ["ü", 1]], ["ǘ", ["ü", 2]], ["ǚ", ["ü", 3]], ["ǜ", ["ü", 4]],
  ["ń", ["n", 2]], ["ň", ["n", 3]], ["ǹ", ["n", 4]], ["ḿ", ["m", 2]],
]);

/**
 * Every pinyin syllable that occurs in the CC-CEDICT dump, minus the stray
 * single letters and non-syllables that dump contains ("xx", "b", "coser").
 * Harvested once and pinned here so the segmenter cannot drift with the data.
 */
const PINYIN_SYLLABLES: ReadonlySet<string> = new Set(
  `a ai an ang ao ba bai ban bang bao bei ben beng bi bia bian biang biao bie bin bing biu bo
   bu ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou
   chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cue cui cun cuo da dai dan
   dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo e ei en
   eng er fa fan fang fei fen feng fiao fo fou fu ga gai gan gang gao ge gei gen geng gong gou
   gu gua guai guan guang gui gun guo ha hai han hang hao he hei hen heng hm hng hong hou hu
   hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue
   jun ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai
   lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo
   lü lüe m ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu n na
   nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nun
   nuo nü nüe o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu pua qi
   qia qian qiang qiao qie qin qing qiong qiu qu quan que qun r ran rang rao re ren reng ri
   rong rou ru rua ruan rui run ruo sa sai san sang sao se sei sen seng sha shai shan shang
   shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su
   suan sui sun suo ta tai tan tang tao te tei teng ti tian tiao tie ting tong tou tu tuan tui
   tun tuo wa wai wan wang wei wen weng wo wu xi xia xian xiang xiao xie xin xing xiong xiu xu
   xuan xue xun ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun za zai zan zang zao
   ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai
   zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo`.split(/\s+/),
);

const MAX_SYLLABLE_LENGTH = 6;

/** Split a toneless pinyin run into syllables, longest-first with backtracking. */
function segment(plain: string): string[] | null {
  const memo = new Map<number, string[] | null>();
  const walk = (i: number): string[] | null => {
    if (i === plain.length) return [];
    const cached = memo.get(i);
    if (cached !== undefined) return cached;
    for (let len = Math.min(MAX_SYLLABLE_LENGTH, plain.length - i); len > 0; len -= 1) {
      const candidate = plain.slice(i, i + len);
      if (!PINYIN_SYLLABLES.has(candidate)) continue;
      const rest = walk(i + len);
      if (rest !== null) {
        const result = [candidate, ...rest];
        memo.set(i, result);
        return result;
      }
    }
    memo.set(i, null);
    return null;
  };
  return walk(0);
}

/**
 * Convert tone-marked pinyin to CC-CEDICT numbered pinyin ("jiànguo" →
 * "jian4 guo5"). Only used for the handful of HSK rows that carry no CC-CEDICT
 * join key; everywhere else the key's own numbered pinyin is authoritative.
 * Returns null when the string cannot be segmented into real syllables.
 */
export function markedToNumbered(marked: string): string | null {
  const out: string[] = [];
  const tokens = marked.toLowerCase().match(/\p{L}+/gu);
  if (tokens === null) return null;
  for (const token of tokens) {
    let plain = "";
    const tones: number[] = [];
    for (const ch of token) {
      const mark = TONE_MARKS.get(ch);
      if (mark !== undefined) {
        plain += mark[0];
        tones.push(mark[1]);
      } else if (ch === "v") {
        plain += "ü";
        tones.push(0);
      } else if (/^[a-zü]$/.test(ch)) {
        plain += ch;
        tones.push(0);
      } else {
        return null;
      }
    }
    const syllables = segment(plain);
    if (syllables === null) return null;
    let at = 0;
    for (const syllable of syllables) {
      let tone = 0;
      for (let k = at; k < at + syllable.length; k += 1) {
        const t = tones[k];
        if (t !== undefined && t !== 0) tone = t;
      }
      out.push(`${syllable.replace(/ü/g, "u:")}${tone === 0 ? 5 : tone}`);
      at += syllable.length;
    }
  }
  return out.length === 0 ? null : out.join(" ");
}

/** Last-resort id material: tone marks stripped, ASCII only. */
export function tonelessSlug(marked: string): string {
  let out = "";
  for (const ch of marked.toLowerCase()) {
    const mark = TONE_MARKS.get(ch);
    if (mark !== undefined) out += mark[0] === "ü" ? "v" : mark[0];
    else if (ch === "ü") out += "v";
    else if (/^[a-z0-9]$/.test(ch)) out += ch;
  }
  return out;
}

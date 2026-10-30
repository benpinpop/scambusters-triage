// Keyword CSV parser, text normalizer and scorer. Pure ES module (Node-testable).

/**
 * Score bands. These are HEURISTICS, not verdicts: tune freely.
 * Each entry: the band applies when score >= min (highest matching min wins).
 */
export const BAND_THRESHOLDS = [
  { min: 0, band: 'Low' },
  { min: 25, band: 'Medium' },
  { min: 50, band: 'High' },
  { min: 75, band: 'Very high' },
];

/**
 * Maps raw points to 0..100:  score = round(100 * (1 - exp(-points / SCORE_SCALE))).
 * Smooth saturation: 1 strong signal (weight 5) is ~15, ~25 points gives ~55,
 * ~45 points gives ~75. Calibrated against test/keywords.test.js samples.
 */
export const SCORE_SCALE = 30;

/** Max occurrences of one keyword that count toward points. */
export const MAX_COUNT_PER_KEYWORD = 3;

/** Category that only provides context (adds 0 points). */
export const CONTEXT_CATEGORY = 'crypto_context';

/** Minimum distinct crypto_context keywords to set cryptoContext. */
export const CRYPTO_CONTEXT_MIN_HITS = 2;

/** Multiplier applied to points when there is no crypto context. */
export const NO_CRYPTO_DAMPEN = 0.5;

const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF\u00AD]/g;

export function normalizeText(s) {
  return String(s ?? '')
    .replace(ZERO_WIDTH, '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCsvRows(text) {
  const rows = [];
  let row = [], field = '', inQ = false, any = false;
  const s = String(text ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"' && field === '') { inQ = true; any = true; }
    else if (c === ',') { row.push(field); field = ''; any = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      if (any || field !== '') { row.push(field); rows.push(row); }
      row = []; field = ''; any = false;
    } else { field += c; any = true; }
  }
  if (any || field !== '') { row.push(field); rows.push(row); }
  return rows;
}

/** @returns {{keyword:string, category:string, weight:number}[]} */
export function parseKeywordCsv(text) {
  const rows = parseCsvRows(text);
  const out = new Map();
  for (const r of rows) {
    if (r.length < 3) continue;
    const keyword = normalizeText(r[0]);
    const category = r[1].trim().toLowerCase();
    const weight = Number(r[2].trim());
    if (!keyword || !category || r[2].trim() === '' || !Number.isFinite(weight)) continue; // also skips header
    const prev = out.get(keyword);
    if (!prev || weight > prev.weight) out.set(keyword, { keyword, category, weight });
  }
  return [...out.values()];
}

const isAlnum = (c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');

/** Count whole-word occurrences of kw in already-normalized text (stops at `max`). */
function countWord(text, kw, max) {
  let n = 0, from = 0;
  for (;;) {
    const i = text.indexOf(kw, from);
    if (i < 0) break;
    const before = i === 0 ? '' : text[i - 1];
    const after = text[i + kw.length] ?? '';
    // Boundary only applies where the keyword edge is itself alphanumeric.
    const lead = isAlnum(kw[0]) && before && isAlnum(before);
    const trail = isAlnum(kw[kw.length - 1]) && after && isAlnum(after);
    if (!lead && !trail) { n++; if (n >= max) break; }
    from = i + 1;
  }
  return n;
}

export function bandFor(score) {
  let band = BAND_THRESHOLDS[0].band;
  for (const t of BAND_THRESHOLDS) if (score >= t.min) band = t.band;
  return band;
}

/**
 * Matching is whole-word: (?<![a-z0-9])kw(?![a-z0-9]) semantics, implemented with
 * indexOf + boundary checks (fast on 500 kB; phrases match across any whitespace
 * because text and keywords are both whitespace-collapsed). Overlapping keywords
 * (e.g. "guaranteed returns" and "guaranteed") each count.
 * Points per keyword = weight * min(count, 3). crypto_context adds 0 points and
 * only sets cryptoContext (>= 2 distinct hits). Without crypto context the points
 * are multiplied by NO_CRYPTO_DAMPEN (0.5): scammy phrasing on a non-crypto page is
 * weaker evidence for this tool's purpose; a `note` says so.
 */
export function scoreText(text, keywords) {
  const t = normalizeText(text);
  const top = [];
  const cats = new Map();
  let cryptoHits = 0;
  for (const k of keywords || []) {
    const count = countWord(t, k.keyword, MAX_COUNT_PER_KEYWORD);
    if (!count) continue;
    if (k.category === CONTEXT_CATEGORY) { cryptoHits++; continue; }
    const points = k.weight * count;
    top.push({ keyword: k.keyword, category: k.category, weight: k.weight, count, points });
    const c = cats.get(k.category) || { category: k.category, hits: 0, points: 0 };
    c.hits++; c.points += points;
    cats.set(k.category, c);
  }
  const cryptoContext = cryptoHits >= CRYPTO_CONTEXT_MIN_HITS;
  const raw = top.reduce((a, x) => a + x.points, 0);
  const points = cryptoContext ? raw : raw * NO_CRYPTO_DAMPEN;
  const score = Math.max(0, Math.min(100, Math.round(100 * (1 - Math.exp(-points / SCORE_SCALE)))));
  top.sort((a, b) => b.points - a.points || b.weight - a.weight || a.keyword.localeCompare(b.keyword));
  const res = {
    score,
    band: bandFor(score),
    cryptoContext,
    cryptoHits,
    categories: [...cats.values()].sort((a, b) => b.points - a.points),
    top: top.slice(0, 15),
    rawPoints: raw,
  };
  if (!cryptoContext && raw > 0) res.note = 'No crypto context found; score reduced by half.';
  return res;
}

let cache = null;
export async function loadKeywords() {
  if (cache) return cache;
  const url = globalThis.chrome?.runtime?.getURL('data/crypto_scam_keywords.csv');
  if (!url) throw new Error('loadKeywords() needs the extension runtime; in Node read the CSV and call parseKeywordCsv.');
  const r = await fetch(url);
  if (!r.ok) throw new Error('Could not load keyword list (' + r.status + ')');
  cache = parseKeywordCsv(await r.text());
  return cache;
}

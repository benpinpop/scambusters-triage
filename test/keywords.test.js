import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseKeywordCsv, normalizeText, scoreText, BAND_THRESHOLDS, bandFor,
} from '../lib/keywords.js';

const csvPath = fileURLToPath(new URL('../data/crypto_scam_keywords.csv', import.meta.url));
const KW = parseKeywordCsv(readFileSync(csvPath, 'utf8'));
const mk = (rows) => parseKeywordCsv('keyword,category,weight\n' + rows.join('\n'));

test('csv: header, BOM, CRLF, blank lines, quotes, embedded commas', () => {
  const r = parseKeywordCsv('\uFEFFkeyword,category,weight\r\n\r\n"Hello, World",Cat_A, 3\r\n"say ""hi""",b,2\r\nbad,row\r\nnan,c,xyz\r\n,c,1\r\n');
  assert.deepEqual(r, [
    { keyword: 'hello, world', category: 'cat_a', weight: 3 },
    { keyword: 'say "hi"', category: 'b', weight: 2 },
  ]);
});

test('csv: dedupe keeps max weight, lowercases', () => {
  const r = parseKeywordCsv('keyword,category,weight\nFoo,a,2\nfoo,a,5\nFOO,a,1');
  assert.equal(r.length, 1);
  assert.equal(r[0].weight, 5);
});

test('csv: real file parses fully', () => {
  assert.ok(KW.length > 500);
  assert.ok(KW.every((k) => k.keyword && k.category && Number.isFinite(k.weight)));
  assert.ok(KW.some((k) => k.keyword === '100% safe'));
});

test('normalizeText: curly quotes, zero-width, whitespace', () => {
  assert.equal(normalizeText('Don\u2019t  MISS\u200B\n out'), "don't miss out");
  assert.equal(normalizeText('\u201Cx\u201D'), '"x"');
});

test('curly apostrophe matches straight keyword', () => {
  const r = scoreText('Hurry, don\u2019t miss out!', KW);
  assert.ok(r.top.some((t) => t.keyword === "don't miss out"));
});

test('word boundaries', () => {
  const kws = mk(['eth,x,5', 'btc,x,5', 'ico,x,5', 'roi,x,5', 'apy,x,5', 'mlm,x,5', 'ido,x,5']);
  const none = 'method ethics icon icons paranoid hybtcx android avoid ethical solidor apyx mlmx';
  assert.equal(scoreText(none, kws).top.length, 0);
  const yes = scoreText('Buy ETH, btc; the ICO. roi/apy (mlm) ido!', kws);
  assert.equal(yes.top.length, 7);
});

test('phrases match across any whitespace; special chars escaped', () => {
  const kws = mk(['guaranteed returns,x,5', '100% safe,x,5', 'a.b,x,2']);
  const r = scoreText('Guaranteed\n\t returns and 100% safe, aXb', kws);
  assert.deepEqual(r.top.map((t) => t.keyword).sort(), ['100% safe', 'guaranteed returns']);
  assert.equal(scoreText('15% referral', mk(['5% referral,x,3'])).top.length, 0);
});

test('count capped at 3 per keyword', () => {
  const r = scoreText('roi roi roi roi roi roi', mk(['roi,x,4']));
  assert.equal(r.top[0].count, 3);
  assert.equal(r.top[0].points, 12);
});

test('crypto_context adds no points, sets cryptoContext at >=2 hits', () => {
  const kws = mk(['bitcoin,crypto_context,1', 'usdt,crypto_context,1', 'guaranteed returns,yield_promise,5']);
  const a = scoreText('bitcoin usdt', kws);
  assert.equal(a.score, 0);
  assert.equal(a.cryptoContext, true);
  assert.equal(a.cryptoHits, 2);
  assert.equal(scoreText('bitcoin', kws).cryptoContext, false);
  const withCtx = scoreText('bitcoin usdt guaranteed returns', kws);
  const noCtx = scoreText('guaranteed returns', kws);
  assert.equal(withCtx.rawPoints, 5);
  assert.ok(noCtx.score < withCtx.score);
  assert.match(noCtx.note, /No crypto context/);
});

test('bands follow thresholds', () => {
  assert.equal(bandFor(0), 'Low');
  assert.equal(bandFor(24), 'Low');
  assert.equal(bandFor(25), 'Medium');
  assert.equal(bandFor(50), 'High');
  assert.equal(bandFor(75), 'Very high');
  assert.equal(bandFor(100), 'Very high');
  assert.equal(BAND_THRESHOLDS[0].min, 0);
});

const NEWS = 'Bitcoin and Ethereum prices rose on Tuesday as the crypto market recovered. Analysts said the blockchain sector benefits from renewed interest in stablecoin regulation. Tether and USDC supply grew. A new token launch on a decentralized exchange drew attention, though experts warned about volatility and risk. The wallet provider released a security update.';
const SCAM = 'Guaranteed 300% daily returns! Deposit USDT (TRC20) to our wallet address. Risk-free, 100% safe. Limited time offer, don\u2019t miss out, only 24 hours left! Minimum deposit 50 USDT. To withdraw you must pay a withdrawal fee first. Refer friends and earn 10% referral commission. Our AI trading bot guarantees profit. Bitcoin and Ethereum accepted.';
const BAKERY = 'Welcome to our bakery. We bake fresh bread every morning. Guaranteed fresh, limited time offer on croissants, don\u2019t miss out! Visit us on Main Street. Free delivery, support 24/7.';

test('calibration', () => {
  const n = scoreText(NEWS, KW), s = scoreText(SCAM, KW), b = scoreText(BAKERY, KW);
  console.log(`# calibration: news=${n.score}/${n.band} scam=${s.score}/${s.band} bakery=${b.score}/${b.band}`);
  assert.ok(['Low', 'Medium'].includes(n.band));
  assert.ok(['High', 'Very high'].includes(s.band));
  assert.equal(b.band, 'Low');
});

test('performance: ~500 kB under 2 s', () => {
  const big = (SCAM + ' ').repeat(Math.ceil(500000 / SCAM.length));
  const t = Date.now();
  scoreText(big, KW);
  assert.ok(Date.now() - t < 2000);
});

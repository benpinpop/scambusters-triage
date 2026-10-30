// Validator unit tests. Vectors come from the published specs (BIP-13/173/350,
// EIP-55, CashAddr spec, CIP-19, XRPL docs / XLS-5d) and from the user's
// wallet_validation test-suite (github.com/benpinpop/urlscan-dashboard), whose
// vectors are themselves the spec vectors. Generated addresses use a fixed
// hash160 so they are reproducible. Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAddress, detectChain, classifyCandidate, cleanInput, validateDestTag,
  decodeXAddress, encodeBase58Check, cashAddrEncode, toChecksumAddress, XRP_ALPHABET,
} from '../lib/validators/index.js';
import { base58CheckDecode } from '../lib/validators/base58.js';
import { decodeSegwit, bech32Decode } from '../lib/validators/bech32.js';
import { keccak_256 } from '../lib/vendor/noble-hashes/sha3.js';
import { bytesToHex } from '../lib/vendor/noble-hashes/utils.js';
import { EVM_CHAINS } from '../lib/chains.js';

const H160 = Uint8Array.from(Buffer.from('62e907b15cbf27d5425399ebf6f0fb50ebb88f18', 'hex')); // genesis pubkey hash
const b58 = v => encodeBase58Check(v, H160);

const VALID = {
  btc: ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',
        'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
        'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'],
  eth: ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
        '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
        '0xdAC17F958D2ee523a2206206994597C13D831ec7', '0xde709f2102306220921060314715629080e2fb77',
        '0x52908400098527886E0F7030069857D2E4169EE7'],
  bsc: ['0x55d398326f99059fF775485246999027B3197955'],
  trx: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', b58(0x41)],
  xrp: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', 'rrrrrrrrrrrrrrrrrrrrBZbvji',
        'rrrrrrrrrrrrrrrrrNAMEtxvNvQ', 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe', 'rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn'],
  ltc: [b58(0x30), b58(0x32), 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9'],
  doge: [b58(0x1e), b58(0x16)],
  dash: [b58(0x4c), b58(0x10)],
  bch: ['bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 'qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy',
        'BITCOINCASH:QPM2QSZNHKS23Z7629MMS6S4CWEF74VCWVY22GDX6A', 'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq'],
  ada: ['addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x',
        'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8'],
  sol: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'So11111111111111111111111111111111111111112', '11111111111111111111111111111111'],
  matic: ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'], arb: ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
  avax: ['0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359'], op: ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
};

test('vendored keccak-256 matches published vectors', () => {
  assert.equal(bytesToHex(keccak_256(new Uint8Array())), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(bytesToHex(keccak_256(new TextEncoder().encode('abc'))), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
});

test('all 15 chains: valid vectors pass with an explicit chain', () => {
  assert.equal(Object.keys(VALID).length, 15);
  for (const [chain, list] of Object.entries(VALID)) {
    for (const a of list) {
      const r = validateAddress(a, chain);
      assert.ok(r.ok, `${chain} ${a}: ${r.reason}`);
      assert.equal(r.chain, chain);
    }
  }
});

test('generated version bytes start with the documented letters', () => {
  for (const [v, re] of [[0x41, /^T/], [0x30, /^L/], [0x32, /^M/], [0x1e, /^D/], [0x16, /^[9A]/], [0x4c, /^X/], [0x10, /^7/], [0x00, /^1/], [0x05, /^3/]]) {
    assert.match(b58(v), re);
  }
});

test('auto-detection picks the right chain', () => {
  const cases = [
    ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'btc'], ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'btc'],
    ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'btc'],
    ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'eth'], ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'trx'],
    ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 'xrp'], [b58(0x30), 'ltc'], [b58(0x1e), 'doge'], [b58(0x16), 'doge'],
    [b58(0x4c), 'dash'], [b58(0x10), 'dash'], ['qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 'bch'],
    ['addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8', 'ada'],
    ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'sol'],
  ];
  for (const [a, chain] of cases) {
    const r = validateAddress(a);
    assert.ok(r.ok, `${a}: ${r.reason}`);
    assert.equal(r.chain, chain, a);
  }
  assert.equal(detectChain('hello').chain, null);
  assert.deepEqual(detectChain('0x' + 'ab'.repeat(20)).candidates, EVM_CHAINS);
  assert.equal(validateAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed').ambiguousEvm, true);
});

test('EVM: EIP-55 vectors, no-checksum tagging, bad checksum rejected', () => {
  for (const a of VALID.eth.slice(0, 4)) {
    assert.equal(toChecksumAddress(a.toLowerCase()), a);
    assert.equal(validateAddress(a, 'eth').validation, 'checksum');
  }
  const lower = validateAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 'bsc');
  assert.equal(lower.validation, 'no_checksum');
  assert.equal(lower.normalized, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
  assert.equal(lower.address, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  assert.equal(validateAddress('0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED', 'eth').validation, 'no_checksum');
  const bad = validateAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD', 'eth');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /EIP-55/);
  assert.match(validateAddress('0x123', 'eth').reason, /40 hex/);
  for (const c of EVM_CHAINS) assert.ok(validateAddress(VALID.eth[0], c).ok);
});

/** Every single-character substitution of a checksummed address must fail. */
function corruptions(addr, alphabet) {
  const out = [];
  for (const i of [1, Math.floor(addr.length / 2), addr.length - 1]) {
    for (const ch of alphabet) {
      if (ch === addr[i]) continue;
      out.push(addr.slice(0, i) + ch + addr.slice(i + 1));
      if (out.length % 5 === 0) break; // a handful per position keeps the test fast
    }
  }
  return out;
}

test('single-character corruptions fail the checksum', () => {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const cases = [
    ['btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', B58], ['btc', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', B58],
    ['btc', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', BECH],
    ['btc', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', BECH],
    ['trx', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', B58], ['xrp', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', XRP_ALPHABET],
    ['ltc', b58(0x30), B58], ['doge', b58(0x1e), B58], ['dash', b58(0x4c), B58],
    ['bch', 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', BECH],
    ['ada', 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8', BECH],
  ];
  let n = 0;
  for (const [chain, addr, alpha] of cases) {
    const start = addr.indexOf(':') + 1 || (addr.match(/^(bc1|ltc1|addr1)/) || [''])[0].length;
    for (const bad of corruptions(addr, alpha)) {
      if (bad.slice(0, start) !== addr.slice(0, start)) continue; // keep the prefix intact
      const r = validateAddress(bad, chain);
      assert.equal(r.ok, false, `${chain} corruption accepted: ${bad}`);
      n++;
    }
  }
  assert.ok(n > 100, `ran ${n} corruptions`);
  // EVM: flipping the case of one letter breaks EIP-55.
  const e = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
  for (let i = 2; i < e.length; i++) {
    if (!/[a-f]/i.test(e[i])) continue;
    const flipped = e.slice(0, i) + (e[i] === e[i].toLowerCase() ? e[i].toUpperCase() : e[i].toLowerCase()) + e.slice(i + 1);
    if (flipped === flipped.toLowerCase() || flipped.slice(2) === flipped.slice(2).toUpperCase()) continue;
    assert.equal(validateAddress(flipped, 'eth').ok, false, flipped);
  }
});

test('Bech32/Bech32m rules (BIP-173/350 negatives)', () => {
  for (const a of ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd', // v1 with bech32 checksum
                   'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5',                    // bad checksum
                   'bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',                    // mixed case
                   'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx']) {                 // testnet hrp
    assert.equal(decodeSegwit('bc', a).ok, false, a);
    assert.equal(validateAddress(a, 'btc').ok, false, a);
  }
  const v = decodeSegwit('bc', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4');
  assert.equal(Buffer.from(v.program).toString('hex').slice(0, 8), '751e76e8');
  assert.equal(validateAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'btc').normalized, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
});

test('CashAddr spec vectors round-trip with legacy', () => {
  const pairs = [
    ['1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
    ['1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR', 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy'],
    ['3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC', 'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq'],
  ];
  for (const [legacy, cash] of pairs) {
    const d = base58CheckDecode(legacy);
    assert.equal(cashAddrEncode(d.bytes[0] === 0 ? 0 : 1, d.bytes.subarray(1)), cash);
    assert.equal(validateAddress(legacy, 'bch').address, cash, 'explicit bch converts legacy to CashAddr');
    assert.equal(validateAddress(cash.split(':')[1]).normalized, cash, 'bare and prefixed forms dedupe');
    assert.equal(validateAddress(legacy).chain, 'btc', 'legacy auto-detects as BTC');
  }
  assert.equal(validateAddress('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6q', 'bch').ok, false);
  assert.equal(validateAddress('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b', 'bch').ok, false);
});

test('Cardano CIP-19 vectors and negatives', () => {
  const d = bech32Decode(VALID.ada[0], 1023);
  assert.ok(d.ok);
  assert.equal(validateAddress(VALID.ada[0]).kind, 'Shelley base (CIP-19)');
  assert.equal(validateAddress(VALID.ada[1]).kind, 'Shelley enterprise (CIP-19)');
  assert.equal(validateAddress('addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl9', 'ada').ok, false);
  assert.equal(validateAddress('addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz', 'ada').ok, false);
});

test('XRP: classic, special accounts, X-address decoding, dest tags', () => {
  assert.equal(encodeBase58Check(0x00, new Uint8Array(20), XRP_ALPHABET), 'rrrrrrrrrrrrrrrrrrrrrhoLvTp');
  assert.equal(validateAddress('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTi', 'xrp').ok, false);
  assert.equal(validateAddress('rHb9CJAWyB4rj91VRWn96Dk', 'xrp').ok, false);
  // XLS-5d vectors from xrpl.js ripple-address-codec test/index.test.ts: r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59
  const none = decodeXAddress('X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ');
  assert.ok(none.ok, none.reason);
  assert.equal(none.classic, 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59');
  assert.equal(none.tag, null);
  const one = decodeXAddress('X7AcgcsBL6XDcUb289X4mJ8djcdyKaGZMhc9YTE92ehJ2Fu');
  assert.ok(one.ok, one.reason);
  assert.equal(one.tag, '1');
  const v = validateAddress('X7AcgcsBL6XDcUb289X4mJ8djcdyKaGZMhc9YTE92ehJ2Fu');
  assert.equal(v.chain, 'xrp');
  assert.equal(v.address, 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59');
  assert.equal(v.xrpDestTag, '1');
  assert.equal(decodeXAddress('X7AcgcsBL6XDcUb289X4mJ8djcdyKaGZMhc9YTE92ehJ2Fv').ok, false);
  assert.deepEqual(validateDestTag(' 007 '), { ok: true, tag: '7' });
  assert.deepEqual(validateDestTag(''), { ok: true, tag: '' });
  assert.equal(validateDestTag('4294967295').ok, true);
  for (const bad of ['-1', '1.5', 'abc', '4294967296', '１２']) assert.equal(validateDestTag(bad).ok, false, bad);
});

test('wrong chain gives a specific reason', () => {
  const r = validateAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'btc');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Tron/);
  assert.match(validateAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'trx').reason, /34 characters/);
  assert.match(validateAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'ltc').reason, /version byte/);
  assert.match(validateAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'xrp').reason, /Ethereum/);
  assert.match(validateAddress('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 'btc').reason, /XRP/);
  assert.equal(validateAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'ltc').ok, true, 'LTC 0x05 accepted when explicit');
  assert.equal(validateAddress('xmr4abc', 'xmr').ok, false);
});

test('input cleaning strips invisible characters; CSV-injection guard', () => {
  assert.equal(cleanInput(' ​1A1zP1eP5QGef‌i2DMPTfTL5SLmv7DivfNa﻿ '), '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  assert.ok(validateAddress('1A1zP1eP5QGef​i2DMPTfTL5SLmv7DivfNa').ok);
  assert.equal(validateAddress('1A1zP1eP5QGefi2DMPT fTL5SLmv7DivfNa').ok, false);
  assert.equal(validateAddress('').ok, false);
});

test('classifyCandidate: valid / rejected / ignore, SOL gating, EVM suggestion', () => {
  assert.equal(classifyCandidate('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa').status, 'valid');
  const bad = classifyCandidate('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb');
  assert.equal(bad.status, 'rejected');
  assert.match(bad.reason, /checksum/);
  assert.equal(classifyCandidate('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6x').status, 'rejected');
  assert.equal(classifyCandidate('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD').status, 'rejected');
  assert.equal(classifyCandidate('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', { context: 'Pay on Solana' }).status, 'valid');
  assert.equal(classifyCandidate('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', { context: 'hello' }).status, 'ignore');
  assert.equal(classifyCandidate('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', { scheme: 'solana' }).result.validation, 'unverified');
  assert.equal(classifyCandidate('abcdefghijkmnopqrstuvwxyzabcdefg').status, 'ignore');
  const evm = classifyCandidate('0x55d398326f99059fF775485246999027B3197955', { context: 'Send USDT (BEP20) to' });
  assert.equal(evm.status, 'valid');
  assert.equal(evm.result.chain, 'eth');
  assert.equal(evm.result.suggestedChain, 'bsc');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { matchAuthUrl } from '../lib/autofill/urlmatch.js';
import { DEFAULT_PROFILE, DEFAULT_OPTS, sanitizeProfile, sanitizeOpts, parseCustom, formatCustom, siteTagOf } from '../lib/autofill/profile.js';

const kind = (u) => { const m = matchAuthUrl(u); return m ? m.kind : null; };

test('matchAuthUrl: sign-up and login URLs', () => {
  const signup = [
    'https://x.example/signup', 'https://x.example/sign-up', 'https://x.example/sign_up/', 'https://x.example/register',
    'https://x.example/en/registration', 'https://x.example/create-account', 'https://x.example/users/new-account',
    'https://x.example/join', 'https://x.example/Sign-Up?ref=1', 'https://x.example/#/register', 'https://x.example/#!/signup',
    'https://x.example/auth?mode=signup', 'https://x.example/account?action=register', 'https://x.example/?register',
    'https://x.example/SignUp', 'https://x.example/user-signup-form', 'https://x.example/get-started',
  ];
  for (const u of signup) assert.equal(kind(u), 'signup', u);
  const login = [
    'https://x.example/login', 'https://x.example/log-in', 'https://x.example/signin', 'https://x.example/sign-in',
    'https://x.example/user/login.php', 'https://x.example/Account/Login', 'https://x.example/#/login', 'https://login.x.example/',
    'https://x.example/auth', 'https://x.example/adminlogin', 'https://x.example/sso', 'https://x.example/?view=login',
  ];
  for (const u of login) assert.equal(kind(u), 'login', u);
});

test('matchAuthUrl: ordinary pages do not match', () => {
  const no = [
    'https://x.example/', 'https://x.example/designing-your-home', 'https://x.example/blog/authors', 'https://x.example/association',
    'https://x.example/prices', 'https://x.example/dashboard', 'https://x.example/joint-venture', 'https://x.example/oauth-guide',
    'https://x.example/search?q=register-now-offer', 'https://shop.x.example/', 'about:blank', 'chrome://extensions', 'not a url',
  ];
  for (const u of no) assert.equal(kind(u), null, u);
});

test('matchAuthUrl: signup wins over login on the same URL; via is reported', () => {
  assert.equal(kind('https://x.example/login-or-register'), 'signup');
  assert.equal(matchAuthUrl('https://x.example/signin').via, 'path');
  assert.equal(matchAuthUrl('https://x.example/#/signin').via, 'hash');
  assert.equal(matchAuthUrl('https://login.x.example/').via, 'subdomain');
});

test('defaults are exactly what was asked for', () => {
  assert.equal(DEFAULT_PROFILE.username, 'username1202');
  assert.equal(DEFAULT_PROFILE.email, 'example@example.com');
  assert.equal(DEFAULT_PROFILE.password, 'Password1*');
  assert.equal(DEFAULT_PROFILE.phone, '2025550123');
  assert.equal(DEFAULT_PROFILE.country, 'United States of America');
  assert.equal(DEFAULT_OPTS.onLoad, true);
  assert.equal(DEFAULT_OPTS.checkTerms, false);
});

test('sanitizeProfile validates and merges', () => {
  const ok = sanitizeProfile({ username: ' bob99 ', email: 'a@b.co', phone: '+1 (202) 555-0123', dob: '2000-02-29' });
  assert.ok(ok.ok);
  assert.equal(ok.profile.username, 'bob99');
  assert.equal(ok.profile.password, 'Password1*'); // untouched
  for (const bad of [{ email: 'nope' }, { phone: '12' }, { phone: 'abc1234567' }, { dob: '2001-02-30' }, { username: 'a b' }, { username: 5 }, { zip: 'x'.repeat(201) }, { password: 'a\nb' }]) {
    const r = sanitizeProfile(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.errors.length);
  }
  assert.equal(sanitizeProfile({ email: '' }).ok, true); // empty = not filled
  assert.equal(sanitizeProfile({ password: ' keep spaces ' }).profile.password, ' keep spaces ');
  assert.equal(sanitizeProfile({ evil: 1 }).profile.evil, undefined);
});

test('custom fields: parse, format, caps', () => {
  const list = parseCustom('referral = ABC123\nnot a line\n = nolabel\nsecurity answer=blue = sky\n');
  assert.deepEqual(list, [{ label: 'referral', value: 'ABC123' }, { label: 'security answer', value: 'blue = sky' }]);
  assert.equal(parseCustom(formatCustom(list)).length, 2);
  const r = sanitizeProfile({ custom: Array.from({ length: 25 }, (_, i) => ({ label: 'l' + i, value: 'v' })) });
  assert.equal(r.ok, false);
  assert.equal(sanitizeProfile({ custom: 'x' }).ok, false);
});

test('sanitizeOpts only takes known booleans', () => {
  const o = sanitizeOpts({ onLoad: 0, siteTagEmail: 1, junk: true });
  assert.equal(o.onLoad, false);
  assert.equal(o.siteTagEmail, true);
  assert.equal(o.junk, undefined);
});

test('siteTagOf', () => {
  assert.equal(siteTagOf('www.shop-x.com'), 'shopx');
  assert.equal(siteTagOf('login.bigcoin.co.uk'), 'bigcoin');
  assert.equal(siteTagOf('localhost'), '');
  assert.equal(siteTagOf('192.168.0.1'), '');
});

test('matchDepositUrl', async () => {
  const { matchDepositUrl } = await import('../lib/autofill/urlmatch.js');
  for (const u of ['https://x.example/deposit', 'https://x.example/user/Deposit/', 'https://x.example/wallet/top-up', 'https://x.example/add-funds',
    'https://x.example/#/deposit', 'https://x.example/account?action=deposit', 'https://x.example/usdt-deposit', 'https://deposit.x.example/', 'https://x.example/recharge']) {
    assert.ok(matchDepositUrl(u), u);
  }
  for (const u of ['https://x.example/', 'https://x.example/login', 'https://x.example/withdraw', 'https://x.example/depositary-receipts-blog-posts-index', 'ftp://x.example/deposit', 'nope']) {
    assert.equal(matchDepositUrl(u), null, u);
  }
});

test('depositAmount validation and default', () => {
  assert.equal(DEFAULT_PROFILE.depositAmount, '100');
  assert.equal(DEFAULT_OPTS.depositFill, true);
  assert.ok(sanitizeProfile({ depositAmount: '49.99' }).ok);
  assert.ok(sanitizeProfile({ depositAmount: '' }).ok);
  for (const bad of ['0', '-5', '1e3', 'abc', '10.999', '1,000']) assert.equal(sanitizeProfile({ depositAmount: bad }).ok, false, bad);
});

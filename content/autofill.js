// ScamBusters Triage autofill content script (classic script, injected on demand, possibly many times).
// This is the only content script that WRITES to a page, which is why it is separate from content.js.
// It sets values on sign-up/login fields and nothing else: it never submits a form, follows a link,
// touches cookies/storage, or sends anything a page contains back to the extension. The profile
// arrives as an argument from the service worker, which only calls it while the side panel is open.
if (!globalThis.__sbAutofill) {
  (function () {
    'use strict';

    const VERSION = '1.0.0';
    const MAX_ELS = 400;
    const MAX_ALL = 6000;
    const OUTLINE = '2px solid #2f6f4f';
    const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'range', 'color', 'checkbox', 'radio', 'search']);

    const filled = new WeakSet();   // fields we already filled: never touched twice
    let lastFill = [];              // [{ el, prev, prevOutline, kind }] for undo()

    // ------------------------------------------------------------ text helpers
    const norm = (s) => String(s || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.[\]()/:]+/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
    const short = (s, n = 40) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

    const NEWS_RE = /newsletter|subscri|mailing list|unsubscribe|marketing/;
    const SKIP_RE = /\bsearch\b|captcha|\botp\b|one time|\b2fa\b|verif\w* code|security code|coupon|promo|referr?al|invit|voucher|honey|\btrap\b|leave (this )?blank|do not (fill|enter)|no ?spam|\bhp\b/;
    const EMAIL_RE = /\be ?mail\b|\be ?mail ?address\b/;
    const PHONE_RE = /\b(phone|mobile|msisdn|cell|cellphone|telephone|tel|whatsapp)\b|phone ?number|mobile ?number|contact number/;
    const USER_RE = /\b(user ?name|login( ?(id|name))?|user ?id|nick ?name|handle|screen ?name|account ?(name|id)|member ?(name|id)|display ?name|alias)\b/;
    const FIRST_RE = /\b(first ?name|fname|given ?name|forename)\b/;
    const LAST_RE = /\b(last ?name|lname|surname|family ?name)\b/;
    const FULL_RE = /^(full ?name|your name|name|legal name|real name)$/;
    const DIAL_RE = /(dial(ing)? ?code|country ?code|calling ?code|phone ?code|tel ?code)/;
    // Deposit pages: an amount box is only ours when the page is a deposit page.
    const AMOUNT_RE = /\b(amount|deposit|sum|funds?|invest(ment)?|stake|top ?up|recharge)\b/;
    const NOT_AMOUNT_RE = /withdraw|payout|cash ?out|address|wallet|tx ?id|hash|memo|\btag\b|account|card|cvv|cvc|expir|name|e ?mail|phone|code|quantity|\bqty\b/;
    const NOT_NUMBER_AMOUNT_RE = /\b(age|year|day|month|pin|otp|zip|postal)\b/;
    const DEPOSIT_HEAD_RE = /\b(deposit|top ?up|add funds|fund (your )?(account|wallet)|recharge)\b/i;
    const COUNTRY_RE = /\b(country|countries|nationality|residence)\b/;
    const DOB_RE = /birth|\bdob\b|\bbday\b/;
    const ZIP_RE = /\b(zip|postal|post ?code|postcode)\b/;
    const STATE_RE = /\b(state|province|region|county)\b/;
    const CITY_RE = /\b(city|town|suburb)\b/;
    const ADDR_RE = /\b(address|street|addr)\b/;
    const TERMS_RE = /\b(terms|conditions|privacy|agree|accept|consent|tos|policy|18|age|adult|legal age)\b/;

    const AC_MAP = {
      username: 'username', email: 'email', 'new-password': 'password', 'current-password': 'password',
      tel: 'phone', 'tel-national': 'phone', 'tel-local': 'phone', country: 'country', 'country-name': 'country',
      'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName', bday: 'dob',
      'street-address': 'address', 'address-line1': 'address', 'address-level2': 'city',
      'address-level1': 'state', 'postal-code': 'zip',
    };

    // name, ISO-2, dial code, aliases (all normalized)
    const COUNTRIES = [
      ['united states', 'us', '1', ['usa', 'united states of america', 'america', 'u s a', 'u s']],
      ['united kingdom', 'gb', '44', ['uk', 'great britain', 'britain', 'england', 'u k']],
      ['canada', 'ca', '1'], ['australia', 'au', '61'], ['new zealand', 'nz', '64'], ['ireland', 'ie', '353'],
      ['germany', 'de', '49'], ['france', 'fr', '33'], ['spain', 'es', '34'], ['italy', 'it', '39'],
      ['netherlands', 'nl', '31', ['holland']], ['belgium', 'be', '32'], ['switzerland', 'ch', '41'],
      ['austria', 'at', '43'], ['sweden', 'se', '46'], ['norway', 'no', '47'], ['denmark', 'dk', '45'],
      ['finland', 'fi', '358'], ['poland', 'pl', '48'], ['portugal', 'pt', '351'],
      ['russia', 'ru', '7', ['russian federation']], ['ukraine', 'ua', '380'], ['turkey', 'tr', '90', ['turkiye']],
      ['india', 'in', '91'], ['china', 'cn', '86'], ['japan', 'jp', '81'],
      ['south korea', 'kr', '82', ['korea republic of', 'republic of korea', 'korea']],
      ['singapore', 'sg', '65'], ['hong kong', 'hk', '852'], ['malaysia', 'my', '60'], ['indonesia', 'id', '62'],
      ['philippines', 'ph', '63'], ['thailand', 'th', '66'], ['vietnam', 'vn', '84'],
      ['united arab emirates', 'ae', '971', ['uae']], ['saudi arabia', 'sa', '966'], ['israel', 'il', '972'],
      ['south africa', 'za', '27'], ['nigeria', 'ng', '234'], ['kenya', 'ke', '254'], ['egypt', 'eg', '20'],
      ['brazil', 'br', '55'], ['mexico', 'mx', '52'], ['argentina', 'ar', '54'], ['colombia', 'co', '57'], ['chile', 'cl', '56'],
    ].map(([name, iso, dial, alias = []]) => ({ name, iso, dial, alias }));

    const normOpt = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '').replace(/\(?\+\s?\d+\)?/g, ' ').replace(/[^a-z0-9 ]+/gi, ' ')
      .toLowerCase().replace(/\s+/g, ' ').replace(/^the /, '').trim();
    const dialOf = (s) => { const m = /\+\s?(\d{1,4})/.exec(String(s || '')); return m ? m[1] : ''; };

    function countryEntry(name) {
      const t = normOpt(name);
      return COUNTRIES.find((c) => c.name === t || c.iso === t || c.alias.includes(t)) || null;
    }

    function pickCountry(sel, target) {
      const entry = countryEntry(target);
      const names = entry ? new Set([entry.name, ...entry.alias]) : new Set([normOpt(target)]);
      const opts = [...sel.options];
      let i = opts.findIndex((o) => names.has(normOpt(o.text)));
      if (i >= 0) return i;
      i = opts.findIndex((o) => { const v = normOpt(o.value); return v && (names.has(v) || (entry && v === entry.iso)); });
      if (i >= 0) return i;
      if (entry) i = opts.findIndex((o) => !normOpt(o.text) && dialOf(o.text) === entry.dial);
      return i;
    }

    function pickByText(sel, target) {
      const t = normOpt(target);
      if (!t) return -1;
      const opts = [...sel.options];
      let i = opts.findIndex((o) => normOpt(o.text) === t);
      if (i < 0) i = opts.findIndex((o) => normOpt(o.value) === t);
      return i;
    }

    // ------------------------------------------------------------ value formatting
    function formatPhone(raw, el, dial) {
      const digits = String(raw || '').replace(/\D/g, '');
      if (!digits) return '';
      const national = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
      const ph = (el.getAttribute('placeholder') || '').trim();
      const max = parseInt(el.getAttribute('maxlength') || '', 10);
      let out = national;
      if (ph.startsWith('+')) out = '+' + dial + national;
      else if (national.length === 10 && /^\(/.test(ph)) out = `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
      else if (national.length === 10 && /[x\d]{3}-[x\d]{3}-[x\d]{4}/i.test(ph)) out = `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
      else if (national.length === 10 && /[x\d]{3}\.[x\d]{3}\.[x\d]{4}/i.test(ph)) out = `${national.slice(0, 3)}.${national.slice(3, 6)}.${national.slice(6)}`;
      if (max > 0 && out.length > max) out = national.length <= max ? national : digits.slice(-max);
      return out;
    }

    function formatDob(iso, el) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
      if (!m) return '';
      if ((el.getAttribute('type') || '').toLowerCase() === 'date') return iso;
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      const sep = (/[^a-z]/.exec(ph) || ['/'])[0];
      if (/^y/.test(ph)) return [m[1], m[2], m[3]].join(sep);
      if (/^d/.test(ph)) return [m[3], m[2], m[1]].join(sep);
      return [m[2], m[3], m[1]].join(sep);
    }

    // ------------------------------------------------------------ DOM discovery
    function collectFields() {
      const out = [];
      const seenRoots = new Set();
      const walk = (root) => {
        if (seenRoots.has(root)) return;
        seenRoots.add(root);
        let list = [];
        try { list = root.querySelectorAll('input, select'); } catch (e) { return; }
        for (const el of list) { if (out.length < MAX_ELS) out.push(el); }
        let n = 0;
        let all = [];
        try { all = root.querySelectorAll('*'); } catch (e) { /* ignore */ }
        for (const el of all) {
          if (++n > MAX_ALL) break;
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      return out;
    }

    function hasLayout(doc) {
      try { return doc.documentElement.getClientRects().length > 0; } catch (e) { return true; }
    }

    function visible(el) {
      const win = el.ownerDocument.defaultView;
      if (!win) return false;
      if (el.hidden || (el.closest && el.closest('[hidden]'))) return false;
      let cs;
      try { cs = win.getComputedStyle(el); } catch (e) { return false; }
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
      if (el.closest && el.closest('[aria-hidden="true"]')) return false;
      if (!hasLayout(el.ownerDocument)) return true; // no layout engine (tests): style checks only
      if (parseFloat(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2 && r.right > 0;
    }

    function labelText(el) {
      let t = '';
      try { if (el.labels) for (const l of el.labels) t += ' ' + l.textContent; } catch (e) { /* ignore */ }
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const root = el.getRootNode();
        for (const id of by.split(/\s+/)) {
          const n = root && root.getElementById ? root.getElementById(id) : null;
          if (n) t += ' ' + n.textContent;
        }
      }
      if (!t.trim()) {
        const prev = el.previousElementSibling;
        if (prev && /^(LABEL|SPAN|DIV|P|STRONG|B)$/.test(prev.tagName) && (prev.textContent || '').length < 60) t += ' ' + prev.textContent;
      }
      return t.slice(0, 200);
    }

    function signals(el) {
      const g = (n) => norm(el.getAttribute(n));
      const s = { name: g('name'), id: g('id'), ph: g('placeholder'), aria: g('aria-label'), title: g('title'), label: norm(labelText(el)) };
      s.all = [s.name, s.id, s.ph, s.aria, s.label, s.title].filter(Boolean).join(' | ');
      return s;
    }

    function acToken(el) {
      const toks = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
      return toks.length ? toks[toks.length - 1] : '';
    }

    const SELECT_KINDS = /^(country|dialcode|state|custom:)/;

    /** What is this field? A kind string, or null if it is not ours to fill. */
    function classify(el, s, customs, deposit) {
      const isSelect = el.tagName === 'SELECT';
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (!isSelect && SKIP_TYPES.has(type)) return null;
      if (type === 'password') return 'password';
      const all = s.all;
      if (NEWS_RE.test(all) || SKIP_RE.test(all)) return null;
      for (let i = 0; i < customs.length; i++) {
        const lab = norm(customs[i].label);
        if (lab && all.includes(lab)) return 'custom:' + i;
      }
      let kind = AC_MAP[acToken(el)] || null;
      if (!kind && type === 'email') kind = 'email';
      if (!kind && type === 'tel' && !(deposit && AMOUNT_RE.test(all) && !NOT_AMOUNT_RE.test(all))) kind = 'phone';
      if (!kind && deposit && !isSelect && (type === 'text' || type === 'number' || type === 'tel') && !NOT_AMOUNT_RE.test(all)) {
        if (AMOUNT_RE.test(all)) kind = 'amount';
        else if (type === 'number' && !NOT_NUMBER_AMOUNT_RE.test(all) && !PHONE_RE.test(all)) kind = 'amount';
      }
      if (!kind) {
        if (isSelect && DIAL_RE.test(all)) kind = 'dialcode';
        else if (EMAIL_RE.test(all)) kind = 'email';
        else if (PHONE_RE.test(all)) kind = 'phone';
        else if (USER_RE.test(all)) kind = 'username';
        else if (FIRST_RE.test(all)) kind = 'firstName';
        else if (LAST_RE.test(all)) kind = 'lastName';
        else if ([s.name, s.id, s.ph, s.aria, s.label].some((x) => x && FULL_RE.test(x))) kind = 'fullName';
        else if (COUNTRY_RE.test(all)) kind = 'country';
        else if (DOB_RE.test(all)) kind = 'dob';
        else if (ZIP_RE.test(all)) kind = 'zip';
        else if (STATE_RE.test(all)) kind = 'state';
        else if (CITY_RE.test(all)) kind = 'city';
        else if (ADDR_RE.test(all)) kind = 'address';
      }
      if (type === 'date' && kind !== 'dob') return null;
      if (isSelect && !SELECT_KINDS.test(kind || '')) return null;
      return kind;
    }

    function rootOf(el) {
      return el.form || (el.closest && el.closest('form, [role="dialog"], dialog, [aria-modal="true"]')) || document;
    }

    // ------------------------------------------------------------ values
    function withTag(profile, kind, tag, flags) {
      if (kind === 'email' && flags.siteTagEmail && tag) {
        const at = profile.email.lastIndexOf('@');
        if (at > 0 && !profile.email.slice(0, at).includes('+')) return profile.email.slice(0, at) + '+' + tag + profile.email.slice(at);
      }
      if (kind === 'username' && flags.siteTagUsername && tag) return profile.username + tag;
      return profile[kind];
    }

    function valueFor(kind, el, ctx) {
      const p = ctx.profile;
      switch (kind) {
        case 'email': case 'username': {
          const plain = p[kind] || '';
          const v = withTag(p, kind, ctx.tag, ctx.flags) || '';
          const max = parseInt(el.getAttribute('maxlength') || '', 10);
          return max > 0 && v.length > max ? plain : v;
        }
        case 'dialcode': return p.country || '';
        case 'password': case 'country': case 'firstName': case 'lastName': case 'address': case 'city': case 'state': case 'zip':
          return p[kind] || '';
        case 'phone': return formatPhone(p.phone, el, ctx.dial);
        case 'fullName': return [p.firstName, p.lastName].filter(Boolean).join(' ');
        case 'dob': return formatDob(p.dob, el);
        case 'amount': return formatAmount(p.depositAmount, el);
        default:
          if (kind.startsWith('custom:')) { const c = ctx.customs[Number(kind.slice(7))]; return c ? c.value : ''; }
          return '';
      }
    }

    function isEmpty(el, kind) {
      if (el.tagName === 'SELECT') return el.selectedIndex <= 0;
      const v = String(el.value || '').trim();
      if (kind === 'amount') return /^0*[.,]?0*$/.test(v); // a "0" or "0.00" starter value is still empty
      return !v;
    }

    /** "100" -> "100" or "100.00" (decimal placeholder/step), raised to the field's min and capped at its max. */
    function formatAmount(raw, el) {
      let n = Number(raw);
      if (!raw || !Number.isFinite(n) || n <= 0) return '';
      const min = parseFloat(el.getAttribute('min') || '');
      const max = parseFloat(el.getAttribute('max') || '');
      if (Number.isFinite(min) && n < min) n = min;
      if (Number.isFinite(max) && n > max) n = max;
      const ph = el.getAttribute('placeholder') || '';
      const step = el.getAttribute('step') || '';
      const decimals = /\d[.,]\d{2}\b/.test(ph) || /^0?\.0*1$/.test(step) || !Number.isInteger(n);
      return decimals ? n.toFixed(2) : String(n);
    }

    function looksLikeDepositPage() {
      if (DEPOSIT_HEAD_RE.test(document.title || '')) return true;
      let n = 0;
      for (const h of document.querySelectorAll('h1, h2, h3, legend, [role="heading"]')) {
        if (++n > 40) break;
        if (DEPOSIT_HEAD_RE.test(String(h.textContent || '').slice(0, 120)) && visible(h)) return true;
      }
      return false;
    }

    function setNative(el, value, index) {
      const win = el.ownerDocument.defaultView;
      const isSel = el.tagName === 'SELECT';
      const proto = isSel ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (isSel) el.selectedIndex = index;
      else if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
      el.dispatchEvent(new win.Event('blur'));
      el.dispatchEvent(new win.Event('focusout', { bubbles: true }));
    }

    function isCombobox(el) {
      return el.getAttribute('role') === 'combobox' || el.hasAttribute('list') || /list|both/.test(el.getAttribute('aria-autocomplete') || '');
    }

    // ------------------------------------------------------------ run
    function frameAllowed() {
      // Only the top frame and same-origin frames: a third-party iframe never receives the profile.
      try { if (window.top === window) return true; void window.top.location.href; return true; } catch (e) { return false; }
    }

    function run(o) {
      const opts = o || {};
      const mode = opts.mode || 'url';
      const dry = !!opts.dryRun;
      const result = { frameUrl: location.href, isTop: window.top === window, detected: false, fields: [], used: {}, terms: 0 };
      if (!frameAllowed()) { result.skipped = 'cross-origin frame'; return result; }

      const profile = Object.assign({ custom: [] }, opts.profile || {});
      const customs = Array.isArray(profile.custom) ? profile.custom.slice(0, 20) : [];
      const entry = countryEntry(profile.country);
      const ctx = { profile, customs, tag: String(opts.siteTag || ''), flags: opts.flags || {}, dial: entry ? entry.dial : '1' };

      const deposit = !!opts.depositFill && (!!opts.deposit || looksLikeDepositPage());
      result.deposit = deposit;
      const items = [];
      let sawAuth = false;
      for (const el of collectFields()) {
        if (el.disabled || el.readOnly || !visible(el)) continue;
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'password' || acToken(el) === 'username' || acToken(el) === 'new-password') sawAuth = true;
        const s = signals(el);
        const kind = classify(el, s, customs, deposit);
        if (kind) items.push({ el, s, kind });
      }
      result.detected = sawAuth;
      if (mode === 'dom' && !sawAuth && !deposit) return result;
      if (!items.length) return result;

      // If a password field is present, only that form/dialog is ours: never a footer newsletter box.
      const pwRoots = [...new Set(items.filter((i) => i.kind === 'password').map((i) => rootOf(i.el)))];
      const inScope = (el, kind) => kind === 'amount' || !pwRoots.length || pwRoots.includes(document) || pwRoots.some((r) => r.contains && r.contains(el));

      const touched = [];
      for (const it of items) {
        const { el, kind } = it;
        const row = { kind: kind.startsWith('custom:') ? 'custom' : kind, label: short(el.name || el.id || el.getAttribute('placeholder') || el.type, 40) };
        result.fields.push(row);
        if (!inScope(el, kind)) { row.status = 'skipped'; row.reason = 'outside the sign-up form'; continue; }
        if (filled.has(el)) { row.status = 'skipped'; row.reason = 'already filled'; continue; }
        const value = valueFor(kind, el, ctx);
        if (!value) { row.status = 'skipped'; row.reason = 'nothing in the profile for this'; continue; }

        let index = -1;
        if (el.tagName === 'SELECT') {
          index = kind === 'country' || kind === 'dialcode' ? pickCountry(el, value) : pickByText(el, value);
          if (index < 0) { row.status = 'manual'; row.reason = 'no matching option, pick it yourself'; continue; }
          if (kind !== 'country' && kind !== 'dialcode' && !isEmpty(el)) { row.status = 'skipped'; row.reason = 'already has a choice'; continue; }
          if (el.selectedIndex === index) { row.status = 'skipped'; row.reason = 'already correct'; continue; }
        } else {
          if (!isEmpty(el, kind)) { row.status = 'skipped'; row.reason = 'already has text'; continue; }
          if ((kind === 'country' || kind === 'state' || kind === 'city') && isCombobox(el)) {
            row.status = 'manual'; row.reason = 'suggestion box, pick it yourself'; continue;
          }
        }
        if (dry) { row.status = 'would-fill'; continue; }

        const prev = el.tagName === 'SELECT' ? el.selectedIndex : el.value;
        const prevOutline = el.style.outline;
        setNative(el, value, index);
        filled.add(el);
        if (opts.highlight !== false) el.style.outline = OUTLINE;
        lastFill.push({ el, prev, prevOutline, kind });
        touched.push(el);
        row.status = 'filled';
        if (kind === 'email' && !result.used.email) result.used.email = value;
        if (kind === 'username' && !result.used.username) result.used.username = value;
      }

      if (opts.checkTerms && touched.length && !dry) result.terms = tickTerms(touched);
      return result;
    }

    function tickTerms(touched) {
      const forms = new Set(touched.map((el) => el.form).filter(Boolean));
      let n = 0;
      for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
        if (cb.checked || cb.disabled || !visible(cb) || filled.has(cb)) continue;
        if (forms.size && !forms.has(cb.form)) continue;
        const s = signals(cb);
        if (!TERMS_RE.test(s.all) || NEWS_RE.test(s.all) || /\b(offers|updates|sms|notify|notification|email me)\b/.test(s.all)) continue;
        cb.click();
        if (!cb.checked) continue;
        filled.add(cb);
        lastFill.push({ el: cb, prev: false, prevOutline: cb.style.outline, kind: 'terms' });
        n++;
      }
      return n;
    }

    function undo() {
      let n = 0;
      for (const { el, prev, prevOutline, kind } of lastFill) {
        if (!el.isConnected) continue;
        try {
          if (kind === 'terms') { if (el.checked) el.click(); }
          else setNative(el, prev, prev);
          el.style.outline = prevOutline;
          filled.delete(el);
          n++;
        } catch (e) { /* page changed under us */ }
      }
      lastFill = [];
      return { restored: n };
    }

    // ------------------------------------------------------------ late-rendered forms
    // Asks the worker to run again when inputs appear (multi-step flows, SPA modals). The worker
    // re-checks that the side panel is open and answers {stop:true} when it is not.
    let observer = null;
    let timer = null;
    let lastAsk = 0;

    function stopWatch() {
      if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } }
      observer = null;
      if (timer) clearTimeout(timer);
      timer = null;
    }

    function ask() {
      timer = null;
      lastAsk = Date.now();
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) { stopWatch(); return; }
        const p = chrome.runtime.sendMessage({ type: 'autofill/retry' });
        if (p && typeof p.then === 'function') {
          p.then((r) => { if (r && r.stop) stopWatch(); }, () => stopWatch());
        }
      } catch (e) { stopWatch(); }
    }

    function watch() {
      if (observer || typeof MutationObserver === 'undefined' || !document.documentElement) return;
      const addsField = (n) => n.nodeType === 1 && (/^(INPUT|SELECT|FORM)$/.test(n.tagName) || (n.querySelector && n.querySelector('input, select')));
      observer = new MutationObserver((recs) => {
        if (timer || !recs.some((r) => r.addedNodes.length && [...r.addedNodes].some(addsField))) return;
        timer = setTimeout(ask, Math.max(800, lastAsk + 3000 - Date.now()));
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    globalThis.__sbAutofill = Object.freeze({ run, undo, watch, stopWatch, version: VERSION });
  })();
}

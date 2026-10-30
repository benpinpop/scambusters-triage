// ScamBusters Triage content script (classic script, injected on demand, possibly many times).
// READ-ONLY: never evals, fetches, follows links or touches cookies/storage. The only
// thing it sends is {type:'content/mutation', result} from a debounced MutationObserver.
if (!globalThis.__sbTriage) {
  (function () {
    'use strict';

    const VERSION = '1.0.0';
    const MAX_CANDIDATES = 2000;
    const MAX_MARKS = 2000;
    const MAX_TEXT = 500 * 1024;
    const MAX_ATTR = 20000;
    const MAX_CONTEXTS = 3;
    const CTX_LEN = 120;
    const MARK_ATTR = 'data-sb-triage';

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TD', 'TH', 'TR', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'PRE', 'BLOCKQUOTE', 'BODY', 'DD', 'DT', 'FORM', 'FIELDSET', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'UL', 'OL',
      'TABLE', 'TBODY', 'CAPTION', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY', 'HTML']);
    const ATTRS = new Set(['value', 'placeholder', 'title', 'alt', 'aria-label']);
    const SCHEMES = {
      bitcoin: 'bitcoin', ethereum: 'ethereum', tron: 'tron', litecoin: 'litecoin', dogecoin: 'dogecoin',
      bitcoincash: 'bitcoincash', ripple: 'ripple', xrpl: 'xrpl', solana: 'solana', cardano: 'cardano', dash: 'dash',
    };
    const SCHEME_RE = /^\s*([a-z]+):/i;
    const ZW_RE = /[​-‏⁠﻿­]/g;
    const ZW_CHAR = /^[​-‏⁠﻿­]$/;

    const CANDIDATE_RES = [
      /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g,
      /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{25,50}(?![0-9A-Za-z])/g,
      /(?<![0-9a-z])(?:bc|ltc)1[02-9ac-hj-np-z]{6,87}(?![0-9a-z])/gi,
      /(?<![0-9a-z])addr1[02-9ac-hj-np-z]{50,120}(?![0-9a-z])/gi,
      /(?<![0-9a-z])(?:bitcoincash:)?[qp][02-9ac-hj-np-z]{41}(?![0-9a-z])/gi,
    ];

    const strip = (s) => String(s).replace(ZW_RE, '');
    const collapse = (s) => s.replace(/\s+/g, ' ').trim();

    function looksLikeWord(tok) {
      // Base58-shaped tokens with no digits and a single case are ordinary words: noise.
      return !(/\d/.test(tok) || (/[a-z]/.test(tok) && /[A-Z]/.test(tok)));
    }

    function blockOf(el) {
      let e = el;
      while (e && e.nodeType === 1) {
        if (BLOCK_TAGS.has(e.tagName)) return e;
        e = e.parentElement;
      }
      return el && el.nodeType === 1 ? el : null;
    }

    function isMark(el) {
      return !!el && el.nodeType === 1 && el.tagName === 'MARK' && el.hasAttribute(MARK_ATTR);
    }

    function isTopFrame() {
      try { return window.top === window; } catch (e) { return false; }
    }

    // ---------------------------------------------------------------- scan
    function scan() {
      const t0 = Date.now();
      startObserver();
      const found = new Map(); // raw -> candidate
      const blockCache = new Map();

      function blockText(el) {
        const b = blockOf(el);
        if (!b) return '';
        let t = blockCache.get(b);
        if (t === undefined) {
          t = collapse(strip(b.textContent || '')).slice(0, 20000);
          blockCache.set(b, t);
        }
        return t;
      }

      function contextFor(raw, ownText, el) {
        let src = '';
        let idx = -1;
        // Prefer the enclosing block's text (more surrounding words), then the string itself.
        if (el) {
          src = blockText(el);
          idx = src.indexOf(raw);
        }
        if (idx < 0 && ownText) {
          const own = collapse(ownText);
          const j = own.indexOf(raw);
          if (j >= 0) { src = own; idx = j; }
        }
        if (idx < 0) return src.slice(0, CTX_LEN).trim();
        const start = Math.max(0, Math.round(idx + raw.length / 2 - CTX_LEN / 2));
        return src.slice(start, start + CTX_LEN).trim();
      }

      function add(raw, source, extra, ownText, el) {
        if (!raw) return;
        let c = found.get(raw);
        if (!c && found.size >= MAX_CANDIDATES) return;
        let ctx = '';
        try { ctx = contextFor(raw, ownText, el); } catch (e) { /* ignore */ }
        if (!c) {
          c = { raw, context: ctx, contexts: [], source };
          if (extra) Object.assign(c, extra);
          found.set(raw, c);
        }
        if (ctx && c.contexts.length < MAX_CONTEXTS && !c.contexts.includes(ctx)) c.contexts.push(ctx);
      }

      function scanString(text, source, extra, el) {
        if (!text) return;
        let s = strip(text);
        if (s.length < 14) return;
        if (s.length > MAX_ATTR * 5) s = s.slice(0, MAX_ATTR * 5);
        for (let i = 0; i < CANDIDATE_RES.length; i++) {
          for (const m of s.matchAll(CANDIDATE_RES[i])) {
            if (i === 1 && looksLikeWord(m[0])) continue;
            add(m[0], source, extra, s, el);
            if (found.size >= MAX_CANDIDATES) return;
          }
        }
      }

      function scanHref(el, attrName, inShadow) {
        const href = el.getAttribute(attrName);
        if (!href) return;
        const h = strip(href).trim();
        const sm = SCHEME_RE.exec(h);
        const source = inShadow ? 'shadow' : 'href';
        if (sm && SCHEMES[sm[1].toLowerCase()]) {
          const scheme = SCHEMES[sm[1].toLowerCase()];
          const rest = h.slice(sm[0].length).replace(/^\/\//, '');
          let addr = rest.split(/[?@/#]/)[0];
          try { addr = decodeURIComponent(addr); } catch (e) { /* keep as is */ }
          if (scheme === 'bitcoincash' && addr && !/^bitcoincash:/i.test(addr)) addr = 'bitcoincash:' + addr;
          if (addr) add(addr, source, { scheme, attr: attrName }, h + ' ' + (el.textContent || ''), el);
        }
        // Query parameter values (and path segments of web URLs) of any href.
        const qi = h.indexOf('?');
        const pathPart = (qi >= 0 ? h.slice(0, qi) : h).split('#')[0];
        const query = qi >= 0 ? h.slice(qi + 1).split('#')[0] : '';
        const bits = [];
        for (const kv of query.split('&')) {
          const eq = kv.indexOf('=');
          if (eq < 0) continue;
          let v = kv.slice(eq + 1);
          try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { /* keep as is */ }
          bits.push(v);
        }
        if (/^https?:/i.test(pathPart) || !/^[a-z][a-z0-9+.-]*:/i.test(pathPart)) {
          for (const seg of pathPart.split('/')) bits.push(seg);
        }
        for (const b of bits) scanString(b, source, { attr: attrName }, el);
      }

      function scanElement(el, inShadow) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (type !== 'password' && type !== 'file') {
            const v = el.value;
            if (typeof v === 'string' && v) scanString(v.slice(0, MAX_ATTR), inShadow ? 'shadow' : 'input', null, el);
          }
        }
        const attrs = el.attributes;
        for (let i = 0; i < attrs.length; i++) {
          const a = attrs[i];
          const n = a.name;
          if (n === MARK_ATTR) continue;
          if (ATTRS.has(n) || n.startsWith('data-') || (n === 'content' && tag === 'META')) {
            const v = a.value;
            if (v) scanString(v.length > MAX_ATTR ? v.slice(0, MAX_ATTR) : v, inShadow ? 'shadow' : 'attr', { attr: n }, el);
          }
        }
        if (tag === 'A' || tag === 'AREA') {
          scanHref(el, 'href', inShadow);
          if (el.hasAttribute('src')) scanHref(el, 'src', inShadow);
        }
      }

      const stack = [{ node: document.documentElement || document, shadow: false }];
      while (stack.length && found.size < MAX_CANDIDATES) {
        const { node, shadow } = stack.pop();
        if (node.nodeType === 3) {
          const p = node.parentElement;
          scanString(node.nodeValue, shadow ? 'shadow' : 'text', null, p);
          continue;
        }
        if (node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) continue;
        if (node.nodeType === 1) {
          if (SKIP_TAGS.has(node.tagName) || isMark(node)) continue;
          scanElement(node, shadow);
        }
        const children = node.childNodes;
        for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], shadow }); // pop in document order
        if (node.nodeType === 1 && node.shadowRoot) {
          observeRoot(node.shadowRoot);
          stack.push({ node: node.shadowRoot, shadow: true });
        }
      }

      return {
        frameUrl: location.href,
        isTop: isTopFrame(),
        durationMs: Date.now() - t0,
        candidates: [...found.values()],
      };
    }

    // ---------------------------------------------------------------- collectText
    function collectText() {
      const parts = [];
      let size = 0;
      const push = (s) => {
        if (!s || size >= MAX_TEXT) return;
        const t = String(s);
        parts.push(t);
        size += t.length + 1;
      };
      let hadInner = false;
      if (document.body) {
        let inner = null;
        try { inner = document.body.innerText; } catch (e) { inner = null; }
        if (typeof inner === 'string') { push(inner); hadInner = true; }
      }
      // Walk for attribute values and shadow-root text (and all text when innerText is unavailable).
      const stack = [{ node: document.body || document.documentElement, shadow: false }];
      while (stack.length && size < MAX_TEXT) {
        const { node, shadow } = stack.pop();
        if (!node) continue;
        if (node.nodeType === 3) {
          if (shadow || !hadInner) push(node.nodeValue);
          continue;
        }
        if (node.nodeType === 1) {
          if (SKIP_TAGS.has(node.tagName)) continue;
          const attrs = node.attributes;
          for (let i = 0; i < attrs.length; i++) {
            const n = attrs[i].name;
            if (n === 'alt' || n === 'placeholder' || n === 'aria-label' || n === 'title') push(attrs[i].value);
          }
        } else if (node.nodeType !== 11) continue;
        const kids = node.childNodes;
        for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i], shadow });
        if (node.nodeType === 1 && node.shadowRoot) stack.push({ node: node.shadowRoot, shadow: true });
      }
      let metaDescription = '';
      try {
        const m = document.querySelector('meta[name="description" i]');
        metaDescription = m ? m.getAttribute('content') || '' : '';
      } catch (e) { /* ignore */ }
      const title = document.title || '';
      let text = title + '\n' + metaDescription + '\n' + parts.join('\n');
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
      return { frameUrl: location.href, isTop: isTopFrame(), title, metaDescription, text };
    }

    // ---------------------------------------------------------------- highlight
    let suppress = false;
    let marks = [];

    const QUOTE_MAP = {
      '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
      '“': '"', '”': '"', '„': '"', '″': '"',
    };

    // Normalize (lowercase, straight quotes, no zero-width, collapsed whitespace) while
    // keeping an offset map: s[i] came from original range [starts[i], ends[i]).
    function normalizeMapped(orig) {
      let s = '';
      const starts = [], ends = [];
      let i = 0;
      let lastSpace = true;
      while (i < orig.length) {
        const c = orig[i];
        if (ZW_CHAR.test(c)) { i++; continue; }
        if (/\s/.test(c)) {
          let j = i + 1;
          while (j < orig.length && /\s/.test(orig[j])) j++;
          if (!lastSpace) { s += ' '; starts.push(i); ends.push(j); lastSpace = true; }
          i = j;
          continue;
        }
        let n = QUOTE_MAP[c] || c;
        const lower = n.toLowerCase();
        if (lower.length === 1) n = lower;
        s += n; starts.push(i); ends.push(i + 1);
        lastSpace = false;
        i++;
      }
      return { s, starts, ends };
    }

    function normPhrase(p) {
      return collapse(strip(p).replace(/[‘’‚‛′]/g, "'").replace(/[“”„″]/g, '"').toLowerCase());
    }

    function esc(s) { return s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); }

    function highlight(phrases) {
      suppress = true;
      try {
        clearHighlightInner();
        const list = [...new Set((phrases || []).map((p) => normPhrase(String(p))).filter(Boolean))]
          .sort((a, b) => b.length - a.length);
        if (!list.length) return { count: 0 };
        let re;
        try {
          re = new RegExp('(?<![a-z0-9])(?:' + list.map(esc).join('|') + ')(?![a-z0-9])', 'g');
        } catch (e) { return { count: 0 }; }

        const textNodes = [];
        const stack = [document.body || document.documentElement];
        while (stack.length) {
          const node = stack.pop();
          if (!node) continue;
          if (node.nodeType === 3) { textNodes.push(node); continue; }
          if (node.nodeType === 1) {
            const tag = node.tagName;
            if (SKIP_TAGS.has(tag) || tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || isMark(node)) continue;
            const ce = node.getAttribute('contenteditable');
            if (ce !== null && ce.toLowerCase() !== 'false') continue;
          } else if (node.nodeType !== 11) continue;
          const kids = node.childNodes;
          for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
          if (node.nodeType === 1 && node.shadowRoot) stack.push(node.shadowRoot);
        }

        let count = 0;
        for (const tn of textNodes) {
          if (count >= MAX_MARKS) break;
          const orig = tn.nodeValue;
          const parent = tn.parentNode;
          if (!orig || orig.length < 2 || !parent) continue;
          const { s, starts, ends } = normalizeMapped(orig);
          re.lastIndex = 0;
          const ranges = [];
          let m;
          while ((m = re.exec(s)) !== null) {
            if (m[0].length === 0) { re.lastIndex++; continue; }
            ranges.push([starts[m.index], ends[m.index + m[0].length - 1]]);
            if (count + ranges.length >= MAX_MARKS) break;
          }
          if (!ranges.length) continue;
          const frag = document.createDocumentFragment();
          let pos = 0;
          for (const [a, b] of ranges) {
            if (a > pos) frag.appendChild(document.createTextNode(orig.slice(pos, a)));
            const mark = document.createElement('mark');
            mark.setAttribute(MARK_ATTR, '1');
            mark.style.backgroundColor = '#ffeb3b';
            mark.style.color = 'inherit';
            mark.textContent = orig.slice(a, b);
            frag.appendChild(mark);
            marks.push(mark);
            pos = b;
            count++;
          }
          if (pos < orig.length) frag.appendChild(document.createTextNode(orig.slice(pos)));
          parent.replaceChild(frag, tn);
        }
        return { count };
      } finally {
        flushOwnMutations();
        suppress = false;
      }
    }

    function clearHighlightInner() {
      const all = new Set(marks);
      try {
        for (const m of document.querySelectorAll('mark[' + MARK_ATTR + ']')) all.add(m);
      } catch (e) { /* ignore */ }
      const parents = new Set();
      for (const m of all) {
        const p = m.parentNode;
        if (!p) continue;
        p.replaceChild(document.createTextNode(m.textContent), m);
        parents.add(p);
      }
      for (const p of parents) { try { p.normalize(); } catch (e) { /* ignore */ } }
      marks = [];
      return { cleared: all.size };
    }

    function clearHighlight() {
      suppress = true;
      try { return clearHighlightInner(); } finally { flushOwnMutations(); suppress = false; }
    }

    // ---------------------------------------------------------------- observer
    let observer = null;
    let timer = null;
    let lastSent = 0;
    const observedRoots = new WeakSet();
    const OBS_OPTS = { childList: true, subtree: true, characterData: true, attributes: true };

    function relevant(rec) {
      if (rec.type === 'attributes') {
        const n = rec.attributeName || '';
        if (n === MARK_ATTR) return false;
        if (!(n === 'value' || n === 'href' || n === 'src' || n.startsWith('data-'))) return false;
      }
      const t = rec.target;
      const el = t && t.nodeType === 1 ? t : t && t.parentElement;
      if (el && (isMark(el) || (el.closest && el.closest('mark[' + MARK_ATTR + ']')))) return false;
      if (rec.type === 'childList') {
        const nodes = [...rec.addedNodes, ...rec.removedNodes];
        if (nodes.length && nodes.every(isMark)) return false;
      }
      return true;
    }

    function flushOwnMutations() {
      if (observer) { try { observer.takeRecords(); } catch (e) { /* ignore */ } }
    }

    function disconnect() {
      if (observer) { try { observer.disconnect(); } catch (e) { /* ignore */ } }
      observer = null;
      if (timer) clearTimeout(timer);
      timer = null;
    }

    function observeRoot(root) {
      if (!observer || observedRoots.has(root)) return;
      observedRoots.add(root);
      try { observer.observe(root, OBS_OPTS); } catch (e) { /* ignore */ }
    }

    function schedule() {
      if (timer) return;
      const wait = Math.max(1000, lastSent + 2000 - Date.now()); // debounce 1 s, at most one message per 2 s
      timer = setTimeout(() => {
        timer = null;
        send();
      }, wait);
    }

    function send() {
      if (!observer) return;
      let result;
      try { result = scan(); } catch (e) { return; }
      lastSent = Date.now();
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) { disconnect(); return; }
        const p = chrome.runtime.sendMessage({ type: 'content/mutation', result });
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            try { if (!chrome.runtime || !chrome.runtime.id) disconnect(); } catch (e) { disconnect(); }
          });
        }
      } catch (e) {
        disconnect(); // extension context invalidated
      }
    }

    function startObserver() {
      if (observer || typeof MutationObserver === 'undefined') return;
      const target = document.documentElement;
      if (!target) return;
      observer = new MutationObserver((records) => {
        if (suppress) return;
        if (records.some(relevant)) schedule();
      });
      observedRoots.add(target);
      observer.observe(target, OBS_OPTS);
    }

    globalThis.__sbTriage = Object.freeze({ scan, collectText, highlight, clearHighlight, version: VERSION });
  })();
}

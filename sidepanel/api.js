// Port to the service worker: request/response with reqId, timeouts, reconnect.

const LONG = new Set(['urlscan/scan', 'onchain/lookup']);

export function createApi({ onState, onSettings, onReconnect }) {
  const chrome = () => globalThis.chrome;
  let port = null;
  let seq = 0;
  let windowId = null;
  const pending = new Map();

  function failAll(message) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject({ code: 'connection_reset', message });
    }
    pending.clear();
  }

  function connect() {
    port = chrome().runtime.connect({ name: 'sidepanel' });
    port.onMessage.addListener(msg => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'response') {
        const p = pending.get(msg.reqId);
        if (!p) return;
        pending.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(msg.error || { code: 'unknown', message: 'Unknown error' });
      } else if (msg.type === 'state') onState(msg.state);
      else if (msg.type === 'settings') onSettings(msg.settings, msg.keys);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      failAll('Connection to the extension restarted, please retry');
      setTimeout(async () => {
        try {
          connect();
          const d = await hello();
          onReconnect && onReconnect(d);
        } catch { /* next disconnect/ retry loop below */
          setTimeout(() => port || connect(), 1000);
        }
      }, 400);
    });
  }

  function call(type, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!port) {
        try { connect(); } catch (e) {
          reject({ code: 'no_port', message: 'Not connected to the extension' });
          return;
        }
      }
      const reqId = ++seq;
      const ms = LONG.has(type) ? 180000 : 60000;
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject({ code: 'timeout', message: `Request ${type} timed out` });
      }, ms);
      pending.set(reqId, { resolve, reject, timer });
      try {
        port.postMessage({ reqId, type, ...payload });
      } catch (e) {
        pending.delete(reqId);
        clearTimeout(timer);
        reject({ code: 'no_port', message: 'Connection to the extension restarted, please retry' });
      }
    });
  }

  async function hello() {
    if (windowId == null) {
      try { windowId = (await chrome().windows.getCurrent()).id; } catch { windowId = null; }
    }
    return call('panel/hello', { windowId });
  }

  async function start() {
    connect();
    return hello();
  }

  return { start, call };
}

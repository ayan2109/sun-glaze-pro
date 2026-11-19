// In-memory stand-in for the Firebase Realtime Database adapter in config/firebase.js.
// Mimics RTDB semantics that matter here: null deletes, empty containers vanish, undefined is rejected.
const parts = p => String(p).replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function normalize(v, path = '') {
  if (v === undefined) throw new Error(`RTDB rejects undefined values (at ${path})`);
  if (v === null) return null;
  if (Array.isArray(v)) { const out = v.map((x, i) => normalize(x, `${path}/${i}`)).filter(x => x !== null); return out.length ? out : null; }
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (/[.$#\[\]\/]/.test(k)) throw new Error(`Invalid RTDB key "${k}" at ${path}`);
      const n = normalize(x, `${path}/${k}`); if (n !== null) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  }
  return v;
}

export function createMemoryDb(seed = {}) {
  let root = clone(seed);
  let counter = 0;
  const walk = path => { let cur = root; for (const p of parts(path)) { if (cur === null || typeof cur !== 'object') return undefined; cur = cur[p]; } return cur; };
  function setAt(path, value) {
    const segs = parts(path), v = normalize(value, path);
    if (!segs.length) { root = v || {}; return; }
    const chain = [root];
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (cur[segs[i]] === undefined || typeof cur[segs[i]] !== 'object') { if (v === null) return; cur[segs[i]] = {}; }
      cur = cur[segs[i]]; chain.push(cur);
    }
    if (v === null) delete cur[segs[segs.length - 1]]; else cur[segs[segs.length - 1]] = clone(v);
    for (let i = segs.length - 1; i > 0; i--) { if (chain[i] && typeof chain[i] === 'object' && !Object.keys(chain[i]).length) delete chain[i - 1][segs[i - 1]]; else break; }
  }
  return {
    ref() { throw new Error('ref() not supported in memory db'); },
    async get(path) { const v = walk(path); return v === undefined || v === null ? null : clone(v); },
    async set(path, value) { setAt(path, value); },
    async update(values) { for (const [p, v] of Object.entries(values)) setAt(p.replace(/^\/+|\/+$/g, ''), v); },
    async remove(path) { setAt(path, null); },
    async transaction(path, fn) {
      const cur = walk(path); const next = fn(cur === undefined ? null : clone(cur));
      if (next === undefined) return { committed: false, snapshot: { val: () => cur ?? null } };
      setAt(path, next); return { committed: true, snapshot: { val: () => next } };
    },
    key() { counter += 1; return `k${String(counter).padStart(6, '0')}${Math.random().toString(36).slice(2, 6)}`; },
    dump() { return clone(root); },
  };
}

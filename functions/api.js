// Cloudflare Pages Function: the website's database API at /api.
// Same calls as the old Google Apps Script backend (loadAll, getStamp, saveDocs), stored in a Cloudflare D1
// database bound as DB. The first PIN anyone uses becomes the PIN for everyone.

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS backups (day TEXT PRIMARY KEY, data TEXT NOT NULL)',
];

async function ready(db) {
  await db.batch(SCHEMA.map(s => db.prepare(s)));
}

async function getMeta(db, k) {
  const r = await db.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first();
  return r ? r.v : null;
}

// Each person can have their own PIN (stored only as a hash). The main PIN is the owners' PIN.
const hashPin = async pin => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dgz:' + pin)))].map(b => b.toString(16).padStart(2, '0')).join('');
async function users(db) { return JSON.parse((await getMeta(db, 'users')) || '[]'); }

// Returns who the PIN belongs to: { name, role } (role 'owner', 'staff' or 'tech').
async function checkPin(db, pin) {
  pin = String(pin || '').trim();
  if (!pin) throw new Error('bad_pin');
  const saved = await getMeta(db, 'pin');
  if (saved === null) {
    // first visit sets the PIN; OR IGNORE keeps the first one if two phones race
    await db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind('pin', pin).run();
    if ((await getMeta(db, 'pin')) !== pin) throw new Error('bad_pin');
    return { name: '', role: 'owner' };
  }
  if (pin === saved) return { name: '', role: 'owner' };
  const h = await hashPin(pin), u = (await users(db)).find(x => x.h === h);
  if (!u) throw new Error('bad_pin');
  return { name: u.name, role: ROLES.includes(u.role) ? u.role : 'owner' };
}
const ROLES = ['owner', 'staff', 'tech'];

// The technician ('tech') only ever receives and changes the technical records. Money data never leaves the server.
const TECH_WRITE = /^state\/((store|toBuy)|(matLog|issues|tickets)@[^/]+)$/;
// Read-only for the technician, cut down to the fields the tech pages need.
const TECH_READ = {
  'state/sites': v => (v || []).map(s => ({ id: s.id, name: s.name, group: s.group, router: s.router })),
  'state/employees': v => (v || []).map(e => ({ id: e.id, name: e.name, role: e.role, phone: e.phone })),
  'state/settings': v => ({ business: (v || {}).business, techName: (v || {}).techName, subtechName: (v || {}).subtechName }),
};
function techDocs(docs) {
  const out = {};
  for (const p in docs) {
    if (TECH_WRITE.test(p)) out[p] = docs[p];
    else if (TECH_READ[p]) { try { out[p] = JSON.stringify({ v: TECH_READ[p](JSON.parse(docs[p]).v) }); } catch (e) {} }
  }
  return out;
}
async function checkOwner(db, pin) {
  const me = await checkPin(db, pin);
  if (me.role !== 'owner') throw new Error('owners_only');
  return me;
}

const stamp = async db => (await getMeta(db, 'stamp')) || '0';

const FNS = {
  async whoami(db, pin) {
    return checkPin(db, pin);
  },
  async listUsers(db, pin) {
    await checkOwner(db, pin);
    return (await users(db)).map(u => ({ name: u.name, role: u.role }));
  },
  // set or change one person's PIN; an empty newPin removes the person
  async setUser(db, pin, name, role, newPin) {
    await checkOwner(db, pin);
    name = String(name || '').trim().toUpperCase();
    if (!name) throw new Error('no_name');
    let list = (await users(db)).filter(u => u.name !== name);
    newPin = String(newPin || '').trim();
    if (newPin) {
      if (newPin.length < 4) throw new Error('pin_too_short');
      const h = await hashPin(newPin);
      if (newPin === (await getMeta(db, 'pin')) || list.some(u => u.h === h)) throw new Error('pin_in_use');
      list.push({ name, role: ROLES.includes(role) ? role : 'owner', h });
    }
    await db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('users', JSON.stringify(list)).run();
    return list.map(u => ({ name: u.name, role: u.role }));
  },
  // The technician records what a material cost without seeing the costs list: the server adds it to the owners' costs.
  async techAddCost(db, pin, o) {
    await checkPin(db, pin);
    o = o || {};
    const date = /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
    const amount = Number(o.amount);
    if (!(amount > 0)) throw new Error('bad_amount');
    const item = { id: 'tc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date, category: 'Materials', site: String(o.site || 'general').slice(0, 40), amount, desc: String(o.desc || '').slice(0, 200), paidBy: String(o.paidBy || '').slice(0, 60) };
    const path = 'state/expenses@' + date.slice(0, 4), r = await db.prepare('SELECT data FROM docs WHERE path = ?').bind(path).first();
    const doc = r ? JSON.parse(r.data) : { v: [] };
    (doc.v = doc.v || []).push(item);
    const now = Date.now();
    await db.batch([
      db.prepare('INSERT INTO docs (path, data, updated) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind(path, JSON.stringify(doc), now),
      db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('stamp', String(now)),
    ]);
    return { ok: true };
  },
  async listBackups(db, pin) {
    await checkOwner(db, pin);
    const { results } = await db.prepare('SELECT day, length(data) AS size FROM backups ORDER BY day DESC').all();
    return results;
  },
  async getBackup(db, pin, day) {
    await checkOwner(db, pin);
    const r = await db.prepare('SELECT data FROM backups WHERE day = ?').bind(String(day)).first();
    if (!r) throw new Error('no_backup');
    return { docs: JSON.parse(r.data) };
  },
  async getStamp(db, pin) {
    await checkPin(db, pin);
    return stamp(db);
  },
  async loadAll(db, pin) {
    const me = await checkPin(db, pin);
    const { results } = await db.prepare('SELECT path, data FROM docs').all();
    const docs = {};
    for (const r of results) docs[r.path] = r.data;
    return { docs: me.role === 'tech' ? techDocs(docs) : docs, stamp: await stamp(db) };
  },
  async saveDocs(db, pin, sets, dels) {
    const me = await checkPin(db, pin);
    if (me.role === 'tech' && [...Object.keys(sets || {}), ...(dels || [])].some(p => !TECH_WRITE.test(p))) throw new Error('not_allowed');
    const now = Date.now(), st = String(now), q = [];
    for (const p of Object.keys(sets || {})) {
      q.push(db.prepare('INSERT INTO docs (path, data, updated) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated = excluded.updated').bind(p, String(sets[p]), now));
    }
    for (const p of dels || []) q.push(db.prepare('DELETE FROM docs WHERE path = ?').bind(p));
    q.push(db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('stamp', st));
    await db.batch(q); // one transaction: all or nothing
    return { stamp: st };
  },
};

export async function onRequestPost({ request, env }) {
  let out;
  try {
    if (!env.DB) throw new Error('no_database');
    const req = await request.json();
    const fn = FNS[req.fn];
    if (!fn) throw new Error('unknown');
    await ready(env.DB);
    out = { result: await fn(env.DB, ...(req.args || [])) };
  } catch (err) {
    out = { error: String((err && err.message) || err) };
  }
  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export async function onRequestGet({ env }) {
  return new Response(env.DB ? 'Dala & Genzi data service is working.' : 'Database not connected yet.', { headers: { 'content-type': 'text/plain' } });
}


// Nightly backup: a full copy of every document, one row per day, the last 30 days kept.
export async function dailyBackup(env) {
  if (!env.DB) return;
  const db = env.DB;
  await ready(db);
  const { results } = await db.prepare('SELECT path, data FROM docs').all();
  if (!results.length) return;
  const docs = {};
  for (const r of results) docs[r.path] = r.data;
  const day = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // Kenya date
  await db.batch([
    db.prepare('INSERT INTO backups (day, data) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET data = excluded.data').bind(day, JSON.stringify(docs)),
    db.prepare('DELETE FROM backups WHERE day NOT IN (SELECT day FROM backups ORDER BY day DESC LIMIT 30)'),
  ]);
}

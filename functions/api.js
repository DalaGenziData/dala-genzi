// Cloudflare Pages Function: the website's database API at /api.
// Same calls as the old Google Apps Script backend (loadAll, getStamp, saveDocs), stored in a Cloudflare D1
// database bound as DB. The first PIN anyone uses becomes the PIN for everyone.

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
];

async function ready(db) {
  await db.batch(SCHEMA.map(s => db.prepare(s)));
}

async function getMeta(db, k) {
  const r = await db.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first();
  return r ? r.v : null;
}

async function checkPin(db, pin) {
  pin = String(pin || '').trim();
  if (!pin) throw new Error('bad_pin');
  const saved = await getMeta(db, 'pin');
  if (saved === null) {
    // first visit sets the PIN; OR IGNORE keeps the first one if two phones race
    await db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind('pin', pin).run();
    if ((await getMeta(db, 'pin')) !== pin) throw new Error('bad_pin');
    return;
  }
  if (pin !== saved) throw new Error('bad_pin');
}

const stamp = async db => (await getMeta(db, 'stamp')) || '0';

// Reads from the ISPLedger billing dashboards (PHPNuxBill API) so earnings can be imported automatically.
// Only *.ispledger.com addresses are allowed, so this can't be used to fetch other websites.
async function ispGet(base, token, route, query) {
  base = String(base || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.ispledger\.com$/i.test(base)) throw new Error('bad_site');
  const qs = new URLSearchParams(String(query || ''));
  qs.set('r', String(route || 'dashboard'));
  qs.set('token', String(token || ''));
  const r = await fetch(base + '/system/api.php?' + qs.toString(), { headers: { accept: 'application/json' } });
  const text = await r.text();
  return { status: r.status, text: text.slice(0, 60000) };
}

const FNS = {
  async smsPreview(db, pin) {
    await checkPin(db, pin);
    const m = await buildReminder(db);
    return { ...m, last: JSON.parse((await getMeta(db, 'sms_log')) || 'null') };
  },
  async smsTest(db, pin, env) {
    await checkPin(db, pin);
    const m = await buildReminder(db);
    if (!m.to.length) throw new Error('no_numbers');
    const res = await sendSms(env, m.to, m.count ? m.text : 'DalaWifi test message: automatic reminders are working. dalawifi.com');
    await db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('sms_log', JSON.stringify({ at: new Date().toISOString(), test: true, ...res })).run();
    return res;
  },
  async ispFetch(db, pin, base, token, route, query) {
    await checkPin(db, pin);
    return ispGet(base, token, route, query);
  },
  async getStamp(db, pin) {
    await checkPin(db, pin);
    return stamp(db);
  },
  async loadAll(db, pin) {
    await checkPin(db, pin);
    const { results } = await db.prepare('SELECT path, data FROM docs').all();
    const docs = {};
    for (const r of results) docs[r.path] = r.data;
    return { docs, stamp: await stamp(db) };
  },
  async saveDocs(db, pin, sets, dels) {
    await checkPin(db, pin);
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
    const args = req.args || [];
    out = { result: await (req.fn === 'smsTest' ? fn(env.DB, args[0], env) : fn(env.DB, ...args)) };
  } catch (err) {
    out = { error: String((err && err.message) || err) };
  }
  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export async function onRequestGet({ env }) {
  return new Response(env.DB ? 'Dala & Genzi data service is working.' : 'Database not connected yet.', { headers: { 'content-type': 'text/plain' } });
}

// ---------- daily SMS reminders (Africa's Talking) ----------
// The page keeps a list of upcoming payments in state/remindQueue. Every morning the Worker's cron
// turns it into one short SMS and sends it to the partners' numbers in state/settings.
// AT_USERNAME and AT_API_KEY are Cloudflare secrets the owner adds in the dashboard.
const nairobiDay = (ms = Date.now()) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400e3);
const ksh = n => Math.round(Number(n) || 0).toLocaleString('en-US');
async function readDoc(db, path) {
  const r = await db.prepare('SELECT data FROM docs WHERE path = ?').bind(path).first();
  if (!r) return null;
  try { return (JSON.parse(r.data) || {}).v; } catch (e) { return null; }
}
export async function buildReminder(db) {
  const settings = (await readDoc(db, 'state/settings')) || {};
  const q = (await readDoc(db, 'state/remindQueue')) || {};
  const days = Number(settings.remindDays) || 3, t = nairobiDay();
  const items = (q.items || []).filter(x => x.date && x.amount > 0).map(x => ({ ...x, left: dayDiff(t, x.date) })).filter(x => x.left <= days);
  const nums = (settings.contacts || []).map(c => String(c[1] || '').replace(/[^0-9+]/g, '').replace(/^0/, '+254')).filter(Boolean);
  const d = new Date(Date.parse(t)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const it = x => `${x.who} ${String(x.what).replace(' subscription', '').replace(' (estimate)', '').replace('Electricity token', 'token')} ${ksh(x.amount)}${x.left < 0 ? ` (${-x.left}d late)` : x.left === 0 ? ' (today)' : ` (in ${x.left}d)`}`;
  const od = items.filter(x => x.left < 0), due = items.filter(x => x.left >= 0);
  const parts = [`DalaWifi ${d}:`];
  if (od.length) parts.push('OVERDUE: ' + od.map(it).join('; ') + '.');
  if (due.length) parts.push('DUE: ' + due.map(it).join('; ') + '.');
  parts.push(`Total Ksh ${ksh(items.reduce((a, x) => a + Number(x.amount), 0))}. dalawifi.com/#upcoming`);
  return { count: items.length, text: parts.join(' '), to: nums, auto: settings.autoSms !== false };
}
async function sendSms(env, to, message) {
  if (!env.AT_USERNAME || !env.AT_API_KEY) throw new Error('sms_not_set_up');
  const host = env.AT_USERNAME === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  const r = await fetch(host + '/version1/messaging', {
    method: 'POST',
    headers: { apiKey: env.AT_API_KEY, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: env.AT_USERNAME, to: to.join(','), message }),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  const rec = (j && j.SMSMessageData && j.SMSMessageData.Recipients) || [];
  return { ok: r.ok && rec.length > 0 && rec.every(x => /success/i.test(x.status)), status: r.status, detail: rec.length ? rec.map(x => `${x.number}: ${x.status}${x.cost ? ' ' + x.cost : ''}`).join(', ') : text.slice(0, 300) };
}
export async function dailyReminders(env) {
  if (!env.DB) return;
  await ready(env.DB);
  const t = nairobiDay();
  if ((await getMeta(env.DB, 'sms_last')) === t) return; // already sent today
  const m = await buildReminder(env.DB);
  if (!m.auto || !m.count || !m.to.length) return;
  let res;
  try { res = await sendSms(env, m.to, m.text); } catch (e) { res = { ok: false, detail: String((e && e.message) || e) }; }
  if (res.ok) await env.DB.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('sms_last', t).run();
  await env.DB.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind('sms_log', JSON.stringify({ at: new Date().toISOString(), text: m.text, ...res })).run();
}

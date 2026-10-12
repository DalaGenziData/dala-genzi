// Cloudflare Worker: serves the website files, the /api data service and the nightly backup.
import { onRequestPost, onRequestGet, dailyBackup, gateKey } from './functions/api.js';

const HIDE = { 'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet' };
const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store', ...HIDE } });
const hidden = r => { const out = new Response(r.body, r); Object.entries(HIDE).forEach(([k, v]) => out.headers.set(k, v)); return out; };
const cookie = (req, name) => { const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')); return m ? m[1] : ''; };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // search engines are told to stay away and never list the website
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain', ...HIDE } });
    // private link: without the key the website looks like it does not exist
    const key = await gateKey(env).catch(() => null);
    if (key) {
      const k = url.searchParams.get('k');
      if (k === key) {
        return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `dgk=${key}; Path=/; Max-Age=315360000; HttpOnly; Secure; SameSite=Lax`, 'cache-control': 'no-store', ...HIDE } });
      }
      if (cookie(request, 'dgk') !== key) return notFound();
    }
    if (url.pathname === '/api') {
      return hidden(await (request.method === 'POST' ? onRequestPost({ request, env }) : onRequestGet({ env })));
    }
    return hidden(await env.ASSETS.fetch(request));
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyBackup(env));
  },
};

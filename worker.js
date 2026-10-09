// Cloudflare Worker: serves the website files, the /api data service and the nightly backup.
import { onRequestPost, onRequestGet, dailyBackup } from './functions/api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api') {
      return request.method === 'POST' ? onRequestPost({ request, env }) : onRequestGet({ env });
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyBackup(env));
  },
};

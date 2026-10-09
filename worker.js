// Cloudflare Worker: serves the website files and the /api data service.
import { onRequestPost, onRequestGet } from './functions/api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api') {
      return request.method === 'POST' ? onRequestPost({ request, env }) : onRequestGet({ env });
    }
    return env.ASSETS.fetch(request);
  },
};

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  'https://bryancraven.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'null' // for local file:// access
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(allowed =>
    origin === allowed || origin.startsWith(allowed + ':') || origin.startsWith(allowed + '/')
  );
}

function getCorsOrigin(request) {
  const origin = request.headers.get('Origin');
  // Allow local file access (origin is 'null' string) and allowed origins
  if (origin === 'null' || isAllowedOrigin(origin)) {
    return origin;
  }
  return ALLOWED_ORIGINS[0]; // Default to main site
}

export default {
  async fetch(request, env, ctx) {
    const corsOrigin = getCorsOrigin(request);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Range',
          'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type',
        }
      });
    }

    const url = new URL(request.url);
    const audioUrl = url.searchParams.get('audio');
    const species = url.searchParams.get('species');
    const quality = url.searchParams.get('quality') || 'A';

    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': corsOrigin,
          'Allow': 'GET, OPTIONS'
        }
      });
    }

    if (audioUrl) {
      let targetUrl;
      try {
        targetUrl = new URL(audioUrl);
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Invalid audio URL' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin }
        });
      }

      if (targetUrl.protocol !== 'https:' || targetUrl.hostname !== 'xeno-canto.org') {
        return new Response(JSON.stringify({ error: 'Audio URL must be hosted by xeno-canto.org' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin }
        });
      }

      const upstreamHeaders = new Headers();
      const range = request.headers.get('Range');
      if (range) upstreamHeaders.set('Range', range);

      try {
        const audioResponse = await fetch(targetUrl.toString(), { headers: upstreamHeaders });
        const headers = new Headers();
        headers.set('Access-Control-Allow-Origin', corsOrigin);
        headers.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Type');
        headers.set('Cache-Control', 'public, max-age=86400');
        headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
        headers.set('Content-Disposition', 'inline');
        const contentType = audioResponse.headers.get('Content-Type') || 'audio/mpeg';
        headers.set('Content-Type', contentType);
        for (const headerName of ['Accept-Ranges', 'Content-Length', 'Content-Range']) {
          const value = audioResponse.headers.get(headerName);
          if (value) headers.set(headerName, value);
        }
        return new Response(audioResponse.body, {
          status: audioResponse.status,
          statusText: audioResponse.statusText,
          headers
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Failed to fetch audio' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin }
        });
      }
    }

    if (!species) {
      return new Response(JSON.stringify({ error: 'Missing species parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin }
      });
    }

    if (!/^[A-Za-z .'-]+$/.test(species)) {
      return new Response(JSON.stringify({ error: 'Invalid species parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin }
      });
    }

    if (!/^(any|[A-E])$/i.test(quality)) {
      return new Response(JSON.stringify({ error: 'Invalid quality parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin }
      });
    }

    // Create a cache key based on species
    const cacheKey = new Request(`https://cache.local/${species}/${quality}`, request);
    const cache = caches.default;

    // Check cache first
    let cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      // Clone and update CORS header for this request's origin
      const headers = new Headers(cachedResponse.headers);
      headers.set('Access-Control-Allow-Origin', corsOrigin);
      headers.set('X-Cache', 'HIT');
      return new Response(cachedResponse.body, { headers });
    }

    // Not cached, fetch from xeno-canto
    const query = quality.toLowerCase() === 'any' ? `sp:"${species}"` : `sp:"${species}" q:${quality.toUpperCase()}`;
    const apiParams = new URLSearchParams({ query });
    if (env.XENO_CANTO_API_KEY) apiParams.set('key', env.XENO_CANTO_API_KEY);
    const apiUrl = `https://xeno-canto.org/api/3/recordings?${apiParams.toString()}`;

    try {
      const response = await fetch(apiUrl);
      const data = await response.json();

      const responseBody = JSON.stringify(data);
      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin,
        'Cache-Control': 'public, max-age=86400', // Browser cache: 24 hours
        'X-Cache': 'MISS'
      };

      const newResponse = new Response(responseBody, { headers });

      // Store in edge cache (cache for 7 days server-side)
      const cacheResponse = new Response(responseBody, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=604800' // Edge cache: 7 days
        }
      });
      ctx.waitUntil(cache.put(cacheKey, cacheResponse));

      return newResponse;
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Failed to fetch from xeno-canto' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin }
      });
    }
  }
};

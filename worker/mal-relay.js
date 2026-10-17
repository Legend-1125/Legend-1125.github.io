/**
 * AniZone ⇄ MyAnimeList relay (Cloudflare Worker)
 *
 * MyAnimeList's API does not accept requests made directly from web pages
 * (no CORS), and logging in needs a client secret that must never be put in
 * a public website. This small Worker sits in between:
 *
 *   GET  /config               -> { clientId, callbackUrl, siteIndex } for starting a login
 *   GET  /oauth/callback       <- MAL sends the visitor here after they log in;
 *                                 forwards them back to AniZone with the code
 *   POST /oauth/token          { code, code_verifier }  -> MAL tokens
 *   POST /oauth/refresh        { refresh_token }        -> new MAL tokens
 *   *    /api/<path>           -> https://api.myanimelist.net/v2/<path>
 *                                 (only the few list/profile paths AniZone uses)
 *   GET  /public/anime/<id>    -> { id, mean, scoringUsers }: an anime's MAL score,
 *                                 for every visitor, no login needed
 *
 * It stores nothing. Tokens go straight back to the visitor's browser.
 *
 * Settings (Cloudflare dashboard -> Worker -> Settings -> Variables and Secrets):
 *   MAL_CLIENT_ID      your MAL API Client ID                       (text)
 *   MAL_CLIENT_SECRET  your MAL API Client Secret                   (secret)
 *   ALLOWED_ORIGINS    sites allowed to use this relay, comma separated (text), e.g.
 *                      https://legend-1125.github.io,http://localhost:8000
 */

const MAL_AUTHORIZE_URL = 'https://myanimelist.net/v1/oauth2/authorize';
const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
const MAL_API_BASE = 'https://api.myanimelist.net/v2/';
const MAX_BODY_BYTES = 4096;

// The only MAL API calls AniZone makes. Anything else is refused, so the relay
// can't be used as a general-purpose proxy.
const API_RULES = [
    { pattern: /^users\/@me$/, methods: ['GET'] },
    { pattern: /^users\/@me\/animelist$/, methods: ['GET'] },
    { pattern: /^anime\/\d{1,9}$/, methods: ['GET'] },
    { pattern: /^anime\/\d{1,9}\/my_list_status$/, methods: ['PATCH', 'PUT', 'DELETE'] },
];

function allowedOrigins(env) {
    return String(env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim().replace(/\/+$/, '')).filter(Boolean);
}

function corsHeaders(origin, env) {
    if (!origin || !allowedOrigins(env).includes(origin)) return {};
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    };
}

function json(data, status, origin, env) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin, env) },
    });
}

// The login's "state" is a short code: 20 random letters/digits made by the site,
// then the position of the site in ALLOWED_ORIGINS (0, 1, ...). MyAnimeList
// rejects longer or unusual state values, so the return address itself is
// never put in it.
const STATE_PATTERN = /^[A-Za-z0-9]{20}(\d{1,2})$/;
function returnOrigin(state, env) {
    const match = String(state || '').match(STATE_PATTERN);
    return match ? allowedOrigins(env)[Number(match[1])] || null : null;
}

// After logging in on MAL, send the visitor back to AniZone, but only to one of
// the allowed sites.
function handleCallback(url, env) {
    const state = url.searchParams.get('state') || '';
    const origin = returnOrigin(state, env);
    if (!origin) {
        return new Response('This login did not start from an allowed AniZone site.', { status: 400, headers: { 'Content-Type': 'text/plain' } });
    }
    const target = new URL(origin + '/');
    const params = new URLSearchParams({ state });
    for (const key of ['code', 'error', 'error_description']) {
        const value = url.searchParams.get(key);
        if (value) params.set(key, value);
    }
    target.hash = `#/mal-callback?${params}`;
    return Response.redirect(target.toString(), 302);
}

async function readJsonBody(request) {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) throw new Error('Request too large.');
    return JSON.parse(text || '{}');
}

async function exchangeToken(form, origin, env) {
    const response = await fetch(MAL_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.MAL_CLIENT_ID, client_secret: env.MAL_CLIENT_SECRET || '', ...form }),
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
        return json({ error: payload.error || 'token_error', message: payload.message || payload.hint || `MyAnimeList refused the login (${response.status}).` }, response.status === 401 || response.status === 400 ? 400 : 502, origin, env);
    }
    const { access_token, refresh_token, expires_in, token_type } = payload;
    return json({ access_token, refresh_token, expires_in, token_type }, 200, origin, env);
}

// MAL scores for anime pages. MAL's official API answers these with just the
// Client ID, so visitors don't need to log in. Scores barely move, so each one
// is kept for 6 hours (Cloudflare's cache where available, and the browser's).
const PUBLIC_TTL_SECONDS = 6 * 60 * 60;
async function publicAnime(url, origin, env, ctx) {
    const match = url.pathname.match(/^\/public\/anime\/(\d{1,9})$/);
    if (!match) return json({ error: 'not_found' }, 404, origin, env);
    const id = Number(match[1]);
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cacheKey = new Request(`${url.origin}/public/anime/${id}`);
    const withCors = (response) => {
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders(origin, env)).forEach(([key, value]) => headers.set(key, value));
        return new Response(response.body, { status: response.status, headers });
    };
    try {
        const hit = cache && await cache.match(cacheKey);
        if (hit) return withCors(hit);
    } catch {}

    const upstream = await fetch(`${MAL_API_BASE}anime/${id}?fields=mean,num_scoring_users`, {
        headers: { 'X-MAL-CLIENT-ID': env.MAL_CLIENT_ID, Accept: 'application/json' },
    });
    if (upstream.status !== 200 && upstream.status !== 404) {
        return json({ error: 'upstream_error', message: `MyAnimeList answered ${upstream.status}.` }, 502, origin, env);
    }
    const data = upstream.status === 200 ? await upstream.json() : {};
    const body = { id, mean: typeof data.mean === 'number' ? data.mean : null, scoringUsers: data.num_scoring_users ?? null };
    const response = new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${PUBLIC_TTL_SECONDS}`, Vary: 'Origin' },
    });
    try {
        const stored = cache && cache.put(cacheKey, response.clone());
        if (stored) { if (ctx?.waitUntil) ctx.waitUntil(stored); else await stored; }
    } catch {}
    return withCors(response);
}

async function proxyApi(request, url, origin, env) {
    const path = url.pathname.replace(/^\/api\//, '');
    const rule = API_RULES.find(candidate => candidate.pattern.test(path));
    if (!rule) return json({ error: 'not_allowed', message: 'This MyAnimeList request is not allowed through the relay.' }, 403, origin, env);
    if (!rule.methods.includes(request.method)) return json({ error: 'method_not_allowed' }, 405, origin, env);
    const authorization = request.headers.get('Authorization') || '';
    if (!/^Bearer [\w.\-~+/]+=*$/.test(authorization)) return json({ error: 'unauthorized', message: 'Log in with MyAnimeList first.' }, 401, origin, env);

    const init = { method: request.method, headers: { Authorization: authorization, Accept: 'application/json' } };
    if (['PATCH', 'PUT'].includes(request.method)) {
        const body = await request.text();
        if (body.length > MAX_BODY_BYTES) return json({ error: 'too_large' }, 413, origin, env);
        init.body = body;
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const upstream = await fetch(MAL_API_BASE + path + url.search, init);
    return new Response(upstream.body, {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin, env) },
    });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin') || '';
        const fromAllowedSite = allowedOrigins(env).includes(origin);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: fromAllowedSite ? 204 : 403, headers: corsHeaders(origin, env) });
        }
        if (!env.MAL_CLIENT_ID || !allowedOrigins(env).length) {
            return json({ error: 'not_configured', message: 'The relay needs MAL_CLIENT_ID and ALLOWED_ORIGINS settings.' }, 500, origin, env);
        }
        // The MAL login page sends the visitor here directly (a normal page visit, no Origin).
        if (request.method === 'GET' && url.pathname === '/oauth/callback') return handleCallback(url, env);
        // Everything else may only be called by AniZone itself.
        if (!fromAllowedSite) return json({ error: 'forbidden_origin', message: 'This site is not allowed to use the relay.' }, 403, origin, env);

        try {
            if (request.method === 'GET' && url.pathname === '/config') {
                return json({ clientId: env.MAL_CLIENT_ID, callbackUrl: `${url.origin}/oauth/callback`, authorizeUrl: MAL_AUTHORIZE_URL, siteIndex: allowedOrigins(env).indexOf(origin) }, 200, origin, env);
            }
            if (request.method === 'POST' && url.pathname === '/oauth/token') {
                const { code, code_verifier } = await readJsonBody(request);
                if (!code || !code_verifier) return json({ error: 'invalid_request' }, 400, origin, env);
                return exchangeToken({ grant_type: 'authorization_code', code, code_verifier, redirect_uri: `${url.origin}/oauth/callback` }, origin, env);
            }
            if (request.method === 'POST' && url.pathname === '/oauth/refresh') {
                const { refresh_token } = await readJsonBody(request);
                if (!refresh_token) return json({ error: 'invalid_request' }, 400, origin, env);
                return exchangeToken({ grant_type: 'refresh_token', refresh_token }, origin, env);
            }
            if (url.pathname.startsWith('/api/')) return proxyApi(request, url, origin, env);
            if (request.method === 'GET' && url.pathname.startsWith('/public/')) return publicAnime(url, origin, env, ctx);
            return json({ error: 'not_found' }, 404, origin, env);
        } catch (error) {
            return json({ error: 'relay_error', message: 'The relay could not reach MyAnimeList. Try again in a moment.' }, 502, origin, env);
        }
    },
};

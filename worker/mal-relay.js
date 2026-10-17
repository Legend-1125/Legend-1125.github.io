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
 *   GET  /public/backdrop?t=<title>&t=...&year=&format=
 *                              -> { path, width, height }: a full-screen, text-free
 *                                 picture for the home page banner, from TMDB
 *                                 (only when TMDB_TOKEN is set)
 *   GET  /public/news?source=<id> -> { source, name, items: [{ title, url, date, image, excerpt }] }
 *                                 the latest stories from one of the anime news sites below
 *
 * It stores nothing. Tokens go straight back to the visitor's browser.
 *
 * Settings (Cloudflare dashboard -> Worker -> Settings -> Variables and Secrets):
 *   MAL_CLIENT_ID      your MAL API Client ID                       (text)
 *   MAL_CLIENT_SECRET  your MAL API Client Secret                   (secret)
 *   ALLOWED_ORIGINS    sites allowed to use this relay, comma separated (text), e.g.
 *                      https://legend-1125.github.io,http://localhost:8000
 *   TMDB_TOKEN         optional: TMDB "API Read Access Token", for HD home banners (secret)
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

// Home page banners in HD. AniList and Kitsu banners are small strips; TMDB has
// full-screen (16:9, up to 4K) artwork for most anime. TMDB doesn't know AniList
// or MAL ids, so the show is found by title: the English, romaji and Japanese
// titles, then the series name without its season/arc ("Tokyo Revengers: ...").
// Only Japanese animation is accepted, and a shortened name must match exactly.
const TMDB_API = 'https://api.themoviedb.org/3';
const BACKDROP_TTL_SECONDS = 7 * 24 * 60 * 60;
const BACKDROP_MISS_TTL_SECONDS = 24 * 60 * 60;
const plainTitle = (text) => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function seriesName(title) {
    const base = String(title || '')
        .split(/\s*[:：]\s+|\s+-\s+/)[0]
        .replace(/\s+(season|part|cour)\s*\d+.*$/i, '')
        .replace(/\s+\d+(st|nd|rd|th)\s+season.*$/i, '')
        .replace(/\s+(2nd|3rd|\d+th)?\s*(arc|hen|-hen)$/i, '')
        .trim();
    return base.length >= 4 && base !== title ? base : '';
}
async function tmdbGet(path, env) {
    const response = await fetch(TMDB_API + path, { headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, Accept: 'application/json' } });
    if (!response.ok) { const error = new Error(`TMDB answered ${response.status}`); error.status = response.status; throw error; }
    return response.json();
}
async function findBackdrop(titles, year, format, env) {
    const wanted = new Set(titles.map(plainTitle).filter(Boolean));
    const queries = [];
    for (const title of titles) if (title && !queries.some(q => q.text === title)) queries.push({ text: title, exact: false });
    for (const title of titles) {
        const base = seriesName(title);
        if (base && !queries.some(q => q.text === base)) { queries.push({ text: base, exact: true }); wanted.add(plainTitle(base)); }
    }
    const kinds = format === 'MOVIE' ? ['movie', 'tv'] : ['tv', 'movie'];
    for (const kind of kinds) {
        for (const query of queries.slice(0, 6)) {
            const params = new URLSearchParams({ query: query.text, include_adult: 'false' });
            const data = await tmdbGet(`/search/${kind}?${params}`, env);
            const anime = (data.results || []).filter(result => (result.genre_ids || []).includes(16)
                && (result.original_language === 'ja' || (result.origin_country || []).includes('JP')));
            const names = (result) => [result.name, result.original_name, result.title, result.original_title].map(plainTitle).filter(Boolean);
            const q = plainTitle(query.text);
            let match = anime.find(result => names(result).some(name => wanted.has(name)));
            if (!match && !query.exact) match = anime.find(result => names(result).some(name => name.length >= 4 && (name.includes(q) || q.includes(name))));
            if (match && kind === 'movie' && year) {
                const released = Number(String(match.release_date || '').slice(0, 4));
                if (released && Math.abs(released - year) > 1) match = null;
            }
            if (!match) continue;
            const images = await tmdbGet(`/${kind}/${match.id}/images?include_image_language=null,en,ja`, env);
            const backdrops = (images.backdrops || []).filter(b => b.file_path && b.width >= 1280);
            backdrops.sort((a, b) => (a.iso_639_1 == null ? 0 : 1) - (b.iso_639_1 == null ? 0 : 1) || (b.vote_average || 0) - (a.vote_average || 0) || (b.width || 0) - (a.width || 0));
            const best = backdrops[0];
            if (best) return { path: best.file_path, width: best.width, height: best.height, tmdbId: match.id, kind, name: match.name || match.title };
            return null;
        }
    }
    return null;
}
async function publicBackdrop(url, origin, env, ctx) {
    if (!env.TMDB_TOKEN) return json({ error: 'tmdb_not_configured', message: 'Add TMDB_TOKEN to the relay for HD banners.' }, 501, origin, env);
    const titles = url.searchParams.getAll('t').map(t => t.trim().slice(0, 200)).filter(Boolean).slice(0, 3);
    if (!titles.length) return json({ error: 'invalid_request' }, 400, origin, env);
    const year = Number(url.searchParams.get('year')) || 0;
    const format = String(url.searchParams.get('format') || '').toUpperCase().replace(/[^A-Z_]/g, '').slice(0, 12);
    const key = new URLSearchParams();
    titles.forEach(t => key.append('t', t)); if (year) key.set('year', String(year)); if (format) key.set('format', format);
    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const cacheKey = new Request(`${url.origin}/public/backdrop?${key}`);
    const withCors = (response) => {
        const headers = new Headers(response.headers);
        Object.entries(corsHeaders(origin, env)).forEach(([name, value]) => headers.set(name, value));
        return new Response(response.body, { status: response.status, headers });
    };
    try { const hit = cache && await cache.match(cacheKey); if (hit) return withCors(hit); } catch {}
    let found;
    try { found = await findBackdrop(titles, year, format, env); }
    catch (error) {
        return json({ error: 'upstream_error', message: error.status === 401 ? 'TMDB refused the token. Re-copy TMDB_TOKEN.' : 'TMDB could not be reached.' }, error.status === 401 ? 502 : 504, origin, env);
    }
    const ttl = found ? BACKDROP_TTL_SECONDS : BACKDROP_MISS_TTL_SECONDS;
    const response = new Response(JSON.stringify(found || { path: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}`, Vary: 'Origin' },
    });
    try { const stored = cache && cache.put(cacheKey, response.clone()); if (stored) { if (ctx?.waitUntil) ctx.waitUntil(stored); else await stored; } } catch {}
    return withCors(response);
}

// Anime news from several sites. Their feeds can't be read by web pages directly
// (no CORS), so the relay reads them, finds a picture for stories whose feed has
// none (from the article's own preview image), and returns one tidy format.
// Only these feeds can be read: the relay is not a general-purpose proxy.
const NEWS_SOURCES = {
    mal: { name: 'MyAnimeList', feed: 'https://myanimelist.net/rss/news.xml' },
    crunchyroll: { name: 'Crunchyroll News', feed: 'https://cr-news-api-service.prd.crunchyrollsvc.com/v1/en-US/rss' },
    ann: { name: 'Anime News Network', feed: 'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us' },
    animecorner: { name: 'Anime Corner', feed: 'https://animecorner.me/feed/' },
    honeysanime: { name: "Honey's Anime", feed: 'https://honeysanime.com/feed/' },
};
const NEWS_MAX_ITEMS = 25;
const NEWS_TTL_SECONDS = 15 * 60;
const NEWS_FETCH_TIMEOUT_MS = 8000;
const NEWS_IMAGE_TIMEOUT_MS = 4000;
const NEWS_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; AniZoneNews/1.0; +https://legend-1125.github.io)', Accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5' };
const articleImages = new Map();   // article URL -> picture, kept while this relay instance is warm
const newsMemory = new Map();      // source -> { at, body }

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', eacute: 'é', copy: '©', reg: '®', trade: '™' };
function decodeEntities(text) {
    return String(text || '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
        if (code[0] === '#') {
            const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
        }
        return ENTITIES[code.toLowerCase()] ?? whole;
    });
}
const unwrapCdata = (text) => String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const stripTags = (html) => String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
// Twice, because some feeds escape their HTML ("&lt;p&gt;") inside the text.
const plainText = (html) => stripTags(decodeEntities(stripTags(unwrapCdata(html)))).replace(/\s+/g, ' ').trim();
function xmlField(block, name) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    return match ? unwrapCdata(match[1]).trim() : '';
}
function xmlAttr(block, name, attr) {
    const tag = block.match(new RegExp(`<${name}\\b[^>]*>`, 'i'))?.[0] || '';
    const value = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1] || '';
    return decodeEntities(value);
}
function cleanLink(href) {
    try {
        const url = new URL(decodeEntities(href).trim());
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
        url.protocol = 'https:';
        [...url.searchParams.keys()].filter(key => /^utm_/i.test(key)).forEach(key => url.searchParams.delete(key));
        return url.toString();
    } catch { return ''; }
}
const httpsImage = (src) => { const url = cleanLink(src); return url && !/\.svg(\?|$)/i.test(url) && !/(gravatar|feedburner|pixel|emoji|1x1)/i.test(url) ? url : ''; };
function firstImageIn(html) {
    for (const match of unwrapCdata(html).matchAll(/<img\b[^>]*>/gi)) {
        const tag = match[0];
        const src = tag.match(/\b(?:data-src|src)\s*=\s*["']([^"']+)["']/i)?.[1];
        const width = Number(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] || 0);
        if (src && (!width || width >= 200)) { const url = httpsImage(src); if (url) return url; }
    }
    return '';
}
function parseFeed(xml) {
    const items = [];
    for (const match of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
        const block = match[1];
        const title = plainText(xmlField(block, 'title'));
        const url = cleanLink(plainText(xmlField(block, 'link')) || xmlAttr(block, 'link', 'href'));
        if (!title || !url) continue;
        const description = xmlField(block, 'description');
        const content = xmlField(block, 'content:encoded');
        const dateText = xmlField(block, 'pubDate') || xmlField(block, 'dc:date') || xmlField(block, 'published');
        const date = new Date(plainText(dateText));
        const enclosureType = xmlAttr(block, 'enclosure', 'type');
        const image = httpsImage(xmlAttr(block, 'media:thumbnail', 'url') || plainText(xmlField(block, 'media:thumbnail')))
            || httpsImage(xmlAttr(block, 'media:content', 'url'))
            || (/^image\//i.test(enclosureType) || !enclosureType ? httpsImage(xmlAttr(block, 'enclosure', 'url')) : '')
            || firstImageIn(content) || firstImageIn(description);
        items.push({
            title: title.slice(0, 300),
            url,
            date: Number.isNaN(date.getTime()) ? '' : date.toISOString(),
            image,
            excerpt: plainText(description || content).slice(0, 400),
        });
        if (items.length >= NEWS_MAX_ITEMS) break;
    }
    return items;
}
async function fetchText(url, timeoutMs, maxBytes = 1_500_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { headers: NEWS_HEADERS, signal: controller.signal, redirect: 'follow' });
        if (!response.ok) { const error = new Error(`answered ${response.status}`); error.status = response.status; throw error; }
        const text = await response.text();
        return text.length > maxBytes ? text.slice(0, maxBytes) : text;
    } finally { clearTimeout(timer); }
}
// The article's own preview picture (what social sites show when the link is shared).
async function articleImage(url) {
    if (articleImages.has(url)) return articleImages.get(url);
    let image = '';
    try {
        const html = (await fetchText(url, NEWS_IMAGE_TIMEOUT_MS, 400_000)).slice(0, 200_000);
        for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
            if (!/(?:property|name)\s*=\s*["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["']/i.test(tag)) continue;
            image = httpsImage(tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1] || '');
            if (image) break;
        }
    } catch {}
    if (articleImages.size > 500) articleImages.clear();
    articleImages.set(url, image);
    return image;
}
async function publicNews(url, origin, env, ctx) {
    const id = url.searchParams.get('source') || '';
    const source = Object.prototype.hasOwnProperty.call(NEWS_SOURCES, id) ? NEWS_SOURCES[id] : null;
    if (!source) return json({ error: 'unknown_source', sources: Object.keys(NEWS_SOURCES) }, 404, origin, env);
    const reply = (body) => new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${NEWS_TTL_SECONDS}`, ...corsHeaders(origin, env) },
    });
    const remembered = newsMemory.get(id);
    if (remembered && Date.now() - remembered.at < NEWS_TTL_SECONDS * 1000) return reply(remembered.body);
    let items;
    try { items = parseFeed(await fetchText(source.feed, NEWS_FETCH_TIMEOUT_MS)); }
    catch (error) {
        if (remembered) return reply(remembered.body);
        return json({ error: 'source_unavailable', message: `${source.name} could not be reached (${error.message || 'no answer'}).` }, 502, origin, env);
    }
    if (!items.length) return json({ error: 'source_unavailable', message: `${source.name} sent no stories.` }, 502, origin, env);
    // Stories without a picture in the feed: look up the article's preview picture (side by side).
    await Promise.all(items.map(async item => { if (!item.image) item.image = await articleImage(item.url); }));
    const body = JSON.stringify({ source: id, name: source.name, items });
    newsMemory.set(id, { at: Date.now(), body });
    return reply(body);
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
            if (request.method === 'GET' && url.pathname === '/public/backdrop') return publicBackdrop(url, origin, env, ctx);
            if (request.method === 'GET' && url.pathname === '/public/news') return publicNews(url, origin, env, ctx);
            if (request.method === 'GET' && url.pathname.startsWith('/public/')) return publicAnime(url, origin, env, ctx);
            return json({ error: 'not_found' }, 404, origin, env);
        } catch (error) {
            return json({ error: 'relay_error', message: 'The relay could not reach MyAnimeList. Try again in a moment.' }, 502, origin, env);
        }
    },
};

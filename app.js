// AniZone — AniList GraphQL edition
// Single-file application data layer, routing, rendering and local cache.

const ANILIST_API = 'https://graphql.anilist.co';
const JIKAN_API = 'https://api.jikan.moe/v4';
const MAL_SCORE_PREFIX = 'anizone:mal-score:v1:';
const MAL_SCORE_TTL = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 24;
const SEARCH_PAGE_SIZE = 50;
const CACHE_PREFIX = 'anizone:anilist:v2:';
const CACHE_TTL = {
    trending: 30 * 60 * 1000,
    top: 24 * 60 * 60 * 1000,
    discover: 6 * 60 * 60 * 1000,
    search: 15 * 60 * 1000,
    details: 7 * 24 * 60 * 60 * 1000,
    studio: 6 * 60 * 60 * 1000,
    schedule: 10 * 60 * 1000,
};

// AniList has exactly these 19 genres. Every other entry in the genre menu
// (Isekai, Shounen, School, ...) is an AniList *tag* and must be queried with tag:.
const ANILIST_GENRES = new Set(['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Hentai', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller']);
// A tag only counts when it describes at least this much of a show (AniList tag rank,
// 0-100), so "Isekai" returns isekai shows rather than ones with a brief isekai episode.
const TAG_MIN_RANK = 60;

const HISTORY_KEY = 'anizoneAniListHistory';
const HISTORY_LIMIT = 100;

function compactHistoryItem(anime) {
    return {
        id: Number(anime?.id),
        isAdult: Boolean(anime?.isAdult),
        title: {
            english: anime?.title?.english || null,
            romaji: anime?.title?.romaji || null,
            native: anime?.title?.native || null,
        },
        coverImage: { large: anime?.coverImage?.large || anime?.coverImage?.extraLarge || anime?.coverImage?.medium || '' },
        averageScore: anime?.averageScore || null,
        format: anime?.format || null,
        viewedAt: anime?.viewedAt || Date.now(),
    };
}
function clearAniListCaches() {
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
    }
}
function persistHistory() {
    const payload = JSON.stringify(clickHistory.slice(0, HISTORY_LIMIT));
    try {
        localStorage.setItem(HISTORY_KEY, payload);
    } catch (error) {
        // Old API caches can consume the storage quota. They are disposable;
        // history and preferences are not.
        clearAniListCaches();
        try { localStorage.setItem(HISTORY_KEY, payload); }
        catch (retryError) { console.warn('Unable to persist history:', retryError); }
    }
}
function loadCompactHistory() {
    try {
        const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        const seen = new Set();
        return raw.map(compactHistoryItem).filter(item => {
            if (!item.id || seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
        }).slice(0, HISTORY_LIMIT);
    } catch { return []; }
}

let clickHistory = loadCompactHistory();
let titleLanguage = localStorage.getItem('anizoneTitleLanguage') || 'english';
const ADULT_DEFAULT_MIGRATION_KEY = 'anizone:adult-default-off:v1';
if (!localStorage.getItem(ADULT_DEFAULT_MIGRATION_KEY)) {
    localStorage.setItem('anizoneAdultEnabled', 'false');
    localStorage.setItem('anizoneDiscoverAdultMode', 'regular');
    localStorage.setItem(ADULT_DEFAULT_MIGRATION_KEY, 'done');
}
const ADULT_DEFAULT_OFF_MIGRATION = 'anizoneAdultDefaultOffV1';
if (!localStorage.getItem(ADULT_DEFAULT_OFF_MIGRATION)) {
    localStorage.setItem('anizoneAdultEnabled', 'false');
    localStorage.setItem('anizoneDiscoverAdultMode', 'regular');
    localStorage.setItem(ADULT_DEFAULT_OFF_MIGRATION, 'true');
}
let adultContentEnabled = localStorage.getItem('anizoneAdultEnabled') === 'true';
let castLanguage = localStorage.getItem('anizoneCastLanguage') || 'JAPANESE';
let currentCastEdges = [];
let currentDetailAnime = null;
let heroBackgroundLayer = 0;
let selectedDiscoverAdult = localStorage.getItem('anizoneDiscoverAdultMode') || (adultContentEnabled ? 'both' : 'regular');

let currentSearchQuery = '';
let currentPage = 1;
let currentActiveRowTarget = '';
let selectedStudioId = null;
let selectedStudioName = '';
let selectedDiscoverGenre = '';
let selectedDiscoverYear = String(new Date().getFullYear());
let selectedDiscoverSeason = '';
let selectedDiscoverType = '';
let selectedDiscoverStatus = '';
let selectedDiscoverRating = '';
// Search filters are separate from Discover and live in the search address
// (#/search?q=...&genre=...): a new search starts clean, and refresh/Back keep them.
const SEARCH_FILTER_PARAMS = Object.freeze({ genre: 'genre', year: 'year', season: 'season', type: 'type', status: 'status', rating: 'score', content: 'content', order: 'sort' });
const SEARCH_FILTER_VALUES = Object.freeze({
    season: ['WINTER', 'SPRING', 'SUMMER', 'FALL'],
    type: ['tv', 'movie', 'ova', 'ona', 'special'],
    status: ['airing', 'complete', 'upcoming'],
    rating: ['70', '80', '90'],
    content: ['regular', 'adult', 'both'],
    order: ['popularity', 'score', 'start_date'],
});
function defaultSearchFilters() {
    return { genre: '', year: '', season: '', type: '', status: '', rating: '', content: '', order: 'default' };
}
let searchFilters = defaultSearchFilters();
let homeDiscoverStale = false;
function effectiveSearchContent() {
    return adultContentEnabled ? (searchFilters.content || 'both') : 'regular';
}
let resultsPageInfo = null;
let resultsRequestToken = 0;
let suggestionController = null;
let heroSlides = [];
let heroSlideIndex = 0;
let heroInterval = null;
let scheduleInitialized = false;
const dashboardPools = { trending: [], top: [], discover: [] };

const views = document.querySelectorAll('.tab-view');
const navButtons = document.querySelectorAll('.nav-btn');
const searchInput = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search-btn');
const suggestionsDropdown = document.getElementById('search-suggestions');
const loading = document.getElementById('loading');
const mainNav = document.getElementById('main-nav');

function abortError() { return new DOMException('Aborted', 'AbortError'); }
function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(abortError()); return; }
        const onAbort = () => { clearTimeout(timer); reject(abortError()); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
function getCurrentSeason() {
    const month = new Date().getMonth();
    if (month < 3) return 'WINTER';
    if (month < 6) return 'SPRING';
    if (month < 9) return 'SUMMER';
    return 'FALL';
}
function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function stripHtml(value) {
    // DOMParser builds an inert document: unlike innerHTML on a <div>, nothing in it
    // loads or runs (no image requests, no onerror handlers).
    return new DOMParser().parseFromString(String(value || ''), 'text/html').body.textContent || '';
}
// A synopsis without the credits and editors' notes AniList/MAL add to it:
// "(Source: Kodansha USA)", "[Written by MAL Rewrite]", "Note: episode 2 was streamed...".
function synopsisText(description) {
    let text = stripHtml(description).replace(/\s+/g, ' ').trim();
    text = text.replace(/\s*[(\[]\s*(?:sources?|written by|taken from|from)\s*[:\s][^)\]]*[)\]]/gi, ' ');
    const note = text.search(/(?:^|\s)(?:notes?|n\.b\.)\s*:/i);
    if (note > 30) text = text.slice(0, note);   // (a "note:" right at the start is part of the story)
    text = text.replace(/\s*(?:sources?)\s*:\s*[^.]*\.?\s*$/i, '');
    return text.replace(/\s+/g, ' ').trim();
}
function showLoading(show) { loading?.classList.toggle('hidden', !show); }
function scrollPageToTop() {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
}
function displayTitle(anime, forceEnglish = false) {
    const titles = anime?.title || {};
    if (forceEnglish || titleLanguage === 'english') return titles.english || titles.romaji || titles.native || 'Untitled';
    return titles.romaji || titles.english || titles.native || 'Untitled';
}
function secondaryTitle(anime) {
    const primary = displayTitle(anime);
    const other = titleLanguage === 'english' ? anime?.title?.romaji : anime?.title?.english;
    return other && other !== primary ? other : '';
}
function imageUrl(anime) { return anime?.coverImage?.extraLarge || anime?.coverImage?.large || anime?.coverImage?.medium || ''; }
function dateNumber(date) {
    if (!date?.year) return Number.MAX_SAFE_INTEGER;
    return date.year * 10000 + (date.month || 1) * 100 + (date.day || 1);
}
function formatDate(date) {
    if (!date?.year) return 'TBA';
    return new Date(date.year, (date.month || 1) - 1, date.day || 1).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
function formatStatus(status) {
    return ({ RELEASING: 'Airing', FINISHED: 'Completed', NOT_YET_RELEASED: 'Upcoming', CANCELLED: 'Cancelled', HIATUS: 'Hiatus' })[status] || status || 'Unknown';
}
function formatFormat(format) {
    return ({ TV: 'TV', TV_SHORT: 'TV Short', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music' })[format] || format || 'Anime';
}
function seasonLabel() {
    const season = selectedDiscoverSeason ? `${selectedDiscoverSeason.charAt(0)}${selectedDiscoverSeason.slice(1).toLowerCase()} ` : '';
    return `${season}${selectedDiscoverYear}`.trim();
}

function cacheGet(key) {
    try {
        const record = JSON.parse(localStorage.getItem(CACHE_PREFIX + key) || 'null');
        if (!record || Date.now() > record.expiresAt) return null;
        return record.value;
    } catch { return null; }
}
function pruneAniListCaches(maxEntries = 28) {
    const entries = [];
    for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (!key?.startsWith(CACHE_PREFIX)) continue;
        try {
            const record = JSON.parse(localStorage.getItem(key) || 'null');
            if (!record || Date.now() > record.expiresAt) localStorage.removeItem(key);
            else entries.push({ key, storedAt: record.storedAt || 0 });
        } catch { localStorage.removeItem(key); }
    }
    entries.sort((a, b) => b.storedAt - a.storedAt).slice(maxEntries).forEach(entry => localStorage.removeItem(entry.key));
}
function cacheSet(key, value, ttl) {
    const payload = JSON.stringify({ value, expiresAt: Date.now() + ttl, storedAt: Date.now() });
    try {
        pruneAniListCaches();
        localStorage.setItem(CACHE_PREFIX + key, payload);
    } catch {
        clearAniListCaches();
        try { localStorage.setItem(CACHE_PREFIX + key, payload); } catch { /* live data is still usable */ }
    }
}


function getCachedMalScore(malId) {
    if (!malId) return null;
    try {
        const record = JSON.parse(localStorage.getItem(MAL_SCORE_PREFIX + malId) || 'null');
        if (!record || Date.now() > record.expiresAt) {
            localStorage.removeItem(MAL_SCORE_PREFIX + malId);
            return null;
        }
        return record.score ?? null;
    } catch { return null; }
}
function setCachedMalScore(malId, score) {
    if (!malId || score == null) return;
    try {
        localStorage.setItem(MAL_SCORE_PREFIX + malId, JSON.stringify({ score, expiresAt: Date.now() + MAL_SCORE_TTL }));
    } catch {
        // MAL scores are optional; never let storage issues break the detail page.
    }
}
const JIKAN_CACHE_PREFIX = 'anizone:jikan:v3:';
const JIKAN_DEFAULT_TTL = 12 * 60 * 60 * 1000;
const jikanInflight = new Map();
let jikanQueue = Promise.resolve();
let lastJikanRequestAt = 0;
let jikanCooldownUntil = 0;
// Jikan (the free MyAnimeList API) sometimes goes down or hangs. Each request gets a
// time limit, and after a failure all Jikan requests pause briefly, so the MAL badge
// shows "MAL —" within seconds instead of waiting on a line of doomed requests.
const JIKAN_TIMEOUT_MS = 8000;
const JIKAN_OUTAGE_PAUSE_MS = 60 * 1000;
let jikanUnavailableUntil = 0;
function jikanUnavailableError() {
    const error = new Error('MyAnimeList data is temporarily unavailable.');
    error.name = 'JikanUnavailable';
    return error;
}
function jikanCacheRead(path, allowStale = false) {
    try {
        const record = JSON.parse(localStorage.getItem(JIKAN_CACHE_PREFIX + path) || 'null');
        if (!record) return null;
        if (!allowStale && Date.now() > record.expiresAt) return null;
        return record.value;
    } catch { return null; }
}
function jikanCacheWrite(path, value, ttl) {
    try { localStorage.setItem(JIKAN_CACHE_PREFIX + path, JSON.stringify({ value, expiresAt: Date.now() + ttl })); } catch {}
}
// fetch + JSON with a time limit. An outer signal (leaving the page) cancels it too.
async function fetchJsonWithTimeout(url, timeoutMs, signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
        let payload = null;
        try { payload = await response.json(); } catch {}
        return { response, payload };
    } catch (error) {
        if (signal?.aborted) throw abortError();
        if (error.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs / 1000}s.`);
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
async function jikanRequest(path, { retries = 1, ttl = JIKAN_DEFAULT_TTL, force = false, signal } = {}) {
    if (!force) {
        const cached = jikanCacheRead(path);
        if (cached) return cached;
    }
    if (Date.now() < jikanUnavailableUntil) {
        const stale = jikanCacheRead(path, true);
        if (stale) return stale;
        throw jikanUnavailableError();
    }
    if (jikanInflight.has(path)) return jikanInflight.get(path);
    const task = jikanQueue = jikanQueue.catch(() => {}).then(async () => {
        if (signal?.aborted) throw abortError();
        const stale = jikanCacheRead(path, true);
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
            if (Date.now() < jikanUnavailableUntil) { lastError = jikanUnavailableError(); break; }
            try {
                const wait = Math.max(0, jikanCooldownUntil - Date.now(), 1250 - (Date.now() - lastJikanRequestAt));
                if (wait) await delay(wait, signal);
                lastJikanRequestAt = Date.now();
                const { response, payload } = await fetchJsonWithTimeout(`${JIKAN_API}${path}`, JIKAN_TIMEOUT_MS, signal);
                if (response.ok) { jikanCacheWrite(path, payload, ttl); return payload; }
                const retryAfter = Number(response.headers.get('Retry-After')) || Math.min(12, 2 ** (attempt + 1));
                if (response.status === 429) jikanCooldownUntil = Date.now() + retryAfter * 1000;
                lastError = new Error(response.status === 429 ? 'Extra MyAnimeList data is temporarily rate-limited.' : (payload?.message || `Jikan request failed (${response.status}).`));
                if ((response.status === 429 || response.status >= 500) && attempt < retries) { await delay(retryAfter * 1000, signal); continue; }
                break;
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                // No response at all (network error, CORS-less error page, or time limit):
                // Jikan itself is unreachable, so stop asking for a minute.
                jikanUnavailableUntil = Date.now() + JIKAN_OUTAGE_PAUSE_MS;
                console.warn('Jikan unavailable:', error.message);
                lastError = jikanUnavailableError();
                break;
            }
        }
        if (stale) return stale;
        throw lastError || jikanUnavailableError();
    }).finally(() => { if (jikanInflight.get(path) === task) jikanInflight.delete(path); });
    jikanInflight.set(path, task);
    signal?.addEventListener('abort', () => {
        if (jikanInflight.get(path) === task) jikanInflight.delete(path);
    }, { once: true });
    return task;
}
// One /full request supplies both the MAL score and the theme songs.
async function getJikanAnimeFull(malId, signal) {
    if (!malId) return null;
    const payload = await jikanRequest(`/anime/${Number(malId)}/full`, { retries: 1, ttl: 24 * 60 * 60 * 1000, signal });
    return payload?.data || null;
}
// MAL's own API, through the AniZone relay (worker/mal-relay.js). Works without
// logging in. Returns the score, null when MAL has no score yet, or undefined
// when the relay can't answer (not set up, older relay version, MAL down).
const RELAY_SCORE_TIMEOUT_MS = 6000;
async function fetchMalScoreFromRelay(malId, signal) {
    const relay = typeof MalSync !== 'undefined' ? MalSync.relayUrl() : '';
    if (!relay) return undefined;
    try {
        const { response, payload } = await fetchJsonWithTimeout(`${relay}/public/anime/${Number(malId)}`, RELAY_SCORE_TIMEOUT_MS, signal);
        if (response.ok && payload && 'mean' in payload) return typeof payload.mean === 'number' ? payload.mean : null;
        console.warn('MAL score relay answered', response.status);
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        console.warn('MAL score relay unavailable:', error.message);
    }
    return undefined;
}
// Returns the MAL score, null when MAL has no score, or throws when no source can answer.
// Tries MAL's official API (via the relay) first, then Jikan.
async function fetchMalScore(malId, signal) {
    if (!malId) return null;
    const cached = getCachedMalScore(malId);
    if (cached != null) return cached;
    let score = await fetchMalScoreFromRelay(malId, signal);
    if (score === undefined) {
        try {
            score = (await getJikanAnimeFull(malId, signal))?.score ?? null;
        } catch (error) {
            const staleCompact = jikanCacheRead(`/anime/${Number(malId)}`, true);
            if (error.name === 'AbortError' || staleCompact?.data?.score == null) throw error;
            score = staleCompact.data.score;
        }
    }
    if (score != null) setCachedMalScore(malId, score);
    return score;
}

async function getAnimeByMalId(malId) {
    const query = `query ($idMal: Int!) {
        Media(idMal: $idMal, type: ANIME) { id idMal isAdult title { romaji english native } }
    }`;
    return aniRequest(query, { idMal: Number(malId) }, { cacheKey: `mal-to-anilist:${Number(malId)}`, ttl: 30 * 24 * 60 * 60 * 1000, priority: 'interactive' });
}

class AniListError extends Error {
    constructor(message, status = 0, details = null) {
        super(message);
        this.name = 'AniListError';
        this.status = status;
        this.details = details;
    }
}

const ANILIST_CACHE_STALE_TTL = 7 * 24 * 60 * 60 * 1000;

/* ==========================================
   ANILIST REQUEST SCHEDULER
   AniList allows 30 requests per minute (its temporarily reduced limit) and
   accepts short bursts. Instead of spacing every request ~2s apart, requests go
   out immediately while a per-minute budget lasts, a few at a time, and the
   queue is ordered by priority:
     interactive  what the visitor just clicked (anime page, search, grid pages)
     normal       supporting data for the current page (franchise timeline)
     background   prefetching (Home rows while another page is open)
   ========================================== */
const ANI_WINDOW_MS = 60_000;
const ANI_WINDOW_BUDGET = 24;      // stay well under AniList's 30/min
const ANI_MAX_IN_FLIGHT = 3;
const ANI_MIN_GAP_MS = 120;        // spread a burst slightly
const ANI_LOW_REMAINING = 3;       // server says we're nearly out: pause
const ANI_LOW_REMAINING_PAUSE_MS = 15_000;
const ANI_PRIORITY_RANK = Object.freeze({ interactive: 0, normal: 1, background: 2 });

const aniJobs = new Map();         // request key -> job, shared by callers asking for the same data
const aniPending = [];
const aniSentAt = [];              // send times within the last minute
let aniInFlightCount = 0;
let aniPumpTimer = null;
let aniJobSeq = 0;
let aniLastRequestAt = 0;
let aniCooldownUntil = 0;

function cacheGetStale(key) {
    try {
        const record = JSON.parse(localStorage.getItem(CACHE_PREFIX + key) || 'null');
        if (!record || !record.value) return null;
        const agePastExpiry = Date.now() - Number(record.expiresAt || 0);
        return agePastExpiry <= ANILIST_CACHE_STALE_TTL ? record.value : null;
    } catch { return null; }
}

function updateAniRateState(response) {
    const now = Date.now();
    const remaining = Number(response.headers.get('X-RateLimit-Remaining'));
    const reset = Number(response.headers.get('X-RateLimit-Reset'));
    const resetAt = Number.isFinite(reset) && reset > 0 ? (reset > 10_000_000_000 ? reset : reset * 1000) : 0;
    const retryAfter = Number(response.headers.get('Retry-After'));
    if (response.status === 429) {
        const fallback = resetAt > now ? resetAt - now : 65_000;
        aniCooldownUntil = Math.max(aniCooldownUntil, now + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : fallback));
    } else if (Number.isFinite(remaining) && response.headers.has('X-RateLimit-Remaining') && remaining <= ANI_LOW_REMAINING) {
        // Another tab (or an earlier visit) used most of this minute's allowance.
        aniCooldownUntil = Math.max(aniCooldownUntil, resetAt > now ? resetAt + 500 : now + ANI_LOW_REMAINING_PAUSE_MS);
    }
}

function aniDelayUntilNextSlot() {
    const now = Date.now();
    while (aniSentAt.length && now - aniSentAt[0] >= ANI_WINDOW_MS) aniSentAt.shift();
    let wait = Math.max(0, aniCooldownUntil - now, ANI_MIN_GAP_MS - (now - aniLastRequestAt));
    if (aniSentAt.length >= ANI_WINDOW_BUDGET) wait = Math.max(wait, aniSentAt[0] + ANI_WINDOW_MS - now);
    return wait;
}

function pumpAniQueue() {
    clearTimeout(aniPumpTimer);
    aniPumpTimer = null;
    for (let i = aniPending.length - 1; i >= 0; i--) {
        if (aniPending[i].controller.signal.aborted) aniPending.splice(i, 1)[0].reject(abortError());
    }
    if (!aniPending.length || aniInFlightCount >= ANI_MAX_IN_FLIGHT) return;
    const wait = aniDelayUntilNextSlot();
    if (wait > 0) { aniPumpTimer = setTimeout(pumpAniQueue, wait); return; }
    aniPending.sort((x, y) => x.rank - y.rank || x.seq - y.seq);
    const job = aniPending.shift();
    aniInFlightCount++;
    aniLastRequestAt = Date.now();
    aniSentAt.push(aniLastRequestAt);
    job.run(job.controller.signal).then(job.resolve, job.reject).finally(() => {
        aniInFlightCount--;
        pumpAniQueue();
    });
    pumpAniQueue();
}

// Several parts of the page can ask for the same data. The shared request is only
// cancelled when every caller that asked for it has gone (e.g. left the page).
function joinAniJob(job, signal, priority) {
    job.rank = Math.min(job.rank, ANI_PRIORITY_RANK[priority] ?? ANI_PRIORITY_RANK.normal);
    if (!signal) { job.pinned = true; }
    else if (!signal.aborted) {
        job.liveSignals++;
        signal.addEventListener('abort', () => {
            job.liveSignals--;
            if (!job.pinned && job.liveSignals === 0) {
                job.controller.abort();
                if (aniJobs.get(job.key) === job) aniJobs.delete(job.key);
                pumpAniQueue();
            }
        }, { once: true });
    }
    if (job.queued && job.rank === 0) pumpAniQueue();
    return job.promise;
}

function aniRequest(query, variables = {}, options = {}) {
    const { cacheKey = '', ttl = 0, signal, priority = 'normal' } = options;
    if (signal?.aborted) return Promise.reject(abortError());
    const key = cacheKey || `${query}:${JSON.stringify(variables)}`;
    if (cacheKey) {
        const cached = cacheGet(cacheKey);
        if (cached) return Promise.resolve(cached);
    }
    const existing = aniJobs.get(key);
    if (existing) return joinAniJob(existing, signal, priority);

    const job = { key, rank: ANI_PRIORITY_RANK.normal, seq: ++aniJobSeq, controller: new AbortController(), liveSignals: 0, pinned: false, queued: true };
    job.run = async jobSignal => {
        job.queued = false;
        const stale = cacheKey ? cacheGetStale(cacheKey) : null;
        let response;
        try {
            response = await fetch(ANILIST_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ query, variables }),
                signal: jobSignal,
            });
            updateAniRateState(response);
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            if (stale) return stale;
            throw new AniListError('AniList is temporarily unreachable. Cached pages will continue to work when available.');
        }

        let payload = null;
        try { payload = await response.json(); } catch {}
        if (response.status === 429) {
            if (stale) return stale;
            throw new AniListError('AniList is temporarily rate-limited. Please wait about a minute before requesting new uncached data.', 429);
        }
        if (!response.ok || payload?.errors?.length) {
            if (stale && response.status >= 500) return stale;
            const message = payload?.errors?.map(error => error.message).join('; ') || `AniList request failed (${response.status}).`;
            throw new AniListError(message, response.status, payload?.errors || null);
        }
        if (cacheKey && ttl) cacheSet(cacheKey, payload.data, ttl);
        return payload.data;
    };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; })
        .finally(() => { if (aniJobs.get(key) === job) aniJobs.delete(key); });
    aniJobs.set(key, job);
    aniPending.push(job);
    const result = joinAniJob(job, signal, priority);
    pumpAniQueue();
    return result;
}

const MEDIA_CARD_FIELDS = `
    id idMal isAdult
    title { romaji english native }
    coverImage { medium large extraLarge color }
    bannerImage description(asHtml: false)
    averageScore meanScore popularity trending favourites
    format status episodes duration season seasonYear
    startDate { year month day }
    endDate { year month day }
    genres
    studios(isMain: true) { nodes { id name isAnimationStudio } }
`;

const MEDIA_DETAIL_FIELDS = `
    ${MEDIA_CARD_FIELDS}
    siteUrl source countryOfOrigin hashtag
    trailer { id site thumbnail }
    externalLinks { id url site type language color icon notes isDisabled }
    recommendations(sort: RATING_DESC, perPage: 50) { nodes { rating mediaRecommendation { id idMal isAdult title { romaji english native } coverImage { medium large extraLarge } averageScore format status episodes } } }
    staff(sort: RELEVANCE, perPage: 12) { edges { role node { id name { full native } image { large medium } primaryOccupations } } }
    rankings { rank type format year season allTime context }
    synonyms
    nextAiringEpisode { airingAt episode timeUntilAiring }
    characters(sort: [ROLE, RELEVANCE, ID], perPage: 18) {
        edges {
            role
            node { id name { full native } image { large medium } }
            voiceActors(sort: [RELEVANCE, ID]) {
                id
                languageV2
                name { full native }
                image { large medium }
            }
        }
    }
    relations {
        edges {
            relationType(version: 2)
            node {
                id idMal isAdult type format status episodes
                title { romaji english native }
                synonyms
                coverImage { medium large extraLarge }
                startDate { year month day }
            }
        }
    }
`;

function mediaPageQuery(extraVariables = '', extraArguments = '') {
    return `query ($page: Int!, $perPage: Int!${extraVariables}) {
        Page(page: $page, perPage: $perPage) {
            pageInfo { total currentPage lastPage hasNextPage perPage }
            media(type: ANIME${extraArguments}) { ${MEDIA_CARD_FIELDS} }
        }
    }`;
}

function adultArgument() { return adultContentEnabled ? '' : ', isAdult: false'; }

/* "Hide shows I've seen" (Settings > Content settings).
   Anything on your MyAnimeList list that you've started (watching, completed, on hold,
   dropped) is left out of Top Rated, Discover and recommendations. Trending, search,
   the seasonal chart and the schedule still show everything. AniList leaves them out
   of each page (so pages stay full); the same check runs again in the page as a backstop. */
const HIDE_SEEN_KEY = 'anizone:hide-seen:v1';
const SEEN_STATUSES = new Set(['watching', 'completed', 'on_hold', 'dropped']);
let hideSeenEnabled = (() => { try { return localStorage.getItem(HIDE_SEEN_KEY) === 'true'; } catch { return false; } })();
let seenFilterOnServer = true;   // switched off if AniList ever rejects the list of IDs
let lastSeenKey = '';
const isSeenEntry = entry => Boolean(entry) && (SEEN_STATUSES.has(entry.status) || Boolean(entry.rewatching));
function seenMalIds() {
    if (!hideSeenEnabled || typeof MalSync === 'undefined' || typeof MalSync.listEntries !== 'function') return [];
    return [...new Set(MalSync.listEntries().filter(isSeenEntry).map(entry => Number(entry.id)).filter(Boolean))].sort((a, b) => a - b);
}
function seenIdsKey(ids) {
    if (!ids.length) return '';
    let hash = 5381;
    for (const id of ids) hash = ((hash * 33) ^ id) >>> 0;
    return `${ids.length}-${hash.toString(36)}`;
}
// The IDs to send to AniList (empty when the setting is off or AniList can't take them).
function seenFilterIds() { return seenFilterOnServer ? seenMalIds() : []; }
function hasSeen(anime) {
    if (!hideSeenEnabled || !anime?.idMal || typeof MalSync === 'undefined' || typeof MalSync.entryFor !== 'function') return false;
    return isSeenEntry(MalSync.entryFor(anime.idMal));
}
function withoutSeen(list) { return hideSeenEnabled && Array.isArray(list) ? list.filter(anime => !hasSeen(anime)) : list; }
// AniList said no to idMal_not_in: stop sending it and rely on the in-page check.
function dropServerSeenFilter(error) {
    if (!seenFilterOnServer || !hideSeenEnabled || !(error instanceof AniListError) || error.status !== 400) return false;
    seenFilterOnServer = false;
    console.warn('AniList rejected the seen-shows filter; filtering in the page instead.');
    return true;
}
function formatVariable(value) {
    const map = { tv: 'TV', movie: 'MOVIE', ova: 'OVA', ona: 'ONA', special: 'SPECIAL' };
    return map[value] || null;
}
function statusVariable(value) {
    return ({ airing: 'RELEASING', complete: 'FINISHED', upcoming: 'NOT_YET_RELEASED' })[value] || null;
}
function minimumScore(value) { return value ? Number(value) : null; }

async function getTrending(page = 1, perPage = PAGE_SIZE, { signal, priority = 'interactive' } = {}) {
    const query = mediaPageQuery('', `, sort: TRENDING_DESC${adultArgument()}`);
    return aniRequest(query, { page, perPage }, { cacheKey: `trending:${adultContentEnabled}:${page}:${perPage}`, ttl: CACHE_TTL.trending, signal, priority });
}
async function getTopRated(page = 1, perPage = PAGE_SIZE, { signal, priority = 'interactive' } = {}) {
    const seen = seenFilterIds();
    const query = mediaPageQuery(seen.length ? ', $seen: [Int]' : '', `, sort: SCORE_DESC${seen.length ? ', idMal_not_in: $seen' : ''}${adultArgument()}`);
    const variables = seen.length ? { page, perPage, seen } : { page, perPage };
    return aniRequest(query, variables, { cacheKey: `top:${adultContentEnabled}:${page}:${perPage}${seen.length ? `:seen-${seenIdsKey(seen)}` : ''}`, ttl: CACHE_TTL.top, signal, priority });
}
function buildMediaPageRequest({ page = 1, perPage = PAGE_SIZE, filters = {}, sort = null, cachePrefix = 'media', ttl = CACHE_TTL.search, signal, priority = 'normal', excludeMal = [] } = {}) {
    const variableDefs = ['$page: Int!', '$perPage: Int!'];
    const mediaArgs = ['type: ANIME'];
    const variables = { page, perPage };

    const addVariable = (name, graphType, value, argument = name) => {
        if (value === null || value === undefined || value === '') return;
        variableDefs.push(`$${name}: ${graphType}`);
        mediaArgs.push(`${argument}: $${name}`);
        variables[name] = value;
    };

    addVariable('search', 'String', filters.search);
    addVariable('season', 'MediaSeason', filters.season ? String(filters.season).toUpperCase() : null);
    addVariable('seasonYear', 'Int', filters.year ? Number(filters.year) : null);
    if (filters.genre && ANILIST_GENRES.has(filters.genre)) {
        addVariable('genre', 'String', filters.genre);
    } else if (filters.genre) {
        addVariable('tag', 'String', filters.genre);
        addVariable('minimumTagRank', 'Int', TAG_MIN_RANK);
    }
    addVariable('format', 'MediaFormat', formatVariable(filters.type));
    addVariable('status', 'MediaStatus', statusVariable(filters.status));
    addVariable('minimumScore', 'Int', minimumScore(filters.rating), 'averageScore_greater');

    let adultValue = null;
    if (!adultContentEnabled) adultValue = false;
    else if (filters.adultMode === 'regular') adultValue = false;
    else if (filters.adultMode === 'adult') adultValue = true;
    addVariable('isAdult', 'Boolean', adultValue);
    if (excludeMal.length) addVariable('seen', '[Int]', excludeMal, 'idMal_not_in');

    if (sort) {
        variableDefs.push('$sort: [MediaSort]');
        mediaArgs.push('sort: $sort');
        variables.sort = Array.isArray(sort) ? sort : [sort];
    }

    const query = `query (${variableDefs.join(', ')}) {
        Page(page: $page, perPage: $perPage) {
            pageInfo { total currentPage lastPage hasNextPage perPage }
            media(${mediaArgs.join(', ')}) { ${MEDIA_CARD_FIELDS} }
        }
    }`;
    // The list of seen IDs can be long: the cache key holds a short fingerprint of it instead.
    const keyVariables = excludeMal.length ? { ...variables, seen: seenIdsKey(excludeMal) } : variables;
    const cacheKey = `${cachePrefix}:${adultContentEnabled}:${JSON.stringify(keyVariables)}`;
    return aniRequest(query, variables, { cacheKey, ttl, signal, priority });
}

async function getDiscover(page = 1, perPage = PAGE_SIZE, { signal, priority = 'interactive' } = {}) {
    return buildMediaPageRequest({
        page,
        perPage,
        filters: {
            season: selectedDiscoverSeason,
            year: selectedDiscoverYear,
            genre: selectedDiscoverGenre,
            type: selectedDiscoverType,
            status: selectedDiscoverStatus,
            rating: selectedDiscoverRating,
            adultMode: selectedDiscoverAdult,
        },
        sort: 'POPULARITY_DESC',
        excludeMal: seenFilterIds(),
        cachePrefix: 'discover',
        ttl: CACHE_TTL.discover,
        signal,
        priority,
    });
}

async function searchAnime(queryText, page = 1, perPage = PAGE_SIZE, filters = {}, signal) {
    const requestedSort = ({ popularity: 'POPULARITY_DESC', score: 'SCORE_DESC', start_date: 'START_DATE_DESC' })[filters.order];
    // Keep title relevance as the default even when format/status/score filters are active.
    // Explicit user-selected sorting still overrides relevance.
    const sort = requestedSort || 'SEARCH_MATCH';
    return buildMediaPageRequest({
        page,
        perPage,
        filters: {
            search: queryText,
            genre: filters.genre,
            year: filters.year,
            season: filters.season,
            type: filters.type,
            status: filters.status,
            rating: filters.rating,
            adultMode: adultContentEnabled ? filters.adultMode : 'regular',
        },
        sort,
        cachePrefix: 'search',
        ttl: CACHE_TTL.search,
        signal,
        priority: 'interactive',
    });
}

async function getStudioAnime(studioId, page = 1, perPage = PAGE_SIZE, filters = {}, { signal, priority = 'interactive' } = {}) {
    const sort = ({ popularity: 'POPULARITY_DESC', score: 'SCORE_DESC', start_date: 'START_DATE_DESC' })[filters.order] || 'POPULARITY_DESC';
    const query = `query ($id: Int!, $page: Int!, $perPage: Int!, $sort: [MediaSort]) {
        Studio(id: $id) {
            id name
            media(page: $page, perPage: $perPage, sort: $sort, isMain: true) {
                pageInfo { total currentPage lastPage hasNextPage perPage }
                nodes { ${MEDIA_CARD_FIELDS} }
            }
        }
    }`;
    const data = await aniRequest(query, {
        id: Number(studioId), page, perPage, sort: [sort],
    }, {
        cacheKey: `studio:${adultContentEnabled}:${studioId}:${page}:${perPage}:${sort}`,
        ttl: CACHE_TTL.studio,
        signal,
        priority,
    });

    let items = data.Studio?.media?.nodes || [];
    if (!adultContentEnabled) items = items.filter(item => !item.isAdult);
    const wantedFormat = formatVariable(filters.type);
    const wantedStatus = statusVariable(filters.status);
    const scoreFloor = minimumScore(filters.rating);
    if (wantedFormat) items = items.filter(item => item.format === wantedFormat);
    if (wantedStatus) items = items.filter(item => item.status === wantedStatus);
    if (scoreFloor) items = items.filter(item => Number(item.averageScore || 0) >= scoreFloor);

    return {
        studioName: data.Studio?.name || '',
        Page: {
            pageInfo: data.Studio?.media?.pageInfo || { total: items.length, currentPage: page, lastPage: page, hasNextPage: false, perPage },
            media: items,
        },
    };
}

async function findStudios(search, perPage = 5, signal) {
    // StudioSort does not support SEARCH_MATCH on all AniList deployments.
    // The search argument already ranks relevant matches well enough.
    const query = `query ($search: String!, $perPage: Int!) {
        Page(page: 1, perPage: $perPage) {
            studios(search: $search) { id name isAnimationStudio }
        }
    }`;
    return aniRequest(query, { search, perPage }, { signal });
}

async function getAnimeDetails(id, { signal, priority = 'interactive' } = {}) {
    const query = `query ($id: Int!) { Media(id: $id, type: ANIME) { ${MEDIA_DETAIL_FIELDS} } }`;
    return aniRequest(query, { id: Number(id) }, { cacheKey: `detail:v4:${id}`, ttl: CACHE_TTL.details, signal, priority });
}

function initImageLazyLoad() {
    const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const image = entry.target;
            image.addEventListener('load', () => image.classList.add('loaded'), { once: true });
            if (image.complete) image.classList.add('loaded');
            observer.unobserve(image);
        });
    });
    new MutationObserver(mutations => mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
        if (node.tagName === 'IMG') observer.observe(node);
        node.querySelectorAll?.('img').forEach(image => observer.observe(image));
    }))).observe(document.body, { childList: true, subtree: true });
}

/* ==========================================
   ROUTING
   Every view has its own #/ address, so pages can be shared, bookmarked,
   refreshed and reached with Back/Forward. Hash routes need no server
   configuration, which keeps the site working on GitHub Pages.

     #/                         Home
     #/anime/154587             Anime details
     #/search?q=frieren&page=2  Search results
     #/browse/trending          Trending | top | discover grids
     #/studio/11?name=Madhouse  Studio grid
     #/list  #/schedule  #/news
   ========================================== */
const VIEW_ROUTES = Object.freeze({
    'view-home': '#/',
    'view-history': '#/list',
    'view-schedule': '#/schedule',
    'view-seasonal': '#/seasonal',
    'view-news': '#/news',
    'view-profile': '#/profile',
});
const BROWSE_TARGETS = new Set(['trending', 'top', 'discover']);
const BROWSE_TITLES = Object.freeze({ trending: 'Trending Now', top: 'Top Rated', discover: 'Discover' });
const SITE_TITLE = 'AniZone';
const scrollMemory = new Map();
let lastKnownScrollY = 0;
let currentEntryKey = null;
let currentEntryDepth = 0;
let entryKeyCounter = 0;
let pendingScrollRestore = null;

function routeHash(path, params = {}) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') return;
        if (key === 'page' && Number(value) <= 1) return;
        query.set(key, String(value));
    });
    const queryString = query.toString();
    return `#${path}${queryString ? `?${queryString}` : ''}`;
}
function animeHash(id) { return routeHash(`/anime/${Number(id)}`); }
function studioHash(id, name = '', page = 1) { return routeHash(`/studio/${Number(id)}`, { name, page }); }

function parseRoute(hash = location.hash) {
    const raw = String(hash || '').replace(/^#\/?/, '');
    const queryIndex = raw.indexOf('?');
    const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
    const params = new URLSearchParams(queryIndex === -1 ? '' : raw.slice(queryIndex + 1));
    let segments;
    try { segments = path.split('/').filter(Boolean).map(decodeURIComponent); }
    catch { return { name: 'not-found' }; }
    const [section, id] = segments;
    const page = Math.max(1, Number.parseInt(params.get('page'), 10) || 1);
    const numericId = /^\d+$/.test(id || '') ? Number(id) : null;

    if (!section) return { name: 'home' };
    if (section === 'anime' && numericId) return { name: 'anime', id: numericId };
    if (section === 'search') {
        const query = (params.get('q') || '').trim();
        return query ? { name: 'search', query, page, filters: readSearchFilters(params), from: (params.get('from') || '').trim().slice(0, 100) } : { name: 'not-found' };
    }
    if (section === 'browse' && BROWSE_TARGETS.has(id)) return { name: 'browse', target: id, page };
    if (section === 'studio' && numericId) return { name: 'studio', id: numericId, studioName: params.get('name') || '', page };
    // Stats and History used to be My List tabs; they now live on the Profile page.
    if (section === 'list' && segments.length === 1 && ['stats', 'history'].includes(params.get('tab'))) return { name: 'redirect', to: `#/profile?tab=${params.get('tab')}` };
    if (section === 'list' && segments.length === 1) return { name: 'list', tab: params.get('tab') || '', params: Object.fromEntries(params) };
    if (section === 'profile' && segments.length === 1) return { name: 'profile', tab: params.get('tab') || '' };
    if (section === 'news' && segments.length === 1) return { name: 'news', source: params.get('source') || 'all', page };
    if (section === 'schedule' && segments.length === 1) return { name: section };
    if (section === 'seasonal' && segments.length === 1) return { name: 'seasonal', params: Object.fromEntries(params) };
    // MyAnimeList sync (mal.js): login return and "open this MAL entry in AniZone".
    if (section === 'mal-callback') return { name: 'mal-callback', code: params.get('code') || '', state: params.get('state') || '', error: params.get('error') || '' };
    if (section === 'mal' && numericId) return { name: 'mal-anime', id: numericId };
    return { name: 'not-found' };
}

function readSearchFilters(params) {
    const filters = defaultSearchFilters();
    Object.entries(SEARCH_FILTER_PARAMS).forEach(([key, param]) => {
        const value = (params.get(param) || '').trim();
        if (!value) return;
        if (key === 'genre') filters.genre = value.slice(0, 60);
        else if (key === 'year') { if (/^\d{4}$/.test(value)) filters.year = value; }
        else if (SEARCH_FILTER_VALUES[key]?.includes(value)) filters[key] = value;
    });
    return filters;
}

function navigate(hash, { replace = false } = {}) {
    if (replace) {
        history.replaceState({ azDepth: currentEntryDepth }, '', hash);
        renderRoute();
    } else if (hash === location.hash) {
        // Same address (e.g. clicking Home while on Home): show it fresh from the top.
        renderRoute({ fresh: true });
    } else {
        location.hash = hash; // fires hashchange -> renderRoute
    }
}

// Gives each history entry a key so Back/Forward can restore its scroll position,
// and records how deep into the site the visitor is so our Back buttons never
// send someone who arrived from a shared link away from AniZone.
function trackHistoryEntry() {
    if (currentEntryKey) scrollMemory.set(currentEntryKey, lastKnownScrollY);
    const state = history.state;
    if (state?.azKey) {
        currentEntryKey = state.azKey;
        currentEntryDepth = Number(state.azDepth) || 0;
        return true;
    }
    const depth = Number.isFinite(state?.azDepth) ? state.azDepth : (currentEntryKey ? currentEntryDepth + 1 : 0);
    currentEntryKey = `${Date.now().toString(36)}-${++entryKeyCounter}`;
    currentEntryDepth = depth;
    history.replaceState({ azKey: currentEntryKey, azDepth: depth }, '', location.href);
    return false;
}

function goBack() {
    if (currentEntryDepth > 0) history.back();
    else navigate('#/', { replace: true });
}

function setPageTitle(text = '') {
    document.title = text ? `${text} · ${SITE_TITLE}` : SITE_TITLE;
}

function showView(targetViewId) {
    views.forEach(view => view.classList.toggle('hidden', view.id !== targetViewId));
    navButtons.forEach(button => button.classList.toggle('active', button.dataset.tab === targetViewId));
    if (pendingScrollRestore == null) scrollPageToTop();
}

function restorePendingScroll() {
    if (pendingScrollRestore == null) return;
    const top = pendingScrollRestore;
    pendingScrollRestore = null;
    requestAnimationFrame(() => window.scrollTo({ top, left: 0, behavior: 'instant' }));
}

function closeTransientPanels() {
    document.getElementById('va-modal')?.classList.add('hidden');
    document.getElementById('detail-preferences-panel')?.classList.add('hidden');
    suggestionsDropdown?.classList.add('hidden');
    const hamburger = document.getElementById('hamburger-btn');
    hamburger?.setAttribute('aria-expanded', 'false');
    hamburger?.classList.remove('open');
    document.getElementById('nav-menu-panel')?.classList.remove('open-panel');
}

function renderRoute({ fresh = false } = {}) {
    const route = parseRoute();
    if (route.name === 'not-found') { navigate('#/', { replace: true }); return; }
    if (route.name === 'redirect') { navigate(route.to, { replace: true }); return; }
    const revisit = trackHistoryEntry();
    pendingScrollRestore = revisit && !fresh ? (scrollMemory.get(currentEntryKey) ?? null) : null;
    closeTransientPanels();
    if (route.name !== 'anime') stopDetailActivity();
    if (!['search', 'browse', 'studio'].includes(route.name)) {
        cancelResultsRequest();
        if (resultsRequestToken) { resultsRequestToken++; showLoading(false); }
    }

    switch (route.name) {
        case 'home':
            setPageTitle();
            showView('view-home');
            if (homeDiscoverStale) {
                homeDiscoverStale = false;
                syncHomeDiscoverControls();
                refreshDiscoverRow();
            }
            restorePendingScroll();
            break;
        case 'list':
            setPageTitle('My List');
            showView('view-history');
            if (window.MalSync) MalSync.renderMyList(route.tab, route.params);
            restorePendingScroll();
            break;
        case 'profile':
            setPageTitle('Profile');
            showView('view-profile');
            if (window.MalSync?.renderProfile) MalSync.renderProfile(route.tab);
            else renderHistoryLogGrid();
            restorePendingScroll();
            break;
        case 'mal-callback':
            pendingScrollRestore = null;
            setPageTitle('My List');
            showView('view-history');
            MalSync.handleCallback(route);
            break;
        case 'mal-anime':
            pendingScrollRestore = null;
            MalSync.openByMalId(route.id);
            break;
        case 'schedule':
            pendingScrollRestore = null;
            setPageTitle('Schedule');
            showView('view-schedule');
            initScheduleView();
            break;
        case 'seasonal':
            setPageTitle('Seasonal Chart');
            showView('view-seasonal');
            renderSeasonal(route.params);
            restorePendingScroll();
            break;
        case 'news':
            pendingScrollRestore = null;
            setPageTitle('News');
            showView('view-news');
            newsSource = NEWS_SOURCE_IDS.has(route.source) ? route.source : 'all';
            loadNews(false, route.page);
            break;
        case 'anime':
            pendingScrollRestore = null;
            showAnimeDetails(route.id);
            break;
        default:
            showResultsRoute(route);
    }
}

function showResultsRoute(route) {
    if (route.name === 'search') {
        searchFilters = route.filters;
        currentSearchQuery = route.query;
        searchCorrectedFrom = route.from || '';
        currentActiveRowTarget = 'search';
        // The box is left empty after a search; the page title shows what was searched.
        if (searchInput && document.activeElement !== searchInput) searchInput.value = '';
        clearSearchBtn?.classList.add('hidden');
        setPageTitle(`Search: ${route.query}`);
    } else if (route.name === 'studio') {
        if (selectedStudioId !== route.id) selectedStudioName = '';
        selectedStudioId = route.id;
        selectedStudioName = route.studioName || selectedStudioName;
        currentActiveRowTarget = 'studio';
        setPageTitle(selectedStudioName || 'Studio');
    } else {
        currentActiveRowTarget = route.target;
        setPageTitle(BROWSE_TITLES[route.target]);
    }
    currentPage = route.page;
    configureResultsHeader(currentActiveRowTarget);
    showView('view-results');
    fetchExpandedGridData();
}

function resultsRouteHash(page = currentPage) {
    if (currentActiveRowTarget === 'search') {
        const params = { q: currentSearchQuery };
        Object.entries(SEARCH_FILTER_PARAMS).forEach(([key, param]) => {
            const value = searchFilters[key];
            if (value && !(key === 'order' && value === 'default')) params[param] = value;
        });
        if (searchCorrectedFrom && page <= 1) params.from = searchCorrectedFrom;
        return routeHash('/search', { ...params, page });
    }
    if (currentActiveRowTarget === 'studio') return studioHash(selectedStudioId, selectedStudioName, page);
    return routeHash(`/browse/${currentActiveRowTarget}`, { page });
}
// Keeps the address bar in step after a filter change without adding a history entry.
function syncResultsUrl() {
    const hash = resultsRouteHash(currentPage);
    if (hash !== location.hash) history.replaceState(history.state, '', hash);
}

function configureResultsHeader(target) {
    const title = document.getElementById('grid-title');
    const filters = document.getElementById('global-filters-container');
    const discoverFilters = document.getElementById('grid-discover-filters');
    if (target === 'trending' || target === 'top') {
        filters?.classList.add('hidden');
        discoverFilters?.classList.add('hidden');
        title.textContent = target === 'trending' ? 'Trending Now' : 'Top Rated';
    } else if (target === 'discover') {
        filters?.classList.add('hidden');
        discoverFilters?.classList.remove('hidden');
        title.textContent = `Discover · ${seasonLabel()}`;
        syncGridDiscoverFilters();
    } else if (target === 'search') {
        filters?.classList.add('hidden');
        discoverFilters?.classList.remove('hidden');
        title.textContent = `Search: “${currentSearchQuery}”`;
        syncGridDiscoverFilters();
    } else {
        filters?.classList.remove('hidden');
        discoverFilters?.classList.add('hidden');
        if (target === 'studio') title.textContent = selectedStudioName ? `Studio: ${selectedStudioName}` : 'Studio';
    }
}

function initNavigation() {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    window.addEventListener('scroll', () => { lastKnownScrollY = window.scrollY; }, { passive: true });
    window.addEventListener('hashchange', () => renderRoute());
    navButtons.forEach(button => button.addEventListener('click', () => {
        const route = VIEW_ROUTES[button.dataset.tab];
        if (route) navigate(route);
    }));
    document.getElementById('logo-btn')?.addEventListener('click', () => navigate('#/'));
    document.getElementById('shuffle-btn')?.addEventListener('click', triggerRandomShuffle);
    document.getElementById('grid-back-btn')?.addEventListener('click', goBack);
    document.getElementById('back-btn')?.addEventListener('click', goBack);
    const hamburger = document.getElementById('hamburger-btn');
    const panel = document.getElementById('nav-menu-panel');
    const closeMenu = () => {
        if (!panel?.classList.contains('open-panel')) return;
        hamburger?.setAttribute('aria-expanded', 'false');
        hamburger?.classList.remove('open');
        panel.classList.remove('open-panel');
    };
    let openedAtY = 0;
    hamburger?.addEventListener('click', event => {
        event.stopPropagation();
        const open = hamburger.getAttribute('aria-expanded') === 'true';
        hamburger.setAttribute('aria-expanded', String(!open));
        hamburger.classList.toggle('open', !open);
        panel?.classList.toggle('open-panel', !open);
        openedAtY = window.scrollY;
    });
    // The menu closes as soon as you start scrolling, tap outside it, or press Escape.
    window.addEventListener('scroll', () => { if (Math.abs(window.scrollY - openedAtY) > 8) closeMenu(); }, { passive: true });
    document.addEventListener('click', event => { if (!panel?.contains(event.target) && !hamburger?.contains(event.target)) closeMenu(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
}

function initPreferences() {
    const adultToggle = document.getElementById('adult-content-toggle');
    const languageSelect = document.getElementById('title-language-select');
    if (adultToggle) adultToggle.checked = adultContentEnabled;
    if (languageSelect) languageSelect.value = titleLanguage;

    adultToggle?.addEventListener('change', event => {
        adultContentEnabled = event.target.checked;
        localStorage.setItem('anizoneAdultEnabled', String(adultContentEnabled));
        updateContentSummary();
        if (adultContentEnabled && selectedDiscoverAdult === 'regular') selectedDiscoverAdult = 'both';
        if (!adultContentEnabled) selectedDiscoverAdult = 'regular';
        localStorage.setItem('anizoneDiscoverAdultMode', selectedDiscoverAdult);
        syncDiscoverAdultFilter();

        // Make one visible refresh per toggle. Disabling can be applied from the
        // current in-memory data immediately. Enabling needs one fresh AniList
        // request because adult titles were not included in the previous pool.
        const visiblePool = pool => adultContentEnabled ? pool : pool.filter(anime => !anime.isAdult);
        if (adultContentEnabled) {
            loadDashboardRows({ silent: true });
        } else {
            renderSliderTrack('row-trending', visiblePool(dashboardPools.trending));
            renderSliderTrack('row-top', visiblePool(dashboardPools.top));
            renderSliderTrack('row-discover', visiblePool(dashboardPools.discover));
            setupHeroBillboard(visiblePool(dashboardPools.trending));
        }

        if (currentActiveRowTarget && !document.getElementById('view-results')?.classList.contains('hidden')) fetchExpandedGridData();
        if (!document.getElementById('view-schedule')?.classList.contains('hidden') && scheduleInitialized) initScheduleView(true);
        window.MalSync?.refreshViews();
        scheduleForYouRows();
    });
    const hideSeenToggle = document.getElementById('hide-seen-toggle');
    if (hideSeenToggle) hideSeenToggle.checked = hideSeenEnabled;
    hideSeenToggle?.addEventListener('change', event => {
        hideSeenEnabled = event.target.checked;
        try { localStorage.setItem(HIDE_SEEN_KEY, String(hideSeenEnabled)); } catch { /* still applies for this visit */ }
        updateHideSeenHint();
        updateContentSummary();
        refreshForHideSeen();
    });
    updateHideSeenHint();
    updateContentSummary();
    languageSelect?.addEventListener('change', event => {
        titleLanguage = event.target.value;
        localStorage.setItem('anizoneTitleLanguage', titleLanguage);
        updateVisibleTitlesForLanguage();
        window.MalSync?.refreshViews();
    });
}


function updateVisibleTitlesForLanguage() {
    document.querySelectorAll('.anime-card').forEach(card => {
        const anime = card._animeData;
        const titleNode = card.querySelector('.anime-card-title');
        if (!anime || !titleNode) return;
        const title = displayTitle(anime);
        const alt = secondaryTitle(anime);
        titleNode.innerHTML = `<strong class="anime-card-name">${escapeHtml(title)}</strong>${alt ? `<span>${escapeHtml(alt)}</span>` : ''}`;
        card.querySelector('.anime-card-link')?.setAttribute('title', alt ? `${title} (${alt})` : title);
        const removeButton = card.querySelector('.card-eraser-btn');
        if (removeButton) removeButton.setAttribute('aria-label', `Remove ${title} from history`);
    });
    if (heroSlides[heroSlideIndex]) renderHeroSlide(heroSlideIndex);
    if (currentDetailAnime && !document.getElementById('view-details')?.classList.contains('hidden')) {
        const primary = displayTitle(currentDetailAnime);
        const alternate = secondaryTitle(currentDetailAnime);
        const title = document.getElementById('detail-title');
        if (title) {
            title.innerHTML = `${escapeHtml(primary)}${alternate ? `<span class="detail-alt-title">${escapeHtml(alternate)}</span>` : ''}`;
            title.classList.toggle('long-title', primary.length > 45);
        }
        renderCastProfiles(currentCastEdges, false);
    }
    if (!document.getElementById('view-schedule')?.classList.contains('hidden') && scheduleInitialized) initScheduleView(true);
}

function initSearchEngine() {
    const trigger = document.getElementById('search-icon-trigger');
    const wrapper = trigger?.parentElement;
    const collapseSearch = () => {
        wrapper?.classList.remove('open');
        suggestionsDropdown?.classList.add('hidden');
    };
    trigger?.addEventListener('click', event => {
        event.stopPropagation();
        wrapper?.classList.toggle('open');
        if (wrapper?.classList.contains('open')) searchInput?.focus();
    });
    let timer;
    searchInput?.addEventListener('input', () => {
        const query = searchInput.value.trim();
        clearSearchBtn?.classList.toggle('hidden', !query);
        suggestionsDropdown?.classList.add('hidden');
        clearTimeout(timer);
        suggestionController?.abort();
        if (query.length >= 3) timer = setTimeout(() => fetchSearchSuggestions(query), 550);
    });
    searchInput?.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        clearTimeout(timer);   // a suggestion lookup waiting to start must not reopen the list
        suggestionController?.abort();
        suggestionsDropdown?.classList.add('hidden');
        const query = searchInput.value.trim();
        if (query) {
            executeGlobalSearch(query, 1);
            collapseSearch();
            searchInput.blur();
            searchInput.value = '';
            clearSearchBtn?.classList.add('hidden');
        }
    });
    clearSearchBtn?.addEventListener('click', () => {
        searchInput.value = '';
        clearSearchBtn.classList.add('hidden');
        suggestionsDropdown.classList.add('hidden');
        searchInput.focus();
    });
    document.addEventListener('click', event => {
        if (!wrapper?.contains(event.target)) collapseSearch();
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') collapseSearch(); });
    document.querySelectorAll('.nav-btn, #logo-btn, #shuffle-btn').forEach(control => control.addEventListener('click', collapseSearch));
    window.addEventListener('scroll', () => { if (wrapper?.classList.contains('open') && document.activeElement !== searchInput) collapseSearch(); }, { passive: true });
}
async function fetchSearchSuggestions(queryText) {
    suggestionController?.abort();
    suggestionController = new AbortController();
    const query = `query ($search: String!, $mediaCount: Int!, $studioCount: Int!) {
        anime: Page(page: 1, perPage: $mediaCount) {
            media(type: ANIME, search: $search, sort: SEARCH_MATCH${adultArgument()}) { ${MEDIA_CARD_FIELDS} }
        }
        studios: Page(page: 1, perPage: $studioCount) {
            studios(search: $search) { id name isAnimationStudio }
        }
    }`;
    try {
        const data = await aniRequest(query, { search: queryText, mediaCount: 6, studioCount: 3 }, {
            cacheKey: `suggestions:${adultContentEnabled}:${queryText.toLowerCase()}`,
            ttl: 30 * 60 * 1000,
            signal: suggestionController.signal,
            priority: 'interactive',
        });
        const anime = data?.anime?.media || [];
        const studios = data?.studios?.studios || [];
        if (!anime.length && !studios.length) return;
        // Only while you're still typing this in the box (not after you've searched).
        if (document.activeElement !== searchInput || searchInput.value.trim() !== queryText) return;
        suggestionsDropdown.innerHTML = '';
        anime.forEach(item => {
            const row = document.createElement('div');
            row.className = 'suggestion-item';
            const alt = secondaryTitle(item);
            row.innerHTML = `<span><strong>${escapeHtml(displayTitle(item))}</strong>${alt ? `<small>${escapeHtml(alt)}</small>` : ''}</span><span class="sug-score"${item.averageScore ? ' title="AniList score"' : ''}>${item.averageScore ? `${Math.round(item.averageScore)}%` : '–'}</span>`;
            row.addEventListener('click', () => { suggestionsDropdown.classList.add('hidden'); viewSingleAnime(item.id); });
            suggestionsDropdown.appendChild(row);
        });
        studios.forEach(studio => {
            const row = document.createElement('div');
            row.className = 'suggestion-item studio-suggestion';
            row.innerHTML = `<span><strong>${escapeHtml(studio.name)}</strong><small>Studio</small></span><span class="sug-score">Studio</span>`;
            row.addEventListener('click', () => { suggestionsDropdown.classList.add('hidden'); viewStudioGrid(studio.id, studio.name); });
            suggestionsDropdown.appendChild(row);
        });
        suggestionsDropdown.classList.remove('hidden');
    } catch (error) {
        if (error.name !== 'AbortError') console.warn('Suggestions paused:', error.message);
    }
}

async function getDashboardBundle({ priority = 'interactive' } = {}) {
    const discoverDefs = [];
    const discoverArgs = [];
    const variables = { perPage: 20 };
    const addDiscover = (name, type, value, argument = name) => {
        discoverDefs.push(`, $${name}: ${type}`);
        discoverArgs.push(`, ${argument}: $${name}`);
        variables[name] = value;
    };
    if (selectedDiscoverSeason) addDiscover('season', 'MediaSeason', selectedDiscoverSeason);
    if (selectedDiscoverYear) addDiscover('seasonYear', 'Int', Number(selectedDiscoverYear));
    if (selectedDiscoverGenre && ANILIST_GENRES.has(selectedDiscoverGenre)) addDiscover('genre', 'String', selectedDiscoverGenre);
    else if (selectedDiscoverGenre) {
        addDiscover('tag', 'String', selectedDiscoverGenre);
        addDiscover('minimumTagRank', 'Int', TAG_MIN_RANK);
    }
    // Trending always shows everything; Top Rated and Discover can leave out shows you've seen.
    const seen = seenFilterIds();
    if (seen.length) variables.seen = seen;
    lastSeenKey = seenIdsKey(seenMalIds());
    const seenDef = seen.length ? ', $seen: [Int]' : '';
    const seenArg = seen.length ? ', idMal_not_in: $seen' : '';
    const query = `query ($perPage: Int!${discoverDefs.join('')}${seenDef}) {
        trending: Page(page: 1, perPage: $perPage) { media(type: ANIME, sort: TRENDING_DESC${adultArgument()}) { ${MEDIA_CARD_FIELDS} } }
        top: Page(page: 1, perPage: $perPage) { media(type: ANIME, sort: SCORE_DESC${seenArg}${adultArgument()}) { ${MEDIA_CARD_FIELDS} } }
        discover: Page(page: 1, perPage: $perPage) { media(type: ANIME, sort: POPULARITY_DESC${discoverArgs.join('')}${seenArg}${adultArgument()}) { ${MEDIA_CARD_FIELDS} } }
    }`;
    try {
        return await aniRequest(query, variables, {
            cacheKey: `dashboard:v2:${adultContentEnabled}:${selectedDiscoverSeason}:${selectedDiscoverYear}:${selectedDiscoverGenre}${seen.length ? `:seen-${seenIdsKey(seen)}` : ''}`,
            ttl: CACHE_TTL.trending,
            priority,
        });
    } catch (error) {
        if (seen.length && dropServerSeenFilter(error)) return getDashboardBundle({ priority });
        throw error;
    }
}

async function loadDashboardRows({ silent = false } = {}) {
    if (!silent) showLoading(true);
    try {
        const data = await getDashboardBundle({ priority: parseRoute().name === 'home' ? 'interactive' : 'background' });
        dashboardPools.trending = data?.trending?.media || [];
        dashboardPools.top = data?.top?.media || [];
        dashboardPools.discover = data?.discover?.media || [];
        renderSliderTrack('row-trending', dashboardPools.trending);
        renderSliderTrack('row-top', dashboardPools.top);
        renderSliderTrack('row-discover', dashboardPools.discover);
        setupHeroBillboard(dashboardPools.trending);
    } catch (error) {
        renderRowError('row-trending', error, loadDashboardRows);
        renderRowError('row-top', error, loadDashboardRows);
        renderRowError('row-discover', error, loadDashboardRows);
    } finally {
        if (!silent) showLoading(false);
    }
}
function renderRowError(trackId, error, retry) {
    console.error(trackId, error);
    const track = document.getElementById(trackId);
    if (!track) return;
    track.innerHTML = `<div class="empty-state api-error">Unable to load this section.<button class="inline-retry-btn">Retry</button></div>`;
    track.querySelector('.inline-retry-btn')?.addEventListener('click', retry);
}
const SEEN_FILTERED_ROWS = new Set(['row-top', 'row-discover', 'row-for-you']);
function renderSliderTrack(trackId, dataset) {
    const track = document.getElementById(trackId);
    if (!track) return;
    if (SEEN_FILTERED_ROWS.has(trackId)) dataset = withoutSeen(dataset);
    track.innerHTML = '';
    if (!dataset?.length) {
        track.innerHTML = '<div class="empty-state">No matching anime found.</div>';
        return;
    }
    dataset.forEach(anime => track.appendChild(createAnimeCard(anime)));
}
function createAnimeCard(anime, isHistory = false) {
    const card = document.createElement('div');
    card.className = 'anime-card';
    card._animeData = anime;
    const title = displayTitle(anime);
    const alt = secondaryTitle(anime);
    // A real link: reachable with Tab, opens in a new tab with middle-click or long-press,
    // and its address can be copied and shared. The poster is decorative because the
    // title text inside the link already names it.
    card.innerHTML = `<a class="anime-card-link" href="${animeHash(anime.id)}" title="${escapeHtml(alt ? `${title} (${alt})` : title)}"><img src="${escapeHtml(imageUrl(anime))}" alt="" loading="lazy">${anime.isAdult ? '<span class="adult-card-badge">18+</span>' : ''}<div class="anime-card-overlay"></div><div class="anime-card-title"><strong class="anime-card-name">${escapeHtml(title)}</strong>${alt ? `<span>${escapeHtml(alt)}</span>` : ''}</div></a>`;
    if (anime.isAdult) card.classList.add('adult-card');
    if (isHistory) {
        // Kept outside the link: a button nested inside a link is invalid HTML.
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'card-eraser-btn';
        button.title = 'Remove from history';
        button.setAttribute('aria-label', `Remove ${title} from history`);
        button.textContent = '✕';
        button.addEventListener('click', () => removeAnimeFromHistoryLog(anime.id));
        card.appendChild(button);
    }
    return card;
}

/* ==========================================
   FOR YOU (home): recommendations from your MyAnimeList list
   Shows you scored 8+ (or, with few scores, your recent completed and watching
   shows) are looked up on AniList, whose users vote on "if you liked this, watch
   that". Everything already on your list is skipped. One AniList request,
   kept for 12 hours for the same set of shows.
   ========================================== */
const FOR_YOU_SEEDS = 8;
const FOR_YOU_TTL = 12 * 60 * 60 * 1000;
const FOR_YOU_CARD_FIELDS = 'id idMal isAdult status format episodes seasonYear averageScore popularity title { romaji english native } coverImage { large extraLarge }';
let forYouToken = 0;
let forYouTimer = null;

function forYouSeeds(entries) {
    const visible = entries.filter(entry => adultContentEnabled || entry.nsfw !== 'black');
    const byScoreThenRecent = (a, b) => (b.score - a.score) || String(b.updatedAt).localeCompare(String(a.updatedAt));
    let seeds = visible.filter(entry => entry.score >= 8 && entry.status !== 'plan_to_watch').sort(byScoreThenRecent);
    if (seeds.length < 3) {
        const extra = visible.filter(entry => ['completed', 'watching'].includes(entry.status) && !seeds.includes(entry) && (!entry.score || entry.score >= 6))
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        seeds = seeds.concat(extra);
    }
    return seeds.slice(0, FOR_YOU_SEEDS);
}
function forYouRowHtml(id, heading) {
    return `<div class="content-row for-you-row"><div class="row-header"><h2>${escapeHtml(heading)}</h2></div><div class="slider-container"><button class="slider-arrow left-arrow" type="button" aria-label="Scroll left">‹</button><div class="slider-track" id="${id}"></div><button class="slider-arrow right-arrow" type="button" aria-label="Scroll right">›</button></div></div>`;
}
function wireSliderArrows(root) {
    root.querySelectorAll('.slider-container').forEach(container => {
        const track = container.querySelector('.slider-track');
        container.querySelector('.left-arrow')?.addEventListener('click', () => track?.scrollBy({ left: -500, behavior: 'smooth' }));
        container.querySelector('.right-arrow')?.addEventListener('click', () => track?.scrollBy({ left: 500, behavior: 'smooth' }));
    });
}
function scheduleForYouRows() {
    clearTimeout(forYouTimer);
    forYouTimer = setTimeout(loadForYouRows, 300);
}
async function loadForYouRows() {
    const host = document.getElementById('for-you-rows');
    if (!host) return;
    const token = ++forYouToken;
    const entries = malSyncHas('listEntries') ? MalSync.listEntries() : [];
    const seeds = forYouSeeds(entries);
    if (!seeds.length) { host.innerHTML = ''; host.dataset.key = ''; return; }
    const listed = new Set(entries.map(entry => entry.id));
    const seedKey = seeds.map(seed => seed.id).sort((a, b) => a - b).join(',');
    if (!host.dataset.key) host.innerHTML = forYouRowHtml('row-for-you', 'Recommended for you').replace('<div class="slider-track" id="row-for-you"></div>', '<div class="slider-track" id="row-for-you"><div class="spinner"></div></div>');

    const query = `query {\n${seeds.map((seed, i) => `  s${i}: Media(idMal: ${Number(seed.id)}, type: ANIME) { id idMal title { romaji english native } recommendations(sort: RATING_DESC, perPage: 10) { nodes { rating mediaRecommendation { ${FOR_YOU_CARD_FIELDS} } } } }`).join('\n')}\n}`;
    let data;
    try {
        data = await aniRequest(query, {}, { cacheKey: `foryou:v1:${seedKey}`, ttl: FOR_YOU_TTL, priority: 'background' });
    } catch (error) {
        if (token !== forYouToken) return;
        if (!host.dataset.key) host.innerHTML = '';   // quietly leave the section out
        console.warn('Recommendations unavailable:', error.message);
        return;
    }
    if (token !== forYouToken) return;

    // Score each suggestion: how much you liked the show it came from, and how many
    // AniList users agree it's a good follow-up.
    const pool = new Map();
    seeds.forEach((seed, i) => {
        const media = data?.[`s${i}`];
        if (!media) return;
        const liked = (seed.score || 7) - 5;
        for (const node of media.recommendations?.nodes || []) {
            const rec = node?.mediaRecommendation;
            if (!rec?.id || (rec.idMal && listed.has(rec.idMal)) || rec.status === 'NOT_YET_RELEASED') continue;
            if (rec.isAdult && !adultContentEnabled) continue;
            const weight = liked * (1 + Math.log1p(Math.max(0, node.rating || 0)));
            const item = pool.get(rec.id) || { anime: rec, weight: 0 };
            item.weight += weight;
            pool.set(rec.id, item);
        }
    });
    const top = [...pool.values()].sort((a, b) => b.weight - a.weight).slice(0, 24).map(item => item.anime);

    if (!top.length) { host.innerHTML = ''; host.dataset.key = ''; return; }
    host.innerHTML = forYouRowHtml('row-for-you', 'Recommended for you');
    host.dataset.key = seedKey;
    wireSliderArrows(host);
    renderSliderTrack('row-for-you', top);
}

/* ==========================================
   SEASONAL CHART  (#/seasonal?season=fall&year=2026&format=TV&genre=Action&sort=score)
   Every anime starting in a season, like MyAnimeList's seasonal page, with
   format and genre filters and one-click "Plan to Watch".
   ========================================== */
// mal.js and app.js load separately, so a browser can briefly hold an older copy of
// one of them right after an update: check a feature exists before using it.
const malSyncHas = (name) => typeof MalSync !== 'undefined' && typeof MalSync[name] === 'function';
const SEASON_ORDER = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const SEASON_NAMES = { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' };
const SEASONAL_FORMATS = Object.freeze({ TV: 'TV', TV_SHORT: 'TV Short', MOVIE: 'Movie', ONA: 'ONA', OVA: 'OVA', SPECIAL: 'Special' });
const SEASONAL_SORTS = Object.freeze({ popularity: ['Most popular', 'POPULARITY_DESC'], score: ['Highest score', 'SCORE_DESC'], trending: ['Trending', 'TRENDING_DESC'], start: ['Start date', 'START_DATE'], title: ['Title', 'TITLE_ROMAJI'] });
const SEASONAL_PAGE_SIZE = 50;
const MAL_MEDIA_TYPE = { TV: 'tv', TV_SHORT: 'tv', MOVIE: 'movie', OVA: 'ova', ONA: 'ona', SPECIAL: 'special', MUSIC: 'music' };
const MAL_AIRING = { RELEASING: 'currently_airing', FINISHED: 'finished_airing', NOT_YET_RELEASED: 'not_yet_aired' };
let seasonalView = null;
let seasonalItems = [];
let seasonalToken = 0;
let seasonalHasMore = false;
let seasonalTotal = 0;
let seasonalControlsReady = false;

function seasonOf(date = new Date()) {
    return { season: SEASON_ORDER[Math.floor(date.getMonth() / 3)], year: date.getFullYear() };
}
function shiftSeason({ season, year }, by) {
    const index = SEASON_ORDER.indexOf(season) + by;
    return { season: SEASON_ORDER[((index % 4) + 4) % 4], year: year + Math.floor(index / 4) };
}
const chartSeasonLabel = ({ season, year }) => `${SEASON_NAMES[season]} ${year}`;
function readSeasonalView(params = {}) {
    const now = seasonOf();
    const season = String(params.season || '').toUpperCase();
    const year = Number(params.year);
    return {
        season: SEASON_ORDER.includes(season) ? season : now.season,
        year: Number.isInteger(year) && year >= 1970 && year <= now.year + 2 ? year : now.year,
        format: SEASONAL_FORMATS[params.format] ? params.format : '',
        genre: ANILIST_GENRES.has(params.genre) ? params.genre : '',
        sort: SEASONAL_SORTS[params.sort] ? params.sort : 'popularity',
        hideListed: params.hide === 'listed',
    };
}
function seasonalHash(view = seasonalView) {
    const now = seasonOf();
    const isNow = view.season === now.season && view.year === now.year;
    return routeHash('/seasonal', {
        season: isNow ? '' : view.season.toLowerCase(), year: isNow ? '' : view.year,
        format: view.format, genre: view.genre, sort: view.sort === 'popularity' ? '' : view.sort, hide: view.hideListed ? 'listed' : '',
    });
}
function setSeasonalView(changes) {
    navigate(seasonalHash({ ...seasonalView, ...changes }));
}

function initSeasonalControls() {
    if (seasonalControlsReady) return;
    seasonalControlsReady = true;
    const format = document.getElementById('seasonal-format');
    const genre = document.getElementById('seasonal-genre');
    const sort = document.getElementById('seasonal-sort');
    const year = document.getElementById('seasonal-year');
    if (year) {
        const latest = seasonOf().year + 2;
        year.innerHTML = Array.from({ length: latest - 1969 }, (_, i) => latest - i).map(y => `<option value="${y}">${y}</option>`).join('');
        enhanceSelect(year);
        year.addEventListener('change', () => { if (Number(year.value) !== seasonalView.year) setSeasonalView({ year: Number(year.value) }); });
    }
    if (format) format.innerHTML = '<option value="">All formats</option>' + Object.entries(SEASONAL_FORMATS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    if (genre) genre.innerHTML = '<option value="">All genres</option>' + [...ANILIST_GENRES].filter(g => g !== 'Hentai').map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
    if (sort) sort.innerHTML = Object.entries(SEASONAL_SORTS).map(([value, [label]]) => `<option value="${value}">${label}</option>`).join('');
    [format, genre, sort].forEach(select => select && enhanceSelect(select));
    format?.addEventListener('change', () => { if (format.value !== seasonalView.format) setSeasonalView({ format: format.value }); });
    genre?.addEventListener('change', () => { if (genre.value !== seasonalView.genre) setSeasonalView({ genre: genre.value }); });
    sort?.addEventListener('change', () => { if (sort.value !== seasonalView.sort) setSeasonalView({ sort: sort.value }); });
    document.getElementById('seasonal-hide-listed')?.addEventListener('click', () => setSeasonalView({ hideListed: !seasonalView.hideListed }));
    document.getElementById('season-more-btn')?.addEventListener('click', () => loadSeasonalPage(Math.floor(seasonalItems.length / SEASONAL_PAGE_SIZE) + 1));
    if (malSyncHas('subscribe')) MalSync.subscribe(() => { if (!document.getElementById('view-seasonal')?.classList.contains('hidden')) drawSeasonal(); });
}

function renderSeasonSwitch() {
    const seg = document.getElementById('season-seg');
    if (!seg || !seasonalView) return;
    const now = seasonOf();
    const same = (a, b) => a.season === b.season && a.year === b.year;
    seg.innerHTML = SEASON_ORDER.map(season => {
        const target = { season, year: seasonalView.year };
        const active = season === seasonalView.season;
        const live = same(target, now);
        return `<a class="season-seg-btn${active ? ' active' : ''}" href="${seasonalHash({ ...seasonalView, ...target })}"${active ? ' aria-current="page"' : ''}${live ? ' title="The current season"' : ''}>${SEASON_NAMES[season]}${live ? '<i class="season-live" aria-label="(now)"></i>' : ''}</a>`;
    }).join('');
    const prev = document.getElementById('season-prev');
    const next = document.getElementById('season-next');
    if (prev) prev.href = seasonalHash({ ...seasonalView, ...shiftSeason(seasonalView, -1) });
    if (next) next.href = seasonalHash({ ...seasonalView, ...shiftSeason(seasonalView, 1) });
    const year = document.getElementById('seasonal-year');
    if (year) {
        if (![...year.options].some(option => Number(option.value) === seasonalView.year)) year.insertAdjacentHTML('beforeend', `<option value="${seasonalView.year}">${seasonalView.year}</option>`);
        year.value = String(seasonalView.year);
        year._azRebuild?.();
    }
    const back = document.getElementById('season-now');
    if (back) {
        back.href = seasonalHash({ ...seasonalView, ...now });
        back.classList.toggle('hidden', same(seasonalView, now));
    }
    // Is this season over, on now, or still to come?
    const when = document.getElementById('season-when');
    if (when) {
        const order = (v) => v.year * 4 + SEASON_ORDER.indexOf(v.season);
        const diff = order(seasonalView) - order(now);
        when.textContent = diff === 0 ? 'Airing now' : diff > 0 ? 'Upcoming' : 'Past season';
        when.className = `season-when ${diff === 0 ? 'now' : diff > 0 ? 'upcoming' : 'past'}`;
    }
}

function renderSeasonal(params = {}) {
    initSeasonalControls();
    const next = readSeasonalView(params);
    const sameQuery = seasonalView && ['season', 'year', 'format', 'genre', 'sort'].every(key => seasonalView[key] === next[key]);
    seasonalView = next;
    const set = (id, value) => { const select = document.getElementById(id); if (select) { select.value = value; select._azRebuild?.(); } };
    set('seasonal-format', next.format); set('seasonal-genre', next.genre); set('seasonal-sort', next.sort);
    const hide = document.getElementById('seasonal-hide-listed');
    if (hide) {
        const available = typeof MalSync !== 'undefined' && MalSync.isLoggedIn();
        hide.classList.toggle('hidden', !available);
        hide.setAttribute('aria-pressed', String(next.hideListed));
    }
    const subtitle = document.getElementById('seasonal-subtitle');
    if (subtitle) subtitle.textContent = `Anime starting in ${chartSeasonLabel(next)}`;
    renderSeasonSwitch();
    if (sameQuery && seasonalItems.length) { drawSeasonal(); return; }
    seasonalItems = [];
    loadSeasonalPage(1);
}

async function loadSeasonalPage(page, { retried = false } = {}) {
    const grid = document.getElementById('season-grid');
    const more = document.getElementById('season-more-btn');
    if (!grid) return;
    const token = ++seasonalToken;
    const view = seasonalView;
    if (page === 1) { grid.innerHTML = '<div class="spinner"></div>'; setSeasonalStatus(''); }
    if (more) { more.disabled = true; more.textContent = 'Loading…'; }
    // Filters that don't apply are left out of the request entirely: AniList reads
    // an empty value (null) as "must be empty", which matches nothing.
    const genreArg = view.genre ? ', genre: $genre' : '';
    const adultArg = adultContentEnabled ? '' : ', isAdult: false';
    const query = `query ($page: Int, $perPage: Int, $season: MediaSeason, $year: Int, $formats: [MediaFormat], $sort: [MediaSort]${view.genre ? ', $genre: String' : ''}) {
        Page(page: $page, perPage: $perPage) {
            pageInfo { total hasNextPage }
            media(type: ANIME, season: $season, seasonYear: $year, format_in: $formats, sort: $sort${genreArg}${adultArg}) {
                id idMal isAdult format episodes duration status source genres averageScore popularity
                title { romaji english native } coverImage { large extraLarge color }
                startDate { year month day } description(asHtml: false)
                studios(isMain: true) { nodes { name } }
                nextAiringEpisode { episode airingAt }
            }
        }
    }`;
    const variables = {
        page, perPage: SEASONAL_PAGE_SIZE, season: view.season, year: view.year,
        formats: view.format ? [view.format] : Object.keys(SEASONAL_FORMATS),
        sort: view.sort === 'popularity' ? ['POPULARITY_DESC'] : [SEASONAL_SORTS[view.sort][1], 'POPULARITY_DESC'],
        ...(view.genre ? { genre: view.genre } : {}),
    };
    const cacheKey = `seasonal:v2:${view.season}:${view.year}:${view.format}:${view.genre}:${view.sort}:${adultContentEnabled}:${page}`;
    try {
        const data = await aniRequest(query, variables, { cacheKey, ttl: 30 * 60 * 1000, priority: 'interactive' });
        if (token !== seasonalToken) return;
        const media = data?.Page?.media || [];
        if (page === 1 && !media.length) {
            // An empty season is never worth keeping: AniList sometimes answers with
            // nothing when it's busy. Forget it, and ask once more before saying so.
            try { localStorage.removeItem(CACHE_PREFIX + cacheKey); } catch {}
            if (!retried) { await delay(1500); if (token === seasonalToken) loadSeasonalPage(1, { retried: true }); return; }
        }
        const known = new Set(seasonalItems.map(item => item.id));
        seasonalItems = seasonalItems.concat(media.filter(item => !known.has(item.id)));
        seasonalHasMore = Boolean(data?.Page?.pageInfo?.hasNextPage);
        seasonalTotal = data?.Page?.pageInfo?.total || seasonalItems.length;
        drawSeasonal();
    } catch (error) {
        if (token !== seasonalToken) return;
        if (page === 1) {
            grid.innerHTML = `<div class="empty-state api-error">${escapeHtml(error.message || 'This season could not be loaded.')}<button class="inline-retry-btn" type="button">Retry</button></div>`;
            grid.querySelector('.inline-retry-btn')?.addEventListener('click', () => loadSeasonalPage(1));
        } else {
            setSeasonalStatus('More anime could not be loaded just now.');
        }
    } finally {
        if (token === seasonalToken && more) { more.disabled = false; more.textContent = 'Show more'; }
    }
}
function setSeasonalStatus(text) {
    const status = document.getElementById('seasonal-status');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('hidden', !text);
}

function seasonalAiringText(anime) {
    const next = anime.nextAiringEpisode;
    if (next?.airingAt) {
        const when = new Date(next.airingAt * 1000);
        const day = when.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return `Ep ${next.episode} airs ${day}, ${time}`;
    }
    const start = anime.startDate || {};
    if (anime.status === 'NOT_YET_RELEASED') {
        if (start.year && start.month && start.day) return `Starts ${new Date(start.year, start.month - 1, start.day).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
        if (start.year && start.month) return `Starts ${new Date(start.year, start.month - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' })}`;
        return 'Start date not announced';
    }
    if (anime.status === 'FINISHED') return 'Finished airing';
    return 'Airing';
}
const SOURCE_NAMES = { MANGA: 'Manga', LIGHT_NOVEL: 'Light novel', ORIGINAL: 'Original', VIDEO_GAME: 'Game', VISUAL_NOVEL: 'Visual novel', NOVEL: 'Novel', WEB_NOVEL: 'Web novel', WEB_MANGA: 'Web manga', OTHER: '' };
function compactCount(n) {
    if (!n) return '';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K`;
    return String(n);
}
function seasonalActionHtml(anime) {
    if (!anime.idMal) return '';
    if (!malSyncHas('entryFor') || !malSyncHas('addToPlanToWatch')) return '';
    const entry = MalSync.entryFor(anime.idMal);
    if (entry?.status) {
        const progress = entry.status === 'watching' && entry.watched ? ` · Ep ${entry.watched}` : '';
        return `<span class="season-on-list mal-status-${escapeHtml(entry.status)}"><i aria-hidden="true"></i>${escapeHtml(MalSync.statusLabel(entry.status))}${progress}</span>`;
    }
    return `<button type="button" class="season-ptw-btn" data-ptw="${anime.id}">+ Plan to Watch</button>`;
}
function seasonalCardHtml(anime) {
    const title = displayTitle(anime);
    const alt = secondaryTitle(anime);
    const studio = anime.studios?.nodes?.[0]?.name || '';
    const facts = [studio, anime.episodes ? `${anime.episodes} ep${anime.episodes === 1 ? '' : 's'}` : '', anime.duration && anime.format === 'MOVIE' ? `${anime.duration} min` : '', SOURCE_NAMES[anime.source] || ''].filter(Boolean).join(' · ');
    const synopsis = synopsisText(anime.description) || 'No synopsis yet.';
    const popularity = compactCount(anime.popularity);
    return `<article class="season-card${anime.isAdult ? ' adult-card' : ''}" data-anime-id="${anime.id}">
        <a class="season-card-poster" href="${animeHash(anime.id)}" tabindex="-1" aria-hidden="true"><img src="${escapeHtml(imageUrl(anime))}" alt="" loading="lazy" decoding="async"><span class="season-card-format">${escapeHtml(SEASONAL_FORMATS[anime.format] || formatFormat(anime.format))}</span></a>
        <div class="season-card-body">
            <a class="season-card-title" href="${animeHash(anime.id)}" title="${escapeHtml(alt ? `${title} (${alt})` : title)}">${escapeHtml(title)}</a>
            ${facts ? `<div class="season-card-meta">${escapeHtml(facts)}</div>` : ''}
            <div class="season-card-airing">${escapeHtml(seasonalAiringText(anime))}</div>
            ${anime.genres?.length ? `<div class="season-card-genres">${anime.genres.slice(0, 4).map(g => `<span>${escapeHtml(g)}</span>`).join('')}</div>` : ''}
            <p class="season-card-synopsis">${escapeHtml(synopsis)}</p>
            <div class="season-card-foot">
                <span class="season-card-stats">${anime.averageScore ? `<b title="AniList score">${anime.averageScore}%</b>` : '<b class="muted">No score yet</b>'}${popularity ? `<span title="${escapeHtml(`${anime.popularity.toLocaleString()} AniList users have it on their list`)}">${popularity} members</span>` : ''}</span>
                <span class="season-card-action" data-action-for="${anime.id}">${seasonalActionHtml(anime)}</span>
            </div>
        </div>
    </article>`;
}
function drawSeasonal() {
    const grid = document.getElementById('season-grid');
    const more = document.getElementById('season-more-btn');
    const count = document.getElementById('seasonal-count');
    if (!grid || !seasonalView) return;
    const loggedIn = typeof MalSync !== 'undefined' && MalSync.isLoggedIn();
    const visible = seasonalItems.filter(anime => (adultContentEnabled || !anime.isAdult)
        && !(seasonalView.hideListed && loggedIn && anime.idMal && malSyncHas('entryFor') && MalSync.entryFor(anime.idMal)));
    // No totals from AniList (it caps them); only how many of yours are hidden.
    const hiddenCount = seasonalItems.length - visible.length;
    if (count) count.textContent = hiddenCount > 0 ? `${hiddenCount} on your list hidden` : '';
    more?.classList.toggle('hidden', !seasonalHasMore);
    if (!visible.length) {
        grid.innerHTML = seasonalItems.length
            ? '<div class="empty-state">Everything shown so far is already on your list.</div>'
            : `<div class="empty-state">No anime found for ${escapeHtml(chartSeasonLabel(seasonalView))}${seasonalView.format || seasonalView.genre ? ' with these filters' : ''}.<span>If that looks wrong, AniList may be busy.</span><button class="inline-retry-btn" type="button">Try again</button></div>`;
        grid.querySelector('.inline-retry-btn')?.addEventListener('click', () => { seasonalItems = []; loadSeasonalPage(1, { retried: true }); });
        return;
    }
    grid.innerHTML = visible.map(seasonalCardHtml).join('');
    grid.querySelectorAll('[data-ptw]').forEach(button => button.addEventListener('click', () => {
        const anime = seasonalItems.find(item => item.id === Number(button.dataset.ptw));
        if (!anime?.idMal) return;
        MalSync.addToPlanToWatch({
            id: anime.idMal, title: anime.title?.romaji || anime.title?.english || '', titleEn: anime.title?.english || '',
            picture: anime.coverImage?.large || imageUrl(anime), episodes: anime.episodes || 0, isAdult: anime.isAdult,
            mediaType: MAL_MEDIA_TYPE[anime.format] || '', airing: MAL_AIRING[anime.status] || '', genres: anime.genres || [],
            season: { year: seasonalView.year, season: seasonalView.season.toLowerCase() }, mean: 0,
        });
    }));
}

function setupHeroBillboard(animeList) {
    heroSlides = (animeList || []).slice(0, 10);
    heroSlideIndex = 0;
    renderHeroIndicators();
    renderHeroSlide(0);
    // Look up every slide's picture now, side by side (small requests; the images
    // themselves are fetched one slide ahead).
    heroSlides.slice(1).forEach(anime => findHeroHd(anime));
    startHeroAutoRotate();
}
function startHeroAutoRotate() {
    clearInterval(heroInterval);
    if (heroSlides.length > 1) heroInterval = setInterval(() => goToHeroSlide(1), 6000);
}
function goToHeroSlide(delta) {
    if (!heroSlides.length) return;
    heroSlideIndex = (heroSlideIndex + delta + heroSlides.length) % heroSlides.length;
    renderHeroSlide(heroSlideIndex);
    startHeroAutoRotate();
}
function initHeroControls() {
    document.getElementById('hero-next-btn')?.addEventListener('click', () => goToHeroSlide(1));
    document.getElementById('hero-prev-btn')?.addEventListener('click', () => goToHeroSlide(-1));
}
function renderHeroIndicators() {
    const container = document.getElementById('hero-indicators');
    if (!container) return;
    container.innerHTML = '';
    heroSlides.forEach((_, index) => {
        const dot = document.createElement('button');
        dot.className = 'hero-dot';
        dot.setAttribute('aria-label', `Trending title ${index + 1}`);
        dot.addEventListener('click', () => { heroSlideIndex = index; renderHeroSlide(index); startHeroAutoRotate(); });
        container.appendChild(dot);
    });
}
/* Home banner images in HD.
   AniList's banners are about 1900×400 and the home banner is most of the screen
   tall, so they were stretched 2–3× and looked soft. Sources, best first:
     1. TMDB: full-screen 16:9 artwork without text (through the relay; needs TMDB_TOKEN there)
     2. Kitsu: the original upload of its banner
     3. AniList's banner
   An image is only shown full-width if it's big enough for this screen. Otherwise
   the banner shows the sharp poster on the right over a dimmed, blurred backdrop,
   so it never shows a stretched, soft picture. Lookups are remembered on this device. */
const KITSU_API = 'https://kitsu.io/api/edge';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/';
const HERO_HD_KEY = 'anizone:hero-hd:v2';
const HERO_HD_TTL = 14 * 24 * 60 * 60 * 1000;
const HERO_HD_MISS_TTL = 2 * 24 * 60 * 60 * 1000;
const HERO_HD_RETRY_TTL = 5 * 60 * 1000;         // a source couldn't answer (down, or not set up yet): ask again in 5 minutes
const HERO_HD_TIMEOUT_MS = 6000;
const HERO_MAX_UPSCALE = 1.5;                      // more stretching than this looks soft
const HERO_PREVIEW_UPSCALE = 2;                    // fine for a moment while the full-size picture loads
const HERO_FIRST_PAINT_WAIT_MS = 400;              // longest the text waits for a picture
const waitMs = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const heroHdInflight = new Map();
let heroRenderToken = 0;
function heroHdCache() {
    try { return JSON.parse(localStorage.getItem(HERO_HD_KEY) || '{}') || {}; } catch { return {}; }
}
function heroHdKey(anime) { return anime?.idMal ? `m${anime.idMal}` : anime?.id ? `a${anime.id}` : ''; }
// TMDB pictures in the order to load them: the 1280px one (about 200 KB, quick) and,
// when this screen needs more, the full-size one (often 4K, 1-3 MB) to sharpen it.
function tmdbImageSteps(path) {
    const hero = document.getElementById('home-hero');
    // A 16:9 picture covering the banner must be this wide (the banner may be taller than 16:9 on phones).
    const width = hero?.clientWidth || innerWidth, height = hero?.clientHeight || innerHeight * 0.88;
    const needed = Math.max(width, height * 16 / 9) * Math.min(window.devicePixelRatio || 1, 2);
    const steps = [`${TMDB_IMAGE_BASE}w1280${path}`];
    if (needed > 1280 * 1.15) steps.push(`${TMDB_IMAGE_BASE}original${path}`);
    return steps;
}
// Remembered HD pictures for this anime, lowest to highest quality: [] when there are none,
// undefined when not looked up yet.
function cachedHeroHd(anime) {
    const record = heroHdCache()[heroHdKey(anime)];
    if (!record || Date.now() > record.expiresAt) return undefined;
    return heroSourceUrls(record);
}
function heroSourceUrls(record) {
    if (record.tmdb) return tmdbImageSteps(record.tmdb);
    return record.kitsu ? [record.kitsu] : [];
}
function rememberHeroHd(anime, record, ttl) {
    const key = heroHdKey(anime);
    if (!key) return;
    const cache = heroHdCache();
    const now = Date.now();
    for (const [id, entry] of Object.entries(cache)) if (!entry || now > entry.expiresAt) delete cache[id];
    cache[key] = { ...record, expiresAt: now + ttl };
    const ids = Object.keys(cache);
    if (ids.length > 200) ids.sort((a, b) => cache[a].expiresAt - cache[b].expiresAt).slice(0, ids.length - 200).forEach(id => delete cache[id]);
    try { localStorage.setItem(HERO_HD_KEY, JSON.stringify(cache)); } catch {}
}
async function fetchWithTimeout(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HERO_HD_TIMEOUT_MS);
    try { return await fetch(url, { ...init, signal: controller.signal }); }
    finally { clearTimeout(timer); }
}
// TMDB picture path, '' when TMDB has none, or null when the relay can't answer.
async function lookupTmdbBackdrop(anime) {
    const relay = typeof MalSync !== 'undefined' ? MalSync.relayUrl() : '';
    if (!relay) return null;
    const titles = [anime.title?.english, anime.title?.romaji, anime.title?.native].filter(Boolean);
    if (!titles.length) return '';
    const params = new URLSearchParams();
    [...new Set(titles)].forEach(title => params.append('t', title));
    const year = anime.seasonYear || anime.startDate?.year;
    if (year) params.set('year', year);
    if (anime.format) params.set('format', anime.format);
    try {
        const response = await fetchWithTimeout(`${relay}/public/backdrop?${params}`, { headers: { Accept: 'application/json' } });
        if (!response.ok) return null;                 // older relay, TMDB not set up, or TMDB down
        const payload = await response.json();
        return typeof payload?.path === 'string' && /^\/[\w.-]+$/.test(payload.path) ? payload.path : '';
    } catch { return null; }
}
// Kitsu banner (original upload), '' when Kitsu has none, or null when Kitsu can't be reached.
async function lookupKitsuBanner(anime) {
    if (!anime.idMal) return '';
    const params = new URLSearchParams({ 'filter[externalSite]': 'myanimelist/anime', 'filter[externalId]': String(anime.idMal), include: 'item', 'fields[anime]': 'coverImage' });
    try {
        const response = await fetchWithTimeout(`${KITSU_API}/mappings?${params}`, { headers: { Accept: 'application/vnd.api+json' } });
        if (!response.ok) return null;
        const payload = await response.json();
        const cover = (payload?.included || []).find(entry => entry?.type === 'anime')?.attributes?.coverImage;
        const url = cover?.original || cover?.large || '';
        return /^https:\/\//.test(url) ? url : '';
    } catch { return null; }
}
// Resolves to the HD candidates for this anime, best first (may be empty).
function findHeroHd(anime) {
    const key = heroHdKey(anime);
    if (!key) return Promise.resolve([]);
    const known = cachedHeroHd(anime);
    if (known !== undefined) return Promise.resolve(known);
    if (heroHdInflight.has(key)) return heroHdInflight.get(key);
    const task = (async () => {
        const tmdb = await lookupTmdbBackdrop(anime);
        const kitsu = tmdb ? '' : await lookupKitsuBanner(anime);
        const record = { tmdb: tmdb || '', kitsu: kitsu || '' };
        const unanswered = tmdb === null || (!tmdb && kitsu === null);
        rememberHeroHd(anime, record, record.tmdb ? HERO_HD_TTL : unanswered ? HERO_HD_RETRY_TTL : record.kitsu ? HERO_HD_TTL : HERO_HD_MISS_TTL);
        return heroSourceUrls(record);
    })().finally(() => heroHdInflight.delete(key));
    heroHdInflight.set(key, task);
    return task;
}
const loadedImageSizes = new Map();
function preloadImage(url) {
    if (!url) return Promise.resolve(null);
    if (loadedImageSizes.has(url)) return Promise.resolve(loadedImageSizes.get(url));
    return new Promise(resolve => {
        const image = new Image();
        image.decoding = 'async';
        image.onload = () => { const size = { width: image.naturalWidth, height: image.naturalHeight }; loadedImageSizes.set(url, size); resolve(size); };
        image.onerror = () => resolve(null);
        image.src = url;
    });
}
// True when an image this size can cover the banner without visible stretching.
function sharpEnoughForHero(size, maxUpscale = HERO_MAX_UPSCALE) {
    if (!size?.width || !size?.height) return false;
    const hero = document.getElementById('home-hero');
    const width = hero?.clientWidth || innerWidth, height = hero?.clientHeight || innerHeight * 0.88;
    const scale = Math.max(width / size.width, height / size.height) * Math.min(window.devicePixelRatio || 1, 2);
    return scale <= maxUpscale;
}
function heroLayerParts(layer) {
    let backdrop = layer.querySelector('.hero-layer-bg');
    let poster = layer.querySelector('.hero-layer-poster');
    if (!backdrop) { backdrop = document.createElement('div'); backdrop.className = 'hero-layer-bg'; layer.appendChild(backdrop); }
    if (!poster) { poster = document.createElement('img'); poster.className = 'hero-layer-poster'; poster.alt = ''; poster.decoding = 'async'; layer.appendChild(poster); }
    return { backdrop, poster };
}
const cssUrl = (url) => url ? `url('${String(url).replace(/'/g, '%27')}')` : 'none';
// Cross-fades the banner. mode 'full' = a sharp picture across the whole banner;
// 'spotlight' = the poster, sharp, beside the text, over a dim blurred backdrop.
function showHeroBackground({ mode, image, backdrop }, { sharpen = false } = {}) {
    const layers = [document.getElementById('hero-bg-a'), document.getElementById('hero-bg-b')];
    const nextLayerIndex = heroBackgroundLayer === 0 ? 1 : 0;
    const currentLayer = layers[heroBackgroundLayer];
    const nextLayer = layers[nextLayerIndex];
    if (!nextLayer) return;
    const parts = heroLayerParts(nextLayer);
    nextLayer.style.backgroundImage = 'none';
    nextLayer.classList.remove('poster-fill');
    nextLayer.classList.toggle('spotlight', mode === 'spotlight');
    parts.backdrop.style.backgroundImage = cssUrl(mode === 'spotlight' ? backdrop || image : image);
    parts.backdrop.style.setProperty('--hero-poster', cssUrl(image));
    if (mode === 'spotlight' && image) { parts.poster.src = image; parts.poster.hidden = false; }
    else { parts.poster.removeAttribute('src'); parts.poster.hidden = true; }
    nextLayer.dataset.mode = mode;
    document.getElementById('home-hero')?.classList.toggle('spotlight-mode', mode === 'spotlight');
    nextLayer.dataset.src = image || '';
    // Swapping in a sharper copy of the same picture: fade only, no zoom.
    nextLayer.classList.toggle('no-zoom', sharpen);
    nextLayer.classList.add('active');
    currentLayer?.classList.remove('active');
    heroBackgroundLayer = nextLayerIndex;
}
function spotlightPicture(anime) {
    const poster = imageUrl(anime);
    return { mode: 'spotlight', image: poster, backdrop: anime.bannerImage || poster };
}
function renderHeroSlide(index) {
    const anime = heroSlides[index];
    if (!anime) return;
    const token = ++heroRenderToken;
    const steps = cachedHeroHd(anime) || [];
    if (!steps.length) findHeroHd(anime);   // start the lookup now, ahead of anything else

    const applySlide = (picture) => {
        if (token !== heroRenderToken) return;
        showHeroBackground(picture);
        document.getElementById('hero-title').textContent = displayTitle(anime);
        document.getElementById('hero-synopsis').textContent = synopsisText(anime.description) || 'No synopsis available.';
        document.querySelector('.hero-badge.top-10').textContent = `#${index + 1} Trending`;
        document.querySelector('.hero-badge.new-season').textContent = anime.seasonYear ? `${anime.season || ''} ${anime.seasonYear}`.trim() : formatStatus(anime.status);
        const watchTitle = anime.title?.english || anime.title?.romaji || '';
        const selectedWatchSite = getSelectedWatchSite();
        const heroWatchButton = document.getElementById('hero-watch-btn');
        heroWatchButton.textContent = `Watch on ${selectedWatchSite.name}`;
        heroWatchButton.onclick = () => window.open(buildWatchUrl(selectedWatchSite.url, watchTitle), '_blank', 'noopener,noreferrer');
        document.getElementById('hero-info-btn').onclick = () => viewSingleAnime(anime.id);
        document.querySelectorAll('#hero-indicators .hero-dot').forEach((dot, i) => dot.classList.toggle('active', i === index));
        sharpenHeroSlide(anime, token, picture).then(() => {
            // Then get the next slide's pictures ready, so it's sharp the moment it appears.
            const next = heroSlides[(index + 1) % heroSlides.length];
            if (next && next !== anime && token === heroRenderToken) prefetchHeroSlide(next);
        });
    };

    // Show the text straight away with the best picture that's ready within a moment:
    // the sharpest copy already downloaded, else the quick 1280px one, else the poster.
    // (A lower-quality copy may stretch a little more, since a sharper one is on its way.)
    const allowed = (i) => i === steps.length - 1 ? HERO_MAX_UPSCALE : HERO_PREVIEW_UPSCALE;
    const ready = [...steps].reverse().find(url => sharpEnoughForHero(loadedImageSizes.get(url), allowed(steps.indexOf(url))));
    if (ready) { applySlide({ mode: 'full', image: ready }); return; }
    const quick = steps[0];
    const poster = imageUrl(anime);
    Promise.race([
        Promise.all([quick ? preloadImage(quick) : null, preloadImage(poster)]),
        waitMs(HERO_FIRST_PAINT_WAIT_MS),
    ]).then(() => {
        const quickSize = quick && loadedImageSizes.get(quick);
        applySlide(sharpEnoughForHero(quickSize, allowed(0)) ? { mode: 'full', image: quick } : spotlightPicture(anime));
    });
}
// Loads the HD pictures for the slide on screen, lowest quality first, and swaps each in
// once it has loaded. The full-size one is only kept if it's sharp for this screen.
async function sharpenHeroSlide(anime, token, shown) {
    const steps = await findHeroHd(anime);
    let current = shown.mode === 'full' ? steps.indexOf(shown.image) : -1;
    for (let i = current + 1; i < steps.length; i++) {
        const size = await preloadImage(steps[i]);
        if (token !== heroRenderToken) return;
        const last = i === steps.length - 1;
        if (!sharpEnoughForHero(size, last ? HERO_MAX_UPSCALE : HERO_PREVIEW_UPSCALE)) continue;
        showHeroBackground({ mode: 'full', image: steps[i] }, { sharpen: current >= 0 });
        current = i;
    }
}
const heroPrefetched = new Set();
async function prefetchHeroSlide(anime) {
    const steps = await findHeroHd(anime);
    for (const url of steps) {
        if (heroPrefetched.has(url)) continue;
        heroPrefetched.add(url);
        await preloadImage(url);
    }
}

function initDiscoverFilters() {
    populateYearFilterOptions();
    const genre = document.getElementById('home-filter-genre');
    const year = document.getElementById('filter-year');
    const season = document.getElementById('filter-season');
    const type = document.getElementById('discover-type');
    const status = document.getElementById('discover-status');
    const rating = document.getElementById('discover-rating');
    const adult = document.getElementById('discover-adult-filter');
    if (genre) genre.value = selectedDiscoverGenre;
    if (year) year.value = selectedDiscoverYear;
    if (season) season.value = selectedDiscoverSeason;
    if (type) type.value = selectedDiscoverType;
    if (status) status.value = selectedDiscoverStatus;
    if (rating) rating.value = selectedDiscoverRating;
    if (adult) adult.value = selectedDiscoverAdult;
    syncDiscoverAdultFilter();
    const filterToggle = document.getElementById('discover-filter-toggle');
    const filterPanel = document.getElementById('discover-filter-panel');
    filterToggle?.addEventListener('click', () => {
        const open = filterToggle.getAttribute('aria-expanded') === 'true';
        filterToggle.setAttribute('aria-expanded', String(!open));
        filterPanel?.classList.toggle('open', !open);
    });
    [
        [genre, value => selectedDiscoverGenre = value],
        [year, value => selectedDiscoverYear = value],
        [season, value => selectedDiscoverSeason = value],
        [type, value => selectedDiscoverType = value],
        [status, value => selectedDiscoverStatus = value],
        [rating, value => selectedDiscoverRating = value],
        [adult, value => { selectedDiscoverAdult = value; localStorage.setItem('anizoneDiscoverAdultMode', value); }],
    ].forEach(([element, setter]) => element?.addEventListener('change', event => { setter(event.target.value); refreshDiscoverRow(); }));
    document.getElementById('reset-discover-filters')?.addEventListener('click', resetDiscoverFilters);
}
function populateYearFilterOptions() {
    const select = document.getElementById('filter-year');
    if (!select) return;
    let options = '<option value="">All Years</option>';
    for (let year = new Date().getFullYear() + 1; year >= 1960; year--) options += `<option value="${year}">${year}</option>`;
    select.innerHTML = options;
}
function syncDiscoverAdultFilter() {
    if (!adultContentEnabled) {
        selectedDiscoverAdult = 'regular';
        localStorage.setItem('anizoneDiscoverAdultMode', selectedDiscoverAdult);
    }
    const gridValue = currentActiveRowTarget === 'search' ? effectiveSearchContent() : selectedDiscoverAdult;
    [
        [document.getElementById('discover-adult-filter'), selectedDiscoverAdult],
        [document.getElementById('grid-discover-adult'), gridValue],
    ].forEach(([select, value]) => {
        if (!select) return;
        select.disabled = !adultContentEnabled;
        select.value = value;
        select.classList.toggle('hidden', !adultContentEnabled);
        const wrapper = select.closest('.az-select');
        wrapper?.classList.toggle('hidden', !adultContentEnabled);
        wrapper?.classList.toggle('adult-filter-active', adultContentEnabled);
        select._azRebuild?.();
    });
}

// Shows the current Discover filter values in the Home page's dropdowns.
function syncHomeDiscoverControls() {
    const values = {
        'home-filter-genre': selectedDiscoverGenre,
        'filter-year': selectedDiscoverYear,
        'filter-season': selectedDiscoverSeason,
        'discover-type': selectedDiscoverType,
        'discover-status': selectedDiscoverStatus,
        'discover-rating': selectedDiscoverRating,
        'discover-adult-filter': selectedDiscoverAdult,
    };
    Object.entries(values).forEach(([id, value]) => {
        const select = document.getElementById(id);
        if (select) { select.value = value; select._azRebuild?.(); }
    });
}

function resetDiscoverFilters() {
    selectedDiscoverGenre = '';
    selectedDiscoverYear = String(new Date().getFullYear());
    selectedDiscoverSeason = '';
    selectedDiscoverType = '';
    selectedDiscoverStatus = '';
    selectedDiscoverRating = '';
    selectedDiscoverAdult = adultContentEnabled ? 'both' : 'regular';
    localStorage.setItem('anizoneDiscoverAdultMode', selectedDiscoverAdult);
    syncHomeDiscoverControls();
    refreshDiscoverRow();
}
async function refreshDiscoverRow() {
    const track = document.getElementById('row-discover');
    if (!track) return;
    track.innerHTML = '<div class="spinner"></div>';
    try {
        const data = await getDiscover(1, 20);
        renderSliderTrack('row-discover', data.Page.media || []);
    } catch (error) {
        renderRowError('row-discover', error, refreshDiscoverRow);
    }
}

function initSliders() {
    document.querySelectorAll('.see-more-btn').forEach(button => button.addEventListener('click', () => expandRowToGrid(button.dataset.target)));
    document.querySelectorAll('.slider-container').forEach(container => {
        const track = container.querySelector('.slider-track');
        container.querySelector('.left-arrow')?.addEventListener('click', () => track?.scrollBy({ left: -500, behavior: 'smooth' }));
        container.querySelector('.right-arrow')?.addEventListener('click', () => track?.scrollBy({ left: 500, behavior: 'smooth' }));
    });
}
// The filter bar on the grid page serves both Discover and Search; each keeps its own values.
function gridFilterValues() {
    if (currentActiveRowTarget === 'search') return { ...searchFilters, content: effectiveSearchContent() };
    return {
        genre: selectedDiscoverGenre, year: selectedDiscoverYear, season: selectedDiscoverSeason,
        type: selectedDiscoverType, status: selectedDiscoverStatus, rating: selectedDiscoverRating,
        content: selectedDiscoverAdult, order: 'default',
    };
}
function setGridFilter(key, value) {
    if (currentActiveRowTarget === 'search') {
        searchFilters = { ...searchFilters, [key]: value };
        return;
    }
    homeDiscoverStale = true;
    if (key === 'genre') selectedDiscoverGenre = value;
    else if (key === 'year') selectedDiscoverYear = value;
    else if (key === 'season') selectedDiscoverSeason = value;
    else if (key === 'type') selectedDiscoverType = value;
    else if (key === 'status') selectedDiscoverStatus = value;
    else if (key === 'rating') selectedDiscoverRating = value;
    else if (key === 'content') { selectedDiscoverAdult = value; localStorage.setItem('anizoneDiscoverAdultMode', value); }
}
const GRID_FILTER_SELECTS = Object.freeze({
    'grid-discover-genre': 'genre',
    'grid-discover-year': 'year',
    'grid-discover-season': 'season',
    'grid-discover-type': 'type',
    'grid-discover-status': 'status',
    'grid-discover-rating': 'rating',
    'grid-discover-adult': 'content',
    'grid-search-order': 'order',
});

function syncGridDiscoverFilters() {
    const values = gridFilterValues();
    [['grid-discover-genre', 'home-filter-genre'], ['grid-discover-year', 'filter-year']].forEach(([id, sourceId]) => {
        const target = document.getElementById(id);
        const source = document.getElementById(sourceId);
        if (target && source && target.options.length !== source.options.length) target.innerHTML = source.innerHTML;
    });
    Object.entries(GRID_FILTER_SELECTS).forEach(([id, key]) => {
        const select = document.getElementById(id);
        if (select) { select.value = values[key]; select._azRebuild?.(); }
    });
    syncDiscoverAdultFilter();
    const searchOrder = document.getElementById('grid-search-order');
    const searchOrderWrap = searchOrder?.closest('.az-select') || searchOrder;
    searchOrderWrap?.classList.toggle('hidden', currentActiveRowTarget !== 'search');
}

function initGridDiscoverFilters() {
    const toggle = document.getElementById('grid-discover-filter-toggle');
    const panel = document.getElementById('grid-discover-filter-panel');
    toggle?.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!open));
        panel?.classList.toggle('open', !open);
    });
    Object.entries(GRID_FILTER_SELECTS).forEach(([id, key]) => document.getElementById(id)?.addEventListener('change', event => {
        setGridFilter(key, event.target.value);
        currentPage = 1;
        syncResultsUrl();
        configureResultsHeader(currentActiveRowTarget);
        fetchExpandedGridData();
    }));
    document.getElementById('grid-reset-discover-filters')?.addEventListener('click', () => {
        if (currentActiveRowTarget === 'search') searchFilters = defaultSearchFilters();
        else resetDiscoverFilters();
        currentPage = 1;
        syncResultsUrl();
        configureResultsHeader(currentActiveRowTarget);
        fetchExpandedGridData();
    });
}

function initGlobalFilterListeners() {
    ['filter-type', 'filter-status', 'filter-rating', 'filter-order'].forEach(id => document.getElementById(id)?.addEventListener('change', () => {
        if (currentActiveRowTarget && !document.getElementById('view-results')?.classList.contains('hidden')) {
            currentPage = 1;
            syncResultsUrl();
            fetchExpandedGridData();
        }
    }));
}
function expandRowToGrid(target) {
    if (BROWSE_TARGETS.has(target)) navigate(routeHash(`/browse/${target}`));
}
function executeGlobalSearch(query) {
    const text = String(query || '').trim();
    suggestionsDropdown?.classList.add('hidden');
    if (text) navigate(routeHash('/search', { q: text }));
}
function viewStudioGrid(studioId, studioName = '') {
    navigate(studioHash(studioId, studioName));
}
let resultsAbortController = null;
function cancelResultsRequest() {
    resultsAbortController?.abort();
    resultsAbortController = null;
}
async function fetchExpandedGridData() {
    const token = ++resultsRequestToken;
    const grid = document.getElementById('search-results-grid');
    if (!grid || !currentActiveRowTarget) return;
    cancelResultsRequest();
    resultsAbortController = new AbortController();
    const request = { signal: resultsAbortController.signal, priority: 'interactive' };
    showLoading(true);
    grid.innerHTML = '<div class="spinner"></div>';
    const filters = currentActiveRowTarget === 'search' ? {
        ...searchFilters,
        adultMode: effectiveSearchContent(),
    } : {
        type: document.getElementById('filter-type')?.value || '',
        status: document.getElementById('filter-status')?.value || '',
        rating: document.getElementById('filter-rating')?.value || '',
        order: document.getElementById('filter-order')?.value || 'default',
    };
    const firstSearchPage = currentActiveRowTarget === 'search' && currentPage === 1;
    const searchText = currentSearchQuery;
    renderSearchStudios(null); renderSearchBanner(null);   // nothing left over from the previous search
    const studiosRequest = firstSearchPage ? findStudiosWithWorks(searchText, request.signal).catch(() => null) : null;
    try {
        let data;
        if (currentActiveRowTarget === 'trending') data = await getTrending(currentPage, PAGE_SIZE, request);
        else if (currentActiveRowTarget === 'top') data = await getTopRated(currentPage, PAGE_SIZE, request);
        else if (currentActiveRowTarget === 'discover') data = await getDiscover(currentPage, PAGE_SIZE, request);
        else if (currentActiveRowTarget === 'studio') data = await getStudioAnime(selectedStudioId, currentPage, PAGE_SIZE, filters, request);
        else data = await searchAnime(currentSearchQuery, currentPage, SEARCH_PAGE_SIZE, filters, request.signal);
        if (token !== resultsRequestToken) return;
        if (currentActiveRowTarget === 'studio' && data.studioName && data.studioName !== selectedStudioName) {
            selectedStudioName = data.studioName;
            configureResultsHeader('studio');
            setPageTitle(selectedStudioName);
            syncResultsUrl();
        }
        resultsPageInfo = data.Page.pageInfo;
        const studioMatch = firstSearchPage ? pickStudioMatch(searchText, await studiosRequest) : null;
        if (token !== resultsRequestToken) return;
        renderSearchStudios(studioMatch);
        const pageItems = data.Page.media || [];
        renderResultsPage(grid, ['top', 'discover'].includes(currentActiveRowTarget) ? withoutSeen(pageItems) : pageItems, resultsPageInfo);
        if (firstSearchPage) {
            const items = data.Page.media || [];
            if (studioMatch?.strong && !items.length) grid.innerHTML = `<div class="empty-state">No titles contain “${escapeHtml(searchText)}”. ${escapeHtml(studioMatch.strong.name)}'s anime are shown above.</div>`;
            renderSearchBanner(searchCorrectedFrom ? { corrected: true, from: searchCorrectedFrom, to: searchText } : null);
            // Few or no results, and not obviously a studio: maybe a spelling mistake.
            if (!searchCorrectedFrom && !studioMatch?.strong && items.length < 5) suggestSpelling(searchText, token, items.length);
        }
    } catch (error) {
        if (token !== resultsRequestToken || error.name === 'AbortError') return;
        if (['top', 'discover'].includes(currentActiveRowTarget) && dropServerSeenFilter(error)) { showLoading(false); fetchExpandedGridData(); return; }
        console.error('Grid error:', error);
        grid.innerHTML = `<div class="empty-state api-error">${escapeHtml(error.message || 'Unable to load results.')}<button id="grid-retry-btn" class="inline-retry-btn">Retry</button></div>`;
        document.getElementById('grid-retry-btn')?.addEventListener('click', fetchExpandedGridData);
        updatePaginationControls(null);
    } finally {
        if (token === resultsRequestToken) showLoading(false);
    }
}
/* ==========================================
   SEARCH: STUDIOS AND "DID YOU MEAN"
   A search also looks for studios. A close match ("mappa" -> MAPPA) gets its own
   section above the title results with the studio's most popular anime.
   When a search finds little or nothing, it's compared with popular anime
   titles, studio names and your own list/history: nothing found -> the
   corrected search is shown instead (and says so); a few found -> "Did you mean".
   ========================================== */
let searchCorrectedFrom = '';
const SPELL_KEY = 'anizone:spell:v1';
const SPELL_TTL = 7 * 24 * 60 * 60 * 1000;
let spellCorpusRequest = null;

function normalizeSearchText(text) {
    return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
// Edit distance that counts a swap of two neighbouring letters as one mistake.
// Stops early once it's clearly more than `max` apart.
function typoDistance(a, b, max = 3) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prevPrev = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
            if (prevPrev && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, prevPrev[j - 2] + 1);
            row.push(value);
            if (value < rowMin) rowMin = value;
        }
        if (rowMin > max) return max + 1;
        prevPrev = prev; prev = row;
    }
    return prev[b.length];
}
const typoAllowance = (length) => length <= 3 ? 0 : length <= 5 ? 1 : length <= 9 ? 2 : 3;

async function findStudiosWithWorks(text, signal) {
    const query = `query ($search: String!) {
        Page(page: 1, perPage: 6) {
            studios(search: $search) {
                id name isAnimationStudio favourites
                media(sort: POPULARITY_DESC, isMain: true, perPage: 12) { pageInfo { total } nodes { ${FOR_YOU_CARD_FIELDS} } }
            }
        }
    }`;
    const data = await aniRequest(query, { search: text }, { cacheKey: `search-studios:v1:${normalizeSearchText(text)}`, ttl: 24 * 60 * 60 * 1000, signal, priority: 'interactive' });
    return data?.Page?.studios || [];
}
// The studio this search most likely means (if any), plus other matching studios.
function pickStudioMatch(text, studios) {
    if (!studios?.length) return null;
    const q = normalizeSearchText(text);
    const scored = studios.map(studio => {
        const name = normalizeSearchText(studio.name);
        let closeness = 9;
        if (name === q) closeness = 0;
        else if (name.startsWith(`${q} `) || name.replace(/ /g, '') === q.replace(/ /g, '')) closeness = 1;
        else if (q.length >= 4 && typoDistance(q, name, 2) <= typoAllowance(q.length)) closeness = 2;
        return { studio, closeness, works: (studio.media?.nodes || []).filter(anime => adultContentEnabled || !anime.isAdult) };
    }).sort((a, b) => a.closeness - b.closeness || (b.studio.isAnimationStudio - a.studio.isAnimationStudio) || ((b.studio.favourites || 0) - (a.studio.favourites || 0)));
    const best = scored[0];
    const strong = best.closeness <= 2 && best.works.length ? best : null;
    return {
        strong: strong ? { ...strong.studio, works: strong.works, total: strong.studio.media?.pageInfo?.total || strong.works.length } : null,
        others: scored.filter(item => item !== strong).map(item => item.studio).slice(0, 5),
    };
}
function renderSearchStudios(match) {
    const box = document.getElementById('search-studios');
    const heading = document.getElementById('search-titles-heading');
    if (!box) return;
    const others = match?.others || [];
    if (!match || (!match.strong && !others.length)) { box.classList.add('hidden'); box.innerHTML = ''; heading?.classList.add('hidden'); return; }
    const chips = others.length ? `<div class="search-studio-others"><span>${match.strong ? 'Other studios' : 'Studios'}</span>${others.map(studio => `<a class="stats-genre-chip" href="${studioHash(studio.id, studio.name)}">${escapeHtml(studio.name)}</a>`).join('')}</div>` : '';
    if (match.strong) {
        const studio = match.strong;
        box.innerHTML = `<section class="search-studio">
            <div class="search-studio-head">
                <div><span class="stats-eyebrow">Studio</span><h3>${escapeHtml(studio.name)}</h3><span class="search-studio-meta">Most popular first</span></div>
                <a class="see-more-btn" href="${studioHash(studio.id, studio.name)}">See all ${escapeHtml(studio.name)} anime <span>›</span></a>
            </div>
            <div class="slider-container"><button class="slider-arrow left-arrow" type="button" aria-label="Scroll left">‹</button><div class="slider-track" id="search-studio-track"></div><button class="slider-arrow right-arrow" type="button" aria-label="Scroll right">›</button></div>
            ${chips}
        </section>`;
        wireSliderArrows(box);
        renderSliderTrack('search-studio-track', studio.works);
    } else {
        box.innerHTML = chips;
    }
    box.classList.remove('hidden');
    if (heading) {
        heading.textContent = `Titles matching “${currentSearchQuery}”`;
        heading.classList.toggle('hidden', !match.strong);
    }
}
function renderSearchBanner(info) {
    const banner = document.getElementById('autocorrect-banner');
    if (!banner) return;
    if (!info) { banner.classList.add('hidden'); banner.innerHTML = ''; return; }
    if (info.corrected) {
        banner.innerHTML = `No results for “${escapeHtml(info.from)}”. Showing results for <strong>${escapeHtml(info.to)}</strong> instead.`;
    } else {
        const target = info.studio ? studioHash(info.studio.id, info.studio.name) : routeHash('/search', { q: info.label });
        banner.innerHTML = `Did you mean ${info.studio ? 'the studio ' : ''}<a class="autocorrect-link" href="${target}">${escapeHtml(info.label)}</a>?`;
    }
    banner.classList.remove('hidden');
}

// Popular anime titles and studio names, kept on this device for a week.
function spellingCorpus() {
    if (spellCorpusRequest) return spellCorpusRequest;
    spellCorpusRequest = (async () => {
        try {
            const saved = JSON.parse(localStorage.getItem(SPELL_KEY) || 'null');
            if (saved?.titles?.length && Date.now() - saved.savedAt < SPELL_TTL) return saved;
        } catch {}
        const page = (n) => `t${n}: Page(page: ${n}, perPage: 50) { media(type: ANIME, sort: POPULARITY_DESC) { title { romaji english } } }`;
        const [a, b] = await Promise.all([
            aniRequest(`query { ${page(1)} ${page(2)} }`, {}, { priority: 'background' }),
            aniRequest(`query { ${page(3)} studios: Page(page: 1, perPage: 50) { studios(sort: FAVOURITES_DESC) { id name } } }`, {}, { priority: 'background' }).catch(() => null),
        ]);
        const titles = [];
        for (const data of [a, b]) for (const key of ['t1', 't2', 't3']) for (const media of data?.[key]?.media || []) titles.push([media.title?.english || '', media.title?.romaji || ''].filter(Boolean));
        const corpus = { titles, studios: (b?.studios?.studios || []).map(studio => [studio.id, studio.name]), savedAt: Date.now() };
        try { localStorage.setItem(SPELL_KEY, JSON.stringify(corpus)); } catch {}
        return corpus;
    })().catch(error => { spellCorpusRequest = null; throw error; });
    return spellCorpusRequest;
}
function spellingCandidates(corpus) {
    const out = [];
    const add = (label, kind, extra = {}) => { const norm = normalizeSearchText(label); if (norm.length >= 2) out.push({ label, norm, kind, ...extra }); };
    (corpus?.studios || []).forEach(([id, name]) => add(name, 'studio', { studio: { id, name } }));
    (corpus?.titles || []).forEach(names => names.forEach(name => add(name, 'title')));
    const local = [];
    if (typeof MalSync !== 'undefined' && typeof MalSync.listEntries === 'function') MalSync.listEntries().forEach(entry => local.push(entry.titleEn, entry.title));
    (typeof clickHistory !== 'undefined' ? clickHistory : []).forEach(item => local.push(item.title?.english, item.title?.romaji));
    Object.values(dashboardPools || {}).flat().forEach(anime => local.push(anime?.title?.english, anime?.title?.romaji));
    local.filter(Boolean).forEach(name => add(name, 'title'));
    return out;
}
// The most likely intended search, or null. Matches the whole name, the start of a
// longer name ("jujutsu kaisn" -> Jujutsu Kaisen ...), or one word of it ("naurto").
function bestSpellingMatch(text, candidates) {
    const q = normalizeSearchText(text);
    const allowed = typoAllowance(q.replace(/ /g, '').length);
    if (!allowed) return null;
    let best = null;
    for (const candidate of candidates) {
        const c = candidate.norm;
        let distance = typoDistance(q, c, allowed);
        let suggestion = candidate.label;
        if (distance > allowed && c.length > q.length) {
            const prefix = typoDistance(q, c.slice(0, q.length), allowed);
            if (prefix + 0.25 < distance) distance = prefix + 0.25;
        }
        if (distance > allowed && !q.includes(' ')) {
            for (const word of c.split(' ')) {
                if (word.length < 4) continue;
                const d = typoDistance(q, word, allowed) + 0.5;
                if (d < distance) { distance = d; suggestion = candidate.kind === 'studio' ? candidate.label : word.charAt(0).toUpperCase() + word.slice(1); }
            }
        }
        if (distance === 0 || distance > allowed) continue;
        if (!best || distance < best.distance) best = { ...candidate, distance, label: suggestion };
    }
    return best;
}
async function suggestSpelling(text, token, resultCount) {
    let corpus = null;
    try { corpus = await spellingCorpus(); } catch { /* local titles only */ }
    if (token !== resultsRequestToken || currentSearchQuery !== text) return;
    const match = bestSpellingMatch(text, spellingCandidates(corpus));
    if (!match || normalizeSearchText(match.label) === normalizeSearchText(text)) return;
    if (!resultCount) {
        // Nothing found: show the corrected search straight away (and say so).
        navigate(routeHash('/search', { q: match.label, from: text }), { replace: true });
        return;
    }
    renderSearchBanner({ label: match.label, studio: match.kind === 'studio' ? match.studio : null });
}

function renderResultsPage(grid, items, pageInfo) {
    grid.innerHTML = '';
    if (!items.length) grid.innerHTML = '<div class="empty-state">No matching anime found.</div>';
    else items.forEach(item => grid.appendChild(createAnimeCard(item)));
    // AniList stops counting at 500/5,000, so its totals aren't real numbers. A count is
    // shown only when it's exact: when this is the last page of results.
    const perPage = Number(pageInfo?.perPage || items.length || 1);
    const exactTotal = pageInfo && !pageInfo.hasNextPage
        ? Math.max(0, (Number(pageInfo.currentPage || currentPage) - 1) * perPage + items.length)
        : null;
    const countTag = document.getElementById('results-count');
    countTag.textContent = exactTotal ? `${exactTotal.toLocaleString()} ${exactTotal === 1 ? 'title' : 'titles'}` : '';
    countTag.classList.toggle('hidden', !exactTotal);
    updatePaginationControls(pageInfo);
    restorePendingScroll();
}
function updatePaginationControls(pageInfo) {
    const previous = document.getElementById('prev-page-btn');
    const next = document.getElementById('next-page-btn');
    const indicator = document.getElementById('page-indicator');
    if (!previous || !next || !indicator) return;
    previous.disabled = !pageInfo || currentPage <= 1;
    next.disabled = !pageInfo?.hasNextPage;
    indicator.textContent = `Page ${currentPage}`;
    previous.onclick = () => { if (currentPage > 1) navigate(resultsRouteHash(currentPage - 1)); };
    next.onclick = () => { if (pageInfo?.hasNextPage) navigate(resultsRouteHash(currentPage + 1)); };
}

function viewSingleAnime(animeId) { navigate(animeHash(animeId)); }

// Each visit to an anime page gets a token and an AbortController. Anything that
// finishes after the visitor has moved on is discarded instead of being drawn
// onto the wrong anime's page, and queued background requests are cancelled.
let detailRequestToken = 0;
let detailAbortController = null;

function detailSignal() { return detailAbortController?.signal; }
function isCurrentDetail(anime) { return Boolean(anime) && currentDetailAnime?.id === anime.id; }

function stopDetailActivity() {
    detailAbortController?.abort();
    detailAbortController = null;
    clearInterval(countdownTimer);
    // A playing trailer keeps making sound in a hidden view, so remove it.
    const trailer = document.getElementById('detail-trailer');
    if (trailer?.querySelector('iframe')) trailer.innerHTML = '';
}

function resetDetailView() {
    currentDetailAnime = null;
    currentCastEdges = [];
    detailSectionState = { animeId: null, loaded: new Set() };
    document.getElementById('detail-backdrop').style.backgroundImage = 'none';
    const poster = document.getElementById('detail-poster');
    poster.removeAttribute('src');
    poster.alt = '';
    document.getElementById('detail-title').textContent = 'Loading…';
    document.getElementById('detail-synopsis').textContent = '';
    document.querySelector('#view-details .meta-badges')?.classList.add('hidden');
    document.getElementById('detail-adult-warning')?.classList.add('hidden');
    document.getElementById('detail-studio').textContent = '';
    document.getElementById('badge-status').textContent = '';
    document.getElementById('streaming-links-container').innerHTML = '';
    const malProgress = document.getElementById('mal-progress');
    if (malProgress) malProgress.innerHTML = '';
    const spinner = '<div class="spinner"></div>';
    document.getElementById('characters-list').innerHTML = spinner;
    document.getElementById('chrono-timeline').innerHTML = spinner;
    document.getElementById('timeline-summary')?.classList.add('hidden');
    ['episode-countdown', 'detail-trailer', 'detail-themes', 'manga-continuation', 'detail-staff', 'detail-recommendations']
        .forEach(id => { const box = document.getElementById(id); if (box) box.innerHTML = ''; });
}

async function showAnimeDetails(animeId) {
    const token = ++detailRequestToken;
    stopDetailActivity();
    detailAbortController = new AbortController();
    resetDetailView();
    showView('view-details');
    showLoading(true);
    try {
        const data = await getAnimeDetails(animeId, { signal: detailSignal() });
        if (token !== detailRequestToken) return;
        const anime = data?.Media;
        if (!anime) throw new AniListError('This anime could not be found.');
        if (!adultContentEnabled && anime.isAdult) throw new AniListError('Adult content is hidden. Enable the 18+ toggle to view this title.');
        currentDetailAnime = anime;
        setPageTitle(displayTitle(anime));
        renderAnimeDetails(anime);
        window.MalSync?.renderProgressPanel(anime);
        renderCastProfiles(anime.characters?.edges || []);
        appendAnimeToClickHistoryLog(anime);
        if (getDetailPrefs().timeline) renderDetailSection('timeline', anime);
        else { document.getElementById('chrono-timeline').innerHTML = ''; document.getElementById('timeline-summary')?.classList.add('hidden'); }
    } catch (error) {
        if (token !== detailRequestToken || error.name === 'AbortError') return;
        console.error('Detail error:', error);
        setPageTitle();
        document.getElementById('detail-title').textContent = error.message || 'Unable to load anime details.';
        document.getElementById('characters-list').innerHTML = '<div class="empty-state">Cast unavailable.</div>';
        document.getElementById('chrono-timeline').innerHTML = '<div class="empty-state">Timeline unavailable.</div>';
        document.getElementById('timeline-summary')?.classList.add('hidden');
    } finally {
        if (token === detailRequestToken) showLoading(false);
    }
}
function renderAnimeDetails(anime) {
    const poster = imageUrl(anime);
    const backdrop = anime.bannerImage || poster;
    document.getElementById('detail-backdrop').style.backgroundImage = `url('${backdrop}')`;
    const posterImage = document.getElementById('detail-poster');
    posterImage.src = poster;
    posterImage.alt = `${displayTitle(anime)} poster`;
    document.querySelector('#view-details .meta-badges')?.classList.remove('hidden');
    const primary = displayTitle(anime);
    const alternate = secondaryTitle(anime);
    document.getElementById('detail-title').innerHTML = `${escapeHtml(primary)}${alternate ? `<span class="detail-alt-title">${escapeHtml(alternate)}</span>` : ''}`;
    document.getElementById('detail-title').classList.toggle('long-title', primary.length > 45);
    setSynopsis(synopsisText(anime.description) || 'No synopsis available.');
    const adultWarning = document.getElementById('detail-adult-warning');
    if (adultWarning) adultWarning.classList.toggle('hidden', !anime.isAdult);
    const aniBadge = document.getElementById('badge-score');
    aniBadge.innerHTML = anime.averageScore ? scoreBadgeHtml('AniList', `${Math.round(anime.averageScore)}%`) : scoreBadgeHtml('AniList', '');
    aniBadge.href = anime.siteUrl || `https://anilist.co/anime/${Number(anime.id)}`;
    aniBadge.setAttribute('aria-label', `AniList score ${anime.averageScore ? `${Math.round(anime.averageScore)}%` : 'not available'}. Open on AniList`);
    const malBadge = document.getElementById('badge-mal-score');
    if (malBadge) {
        if (anime.idMal) malBadge.href = `https://myanimelist.net/anime/${Number(anime.idMal)}`; else malBadge.removeAttribute('href');
        malBadge.innerHTML = scoreBadgeHtml('MAL', anime.idMal ? '…' : 'N/A');
        malBadge.title = anime.idMal ? 'Loading MyAnimeList score…' : '';
        malBadge.classList.toggle('hidden', !anime.idMal);
    }
    loadMalScoreIntoDetails(anime);
    document.getElementById('badge-year').textContent = anime.seasonYear || anime.startDate?.year || 'TBA';
    const rating = document.getElementById('badge-rating');
    rating.textContent = anime.isAdult ? '18+' : '';
    rating.classList.toggle('hidden', !anime.isAdult);
    document.getElementById('badge-episodes').textContent = anime.episodes ? `${anime.episodes} Episodes` : 'Episodes TBA';
    document.getElementById('badge-type').textContent = formatFormat(anime.format);
    document.getElementById('badge-status').textContent = formatStatus(anime.status);
    renderStudioLinks(anime.studios?.nodes || []);
    buildStreamingLinks(anime);
}

// Score badges: the site's name as a quiet label, then the number. No star icons.
function scoreBadgeHtml(source, value) {
    return `<span class="score-src">${escapeHtml(source)}</span>${value ? ` <b class="score-num">${escapeHtml(value)}</b>` : ''}`;
}
async function loadMalScoreIntoDetails(anime) {
    const badge = document.getElementById('badge-mal-score');
    if (!badge || !anime?.idMal) return;
    try {
        const score = await fetchMalScore(anime.idMal, detailSignal());
        if (!isCurrentDetail(anime)) return;
        badge.innerHTML = scoreBadgeHtml('MAL', score != null ? Number(score).toFixed(2) : 'N/A');
        badge.title = score != null ? 'MyAnimeList score' : 'MyAnimeList has no score for this title yet.';
    } catch (error) {
        if (error.name === 'AbortError' || !isCurrentDetail(anime)) return;
        badge.innerHTML = scoreBadgeHtml('MAL', '—');
        badge.title = 'MyAnimeList scores are temporarily unavailable. Try again in a minute.';
    }
}

function renderStudioLinks(studios) {
    const container = document.getElementById('detail-studio');
    container.innerHTML = '';
    if (!studios.length) { container.textContent = 'Unknown Studio'; return; }
    studios.forEach((studio, index) => {
        const link = document.createElement('a');
        link.className = 'studio-link';
        link.href = studioHash(studio.id, studio.name);
        link.textContent = studio.name;
        container.appendChild(link);
        if (index < studios.length - 1) container.appendChild(document.createTextNode(', '));
    });
}
function buildStreamingLinks(anime) {
    const title = anime.title?.english || anime.title?.romaji || '';
    const selectedSite = getSelectedWatchSite();
    const watchUrl = buildWatchUrl(selectedSite.url, title);
    // AniList and MyAnimeList are linked from their score badges above.
    document.getElementById('streaming-links-container').innerHTML = `
        <a class="watch-now-btn watch-custom" href="${escapeHtml(watchUrl)}" target="_blank" rel="noopener noreferrer">▶ Watch on ${escapeHtml(selectedSite.name)}</a>`;
}
// Long synopses fold to a few lines, with "Read more" to open them.
function setSynopsis(text) {
    const box = document.getElementById('detail-synopsis');
    if (!box) return;
    box.textContent = text;
    box.classList.add('folded');
    box.nextElementSibling?.classList?.contains('synopsis-toggle') && box.nextElementSibling.remove();
    requestAnimationFrame(() => {
        if (box.scrollHeight <= box.clientHeight + 2) { box.classList.remove('folded'); return; }
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'synopsis-toggle';
        toggle.textContent = 'Read more';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', () => {
            const open = box.classList.toggle('folded') === false;
            toggle.textContent = open ? 'Show less' : 'Read more';
            toggle.setAttribute('aria-expanded', String(open));
        });
        box.after(toggle);
    });
}
function updateCastLanguageControls() {
    document.querySelectorAll('[data-cast-language]').forEach(button => {
        button.classList.toggle('active', button.dataset.castLanguage === castLanguage);
    });
}
function initCastLanguageToggle() {
    const toggle = document.querySelector('.cast-language-toggle');
    if (!toggle || toggle.dataset.bound === 'true') { updateCastLanguageControls(); return; }
    toggle.dataset.bound = 'true';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('tabindex', '0');
    const switchLanguage = () => {
        castLanguage = castLanguage === 'JAPANESE' ? 'ENGLISH' : 'JAPANESE';
        localStorage.setItem('anizoneCastLanguage', castLanguage);
        toggle.setAttribute('aria-checked', String(castLanguage === 'ENGLISH'));
        updateCastLanguageControls();
        renderCastProfiles(currentCastEdges, false);
    };
    toggle.addEventListener('click', event => { event.preventDefault(); switchLanguage(); });
    toggle.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); switchLanguage(); }
    });
    toggle.setAttribute('aria-checked', String(castLanguage === 'ENGLISH'));
    updateCastLanguageControls();
}

function renderCastProfiles(edges, remember = true) {
    if (remember) currentCastEdges = edges || [];
    const container = document.getElementById('characters-list');
    container.innerHTML = '';
    if (!currentCastEdges.length) { container.innerHTML = '<div class="empty-state">No cast data available.</div>'; return; }
    currentCastEdges.slice(0, 18).forEach(edge => {
        const character = edge.node;
        const wantedLanguage = castLanguage === 'ENGLISH' ? 'English' : 'Japanese';
        const actors = (edge.voiceActors || []).filter(actor =>
            String(actor?.languageV2 || '').toLowerCase() === wantedLanguage.toLowerCase()
        );
        const actor = actors[0];
        const languageLabel = castLanguage === 'ENGLISH' ? 'EN' : 'JP';
        const card = document.createElement('div');
        card.className = 'cast-card';
        card.innerHTML = `${character.image?.large ? `<img class="cast-avatar" src="${escapeHtml(character.image.large)}" alt="${escapeHtml(character.name.full)}" loading="lazy">` : '<div class="cast-avatar-placeholder">👤</div>'}<div class="cast-info"><span class="cast-char-name">${escapeHtml(character.name.full)}</span><span class="cast-va-name${actor ? '' : ' no-va'}">${actor ? `${escapeHtml(actor.name.full)} (${languageLabel})` : `No ${languageLabel} voice actor data`}</span></div>`;
        card.addEventListener('click', () => window.open(`https://anilist.co/character/${character.id}`, '_blank', 'noopener'));
        if (actor) card.querySelector('.cast-va-name').addEventListener('click', event => { event.stopPropagation(); openVoiceActorPortfolioPanel(actor.id, actor.name.full); });
        container.appendChild(card);
    });
}

function franchiseWords(anime) {
    const values = [anime?.title?.english, anime?.title?.romaji, ...(anime?.synonyms || [])]
        .filter(Boolean)
        .map(value => String(value).toLowerCase());
    const stop = new Set(['the','a','an','and','of','to','in','on','season','part','movie','film','ova','ona','special','tv','series','anime']);
    const words = new Set();
    for (const value of values) {
        value.replace(/[^a-z0-9]+/g, ' ').split(/\s+/).forEach(word => {
            if (word.length >= 4 && !stop.has(word)) words.add(word);
        });
        // Preserve distinctive franchise stems embedded inside compound titles,
        // e.g. Bakemonogatari / Nisemonogatari.
        if (value.includes('monogatari')) words.add('monogatari');
    }
    return words;
}

function isMainFranchiseMatch(rootAnime, candidate) {
    if (!candidate) return false;
    const rootWords = franchiseWords(rootAnime);
    const candidateWords = franchiseWords(candidate);
    for (const word of rootWords) {
        if (candidateWords.has(word)) return true;
        const titles = [candidate?.title?.english, candidate?.title?.romaji, ...(candidate?.synonyms || [])]
            .filter(Boolean).join(' ').toLowerCase();
        if (word.length >= 6 && titles.includes(word)) return true;
    }
    return false;
}

async function fetchFranchiseTimeline(rootAnime) {
    const container = document.getElementById('chrono-timeline');
    const signal = detailSignal();
    const isStale = () => !isCurrentDetail(rootAnime) || signal?.aborted;
    // A chronological franchise timeline should represent the main animated
    // continuity. AniList's CHARACTER, OTHER and SIDE_STORY edges often point to
    // music videos, promotional shorts, parody clips, or loosely associated media.
    const MAIN_CONTINUITY_RELATIONS = new Set(['PREQUEL', 'SEQUEL']);
    const seen = new Map([[rootAnime.id, { ...rootAnime, relation: 'Current' }]]);
    const queue = [{ anime: rootAnime, depth: 0 }];

    try {
        while (queue.length && seen.size < 40) {
            const current = queue.shift();
            const candidates = (current.anime.relations?.edges || []).filter(edge => {
                const node = edge.node;
                return node?.type === 'ANIME'
                    && MAIN_CONTINUITY_RELATIONS.has(edge.relationType)
                    && !seen.has(node.id)
                    && (adultContentEnabled || !node.isAdult)
                    && isMainFranchiseMatch(rootAnime, node);
            });

            if (!candidates.length) continue;
            const ids = [...new Set(candidates.map(edge => edge.node.id))].slice(0, 30);
            candidates.forEach(edge => seen.set(edge.node.id, {
                ...edge.node,
                relation: String(edge.relationType).replaceAll('_', ' '),
            }));

            if (current.depth >= 8) continue;
            const query = `query ($ids: [Int]) {
                Page(page: 1, perPage: 30) {
                    media(id_in: $ids, type: ANIME) {
                        id idMal isAdult type format status episodes duration
                        title { romaji english native }
                        coverImage { medium large extraLarge }
                        startDate { year month day }
                        relations {
                            edges {
                                relationType(version: 2)
                                node {
                                    id idMal isAdult type format status episodes duration
                                    title { romaji english native }
                                    synonyms
                                    coverImage { medium large extraLarge }
                                    startDate { year month day }
                                }
                            }
                        }
                    }
                }
            }`;
            const data = await aniRequest(query, { ids }, {
                cacheKey: `main-relations:v2:${ids.slice().sort((a, b) => a - b).join(',')}`,
                ttl: CACHE_TTL.details,
                signal,
            });
            if (isStale()) return;
            (data.Page?.media || []).forEach(anime => {
                const existing = seen.get(anime.id) || {};
                seen.set(anime.id, { ...existing, ...anime, relation: existing.relation || 'Related' });
                queue.push({ anime, depth: current.depth + 1 });
            });
        }

        if (isStale()) return;
        const nodes = [...seen.values()].sort((a, b) => dateNumber(a.startDate) - dateNumber(b.startDate) || a.id - b.id);
        renderTimelineLayout(nodes, rootAnime.id);
    } catch (error) {
        if (error.name === 'AbortError' || isStale()) return;
        console.error('Timeline error:', error);
        const partial = [...seen.values()].sort((a, b) => dateNumber(a.startDate) - dateNumber(b.startDate));
        if (partial.length > 1) renderTimelineLayout(partial, rootAnime.id);
        else { container.innerHTML = '<div class="empty-state">Could not build the franchise timeline.</div>'; document.getElementById('timeline-summary')?.classList.add('hidden'); }
    }
}
function timelineFormatLabel(format) {
    return ({ TV: 'TV / Season', TV_SHORT: 'TV Short / Season', MOVIE: 'Movie', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'Special', MUSIC: 'Music' })[format] || formatFormat(format);
}
// Franchise timeline. With MyAnimeList connected, each entry shows where you are with it:
// the rail dot takes the status colour used across the site, a small label says
// "Completed" / "Watching 5/12", shows in progress get a thin progress line, and a
// segmented bar on top sums up the franchise.
let lastTimeline = null;
const TIMELINE_STATUS = { watching: 'Watching', completed: 'Completed', on_hold: 'On hold', dropped: 'Dropped', plan_to_watch: 'Planned' };
function timelineEntry(node) {
    if (!node?.idMal || typeof malSyncHas !== 'function' || !malSyncHas('entryFor')) return null;
    return MalSync.entryFor(node.idMal) || null;
}
function timelineStatusText(entry, node) {
    if (entry.rewatching) return 'Rewatching';
    const label = TIMELINE_STATUS[entry.status] || '';
    const total = node.episodes || entry.episodes || 0;
    const watched = Number(entry.watched) || 0;
    return ['watching', 'on_hold', 'dropped'].includes(entry.status) && total > 1 ? `${label} ${watched}/${total}` : label;
}
function renderTimelineSummary(nodes, entries) {
    const box = document.getElementById('timeline-summary');
    if (!box) return;
    if (!entries.some(Boolean)) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const finished = entries.filter(entry => entry?.status === 'completed').length;
    const going = entries.filter(entry => entry && (entry.status === 'watching' || entry.rewatching)).length;
    const segments = nodes.map((node, i) => {
        const entry = entries[i];
        const tip = `${displayTitle(node)}: ${entry ? timelineStatusText(entry, node) : 'Not on your list'}`;
        return `<span class="tl-seg${entry ? ` mal-status-${entry.status}` : ''}" title="${escapeHtml(tip)}"></span>`;
    }).join('');
    box.innerHTML = `<div class="tl-sum-text"><strong>${finished} of ${nodes.length}</strong> finished${going ? ` · ${going} in progress` : ''}</div><div class="tl-sum-bar" aria-hidden="true">${segments}</div>`;
    box.classList.remove('hidden');
}
function renderTimelineLayout(nodes, activeId) {
    lastTimeline = { nodes, activeId: Number(activeId) };
    const container = document.getElementById('chrono-timeline');
    container.innerHTML = '';
    if (nodes.length <= 1) { renderTimelineSummary([], []); container.innerHTML = '<div class="empty-state">Standalone title — no related anime found.</div>'; return; }
    const entries = nodes.map(timelineEntry);
    renderTimelineSummary(nodes, entries);
    nodes.forEach((node, i) => {
        const current = node.id === Number(activeId);
        const entry = entries[i];
        const element = document.createElement('div');
        element.className = `timeline-node${current ? ' current-node' : ''}${entry ? ` tl-has mal-status-${entry.status}${entry.rewatching ? ' tl-rewatching' : ''}` : ''}`;
        const total = node.episodes || entry?.episodes || 0;
        const partway = entry && ['watching', 'on_hold', 'dropped'].includes(entry.status) && total > 0;
        const percent = partway ? Math.min(100, Math.round(((Number(entry.watched) || 0) / total) * 100)) : 0;
        element.innerHTML = `<div class="timeline-dot"></div><div class="timeline-meta-row"><div class="timeline-relation">${escapeHtml(node.relation || 'Related')} · ${escapeHtml(formatDate(node.startDate))}</div><span class="timeline-format-badge">${escapeHtml(timelineFormatLabel(node.format))}</span></div><div class="timeline-title">${escapeHtml(displayTitle(node))}</div>`
            + (entry ? `<div class="tl-status"><i aria-hidden="true"></i>${escapeHtml(timelineStatusText(entry, node))}</div>` : '')
            + (partway ? `<span class="tl-progress" style="--p:${percent}%" aria-hidden="true"></span>` : '');
        if (!current) element.addEventListener('click', () => viewSingleAnime(node.id));
        container.appendChild(element);
    });
}
// Your list changed (logged in, synced, status/episodes updated): redraw the marks.
document.addEventListener('DOMContentLoaded', () => {
    if (typeof malSyncHas === 'function' && malSyncHas('subscribe')) MalSync.subscribe(() => {
        if (!lastTimeline || currentDetailAnime?.id !== lastTimeline.activeId || document.getElementById('view-details')?.classList.contains('hidden')) return;
        if (!document.querySelector('#chrono-timeline .timeline-node')) return;
        renderTimelineLayout(lastTimeline.nodes, lastTimeline.activeId);
    });
});

async function openStaffPortfolioPanel(personId, personName) {
    const modal = document.getElementById('va-modal');
    const name = document.getElementById('va-modal-name');
    const roles = document.getElementById('va-roles-container');
    modal.classList.remove('hidden');
    name.textContent = personName;
    roles.innerHTML = '<div class="spinner"></div>';
    document.getElementById('close-va-modal').onclick = () => modal.classList.add('hidden');
    modal.onclick = event => { if (event.target === modal) modal.classList.add('hidden'); };
    try {
        const query = `query ($id: Int!) { Staff(id: $id) { id name { full } primaryOccupations staffMedia(page: 1, perPage: 30, type: ANIME, sort: [POPULARITY_DESC]) { nodes { id isAdult popularity title { romaji english native } coverImage { medium } } } } }`;
        const data = await aniRequest(query, { id: Number(personId) }, { cacheKey: `staff-media:${personId}`, ttl: CACHE_TTL.details, priority: 'interactive' });
        const anime = (data.Staff?.staffMedia?.nodes || []).filter(item => adultContentEnabled || !item.isAdult);
        roles.innerHTML = '';
        if (!anime.length) { roles.innerHTML = '<div class="empty-state">No anime staff credits found.</div>'; return; }
        anime.forEach(item => {
            const card = document.createElement('div');
            card.className = 'va-role-card';
            card.innerHTML = `<span class="va-role-anime">${escapeHtml(displayTitle(item))}</span><span class="va-role-char">Staff credit</span>`;
            card.addEventListener('click', () => { modal.classList.add('hidden'); viewSingleAnime(item.id); });
            roles.appendChild(card);
        });
    } catch (error) {
        roles.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Failed to load staff credits.')}</div>`;
    }
}

async function openVoiceActorPortfolioPanel(personId, personName) {
    const modal = document.getElementById('va-modal');
    const name = document.getElementById('va-modal-name');
    const roles = document.getElementById('va-roles-container');
    modal.classList.remove('hidden');
    name.textContent = personName;
    roles.innerHTML = '<div class="spinner"></div>';
    document.getElementById('close-va-modal').onclick = () => modal.classList.add('hidden');
    modal.onclick = event => { if (event.target === modal) modal.classList.add('hidden'); };
    try {
        const query = `query ($id: Int!) { Staff(id: $id) { id name { full } characters(page: 1, perPage: 25, sort: [FAVOURITES_DESC]) { edges { node { id name { full } } media { id isAdult type popularity title { romaji english native } } } } } }`;
        const data = await aniRequest(query, { id: Number(personId) }, { cacheKey: `staff:${personId}`, ttl: CACHE_TTL.details, priority: 'interactive' });
        const edges = data.Staff?.characters?.edges || [];
        roles.innerHTML = '';
        const visible = edges.filter(edge => edge.media?.length && (adultContentEnabled || edge.media.some(anime => !anime.isAdult)));
        if (!visible.length) { roles.innerHTML = '<div class="empty-state">No anime roles found.</div>'; return; }
        visible.forEach(edge => {
            const anime = [...edge.media].filter(item => adultContentEnabled || !item.isAdult).sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
            const card = document.createElement('div');
            card.className = 'va-role-card';
            card.innerHTML = `<span class="va-role-anime">${escapeHtml(displayTitle(anime))}</span><span class="va-role-char">as ${escapeHtml(edge.node.name.full)}</span>`;
            card.addEventListener('click', () => { modal.classList.add('hidden'); viewSingleAnime(anime.id); });
            roles.appendChild(card);
        });
    } catch (error) {
        roles.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Failed to load voice roles.')}</div>`;
    }
}

/* Surprise Me
   AniList only lets a request reach the first 5,000 results of any list, so a
   random position is chosen within that limit (the old code picked from 12,000
   and failed whenever it landed past 5,000). Picks come from released TV, movies,
   OVAs and ONAs that enough people have watched and rated reasonably, and skip
   titles already on your list, ones you've opened, and recent surprises. */
const SURPRISE_PAGE_SIZE = 50;
const SURPRISE_REACHABLE = 5000;
const SURPRISE_FILTERS = Object.freeze({ popularity: 8000, score: 55, formats: ['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA'] });
const SURPRISE_RECENT_KEY = 'anizone:surprise:recent:v1';
const SURPRISE_TTL = 24 * 60 * 60 * 1000;

function surprisePage(page) {
    const query = `query ($page: Int!, $perPage: Int!, $popularity: Int, $score: Int, $formats: [MediaFormat]) {
        Page(page: $page, perPage: $perPage) {
            pageInfo { total lastPage }
            media(type: ANIME, sort: POPULARITY_DESC, status_not: NOT_YET_RELEASED, popularity_greater: $popularity, averageScore_greater: $score, format_in: $formats${adultContentEnabled ? '' : ', isAdult: false'}) { id idMal isAdult title { romaji english native } }
        }
    }`;
    return aniRequest(query, {
        page,
        perPage: SURPRISE_PAGE_SIZE,
        popularity: SURPRISE_FILTERS.popularity,
        score: SURPRISE_FILTERS.score,
        formats: SURPRISE_FILTERS.formats,
    }, { cacheKey: `surprise:v3:${adultContentEnabled}:${page}`, ttl: SURPRISE_TTL, priority: 'interactive' });
}

async function triggerRandomShuffle() {
    showLoading(true);
    try {
        // Page 1 also tells us how many pages there are (and is kept for a day).
        const first = await surprisePage(1);
        const lastPage = Math.max(1, Number(first?.Page?.pageInfo?.lastPage) || 1);
        const reachablePages = Math.min(lastPage, Math.floor(SURPRISE_REACHABLE / SURPRISE_PAGE_SIZE));
        const page = 1 + Math.floor(Math.random() * reachablePages);
        const data = page === 1 ? first : await surprisePage(page);
        const candidates = (data?.Page?.media || []).filter(anime => adultContentEnabled || !anime.isAdult);
        if (!candidates.length) throw new Error('No surprise found right now. Please try again.');

        let recent = [];
        try { recent = JSON.parse(sessionStorage.getItem(SURPRISE_RECENT_KEY) || '[]'); } catch {}
        const seen = new Set([...recent, ...clickHistory.map(item => item.id)]);
        const listed = window.MalSync?.listedMalIds?.() || new Set();
        const fresh = candidates.filter(anime => !seen.has(anime.id) && !listed.has(anime.idMal));
        const pool = fresh.length ? fresh : candidates;
        const pick = pool[Math.floor(Math.random() * pool.length)];

        try { sessionStorage.setItem(SURPRISE_RECENT_KEY, JSON.stringify([pick.id, ...recent].slice(0, 50))); } catch {}
        viewSingleAnime(pick.id);
    } catch (error) {
        siteAlert(error.message || 'Unable to choose a surprise anime right now.', { title: 'Surprise Me' });
    } finally { showLoading(false); }
}

function appendAnimeToClickHistoryLog(anime) {
    const compact = compactHistoryItem({ ...anime, viewedAt: Date.now() });
    clickHistory = clickHistory.filter(item => item.id !== compact.id);
    clickHistory.unshift(compact);
    clickHistory = clickHistory.slice(0, HISTORY_LIMIT);
    persistHistory();
}
function removeAnimeFromHistoryLog(animeId) {
    clickHistory = clickHistory.filter(item => item.id !== Number(animeId));
    persistHistory();
    renderHistoryLogGrid();
}
function renderHistoryLogGrid() {
    const grid = document.getElementById('click-history-grid');
    if (!grid) return;
    const visible = clickHistory.filter(item => adultContentEnabled || !item.isAdult);
    grid.innerHTML = '';
    if (!visible.length) {
        grid.innerHTML = '<div class="empty-state">Your history is empty.</div>';
        return;
    }
    visible.forEach(item => grid.appendChild(createAnimeCard(item, true)));
}

let scheduleSelectedOffset = 0;
let scheduleRequestToken = 0;
// Rebuilt on every visit, so "Today" stays right after midnight.
function initScheduleView() {
    buildDayNav(scheduleInitialized ? scheduleSelectedOffset : 0);
    scheduleInitialized = true;
}
function scheduleTimeZoneLabel() {
    try {
        const zone = new Intl.DateTimeFormat([], { timeZoneName: 'long' }).formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value;
        return zone || Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, ' ');
    } catch { return 'your time zone'; }
}
function buildDayNav(selected = 0) {
    const nav = document.getElementById('schedule-day-nav');
    const zone = document.getElementById('schedule-timezone');
    if (zone) zone.textContent = scheduleTimeZoneLabel();
    nav.innerHTML = '';
    const today = new Date();
    for (let offset = 0; offset < 7; offset++) {
        const date = new Date(today);
        date.setDate(today.getDate() + offset);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `sched-day-btn${offset === selected ? ' active' : ''}`;
        button.setAttribute('aria-pressed', String(offset === selected));
        button.innerHTML = `<span class="sched-day-name">${offset === 0 ? 'Today' : date.toLocaleDateString([], { weekday: 'short' })}</span><span class="sched-day-month">${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>`;
        button.addEventListener('click', () => {
            scheduleSelectedOffset = offset;
            nav.querySelectorAll('.sched-day-btn').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
            keepDayVisible(nav, button);
            fetchScheduleForDate(date);
        });
        nav.appendChild(button);
    }
    keepDayVisible(nav, nav.querySelector('.sched-day-btn.active'));
    const day = new Date(today);
    day.setDate(today.getDate() + selected);
    fetchScheduleForDate(day);
}
// On narrow screens the day strip scrolls sideways; keep the chosen day in view.
function keepDayVisible(nav, button) {
    if (!nav || !button || nav.scrollWidth <= nav.clientWidth) return;
    const left = button.offsetLeft - nav.offsetLeft;
    if (left < nav.scrollLeft || left + button.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollTo({ left: Math.max(0, left - 16), behavior: 'instant' });
}
async function fetchScheduleForDate(date) {
    const token = ++scheduleRequestToken;   // a quicker click on another day wins
    const list = document.getElementById('schedule-list');
    list.innerHTML = '<div class="schedule-loading"><div class="sched-spinner"></div><span>Fetching schedule...</span></div>';
    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end = new Date(date); end.setHours(23, 59, 59, 999);
    const query = `query ($start: Int!, $end: Int!, $page: Int!, $perPage: Int!) {
        Page(page: $page, perPage: $perPage) {
            pageInfo { hasNextPage }
            airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
                id airingAt episode
                media { ${MEDIA_CARD_FIELDS} }
            }
        }
    }`;
    try {
        const all = [];
        for (let page = 1; page <= 5; page++) {
            const variables = { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000), page, perPage: 50 };
            const data = await aniRequest(query, variables, { cacheKey: `schedule:${adultContentEnabled}:${start.toISOString().slice(0,10)}:${page}`, ttl: CACHE_TTL.schedule, priority: 'interactive' });
            all.push(...(data.Page.airingSchedules || []));
            if (!data.Page.pageInfo.hasNextPage) break;
        }
        if (token !== scheduleRequestToken) return;
        renderScheduleList(all.filter(item => adultContentEnabled || !item.media.isAdult));
    } catch (error) {
        if (token !== scheduleRequestToken) return;
        list.innerHTML = `<div class="schedule-empty"><span>${escapeHtml(error.message || 'Could not load schedule.')}</span></div>`;
    }
}
// Shows you're watching on MyAnimeList come first, in their own group.
let lastScheduleItems = null;
function watchingEntryFor(anime) {
    if (!anime?.idMal || typeof malSyncHas !== 'function' || !malSyncHas('entryFor')) return null;
    const entry = MalSync.entryFor(anime.idMal);
    return entry && (entry.status === 'watching' || entry.rewatching) ? entry : null;
}
function scheduleRow(entry, now, mine) {
    const anime = entry.media;
    const time = new Date(entry.airingAt * 1000);
    const aired = time.getTime() <= now;
    const title = displayTitle(anime);
    const clock = time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const item = document.createElement('a');
    item.className = `schedule-item${aired ? ' aired' : ' upcoming'}${mine ? ' mine' : ''}`;
    item.href = animeHash(anime.id);
    // How far you've got, so you can see if you're behind.
    const seen = mine ? `<span class="sched-seen">${mine.watched ? `you've seen ${mine.watched}` : 'not started'}</span>` : '';
    // Grey time = already aired; coloured time = still to come.
    item.innerHTML = `<time class="sched-time" datetime="${time.toISOString()}" title="${aired ? 'Aired' : 'Airs'} at ${clock}" aria-label="${aired ? 'Aired' : 'Airs'} at ${clock}">${clock}</time>`
        + `<img class="sched-poster" src="${escapeHtml(imageUrl(anime))}" alt="" loading="lazy">`
        + `<div class="sched-info"><div class="sched-anime-title">${mine ? '<i class="sched-mine-dot" aria-label="On your Watching list"></i>' : ''}${escapeHtml(title)}</div>`
        + `<div class="sched-meta"><span class="sched-ep">Episode ${entry.episode}${anime.episodes ? ` of ${anime.episodes}` : ''}</span>${seen}`
        + `${anime.genres?.length ? `<span class="sched-genres">${escapeHtml(anime.genres.slice(0, 2).join(' · '))}</span>` : ''}</div></div>`
        + scheduleScores(anime, mine);
    return { item, aired };
}
// AniList and MyAnimeList scores, stacked on the right. MAL fills in after the list draws.
function scheduleScores(anime, mine) {
    const al = anime.averageScore ? `<span class="sched-score-row" title="AniList score"><span class="score-src">AniList</span><b>${Math.round(anime.averageScore)}%</b></span>` : '';
    let mal = '';
    if (anime.idMal) {
        const known = mine?.mean || getCachedMalScore(anime.idMal);
        mal = `<span class="sched-score-row" title="MyAnimeList score"${known ? '' : ` data-mal-score="${Number(anime.idMal)}"`}><span class="score-src">MAL</span><b>${known ? Number(known).toFixed(2) : '…'}</b></span>`;
    }
    return al || mal ? `<div class="sched-score">${al}${mal}</div>` : '';
}
let scheduleScoreToken = 0;
async function fillScheduleMalScores(list) {
    const token = ++scheduleScoreToken;
    const pending = [...list.querySelectorAll('[data-mal-score]')];
    const next = async () => {
        while (pending.length && token === scheduleScoreToken) {
            const row = pending.shift();
            const value = row.querySelector('b');
            try {
                const score = await fetchMalScore(Number(row.dataset.malScore));
                value.textContent = score != null ? Number(score).toFixed(2) : '–';
                if (score == null) row.title = 'MyAnimeList has no score for this yet';
            } catch {
                value.textContent = '–';
                row.title = 'MyAnimeList score unavailable right now';
            }
            row.removeAttribute('data-mal-score');
        }
    };
    await Promise.all([next(), next(), next(), next()]);   // a few at a time
}
function renderScheduleList(items) {
    lastScheduleItems = items;
    const list = document.getElementById('schedule-list');
    list.innerHTML = '';
    if (!items.length) { list.innerHTML = '<div class="schedule-empty"><span>No episodes scheduled.</span></div>'; return; }
    const now = Date.now();
    const sorted = [...items].sort((a, b) => a.airingAt - b.airingAt);
    const mine = sorted.filter(entry => watchingEntryFor(entry.media));
    const rest = sorted.filter(entry => !watchingEntryFor(entry.media));
    const heading = (text) => { const h = document.createElement('h3'); h.className = 'schedule-group'; h.textContent = text; list.appendChild(h); };
    if (mine.length) {
        heading("You're watching");
        mine.forEach(entry => list.appendChild(scheduleRow(entry, now, watchingEntryFor(entry.media)).item));
        if (rest.length) heading('All shows');
    }
    let sawAired = false, nowMarked = false;
    rest.forEach(entry => {
        const { item, aired } = scheduleRow(entry, now, null);
        // One "Now" line between what has aired and what's still to come (today only).
        if (aired) sawAired = true;
        else if (sawAired && !nowMarked) {
            nowMarked = true;
            const line = document.createElement('div');
            line.className = 'schedule-now';
            line.innerHTML = '<span>Now</span>';
            list.appendChild(line);
        }
        list.appendChild(item);
    });
    fillScheduleMalScores(list);
}
// "Hide shows I've seen": redraw what it affects when it's switched or your list changes.
function updateHideSeenHint() {
    const hint = document.getElementById('hide-seen-hint');
    if (!hint) return;
    const hasList = typeof MalSync !== 'undefined' && typeof MalSync.listEntries === 'function' && MalSync.listEntries().length > 0;
    hint.textContent = hasList || !hideSeenEnabled
        ? "Leaves shows you've watched, finished, paused or dropped out of Top Rated, Discover and recommendations. Trending still shows everything."
        : 'Log in to MyAnimeList below so AniZone knows what you have seen.';
}
function refreshForHideSeen() {
    lastSeenKey = seenIdsKey(seenMalIds());
    loadDashboardRows({ silent: true });
    if (['top', 'discover'].includes(currentActiveRowTarget) && !document.getElementById('view-results')?.classList.contains('hidden')) fetchExpandedGridData();
    if (currentDetailAnime && !document.getElementById('view-details')?.classList.contains('hidden')) renderRecommendations(currentDetailAnime);
}
document.addEventListener('DOMContentLoaded', () => {
    if (typeof malSyncHas === 'function' && malSyncHas('subscribe')) MalSync.subscribe(() => {
        updateHideSeenHint();
        if (hideSeenEnabled && seenIdsKey(seenMalIds()) !== lastSeenKey) refreshForHideSeen();
    });
});
// When your MyAnimeList list loads or changes, re-sort the schedule on screen.
document.addEventListener('DOMContentLoaded', () => {
    if (typeof malSyncHas === 'function' && malSyncHas('subscribe')) MalSync.subscribe(() => {
        if (lastScheduleItems && !document.getElementById('view-schedule')?.classList.contains('hidden')) renderScheduleList(lastScheduleItems);
    });
});

function initApp() {
    initNavigation();
    initPreferences();
    initSearchEngine();
    initSliders();
    initDiscoverFilters();
    initGlobalFilterListeners();
    initImageLazyLoad();
    initHeroControls();
    initCastLanguageToggle();
    persistHistory();
    document.getElementById('clear-click-history')?.addEventListener('click', async () => {
        if (await siteConfirm('Clear your watch history?', { title: 'Clear history', confirmText: 'Clear' })) {
            clickHistory = [];
            persistHistory();
            renderHistoryLogGrid();
        }
    });
    window.addEventListener('scroll', () => mainNav?.classList.toggle('scrolled', window.scrollY > 20));
    // Home rows load in the background on every page; the full-screen loader is
    // only shown when Home is the page being opened.
    loadDashboardRows({ silent: parseRoute().name !== 'home' });
    // Recommendations follow your MyAnimeList list (logging in, list updates, changes).
    if (malSyncHas('subscribe')) { MalSync.subscribe(scheduleForYouRows); scheduleForYouRows(); }
    setTimeout(() => (window.requestIdleCallback || (fn => setTimeout(fn, 1)))(() => spellingCorpus().catch(() => {})), 15000);
}

document.addEventListener('DOMContentLoaded', initApp);

/* ==========================================
   CONNECTED EXPERIENCE: MAL + ANILIST + JIKAN
   ========================================== */
const ANIZONE_CONFIG = Object.freeze({});

// Shared in-site dialog helpers. These replace blocking browser popups.
function siteDialog(message, { title = 'AniZone', confirmText = 'OK', cancelText = '', danger = false } = {}) {
    const overlay = document.getElementById('site-dialog');
    const titleEl = document.getElementById('site-dialog-title');
    const messageEl = document.getElementById('site-dialog-message');
    const confirm = document.getElementById('site-dialog-confirm');
    const cancel = document.getElementById('site-dialog-cancel');
    const close = document.getElementById('site-dialog-close');
    if (!overlay || !titleEl || !messageEl || !confirm || !cancel || !close) {
        return Promise.resolve(window.confirm(String(message)));
    }
    titleEl.textContent = title;
    messageEl.textContent = String(message);
    confirm.textContent = confirmText;
    confirm.classList.toggle('btn-danger', Boolean(danger));
    confirm.classList.toggle('btn-primary', !danger);
    cancel.textContent = cancelText || 'Cancel';
    cancel.classList.toggle('hidden', !cancelText);
    overlay.classList.remove('hidden');
    return new Promise(resolve => {
        const finish = value => {
            overlay.classList.add('hidden');
            confirm.onclick = null; cancel.onclick = null; close.onclick = null; overlay.onclick = null;
            resolve(value);
        };
        confirm.onclick = () => finish(true);
        cancel.onclick = () => finish(false);
        close.onclick = () => finish(false);
        overlay.onclick = event => { if (event.target === overlay) finish(false); };
        requestAnimationFrame(() => confirm.focus());
    });
}
function siteAlert(message, options = {}) {
    return siteDialog(message, { title: options.title || 'AniZone', confirmText: options.confirmText || 'OK' });
}
function siteConfirm(message, options = {}) {
    return siteDialog(message, {
        title: options.title || 'Confirm',
        confirmText: options.confirmText || 'Confirm',
        cancelText: options.cancelText || 'Cancel',
        danger: options.danger !== false,
    });
}

// Local visual themes do not require MAL or AniList login.

function siteWebsiteForm() {
    const overlay = document.getElementById('site-dialog');
    const titleEl = document.getElementById('site-dialog-title');
    const messageEl = document.getElementById('site-dialog-message');
    const fields = document.getElementById('site-dialog-fields');
    const nameInput = document.getElementById('site-dialog-name');
    const urlInput = document.getElementById('site-dialog-url');
    const errorEl = document.getElementById('site-dialog-error');
    const confirm = document.getElementById('site-dialog-confirm');
    const cancel = document.getElementById('site-dialog-cancel');
    const close = document.getElementById('site-dialog-close');
    if (!overlay || !titleEl || !messageEl || !fields || !nameInput || !urlInput || !errorEl || !confirm || !cancel || !close) return Promise.resolve(null);

    titleEl.textContent = 'Save watch website';
    messageEl.textContent = 'Add a name and a secure HTTPS link. Use {query} where the anime title should be inserted.';
    fields.classList.remove('hidden');
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
    nameInput.value = '';
    urlInput.value = '';
    confirm.textContent = 'Save Address';
    confirm.classList.remove('btn-danger');
    confirm.classList.add('btn-primary');
    cancel.textContent = 'Cancel';
    cancel.classList.remove('hidden');
    overlay.classList.remove('hidden');

    return new Promise(resolve => {
        const finish = value => {
            overlay.classList.add('hidden');
            fields.classList.add('hidden');
            confirm.onclick = null; cancel.onclick = null; close.onclick = null; overlay.onclick = null;
            nameInput.onkeydown = null; urlInput.onkeydown = null;
            resolve(value);
        };
        const submit = () => {
            const name = nameInput.value.trim();
            const url = urlInput.value.trim();
            let error = '';
            if (!name) error = 'Enter a website name.';
            else if (!isSecureWebsiteUrl(url)) error = 'Enter a valid link beginning with https://';
            if (error) {
                errorEl.textContent = error;
                errorEl.classList.remove('hidden');
                (name ? urlInput : nameInput).focus();
                return;
            }
            finish({ name: name.slice(0, 40), url });
        };
        confirm.onclick = submit;
        cancel.onclick = () => finish(null);
        close.onclick = () => finish(null);
        overlay.onclick = event => { if (event.target === overlay) finish(null); };
        const enterToSubmit = event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } };
        nameInput.onkeydown = enterToSubmit;
        urlInput.onkeydown = enterToSubmit;
        requestAnimationFrame(() => nameInput.focus());
    });
}

const THEME_AVATAR_DATA = Object.freeze({
    purple: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAYAAADNkKWqAAAE1klEQVR42u3cUUrjYBSGYRO6u6wh10KX0NtAl1DoauOViKCiNm1zzvc8d8MMw5D/nLd/teMwT8v6AhBo9AgAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQCDewSP48Ho8fft718vZAyJ2B7rO/zBPy+rA/0YMsQM9diA2gP85dCHE/PfagbgAbnXwQogdqD//UQG8R/xEEDtQdwdGB1/j7wc7IIC7PhgRxA7U2gGfAxRBzGSs0eGD+U/dudHhiy6k7oC3wCKIGfQW2OEDAggQcgkRQBAfN0AMIQgggAC6eQECCCCAAAK4c340FeAGCCCAbqKAAIIXX/oH0ACAHXQDdPiAAIIXYReAoAA+6xDc/sAN0FtRCJz/SjvnLbDgYiZj5380AOKHHfAW2AAYMOxA2A4M87SsaYOw9Y/LEj/Mf02RAdxqCIQPO1B7B2IDeMsQCB92oMcOxAfwN8MgeNiBnjsggEAsnwMEBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQR4loNHANzq9Xj69Ovr5Vzi3z3M07I6PuDW6H1l7yEUQGDz8FWJoAACdwlfhQj6GiCbLUOVr/vwuPDtnRsgmy+DEApflblwA2TzhXj/c0IofHsngNxtKYRQ+AQQiyWEoieApC+JEAqfAGL5hDAuej4GAz8spBi66QkgboVC2C56/icIlqrZ4jifHmfoBkiZpRbEOm9t/TQYLJ0Fiwle1XNxA6RNEDpFsdo3L6o+ezdAWi/n3hez+ndpq7/oCCCRi/uo5e36MZQut20BxIITFT0BRAiJDp8AIoTEhk8AEUIioyeAiCHR4RNAhFD04p+BACKGoieAIISiJ4AghqIngCCIgieAIIiCJ4AgiIIngCCKQieAIIxCJ4AQG0wxE0CAckaPABBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBAQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEBNAjAAQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEBBBBAAAEECPAGJfVTvTYEw2gAAAAASUVORK5CYII=',
    crimson: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAYAAADNkKWqAAAE1UlEQVR42u3cUU7bUBCGUWxlQX7yIlA2lA04G4qyPfOEEBIgIE7imf+ct6pVVfnOfLmBlGGZ5vUFINDoEQACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIICAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAQLyDR/Dh9Hr89vfO14sHROwOdJ3/YZnm1YH/jRhiB3rsQGwA/3PoQoj577UDcQHc6uCFEDtQf/6jAniP+IkgdqDuDowOvsbfD3ZAAHd9MCKIHai1Az4HKIKYyVijwwfzn7pzo8MXXUjdAW+BRRAz6C2wwwcEECDkEiKAID5ugBhCEEAAAXTzAgQQQAABBHDn/GgqwA0QQADdRAEBBC++9A+gAQA76Abo8AEBBC/CLgBBAXzWIbj9gRugt6IQOP+Vds5bYMHFTMbO/2gAxA874C2wATBg2IGwHRiWaV7TBmHrH5clfpj/miIDuNUQCB92oPYOxAbwliEQPuxAjx2ID+BvhkHwsAM9d0AAgVg+BwgIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCPAsB48AuNXp9fjp1+frpcS/e1imeXV8wK3R+8reQyiAwObhqxJBAQTuEr4KEfQ1QDZbhipf9+Fx4ds7N0A2XwYhFL4qc+EGyOYL8f7nhFD49k4AudtSCKHwCSAWSwhFTwBJXxIhFD4BxPIJYVz0fAwGflhIMXTTE0DcCoWwXfT8TxAsVbPFcT49ztANkDJLLYh13tr6aTBYOgsWE7yq5+IGSJsgdIpitW9eVH32boC0Xs69L2b179JWf9ERQCIX91HL2/VjKF1u2wKIBScqegKIEBIdPgFECIkNnwAihERGTwARQ6LDJ4AIoejFPwMBRAxFTwBBCEVPAEEMRU8AQRAFTwBBEAVPAEEQBU8AQRSFTgBBGIVOACE2mGImgADljB4BIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCAgggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIICCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggIoEcACCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAgIIIIAAAggQ4A0E40lDgzjkVAAAAABJRU5ErkJggg==',
    sakura: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAYAAADNkKWqAAAE0klEQVR42u3c0U3jUBCGUWylPXdhuYJ04VTgZs0TQkiAgDjBM/85b6tdrVa+M19uIMuwTvP+AhBo9AgAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQCDexSN4d12WL3/vtm0eELE70HX+h3Wadwf+O2KIHeixA7EB/MuhCyHmv9cOxAXwqIMXQuxA/fmPCuAj4ieC2IG6OzA6+Bp/P9gBATz1wYggdqDWDvgcoAhiJmONDh/Mf+rOjQ5fdCF1B7wFFkHMoLfADh8QQICQS4gAgvi4AWIIQQABBNDNCxBAAAEEEMCT86OpADdAAAF0EwUEELz40j+ABgDsoBugwwcEELwIuwAEBfC/DsHtD9wAvRWFwPmvtHPeAgsuZjJ2/kcDIH7YAW+BDYABww6E7cCwTvOeNghH/7gs8cP81xQZwKOGQPiwA7V3IDaA9wyB8GEHeuxAfAB/MgyChx3ouQMCCMTyOUBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQID/cvEIgHtdl+XDr2/bVuLfPazTvDs+4N7ofebsIRRA4PDwVYmgAAIPCV+FCPoaIIctQ5Wv+/C88J2dGyCHL4MQCl+VuXAD5PCFePtzQih8ZyeAPGwphFD4BBCLJYSiJ4CkL4kQCp8AYvmEMC56PgYD3yykGLrpCSBuhULYLnr+JwiWqtniOJ8eZ+gGSJmlFsQ6b239NBgsnQWLCV7Vc3EDpE0QOkWx2jcvqj57N0BaL+fZF7P6d2mrv+gIIJGL+6zl7foxlC63bQHEghMVPQFECIkOnwAihMSGTwARQiKjJ4CIIdHhE0CEUPTin4EAIoaiJ4AghKIngCCGoieAIIiCJ4AgiIIngCCIgieAIIpCJ4AgjEIngBAbTDETQIByRo8AEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBAQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQE0CMABBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQEEEEAAAQQI8AoQ5VWcjO9+gAAAAABJRU5ErkJggg==',
    shonen: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAYAAADNkKWqAAAE10lEQVR42u3c0U3jUBCGUWylGHeRDlxEakgXTg3pJZWZJ4SQAAFxgmf+c95Wu1qtfGe+3ECWYZmn9QUg0OgRAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAICCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIBAvINH8O58On75e5frzQMidge6zv+wzNPqwH9HDLEDPXYgNoB/OXQhxPz32oG4AG518EKIHag//1EBfET8RBA7UHcHRgdf4+8HOyCAuz4YEcQO1NoBnwMUQcxkrNHhg/lP3bnR4YsupO6At8AiiBn0FtjhAwIIEHIJEUAQHzdADCEIIIAAunkBAggggAACuHN+NBXgBggggG6igACCF1/6B9AAgB10A3T4gACCF2EXgKAA/tchuP2BG6C3ohA4/5V2zltgwcVMxs7/aADEDzvgLbABMGDYgbAdGJZ5WtMGYesflyV+mP+aIgO41RAIH3ag9g7EBvCeIRA+7ECPHYgP4E+GQfCwAz13QACBWD4HCAgggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAICCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAII8F8OHgFwr/Pp+OHXl+utxL97WOZpdXzAvdH7zN5DKIDA5uGrEkEBBB4SvgoR9DVANluGKl/34Xnh2zs3QDZfBiEUvipz4QbI5gvx9ueEUPj2TgB52FIIofAJIBZLCEVPAElfEiEUPgHE8glhXPR8DAa+WUgxdNMTQNwKhbBd9PxPECxVs8VxPj3O0A2QMkstiHXe2vppMFg6CxYTvKrn4gZImyB0imK1b15UffZugLRezr0vZvXv0lZ/0RFAIhf3Wcvb9WMoXW7bAogFJyp6AogQEh0+AUQIiQ2fACKEREZPABFDosMngAih6MU/AwFEDEVPAEEIRU8AQQxFTwBBEAVPAEEQBU8AQRAFTwBBFIVOAEEYhU4AITaYYiaAAOWMHgEggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIICCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAgggIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCAigRwAIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACAggggAACCBDgFZcOTEMoFHKgAAAAAElFTkSuQmCC',
    cyber: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAYAAADNkKWqAAAE10lEQVR42u3c0U3jUBCGUWylHZeRQnhwBU4Z6SGFpDjzhBASICBO4pn/nLfVrlYr35kvN5BlWKZ5fQEINHoEgAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIICCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCAQ7+ARfDgfX7/9vdP14gERuwNd539Ypnl14H8jhtiBHjsQG8D/HLoQYv577UBcALc6eCHEDtSf/6gA3iN+IogdqLsDo4Ov8feDHRDAXR+MCGIHau2AzwGKIGYy1ujwwfyn7tzo8EUXUnfAW2ARxAx6C+zwAQEECLmECCCIjxsghhAEEEAA3bwAAQQQQAAB3Dk/mgpwAwQQQDdRQADBiy/9A2gAwA66ATp8QADBi7ALQFAAn3UIbn/gBuitKATOf6Wd8xZYcDGTsfM/GgDxww54C2wADBh2IGwHhmWa17RB2PrHZYkf5r+myABuNQTChx2ovQOxAbxlCIQPO9BjB+ID+JthEDzsQM8dEEAgls8BAgIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACPMvBIwBudT6+fvr16Xop8e8elmleHR9wa/S+svcQCiCwefiqRFAAgbuEr0IEfQ2QzZahytd9eFz49s4NkM2XQQiFr8pcuAGy+UK8/zkhFL69E0DuthRCKHwCiMUSQtETQNKXRAiFTwCxfEIYFz0fg4EfFlIM3fQEELdCIWwXPf8TBEvVbHGcT48zdAOkzFILYp23tn4aDJbOgsUEr+q5uAHSJgidoljtmxdVn70bIK2Xc++LWf27tNVfdASQyMV91PJ2/RhKl9u2AGLBiYqeACKERIdPABFCYsMngAghkdETQMSQ6PAJIEIoevHPQAARQ9ETQBBC0RNAEEPRE0AQRMETQBBEwRNAEETBE0AQRaETQBBGoRNAiA2mmAkgQDmjRwAIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIICCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAgLoEQACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIIAAAggggAACCCCAAAIIIICAAAIIIIAAAgR4AxgZTdCBqO1xAAAAAElFTkSuQmCC',
    ghibli: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAYAAADNkKWqAAAE1klEQVR42u3cMU7jUBSGUWxlV27d0mUXLrKW7CNdFmgqhJAAAXES3/uf041mNBr53fvlBTIM0zKvLwCBRo8AEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBAQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQTiHTyCD8fT67e/dzlfPSBid6Dr/A/TMq8O/G/EEDvQYwdiA/ifQxdCzH+vHYgL4FYHL4TYgfrzHxXAe8RPBLEDdXdgdPA1/n6wAwK464MRQexArR3wOUARxEzGGh0+mP/UnRsdvuhC6g54CyyCmEFvgR0+IIAAIZcQAQTxcQPEEIIAAgigmxcggAACCCCAO+dHUwFugAAC6CYKCCB48aV/AA0A2EE3QIcPCCB4EXYBCArgsw7B7Q/cAL0VhcD5r7Rz3gILLmYydv5HAyB+2AFvgQ2AAcMOhO3AMC3zmjYIW/+4LPHD/NcUGcCthkD4sAO1dyA2gLcMgfBhB3rsQHwAfzMMgocd6LkDAgjE8jlAQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEECAZzl4BMCtjqfXT7++nK8l/t3DtMyr4wNujd5X9h5CAQQ2D1+VCAogcJfwVYigrwGy2TJU+boPjwvf3rkBsvkyCKHwVZkLN0A2X4j3PyeEwrd3AsjdlkIIhU8AsVhCKHoCSPqSCKHwCSCWTwjjoudjMPDDQoqhm54A4lYohO2i53+CYKmaLY7z6XGGboCUWWpBrPPW1k+DwdJZsJjgVT0XN0DaBKFTFKt986Lqs3cDpPVy7n0xq3+XtvqLjgASubiPWt6uH0PpctsWQCw4UdETQISQ6PAJIEJIbPgEECEkMnoCiBgSHT4BRAhFL/4ZCCBiKHoCCEIoegIIYih6AgiCKHgCCIIoeAIIgih4AgiiKHQCCMIodAIIscEUMwEEKGf0CAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAQAA9AkAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBBAAAEEEEAAAQQQQAABBBAQQAABBBBAgABv2TlJCIGDbL0AAAAASUVORK5CYII='
});

const THEME_KEY = 'anizone:theme:v1';
const WATCH_SITES_KEY = 'anizone:watch-sites:v1';
const WATCH_SITE_SELECTED_KEY = 'anizone:watch-site-selected:v1';
const DEFAULT_WATCH_SITES = Object.freeze([
    { id: 'setup-docs', name: 'Read Setup Docs', url: 'https://github.com/Legend-1125/Legend-1125.github.io/blob/main/README.md' },
]);
const LEGACY_WATCH_SITE_MIGRATION_KEY = 'anizone:watch-site-docs-default:v3';
function migrateLegacyWatchSiteDefault() {
    if (localStorage.getItem(LEGACY_WATCH_SITE_MIGRATION_KEY)) return;
    const stored = loadJson(WATCH_SITES_KEY, null);
    const onlySite = Array.isArray(stored) && stored.length === 1 ? stored[0] : null;
    const isOldDefault = onlySite && (
        (onlySite.name === 'Anikoto' && String(onlySite.url || '').includes('anikototv.to')) ||
        (onlySite.name === 'Temporary Site' && String(onlySite.url || '').includes('example.com')) ||
        (onlySite.name === 'Read Setup Docs' && String(onlySite.url || '') === 'https://github.com/Legend-1125/Legend-1125.github.io')
    );
    if (!stored || isOldDefault) {
        saveJson(WATCH_SITES_KEY, DEFAULT_WATCH_SITES.map(site => ({ ...site })));
        localStorage.setItem(WATCH_SITE_SELECTED_KEY, DEFAULT_WATCH_SITES[0].id);
    }
    localStorage.setItem(LEGACY_WATCH_SITE_MIGRATION_KEY, 'done');
}
function getWatchSites() {
    const stored = loadJson(WATCH_SITES_KEY, null);
    if (!Array.isArray(stored) || !stored.length) return DEFAULT_WATCH_SITES.map(site => ({ ...site }));
    return stored.filter(site => site?.id && site?.name && isSecureWebsiteUrl(site?.url)).slice(0, 3);
}
function isSecureWebsiteUrl(value) {
    try { return new URL(String(value)).protocol === 'https:'; } catch { return false; }
}
function buildWatchUrl(template, title) {
    const safeTemplate = isSecureWebsiteUrl(template) ? template : DEFAULT_WATCH_SITES[0].url;
    return safeTemplate.includes('{query}') ? safeTemplate.replaceAll('{query}', encodeURIComponent(title)) : safeTemplate;
}
function getSelectedWatchSite() {
    const sites = getWatchSites();
    const selectedId = localStorage.getItem(WATCH_SITE_SELECTED_KEY);
    return sites.find(site => site.id === selectedId) || sites[0] || DEFAULT_WATCH_SITES[0];
}
function refreshCurrentStreamingLinks() {
    if (currentDetailAnime && !document.getElementById('view-details')?.classList.contains('hidden')) buildStreamingLinks(currentDetailAnime);
}
// Settings menu: Content, MyAnimeList and Watch website fold away, one open at a time,
// each showing its current setting on the closed header. The last one opened is remembered.
const SETTINGS_FOLD_KEY = 'anizone:settings-open:v1';
function initSettingsFolds(panel) {
    const folds = [...panel.querySelectorAll('details.settings-fold')];
    let remembered = '';
    try { remembered = localStorage.getItem(SETTINGS_FOLD_KEY) || ''; } catch { /* nothing remembered */ }
    folds.forEach(fold => {
        if (fold.dataset.fold === remembered) fold.open = true;
        fold.addEventListener('toggle', () => {
            if (fold.open) folds.forEach(other => { if (other !== fold) other.open = false; });
            const open = folds.find(item => item.open);
            try { localStorage.setItem(SETTINGS_FOLD_KEY, open ? open.dataset.fold : ''); } catch { /* fine */ }
        });
    });
    // MyAnimeList header: your name, or what's needed to connect.
    const mal = document.getElementById('mal-settings');
    const malSum = document.getElementById('mal-sum');
    if (mal && malSum) {
        const update = () => {
            const name = mal.querySelector('.mal-account strong')?.textContent;
            malSum.textContent = name || (mal.querySelector('[data-mal-action="login"]') ? 'Not logged in' : 'Not set up');
        };
        new MutationObserver(update).observe(mal, { childList: true });
        update();
    }
}
function updateContentSummary() {
    const summary = document.getElementById('content-sum');
    if (!summary) return;
    const parts = [adultContentEnabled ? '18+ on' : '', hideSeenEnabled ? 'Hiding seen' : ''].filter(Boolean);
    summary.textContent = parts.join(' · ') || 'Default';
}
function initThemes() {
    const host = document.getElementById('theme-options');
    const menuButton = document.getElementById('theme-menu-btn');
    const menuPanel = document.getElementById('theme-menu-panel');
    const avatar = document.getElementById('theme-avatar-image');
    const watchHost = document.getElementById('watch-site-options');
    const addWatchSiteButton = document.getElementById('add-watch-site-btn');
    if (!host || !menuButton || !menuPanel || !avatar || !watchHost || !addWatchSiteButton) return;

    const themes = [
        { id: 'default', label: 'AniZone', color: '#8B5CF6', avatar: THEME_AVATAR_DATA.purple },
        { id: 'crimson', label: 'Crimson Pulse', color: '#E50914', avatar: THEME_AVATAR_DATA.crimson },
        { id: 'sakura', label: 'Sakura', color: '#ff5c8a', avatar: THEME_AVATAR_DATA.sakura },
        { id: 'shonen', label: 'Shōnen', color: '#ff5a1f', avatar: THEME_AVATAR_DATA.shonen },
        { id: 'cyber', label: 'Cyberpunk', color: '#f72585', avatar: THEME_AVATAR_DATA.cyber },
        { id: 'ghibli', label: 'Forest Spirit', color: '#4CAF50', avatar: THEME_AVATAR_DATA.ghibli },
    ];

    const closeMenu = () => {
        menuPanel.classList.add('hidden');
        menuButton.setAttribute('aria-expanded', 'false');
        document.getElementById('theme-menu-wrap')?.classList.remove('open');
    };
    const apply = value => {
        const selected = themes.find(theme => theme.id === value) || themes[0];
        if (selected.id === 'default') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', selected.id);
        localStorage.setItem(THEME_KEY, selected.id);
        avatar.src = selected.avatar;
        avatar.alt = `${selected.label} theme`;
        const current = document.getElementById('theme-current');
        if (current) current.textContent = selected.label;
        host.querySelectorAll('.theme-option').forEach(button => button.classList.toggle('active', button.dataset.theme === selected.id));
    };
    const persistSites = sites => saveJson(WATCH_SITES_KEY, sites.slice(0, 3));
    const renderWatchSites = () => {
        const sites = getWatchSites();
        const selected = getSelectedWatchSite();
        watchHost.innerHTML = '';
        sites.forEach(site => {
            const row = document.createElement('label');
            row.className = 'watch-site-row';
            row.title = site.url;
            row.innerHTML = `<input type="radio" name="watch-site" value="${escapeHtml(site.id)}" ${site.id === selected.id ? 'checked' : ''}><span class="watch-site-name">${escapeHtml(site.name)}</span><button class="watch-site-remove" type="button" aria-label="Remove ${escapeHtml(site.name)}">×</button>`;
            row.querySelector('input').addEventListener('change', () => {
                localStorage.setItem(WATCH_SITE_SELECTED_KEY, site.id);
                refreshCurrentStreamingLinks();
            });
            row.querySelector('.watch-site-remove').addEventListener('click', event => {
                event.preventDefault(); event.stopPropagation();
                const next = getWatchSites().filter(item => item.id !== site.id);
                if (!next.length) return siteAlert('Keep at least one watch website.', { title: 'Website required' });
                persistSites(next);
                if (localStorage.getItem(WATCH_SITE_SELECTED_KEY) === site.id) localStorage.setItem(WATCH_SITE_SELECTED_KEY, next[0].id);
                renderWatchSites(); refreshCurrentStreamingLinks();
            });
            watchHost.appendChild(row);
        });
        addWatchSiteButton.disabled = sites.length >= 3;
        const summary = document.getElementById('watch-sum');
        if (summary) summary.textContent = selected.name;
    };

    host.innerHTML = '';
    themes.forEach(theme => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'theme-option'; button.dataset.theme = theme.id; button.setAttribute('role', 'menuitem');
        button.title = theme.label; button.setAttribute('aria-label', `${theme.label} theme`);
        button.innerHTML = `<span class="theme-swatch" style="--theme-swatch:${theme.color}"></span><span>${theme.label}</span>`;
        button.addEventListener('click', event => { event.stopPropagation(); apply(theme.id); });
        host.appendChild(button);
    });
    addWatchSiteButton.addEventListener('click', async event => {
        event.stopPropagation();
        const sites = getWatchSites();
        if (sites.length >= 3) return;
        const website = await siteWebsiteForm();
        if (!website) return;
        const site = { id: `site-${Date.now()}`, name: website.name, url: website.url };
        persistSites([...sites, site]);
        localStorage.setItem(WATCH_SITE_SELECTED_KEY, site.id);
        renderWatchSites(); refreshCurrentStreamingLinks();
    });
    menuButton.addEventListener('click', event => {
        event.stopPropagation();
        const opening = menuPanel.classList.contains('hidden');
        menuPanel.classList.toggle('hidden', !opening);
        menuButton.setAttribute('aria-expanded', String(opening));
        document.getElementById('theme-menu-wrap')?.classList.toggle('open', opening);
    });
    menuPanel.addEventListener('click', event => event.stopPropagation());
    initSettingsFolds(menuPanel);
    document.addEventListener('click', event => { if (!document.getElementById('theme-menu-wrap')?.contains(event.target)) closeMenu(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });

    migrateLegacyWatchSiteDefault();
    const savedTheme = localStorage.getItem(THEME_KEY);
    const initialTheme = themes.some(theme => theme.id === savedTheme) ? savedTheme : 'default';
    apply(initialTheme);
    renderWatchSites();
}
let countdownTimer = null;
function loadJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; } }
function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function hasConfigured(value) { return Boolean(value && !String(value).startsWith('YOUR_')); }
const DETAIL_PREFS_KEY='anizone:detail-prefs:v1';
const DEFAULT_DETAIL_PREFS={countdown:true,timeline:true,trailer:true,themes:true,manga:true,staff:true,recommendations:true};
let detailSectionState={animeId:null,loaded:new Set()};
function getDetailPrefs(){return {...DEFAULT_DETAIL_PREFS,...loadJson(DETAIL_PREFS_KEY,{})};}
function applyDetailPreferences(){
    const prefs=getDetailPrefs();
    document.querySelectorAll('[data-detail-section]').forEach(section=>section.classList.toggle('hidden',prefs[section.dataset.detailSection]===false));
    return prefs;
}
function ensureDetailSectionState(anime){
    if(detailSectionState.animeId!==anime.id) detailSectionState={animeId:anime.id,loaded:new Set()};
}
function renderDetailSection(name,anime,{force=false}={}){
    ensureDetailSectionState(anime);
    if(!force&&detailSectionState.loaded.has(name)) return;
    detailSectionState.loaded.add(name);
    if(name==='countdown') renderCountdown(anime);
    else if(name==='trailer') renderTrailer(anime);
    else if(name==='recommendations') renderRecommendations(anime);
    else if(name==='staff') renderStaff(anime);
    else if(name==='manga') renderRelatedManga(anime);
    else if(name==='themes') fetchThemes(anime);
    else if(name==='timeline') fetchFranchiseTimeline(anime);
}
function renderEnhancedDetails(anime) {
    const prefs=applyDetailPreferences();
    ensureDetailSectionState(anime);
    Object.entries(prefs).forEach(([name,enabled])=>{
        if(!enabled){ if(name==='countdown') clearInterval(countdownTimer); return; }
        if(name!=='timeline') renderDetailSection(name,anime);
    });
}

function renderCountdown(anime){
    clearInterval(countdownTimer);
    const box=document.getElementById('episode-countdown');
    if(!box)return;
    const next=anime.nextAiringEpisode;
    if(!next){
        if(anime.status==='FINISHED') box.innerHTML=`<strong>All announced episodes have aired.</strong>${anime.episodes?`<small>${anime.episodes} episodes completed</small>`:''}`;
        else if(anime.status==='NOT_YET_RELEASED') box.innerHTML='<strong>Premiere date not announced yet.</strong>';
        else if(anime.status==='CANCELLED') box.innerHTML='<strong>This anime was cancelled.</strong>';
        else if(anime.status==='HIATUS') box.innerHTML='<strong>Currently on hiatus.</strong><small>No return episode announced.</small>';
        else box.innerHTML='<strong>Schedule pending.</strong><small>No next episode has been announced yet.</small>';
        return;
    }
    const tick=()=>{const remaining=Math.max(0,next.airingAt*1000-Date.now()); const d=Math.floor(remaining/86400000),h=Math.floor(remaining/3600000)%24,m=Math.floor(remaining/60000)%60,s=Math.floor(remaining/1000)%60; box.innerHTML=`Episode ${next.episode} airs in<div class="countdown-time">${d}d ${h}h ${m}m ${s}s</div>`;}; tick(); countdownTimer=setInterval(tick,1000);
}
function renderTrailer(anime){
    const box=document.getElementById('detail-trailer');
    if(!box)return;
    const trailer=anime.trailer;
    if(String(trailer?.site||'').toLowerCase()!=='youtube'||!trailer?.id){
        const youtubeLink=(anime.externalLinks||[]).find(link=>/youtube/i.test(link.site||'')&&!link.isDisabled)?.url;
        const searchUrl=youtubeLink||`https://www.youtube.com/results?search_query=${encodeURIComponent(`${displayTitle(anime)} official trailer PV`)}`;
        box.innerHTML=`<div class="empty-state rich-empty"><strong>No trailer was supplied by AniList.</strong><span>Search YouTube for an official PV or trailer instead.</span><a class="btn-secondary inline-action" href="${escapeHtml(searchUrl)}" target="_blank" rel="noopener">Search on YouTube ↗</a></div>`;
        return;
    }
    const rawVideoId=String(trailer.id);
    const videoId=encodeURIComponent(rawVideoId);
    const watchUrl=`https://www.youtube.com/watch?v=${videoId}`;
    const thumbnail=trailer.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
    box.innerHTML=`<div class="trailer-preview"><img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(displayTitle(anime))} trailer preview"><button class="trailer-play-button" type="button" aria-label="Play trailer">▶</button><span class="trailer-fallback-note">Embedded playback depends on browser referrer/privacy settings.</span><a class="trailer-external-link" href="${watchUrl}" target="_blank" rel="noopener">Open on YouTube ↗</a></div>`;
    box.querySelector('.trailer-play-button')?.addEventListener('click',()=>{
        const origin=encodeURIComponent(location.origin);
        const widgetReferrer=encodeURIComponent(location.href.split('#')[0]);
        box.innerHTML=`<div class="trailer-player"><iframe allowfullscreen referrerpolicy="origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" src="https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&enablejsapi=1&origin=${origin}&widget_referrer=${widgetReferrer}" title="${escapeHtml(displayTitle(anime))} official trailer"></iframe><a class="trailer-external-link" href="${watchUrl}" target="_blank" rel="noopener">Open on YouTube ↗</a></div>`;
    });
}
// "Recommendations" on an anime page: AniList's picks, 12 of them. With "Hide shows I've
// seen" on, seen ones are skipped; if that leaves fewer than 12, the rest are filled with
// well-liked shows from the same genres that you haven't seen.
const DETAIL_RECS = 12;
let recsTopUpToken = 0;
function renderRecommendations(anime) {
    const box = document.getElementById('detail-recommendations');
    if (!box) return;
    box.innerHTML = '';
    recsTopUpToken++;
    const recs = (anime.recommendations?.nodes || []).map(x => x.mediaRecommendation).filter(Boolean).filter(x => adultContentEnabled || !x.isAdult);
    const shown = withoutSeen(recs).slice(0, DETAIL_RECS);
    shown.forEach(x => box.appendChild(createAnimeCard(x)));
    if (hideSeenEnabled && shown.length < DETAIL_RECS && anime.genres?.length) { topUpRecommendations(anime, box, shown); return; }
    if (!shown.length) box.innerHTML = `<div class="empty-state">${recs.length ? "You've seen everything recommended here." : 'No recommendations yet.'}</div>`;
}
async function topUpRecommendations(anime, box, shown, retried = false) {
    const token = recsTopUpToken;
    const genres = anime.genres.slice(0, 2);
    const seen = seenFilterIds();
    const query = `query ($genres: [String], $id: Int${seen.length ? ', $seen: [Int]' : ''}) {
        Page(page: 1, perPage: 40) {
            media(type: ANIME, genre_in: $genres, id_not: $id, sort: [SCORE_DESC], popularity_greater: 15000, status_not: NOT_YET_RELEASED${seen.length ? ', idMal_not_in: $seen' : ''}${adultArgument()}) { ${MEDIA_CARD_FIELDS} }
        }
    }`;
    const variables = seen.length ? { genres, id: Number(anime.id), seen } : { genres, id: Number(anime.id) };
    let extras = [];
    try {
        const data = await aniRequest(query, variables, { cacheKey: `recs-fill:${adultContentEnabled}:${genres.join('+')}:${anime.id}:${seenIdsKey(seen)}`, ttl: CACHE_TTL.top, priority: 'background' });
        extras = data?.Page?.media || [];
    } catch (error) {
        if (!retried && seen.length && dropServerSeenFilter(error)) return topUpRecommendations(anime, box, shown, true);
        console.warn('Could not top up recommendations:', error.message);
    }
    if (token !== recsTopUpToken || !box.isConnected || currentDetailAnime?.id !== anime.id) return;
    const have = new Set([anime.id, ...shown.map(x => x.id)]);
    withoutSeen(extras).filter(x => !have.has(x.id) && (adultContentEnabled || !x.isAdult)).slice(0, DETAIL_RECS - shown.length)
        .forEach(x => box.appendChild(createAnimeCard(x)));
    if (!box.children.length) box.innerHTML = `<div class="empty-state">You've seen everything recommended here.</div>`;
}
function renderStaff(anime){
    const box=document.getElementById('detail-staff');
    if(!box)return;
    const edges=anime.staff?.edges||[];
    box.innerHTML='';
    if(!edges.length){box.innerHTML='<div class="empty-state">Staff data unavailable.</div>';return;}
    edges.slice(0,12).forEach(edge=>{
        const person=edge.node;
        const card=document.createElement('div');
        card.className='staff-card';
        card.tabIndex=0;
        card.setAttribute('role','button');
        const occupations=(person.primaryOccupations||[]).slice(0,2).join(' · ');
        card.innerHTML=`${person.image?.large?`<img src="${escapeHtml(person.image.large)}" alt="${escapeHtml(person.name.full)}" loading="lazy">`:'<div class="cast-avatar-placeholder">👤</div>'}<div><strong>${escapeHtml(person.name.full)}</strong><small>${escapeHtml(edge.role||'Staff')}</small>${occupations?`<small class="staff-occupation">${escapeHtml(occupations)}</small>`:''}</div>`;
        const open=()=>openStaffPortfolioPanel(person.id,person.name.full);
        card.addEventListener('click',open);
        card.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
        box.appendChild(card);
    });
}
function renderRelatedManga(anime){
    const box=document.getElementById('manga-continuation');
    if(!box)return;
    const priority={SOURCE:0,ADAPTATION:1,PARENT:2,PREQUEL:3,SEQUEL:4,SIDE_STORY:5,SPIN_OFF:6,OTHER:9};
    const manga=(anime.relations?.edges||[]).filter(edge=>edge.node?.type==='MANGA')
        .sort((a,b)=>(priority[a.relationType]??8)-(priority[b.relationType]??8));
    if(!manga.length){
        box.innerHTML='<div class="empty-state"><strong>No related manga listed.</strong><span>AniList has not linked a manga entry to this anime.</span></div>';
        return;
    }
    box.innerHTML=`<div class="related-manga-list">${manga.slice(0,8).map(edge=>{const title=edge.node.title?.english||edge.node.title?.romaji||edge.node.title?.native||'Manga';return `<a class="related-manga-item" href="https://anilist.co/manga/${edge.node.id}" target="_blank" rel="noopener"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(String(edge.relationType||'RELATED').replaceAll('_',' '))} · View on AniList ↗</small></a>`;}).join('')}</div>`;
}
async function fetchThemes(anime){
    const box=document.getElementById('detail-themes'); if(!box)return;
    if(!anime.idMal){box.innerHTML='<div class="empty-state">No MAL entry is available for theme-song data.</div>';return;}
    box.innerHTML='<div class="spinner"></div>';
    try{
        const full=await getJikanAnimeFull(anime.idMal, detailSignal());
        if(!isCurrentDetail(anime))return;
        const theme=full?.theme||{};
        const rows=[...(theme.openings||[]).map(x=>['Opening',x]),...(theme.endings||[]).map(x=>['Ending',x])];
        box.innerHTML=rows.length?rows.map(([kind,title])=>`<div class="music-item"><div><strong>${kind}</strong><small>${escapeHtml(title)}</small></div><a class="see-more-btn" target="_blank" rel="noopener" href="https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} ${displayTitle(anime)}`)}">Search</a></div>`).join(''):'<div class="empty-state">No opening or ending songs are listed for this title.</div>';
    }catch(e){if(e.name==='AbortError'||!isCurrentDetail(anime))return;box.innerHTML='<div class="empty-state"><strong>Theme songs are temporarily unavailable.</strong><span>They come from MyAnimeList, which isn\'t responding right now.</span></div>';}
}
/* ==========================================
   NEWS (MyAnimeList)
   Page 1 comes from MAL's RSS feed: about 14 KB instead of a full web page,
   with exact publish times and full-size images. Later pages come from MAL's
   news pages (?p=2, ...), whose 100x156 thumbnails are swapped for the
   full-size originals. MAL blocks direct browser requests (CORS), so both go
   through public relays raced against each other. Saved stories are shown
   instantly and refreshed in the background.
   ========================================== */
let newsPage = 1;
const NEWS_PAGE_SIZE = 20;                         // MAL lists 20 stories per page
const NEWS_FRESH_MS = 30 * 60 * 1000;              // older than this: refresh in the background
const NEWS_KEEP_MS = 7 * 24 * 60 * 60 * 1000;      // saved stories are shown for up to a week
const NEWS_RELAY_TIMEOUT_MS = 12000;
const NEWS_CACHE_VERSION = 'v6';
const NEWS_RELAYS = Object.freeze([
    url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
]);
const malNewsPageCache = new Map();
const newsInflight = new Map();
let newsRenderToken = 0;

function newsCacheKey(page) { return `anizone:mal-news:page:${page}:${NEWS_CACHE_VERSION}`; }

// Relay responses are untrusted: decode text with an inert parser and only keep https images.
function plainNewsText(value) {
    let text = String(value || '');
    for (let i = 0; i < 2 && /&(?:[a-z]+|#\d+|#x[\da-f]+);|<[a-z/]/i.test(text); i++) text = stripHtml(text);
    return text.replace(/\s+/g, ' ').trim();
}
function safeNewsImage(url) {
    const value = String(url || '').trim().replace(/^\/\//, 'https://');
    return /^https:\/\/[^\s"'<>]+$/i.test(value) ? value : '';
}
// https://cdn.myanimelist.net/r/100x156/s/common/uploaded_files/x.jpeg?s=...
//   -> https://cdn.myanimelist.net/s/common/uploaded_files/x.jpeg  (the original upload)
function fullSizeMalImage(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname !== 'cdn.myanimelist.net') return url;
        const match = parsed.pathname.match(/^\/r\/\d+x\d+(\/.+)$/);
        return match ? `https://cdn.myanimelist.net${match[1]}` : url;
    } catch { return url; }
}
function malNewsId(href) { return String(href || '').match(/(?:^|myanimelist\.net)\/news\/(\d+)/)?.[1] || null; }
function malNewsUrl(id) { return `https://myanimelist.net/news/${id}`; }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MAL_DATE_PATTERN = /((?:Today|Yesterday),\s*\d{1,2}:\d{2}\s*[AP]M|[A-Z][a-z]{2}\s+\d{1,2},\s*(?:\d{4},?\s*)?\d{1,2}:\d{2}\s*[AP]M|\d+\s+(?:minute|hour|day)s?\s+ago)\s+by\s/;
// MAL list dates look like "Oct 14, 9:43 PM", "Yesterday, 3:22 AM" or "5 hours ago".
function parseMalNewsDate(text, now = new Date()) {
    const value = String(text || '').trim();
    const toHours = (h, ampm) => (Number(h) % 12) + (/pm/i.test(ampm || '') ? 12 : 0);
    let m = value.match(/^(\d+)\s+(minute|hour|day)s?\s+ago/i);
    if (m) return new Date(now.getTime() - Number(m[1]) * { minute: 6e4, hour: 36e5, day: 864e5 }[m[2].toLowerCase()]).toISOString();
    m = value.match(/^(Today|Yesterday),\s*(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (m) {
        const date = new Date(now);
        if (/yesterday/i.test(m[1])) date.setDate(date.getDate() - 1);
        date.setHours(toHours(m[2], m[4]), Number(m[3]), 0, 0);
        return date.toISOString();
    }
    m = value.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(?:(\d{4}),?\s*)?(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (m && MONTHS.includes(m[1].toLowerCase())) {
        const date = new Date(Number(m[3] || now.getFullYear()), MONTHS.indexOf(m[1].toLowerCase()), Number(m[2]), toHours(m[4], m[6]), Number(m[5]));
        if (!m[3] && date - now > 2 * 864e5) date.setFullYear(date.getFullYear() - 1); // "Dec 30" seen in January
        return date.toISOString();
    }
    return '';
}

function parseMalNewsRss(xmlText, limit = NEWS_PAGE_SIZE) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('The MyAnimeList news feed could not be read.');
    const items = [];
    const seen = new Set();
    for (const item of doc.getElementsByTagName('item')) {
        const field = name => item.getElementsByTagName(name)[0]?.textContent?.trim() || '';
        const id = malNewsId(field('link'));
        if (!id || seen.has(id)) continue;
        const media = item.getElementsByTagNameNS('*', 'thumbnail')[0] || item.getElementsByTagNameNS('*', 'content')[0] || item.getElementsByTagName('enclosure')[0];
        const thumbnail = safeNewsImage(media?.getAttribute('url') || media?.textContent);
        const published = new Date(field('pubDate'));
        const title = plainNewsText(field('title'));
        if (!title) continue;
        seen.add(id);
        items.push({
            title,
            url: malNewsUrl(id),
            date: Number.isNaN(published.getTime()) ? '' : published.toISOString(),
            excerpt: plainNewsText(field('description')).slice(0, 500),
            image: safeNewsImage(fullSizeMalImage(thumbnail)),
            thumbnail,
        });
        if (items.length >= limit) break;
    }
    return items;
}

// Reads MAL's news list page without relying on its class names: each story is
// the headline link, the picture linked to the same story, and the text around them.
function parseMalNewsHtml(html, limit = NEWS_PAGE_SIZE) {
    const doc = new DOMParser().parseFromString(html, 'text/html'); // inert: nothing in it runs or loads
    const links = [...doc.querySelectorAll('a[href]')].map(a => ({ a, id: malNewsId(a.getAttribute('href')) })).filter(link => link.id);
    const items = [];
    const seen = new Set();
    for (const { a, id } of links) {
        if (seen.has(id) || a.querySelector('img')) continue;
        const title = plainNewsText(a.textContent);
        if (title.length < 8 || /^\d+\s+comments?$/i.test(title)) continue;
        const imageLink = links.find(link => link.id === id && link.a.querySelector('img'))?.a;
        const img = imageLink?.querySelector('img');
        const thumbnail = safeNewsImage(img?.getAttribute('data-src') || img?.getAttribute('src') || (img?.getAttribute('srcset') || '').split(/[ ,]/)[0]);
        let story = a.parentElement;
        if (imageLink) while (story && !story.contains(imageLink)) story = story.parentElement;
        else story = story?.parentElement;
        if (!story || story === doc.body) story = a.parentElement;
        const storyText = plainNewsText(story?.textContent);
        const dateText = storyText.match(MAL_DATE_PATTERN)?.[1] || '';
        const excerpt = [...(story?.querySelectorAll('p, div, span') || [])]
            .filter(el => !el.contains(a) && !el.querySelector('img') && !MAL_DATE_PATTERN.test(`${el.textContent} `))
            .map(el => plainNewsText(el.textContent))
            .filter(text => text.length > 40 && text !== title)
            .sort((x, y) => y.length - x.length)[0] || '';
        seen.add(id);
        items.push({ title, url: malNewsUrl(id), date: parseMalNewsDate(dateText), excerpt: excerpt.slice(0, 500), image: safeNewsImage(fullSizeMalImage(thumbnail)), thumbnail });
        if (items.length >= limit) break;
    }
    return items;
}

function readNewsCache(page) {
    if (malNewsPageCache.has(page)) return malNewsPageCache.get(page);
    try {
        const cached = JSON.parse(localStorage.getItem(newsCacheKey(page)) || 'null');
        if (!cached?.items?.length || Date.now() - cached.savedAt > NEWS_KEEP_MS) return null;
        malNewsPageCache.set(page, cached);
        return cached;
    } catch { return null; }
}
function writeNewsCache(page, result) {
    const value = { ...result, savedAt: Date.now() };
    malNewsPageCache.set(page, value);
    try { localStorage.setItem(newsCacheKey(page), JSON.stringify(value)); } catch {}
    return value;
}
function isNewsFresh(cached) { return Boolean(cached) && Date.now() - cached.savedAt < NEWS_FRESH_MS; }

// Asks every relay at once, keeps the first good answer and cancels the rest.
async function fetchViaNewsRelays(targetUrl, parse, { force = false } = {}) {
    const controllers = NEWS_RELAYS.map(() => new AbortController());
    const attempt = async (relay, index) => {
        const controller = controllers[index];
        const timer = setTimeout(() => controller.abort(), NEWS_RELAY_TIMEOUT_MS);
        try {
            const url = relay(targetUrl) + (force ? `&_=${Date.now()}` : '');
            const response = await fetch(url, { signal: controller.signal, cache: force ? 'no-store' : 'default' });
            if (!response.ok) throw new Error(`News relay failed (${response.status}).`);
            return { result: parse(await response.text()), index };
        } finally { clearTimeout(timer); }
    };
    try {
        const { result, index } = await Promise.any(NEWS_RELAYS.map(attempt));
        controllers.forEach((controller, i) => { if (i !== index) controller.abort(); });
        return result;
    } catch {
        throw new Error('MyAnimeList news is temporarily unavailable.');
    }
}

function fetchMalNewsPage(page = 1, { force = false } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    if (newsInflight.has(safePage)) return newsInflight.get(safePage);
    const fromFeed = safePage === 1;
    const target = fromFeed ? 'https://myanimelist.net/rss/news.xml' : `https://myanimelist.net/news?p=${safePage}`;
    const parse = text => {
        const items = fromFeed ? parseMalNewsRss(text) : parseMalNewsHtml(text);
        if (!items.length) throw new Error('No MyAnimeList news items returned.');
        const hasNextPage = fromFeed
            || new RegExp(`[?&](?:p|page)=${safePage + 1}(?:[&"'#]|$)`).test(text)
            || items.length >= NEWS_PAGE_SIZE;
        return { items, page: safePage, hasNextPage };
    };
    const task = fetchViaNewsRelays(target, parse, { force })
        .then(result => writeNewsCache(safePage, result))
        .finally(() => newsInflight.delete(safePage));
    newsInflight.set(safePage, task);
    return task;
}

function prefetchNewsPage(page) {
    const safePage = Math.max(1, Number(page) || 1);
    if (isNewsFresh(readNewsCache(safePage))) return;
    fetchMalNewsPage(safePage).catch(() => {});
}
// Fetch the news quietly a few seconds after the site opens, so News is ready when clicked.
function scheduleNewsPrefetch() {
    const whenIdle = window.requestIdleCallback || (callback => setTimeout(callback, 1));
    setTimeout(() => whenIdle(() => {
        if (multiSourceNewsAvailable()) NEWS_SOURCES.forEach(source => { if (!isNewsFresh(readNewsSourceCache(source.id))) fetchNewsSource(source.id).catch(() => {}); });
        else prefetchNewsPage(1);
    }, { timeout: 5000 }), 4000);
}

/* ==========================================
   NEWS FROM SEVERAL SITES
   Each site's feed is read by the AniZone relay (worker/mal-relay.js,
   /public/news), which also finds a picture for stories whose feed has none.
   Stories are merged newest first, with a filter per site. Each site is saved
   on this device and refreshed in the background, like MyAnimeList news was.
   If the relay can't serve news, the page falls back to MyAnimeList only.
   ========================================== */
const NEWS_SOURCES = Object.freeze([
    { id: 'mal', name: 'MyAnimeList', link: 'https://myanimelist.net/news' },
    { id: 'crunchyroll', name: 'Crunchyroll News', link: 'https://www.crunchyroll.com/news' },
    { id: 'ann', name: 'Anime News Network', link: 'https://www.animenewsnetwork.com/news/' },
    { id: 'animecorner', name: 'Anime Corner', link: 'https://animecorner.me/category/news/' },
    { id: 'honeysanime', name: "Honey's Anime", link: 'https://honeysanime.com/' },
]);
const NEWS_SOURCE_IDS = new Set(NEWS_SOURCES.map(source => source.id));
const NEWS_SOURCE_CACHE_VERSION = 'v1';
const NEWS_SOURCE_TIMEOUT_MS = 15000;
const NEWS_FIRST_PAINT_MS = 4000;          // first visit: show what has arrived by then
let newsSource = 'all';
let newsRelaySupport = 'unknown';         // 'unknown' | 'yes' | 'no' (relay too old or missing)
const newsSourceMemory = new Map();
const newsSourceInflight = new Map();
const newsSourceErrors = new Map();
let pendingNewsRedraw = null;

const newsSourceInfo = (id) => NEWS_SOURCES.find(source => source.id === id) || NEWS_SOURCES[0];
function newsHash(source = newsSource, page = 1) { return routeHash('/news', { source: source === 'all' ? '' : source, page }); }
function newsRelayUrl() { return typeof MalSync !== 'undefined' ? MalSync.relayUrl() : ''; }
function multiSourceNewsAvailable() { return Boolean(newsRelayUrl()) && newsRelaySupport !== 'no'; }
function newsSourceCacheKey(id) { return `anizone:news:${id}:${NEWS_SOURCE_CACHE_VERSION}`; }
function readNewsSourceCache(id) {
    if (newsSourceMemory.has(id)) return newsSourceMemory.get(id);
    try {
        const cached = JSON.parse(localStorage.getItem(newsSourceCacheKey(id)) || 'null');
        if (!cached?.items?.length || Date.now() - cached.savedAt > NEWS_KEEP_MS) return null;
        newsSourceMemory.set(id, cached);
        return cached;
    } catch { return null; }
}
// Each site's stories are kept on this device and added to, not replaced: a refresh adds
// the newest, "older stories" pages add older ones. nextPage/done track how far back we've read.
const NEWS_SOURCE_MAX_SAVED = 240;
const newsItemTime = (item) => { const t = item?.date ? Date.parse(item.date) : NaN; return Number.isNaN(t) ? 0 : t; };
function mergeNewsItems(first, second) {
    const seen = new Set();
    const merged = [];
    for (const item of [...first, ...second]) {
        if (!item?.url || seen.has(item.url)) continue;
        seen.add(item.url);
        merged.push(item);
    }
    return merged.sort((a, b) => newsItemTime(b) - newsItemTime(a)).slice(0, NEWS_SOURCE_MAX_SAVED);
}
function storeNewsSource(id, value) {
    newsSourceMemory.set(id, value);
    try { localStorage.setItem(newsSourceCacheKey(id), JSON.stringify(value)); } catch {}
    return value;
}
function writeNewsSourceCache(id, items, { relayPaging = false, relayHasMore = false } = {}) {
    const previous = readNewsSourceCache(id);
    const tracked = Boolean(previous?.nextPage);
    // MyAnimeList's older stories come from its own news pages, so it can always go further back.
    const done = tracked ? Boolean(previous.done) : (id === 'mal' ? false : !(relayPaging && relayHasMore));
    return storeNewsSource(id, { items: mergeNewsItems(items, previous?.items || []), savedAt: Date.now(), nextPage: tracked ? previous.nextPage : 2, done });
}
const canLoadMoreNews = (id) => { const saved = readNewsSourceCache(id); return Boolean(saved) && !saved.done; };
const newsMoreInflight = new Map();
// One more page of older stories from a site. Resolves to how many new stories it added.
function fetchMoreNews(id) {
    if (newsMoreInflight.has(id)) return newsMoreInflight.get(id);
    const task = (async () => {
        const saved = readNewsSourceCache(id);
        if (!saved || saved.done) return 0;
        const page = saved.nextPage || 2;
        let fresh = [], more = false;
        if (id === 'mal') {
            const result = await fetchMalNewsPage(page);
            fresh = (result.items || []).filter(item => item?.title && /^https:\/\//.test(item.url || '')).map(item => ({ ...item, source: 'mal' }));
            more = Boolean(result.hasNextPage);
        } else {
            const relay = newsRelayUrl();
            if (!relay) return 0;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), NEWS_SOURCE_TIMEOUT_MS);
            let payload = null;
            try {
                const response = await fetch(`${relay}/public/news?source=${encodeURIComponent(id)}&page=${page}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
                try { payload = await response.json(); } catch {}
                if (!response.ok) throw new Error(payload?.message || `${newsSourceInfo(id).name} could not be reached.`);
            } finally { clearTimeout(timer); }
            fresh = (payload?.items || []).map(item => cleanRelayNewsItem(item, id)).filter(Boolean);
            more = payload?.hasMore === true;
        }
        const current = readNewsSourceCache(id) || saved;
        const known = new Set(current.items.map(item => item.url));
        const added = fresh.filter(item => !known.has(item.url)).length;
        // Nothing new (an older relay that ignores ?page, or the end of the site): stop asking.
        storeNewsSource(id, { ...current, items: mergeNewsItems(current.items, fresh), nextPage: page + 1, done: !more || added === 0 });
        return added;
    })().finally(() => newsMoreInflight.delete(id));
    newsMoreInflight.set(id, task);
    return task;
}
// The relay's answer is treated as untrusted: plain text only, https links and pictures only.
function cleanRelayNewsItem(raw, source) {
    const title = plainNewsText(raw?.title).slice(0, 300);
    const url = String(raw?.url || '');
    if (!title || !/^https:\/\/[^\s"'<>]+$/i.test(url)) return null;
    const when = raw?.date ? new Date(raw.date) : null;
    const thumbnail = safeNewsImage(raw?.image);
    return {
        source, title, url,
        date: when && !Number.isNaN(when.getTime()) ? when.toISOString() : '',
        excerpt: plainNewsText(raw?.excerpt).slice(0, 500),
        image: source === 'mal' ? safeNewsImage(fullSizeMalImage(thumbnail)) : thumbnail,
        thumbnail,
    };
}
function fetchNewsSource(id, { force = false } = {}) {
    if (newsSourceInflight.has(id)) return newsSourceInflight.get(id);
    const name = newsSourceInfo(id).name;
    const task = (async () => {
        const relay = newsRelayUrl();
        if (!relay) throw new Error('No AniZone relay is set up.');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), NEWS_SOURCE_TIMEOUT_MS);
        let response, payload = null;
        try {
            response = await fetch(`${relay}/public/news?source=${encodeURIComponent(id)}`, { signal: controller.signal, cache: force ? 'no-store' : 'default', headers: { Accept: 'application/json' } });
            try { payload = await response.json(); } catch {}
        } catch (error) {
            throw new Error(error.name === 'AbortError' ? `${name} took too long to answer.` : `${name} could not be reached.`);
        } finally { clearTimeout(timer); }
        if (response.status === 404 && payload?.error !== 'unknown_source') {
            newsRelaySupport = 'no';           // the relay predates multi-source news
            throw new Error('The AniZone relay needs updating for news from other sites.');
        }
        if (!response.ok) throw new Error(payload?.message || `${name} could not be reached.`);
        newsRelaySupport = 'yes';
        const items = (payload?.items || []).map(item => cleanRelayNewsItem(item, id)).filter(Boolean);
        if (!items.length) throw new Error(`${name} sent no stories.`);
        return writeNewsSourceCache(id, items, { relayPaging: Boolean(payload && 'hasMore' in payload), relayHasMore: payload?.hasMore === true });
    })().then(result => { newsSourceErrors.delete(id); return result; }, error => { newsSourceErrors.set(id, error.message); throw error; })
        .finally(() => newsSourceInflight.delete(id));
    newsSourceInflight.set(id, task);
    return task;
}
function mergedNews(ids) {
    const seen = new Set();
    const items = [];
    for (const id of ids) for (const item of readNewsSourceCache(id)?.items || []) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        items.push({ ...item, source: id });
    }
    const time = (item) => item.date ? new Date(item.date).getTime() : 0;
    return items.sort((a, b) => time(b) - time(a));
}
function renderNewsSourceTabs() {
    const bar = document.getElementById('news-sources');
    if (!bar) return;
    const show = multiSourceNewsAvailable();
    bar.classList.toggle('hidden', !show);
    if (!show) return;
    const has = (id) => Boolean(readNewsSourceCache(id)?.items?.length);
    const tab = (id, label, extra = '') => `<a class="news-tab${newsSource === id ? ' active' : ''}${extra}" href="${newsHash(id)}"${newsSource === id ? ' aria-current="page"' : ''}>${id === 'all' ? '' : `<i class="news-dot news-src-${id}" aria-hidden="true"></i>`}${escapeHtml(label)}</a>`;
    bar.innerHTML = tab('all', 'All news') + NEWS_SOURCES.map(source => {
        const failed = newsSourceErrors.has(source.id) && !has(source.id);
        return tab(source.id, source.name, failed ? ' unavailable' : '');
    }).join('');
    bar.querySelectorAll('.news-tab.unavailable').forEach(link => { link.title = `${link.textContent} isn't reachable right now`; });
    // On phones the tabs scroll sideways: keep the chosen one in view.
    const active = bar.querySelector('.news-tab.active');
    if (active && bar.scrollWidth > bar.clientWidth) bar.scrollLeft = Math.max(0, active.offsetLeft - bar.offsetLeft - (bar.clientWidth - active.offsetWidth) / 2);
}
function setNewsStatusWithAction(text, label, action) {
    setNewsStatus(text);
    const status = document.getElementById('news-status');
    if (!status || !label) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'news-status-action';
    button.textContent = label;
    button.addEventListener('click', action);
    status.append(' ', button);
}
function newsProblemNote(ids) {
    const failed = ids.filter(id => newsSourceErrors.has(id));
    if (!failed.length) return '';
    const names = failed.map(id => newsSourceInfo(id).name);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    const saved = failed.every(id => readNewsSourceCache(id));
    return saved ? `Showing saved stories from ${list}; it couldn't be reached just now.` : `${list} couldn't be reached just now.`;
}

async function loadNews(force = false, page = 1) {
    const requestedPage = Math.max(1, Number(page) || 1);
    renderNewsSourceTabs();
    if (!multiSourceNewsAvailable()) return loadMalNews(force, requestedPage);
    return loadMultiSourceNews(force, requestedPage);
}

async function loadMultiSourceNews(force, page) {
    const grid = document.getElementById('news-grid');
    if (!grid) return false;
    const token = ++newsRenderToken;
    pendingNewsRedraw = null;
    newsPage = page;
    const ids = newsSource === 'all' ? NEWS_SOURCES.map(source => source.id) : [newsSource];
    const sourceLink = newsSourceInfo(newsSource === 'all' ? 'mal' : newsSource);

    const draw = () => {
        if (token !== newsRenderToken) return false;
        pendingNewsRedraw = null;
        renderNewsSourceTabs();
        const list = mergedNews(ids);
        if (!list.length) return false;
        const pages = Math.ceil(list.length / NEWS_PAGE_SIZE);
        const current = Math.min(page, pages);
        newsPage = current;
        renderNewsItems(list.slice((current - 1) * NEWS_PAGE_SIZE, current * NEWS_PAGE_SIZE), grid);
        updateNewsPagination({ currentPage: current, hasNextPage: current < pages || ids.some(canLoadMoreNews) });
        return true;
    };
    // Older stories: when this page goes past what's saved, fetch older pages from each site
    // (a few rounds at most). Near the end of what's saved, fetch the next lot in the background.
    const enough = () => mergedNews(ids).length >= page * NEWS_PAGE_SIZE;
    const deepen = async () => {
        if (token !== newsRenderToken) return;
        if (!enough() && ids.some(canLoadMoreNews)) {
            setNewsStatus('Loading older stories…');
            grid.classList.add('is-refreshing');
            for (let round = 0; round < 6 && !enough() && ids.some(canLoadMoreNews); round++) {
                await Promise.allSettled(ids.filter(canLoadMoreNews).map(fetchMoreNews));
                if (token !== newsRenderToken) return;
            }
            grid.classList.remove('is-refreshing');
            setNewsStatus(newsProblemNote(ids));
            draw();
        }
        if (token !== newsRenderToken) return;
        const pages = Math.ceil(mergedNews(ids).length / NEWS_PAGE_SIZE);
        if (newsPage >= pages - 1 && ids.some(canLoadMoreNews)) {
            Promise.allSettled(ids.filter(canLoadMoreNews).map(fetchMoreNews)).then(() => {
                if (token !== newsRenderToken) return;
                const total = Math.ceil(mergedNews(ids).length / NEWS_PAGE_SIZE);
                updateNewsPagination({ currentPage: newsPage, hasNextPage: newsPage < total || ids.some(canLoadMoreNews) });
            });
        }
    };
    // New stories while someone is reading: offer them instead of reshuffling the page.
    const redraw = () => {
        if (token !== newsRenderToken) return;
        renderNewsSourceTabs();
        const reading = window.scrollY > 300 && grid.querySelector('.news-card:not(.news-skeleton)');
        if (!reading) { draw(); return; }
        pendingNewsRedraw = draw;
    };

    const shown = draw();
    if (!shown) { renderNewsSkeletons(grid); updateNewsPagination({ currentPage: page, hasNextPage: false }); }
    const stale = ids.filter(id => force || !isNewsFresh(readNewsSourceCache(id)));
    if (!stale.length) { setNewsStatus(newsProblemNote(ids)); await deepen(); return true; }
    setNewsStatus(shown ? 'Checking for newer stories…' : '');
    if (shown && force) grid.classList.add('is-refreshing');

    let painted = shown;
    const tasks = stale.map(id => fetchNewsSource(id, { force }).then(() => { if (painted) redraw(); }, () => {}));
    if (!painted) {
        await Promise.race([Promise.allSettled(tasks), waitMs(NEWS_FIRST_PAINT_MS)]);
        if (token !== newsRenderToken) return false;
        painted = draw();
    }
    await Promise.allSettled(tasks);
    if (token !== newsRenderToken) return false;
    grid.classList.remove('is-refreshing');
    grid.removeAttribute('aria-busy');
    if (newsRelaySupport === 'no') { renderNewsSourceTabs(); return loadMalNews(force, page); }   // older relay: MyAnimeList only
    if (!painted && !draw()) {
        renderNewsSourceTabs();
        updateNewsPagination({ currentPage: 1, hasNextPage: false });
        setNewsStatus('');
        grid.innerHTML = `<div class="empty-state api-error"><strong>${escapeHtml(newsSource === 'all' ? 'News is temporarily unavailable.' : `${sourceLink.name} is temporarily unavailable.`)}</strong><a class="btn-secondary inline-action" href="${escapeHtml(sourceLink.link)}" target="_blank" rel="noopener">Open ${escapeHtml(sourceLink.name)} ↗</a></div>`;
        return false;
    }
    if (pendingNewsRedraw) setNewsStatusWithAction(newsProblemNote(ids) || 'Newer stories are ready.', 'Show them', () => { scrollPageToTop(); draw(); setNewsStatus(newsProblemNote(ids)); });
    else { setNewsStatus(newsProblemNote(ids)); await deepen(); }
    return true;
}

function setNewsStatus(text = '') {
    const status = document.getElementById('news-status');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('hidden', !text);
}
function renderNewsSkeletons(grid, count = 6) {
    grid.innerHTML = Array.from({ length: count }, () => '<article class="news-card news-skeleton" aria-hidden="true"><div class="news-card-image"></div><div class="news-card-body"><i></i><i></i><i></i></div></article>').join('');
    grid.setAttribute('aria-busy', 'true');
}

// MyAnimeList only, through public relays: used when the AniZone relay can't serve
// news (not set up, or an older relay), and for MyAnimeList pages 2 and later.
async function loadMalNews(force = false, page = newsPage) {
    const grid = document.getElementById('news-grid');
    if (!grid) return false;
    const requestedPage = Math.max(1, Number(page) || 1);
    const token = ++newsRenderToken;
    const cached = force ? null : readNewsCache(requestedPage);
    const showingStories = Boolean(grid.querySelector('.news-card:not(.news-skeleton)'));

    if (cached) {
        // Saved stories appear straight away; fresh ones replace them if needed.
        newsPage = requestedPage;
        renderNewsItems(cached.items, grid);
        updateNewsPagination({ currentPage: newsPage, hasNextPage: cached.hasNextPage });
        if (isNewsFresh(cached)) {
            setNewsStatus('');
            if (cached.hasNextPage) prefetchNewsPage(newsPage + 1);
            return true;
        }
        setNewsStatus('Checking for newer stories…');
    } else if (showingStories) {
        grid.classList.add('is-refreshing');
        setNewsStatus(requestedPage === newsPage ? 'Refreshing…' : `Loading page ${requestedPage}…`);
        document.getElementById('news-prev-btn')?.setAttribute('disabled', '');
        document.getElementById('news-next-btn')?.setAttribute('disabled', '');
    } else {
        renderNewsSkeletons(grid);
        setNewsStatus('');
        updateNewsPagination({ currentPage: requestedPage, hasNextPage: false });
    }

    try {
        const result = await fetchMalNewsPage(requestedPage, { force });
        if (token !== newsRenderToken) return false;
        newsPage = requestedPage;
        const unchanged = cached && cached.items.map(item => item.url).join() === result.items.map(item => item.url).join();
        if (!unchanged) renderNewsItems(result.items, grid);
        updateNewsPagination({ currentPage: newsPage, hasNextPage: result.hasNextPage });
        setNewsStatus('');
        if (result.hasNextPage) prefetchNewsPage(newsPage + 1);
        return true;
    } catch (error) {
        if (token !== newsRenderToken) return false;
        if (cached) {
            setNewsStatus('Showing saved stories. MyAnimeList could not be reached just now.');
        } else if (showingStories) {
            updateNewsPagination({ currentPage: newsPage, hasNextPage: true });
            setNewsStatus('');
            siteAlert('That MyAnimeList news page could not be loaded. Your current page has been kept.', { title: 'News unavailable' });
        } else {
            updateNewsPagination({ currentPage: newsPage, hasNextPage: false });
            setNewsStatus('');
            grid.innerHTML = `<div class="empty-state api-error"><strong>MyAnimeList news is temporarily unavailable.</strong><a class="btn-secondary inline-action" href="https://myanimelist.net/news" target="_blank" rel="noopener">Open MyAnimeList News ↗</a></div>`;
        }
        return false;
    } finally {
        if (token === newsRenderToken) {
            grid.classList.remove('is-refreshing');
            grid.removeAttribute('aria-busy');
        }
    }
}

function updateNewsPagination(pageInfo = {}) {
    const controls = document.getElementById('news-pagination');
    const label = document.getElementById('news-page-label');
    const previous = document.getElementById('news-prev-btn');
    const next = document.getElementById('news-next-btn');
    if (!controls || !label || !previous || !next) return;
    const current = Number(pageInfo.currentPage || newsPage || 1);
    label.textContent = `Page ${current}`;
    previous.disabled = current <= 1;
    next.disabled = !pageInfo.hasNextPage;
    controls.classList.toggle('hidden', current <= 1 && !pageInfo.hasNextPage);
}

function newsDateLabel(iso) {
    const date = iso ? new Date(iso) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes >= 0 && minutes < 60) return minutes <= 1 ? 'Just now' : `${minutes} minutes ago`;
    if (minutes >= 0 && minutes < 24 * 60) return `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? '' : 's'} ago`;
    return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderNewsItems(items, grid = document.getElementById('news-grid')) {
    if (!grid) return;
    grid.removeAttribute('aria-busy');
    if (!items.length) {
        grid.innerHTML = '<div class="empty-state">No recent news stories were returned.</div>';
        return;
    }
    grid.innerHTML = items.slice(0, NEWS_PAGE_SIZE).map((item, index) => {
        const image = item.image || item.thumbnail || '';
        const fallback = item.thumbnail && item.thumbnail !== image ? item.thumbnail : '';
        const picture = image
            ? `<img src="${escapeHtml(image)}"${fallback ? ` data-fallback="${escapeHtml(fallback)}"` : ''} alt="" ${index < 3 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" referrerpolicy="no-referrer">`
            : '';
        const source = newsSourceInfo(item.source || 'mal');
        const dateLabel = newsDateLabel(item.date);
        return `<article class="news-card"><div class="news-card-image${image ? '' : ' image-missing'}">${picture}<span>${escapeHtml(source.name)}</span></div><div class="news-card-body"><small><b class="news-src-label"><i class="news-dot news-src-${escapeHtml(source.id)}" aria-hidden="true"></i>${escapeHtml(source.name)}</b>${dateLabel ? ` · ${escapeHtml(dateLabel)}` : ''}</small><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml((item.excerpt || '').slice(0, 240))}</p><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Read on ${escapeHtml(source.name)} →</a></div></article>`;
    }).join('');
    // Full-size picture failed? Fall back to MAL's thumbnail, then to the placeholder.
    grid.querySelectorAll('.news-card-image img').forEach(img => img.addEventListener('error', () => {
        if (img.dataset.fallback) {
            img.src = img.dataset.fallback;
            delete img.dataset.fallback;
        } else {
            img.parentElement.classList.add('image-missing');
            img.remove();
        }
    }));
}

function enhanceSelect(select){
    if(!select||select.dataset.azEnhanced==='true')return;
    select.dataset.azEnhanced='true'; select.classList.add('visually-hidden-select');
    const wrap=document.createElement('div'); wrap.className='az-select';
    select.parentNode.insertBefore(wrap,select); wrap.appendChild(select);
    const trigger=document.createElement('button'); trigger.type='button'; trigger.className='az-select-trigger';
    const menu=document.createElement('div'); menu.className='az-select-menu hidden'; menu.setAttribute('role','listbox');
    wrap.append(trigger,menu);
    const rebuild=()=>{
        const selected=select.options[select.selectedIndex]; trigger.textContent=selected?.textContent||'Select';
        menu.innerHTML=''; [...select.options].forEach(option=>{const button=document.createElement('button');button.type='button';button.className=`az-select-option${option.selected?' selected':''}`;button.textContent=option.textContent;button.disabled=option.disabled;button.onclick=()=>{select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));close();};menu.appendChild(button);});
    };
    const close=()=>{wrap.classList.remove('open');menu.classList.add('hidden');};
    trigger.onclick=e=>{e.stopPropagation();document.querySelectorAll('.az-select.open').forEach(node=>{if(node!==wrap){node.classList.remove('open');node.querySelector('.az-select-menu')?.classList.add('hidden');}});rebuild();wrap.classList.toggle('open');menu.classList.toggle('hidden',!wrap.classList.contains('open'));const chosen=menu.querySelector('.az-select-option.selected');if(chosen&&wrap.classList.contains('open'))menu.scrollTop=Math.max(0,chosen.offsetTop-menu.clientHeight/2+chosen.offsetHeight/2);};
    select._azRebuild=rebuild;
    select.addEventListener('change',rebuild); rebuild();
}
function enhanceAllSelects(){ document.querySelectorAll('select').forEach(enhanceSelect); }
function syncCustomSelects(){ document.querySelectorAll('select[data-az-enhanced="true"]').forEach(select=>select.dispatchEvent(new Event('change'))); }
document.addEventListener('click',()=>document.querySelectorAll('.az-select.open').forEach(node=>{node.classList.remove('open');node.querySelector('.az-select-menu')?.classList.add('hidden');}));

function initDetailPreferences(){
    const button=document.getElementById('detail-preferences-btn');
    const panel=document.getElementById('detail-preferences-panel');
    if(!button||!panel)return;
    const sync=()=>{const prefs=getDetailPrefs();panel.querySelectorAll('[data-detail-pref]').forEach(input=>input.checked=prefs[input.dataset.detailPref]!==false);};
    button.onclick=()=>{sync();panel.classList.toggle('hidden');};
    panel.addEventListener('change',event=>{const input=event.target.closest('[data-detail-pref]');if(!input)return;const name=input.dataset.detailPref;const prefs=getDetailPrefs();prefs[name]=input.checked;saveJson(DETAIL_PREFS_KEY,prefs);applyDetailPreferences();if(currentDetailAnime&&input.checked)renderDetailSection(name,currentDetailAnime);if(name==='countdown'&&!input.checked)clearInterval(countdownTimer);});
    document.addEventListener('click',event=>{if(!panel.contains(event.target)&&event.target!==button)panel.classList.add('hidden');});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.classList.contains('hidden')){panel.classList.add('hidden');button.focus();}});
}
function initConnectedExperience(){
    initThemes();
    enhanceAllSelects();
    syncDiscoverAdultFilter();
    initGridDiscoverFilters();
    initDetailPreferences();
    document.getElementById('refresh-news-btn')?.addEventListener('click',()=>loadNews(true, newsPage));
    document.getElementById('news-prev-btn')?.addEventListener('click',()=>{ if(newsPage > 1) { scrollPageToTop(); navigate(newsHash(newsSource, newsPage - 1)); } });
    document.getElementById('news-next-btn')?.addEventListener('click',()=>{ scrollPageToTop(); navigate(newsHash(newsSource, newsPage + 1)); });
    scheduleNewsPrefetch();
    const baseRender=renderAnimeDetails;
    renderAnimeDetails=function(anime){ detailSectionState={animeId:null,loaded:new Set()}; baseRender(anime); renderEnhancedDetails(anime); };
}
document.addEventListener('DOMContentLoaded',initConnectedExperience);
// Show the page named in the address. This runs after both setup functions above
// so that an anime page opened from a shared link gets every section.
document.addEventListener('DOMContentLoaded',()=>renderRoute());

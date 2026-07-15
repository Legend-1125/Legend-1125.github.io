// AniZone — AniList GraphQL edition
// Single-file application data layer, routing, rendering and local cache.

const ANILIST_API = 'https://graphql.anilist.co';
const JIKAN_API = 'https://api.jikan.moe/v4';
const MAL_SCORE_PREFIX = 'anizone:mal-score:v1:';
const MAL_SCORE_TTL = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 24;
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
let selectedSearchYear = '';
let selectedSearchOrder = 'default';
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

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
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
    const element = document.createElement('div');
    element.innerHTML = value || '';
    return element.textContent || element.innerText || '';
}
function showLoading(show) { loading?.classList.toggle('hidden', !show); }
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
async function jikanRequest(path, { retries = 1, ttl = JIKAN_DEFAULT_TTL, force = false } = {}) {
    if (!force) {
        const cached = jikanCacheRead(path);
        if (cached) return cached;
    }
    if (jikanInflight.has(path)) return jikanInflight.get(path);
    const task = jikanQueue = jikanQueue.catch(() => {}).then(async () => {
        const stale = jikanCacheRead(path, true);
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const wait = Math.max(0, jikanCooldownUntil - Date.now(), 1250 - (Date.now() - lastJikanRequestAt));
                if (wait) await delay(wait);
                lastJikanRequestAt = Date.now();
                const response = await fetch(`${JIKAN_API}${path}`, { headers: { Accept: 'application/json' } });
                let payload = null;
                try { payload = await response.json(); } catch {}
                if (response.ok) { jikanCacheWrite(path, payload, ttl); return payload; }
                const retryAfter = Number(response.headers.get('Retry-After')) || Math.min(12, 2 ** (attempt + 1));
                if (response.status === 429) jikanCooldownUntil = Date.now() + retryAfter * 1000;
                lastError = new Error(response.status === 429 ? 'Extra MyAnimeList data is temporarily rate-limited.' : (payload?.message || `Jikan request failed (${response.status}).`));
                if ((response.status === 429 || response.status >= 500) && attempt < retries) { await delay(retryAfter * 1000); continue; }
                break;
            } catch (error) {
                lastError = error;
                if (attempt < retries) { await delay((attempt + 1) * 1200); continue; }
            }
        }
        if (stale) return stale;
        throw lastError || new Error('Unable to load extra MyAnimeList data.');
    }).finally(() => jikanInflight.delete(path));
    jikanInflight.set(path, task);
    return task;
}
async function getJikanAnimeFull(malId) {
    if (!malId) return null;
    const payload = await jikanRequest(`/anime/${Number(malId)}/full`, { retries: 0, ttl: 24 * 60 * 60 * 1000 });
    return payload?.data || null;
}
async function fetchMalScore(malId) {
    if (!malId) return null;
    const cached = getCachedMalScore(malId);
    if (cached != null) return cached;

    let score = null;
    try {
            const payload = await jikanRequest(`/anime/${Number(malId)}`, { retries: 1, ttl: 24 * 60 * 60 * 1000 });
            score = payload?.data?.score ?? null;
    } catch {
        const staleCompact = jikanCacheRead(`/anime/${Number(malId)}`, true);
        const staleFull = jikanCacheRead(`/anime/${Number(malId)}/full`, true);
        score = staleCompact?.data?.score ?? staleFull?.data?.score ?? null;
    }
    if (score != null) setCachedMalScore(malId, score);
    return score;
}

async function getAnimeByMalId(malId) {
    const query = `query ($idMal: Int!) {
        Media(idMal: $idMal, type: ANIME) { id idMal isAdult title { romaji english native } }
    }`;
    return aniRequest(query, { idMal: Number(malId) });
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
const aniInflight = new Map();
let aniQueue = Promise.resolve();
let aniLastRequestAt = 0;
let aniCooldownUntil = 0;
let aniRemaining = 30;
let aniResetAt = 0;

function cacheGetStale(key) {
    try {
        const record = JSON.parse(localStorage.getItem(CACHE_PREFIX + key) || 'null');
        if (!record || !record.value) return null;
        const agePastExpiry = Date.now() - Number(record.expiresAt || 0);
        return agePastExpiry <= ANILIST_CACHE_STALE_TTL ? record.value : null;
    } catch { return null; }
}

function updateAniRateState(response) {
    const remaining = Number(response.headers.get('X-RateLimit-Remaining'));
    const reset = Number(response.headers.get('X-RateLimit-Reset'));
    if (Number.isFinite(remaining)) aniRemaining = remaining;
    if (Number.isFinite(reset) && reset > 0) aniResetAt = reset > 10_000_000_000 ? reset : reset * 1000;
    const retryAfter = Number(response.headers.get('Retry-After'));
    if (response.status === 429) {
        const fallback = aniResetAt > Date.now() ? aniResetAt - Date.now() : 65_000;
        aniCooldownUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : fallback);
    }
}

async function aniRequest(query, variables = {}, options = {}) {
    const { cacheKey = '', ttl = 0, signal, priority = 'normal' } = options;
    const inflightKey = cacheKey || `${query}:${JSON.stringify(variables)}`;
    if (cacheKey) {
        const cached = cacheGet(cacheKey);
        if (cached) return cached;
    }
    if (aniInflight.has(inflightKey)) return aniInflight.get(inflightKey);

    const task = aniQueue = aniQueue.catch(() => {}).then(async () => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const stale = cacheKey ? cacheGetStale(cacheKey) : null;
        // AniList documents a temporary degraded limit of 30 requests/minute.
        // Keep the client below that ceiling and stop retry storms when the API says 429.
        const baseSpacing = priority === 'interactive' ? 2050 : 2200;
        const waitForSpacing = baseSpacing - (Date.now() - aniLastRequestAt);
        const waitForReset = aniRemaining <= 1 && aniResetAt > Date.now() ? aniResetAt - Date.now() + 500 : 0;
        const wait = Math.max(0, aniCooldownUntil - Date.now(), waitForSpacing, waitForReset);
        if (wait) await delay(wait);
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        let response;
        try {
            aniLastRequestAt = Date.now();
            response = await fetch(ANILIST_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ query, variables }),
                signal,
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
    }).finally(() => aniInflight.delete(inflightKey));

    aniInflight.set(inflightKey, task);
    return task;
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
    recommendations(sort: RATING_DESC, perPage: 12) { nodes { rating mediaRecommendation { id idMal isAdult title { romaji english native } coverImage { medium large extraLarge } averageScore format status episodes } } }
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
                id isAdult type format status episodes
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
function formatVariable(value) {
    const map = { tv: 'TV', movie: 'MOVIE', ova: 'OVA', ona: 'ONA', special: 'SPECIAL' };
    return map[value] || null;
}
function statusVariable(value) {
    return ({ airing: 'RELEASING', complete: 'FINISHED', upcoming: 'NOT_YET_RELEASED' })[value] || null;
}
function minimumScore(value) { return value ? Number(value) : null; }

async function getTrending(page = 1, perPage = PAGE_SIZE) {
    const query = mediaPageQuery('', `, sort: TRENDING_DESC${adultArgument()}`);
    return aniRequest(query, { page, perPage }, { cacheKey: `trending:${adultContentEnabled}:${page}:${perPage}`, ttl: CACHE_TTL.trending });
}
async function getTopRated(page = 1, perPage = PAGE_SIZE) {
    const query = mediaPageQuery('', `, sort: SCORE_DESC${adultArgument()}`);
    return aniRequest(query, { page, perPage }, { cacheKey: `top:${adultContentEnabled}:${page}:${perPage}`, ttl: CACHE_TTL.top });
}
function buildMediaPageRequest({ page = 1, perPage = PAGE_SIZE, filters = {}, sort = null, cachePrefix = 'media', ttl = CACHE_TTL.search, signal } = {}) {
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
    addVariable('genre', 'String', filters.genre);
    addVariable('format', 'MediaFormat', formatVariable(filters.type));
    addVariable('status', 'MediaStatus', statusVariable(filters.status));
    addVariable('minimumScore', 'Int', minimumScore(filters.rating), 'averageScore_greater');

    let adultValue = null;
    if (!adultContentEnabled) adultValue = false;
    else if (filters.adultMode === 'regular') adultValue = false;
    else if (filters.adultMode === 'adult') adultValue = true;
    addVariable('isAdult', 'Boolean', adultValue);

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
    const cacheKey = `${cachePrefix}:${adultContentEnabled}:${JSON.stringify(variables)}`;
    return aniRequest(query, variables, { cacheKey, ttl, signal });
}

async function getDiscover(page = 1, perPage = PAGE_SIZE) {
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
        cachePrefix: 'discover',
        ttl: CACHE_TTL.discover,
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

async function getStudioAnime(studioId, page = 1, perPage = PAGE_SIZE, filters = {}) {
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

async function getAnimeDetails(id) {
    const query = `query ($id: Int!) { Media(id: $id, type: ANIME) { ${MEDIA_DETAIL_FIELDS} } }`;
    return aniRequest(query, { id: Number(id) }, { cacheKey: `detail:${id}`, ttl: CACHE_TTL.details });
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

function syncViewRoute(targetViewId, pushState = true, extraState = {}) {
    views.forEach(view => view.classList.add('hidden'));
    document.getElementById(targetViewId)?.classList.remove('hidden');
    navButtons.forEach(button => button.classList.toggle('active', button.dataset.tab === targetViewId));
    if (pushState) history.pushState({ view: targetViewId, ...extraState }, '', '');
    window.scrollTo({ top: 0 });
}
function handleBrowserBackNavigation(event) {
    const state = event.state;
    if (!state) return;
    if (state.view === 'view-details' && state.animeId) viewSingleAnime(state.animeId, false);
    else if (state.view === 'view-results' && state.target) restoreResultsGridState(state);
    else {
        syncViewRoute(state.view, false);
        if (state.view === 'view-history') renderHistoryLogGrid();
        if (state.view === 'view-schedule') initScheduleView();
    }
}
function restoreResultsGridState(state) {
    currentActiveRowTarget = state.target;
    currentPage = state.page || 1;
    currentSearchQuery = state.query || currentSearchQuery;
    selectedStudioId = state.studioId || selectedStudioId;
    selectedStudioName = state.studioName || selectedStudioName;
    configureResultsHeader(currentActiveRowTarget);
    syncViewRoute('view-results', false);
    fetchExpandedGridData();
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
        if (target === 'studio') title.textContent = `Studio: ${selectedStudioName}`;
    }
}

function initNavigation() {
    navButtons.forEach(button => button.addEventListener('click', () => {
        const tab = button.dataset.tab;
        if (!tab) return;
        syncViewRoute(tab, true);
        if (tab === 'view-history') renderHistoryLogGrid();
        if (tab === 'view-schedule') initScheduleView();
    }));
    document.getElementById('logo-btn')?.addEventListener('click', () => syncViewRoute('view-home', true));
    document.getElementById('shuffle-btn')?.addEventListener('click', triggerRandomShuffle);
    document.getElementById('grid-back-btn')?.addEventListener('click', () => history.back());
    document.getElementById('back-btn')?.addEventListener('click', () => history.back());
    const hamburger = document.getElementById('hamburger-btn');
    const panel = document.getElementById('nav-menu-panel');
    hamburger?.addEventListener('click', () => {
        const open = hamburger.getAttribute('aria-expanded') === 'true';
        hamburger.setAttribute('aria-expanded', String(!open));
        hamburger.classList.toggle('open');
        panel?.classList.toggle('open-panel');
    });
}

function initPreferences() {
    const adultToggle = document.getElementById('adult-content-toggle');
    const languageSelect = document.getElementById('title-language-select');
    if (adultToggle) adultToggle.checked = adultContentEnabled;
    if (languageSelect) languageSelect.value = titleLanguage;

    adultToggle?.addEventListener('change', async event => {
        adultContentEnabled = event.target.checked;
        localStorage.setItem('anizoneAdultEnabled', String(adultContentEnabled));
        if (adultContentEnabled && selectedDiscoverAdult === 'regular') selectedDiscoverAdult = 'both';
        if (!adultContentEnabled) selectedDiscoverAdult = 'regular';
        localStorage.setItem('anizoneDiscoverAdultMode', selectedDiscoverAdult);
        syncDiscoverAdultFilter();
        await loadDashboardRows();
        if (currentActiveRowTarget && !document.getElementById('view-results')?.classList.contains('hidden')) fetchExpandedGridData();
    });
    languageSelect?.addEventListener('change', event => {
        titleLanguage = event.target.value;
        localStorage.setItem('anizoneTitleLanguage', titleLanguage);
        updateVisibleTitlesForLanguage();
    });
}


function updateVisibleTitlesForLanguage() {
    document.querySelectorAll('.anime-card').forEach(card => {
        const anime = card._animeData;
        const titleNode = card.querySelector('.anime-card-title');
        if (!anime || !titleNode) return;
        const title = displayTitle(anime);
        const alt = secondaryTitle(anime);
        titleNode.innerHTML = `${escapeHtml(title)}${alt ? `<span>${escapeHtml(alt)}</span>` : ''}`;
        const image = card.querySelector('img');
        if (image) image.alt = title;
    });
    if (heroSlides[heroSlideIndex]) renderHeroSlide(heroSlideIndex);
    if (currentDetailAnime && !document.getElementById('view-details')?.classList.contains('hidden')) {
        const primary = displayTitle(currentDetailAnime);
        const alternate = secondaryTitle(currentDetailAnime);
        const title = document.getElementById('detail-title');
        if (title) title.innerHTML = `${escapeHtml(primary)}${alternate ? `<span class="detail-alt-title">${escapeHtml(alternate)}</span>` : ''}`;
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
        suggestionController?.abort();
        suggestionsDropdown?.classList.add('hidden');
        const query = searchInput.value.trim();
        if (query) {
            executeGlobalSearch(query, 1);
            collapseSearch();
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
        suggestionsDropdown.innerHTML = '';
        anime.forEach(item => {
            const row = document.createElement('div');
            row.className = 'suggestion-item';
            const alt = secondaryTitle(item);
            row.innerHTML = `<span><strong>${escapeHtml(displayTitle(item))}</strong>${alt ? `<small>${escapeHtml(alt)}</small>` : ''}</span><span class="sug-score">${item.averageScore ? `★ ${(item.averageScore / 10).toFixed(1)}` : 'N/A'}</span>`;
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

async function getDashboardBundle() {
    const seasonArgs = selectedDiscoverSeason ? ', season: $season' : '';
    const yearArgs = selectedDiscoverYear ? ', seasonYear: $seasonYear' : '';
    const genreArgs = selectedDiscoverGenre ? ', genre: $genre' : '';
    const query = `query ($perPage: Int!${selectedDiscoverSeason ? ', $season: MediaSeason' : ''}${selectedDiscoverYear ? ', $seasonYear: Int' : ''}${selectedDiscoverGenre ? ', $genre: String' : ''}) {
        trending: Page(page: 1, perPage: $perPage) { media(type: ANIME, sort: TRENDING_DESC${adultArgument()}) { ${MEDIA_CARD_FIELDS} } }
        top: Page(page: 1, perPage: $perPage) { media(type: ANIME, sort: SCORE_DESC${adultArgument()}) { ${MEDIA_CARD_FIELDS} } }
        discover: Page(page: 1, perPage: $perPage) { media(type: ANIME, sort: POPULARITY_DESC${seasonArgs}${yearArgs}${genreArgs}${adultArgument()}) { ${MEDIA_CARD_FIELDS} } }
    }`;
    const variables = { perPage: 20 };
    if (selectedDiscoverSeason) variables.season = selectedDiscoverSeason;
    if (selectedDiscoverYear) variables.seasonYear = Number(selectedDiscoverYear);
    if (selectedDiscoverGenre) variables.genre = selectedDiscoverGenre;
    return aniRequest(query, variables, {
        cacheKey: `dashboard:${adultContentEnabled}:${selectedDiscoverSeason}:${selectedDiscoverYear}:${selectedDiscoverGenre}`,
        ttl: CACHE_TTL.trending,
        priority: 'interactive',
    });
}

async function loadDashboardRows() {
    showLoading(true);
    try {
        const data = await getDashboardBundle();
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
        showLoading(false);
    }
}
function renderRowError(trackId, error, retry) {
    console.error(trackId, error);
    const track = document.getElementById(trackId);
    if (!track) return;
    track.innerHTML = `<div class="empty-state api-error">Unable to load this section.<button class="inline-retry-btn">Retry</button></div>`;
    track.querySelector('.inline-retry-btn')?.addEventListener('click', retry);
}
function renderSliderTrack(trackId, dataset) {
    const track = document.getElementById(trackId);
    if (!track) return;
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
    card.innerHTML = `<img src="${escapeHtml(imageUrl(anime))}" alt="${escapeHtml(title)}" loading="lazy">${anime.isAdult ? '<span class="adult-card-badge">18+</span>' : ''}<div class="anime-card-overlay"></div><div class="anime-card-title">${escapeHtml(title)}${alt ? `<span>${escapeHtml(alt)}</span>` : ''}</div>`;
    if (anime.isAdult) card.classList.add('adult-card');
    if (isHistory) {
        const button = document.createElement('button');
        button.className = 'card-eraser-btn';
        button.title = 'Remove';
        button.textContent = '✕';
        button.addEventListener('click', event => { event.stopPropagation(); removeAnimeFromHistoryLog(anime.id); });
        card.appendChild(button);
    }
    card.addEventListener('click', () => viewSingleAnime(anime.id));
    return card;
}

function setupHeroBillboard(animeList) {
    heroSlides = (animeList || []).slice(0, 10);
    heroSlideIndex = 0;
    renderHeroIndicators();
    renderHeroSlide(0);
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
function renderHeroSlide(index) {
    const anime = heroSlides[index];
    if (!anime) return;
    const background = anime.bannerImage || imageUrl(anime);
    const layers = [document.getElementById('hero-bg-a'), document.getElementById('hero-bg-b')];
    const nextLayerIndex = heroBackgroundLayer === 0 ? 1 : 0;
    const currentLayer = layers[heroBackgroundLayer];
    const nextLayer = layers[nextLayerIndex];

    const applySlide = () => {
        if (nextLayer) {
            nextLayer.style.backgroundImage = `url('${background}')`;
            nextLayer.classList.add('active');
            currentLayer?.classList.remove('active');
            heroBackgroundLayer = nextLayerIndex;
        }
        document.getElementById('hero-title').textContent = displayTitle(anime);
        document.getElementById('hero-synopsis').textContent = stripHtml(anime.description) || 'No synopsis available.';
        document.querySelector('.hero-badge.top-10').textContent = `#${index + 1} Trending`;
        document.querySelector('.hero-badge.new-season').textContent = anime.seasonYear ? `${anime.season || ''} ${anime.seasonYear}`.trim() : formatStatus(anime.status);
        const watchTitle = anime.title?.english || anime.title?.romaji || '';
        const selectedWatchSite = getSelectedWatchSite();
        const heroWatchButton = document.getElementById('hero-watch-btn');
        heroWatchButton.textContent = `Watch on ${selectedWatchSite.name}`;
        heroWatchButton.onclick = () => window.open(buildWatchUrl(selectedWatchSite.url, watchTitle), '_blank', 'noopener,noreferrer');
        document.getElementById('hero-info-btn').onclick = () => viewSingleAnime(anime.id);
        document.querySelectorAll('#hero-indicators .hero-dot').forEach((dot, i) => dot.classList.toggle('active', i === index));
    };

    if (!background) { applySlide(); return; }
    const preload = new Image();
    preload.onload = applySlide;
    preload.onerror = applySlide;
    preload.src = background;
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
    const selects = [
        document.getElementById('discover-adult-filter'),
        document.getElementById('grid-discover-adult'),
    ].filter(Boolean);
    if (!adultContentEnabled) {
        selectedDiscoverAdult = 'regular';
        localStorage.setItem('anizoneDiscoverAdultMode', selectedDiscoverAdult);
    }
    selects.forEach(select => {
        select.disabled = !adultContentEnabled;
        select.value = selectedDiscoverAdult;
        select.classList.toggle('hidden', !adultContentEnabled);
        const wrapper = select.closest('.az-select');
        wrapper?.classList.toggle('hidden', !adultContentEnabled);
        wrapper?.classList.toggle('adult-filter-active', adultContentEnabled);
        select._azRebuild?.();
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
    document.getElementById('home-filter-genre').value = '';
    document.getElementById('filter-year').value = selectedDiscoverYear;
    document.getElementById('filter-season').value = selectedDiscoverSeason;
    document.getElementById('discover-type').value = '';
    document.getElementById('discover-status').value = '';
    document.getElementById('discover-rating').value = '';
    const adultFilter = document.getElementById('discover-adult-filter');
    if (adultFilter) adultFilter.value = selectedDiscoverAdult;
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
function syncGridDiscoverFilters() {
    const sourceGenre = document.getElementById('home-filter-genre');
    const sourceYear = document.getElementById('filter-year');
    const gridYearValue = currentActiveRowTarget === 'search' ? selectedSearchYear : selectedDiscoverYear;
    const pairs = [
        ['grid-discover-genre', sourceGenre, selectedDiscoverGenre],
        ['grid-discover-year', sourceYear, gridYearValue],
    ];
    pairs.forEach(([id, source, value]) => {
        const target = document.getElementById(id);
        if (!target || !source) return;
        if (target.options.length !== source.options.length) target.innerHTML = source.innerHTML;
        target.value = value;
        target._azRebuild?.();
    });
    const values = {
        'grid-discover-season': selectedDiscoverSeason,
        'grid-discover-type': selectedDiscoverType,
        'grid-discover-status': selectedDiscoverStatus,
        'grid-discover-rating': selectedDiscoverRating,
        'grid-discover-adult': selectedDiscoverAdult,
        'grid-search-order': selectedSearchOrder,
    };
    Object.entries(values).forEach(([id, value]) => {
        const select = document.getElementById(id);
        if (select) { select.value = value; select._azRebuild?.(); }
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
    const bindings = {
        'grid-discover-genre': value => selectedDiscoverGenre = value,
        'grid-discover-year': value => {
            if (currentActiveRowTarget === 'search') selectedSearchYear = value;
            else selectedDiscoverYear = value;
        },
        'grid-discover-season': value => selectedDiscoverSeason = value,
        'grid-discover-type': value => selectedDiscoverType = value,
        'grid-discover-status': value => selectedDiscoverStatus = value,
        'grid-discover-rating': value => selectedDiscoverRating = value,
        'grid-discover-adult': value => { selectedDiscoverAdult = value; localStorage.setItem('anizoneDiscoverAdultMode', value); },
        'grid-search-order': value => selectedSearchOrder = value,
    };
    Object.entries(bindings).forEach(([id, setter]) => document.getElementById(id)?.addEventListener('change', event => {
        setter(event.target.value);
        currentPage = 1;
        syncGridDiscoverFilters();
        fetchExpandedGridData();
    }));
    document.getElementById('grid-reset-discover-filters')?.addEventListener('click', () => {
        if (currentActiveRowTarget === 'search') {
            selectedDiscoverGenre = '';
            selectedSearchYear = '';
            selectedDiscoverSeason = '';
            selectedDiscoverType = '';
            selectedDiscoverStatus = '';
            selectedDiscoverRating = '';
            selectedDiscoverAdult = adultContentEnabled ? 'both' : 'regular';
            selectedSearchOrder = 'default';
        } else {
            resetDiscoverFilters();
        }
        syncGridDiscoverFilters();
        currentPage = 1;
        fetchExpandedGridData();
    });
}

function initGlobalFilterListeners() {
    ['filter-type', 'filter-status', 'filter-rating', 'filter-order'].forEach(id => document.getElementById(id)?.addEventListener('change', () => {
        if (currentActiveRowTarget && !document.getElementById('view-results')?.classList.contains('hidden')) {
            currentPage = 1;
            fetchExpandedGridData();
        }
    }));
}
function expandRowToGrid(target) {
    if (!target) return;
    currentActiveRowTarget = target;
    currentPage = 1;
    configureResultsHeader(target);
    syncViewRoute('view-results', true, { target, page: 1 });
    fetchExpandedGridData();
}
function executeGlobalSearch(query, page = 1) {
    const startingNewSearch = currentActiveRowTarget !== 'search' || currentSearchQuery !== query.trim();
    currentSearchQuery = query.trim();
    currentActiveRowTarget = 'search';
    if (startingNewSearch) {
        selectedSearchYear = '';
        selectedSearchOrder = 'default';
    }
    currentPage = page;
    suggestionsDropdown?.classList.add('hidden');
    configureResultsHeader('search');
    syncViewRoute('view-results', true, { target: 'search', query: currentSearchQuery, page });
    fetchExpandedGridData();
}
function viewStudioGrid(studioId, studioName) {
    currentActiveRowTarget = 'studio';
    selectedStudioId = studioId;
    selectedStudioName = studioName;
    currentPage = 1;
    configureResultsHeader('studio');
    syncViewRoute('view-results', true, { target: 'studio', studioId, studioName, page: 1 });
    fetchExpandedGridData();
}
async function fetchExpandedGridData() {
    const token = ++resultsRequestToken;
    const grid = document.getElementById('search-results-grid');
    if (!grid || !currentActiveRowTarget) return;
    showLoading(true);
    grid.innerHTML = '<div class="spinner"></div>';
    const filters = currentActiveRowTarget === 'search' ? {
        genre: selectedDiscoverGenre,
        year: selectedSearchYear,
        season: selectedDiscoverSeason,
        type: selectedDiscoverType,
        status: selectedDiscoverStatus,
        rating: selectedDiscoverRating,
        adultMode: adultContentEnabled ? selectedDiscoverAdult : 'regular',
        order: selectedSearchOrder,
    } : {
        type: document.getElementById('filter-type')?.value || '',
        status: document.getElementById('filter-status')?.value || '',
        rating: document.getElementById('filter-rating')?.value || '',
        order: document.getElementById('filter-order')?.value || 'default',
    };
    try {
        let data;
        if (currentActiveRowTarget === 'trending') data = await getTrending(currentPage, PAGE_SIZE);
        else if (currentActiveRowTarget === 'top') data = await getTopRated(currentPage, PAGE_SIZE);
        else if (currentActiveRowTarget === 'discover') data = await getDiscover(currentPage, PAGE_SIZE);
        else if (currentActiveRowTarget === 'studio') data = await getStudioAnime(selectedStudioId, currentPage, PAGE_SIZE, filters);
        else data = await searchAnime(currentSearchQuery, currentPage, PAGE_SIZE, filters);
        if (token !== resultsRequestToken) return;
        resultsPageInfo = data.Page.pageInfo;
        renderResultsPage(grid, data.Page.media || [], resultsPageInfo);
    } catch (error) {
        if (token !== resultsRequestToken) return;
        console.error('Grid error:', error);
        grid.innerHTML = `<div class="empty-state api-error">${escapeHtml(error.message || 'Unable to load results.')}<button id="grid-retry-btn" class="inline-retry-btn">Retry</button></div>`;
        document.getElementById('grid-retry-btn')?.addEventListener('click', fetchExpandedGridData);
        updatePaginationControls(null);
    } finally {
        if (token === resultsRequestToken) showLoading(false);
    }
}
function renderResultsPage(grid, items, pageInfo) {
    grid.innerHTML = '';
    if (!items.length) grid.innerHTML = '<div class="empty-state">No matching anime found.</div>';
    else items.forEach(item => grid.appendChild(createAnimeCard(item)));
    const total = Number(pageInfo?.total || items.length);
    document.getElementById('results-count').textContent = total >= 5000 ? '5,000+ Titles' : `${total.toLocaleString()} Titles`;
    updatePaginationControls(pageInfo);
}
function updatePaginationControls(pageInfo) {
    const previous = document.getElementById('prev-page-btn');
    const next = document.getElementById('next-page-btn');
    const indicator = document.getElementById('page-indicator');
    if (!previous || !next || !indicator) return;
    previous.disabled = !pageInfo || currentPage <= 1;
    next.disabled = !pageInfo?.hasNextPage;
    indicator.textContent = `Page ${currentPage}`;
    previous.onclick = () => { if (currentPage > 1) { currentPage--; updateRoutePage(); fetchExpandedGridData(); window.scrollTo({ top: 0 }); } };
    next.onclick = () => { if (pageInfo?.hasNextPage) { currentPage++; updateRoutePage(); fetchExpandedGridData(); window.scrollTo({ top: 0 }); } };
}
function updateRoutePage() {
    const state = { ...(history.state || {}), page: currentPage };
    history.replaceState(state, '', '');
}

async function viewSingleAnime(animeId, pushState = true) {
    showLoading(true);
    syncViewRoute('view-details', false);
    if (pushState) history.pushState({ view: 'view-details', animeId }, '', '');
    document.getElementById('characters-list').innerHTML = '<div class="spinner"></div>';
    document.getElementById('chrono-timeline').innerHTML = '<div class="spinner"></div>';
    try {
        const data = await getAnimeDetails(animeId);
        const anime = data.Media;
        currentDetailAnime = anime;
        if (!adultContentEnabled && anime.isAdult) throw new AniListError('Adult content is hidden. Enable the 18+ toggle to view this title.');
        renderAnimeDetails(anime);
        renderCastProfiles(anime.characters?.edges || []);
        appendAnimeToClickHistoryLog(anime);
        if(getDetailPrefs().timeline) renderDetailSection('timeline',anime); else document.getElementById('chrono-timeline').innerHTML='';
    } catch (error) {
        console.error('Detail error:', error);
        document.getElementById('detail-title').textContent = error.message || 'Unable to load anime details.';
        document.getElementById('characters-list').innerHTML = '<div class="empty-state">Cast unavailable.</div>';
        document.getElementById('chrono-timeline').innerHTML = '<div class="empty-state">Timeline unavailable.</div>';
    } finally { showLoading(false); }
}
function renderAnimeDetails(anime) {
    const poster = imageUrl(anime);
    const backdrop = anime.bannerImage || poster;
    document.getElementById('detail-backdrop').style.backgroundImage = `url('${backdrop}')`;
    document.getElementById('detail-poster').src = poster;
    const primary = displayTitle(anime);
    const alternate = secondaryTitle(anime);
    document.getElementById('detail-title').innerHTML = `${escapeHtml(primary)}${alternate ? `<span class="detail-alt-title">${escapeHtml(alternate)}</span>` : ''}`;
    document.getElementById('detail-synopsis').textContent = stripHtml(anime.description) || 'No synopsis available.';
    const adultWarning = document.getElementById('detail-adult-warning');
    if (adultWarning) adultWarning.classList.toggle('hidden', !anime.isAdult);
    document.getElementById('badge-score').textContent = anime.averageScore ? `★ AniList ${(anime.averageScore / 10).toFixed(1)} / 10` : 'AniList —';
    const malBadge = document.getElementById('badge-mal-score');
    if (malBadge) {
        malBadge.textContent = anime.idMal ? 'MAL …' : 'MAL N/A';
        malBadge.classList.toggle('hidden', !anime.idMal);
    }
    loadMalScoreIntoDetails(anime);
    document.getElementById('badge-year').textContent = anime.seasonYear || anime.startDate?.year || 'TBA';
    document.getElementById('badge-rating').textContent = anime.isAdult ? '18+' : 'General';
    document.getElementById('badge-episodes').textContent = anime.episodes ? `${anime.episodes} Episodes` : 'Episodes TBA';
    document.getElementById('badge-type').textContent = formatFormat(anime.format);
    document.getElementById('badge-status').textContent = formatStatus(anime.status);
    renderStudioLinks(anime.studios?.nodes || []);
    buildStreamingLinks(anime);
}

async function loadMalScoreIntoDetails(anime) {
    const badge = document.getElementById('badge-mal-score');
    if (!badge || !anime?.idMal) return;
    try {
        const score = await fetchMalScore(anime.idMal);
        if (currentDetailAnime?.id !== anime.id) return;
        badge.textContent = score != null ? `★ MAL ${Number(score).toFixed(2)} / 10` : 'MAL N/A';
    } catch (error) {
        if (currentDetailAnime?.id !== anime.id) return;
        badge.textContent = 'MAL —';
        badge.title = 'MAL score is temporarily unavailable.';
        console.warn('MAL score lookup failed:', error);
    }
}

function renderStudioLinks(studios) {
    const container = document.getElementById('detail-studio');
    container.innerHTML = '';
    if (!studios.length) { container.textContent = 'Unknown Studio'; return; }
    studios.forEach((studio, index) => {
        const link = document.createElement('span');
        link.className = 'studio-link';
        link.textContent = studio.name;
        link.addEventListener('click', () => viewStudioGrid(studio.id, studio.name));
        container.appendChild(link);
        if (index < studios.length - 1) container.appendChild(document.createTextNode(', '));
    });
}
function buildStreamingLinks(anime) {
    const title = anime.title?.english || anime.title?.romaji || '';
    const selectedSite = getSelectedWatchSite();
    const watchUrl = buildWatchUrl(selectedSite.url, title);
    const malLink = anime.idMal
        ? `<a class="watch-now-btn watch-myanimelist" href="https://myanimelist.net/anime/${Number(anime.idMal)}" target="_blank" rel="noopener noreferrer">ⓘ MyAnimeList</a>`
        : '';
    document.getElementById('streaming-links-container').innerHTML = `
        <a class="watch-now-btn watch-custom" href="${escapeHtml(watchUrl)}" target="_blank" rel="noopener noreferrer">▶ Watch on ${escapeHtml(selectedSite.name)}</a>
        <a class="watch-now-btn watch-anilist" href="${escapeHtml(anime.siteUrl || `https://anilist.co/anime/${anime.id}`)}" target="_blank" rel="noopener noreferrer">ⓘ AniList</a>
        ${malLink}`;
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
                        id isAdult type format status episodes duration
                        title { romaji english native }
                        coverImage { medium large extraLarge }
                        startDate { year month day }
                        relations {
                            edges {
                                relationType(version: 2)
                                node {
                                    id isAdult type format status episodes duration
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
                cacheKey: `main-relations:${ids.slice().sort((a, b) => a - b).join(',')}`,
                ttl: CACHE_TTL.details,
            });
            (data.Page?.media || []).forEach(anime => {
                const existing = seen.get(anime.id) || {};
                seen.set(anime.id, { ...existing, ...anime, relation: existing.relation || 'Related' });
                queue.push({ anime, depth: current.depth + 1 });
            });
        }

        const nodes = [...seen.values()].sort((a, b) => dateNumber(a.startDate) - dateNumber(b.startDate) || a.id - b.id);
        renderTimelineLayout(nodes, rootAnime.id);
    } catch (error) {
        console.error('Timeline error:', error);
        const partial = [...seen.values()].sort((a, b) => dateNumber(a.startDate) - dateNumber(b.startDate));
        if (partial.length > 1) renderTimelineLayout(partial, rootAnime.id);
        else container.innerHTML = '<div class="empty-state">Could not build the franchise timeline.</div>';
    }
}
function renderTimelineLayout(nodes, activeId) {
    const container = document.getElementById('chrono-timeline');
    container.innerHTML = '';
    if (nodes.length <= 1) { container.innerHTML = '<div class="empty-state">Standalone title — no related anime found.</div>'; return; }
    nodes.forEach(node => {
        const current = node.id === Number(activeId);
        const element = document.createElement('div');
        element.className = `timeline-node${current ? ' current-node' : ''}`;
        element.innerHTML = `<div class="timeline-dot"></div><div class="timeline-relation">${escapeHtml(node.relation || 'Related')} · ${escapeHtml(formatDate(node.startDate))}</div><div class="timeline-title">${escapeHtml(displayTitle(node))}</div>`;
        if (!current) element.addEventListener('click', () => viewSingleAnime(node.id));
        container.appendChild(element);
    });
}

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
        const data = await aniRequest(query, { id: Number(personId) }, { cacheKey: `staff-media:${personId}`, ttl: CACHE_TTL.details });
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
        const data = await aniRequest(query, { id: Number(personId) }, { cacheKey: `staff:${personId}`, ttl: CACHE_TTL.details });
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

async function triggerRandomShuffle() {
    const localPool = [...dashboardPools.trending, ...dashboardPools.top, ...dashboardPools.discover]
        .filter((anime, index, list) => anime?.id && (adultContentEnabled || !anime.isAdult) && list.findIndex(item => item.id === anime.id) === index);
    if (localPool.length) {
        const selected = localPool[Math.floor(Math.random() * localPool.length)];
        viewSingleAnime(selected.id);
        return;
    }
    showLoading(true);
    try {
        const page = Math.floor(Math.random() * 40) + 1;
        const query = mediaPageQuery('', `, sort: POPULARITY_DESC${adultArgument()}`);
        const data = await aniRequest(query, { page, perPage: 25 }, {
            cacheKey: `surprise:${adultContentEnabled}:${page}`,
            ttl: CACHE_TTL.discover,
            priority: 'interactive',
        });
        const pool = data.Page.media || [];
        if (!pool.length) throw new Error('No random title found.');
        viewSingleAnime(pool[Math.floor(Math.random() * pool.length)].id);
    } catch (error) {
        siteAlert(error.message || 'Unable to choose a surprise anime right now.');
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

function initScheduleView() {
    if (!scheduleInitialized) {
        buildDayNav();
        scheduleInitialized = true;
    } else {
        fetchScheduleForDate(new Date());
    }
}
function buildDayNav() {
    const nav = document.getElementById('schedule-day-nav');
    nav.innerHTML = '';
    const today = new Date();
    for (let offset = 0; offset < 7; offset++) {
        const date = new Date(today);
        date.setDate(today.getDate() + offset);
        const button = document.createElement('button');
        button.className = `sched-day-btn${offset === 0 ? ' active' : ''}`;
        button.innerHTML = `<span class="sched-day-month">${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span><span class="sched-day-name">${offset === 0 ? 'Today' : date.toLocaleDateString([], { weekday: 'short' })}</span>`;
        button.addEventListener('click', () => {
            nav.querySelectorAll('.sched-day-btn').forEach(item => item.classList.remove('active'));
            button.classList.add('active');
            fetchScheduleForDate(date);
        });
        nav.appendChild(button);
    }
    fetchScheduleForDate(today);
}
async function fetchScheduleForDate(date) {
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
            const data = await aniRequest(query, variables, { cacheKey: `schedule:${adultContentEnabled}:${start.toISOString().slice(0,10)}:${page}`, ttl: CACHE_TTL.schedule });
            all.push(...(data.Page.airingSchedules || []));
            if (!data.Page.pageInfo.hasNextPage) break;
        }
        renderScheduleList(all.filter(item => adultContentEnabled || !item.media.isAdult));
    } catch (error) {
        list.innerHTML = `<div class="schedule-empty"><span>${escapeHtml(error.message || 'Could not load schedule.')}</span></div>`;
    }
}
function renderScheduleList(items) {
    const list = document.getElementById('schedule-list');
    list.innerHTML = '';
    if (!items.length) { list.innerHTML = '<div class="schedule-empty"><span>No episodes scheduled.</span></div>'; return; }
    items.sort((a, b) => a.airingAt - b.airingAt).forEach(entry => {
        const anime = entry.media;
        const time = new Date(entry.airingAt * 1000);
        const item = document.createElement('div');
        item.className = 'schedule-item';
        item.innerHTML = `<div class="sched-time"><span class="sched-time-val">${time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span class="sched-time-tz">${Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div><img class="sched-poster" src="${escapeHtml(imageUrl(anime))}" alt="${escapeHtml(displayTitle(anime))}" loading="lazy"><div class="sched-info"><div class="sched-anime-title">${escapeHtml(displayTitle(anime))}</div><div class="sched-meta"><span class="sched-ep">Episode ${entry.episode}</span>${anime.genres?.length ? `<span class="sched-genres">${escapeHtml(anime.genres.slice(0,2).join(' · '))}</span>` : ''}<span class="sched-badge airing">Airing</span></div></div>${anime.averageScore ? `<div class="sched-score">★ ${(anime.averageScore / 10).toFixed(1)}</div>` : ''}`;
        item.addEventListener('click', () => viewSingleAnime(anime.id));
        list.appendChild(item);
    });
}

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
    window.addEventListener('popstate', handleBrowserBackNavigation);
    window.addEventListener('scroll', () => mainNav?.classList.toggle('scrolled', window.scrollY > 20));
    loadDashboardRows();
    if (history.state?.view) handleBrowserBackNavigation({ state: history.state });
    else history.replaceState({ view: 'view-home' }, '', '');
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
    { id: 'setup-docs', name: 'Read Setup Docs', url: 'https://github.com/Legend-1125/Legend-1125.github.io' },
]);
const LEGACY_WATCH_SITE_MIGRATION_KEY = 'anizone:watch-site-docs-default:v2';
function migrateLegacyWatchSiteDefault() {
    if (localStorage.getItem(LEGACY_WATCH_SITE_MIGRATION_KEY)) return;
    const stored = loadJson(WATCH_SITES_KEY, null);
    const onlySite = Array.isArray(stored) && stored.length === 1 ? stored[0] : null;
    const isOldDefault = onlySite && (
        (onlySite.name === 'Anikoto' && String(onlySite.url || '').includes('anikototv.to')) ||
        (onlySite.name === 'Temporary Site' && String(onlySite.url || '').includes('example.com'))
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
    };

    host.innerHTML = '';
    themes.forEach(theme => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'theme-option'; button.dataset.theme = theme.id; button.setAttribute('role', 'menuitem');
        button.innerHTML = `<span class="theme-swatch" style="--theme-swatch:${theme.color}"></span><span>${theme.label}</span>`;
        button.addEventListener('click', event => { event.stopPropagation(); apply(theme.id); });
        host.appendChild(button);
    });
    addWatchSiteButton.addEventListener('click', async event => {
        event.stopPropagation();
        const sites = getWatchSites();
        if (sites.length >= 3) return;
        const name = (prompt('Website name (example: Crunchyroll)') || '').trim();
        if (!name) return;
        const url = (prompt('HTTPS website link. Add {query} where the anime title should go.') || '').trim();
        if (!isSecureWebsiteUrl(url)) return siteAlert('Only valid HTTPS links are allowed.', { title: 'Invalid website link' });
        const site = { id: `site-${Date.now()}`, name: name.slice(0, 40), url };
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
    document.addEventListener('click', event => { if (!document.getElementById('theme-menu-wrap')?.contains(event.target)) closeMenu(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });

    migrateLegacyWatchSiteDefault();
    apply(localStorage.getItem(THEME_KEY) || 'default');
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
function renderRecommendations(anime){const box=document.getElementById('detail-recommendations'); if(!box)return; box.innerHTML=''; const recs=(anime.recommendations?.nodes||[]).map(x=>x.mediaRecommendation).filter(Boolean).filter(x=>adultContentEnabled||!x.isAdult); if(!recs.length)return box.innerHTML='<div class="empty-state">No recommendations yet.</div>'; recs.slice(0,12).forEach(x=>box.appendChild(createAnimeCard(x)));}
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
        const full=await getJikanAnimeFull(anime.idMal);
        const theme=full?.theme||{};
        const rows=[...(theme.openings||[]).map(x=>['Opening',x]),...(theme.endings||[]).map(x=>['Ending',x])];
        box.innerHTML=rows.length?rows.map(([kind,title])=>`<div class="music-item"><div><strong>${kind}</strong><small>${escapeHtml(title)}</small></div><a class="see-more-btn" target="_blank" rel="noopener" href="https://www.youtube.com/results?search_query=${encodeURIComponent(`${title} ${displayTitle(anime)}`)}">Search</a></div>`).join(''):'<div class="empty-state">No opening or ending songs are listed for this title.</div>';
    }catch(e){box.innerHTML='<div class="empty-state"><strong>Theme songs are temporarily unavailable.</strong></div>';}
}
let newsPage = 1;
const NEWS_PAGE_SIZE = 12;
const malNewsPageCache = new Map();

function parseMalNewsHtml(html, limit = NEWS_PAGE_SIZE) {
    const decode = value => {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = String(value || '');
        return textarea.value;
    };
    const strip = value => stripHtml(decode(value)).replace(/\s+/g, ' ').trim();
    const absolute = url => !url ? '' : url.startsWith('//') ? `https:${url}` : url.startsWith('/') ? `https://myanimelist.net${url}` : url;
    const items = [];
    const seen = new Set();
    const linkPattern = /<a[^>]+href=["']((?:https:\/\/myanimelist\.net)?\/news\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of html.matchAll(linkPattern)) {
        const url = absolute(match[1].split('?')[0]);
        const title = strip(match[2]);
        if (!title || title.length < 8 || seen.has(url)) continue;
        const at = match.index || 0;
        const context = html.slice(Math.max(0, at - 1800), Math.min(html.length, at + 3500));
        const imageMatch = context.match(/<(?:img|source)[^>]+(?:data-src|src)=["']([^"']+)["']/i);
        const dateMatch = context.match(/(?:datetime=["']([^"']+)["']|class=["'][^"']*(?:date|information)[^"']*["'][^>]*>([\s\S]*?)<\/)/i);
        const summaryMatch = context.match(/<(?:div|p)[^>]+class=["'][^"']*(?:text|summary|description)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|p)>/i);
        items.push({ title, url, date: strip(dateMatch?.[1] || dateMatch?.[2] || ''), excerpt: strip(summaryMatch?.[1] || '').slice(0, 500), image: absolute(imageMatch?.[1] || '') });
        seen.add(url);
        if (items.length >= limit) break;
    }
    return items;
}

async function fetchPublicMalNewsFallback(page = 1, force = false) {
    const safePage = Math.max(1, Number(page) || 1);
    const cacheKey = `anizone:mal-news:public-page:${safePage}:v2`;
    if (!force) {
        try {
            const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
            if (cached?.items?.length && Date.now() - cached.savedAt < 30 * 60 * 1000) return cached;
        } catch {}
    }
    const malPage = `https://myanimelist.net/news${safePage > 1 ? `?p=${safePage}` : ''}`;
    const htmlEndpoints = [
        `https://api.allorigins.win/raw?url=${encodeURIComponent(malPage)}`,
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(malPage)}`,
    ];
    let lastError = null;
    for (const endpoint of htmlEndpoints) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const response = await fetch(endpoint, { headers: { Accept: 'text/html' }, signal: controller.signal }).finally(() => clearTimeout(timeout));
            if (!response.ok) throw new Error(`News request failed (${response.status}).`);
            const html = await response.text();
            const items = parseMalNewsHtml(html, NEWS_PAGE_SIZE);
            if (items.length) {
                const hasNextPage = new RegExp(`[?&]p=${safePage + 1}(?:[&"'])`).test(html) || items.length === NEWS_PAGE_SIZE;
                const result = { items, page: safePage, hasNextPage, savedAt: Date.now() };
                try { localStorage.setItem(cacheKey, JSON.stringify(result)); } catch {}
                return result;
            }
        } catch (error) { lastError = error; }
    }
    if (safePage === 1) {
        const rssUrl = 'https://myanimelist.net/rss/news.xml';
        try {
            const response = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`);
            if (!response.ok) throw new Error(`News request failed (${response.status}).`);
            const payload = await response.json();
            const items = (payload.items || []).map(item => ({
                title: item.title || 'MyAnimeList News', url: item.link || item.guid || 'https://myanimelist.net/news',
                date: item.pubDate || '', excerpt: stripHtml(item.description || item.content || '').trim(),
                image: item.thumbnail || item.enclosure?.link || '',
            })).slice(0, NEWS_PAGE_SIZE);
            if (items.length) return { items, page: 1, hasNextPage: false, savedAt: Date.now() };
        } catch (error) { lastError = error; }
    }
    throw lastError || new Error('MyAnimeList news is temporarily unavailable.');
}

async function fetchMalNewsPage(page = 1, force = false) {
    const safePage = Math.max(1, Number(page) || 1);
    const cacheKey = `anizone:mal-news:page:${safePage}:v2`;
    if (!force && malNewsPageCache.has(safePage)) return malNewsPageCache.get(safePage);
    if (!force) {
        try {
            const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
            if (cached?.items?.length && Date.now() - cached.savedAt < 30 * 60 * 1000) {
                malNewsPageCache.set(safePage, cached);
                return cached;
            }
        } catch {}
    }
    const result = await fetchPublicMalNewsFallback(safePage, force);
    malNewsPageCache.set(safePage, result);
    try { localStorage.setItem(cacheKey, JSON.stringify({ ...result, savedAt: Date.now() })); } catch {}
    return result;
}

async function loadNews(force = false, page = newsPage) {
    const grid = document.getElementById('news-grid');
    if (!grid) return;
    newsPage = Math.max(1, Number(page) || 1);
    grid.innerHTML = '<div class="spinner"></div>';
    try {
        const result = await fetchMalNewsPage(newsPage, force);
        renderNewsItems(result.items, grid);
        updateNewsPagination({ currentPage: newsPage, hasNextPage: result.hasNextPage });
    } catch (error) {
        updateNewsPagination({ currentPage: newsPage, hasNextPage: false });
        grid.innerHTML = `<div class="empty-state api-error"><strong>MyAnimeList news is temporarily unavailable.</strong><a class="btn-secondary inline-action" href="https://myanimelist.net/news" target="_blank" rel="noopener">Open MyAnimeList News ↗</a></div>`;
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

function renderNewsItems(items, grid = document.getElementById('news-grid')) {
    if (!grid) return;
    if (!items.length) {
        grid.innerHTML = '<div class="empty-state">No recent MyAnimeList news stories were returned.</div>';
        return;
    }
    grid.innerHTML = items.map(item => {
        const date = item.date ? new Date(item.date) : null;
        const dateLabel = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : 'MyAnimeList News';
        return `<article class="news-card">${item.image ? `<img src="${escapeHtml(item.image)}" alt="" loading="lazy">` : ''}<div class="news-card-body"><small>${escapeHtml(dateLabel)}</small><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml((item.excerpt || '').slice(0, 240))}</p><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">Read on MyAnimeList →</a></div></article>`;
    }).join('');
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
    trigger.onclick=e=>{e.stopPropagation();document.querySelectorAll('.az-select.open').forEach(node=>{if(node!==wrap){node.classList.remove('open');node.querySelector('.az-select-menu')?.classList.add('hidden');}});rebuild();wrap.classList.toggle('open');menu.classList.toggle('hidden',!wrap.classList.contains('open'));};
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
}
function initConnectedExperience(){
    initThemes();
    enhanceAllSelects();
    syncDiscoverAdultFilter();
    initGridDiscoverFilters();
    initDetailPreferences();
    document.getElementById('refresh-news-btn')?.addEventListener('click',()=>loadNews(true, newsPage));
    document.getElementById('news-prev-btn')?.addEventListener('click',()=>{ if(newsPage > 1) loadNews(false, newsPage - 1); });
    document.getElementById('news-next-btn')?.addEventListener('click',()=>loadNews(false, newsPage + 1));
    document.querySelectorAll('.nav-btn').forEach(btn=>btn.addEventListener('click',()=>{if(btn.dataset.tab==='view-news')loadNews();}));
    const baseRender=renderAnimeDetails;
    renderAnimeDetails=function(anime){ detailSectionState={animeId:null,loaded:new Set()}; baseRender(anime); renderEnhancedDetails(anime); };
}
document.addEventListener('DOMContentLoaded',initConnectedExperience);

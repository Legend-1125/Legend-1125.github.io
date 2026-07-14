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
let selectedDiscoverSeason = getCurrentSeason();
let selectedDiscoverType = '';
let selectedDiscoverStatus = '';
let selectedDiscoverRating = '';
let resultsPageInfo = null;
let resultsRequestToken = 0;
let suggestionController = null;
let heroSlides = [];
let heroSlideIndex = 0;
let heroInterval = null;
let scheduleInitialized = false;

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
    return `${selectedDiscoverSeason.charAt(0)}${selectedDiscoverSeason.slice(1).toLowerCase()} ${selectedDiscoverYear}`;
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
async function jikanRequest(path, { retries = 1 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(`${JIKAN_API}${path}`, { headers: { Accept: 'application/json' } });
            let payload = null;
            try { payload = await response.json(); } catch { /* handled below */ }
            if (response.ok) return payload;
            const message = payload?.message || `Jikan request failed (${response.status}).`;
            lastError = new Error(message);
            if ((response.status === 429 || response.status >= 500) && attempt < retries) {
                const retryAfter = Number(response.headers.get('Retry-After')) || (attempt + 1) * 2;
                await delay(retryAfter * 1000);
                continue;
            }
            throw lastError;
        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                await delay((attempt + 1) * 1000);
                continue;
            }
        }
    }
    throw lastError || new Error('Unable to reach Jikan.');
}
async function fetchMalScore(malId) {
    if (!malId) return null;
    const cached = getCachedMalScore(malId);
    if (cached != null) return cached;
    const payload = await jikanRequest(`/anime/${Number(malId)}`, { retries: 0 });
    const score = payload?.data?.score;
    if (score != null) setCachedMalScore(malId, score);
    return score ?? null;
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

async function aniRequest(query, variables = {}, options = {}) {
    const { cacheKey = '', ttl = 0, signal } = options;
    if (cacheKey) {
        const cached = cacheGet(cacheKey);
        if (cached) return cached;
    }

    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            response = await fetch(ANILIST_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ query, variables }),
                signal,
            });
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            if (attempt < 2) { await delay(700 * (attempt + 1)); continue; }
            throw new AniListError('Unable to reach AniList. Check your connection and try again.');
        }

        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            const retryAfter = Number(response.headers.get('Retry-After')) || 1 + attempt;
            await delay(retryAfter * 1000);
            continue;
        }
        break;
    }

    let payload;
    try { payload = await response.json(); }
    catch { throw new AniListError(`AniList returned an unreadable response (${response.status}).`, response.status); }

    if (!response.ok || payload.errors?.length) {
        const message = payload.errors?.map(error => error.message).join('; ') || `AniList request failed (${response.status}).`;
        throw new AniListError(message, response.status, payload.errors || null);
    }

    if (cacheKey && ttl) cacheSet(cacheKey, payload.data, ttl);
    return payload.data;
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
    // SEARCH_MATCH is only used for an unfiltered title search. Other filters use a
    // normal media sort, avoiding AniList's illegal operator/value combinations.
    const sort = requestedSort || ((filters.type || filters.status || filters.rating) ? 'POPULARITY_DESC' : 'SEARCH_MATCH');
    return buildMediaPageRequest({
        page,
        perPage,
        filters: { search: queryText, type: filters.type, status: filters.status, rating: filters.rating },
        sort,
        cachePrefix: 'search',
        ttl: CACHE_TTL.search,
        signal,
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
    if (target === 'trending' || target === 'top') {
        filters?.classList.add('hidden');
        title.textContent = target === 'trending' ? 'Trending Now' : 'Top Rated';
    } else {
        filters?.classList.remove('hidden');
        if (target === 'search') title.textContent = `Search: “${currentSearchQuery}”`;
        else if (target === 'studio') title.textContent = `Studio: ${selectedStudioName}`;
        else title.textContent = `Discover · ${seasonLabel()}`;
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
        loadDashboardRows();
        if (currentDetailAnime && !document.getElementById('view-details')?.classList.contains('hidden')) {
            renderAnimeDetails(currentDetailAnime);
        }
        if (!document.getElementById('view-history')?.classList.contains('hidden')) renderHistoryLogGrid();
        if (currentActiveRowTarget && !document.getElementById('view-results')?.classList.contains('hidden')) fetchExpandedGridData();
    });
}

function initSearchEngine() {
    const trigger = document.getElementById('search-icon-trigger');
    const wrapper = trigger?.parentElement;
    trigger?.addEventListener('click', () => {
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
        if (query.length >= 2) timer = setTimeout(() => fetchSearchSuggestions(query), 300);
    });
    searchInput?.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        const query = searchInput.value.trim();
        if (query) executeGlobalSearch(query, 1);
    });
    clearSearchBtn?.addEventListener('click', () => {
        searchInput.value = '';
        clearSearchBtn.classList.add('hidden');
        suggestionsDropdown.classList.add('hidden');
        searchInput.focus();
    });
    document.addEventListener('click', event => {
        if (!wrapper?.contains(event.target)) suggestionsDropdown?.classList.add('hidden');
    });
}
async function fetchSearchSuggestions(queryText) {
    suggestionController?.abort();
    suggestionController = new AbortController();
    try {
        const [mediaData, studioData] = await Promise.all([
            searchAnime(queryText, 1, 6, {}, suggestionController.signal),
            findStudios(queryText, 3, suggestionController.signal).catch(() => ({ Page: { studios: [] } })),
        ]);
        const anime = mediaData?.Page?.media || [];
        const studios = studioData?.Page?.studios || [];
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
        if (error.name !== 'AbortError') console.error('Suggestion error:', error);
    }
}

async function loadDashboardRows() {
    showLoading(true);
    const trendPromise = getTrending(1, 20).then(data => {
        const list = data.Page.media || [];
        renderSliderTrack('row-trending', list);
        setupHeroBillboard(list);
    }).catch(error => renderRowError('row-trending', error, loadDashboardRows));
    const topPromise = getTopRated(1, 20).then(data => renderSliderTrack('row-top', data.Page.media || []))
        .catch(error => renderRowError('row-top', error, loadDashboardRows));
    const discoverPromise = refreshDiscoverRow();
    await Promise.allSettled([trendPromise, topPromise, discoverPromise]);
    showLoading(false);
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
        document.getElementById('hero-title').textContent = displayTitle(anime, true);
        document.getElementById('hero-synopsis').textContent = stripHtml(anime.description) || 'No synopsis available.';
        document.querySelector('.hero-badge.top-10').textContent = `#${index + 1} Trending`;
        document.querySelector('.hero-badge.new-season').textContent = anime.seasonYear ? `${anime.season || ''} ${anime.seasonYear}`.trim() : formatStatus(anime.status);
        const watchTitle = anime.title?.english || anime.title?.romaji || '';
        document.getElementById('hero-watch-btn').onclick = () => window.open(`https://anikototv.to/filter?keyword=${encodeURIComponent(watchTitle)}`, '_blank', 'noopener,noreferrer');
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
    let options = '';
    for (let year = new Date().getFullYear() + 1; year >= 1960; year--) options += `<option value="${year}">${year}</option>`;
    select.innerHTML = options;
}
function syncDiscoverAdultFilter() {
    const select = document.getElementById('discover-adult-filter');
    if (!select) return;
    select.classList.toggle('hidden', !adultContentEnabled);
    select.disabled = !adultContentEnabled;
    select.value = selectedDiscoverAdult;
}

function resetDiscoverFilters() {
    selectedDiscoverGenre = '';
    selectedDiscoverYear = String(new Date().getFullYear());
    selectedDiscoverSeason = getCurrentSeason();
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
    currentSearchQuery = query.trim();
    currentActiveRowTarget = 'search';
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
    const filters = {
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
    document.getElementById('results-count').textContent = `${Number(pageInfo?.total || items.length).toLocaleString()} Titles`;
    updatePaginationControls(pageInfo);
}
function updatePaginationControls(pageInfo) {
    const previous = document.getElementById('prev-page-btn');
    const next = document.getElementById('next-page-btn');
    const indicator = document.getElementById('page-indicator');
    if (!previous || !next || !indicator) return;
    previous.disabled = !pageInfo || currentPage <= 1;
    next.disabled = !pageInfo?.hasNextPage;
    indicator.textContent = pageInfo ? `Page ${currentPage} of ${pageInfo.lastPage || currentPage}` : `Page ${currentPage}`;
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
        fetchFranchiseTimeline(anime);
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
        badge.textContent = 'MAL unavailable';
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
    const malLink = anime.idMal
        ? `<a class="watch-now-btn watch-myanimelist" href="https://myanimelist.net/anime/${Number(anime.idMal)}" target="_blank" rel="noopener noreferrer">ⓘ MyAnimeList</a>`
        : '';
    document.getElementById('streaming-links-container').innerHTML = `
        <a class="watch-now-btn watch-custom" href="https://anikototv.to/filter?keyword=${encodeURIComponent(title)}" target="_blank" rel="noopener noreferrer">▶ Watch on Anikoto</a>
        <a class="watch-now-btn watch-anilist" href="${escapeHtml(anime.siteUrl || `https://anilist.co/anime/${anime.id}`)}" target="_blank" rel="noopener noreferrer">ⓘ AniList</a>
        ${malLink}`;
}
function updateCastLanguageControls() {
    document.querySelectorAll('[data-cast-language]').forEach(button => {
        button.classList.toggle('active', button.dataset.castLanguage === castLanguage);
    });
}
function initCastLanguageToggle() {
    document.querySelectorAll('[data-cast-language]').forEach(button => {
        button.addEventListener('click', () => {
            castLanguage = button.dataset.castLanguage;
            localStorage.setItem('anizoneCastLanguage', castLanguage);
            updateCastLanguageControls();
            renderCastProfiles(currentCastEdges, false);
        });
    });
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
        while (queue.length && seen.size < 60) {
            const current = queue.shift();
            const candidates = (current.anime.relations?.edges || []).filter(edge => {
                const node = edge.node;
                return node?.type === 'ANIME'
                    && MAIN_CONTINUITY_RELATIONS.has(edge.relationType)
                    && !seen.has(node.id)
                    && isMainFranchiseMatch(rootAnime, node)
                    && (adultContentEnabled || !node.isAdult);
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
    showLoading(true);
    try {
        // Jikan supplies a true random MAL entry. AniList remains the source for
        // the detail page by resolving the returned MAL ID to an AniList ID.
        let selected = null;
        let lastError = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const payload = await jikanRequest('/random/anime', { retries: 0 });
                const malId = payload?.data?.mal_id;
                if (!malId) throw new Error('Jikan returned no MAL ID.');
                const mapped = await getAnimeByMalId(malId);
                const anime = mapped?.Media;
                if (!anime?.id) throw new Error('This random MAL title is not available on AniList.');
                if (!adultContentEnabled && anime.isAdult) continue;
                selected = anime;
                break;
            } catch (error) {
                lastError = error;
                await delay(350);
            }
        }

        if (!selected) {
            // Reliable fallback: choose from a broad AniList popularity pool.
            const page = Math.floor(Math.random() * 200) + 1;
            const query = mediaPageQuery('', `, sort: POPULARITY_DESC${adultArgument()}`);
            const data = await aniRequest(query, { page, perPage: 25 });
            const pool = data.Page.media || [];
            if (!pool.length) throw lastError || new Error('No random title found.');
            selected = pool[Math.floor(Math.random() * pool.length)];
        }

        await viewSingleAnime(selected.id);
    } catch (error) {
        console.error('Surprise Me failed:', error);
        alert(error.message || 'Could not select a random anime.');
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
    const visible = clickHistory.filter(item => adultContentEnabled || !item.isAdult);
    grid.innerHTML = '';
    if (!visible.length) { grid.innerHTML = '<div class="empty-state">Your list is empty.</div>'; return; }
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
    document.getElementById('clear-click-history')?.addEventListener('click', () => {
        if (confirm('Clear your watch history?')) {
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

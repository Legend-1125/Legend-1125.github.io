// ==========================================
// 1. GLOBAL STATE & CACHE
// ==========================================
let clickHistory = JSON.parse(localStorage.getItem('chronoClickHistory')) || [];
const franchiseCache = {};

let currentSearchQuery = "";
let currentPage = 1;
let hasNextPage = false;
const searchPageSize = 24;
let currentActiveRowTarget = "";

// Virtual pagination over the raw Jikan API: Jikan occasionally repeats
// entries across pages of the same listing (seasons/now especially — the
// duplicate count compounds the further you page), which would otherwise
// shrink a "24 per page" grid down to as few as ~19 visible cards. These
// dedupe across raw API pages within a session and only hand out a display
// page once it actually has 24 unique items (or the API is truly out of
// data), then cache it so Prev/Next never re-fetch or change content for a
// page already seen.
let resultsSessionKey = "";
let resultsPageCache = new Map();
let resultsBuffer = [];
let resultsSeenIds = new Set();
let resultsNextRawPage = 1;
let resultsApiExhausted = false;
let resultsMaxBuiltPage = 0;
let resultsMeta = { total: 0, lastVisiblePage: null };

let selectedDiscoverGenre = "";
let selectedDiscoverYear = String(new Date().getFullYear());
let selectedDiscoverSeason = "summer";
let selectedDiscoverType = "";
let selectedDiscoverStatus = "";
let selectedDiscoverRating = "";

let selectedStudioId = null;
let selectedStudioName = "";

let isRoutingStateUpdating = false;

let heroSlides = [];
let heroSlideIndex = 0;
let heroInterval = null;

// ==========================================
// 2. DOM BINDINGS
// ==========================================
const views = document.querySelectorAll('.tab-view');
const navButtons = document.querySelectorAll('.nav-btn');
const searchInput = document.getElementById('search-input');
const clearSearchBtn = document.getElementById('clear-search-btn');
const suggestionsDropdown = document.getElementById('search-suggestions');
const loading = document.getElementById('loading');
const mainNav = document.getElementById('main-nav');

// ==========================================
// 3. INIT
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initSearchEngine();
    initSliders();
    initDiscoverFilters();
    initGlobalFilterListeners(); // <-- separate, no DOMContentLoaded nesting
    initImageLazyLoad();
    initHeroControls();

    loadDashboardRows();

    window.addEventListener('popstate', handleBrowserBackNavigation);

    if (history.state && history.state.view) {
        const v = history.state.view;
        if (v === 'view-details' && history.state.animeId) {
            viewSingleAnime(history.state.animeId, false);
        } else if (v === 'view-results' && history.state.target) {
            restoreResultsGridState(history.state);
        } else {
            syncViewRoute(v, false);
            if (v === 'view-schedule') initScheduleView();
            if (v === 'view-history') renderHistoryLogGrid();
        }
    } else {
        history.replaceState({ view: 'view-home' }, "", "");
    }

    window.addEventListener('scroll', () => {
        mainNav.classList.toggle('scrolled', window.scrollY > 20);
    });
});

// ==========================================
// UTILITIES
// ==========================================
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showLoading(show) {
    loading.classList.toggle('hidden', !show);
}

// Removes entries with duplicate mal_id (Jikan occasionally repeats an entry
// within a single page, e.g. seasons/now). Title-based dedup was tried but
// drops pages below the fixed 24-per-page count, so id-only is intentional.
function dedupeAnimeList(list) {
    const seenIds = new Set();
    const result = [];
    (list || []).forEach(anime => {
        const id = anime.mal_id;
        if (seenIds.has(id)) return;
        seenIds.add(id);
        result.push(anime);
    });
    return result;
}

// Lazy load image fade-in
function initImageLazyLoad() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;
                img.addEventListener('load', () => img.classList.add('loaded'));
                if (img.complete) img.classList.add('loaded');
                observer.unobserve(img);
            }
        });
    });
    const mutObs = new MutationObserver(mutations => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.tagName === 'IMG') observer.observe(node);
                if (node.querySelectorAll) node.querySelectorAll('img').forEach(img => observer.observe(img));
            });
        });
    });
    mutObs.observe(document.body, { childList: true, subtree: true });
}

// ==========================================
// 4. ROUTING
// ==========================================
function syncViewRoute(targetViewId, pushState = true, extraState = {}) {
    isRoutingStateUpdating = true;
    views.forEach(v => v.classList.add('hidden'));
    const targetView = document.getElementById(targetViewId);
    if (targetView) targetView.classList.remove('hidden');

    navButtons.forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === targetViewId);
    });

    if (pushState) history.pushState({ view: targetViewId, ...extraState }, "", "");
    window.scrollTo({ top: 0 });
    isRoutingStateUpdating = false;
}

function handleBrowserBackNavigation(event) {
    if (!event.state) return;
    if (event.state.view === 'view-details' && event.state.animeId) {
        viewSingleAnime(event.state.animeId, false);
    } else if (event.state.view === 'view-results' && event.state.target) {
        restoreResultsGridState(event.state);
    } else {
        syncViewRoute(event.state.view, false);
    }
}

// Browser back/forward into the results grid re-derives everything from the
// pushed state instead of trusting leftover DOM — avoids stale or empty
// grids when several searches/studio clicks happened in between.
function restoreResultsGridState(state) {
    currentActiveRowTarget = state.target;
    currentPage = state.page || 1;
    if (state.target === 'search') currentSearchQuery = state.query || '';
    if (state.target === 'studio') {
        selectedStudioId = state.studioId;
        selectedStudioName = state.studioName || '';
    }

    const gridTitle = document.getElementById('grid-title');
    const globalFilters = document.getElementById('global-filters-container');

    if (state.target === 'trending' || state.target === 'top') {
        globalFilters.classList.add('hidden');
        gridTitle.textContent = state.target === 'trending' ? 'Trending Now — Full List' : 'Top Rated Masterpieces';
    } else if (state.target === 'studio') {
        globalFilters.classList.remove('hidden');
        gridTitle.textContent = `Studio: ${selectedStudioName}`;
    } else if (state.target === 'search') {
        globalFilters.classList.remove('hidden');
        gridTitle.textContent = `Search: "${currentSearchQuery}"`;
    } else {
        globalFilters.classList.remove('hidden');
        gridTitle.textContent = 'Discover — Advanced Grid';
    }

    syncViewRoute('view-results', false);
    fetchExpandedGridData();
}

function initNavigation() {
    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.getAttribute('data-tab');
            if (tab) {
                syncViewRoute(tab, true);
                if (tab === 'view-history') renderHistoryLogGrid();
                if (tab === 'view-schedule') initScheduleView();
            }
        });
    });

    document.getElementById('logo-btn').addEventListener('click', () => syncViewRoute('view-home', true));
    document.getElementById('shuffle-btn').addEventListener('click', triggerRandomShuffle);
    document.getElementById('grid-back-btn').addEventListener('click', () => syncViewRoute('view-home', false));
    document.getElementById('back-btn').addEventListener('click', () => history.back());

    const hamburgerBtn = document.getElementById('hamburger-btn');
    const navMenuPanel = document.getElementById('nav-menu-panel');
    hamburgerBtn.addEventListener('click', () => {
        const opened = hamburgerBtn.getAttribute('aria-expanded') === 'true';
        hamburgerBtn.setAttribute('aria-expanded', String(!opened));
        hamburgerBtn.classList.toggle('open');
        navMenuPanel.classList.toggle('open-panel');
    });

    const avatarImg = document.querySelector('.profile-avatar img');
    avatarImg?.addEventListener('click', () => {
        avatarImg.classList.remove('avatar-smiling');
        void avatarImg.offsetWidth; // restart the animation on repeated clicks
        avatarImg.classList.add('avatar-smiling');
    });
}

// ==========================================
// 5. SEARCH ENGINE
// ==========================================
function initSearchEngine() {
    const searchTrigger = document.getElementById('search-icon-trigger');
    const searchWrapper = searchTrigger.parentElement;

    searchTrigger.addEventListener('click', () => {
        searchWrapper.classList.toggle('open');
        if (searchWrapper.classList.contains('open')) searchInput.focus();
    });

    let typingTimer;
    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim();
        clearSearchBtn.classList.toggle('hidden', query.length === 0);
        if (query.length === 0) { suggestionsDropdown.classList.add('hidden'); return; }
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
            if (query.length >= 2) fetchSearchSuggestions(query);
        }, 300);
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const query = searchInput.value.trim();
            if (query.length > 0) {
                suggestionsDropdown.classList.add('hidden');
                executeGlobalSearch(query, 1);
            }
        }
    });

    clearSearchBtn.addEventListener('click', () => {
        searchInput.value = "";
        clearSearchBtn.classList.add('hidden');
        suggestionsDropdown.classList.add('hidden');
        searchInput.focus();
    });

    document.addEventListener('click', (e) => {
        if (!searchWrapper.contains(e.target)) suggestionsDropdown.classList.add('hidden');
    });
}

async function fetchSearchSuggestions(query) {
    try {
        const response = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=6&sfw=true`);
        if (!response.ok) return;
        const result = await response.json();
        if (!result?.data?.length) { suggestionsDropdown.classList.add('hidden'); return; }

        suggestionsDropdown.innerHTML = "";
        result.data.forEach(anime => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.innerHTML = `
                <span>${escapeHtml(anime.title)}</span>
                <span class="sug-score">${anime.score ? '★ ' + parseFloat(anime.score).toFixed(1) : 'N/A'}</span>
            `;
            item.addEventListener('click', () => {
                suggestionsDropdown.classList.add('hidden');
                viewSingleAnime(anime.mal_id);
            });
            suggestionsDropdown.appendChild(item);
        });
        suggestionsDropdown.classList.remove('hidden');
    } catch (err) {
        console.error("Suggestions error:", err);
    }
}

// ==========================================
// 6. DASHBOARD ROWS
// ==========================================
async function loadDashboardRows() {
    showLoading(true);
    try {
        // Row 1: Trending (current season)
        const trendingRes = await fetch('https://api.jikan.moe/v4/seasons/now?limit=20&sfw=true');
        const trendingData = await trendingRes.json();
        renderSliderTrack('row-trending', trendingData.data);

        if (trendingData.data?.length > 0) {
            setupHeroBillboard(trendingData.data);
        }

        await delay(500);

        // Row 2: Top Rated
        const topRes = await fetch('https://api.jikan.moe/v4/top/anime?limit=20&type=tv&sfw=true');
        const topData = await topRes.json();
        renderSliderTrack('row-top', topData.data);

        await delay(500);

        // Row 3: Discover
        refreshDiscoverRow();

    } catch (err) {
        console.error("Dashboard load error:", err);
        showLoading(false);
    } finally {
        showLoading(false);
    }
}

function setupHeroBillboard(animeList) {
    if (!animeList?.length) return;
    heroSlides = dedupeAnimeList(animeList).slice(0, 10);
    if (!heroSlides.length) return;
    heroSlideIndex = 0;

    renderHeroIndicators();
    renderHeroSlide(0);
    startHeroAutoRotate();
}

function startHeroAutoRotate() {
    if (heroInterval) clearInterval(heroInterval);
    if (heroSlides.length <= 1) return;
    heroInterval = setInterval(() => {
        heroSlideIndex = (heroSlideIndex + 1) % heroSlides.length;
        renderHeroSlide(heroSlideIndex);
    }, 6000);
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
    const wrap = document.getElementById('hero-indicators');
    if (!wrap) return;
    wrap.innerHTML = "";
    heroSlides.forEach((_, i) => {
        const dot = document.createElement('button');
        dot.className = 'hero-dot';
        dot.setAttribute('aria-label', `Show trending title ${i + 1}`);
        dot.addEventListener('click', () => {
            heroSlideIndex = i;
            renderHeroSlide(i);
            startHeroAutoRotate();
        });
        wrap.appendChild(dot);
    });
}

function renderHeroSlide(index) {
    const anime = heroSlides[index];
    if (!anime) return;
    const hero = document.getElementById('home-hero');
    const imgUrl = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || '';
    hero.style.backgroundImage = `url('${imgUrl}')`;
    document.getElementById('hero-title').textContent = anime.title || '';
    document.getElementById('hero-synopsis').textContent = anime.synopsis || "No synopsis available.";

    const rankBadge = document.querySelector('.hero-badge.top-10');
    if (rankBadge) rankBadge.textContent = `#${index + 1} Trending`;

    const anikotoTitle = anime.title_english || anime.title || '';
    const anikotoUrl = `https://anikototv.to/filter?keyword=${encodeURIComponent(anikotoTitle)}`;
    document.getElementById('hero-watch-btn').onclick = () => window.open(anikotoUrl, '_blank', 'noopener,noreferrer');
    document.getElementById('hero-info-btn').onclick = () => viewSingleAnime(anime.mal_id);

    document.querySelectorAll('#hero-indicators .hero-dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
    });
}

function renderSliderTrack(trackId, dataset) {
    const track = document.getElementById(trackId);
    if (!track) return;
    track.innerHTML = "";
    const deduped = dedupeAnimeList(dataset);
    if (!deduped.length) {
        track.innerHTML = '<div class="empty-state">No content found.</div>';
        return;
    }
    deduped.forEach(anime => track.appendChild(createAnimeCard(anime)));
}

function createAnimeCard(anime, isHistoryView = false) {
    const card = document.createElement('div');
    card.className = 'anime-card';

    const img = anime.images?.jpg?.large_image_url
        || anime.images?.jpg?.image_url
        || anime.images?.webp?.large_image_url
        || '';

    card.innerHTML = `
        <img src="${img}" alt="${escapeHtml(anime.title)}" loading="lazy">
        <div class="anime-card-overlay"></div>
        <div class="anime-card-title">${escapeHtml(anime.title)}</div>
    `;

    if (isHistoryView) {
        const eraser = document.createElement('button');
        eraser.className = 'card-eraser-btn';
        eraser.title = 'Remove from list';
        eraser.innerHTML = '✕';
        eraser.addEventListener('click', (e) => {
            e.stopPropagation();
            removeAnimeFromHistoryLog(anime.mal_id);
        });
        card.appendChild(eraser);
    }

    card.addEventListener('click', () => viewSingleAnime(anime.mal_id));
    return card;
}

// ==========================================
// 7. DISCOVER FILTERS
// ==========================================
function initDiscoverFilters() {
    populateYearFilterOptions();
    ['home-filter-genre', 'filter-year', 'filter-season', 'discover-type', 'discover-status', 'discover-rating']
        .forEach(enhanceSelectWithCustomDropdown);

    const bindings = [
        ['home-filter-genre', v => { selectedDiscoverGenre = v; }],
        ['filter-year',       v => { selectedDiscoverYear = v; }],
        ['filter-season',     v => { selectedDiscoverSeason = v; }],
        ['discover-type',     v => { selectedDiscoverType = v; }],
        ['discover-status',   v => { selectedDiscoverStatus = v; }],
        ['discover-rating',   v => { selectedDiscoverRating = v; }],
    ];
    bindings.forEach(([id, setter]) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            setter(e.target.value);
            refreshDiscoverRow();
        });
    });
}

function populateYearFilterOptions() {
    const yearSelect = document.getElementById('filter-year');
    if (!yearSelect) return;
    const currentYear = new Date().getFullYear();
    let optionsHtml = '';
    for (let y = currentYear; y >= 1999; y--) {
        optionsHtml += `<option value="${y}">${y}</option>`;
    }
    yearSelect.innerHTML = optionsHtml;
    yearSelect.value = selectedDiscoverYear;
}

// Native <select> dropdowns with very long option lists (60+ genres, 25+ years)
// render inconsistently inside this app's embedded webview — option text can
// overflow/scroll oddly since we don't control the native popup at all. This
// swaps the select for a panel we fully own (fixed max-height, our own
// scrolling, our own z-index) while keeping the original <select> in the DOM
// as the source of truth, so every existing 'change' listener keeps working.
let customDropdownGlobalCloseBound = false;
function enhanceSelectWithCustomDropdown(selectId) {
    const select = document.getElementById(selectId);
    if (!select || select.dataset.enhanced) return;
    select.dataset.enhanced = 'true';

    const wrap = document.createElement('div');
    wrap.className = 'custom-select-wrap';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = `${select.className} custom-select-trigger`;
    trigger.textContent = select.options[select.selectedIndex]?.text || '';

    const panel = document.createElement('div');
    panel.className = 'custom-select-panel hidden';

    Array.from(select.options).forEach(opt => {
        const item = document.createElement('div');
        item.className = `custom-select-option${opt.value === select.value ? ' selected' : ''}`;
        item.textContent = opt.text;
        item.addEventListener('click', () => {
            select.value = opt.value;
            trigger.textContent = opt.text;
            panel.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
            item.classList.add('selected');
            panel.classList.add('hidden');
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        panel.appendChild(item);
    });

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.custom-select-panel').forEach(p => { if (p !== panel) p.classList.add('hidden'); });
        panel.classList.toggle('hidden');
    });

    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(trigger);
    wrap.appendChild(panel);
    wrap.appendChild(select);
    select.classList.add('visually-hidden-select');

    if (!customDropdownGlobalCloseBound) {
        document.addEventListener('click', () => {
            document.querySelectorAll('.custom-select-panel').forEach(p => p.classList.add('hidden'));
        });
        customDropdownGlobalCloseBound = true;
    }
}

async function refreshDiscoverRow() {
    const track = document.getElementById('row-discover');
    if (!track) return;
    track.innerHTML = '<div class="spinner"></div>';

    try {
        let url;

        // FIX: When both year and season are set, use the seasons endpoint which is reliable
        if (selectedDiscoverYear && selectedDiscoverSeason && !selectedDiscoverGenre && !selectedDiscoverType && !selectedDiscoverStatus) {
            url = `https://api.jikan.moe/v4/seasons/${selectedDiscoverYear}/${selectedDiscoverSeason}?limit=20&sfw=true`;
        } else {
            // General anime endpoint with all filters
            url = `https://api.jikan.moe/v4/anime?limit=20&page=1&sfw=true`;
            if (selectedDiscoverGenre) url += `&genres=${selectedDiscoverGenre}`;
            if (selectedDiscoverYear) url += `&start_date=${selectedDiscoverYear}-01-01&end_date=${selectedDiscoverYear}-12-31`;
            if (selectedDiscoverType) url += `&type=${selectedDiscoverType}`;
            if (selectedDiscoverStatus) url += `&status=${selectedDiscoverStatus}`;
            if (selectedDiscoverRating) url += `&rating=${selectedDiscoverRating}`;
        }

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (!data?.data?.length) {
            track.innerHTML = '<div class="empty-state">No anime found with these filters. Try different options.</div>';
            return;
        }
        renderSliderTrack('row-discover', data.data);
    } catch (err) {
        console.error("Discover row error:", err);
        track.innerHTML = '<div class="empty-state">Failed to load discover content. Please try again.</div>';
    }
}

// ==========================================
// 8. SLIDERS
// ==========================================
function initSliders() {
    document.querySelectorAll('.see-more-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.getAttribute('data-target');
            if (target) expandRowToGrid(target);
        });
    });

    document.querySelectorAll('.slider-container').forEach(container => {
        const track = container.querySelector('.slider-track');
        const leftArrow = container.querySelector('.left-arrow');
        const rightArrow = container.querySelector('.right-arrow');
        if (!track || !leftArrow || !rightArrow) return;
        leftArrow.addEventListener('click', () => track.scrollBy({ left: -500, behavior: 'smooth' }));
        rightArrow.addEventListener('click', () => track.scrollBy({ left: 500, behavior: 'smooth' }));
    });
}

// ==========================================
// 9. EXPANDED GRID
// ==========================================

// FIX: Global filter listeners — only in one place, not nested in DOMContentLoaded
function initGlobalFilterListeners() {
    ['filter-type','filter-status','filter-rating','filter-order'].forEach(id => {
        enhanceSelectWithCustomDropdown(id);
        document.getElementById(id)?.addEventListener('change', () => {
            // Only re-fetch if we're actually in the results view with a valid target
            if (currentActiveRowTarget && document.getElementById('view-results') && !document.getElementById('view-results').classList.contains('hidden')) {
                currentPage = 1;
                fetchExpandedGridData();
            }
        });
    });

}

function expandRowToGrid(targetRowKey) {
    currentActiveRowTarget = targetRowKey;
    currentPage = 1;

    const gridTitle = document.getElementById('grid-title');
    const globalFilters = document.getElementById('global-filters-container');

    if (targetRowKey === 'trending' || targetRowKey === 'top') {
        globalFilters.classList.add('hidden');
        gridTitle.textContent = targetRowKey === 'trending' ? 'Trending Now — Full List' : 'Top Rated Masterpieces';
    } else {
        globalFilters.classList.remove('hidden');
        gridTitle.textContent = 'Discover — Advanced Grid';
    }

    syncViewRoute('view-results', true, { target: targetRowKey, page: 1 });
    fetchExpandedGridData();
}

// Studio name in the detail view links here — grid of everything that studio made.
function viewStudioGrid(studioId, studioName) {
    if (!studioId) return;
    currentActiveRowTarget = 'studio';
    selectedStudioId = studioId;
    selectedStudioName = studioName || '';
    currentPage = 1;

    document.getElementById('grid-title').textContent = `Studio: ${selectedStudioName}`;
    document.getElementById('global-filters-container').classList.remove('hidden');
    syncViewRoute('view-results', true, { target: 'studio', studioId, studioName: selectedStudioName, page: 1 });
    fetchExpandedGridData();
}

async function fetchExpandedGridData() {
    // Guard: must have a valid target
    if (!currentActiveRowTarget) return;

    showLoading(true);
    const grid = document.getElementById('search-results-grid');
    if (!grid) { showLoading(false); return; }

    const filterType   = document.getElementById('filter-type')?.value || '';
    const filterStatus = document.getElementById('filter-status')?.value || '';
    const filterRating = document.getElementById('filter-rating')?.value || '';
    const filterOrder  = document.getElementById('filter-order')?.value || 'default';

    // A new target/query/filter combo resets the virtual-pagination session;
    // plain Prev/Next page changes keep it so already-built pages are reused
    // from cache instead of re-fetched.
    const sessionKey = JSON.stringify({
        target: currentActiveRowTarget, query: currentSearchQuery, studioId: selectedStudioId,
        genre: selectedDiscoverGenre, year: selectedDiscoverYear, season: selectedDiscoverSeason,
        dType: selectedDiscoverType, dStatus: selectedDiscoverStatus, dRating: selectedDiscoverRating,
        filterType, filterStatus, filterRating, filterOrder
    });

    if (sessionKey !== resultsSessionKey) {
        resultsSessionKey = sessionKey;
        resultsPageCache = new Map();
        resultsBuffer = [];
        resultsSeenIds = new Set();
        resultsNextRawPage = 1;
        resultsApiExhausted = false;
        resultsMaxBuiltPage = 0;
        resultsMeta = { total: 0, lastVisiblePage: null };
    }

    try {
        if (!resultsPageCache.has(currentPage)) {
            while (resultsBuffer.length < searchPageSize && !resultsApiExhausted) {
                const rawPage = resultsNextRawPage;
                const raw = await fetchRawResultsPage(rawPage, filterType, filterStatus, filterRating, filterOrder);
                resultsNextRawPage++;

                if (!raw?.data?.length) {
                    resultsApiExhausted = true;
                    break;
                }

                if (rawPage === 1) {
                    resultsMeta = {
                        total: raw.pagination?.items?.total ?? raw.data.length,
                        lastVisiblePage: raw.pagination?.last_visible_page ?? null
                    };
                }

                raw.data.forEach(anime => {
                    if (resultsSeenIds.has(anime.mal_id)) return;
                    resultsSeenIds.add(anime.mal_id);
                    resultsBuffer.push(anime);
                });

                if (!raw.pagination?.has_next_page) resultsApiExhausted = true;
            }

            const pageItems = resultsBuffer.splice(0, searchPageSize);
            resultsPageCache.set(currentPage, pageItems);
            resultsMaxBuiltPage = Math.max(resultsMaxBuiltPage, currentPage);
        }

        renderResultsPage(grid, resultsPageCache.get(currentPage) || []);

    } catch (err) {
        console.error("Grid load error:", err);
        grid.innerHTML = `<div class="empty-state">Failed to load results. The API may be rate-limited — wait a moment and try again.</div>`;
    } finally {
        showLoading(false);
    }
}

// Builds and fetches one raw Jikan page for the current target. rawPage is
// the API's own page counter, decoupled from currentPage (our virtual,
// post-dedupe page) — fetchExpandedGridData may need several raw pages to
// fill a single 24-item display page.
async function fetchRawResultsPage(rawPage, filterType, filterStatus, filterRating, filterOrder) {
    let url = "";

    if (currentActiveRowTarget === 'trending') {
        url = `https://api.jikan.moe/v4/seasons/now?page=${rawPage}&limit=${searchPageSize}&sfw=true`;

    } else if (currentActiveRowTarget === 'top') {
        url = `https://api.jikan.moe/v4/top/anime?page=${rawPage}&limit=${searchPageSize}&type=tv&sfw=true`;

    } else if (currentActiveRowTarget === 'discover') {
        if (selectedDiscoverYear && selectedDiscoverSeason && !selectedDiscoverGenre && !selectedDiscoverType && !selectedDiscoverStatus) {
            url = `https://api.jikan.moe/v4/seasons/${selectedDiscoverYear}/${selectedDiscoverSeason}?page=${rawPage}&limit=${searchPageSize}&sfw=true`;
        } else {
            url = `https://api.jikan.moe/v4/anime?page=${rawPage}&limit=${searchPageSize}&sfw=true`;
            if (selectedDiscoverGenre) url += `&genres=${selectedDiscoverGenre}`;
            if (selectedDiscoverYear) url += `&start_date=${selectedDiscoverYear}-01-01&end_date=${selectedDiscoverYear}-12-31`;
            if (selectedDiscoverType) url += `&type=${selectedDiscoverType}`;
            if (selectedDiscoverStatus) url += `&status=${selectedDiscoverStatus}`;
            if (selectedDiscoverRating) url += `&rating=${selectedDiscoverRating}`;
        }

    } else if (currentActiveRowTarget === 'studio') {
        url = `https://api.jikan.moe/v4/anime?producers=${selectedStudioId}&page=${rawPage}&limit=${searchPageSize}&sfw=true`;
        if (filterType)   url += `&type=${filterType}`;
        if (filterStatus) url += `&status=${filterStatus}`;
        if (filterRating) url += `&rating=${filterRating}`;
        if (filterOrder && filterOrder !== 'default') url += `&order_by=${filterOrder}&sort=desc`;

    } else {
        url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(currentSearchQuery)}&page=${rawPage}&limit=${searchPageSize}&sfw=true`;
        if (filterType)   url += `&type=${filterType}`;
        if (filterStatus) url += `&status=${filterStatus}`;
        if (filterRating) url += `&rating=${filterRating}`;
        if (filterOrder && filterOrder !== 'default') url += `&order_by=${filterOrder}&sort=desc`;
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    let result = await res.json();

    // Jikan sometimes returns error objects
    if (result.status && result.status !== 200) {
        throw new Error(result.message || 'API error');
    }

    // Title search came up completely empty on the very first raw page — the
    // search box advertises studio names too, so try matching the query
    // against a producer/studio before giving up.
    if (!result?.data?.length && currentActiveRowTarget === 'search' && rawPage === 1) {
        const studioFallback = await trySearchByStudioName(currentSearchQuery, rawPage);
        if (studioFallback?.data?.length) {
            result = studioFallback;
            document.getElementById('grid-title').textContent = `Search: "${currentSearchQuery}" (matched studio)`;
        }
    }

    return result;
}

// Jikan's anime search only matches titles, not studios — when the title
// search is empty, look up the query as a producer/studio name and pull
// that studio's catalogue instead.
async function trySearchByStudioName(query, page) {
    try {
        const prodRes = await fetch(`https://api.jikan.moe/v4/producers?q=${encodeURIComponent(query)}&limit=5`);
        if (!prodRes.ok) return null;
        const prodData = await prodRes.json();
        const lowerQuery = query.trim().toLowerCase();
        const match = prodData?.data?.find(p =>
            (p.titles || []).some(t => (t.title || '').toLowerCase() === lowerQuery)
        ) || prodData?.data?.[0];
        if (!match) return null;

        await delay(350);
        const animeRes = await fetch(`https://api.jikan.moe/v4/anime?producers=${match.mal_id}&page=${page}&limit=${searchPageSize}&sfw=true`);
        if (!animeRes.ok) return null;
        return await animeRes.json();
    } catch {
        return null;
    }
}

function renderResultsPage(grid, items) {
    grid.innerHTML = "";

    if (!items.length) {
        grid.innerHTML = '<div class="empty-state">No matching titles found. Try adjusting your filters.</div>';
        updatePaginationControls(false, resultsMeta.lastVisiblePage);
        document.getElementById('results-count').textContent = '0 Titles';
        return;
    }

    items.forEach(anime => grid.appendChild(createAnimeCard(anime)));

    document.getElementById('results-count').textContent = `${Number(resultsMeta.total).toLocaleString()} Titles Found`;

    hasNextPage = currentPage < resultsMaxBuiltPage || resultsBuffer.length > 0 || !resultsApiExhausted;
    updatePaginationControls(hasNextPage, resultsMeta.lastVisiblePage);
}

function executeGlobalSearch(query, page = 1) {
    // FIX: trim and validate query
    const trimmed = query.trim();
    if (!trimmed) return;

    currentActiveRowTarget = "search";
    currentSearchQuery = trimmed;
    currentPage = page;

    document.getElementById('grid-title').textContent = `Search: "${trimmed}"`;
    document.getElementById('global-filters-container').classList.remove('hidden');
    syncViewRoute('view-results', true, { target: 'search', query: trimmed, page });
    fetchExpandedGridData();
}

function updatePaginationControls(hasMore, totalPages) {
    const prevBtn = document.getElementById('prev-page-btn');
    const nextBtn = document.getElementById('next-page-btn');
    const indicator = document.getElementById('page-indicator');

    prevBtn.disabled = currentPage === 1;
    nextBtn.disabled = !hasMore;
    indicator.textContent = totalPages ? `Page ${currentPage} of ${totalPages}` : `Page ${currentPage}`;

    prevBtn.onclick = () => {
        if (currentPage > 1) { currentPage--; fetchExpandedGridData(); window.scrollTo({ top: 0 }); }
    };
    nextBtn.onclick = () => {
        if (hasMore) { currentPage++; fetchExpandedGridData(); window.scrollTo({ top: 0 }); }
    };
}

// ==========================================
// 10. SINGLE ANIME DETAIL VIEW
// ==========================================
async function viewSingleAnime(animeId, pushHistoryState = true) {
    showLoading(true);

    syncViewRoute('view-details', false);

    // Always push a fresh entry (never replace) — drilling from one detail
    // page into another (timeline node, cast VA role) must leave the prior
    // detail page in history so the back button returns to it, not to
    // whatever was open before the whole chain started.
    if (pushHistoryState) {
        history.pushState({ view: 'view-details', animeId }, "", "");
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });

    try {
        const response = await fetch(`https://api.jikan.moe/v4/anime/${animeId}/full`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        const anime = result.data;
        if (!anime) throw new Error("No anime data returned.");

        const posterImg = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || '';
        document.getElementById('detail-backdrop').style.backgroundImage = `url('${posterImg}')`;
        document.getElementById('detail-poster').src = posterImg;
        document.getElementById('detail-title').textContent = anime.title || '';
        document.getElementById('detail-synopsis').textContent = anime.synopsis || "No synopsis available.";

        document.getElementById('badge-score').textContent = anime.score ? `★ ${parseFloat(anime.score).toFixed(2)} / 10` : 'No Score';
        document.getElementById('badge-year').textContent = anime.year || anime.aired?.prop?.from?.year || 'TBA';
        document.getElementById('badge-rating').textContent = anime.rating || 'Unrated';
        document.getElementById('badge-episodes').textContent = anime.episodes ? `${anime.episodes} Episodes` : 'Ongoing';
        document.getElementById('badge-type').textContent = anime.type || 'TV';
        document.getElementById('badge-status').textContent = anime.status || 'Unknown';
        renderStudioLinks(anime.studios);

        // FIX: Build streaming links — Anikoto search + MAL only, no other platforms
        buildStreamingLinks(anime);

        appendAnimeToClickHistoryLog(anime);

        await delay(300);
        fetchCastProfiles(animeId);
        await delay(300);
        buildFranchiseTimeline(animeId, anime.title, anime.aired?.from, anime.aired?.to);

    } catch (err) {
        console.error("Detail view error:", err);
        showLoading(false);
    } finally {
        showLoading(false);
    }
}

// Each studio name is clickable — jumps to a grid of everything that studio made.
function renderStudioLinks(studios) {
    const container = document.getElementById('detail-studio');
    container.innerHTML = '';
    if (!studios?.length) {
        container.textContent = 'Unknown Studio';
        return;
    }
    studios.forEach((studio, idx) => {
        const link = document.createElement('span');
        link.className = 'studio-link';
        link.textContent = studio.name;
        link.addEventListener('click', () => viewStudioGrid(studio.mal_id, studio.name));
        container.appendChild(link);
        if (idx < studios.length - 1) container.appendChild(document.createTextNode(', '));
    });
}

// FIX: Streaming links — Anikoto search link + MAL profile, no third-party platforms
function buildStreamingLinks(anime) {
    const streamingWrapper = document.getElementById('streaming-links-container');
    streamingWrapper.innerHTML = "";

    // Anikoto search link using the anime title as keyword
    const searchTitle = (anime.title_english || anime.title || '').replace(/\s+/g, '+');
    const anikotoUrl = `https://anikototv.to/filter?keyword=${encodeURIComponent(anime.title_english || anime.title || '')}`;

    const anikotoBtn = document.createElement('a');
    anikotoBtn.className = 'watch-now-btn watch-custom';
    anikotoBtn.href = anikotoUrl;
    anikotoBtn.target = '_blank';
    anikotoBtn.rel = 'noopener noreferrer';
    anikotoBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Watch on Anikoto
    `;
    streamingWrapper.appendChild(anikotoBtn);

    // MAL profile link
    const malBtn = document.createElement('a');
    malBtn.className = 'watch-now-btn watch-mal';
    malBtn.href = anime.url || `https://myanimelist.net/anime/${anime.mal_id}`;
    malBtn.target = '_blank';
    malBtn.rel = 'noopener noreferrer';
    malBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        MyAnimeList Profile
    `;
    streamingWrapper.appendChild(malBtn);
}

// ==========================================
// 11. CAST & CHARACTERS
// ==========================================
async function fetchCastProfiles(animeId) {
    const container = document.getElementById('characters-list');
    container.innerHTML = '<div class="spinner"></div>';

    try {
        // Retries on 429 — without this, anime that load right after a burst
        // of other requests (relations/timeline calls) can silently come back
        // empty even though Jikan actually has character data for them.
        const res = await fetchJikanWithRetry(`https://api.jikan.moe/v4/anime/${animeId}/characters`);
        if (!res || !res.ok) throw new Error(`HTTP ${res?.status}`);
        const data = await res.json();

        container.innerHTML = "";
        if (!data?.data?.length) {
            container.innerHTML = '<div class="empty-state">No cast data available for this title.</div>';
            return;
        }

        const topCast = data.data.slice(0, 12);
        topCast.forEach(item => {
            const char = item.character;
            const jaVA = item.voice_actors?.find(va => va.language === 'Japanese');

            const card = document.createElement('div');
            card.className = 'cast-card';

            const charImg = char?.images?.jpg?.image_url || '';
            const vaName = jaVA?.person?.name || '';
            const vaId = jaVA?.person?.mal_id || null;

            if (charImg) {
                card.innerHTML = `
                    <img class="cast-avatar" src="${charImg}" alt="${escapeHtml(char.name)}" loading="lazy">
                    <div class="cast-info">
                        <span class="cast-char-name">${escapeHtml(char.name)}</span>
                        <span class="cast-va-name">${vaName ? escapeHtml(vaName) + ' (JP)' : 'No VA data'}</span>
                    </div>
                `;
            } else {
                card.innerHTML = `
                    <div class="cast-avatar-placeholder">👤</div>
                    <div class="cast-info">
                        <span class="cast-char-name">${escapeHtml(char.name)}</span>
                        <span class="cast-va-name">${vaName ? escapeHtml(vaName) + ' (JP)' : 'No VA data'}</span>
                    </div>
                `;
            }

            if (vaId && vaName) {
                const vaEl = card.querySelector('.cast-va-name');
                vaEl.style.cursor = 'pointer';
                vaEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openVoiceActorPortfolioPanel(vaId, vaName);
                });
            } else {
                card.querySelector('.cast-va-name').style.color = 'var(--text-muted)';
            }

            container.appendChild(card);
        });
    } catch (err) {
        console.error("Cast fetch error:", err);
        container.innerHTML = '<div class="empty-state">Failed to load cast information.</div>';
    }
}

// ==========================================
// 12. FRANCHISE TIMELINE
// ==========================================
// Only follow relation types that represent the same continuous story/series,
// so unrelated franchise hubs (crossovers, spin-offs, character cameos) don't
// blow up the traversal.
const CHAIN_RELATION_TYPES = new Set([
    'Prequel', 'Sequel', 'Parent Story', 'Side Story',
    'Full Story', 'Summary', 'Alternative Version', 'Alternative Setting'
]);
const MAX_FRANCHISE_NODES = 30;

async function buildFranchiseTimeline(animeId, currentTitle, currentAiredFrom, currentAiredTo) {
    const container = document.getElementById('chrono-timeline');
    container.innerHTML = '<div class="spinner"></div>';

    const cacheKey = `chain_${animeId}`;
    if (franchiseCache[cacheKey]) {
        renderTimelineLayout(franchiseCache[cacheKey], animeId);
        return;
    }

    try {
        const nodes = await collectFranchiseChain(parseInt(animeId), currentTitle, currentAiredFrom, currentAiredTo);
        // Don't permanently cache an apparent standalone — MAL's relation data
        // for very new/upcoming entries is often filled in after the fact, so
        // "no relations yet" can be momentarily incomplete rather than truly
        // standalone. Caching it would lock in the stale result for the rest
        // of the session even after MAL's data gets corrected.
        if (nodes.length > 1) {
            franchiseCache[cacheKey] = nodes;
        }
        renderTimelineLayout(nodes, animeId);
    } catch (err) {
        console.error("Timeline error:", err);
        container.innerHTML = '<div class="empty-state">Could not load franchise timeline.</div>';
    }
}

// Jikan's free tier hard-caps at 3 req/sec. Sequential traversal sits close to
// that ceiling, so on a 429 we back off and retry rather than silently giving
// up and truncating the chain.
async function fetchJikanWithRetry(url, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url);
            if (res.status === 429) {
                await delay(900 * (attempt + 1));
                continue;
            }
            return res;
        } catch {
            if (attempt === maxRetries) return null;
            await delay(900 * (attempt + 1));
        }
    }
    return null;
}

// Breadth-first walk of the relations graph, following only same-series relation types,
// until no new connected titles are found (capped to avoid runaway API usage on huge franchises).
async function collectFranchiseChain(rootId, rootTitle, rootAiredFrom, rootAiredTo) {
    const visited = new Map();
    visited.set(rootId, { mal_id: rootId, title: rootTitle, airedFrom: rootAiredFrom || null, airedTo: rootAiredTo || null, status: null, dateKnown: true });

    const queue = [rootId];
    const fetchedRelationsFor = new Set();

    while (queue.length > 0 && visited.size < MAX_FRANCHISE_NODES) {
        const currentId = queue.shift();
        if (fetchedRelationsFor.has(currentId)) continue;
        fetchedRelationsFor.add(currentId);

        await delay(400);
        const res = await fetchJikanWithRetry(`https://api.jikan.moe/v4/anime/${currentId}/relations`);
        if (!res || !res.ok) continue;
        let relData;
        try {
            relData = await res.json();
        } catch {
            continue;
        }

        (relData?.data || []).forEach(rel => {
            if (!CHAIN_RELATION_TYPES.has(rel.relation)) return;
            rel.entry.forEach(entry => {
                if (entry.type !== 'anime') return;
                if (visited.has(entry.mal_id) || visited.size >= MAX_FRANCHISE_NODES) return;
                visited.set(entry.mal_id, { mal_id: entry.mal_id, title: entry.name || 'Unknown Title', airedFrom: null, airedTo: null, status: null, dateKnown: false });
                queue.push(entry.mal_id);
            });
        });
    }

    // Resolve air dates (start + end) and accurate titles for every node that doesn't already have one
    const needsDate = [...visited.values()].filter(n => !n.dateKnown);
    for (const node of needsDate) {
        await delay(400);
        const res = await fetchJikanWithRetry(`https://api.jikan.moe/v4/anime/${node.mal_id}`);
        if (res?.ok) {
            try {
                const data = await res.json();
                node.title = data?.data?.title || node.title;
                node.airedFrom = data?.data?.aired?.from || null;
                node.airedTo = data?.data?.aired?.to || null;
                node.status = data?.data?.status || null;
            } catch {
                // leave dates as null — node still renders, just sorted to the end
            }
        }
    }

    return [...visited.values()];
}

function formatTimelineDateRange(node) {
    const fmt = (iso) => iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short' }) : null;
    const from = fmt(node.airedFrom);
    const to = fmt(node.airedTo);

    if (!from) return 'TBA';
    if (to && to !== from) return `${from} – ${to}`;
    if (!to && node.status === 'Currently Airing') return `${from} – Present`;
    return from;
}

function renderTimelineLayout(nodes, activeId) {
    const container = document.getElementById('chrono-timeline');
    container.innerHTML = "";

    if (!nodes || nodes.length === 0) {
        container.innerHTML = '<div class="empty-state">Could not load franchise timeline.</div>';
        return;
    }

    const sorted = [...nodes].sort((a, b) => {
        const aTime = a.airedFrom ? new Date(a.airedFrom).getTime() : Infinity;
        const bTime = b.airedFrom ? new Date(b.airedFrom).getTime() : Infinity;
        return aTime - bTime;
    });

    sorted.forEach(node => {
        const isCurrent = node.mal_id === parseInt(activeId);
        const dateLabel = formatTimelineDateRange(node);

        const div = document.createElement('div');
        div.className = `timeline-node${isCurrent ? ' current-node' : ''}`;
        div.innerHTML = `
            <div class="timeline-dot"></div>
            <div class="timeline-relation">${escapeHtml(dateLabel)}</div>
            <div class="timeline-title">${escapeHtml(node.title)}</div>
        `;

        if (!isCurrent) {
            div.addEventListener('click', () => viewSingleAnime(node.mal_id, true));
        }

        container.appendChild(div);
    });
}

// ==========================================
// 13. VOICE ACTOR MODAL
// ==========================================
async function openVoiceActorPortfolioPanel(personId, personName) {
    const modal = document.getElementById('va-modal');
    const nameHeading = document.getElementById('va-modal-name');
    const rolesContainer = document.getElementById('va-roles-container');

    nameHeading.textContent = personName;
    rolesContainer.innerHTML = '<div class="spinner"></div>';
    modal.classList.remove('hidden');

    document.getElementById('close-va-modal').onclick = () => modal.classList.add('hidden');
    modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };

    try {
        const res = await fetch(`https://api.jikan.moe/v4/people/${personId}/voices`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const result = await res.json();

        rolesContainer.innerHTML = "";
        if (!result?.data?.length) {
            rolesContainer.innerHTML = '<div class="empty-state">No portfolio data found for this voice actor.</div>';
            return;
        }

        result.data.slice(0, 15).forEach(role => {
            const card = document.createElement('div');
            card.className = 'va-role-card';
            card.innerHTML = `
                <span class="va-role-anime">${escapeHtml(role.anime?.title || 'Unknown Anime')}</span>
                <span class="va-role-char">as ${escapeHtml(role.character?.name || 'Unknown Character')}</span>
            `;

            if (role.anime?.mal_id) {
                card.addEventListener('click', () => {
                    modal.classList.add('hidden');
                    viewSingleAnime(role.anime.mal_id);
                });
            }

            rolesContainer.appendChild(card);
        });
    } catch (err) {
        console.error("VA modal error:", err);
        rolesContainer.innerHTML = '<div class="empty-state">Failed to load voice actor data.</div>';
    }
}

// ==========================================
// 14. SURPRISE ME (SHUFFLE)
// ==========================================
async function triggerRandomShuffle() {
    showLoading(true);
    let attempts = 0;
    const maxAttempts = 4;

    while (attempts < maxAttempts) {
        try {
            const response = await fetch('https://api.jikan.moe/v4/random/anime');
            if (!response.ok) {
                attempts++;
                await delay(600);
                continue;
            }
            const result = await response.json();

            // FIX: Check data exists AND has a valid mal_id
            if (result?.data?.mal_id) {
                viewSingleAnime(result.data.mal_id, true);
                return; // success — exit
            }
            attempts++;
            await delay(600);
        } catch (err) {
            console.error("Shuffle attempt failed:", err);
            attempts++;
            await delay(600);
        }
    }

    // All attempts failed
    showLoading(false);
    alert("Couldn't pick a random anime right now. The API may be busy — try again in a moment!");
}

// ==========================================
// 15. MY LIST / HISTORY
// ==========================================
function appendAnimeToClickHistoryLog(anime) {
    clickHistory = clickHistory.filter(item => item.mal_id !== anime.mal_id);
    clickHistory.unshift({
        mal_id: anime.mal_id,
        title: anime.title,
        images: {
            jpg: {
                large_image_url: anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || '',
                image_url: anime.images?.jpg?.image_url || ''
            }
        }
    });
    if (clickHistory.length > 50) clickHistory.pop();
    localStorage.setItem('chronoClickHistory', JSON.stringify(clickHistory));
}

function removeAnimeFromHistoryLog(animeId) {
    clickHistory = clickHistory.filter(item => item.mal_id !== parseInt(animeId));
    localStorage.setItem('chronoClickHistory', JSON.stringify(clickHistory));
    renderHistoryLogGrid();
}

function renderHistoryLogGrid() {
    const grid = document.getElementById('click-history-grid');
    if (!grid) return;
    grid.innerHTML = "";
    if (clickHistory.length === 0) {
        grid.innerHTML = '<div class="empty-state">Your list is empty. Browse anime and they\'ll appear here.</div>';
        return;
    }
    clickHistory.forEach(anime => grid.appendChild(createAnimeCard(anime, true)));
}

document.getElementById('clear-click-history').addEventListener('click', () => {
    if (confirm("Clear your entire watch history?")) {
        clickHistory = [];
        localStorage.setItem('chronoClickHistory', JSON.stringify(clickHistory));
        renderHistoryLogGrid();
    }
});

renderHistoryLogGrid();

/* ==========================================
   SCHEDULE VIEW
   ========================================== */

let scheduleInitialized = false;

function initScheduleView() {
    if (scheduleInitialized) return;
    scheduleInitialized = true;
    buildDayNav();
}

function buildDayNav() {
    const nav = document.getElementById('schedule-day-nav');
    if (!nav) return;
    nav.innerHTML = '';

    const today = new Date();
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);

        const btn = document.createElement('button');
        btn.className = 'sched-day-btn' + (i === 0 ? ' active' : '');
        btn.innerHTML = `
            <span class="sched-day-month">${months[d.getMonth()]} ${d.getDate()}</span>
            <span class="sched-day-name">${i === 0 ? 'Today' : days[d.getDay()]}</span>
        `;
        btn.addEventListener('click', () => {
            nav.querySelectorAll('.sched-day-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            fetchScheduleForDay(d.getDay());
        });
        nav.appendChild(btn);
    }

    fetchScheduleForDay(today.getDay());
}

async function fetchScheduleForDay(dayOfWeek) {
    const list = document.getElementById('schedule-list');
    if (!list) return;

    list.innerHTML = `<div class="schedule-loading"><div class="sched-spinner"></div><span>Fetching schedule...</span></div>`;

    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayParam = dayNames[dayOfWeek];

    try {
        // Fetch up to 3 pages to get a full day's schedule
        let allItems = [];
        for (let page = 1; page <= 3; page++) {
            const res = await fetch(`https://api.jikan.moe/v4/schedules?filter=${dayParam}&limit=25&page=${page}`);
            const json = await res.json();
            const items = json.data || [];
            allItems = allItems.concat(items);
            if (!json.pagination?.has_next_page) break;
        }

        // Filter TV only and deduplicate by mal_id
        const seen = new Set();
        const unique = allItems.filter(a => {
            if (seen.has(a.mal_id)) return false;
            seen.add(a.mal_id);
            return true;
        });

        renderScheduleList(unique, dayOfWeek);
    } catch(e) {
        list.innerHTML = `<div class="schedule-empty"><span>Could not load schedule. Please try again.</span></div>`;
    }
}

// Convert JST "HH:MM" to user's local time string
function jstToLocal(jstTime) {
    if (!jstTime) return null;
    const [h, m] = jstTime.split(':').map(Number);
    // JST = UTC+9
    const utcMs = Date.UTC(2000, 0, 1, h - 9, m);
    const local = new Date(utcMs);
    return local.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}

function renderScheduleList(items, dayOfWeek) {
    const list = document.getElementById('schedule-list');
    if (!list) return;

    if (!items || items.length === 0) {
        list.innerHTML = `<div class="schedule-empty"><span>No episodes scheduled for this day.</span></div>`;
        return;
    }

    // Sort by broadcast JST time
    items.sort((a, b) => {
        const ta = a.broadcast?.time || '99:99';
        const tb = b.broadcast?.time || '99:99';
        return ta.localeCompare(tb);
    });

    // Get user's timezone abbreviation
    const tzAbbr = new Intl.DateTimeFormat('en', { timeZoneName: 'short' })
        .formatToParts(new Date())
        .find(p => p.type === 'timeZoneName')?.value || 'Local';

    list.innerHTML = '';
    items.forEach(anime => {
        const item = document.createElement('div');
        item.className = 'schedule-item';

        const rawTime = anime.broadcast?.time;
        const localTime = jstToLocal(rawTime);
        let timeHTML = '';
        if (localTime) {
            timeHTML = `<div class="sched-time"><span class="sched-time-val">${localTime}</span><span class="sched-time-tz">${tzAbbr}</span></div>`;
        } else {
            timeHTML = `<div class="sched-time sched-time--tba"><span class="sched-time-val">TBA</span></div>`;
        }

        const ep = anime.episodes ? `${anime.episodes} eps` : 'Ongoing';
        const score = anime.score ? anime.score.toFixed(1) : null;
        const genres = (anime.genres || []).slice(0, 2).map(g => g.name).join(' · ');

        item.innerHTML = `
            ${timeHTML}
            <img class="sched-poster" src="${anime.images?.jpg?.image_url || ''}" alt="${anime.title}" loading="lazy">
            <div class="sched-info">
                <div class="sched-anime-title">${anime.title}</div>
                <div class="sched-meta">
                    <span class="sched-ep">${ep}</span>
                    ${genres ? `<span class="sched-genres">${genres}</span>` : ''}
                    <span class="sched-badge airing">Airing</span>
                </div>
            </div>
            ${score ? `<div class="sched-score"><svg width="11" height="11" viewBox="0 0 24 24" fill="#f5c518"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>${score}</div>` : ''}
        `;

        item.style.cursor = 'pointer';
        item.addEventListener('click', () => viewSingleAnime(anime.mal_id));

        list.appendChild(item);
    });
}

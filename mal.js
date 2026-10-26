/* ==========================================
   AniZone ⇄ MyAnimeList sync
   Log in with MyAnimeList, then track status, episodes and score from any
   anime page; My List shows your real MAL list.

   MAL's API can't be called straight from a web page and logging in needs a
   secret key, so requests go through a small relay you own (worker/mal-relay.js,
   a free Cloudflare Worker). The relay stores nothing: your MAL login tokens
   are kept in this browser only. Your MAL password is only ever typed on
   MyAnimeList's own page.
   ========================================== */
const MalSync = (() => {
    // Your relay's address, e.g. 'https://anizone-mal.<your-name>.workers.dev'.
    // Can also be set per browser in Profile Settings -> MyAnimeList.
    const RELAY_DEFAULT = 'https://anizone-mal.vavoruganti.workers.dev';
    const SETUP_GUIDE_URL = 'https://github.com/Legend-1125/Legend-1125.github.io/blob/main/worker/README.md';

    const RELAY_KEY = 'anizone:mal:relay:v1';
    const AUTH_KEY = 'anizone:mal:auth:v1';
    const PROFILE_KEY = 'anizone:mal:profile:v1';
    const LIST_KEY = 'anizone:mal:list:v2';   // v2 adds genres, season, airing and MAL score
    const LOGIN_KEY = 'anizone:mal:login:v1';           // sessionStorage, survives the trip to MAL and back
    const LIST_FRESH_MS = 2 * 60 * 1000;
    const SAVE_DELAY_MS = 700;                           // group quick +/- clicks into one save
    const LIST_FIELDS = 'list_status,num_episodes,nsfw,media_type,status,alternative_titles,genres,start_season,mean,average_episode_duration';

    const STATUSES = Object.freeze([
        ['watching', 'Watching'],
        ['completed', 'Completed'],
        ['on_hold', 'On Hold'],
        ['dropped', 'Dropped'],
        ['plan_to_watch', 'Plan to Watch'],
    ]);
    const STATUS_LABEL = Object.fromEntries(STATUSES);
    const SCORE_LABELS = ['–', 'Appalling', 'Horrible', 'Very Bad', 'Bad', 'Average', 'Fine', 'Good', 'Very Good', 'Great', 'Masterpiece'];

    class LoginRequiredError extends Error {
        constructor(message = 'Please log in with MyAnimeList again.') { super(message); this.name = 'LoginRequiredError'; }
    }

    /* ---------- small helpers ---------- */
    const read = (key, fallback, store = localStorage) => {
        try { const value = JSON.parse(store.getItem(key) || 'null'); return value ?? fallback; } catch { return fallback; }
    };
    const write = (key, value, store = localStorage) => { try { store.setItem(key, JSON.stringify(value)); } catch {} };
    const remove = (key, store = localStorage) => { try { store.removeItem(key); } catch {} };
    const $ = id => document.getElementById(id);

    // Letters and digits only: the PKCE standard also allows "-._~", but those
    // characters aren't needed and some sign-in servers are stricter than the standard.
    function randomString(length) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const bytes = crypto.getRandomValues(new Uint8Array(length));
        return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
    }
    // Login "state": 20 random letters/digits (checked on return) + which allowed
    // site to come back to. MyAnimeList rejects long or unusual state values.
    const STATE_NONCE_LENGTH = 20;
    const stateNonce = state => String(state || '').slice(0, STATE_NONCE_LENGTH);

    function toast(message, kind = 'info') {
        let host = $('az-toasts');
        if (!host) {
            host = document.createElement('div');
            host.id = 'az-toasts';
            host.className = 'az-toasts';
            host.setAttribute('role', 'status');
            host.setAttribute('aria-live', 'polite');
            document.body.appendChild(host);
        }
        const item = document.createElement('div');
        item.className = `az-toast ${kind}`;
        item.textContent = message;
        host.appendChild(item);
        setTimeout(() => item.classList.add('leaving'), 3200);
        setTimeout(() => item.remove(), 3600);
    }

    /* ---------- relay & login ---------- */
    function normalizeRelay(value) {
        const text = String(value || '').trim().replace(/\/+$/, '');
        if (!text) return '';
        try {
            const url = new URL(text);
            const local = ['localhost', '127.0.0.1'].includes(url.hostname);
            if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
            return url.origin + url.pathname.replace(/\/+$/, '');
        } catch { return null; }
    }
    const relayUrl = () => normalizeRelay(localStorage.getItem(RELAY_KEY)) || normalizeRelay(RELAY_DEFAULT) || '';
    const isConfigured = () => Boolean(relayUrl());
    const auth = () => read(AUTH_KEY, null);
    const isLoggedIn = () => Boolean(auth()?.refresh_token);
    const profile = () => read(PROFILE_KEY, null);

    async function relayFetch(path, init = {}) {
        if (!isConfigured()) throw new Error('MyAnimeList sync is not set up yet.');
        let response;
        try {
            response = await fetch(relayUrl() + path, { ...init, cache: 'no-store' });
        } catch {
            throw new Error('Could not reach your MyAnimeList relay. Check its address in Profile Settings.');
        }
        return response;
    }
    async function readError(response, fallback) {
        let payload = null;
        try { payload = await response.json(); } catch {}
        return payload?.message || payload?.error || fallback;
    }

    async function startLogin() {
        if (!isConfigured()) { openSettings(); toast('Add your relay address first (Profile Settings → MyAnimeList).', 'warn'); return; }
        try {
            const response = await relayFetch('/config');
            if (!response.ok) throw new Error(await readError(response, 'The relay is not set up correctly.'));
            const config = await response.json();
            const verifier = randomString(64);   // PKCE: MAL only supports the "plain" method (43-128 characters)
            const nonce = randomString(STATE_NONCE_LENGTH);
            if (!Number.isInteger(config.siteIndex) || config.siteIndex < 0) throw new Error('This site is not in the relay\'s ALLOWED_ORIGINS setting.');
            const back = location.hash && !location.hash.startsWith('#/mal-callback') ? location.hash : '#/';
            write(LOGIN_KEY, { verifier, nonce, back, relay: relayUrl(), startedAt: Date.now() }, sessionStorage);
            const state = `${nonce}${config.siteIndex}`;
            const params = new URLSearchParams({
                response_type: 'code',
                client_id: config.clientId,
                redirect_uri: config.callbackUrl,
                state,
                code_challenge: verifier,
                code_challenge_method: 'plain',
            });
            location.assign(`${config.authorizeUrl || 'https://myanimelist.net/v1/oauth2/authorize'}?${params}`);
        } catch (error) {
            siteAlert(error.message, { title: 'MyAnimeList' });
        }
    }

    function saveTokens(tokens) {
        const expiresIn = Number(tokens.expires_in) || 3600;
        write(AUTH_KEY, {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + Math.max(60, expiresIn - 120) * 1000,
        });
    }

    // MAL sent the visitor back to #/mal-callback?code=...&state=...
    async function handleCallback(route) {
        const pending = read(LOGIN_KEY, null, sessionStorage);
        remove(LOGIN_KEY, sessionStorage);
        const finish = (hash = pending?.back || '#/list') => navigate(hash, { replace: true }); // drop the code from history
        const notice = text => showNotice(text);
        notice('Connecting to MyAnimeList…');
        if (route.error) {
            finish('#/list');
            toast(route.error === 'access_denied' ? 'MyAnimeList login cancelled.' : 'MyAnimeList login did not complete.', 'warn');
            return;
        }
        if (!pending || stateNonce(route.state) !== pending.nonce || !route.code) {
            finish('#/list');
            siteAlert('That MyAnimeList login could not be verified. Please try logging in again from this page.', { title: 'MyAnimeList' });
            return;
        }
        try {
            if (pending.relay && pending.relay !== relayUrl()) localStorage.setItem(RELAY_KEY, pending.relay);
            const response = await relayFetch('/oauth/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: route.code, code_verifier: pending.verifier }),
            });
            if (!response.ok) throw new Error(await readError(response, 'MyAnimeList refused the login.'));
            saveTokens(await response.json());
            const me = await malApi('users/@me');
            write(PROFILE_KEY, { name: me?.name || 'MyAnimeList user', picture: me?.picture || '' });
            finish();
            toast(`Connected to MyAnimeList as ${me?.name || 'you'}.`, 'success');
            renderSettings();
            await refreshList({ force: true });
        } catch (error) {
            finish('#/list');
            siteAlert(error.message || 'Could not connect to MyAnimeList.', { title: 'MyAnimeList' });
        }
    }

    let refreshing = null;
    function refreshTokens() {
        if (refreshing) return refreshing;
        refreshing = (async () => {
            const current = auth();
            if (!current?.refresh_token) throw new LoginRequiredError();
            const response = await relayFetch('/oauth/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: current.refresh_token }),
            });
            if (response.status === 400 || response.status === 401) { logout({ quiet: true }); throw new LoginRequiredError('Your MyAnimeList login has expired. Please log in again.'); }
            if (!response.ok) throw new Error(await readError(response, 'Could not renew your MyAnimeList login.'));
            saveTokens(await response.json());
            return auth().access_token;
        })().finally(() => { refreshing = null; });
        return refreshing;
    }
    async function accessToken() {
        const current = auth();
        if (!current?.refresh_token) throw new LoginRequiredError();
        if (current.access_token && Date.now() < current.expires_at) return current.access_token;
        return refreshTokens();
    }

    // Calls https://api.myanimelist.net/v2/<path> through the relay.
    async function malApi(path, { method = 'GET', form = null, keepalive = false, retried = false } = {}) {
        const token = await accessToken();
        const headers = { Authorization: `Bearer ${token}` };
        if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        const response = await relayFetch(`/api/${path}`, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined, keepalive });
        if (response.status === 401 && !retried) {
            await refreshTokens();
            return malApi(path, { method, form, keepalive, retried: true });
        }
        if (response.status === 401) { logout({ quiet: true }); throw new LoginRequiredError(); }
        if (method === 'DELETE' && response.status === 404) return null; // already not on the list
        if (!response.ok) throw new Error(await readError(response, `MyAnimeList request failed (${response.status}).`));
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }

    function logout({ quiet = false } = {}) {
        [AUTH_KEY, PROFILE_KEY, LIST_KEY].forEach(key => remove(key));
        listCache = null;
        renderSettings();
        emit();   // the list view, progress panel and recommendations all update
        if (!quiet) toast('Logged out of MyAnimeList on this device.');
    }

    /* ---------- your list ---------- */
    let listCache = null;      // { entries: { [malId]: entry }, fetchedAt }
    let listRequest = null;
    const listeners = new Set();
    const emit = () => listeners.forEach(listener => { try { listener(); } catch (error) { console.error(error); } });

    function loadList() {
        if (!listCache) listCache = read(LIST_KEY, null) || { entries: {}, fetchedAt: 0 };
        return listCache;
    }
    function saveList() { write(LIST_KEY, listCache); }
    function entryFromNode(node, listStatus) {
        return {
            id: node.id,
            title: node.title || '',
            titleEn: node.alternative_titles?.en || '',
            picture: node.main_picture?.large || node.main_picture?.medium || '',
            episodes: Number(node.num_episodes) || 0,
            nsfw: node.nsfw || 'white',
            mediaType: node.media_type || '',
            airing: node.status || '',
            genres: (node.genres || []).map(genre => genre.name).filter(Boolean),
            season: node.start_season?.year ? { year: Number(node.start_season.year), season: node.start_season.season || '' } : null,
            mean: Number(node.mean) || 0,
            duration: Number(node.average_episode_duration) || 0,   // seconds per episode
            ...statusFields(listStatus),
        };
    }
    function statusFields(listStatus = {}) {
        return {
            status: listStatus.status || '',
            score: Number(listStatus.score) || 0,
            watched: Number(listStatus.num_episodes_watched) || 0,
            rewatching: Boolean(listStatus.is_rewatching),
            updatedAt: listStatus.updated_at || new Date().toISOString(),
        };
    }

    function refreshList({ force = false } = {}) {
        if (!isLoggedIn()) return Promise.resolve(null);
        const list = loadList();
        if (!force && Date.now() - list.fetchedAt < LIST_FRESH_MS) return Promise.resolve(list);
        if (listRequest) return listRequest;
        listRequest = (async () => {
            const entries = {};
            let path = `users/@me/animelist?fields=${encodeURIComponent(LIST_FIELDS)}&limit=1000&nsfw=true`;
            for (let page = 0; path && page < 20; page++) {
                const data = await malApi(path);
                (data?.data || []).forEach(({ node, list_status }) => { if (node?.id) entries[node.id] = entryFromNode(node, list_status); });
                const next = data?.paging?.next || '';
                path = next.startsWith('https://api.myanimelist.net/v2/') ? next.slice('https://api.myanimelist.net/v2/'.length) : '';
            }
            listCache = { entries, fetchedAt: Date.now() };
            saveList();
            emit();
            return listCache;
        })().catch(error => {
            if (error instanceof LoginRequiredError) toast(error.message, 'warn');
            throw error;
        }).finally(() => { listRequest = null; });
        return listRequest;
    }

    const getEntry = malId => loadList().entries[malId] || null;
    function putEntry(malId, entry) {
        const list = loadList();
        if (entry) list.entries[malId] = entry; else delete list.entries[malId];
        saveList();
        emit();
    }

    // Saves changes for one anime. Rapid changes are grouped, and saves for the
    // same anime are sent one after another so they can't arrive out of order.
    const saves = new Map(); // malId -> { changes, timer, running, base, info }
    // `base` is the entry as MyAnimeList has it before these changes, used to undo on failure.
    function queueSave(malId, changes, info, { immediate = false, base = getEntry(malId) } = {}) {
        const job = saves.get(malId) || { changes: {}, timer: null, running: null, base, info };
        Object.assign(job.changes, changes);
        job.info = info;
        saves.set(malId, job);
        setSaveState(malId, 'saving');
        clearTimeout(job.timer);
        job.timer = setTimeout(() => flushSave(malId), immediate ? 0 : SAVE_DELAY_MS);
    }
    async function flushSave(malId, { keepalive = false } = {}) {
        const job = saves.get(malId);
        if (!job) return;
        clearTimeout(job.timer);
        if (job.running) { await job.running.catch(() => {}); return flushSave(malId, { keepalive }); }
        const changes = job.changes;
        if (!Object.keys(changes).length) { saves.delete(malId); return; }
        job.changes = {};
        const form = {};
        if ('status' in changes) form.status = changes.status;
        if ('watched' in changes) form.num_watched_episodes = changes.watched;
        if ('score' in changes) form.score = changes.score;
        job.running = malApi(`anime/${malId}/my_list_status`, { method: 'PATCH', form, keepalive })
            .then(result => {
                const current = getEntry(malId);
                if (current && result) putEntry(malId, { ...current, ...statusFields(result) });
                if (!Object.keys(job.changes).length) { saves.delete(malId); setSaveState(malId, 'saved'); }
            })
            .catch(error => {
                // Put things back the way MyAnimeList still has them, and offer a retry.
                saves.delete(malId);
                putEntry(malId, job.base);
                setSaveState(malId, 'error', error, () => {
                    const retryFrom = getEntry(malId);
                    putEntry(malId, { ...(job.base || newEntry(job.info)), ...changes });
                    queueSave(malId, changes, job.info, { immediate: true, base: retryFrom });
                });
                throw error;
            })
            .finally(() => { job.running = null; });
        return job.running.catch(() => {});
    }
    function flushAll({ keepalive = false } = {}) { [...saves.keys()].forEach(id => flushSave(id, { keepalive })); }

    async function removeFromList(malId) {
        const pending = saves.get(malId);
        const before = pending ? pending.base : getEntry(malId);
        clearTimeout(pending?.timer);
        saves.delete(malId);
        putEntry(malId, null);
        setSaveState(malId, 'saving');
        try {
            await malApi(`anime/${malId}/my_list_status`, { method: 'DELETE' });
            setSaveState(malId, 'removed');
        } catch (error) {
            putEntry(malId, before);
            setSaveState(malId, 'error', error, () => removeFromList(malId));
        }
    }

    function newEntry(info) {
        return {
            id: info.id, title: info.title, titleEn: info.titleEn, picture: info.picture, episodes: info.episodes || 0,
            nsfw: info.isAdult ? 'black' : 'white', mediaType: info.mediaType || '', airing: info.airing || '',
            genres: info.genres || [], season: info.season || null, mean: info.mean || 0,
            status: '', score: 0, watched: 0, rewatching: false, updatedAt: new Date().toISOString(),
        };
    }

    // Applies a change the way MAL's own site does:
    // - adding episodes to something not yet started marks it Watching
    // - reaching the last episode marks it Completed
    // - marking it Completed fills in all episodes
    function applyChange(malId, info, change) {
        const prior = getEntry(malId);
        const before = prior || { ...newEntry(info), ...(malDetails.get(malId) || {}) };
        const total = before.episodes || info.episodes || 0;
        const next = { ...before, episodes: total, updatedAt: new Date().toISOString() };
        const changes = {};
        if ('watched' in change) {
            let watched = Math.max(0, Math.round(Number(change.watched) || 0));
            if (total) watched = Math.min(watched, total);
            next.watched = changes.watched = watched;
            if ((!before.status || before.status === 'plan_to_watch') && watched > 0) next.status = changes.status = 'watching';
            if (total && watched === total && next.status !== 'completed') { next.status = changes.status = 'completed'; toast(`Marked “${displayTitleOf(next)}” as completed.`, 'success'); }
            if (!before.status && watched === 0) next.status = changes.status = 'plan_to_watch';
        }
        if ('status' in change) {
            next.status = changes.status = change.status;
            if (change.status === 'completed' && total) next.watched = changes.watched = total;
        }
        if ('score' in change) next.score = changes.score = Math.min(10, Math.max(0, Number(change.score) || 0));
        if (!before.status && !('status' in changes)) next.status = changes.status = next.watched > 0 ? 'watching' : 'plan_to_watch';
        putEntry(malId, next);
        queueSave(malId, changes, info, { base: prior });
    }

    /* ---------- shared view helpers ---------- */
    function displayTitleOf(entry) {
        return (typeof titleLanguage !== 'undefined' && titleLanguage === 'english' && entry.titleEn) ? entry.titleEn : (entry.title || entry.titleEn || 'Untitled');
    }
    const hiddenAsAdult = entry => entry.nsfw === 'black' && typeof adultContentEnabled !== 'undefined' && !adultContentEnabled;
    function progressText(entry) {
        return `${entry.watched} / ${entry.episodes || '?'}`;
    }
    function progressPercent(entry) {
        if (entry.status === 'completed') return 100;
        return entry.episodes ? Math.round((entry.watched / entry.episodes) * 100) : (entry.watched ? 10 : 0);
    }
    function showNotice(text, kind = '') {
        const box = $('mylist-notice');
        if (!box) return;
        box.textContent = text || '';
        box.className = `mylist-notice${kind ? ` ${kind}` : ''}${text ? '' : ' hidden'}`;
    }

    /* ---------- anime page: progress panel ---------- */
    let panelAnime = null;
    const saveStates = new Map(); // malId -> { state, error, retry }
    // MAL's own details for anime opened this visit, so a title added from its page
    // sorts and filters (genres, MAL score, season) like the rest of the list.
    const malDetails = new Map();
    const DETAIL_FIELDS = 'my_list_status,num_episodes,mean,genres,start_season,media_type,status';
    function detailsFromNode(node) {
        return {
            mean: Number(node.mean) || 0,
            genres: (node.genres || []).map(genre => genre.name).filter(Boolean),
            season: node.start_season?.year ? { year: Number(node.start_season.year), season: node.start_season.season || '' } : null,
            mediaType: node.media_type || '',
            airing: node.status || '',
        };
    }

    function infoFromAnime(anime) {
        return {
            id: anime.idMal,
            title: anime.title?.romaji || anime.title?.english || '',
            titleEn: anime.title?.english || '',
            picture: anime.coverImage?.large || anime.coverImage?.extraLarge || '',
            episodes: anime.episodes || 0,
            isAdult: anime.isAdult,
            mediaType: ({ TV: 'tv', TV_SHORT: 'tv', MOVIE: 'movie', OVA: 'ova', ONA: 'ona', SPECIAL: 'special', MUSIC: 'music' })[anime.format] || '',
            airing: ({ RELEASING: 'currently_airing', FINISHED: 'finished_airing', NOT_YET_RELEASED: 'not_yet_aired' })[anime.status] || '',
            genres: anime.genres || [],
            season: anime.seasonYear ? { year: anime.seasonYear, season: (anime.season || '').toLowerCase() } : null,
        };
    }

    function renderProgressPanel(anime) {
        panelAnime = anime;
        const box = $('mal-progress');
        if (!box) return;
        if (!anime?.idMal) {
            box.innerHTML = '<p class="mal-progress-note">This title isn\'t on MyAnimeList, so its progress can\'t be tracked there.</p>';
            return;
        }
        if (!isConfigured() || !isLoggedIn()) {
            const hint = isConfigured() ? 'Log in with MyAnimeList to track your episodes, status and score' : 'Set up MyAnimeList (Profile Settings) to track your episodes, status and score';
            box.innerHTML = `<div class="mal-pills"><button class="mal-track-btn" type="button" data-mal-action="login" title="${hint}" aria-label="${hint}">+ Track on MyAnimeList</button></div>`;
            box.querySelector('[data-mal-action="login"]').addEventListener('click', () => isConfigured() ? startLogin() : openSettings());
            return;
        }
        drawPanel();
        // Pick up changes made on MyAnimeList itself (or another device).
        const malId = anime.idMal;
        malApi(`anime/${malId}?fields=${DETAIL_FIELDS}`).then(data => {
            if (data) malDetails.set(malId, detailsFromNode(data));
            if (panelAnime?.idMal !== malId || saves.has(malId)) return;
            const current = getEntry(malId);
            if (data?.my_list_status) {
                const merged = { ...(current || newEntry(infoFromAnime(anime))), ...malDetails.get(malId), episodes: Number(data.num_episodes) || current?.episodes || anime.episodes || 0, ...statusFields(data.my_list_status) };
                putEntry(malId, merged);
            } else if (current) {
                putEntry(malId, null);
            }
        }).catch(error => {
            if (panelAnime?.idMal === malId && error instanceof LoginRequiredError) renderProgressPanel(anime);
        });
    }

    function drawPanel() {
        const anime = panelAnime;
        const box = $('mal-progress');
        if (!anime?.idMal || !box || !isLoggedIn()) return;
        const malId = anime.idMal;
        const info = infoFromAnime(anime);
        const entry = getEntry(malId);
        const total = entry?.episodes || info.episodes || 0;
        const watched = entry?.watched || 0;
        const status = entry?.status || '';
        const score = entry?.score || 0;
        const focused = document.activeElement?.closest?.('#mal-progress [data-mal-focus]')?.dataset.malFocus;
        const percent = entry ? progressPercent({ ...entry, episodes: total }) : 0;
        // Three soft pills beside the Watch button, in the same style as the score badges.
        // The episode pill fills with colour as you watch. Removing is in the status menu.
        box.innerHTML = `<div class="mal-pills" role="group" aria-label="My progress on MyAnimeList">
            <div class="mal-control mal-status-pick mal-status-${status || 'none'}" data-mal-focus="status">
                <select data-mal="status" aria-label="Status on my list">
                    <option value="">${entry ? 'Remove from my list' : 'Add to my list'}</option>
                    ${STATUSES.map(([value, label]) => `<option value="${value}"${value === status ? ' selected' : ''}>${label}</option>`).join('')}
                </select>
            </div>
            <div class="mal-stepper" role="group" aria-label="Episodes watched" data-mal-focus="episodes" style="--progress:${percent}%">
                <button type="button" data-mal="minus" aria-label="One episode fewer"${watched <= 0 ? ' disabled' : ''}>−</button>
                <label class="mal-stepper-value"><span class="mal-ep-label">Ep</span><input data-mal="episodes" type="number" inputmode="numeric" min="0"${total ? ` max="${total}"` : ''} value="${watched}" aria-label="Episodes watched"><span>/ ${total || '?'}</span></label>
                <button type="button" data-mal="plus" aria-label="One more episode"${total && watched >= total ? ' disabled' : ''}>+</button>
            </div>
            <div class="mal-control mal-score-pick${score ? ' has-score' : ''}" data-mal-focus="score">
                <select data-mal="score" aria-label="My score">
                    ${SCORE_LABELS.map((label, value) => `<option value="${value}"${value === score ? ' selected' : ''}>${value ? `${value} · ${label}` : 'Score'}</option>`).reverse().join('')}
                </select>
            </div>
            <span class="mal-save-state" data-mal-state aria-live="polite"></span>
        </div>`;
        // The same rounded dropdowns as the rest of the site.
        box.querySelectorAll('select').forEach(select => { if (typeof enhanceSelect === 'function') enhanceSelect(select); });
        const q = name => box.querySelector(`[data-mal="${name}"]`);
        q('status').addEventListener('change', async event => {
            const value = event.target.value;
            if (!value) {
                if (entry && await siteConfirm(`Remove “${displayTitleOf(entry)}” from your MyAnimeList?`, { title: 'Remove from list', confirmText: 'Remove' })) removeFromList(malId);
                else drawPanel();
                return;
            }
            applyChange(malId, info, { status: value });
        });
        q('plus').addEventListener('click', () => applyChange(malId, info, { watched: (getEntry(malId)?.watched || 0) + 1 }));
        q('minus').addEventListener('click', () => applyChange(malId, info, { watched: (getEntry(malId)?.watched || 0) - 1 }));
        q('episodes').addEventListener('change', event => applyChange(malId, info, { watched: event.target.value }));
        q('score').addEventListener('change', event => applyChange(malId, info, { score: event.target.value }));
        q('remove')?.addEventListener('click', async () => {
            if (await siteConfirm(`Remove “${displayTitleOf(entry)}” from your MyAnimeList?`, { title: 'Remove from list', confirmText: 'Remove' })) removeFromList(malId);
        });
        if (focused) box.querySelector(`[data-mal-focus="${focused}"]`)?.querySelector('button:not(:disabled), input')?.focus();
        paintSaveState(malId);
    }

    function setSaveState(malId, state, error = null, retry = null) {
        saveStates.set(malId, { state, error, retry });
        if (state === 'saved' || state === 'removed') setTimeout(() => { if (saveStates.get(malId)?.state === state) { saveStates.delete(malId); paintSaveState(malId); } }, 2500);
        paintSaveState(malId);
        if (state === 'error') toast(`Couldn't save to MyAnimeList: ${error?.message || 'unknown error'}`, 'error');
    }
    function paintSaveState(malId) {
        if (panelAnime?.idMal !== malId) return;
        const host = document.querySelector('#mal-progress [data-mal-state]');
        if (!host) return;
        const info = saveStates.get(malId);
        host.className = `mal-save-state ${info?.state || ''}`;
        if (!info) { host.textContent = ''; return; }
        if (info.state === 'saving') host.textContent = 'Saving…';
        else if (info.state === 'saved') host.textContent = '✓ Saved';
        else if (info.state === 'removed') host.textContent = '✓ Removed from MyAnimeList';
        else if (info.state === 'error') {
            host.innerHTML = '⚠ Not saved · <button type="button" class="mal-link-btn">Retry</button>';
            host.querySelector('button').addEventListener('click', () => info.retry?.());
        }
    }

    /* ---------- My List page ---------- */
    // Sort and filter state lives in the address (#/list?tab=...&sort=...&type=...),
    // so refresh, Back and shared links keep it.
    const SORTS = Object.freeze({
        updated: { label: 'Last updated', order: 'desc' },
        title: { label: 'Title', order: 'asc' },
        score: { label: 'My score', order: 'desc' },
        mean: { label: 'MAL score', order: 'desc' },
        progress: { label: 'Progress', order: 'desc' },
        aired: { label: 'Air date', order: 'desc' },
        type: { label: 'Type', order: 'asc' },
    });
    const TYPES = Object.freeze({ tv: 'TV', movie: 'Movie', ova: 'OVA', ona: 'ONA', special: 'Special', music: 'Music' });
    const AIRING = Object.freeze({ currently_airing: 'Airing', finished_airing: 'Finished', not_yet_aired: 'Not yet aired' });
    const SEASONS = ['winter', 'spring', 'summer', 'fall'];
    const SCORE_FILTERS = Object.freeze({ scored: 'Scored', unscored: 'Not scored', 9: '9 or higher', 8: '8 or higher', 7: '7 or higher', 5: '5 or higher', low: '4 or lower' });
    const FILTER_KEYS = ['type', 'airing', 'year', 'season', 'genre', 'score'];
    let currentTab = '';
    let listView = defaultListView();
    let searchTimer = null;

    function defaultListView() { return { q: '', sort: 'updated', order: '', type: '', airing: '', year: '', season: '', genre: '', score: '' }; }
    function readListView(params = {}) {
        const view = defaultListView();
        view.q = String(params.q || '').slice(0, 80);
        if (SORTS[params.sort]) view.sort = params.sort;
        if (['asc', 'desc'].includes(params.order)) view.order = params.order;
        if (TYPES[params.type]) view.type = params.type;
        if (AIRING[params.airing]) view.airing = params.airing;
        if (/^\d{4}$/.test(params.year || '')) view.year = params.year;
        if (SEASONS.includes(params.season)) view.season = params.season;
        if (params.genre) view.genre = String(params.genre).slice(0, 40);
        if (SCORE_FILTERS[params.score]) view.score = params.score;
        return view;
    }
    const sortOrder = () => listView.order || SORTS[listView.sort].order;
    function listHash(tab = currentTab, view = listView) {
        const params = { tab };
        if (view.q) params.q = view.q;
        if (view.sort !== 'updated') params.sort = view.sort;
        if (view.order && view.order !== SORTS[view.sort].order) params.order = view.order;
        FILTER_KEYS.forEach(key => { if (view[key]) params[key] = view[key]; });
        return routeHash('/list', params);
    }
    function syncListUrl() {
        const hash = listHash();
        if (hash !== location.hash) history.replaceState(history.state, '', hash);
    }
    const activeFilterCount = () => FILTER_KEYS.filter(key => listView[key]).length;

    function typeGroup(mediaType) { return mediaType === 'tv_special' ? 'special' : mediaType; }
    function matchesView(entry) {
        const v = listView;
        if (v.q) {
            const needle = v.q.toLowerCase();
            if (!`${entry.title} ${entry.titleEn}`.toLowerCase().includes(needle)) return false;
        }
        if (v.type && typeGroup(entry.mediaType) !== v.type) return false;
        if (v.airing && entry.airing !== v.airing) return false;
        if (v.year && entry.season?.year !== Number(v.year)) return false;
        if (v.season && entry.season?.season !== v.season) return false;
        if (v.genre && !(entry.genres || []).includes(v.genre)) return false;
        if (v.score) {
            const s = entry.score || 0;
            if (v.score === 'scored' && !s) return false;
            if (v.score === 'unscored' && s) return false;
            if (v.score === 'low' && !(s > 0 && s <= 4)) return false;
            if (/^\d+$/.test(v.score) && s < Number(v.score)) return false;
        }
        return true;
    }
    function sortValue(entry) {
        switch (listView.sort) {
            case 'title': return displayTitleOf(entry).toLowerCase();
            case 'score': return entry.score || null;          // unscored always last
            case 'mean': return entry.mean || null;
            case 'progress': return entry.status === 'completed' ? 1 : (entry.episodes ? entry.watched / entry.episodes : (entry.watched ? 0.01 : 0));
            case 'aired': return entry.season?.year ? entry.season.year * 10 + SEASONS.indexOf(entry.season.season) : null;
            case 'type': return Object.keys(TYPES).indexOf(typeGroup(entry.mediaType)) >= 0 ? Object.keys(TYPES).indexOf(typeGroup(entry.mediaType)) : 99;
            default: return String(entry.updatedAt || '');
        }
    }
    function sortEntries(items) {
        const direction = sortOrder() === 'asc' ? 1 : -1;
        return items.map(entry => ({ entry, value: sortValue(entry) })).sort((a, b) => {
            if (a.value == null && b.value != null) return 1;
            if (b.value == null && a.value != null) return -1;
            if (a.value != null && b.value != null && a.value !== b.value) return (a.value < b.value ? -1 : 1) * direction;
            return displayTitleOf(a.entry).localeCompare(displayTitleOf(b.entry));
        }).map(item => item.entry);
    }

    function renderMyList(tab = '', params = {}) {
        const loggedIn = isConfigured() && isLoggedIn();
        const validTabs = ['all', ...STATUSES.map(([value]) => value)];
        currentTab = validTabs.includes(tab) ? tab : 'watching';
        listView = readListView(params);
        if (loggedIn) refreshList().catch(error => showNotice(error.message, 'error')); // starts first so the list shows a spinner, not "empty"
        syncToolbar(true);
        drawMyList();
    }

    function optionsHtml(map, current, emptyLabel) {
        return `<option value="">${emptyLabel}</option>` + Object.entries(map).map(([value, label]) => `<option value="${escapeHtml(value)}"${value === current ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
    }
    // Puts the current sort/filter values into the toolbar. Year and genre choices
    // come from what's actually on your list.
    function syncToolbar(force = false) {
        const entries = Object.values(loadList().entries).filter(entry => !hiddenAsAdult(entry));
        const years = [...new Set(entries.map(entry => entry.season?.year).filter(Boolean))].sort((a, b) => b - a);
        const genres = [...new Set(entries.flatMap(entry => entry.genres || []))].sort((a, b) => a.localeCompare(b));
        if (listView.year && !years.includes(Number(listView.year))) years.unshift(Number(listView.year));
        if (listView.genre && !genres.includes(listView.genre)) genres.unshift(listView.genre);
        const set = (id, html, value) => {
            const select = $(id);
            if (!select) return;
            if (html != null && select.dataset.options !== html) { select.innerHTML = html; select.dataset.options = html; }
            select.value = value;
            select._azRebuild?.();
        };
        set('mylist-sort', Object.entries(SORTS).map(([value, { label }]) => `<option value="${value}">${label}</option>`).join(''), listView.sort);
        set('mylist-type', optionsHtml(TYPES, listView.type, 'All types'), listView.type);
        set('mylist-airing', optionsHtml(AIRING, listView.airing, 'Any airing status'), listView.airing);
        set('mylist-year', optionsHtml(Object.fromEntries(years.map(year => [String(year), String(year)])), listView.year, 'All years'), listView.year);
        set('mylist-season', optionsHtml({ winter: 'Winter', spring: 'Spring', summer: 'Summer', fall: 'Fall' }, listView.season, 'All seasons'), listView.season);
        set('mylist-genre', optionsHtml(Object.fromEntries(genres.map(genre => [genre, genre])), listView.genre, 'All genres'), listView.genre);
        set('mylist-score', optionsHtml(SCORE_FILTERS, listView.score, 'Any score'), listView.score);
        const search = $('mylist-search');
        if (search && (force || document.activeElement !== search)) search.value = listView.q;
        const order = $('mylist-order');
        if (order) {
            const asc = sortOrder() === 'asc';
            order.textContent = asc ? '↑' : '↓';
            order.setAttribute('aria-label', asc ? 'Ascending order. Switch to descending' : 'Descending order. Switch to ascending');
            order.title = asc ? 'Ascending' : 'Descending';
        }
        const count = activeFilterCount();
        const badge = document.querySelector('#mylist-filter-toggle .mylist-filter-count');
        if (badge) badge.textContent = count ? String(count) : '';
        $('mylist-filter-reset')?.classList.toggle('hidden', !count && !listView.q);
    }

    function drawMyList() {
        const tabs = $('mylist-tabs');
        const grid = $('mal-list-grid');
        const toolbar = $('mylist-toolbar');
        const filterPanel = $('mylist-filter-panel');
        const countLine = $('mylist-count');
        if (!tabs || !grid) return;
        const loggedIn = isConfigured() && isLoggedIn();
        const entries = Object.values(loadList().entries).filter(entry => !hiddenAsAdult(entry));
        const tabLink = (value, label, count) => `<a class="mylist-tab${currentTab === value ? ' active' : ''}" href="${listHash(value)}"${currentTab === value ? ' aria-current="page"' : ''}>${label}${count != null ? ` <span>${count}</span>` : ''}</a>`;
        tabs.innerHTML = loggedIn ? tabLink('all', 'All', entries.length) + STATUSES.map(([value, label]) => tabLink(value, label, entries.filter(entry => entry.status === value).length)).join('') : '';
        tabs.classList.toggle('hidden', !loggedIn);
        renderActions(loggedIn);
        toolbar?.classList.toggle('hidden', !loggedIn);
        if (!loggedIn) { filterPanel?.classList.add('hidden'); $('mylist-filter-toggle')?.setAttribute('aria-expanded', 'false'); }
        countLine?.classList.toggle('hidden', !loggedIn);
        if (!loggedIn) {
            showNotice('');
            grid.classList.remove('mal-rows');
            grid.innerHTML = `<div class="empty-state mylist-signed-out"><strong>Your MyAnimeList list lives here.</strong><span>${isConfigured() ? 'Log in with MyAnimeList to see your list and update your progress from AniZone.' : 'Connect MyAnimeList in Profile Settings to keep your list here.'}</span><a class="btn-secondary inline-action" href="#/profile?tab=history">See what you've opened on AniZone</a></div>`;
            return;
        }
        syncToolbar();
        if (!loadList().fetchedAt && listRequest) { grid.innerHTML = '<div class="spinner"></div>'; showNotice(''); if (countLine) countLine.textContent = ''; return; }
        showNotice('');
        const inTab = currentTab === 'all' ? entries : entries.filter(entry => entry.status === currentTab);
        const items = sortEntries(inTab.filter(matchesView));
        const tabName = currentTab === 'all' ? 'your list' : STATUS_LABEL[currentTab];
        if (countLine) countLine.textContent = inTab.length && items.length !== inTab.length ? `Showing ${items.length} of ${inTab.length}` : '';
        if (!inTab.length) { grid.innerHTML = `<div class="empty-state">Nothing in ${escapeHtml(tabName)} yet.</div>`; return; }
        if (!items.length) {
            grid.innerHTML = `<div class="empty-state">Nothing in ${escapeHtml(tabName)} matches these filters.<button type="button" class="inline-retry-btn" data-mal-action="clear-filters">Clear filters</button></div>`;
            grid.querySelector('[data-mal-action="clear-filters"]').addEventListener('click', clearListFilters);
            return;
        }
        grid.innerHTML = '';
        const rows = layout === 'list';
        grid.classList.toggle('mal-rows', rows);
        items.forEach(entry => grid.appendChild(rows ? listRow(entry) : listCard(entry)));
    }

    /* ---------- Profile page: Stats and History ---------- */
    let profileTab = 'stats';
    function renderProfile(tab = '') {
        const loggedIn = isConfigured() && isLoggedIn();
        profileTab = ['stats', 'history'].includes(tab) ? tab : (loggedIn ? 'stats' : 'history');
        if (loggedIn) refreshList().catch(error => toast(error.message, 'warn'));
        drawProfile();
    }
    function drawProfile() {
        const head = $('profile-head');
        const tabs = $('profile-tabs');
        const statsPanel = $('mylist-stats');
        const historyPanel = $('history-panel');
        if (!head || !tabs || !statsPanel || !historyPanel) return;
        const loggedIn = isConfigured() && isLoggedIn();
        const me = loggedIn ? profile() : null;
        const avatar = me?.picture && /^https:\/\//.test(me.picture) ? `<img class="profile-head-avatar" src="${escapeHtml(me.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="profile-head-avatar placeholder" aria-hidden="true">${escapeHtml((me?.name || 'A').slice(0, 1).toUpperCase())}</span>`;
        head.innerHTML = `${avatar}<div class="profile-head-text"><h2>${escapeHtml(me?.name ? `${me.name}` : 'Your profile')}</h2><p class="page-subtitle">${loggedIn ? 'Stats from your MyAnimeList list, and what you’ve opened on AniZone' : 'What you’ve opened on AniZone. Log in with MyAnimeList for your stats.'}</p></div>${loggedIn ? '<button class="btn-secondary" type="button" data-mal-action="sync">Sync now</button>' : `<button class="btn-primary" type="button" data-mal-action="login">${isConfigured() ? 'Log in with MyAnimeList' : 'Set up MyAnimeList'}</button>`}`;
        head.querySelector('[data-mal-action="sync"]')?.addEventListener('click', async event => {
            event.target.disabled = true;
            try { await refreshList({ force: true }); toast('Your MyAnimeList is up to date.', 'success'); }
            catch (error) { toast(error.message, 'warn'); }
            finally { event.target.disabled = false; }
        });
        head.querySelector('[data-mal-action="login"]')?.addEventListener('click', () => isConfigured() ? startLogin() : openSettings());
        const historyCount = (typeof clickHistory !== 'undefined' ? clickHistory : []).filter(item => adultContentEnabled || !item.isAdult).length;
        const tab = (value, label, count) => `<a class="mylist-tab${profileTab === value ? ' active' : ''}" href="#/profile?tab=${value}"${profileTab === value ? ' aria-current="page"' : ''}>${label}${count != null ? ` <span>${count}</span>` : ''}</a>`;
        tabs.innerHTML = tab('stats', 'Stats') + tab('history', 'History', historyCount);
        statsPanel.classList.toggle('hidden', profileTab !== 'stats');
        historyPanel.classList.toggle('hidden', profileTab !== 'history');
        if (profileTab === 'history') { renderHistoryLogGrid(); return; }
        if (!loggedIn) {
            statsPanel.innerHTML = `<div class="empty-state"><strong>Your anime stats</strong><span>Log in with MyAnimeList to see time watched, how you score, your favourite genres and more.</span></div>`;
            return;
        }
        if (!loadList().fetchedAt && listRequest) { statsPanel.innerHTML = '<div class="spinner"></div>'; return; }
        renderStats(statsPanel, Object.values(loadList().entries).filter(entry => !hiddenAsAdult(entry)));
    }

    /* ---------- Stats ---------- */
    // Everything is worked out from your MyAnimeList list on this device.
    const DEFAULT_MINUTES = { movie: 100, music: 4 };   // when MAL has no episode length
    function episodesSeen(entry) {
        return entry.status === 'completed' ? Math.max(entry.watched, entry.episodes || 0) : entry.watched;
    }
    function minutesWatched(entry) {
        const perEpisode = entry.duration ? entry.duration / 60 : (DEFAULT_MINUTES[entry.mediaType] || 24);
        return episodesSeen(entry) * perEpisode;
    }
    const better = (a, b) => (b.score - a.score) || ((b.mean || 0) - (a.mean || 0));
    function computeStats(entries) {
        const byStatus = Object.fromEntries(STATUSES.map(([value]) => [value, 0]));
        const scores = Array(11).fill(0);
        const genres = new Map();
        const types = new Map();
        const years = new Map();
        let episodes = 0, minutes = 0, scoreSum = 0, scored = 0, diffSum = 0, diffCount = 0, malSum = 0;
        for (const entry of entries) {
            if (entry.status in byStatus) byStatus[entry.status]++;
            episodes += episodesSeen(entry);
            minutes += minutesWatched(entry);
            if (entry.score) {
                scores[entry.score]++; scoreSum += entry.score; scored++;
                if (entry.mean) { diffSum += entry.score - entry.mean; malSum += entry.mean; diffCount++; }
            }
            if (entry.status === 'plan_to_watch') continue;   // tastes come from what you've actually watched
            for (const genre of entry.genres || []) {
                const g = genres.get(genre) || { name: genre, count: 0, scoreSum: 0, scored: 0, best: null, pictured: [] };
                g.count++;
                if (entry.score) { g.scoreSum += entry.score; g.scored++; }
                if (entry.picture && (!g.best || better(g.best, entry) > 0)) g.best = entry;
                if (entry.picture) g.pictured.push(entry);
                genres.set(genre, g);
            }
            const type = TYPES[typeGroup(entry.mediaType)] || 'Other';
            types.set(type, (types.get(type) || 0) + 1);
            if (entry.season?.year) years.set(entry.season.year, (years.get(entry.season.year) || 0) + 1);
        }
        const finished = byStatus.completed + byStatus.dropped;
        const withBoth = entries.filter(entry => entry.score && entry.mean);
        const takes = withBoth.map(entry => ({ entry, diff: entry.score - entry.mean }));
        return {
            total: entries.length, started: entries.length - byStatus.plan_to_watch, byStatus, episodes, minutes, scores,
            meanScore: scored ? scoreSum / scored : 0, scored,
            malMean: diffCount ? malSum / diffCount : 0,
            vsMal: diffCount >= 3 ? diffSum / diffCount : null,
            finishRate: finished ? byStatus.completed / finished : null,
            genres: [...genres.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
            types: [...types.entries()].sort((a, b) => b[1] - a[1]),
            years,
            favourites: entries.filter(entry => entry.score).sort(better).slice(0, 6),
            loved: takes.filter(t => t.diff >= 1).sort((a, b) => b.diff - a.diff).slice(0, 3),
            notForYou: takes.filter(t => t.diff <= -1).sort((a, b) => a.diff - b.diff).slice(0, 3),
        };
    }
    const formatNumber = (n) => Math.round(n).toLocaleString();
    const pct = (n, of) => of ? Math.round((n / of) * 100) : 0;
    const malLink = (entry) => `#/mal/${Number(entry.id)}`;
    const safePicture = (url) => /^https:\/\/[^\s"'<>]+$/.test(String(url || '')) ? url : '';
    // Statuses whose colour is light get dark text inside the bar.
    const LIGHT_STATUS = new Set(['on_hold', 'plan_to_watch']);

    function renderStats(panel, entries) {
        if (!entries.length) {
            panel.innerHTML = '<div class="empty-state">Add some anime to your MyAnimeList list to see your stats here.</div>';
            return;
        }
        const st = computeStats(entries);
        const days = Math.floor(st.minutes / 1440);
        const hours = Math.round((st.minutes - days * 1440) / 60);
        const timeValue = days ? `${days.toLocaleString()}<small>${days === 1 ? 'day' : 'days'}</small>${hours ? ` ${hours}<small>h</small>` : ''}` : `${Math.round(st.minutes / 60)}<small>hours</small>`;
        const heroPosters = st.favourites.filter(entry => safePicture(entry.picture)).slice(0, 5);

        // Quick facts
        const vs = st.vsMal == null ? null : Math.round(st.vsMal * 100) / 100;
        const ring = st.finishRate == null ? '' : (() => {
            const r = 26, c = 2 * Math.PI * r, done = c * st.finishRate;
            return `<svg class="stats-ring" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="${r}" class="stats-ring-track"/><circle cx="32" cy="32" r="${r}" class="stats-ring-value" stroke-dasharray="${done.toFixed(1)} ${(c - done).toFixed(1)}" transform="rotate(-90 32 32)"/></svg>`;
        })();
        const facts = `
            <div class="stats-fact">
                <span class="stats-eyebrow">Your mean score</span>
                <strong class="stats-fact-value">${st.scored ? st.meanScore.toFixed(2) : '–'}</strong>
                <span class="stats-fact-note">${st.scored ? `from ${formatNumber(st.scored)} scored` : 'nothing scored yet'}</span>
                ${vs == null ? '' : `<span class="stats-chip">${vs > 0.05 ? '▲' : vs < -0.05 ? '▼' : '='} ${vs > 0 ? '+' : ''}${vs.toFixed(2)} vs MyAnimeList</span>`}
            </div>
            <div class="stats-fact stats-fact-ring">
                <div><span class="stats-eyebrow">You finish</span>
                <strong class="stats-fact-value">${st.finishRate == null ? '–' : `${Math.round(st.finishRate * 100)}%`}</strong>
                <span class="stats-fact-note">${st.finishRate == null ? 'nothing finished or dropped yet' : `${formatNumber(st.byStatus.completed)} completed · ${formatNumber(st.byStatus.dropped)} dropped`}</span></div>
                ${ring}
            </div>
            <div class="stats-fact">
                <span class="stats-eyebrow">On your list</span>
                <strong class="stats-fact-value">${formatNumber(st.total)}</strong>
                <span class="stats-fact-note">${formatNumber(st.started)} started · ${formatNumber(st.byStatus.plan_to_watch)} planned</span>
            </div>`;

        // Status: one stacked bar with the share written inside each part (where it fits).
        const statusBar = STATUSES.filter(([value]) => st.byStatus[value]).map(([value, label]) => {
            const n = st.byStatus[value];
            const share = pct(n, st.total);
            return `<a class="stats-stack-part mal-status-${value}${LIGHT_STATUS.has(value) ? ' on-light' : ''}" href="${listHash(value, defaultListView())}" style="flex-grow:${n}" aria-label="${escapeHtml(`${label}: ${n} (${share}%)`)}">${share >= 7 ? `<span>${share}%</span>` : ''}</a>`;
        }).join('');
        const statusKey = STATUSES.map(([value, label]) => `<a class="stats-key-item mal-status-${value}" href="${listHash(value, defaultListView())}"><i aria-hidden="true"></i><span>${escapeHtml(label)}</span><b>${formatNumber(st.byStatus[value])}</b><small>${pct(st.byStatus[value], st.total)}%</small></a>`).join('');

        // Score spread, with your average marked.
        const maxScore = Math.max(...st.scores.slice(1), 1);
        // Highlight the most common score, but only when one score clearly leads.
        const topCount = Math.max(...st.scores.slice(1));
        const peak = st.scores.slice(1).filter(n => n === topCount).length === 1 ? st.scores.indexOf(topCount) : -1;
        const scoreBars = st.scores.slice(1).map((n, i) => {
            const score = i + 1;
            return `<div class="stats-col${score === peak && n ? ' peak' : ''}" tabindex="0" data-tip="${escapeHtml(`${SCORE_LABELS[score]} · ${pct(n, st.scored)}% of your scores`)}" aria-label="${escapeHtml(`Score ${score}: ${n} anime`)}"><span class="stats-col-value">${n || ''}</span><span class="stats-col-bar" data-tip-anchor style="height:${n ? Math.max(3, (n / maxScore) * 100) : 0}%"></span></div>`;
        }).join('');
        const scoreAxis = Array.from({ length: 10 }, (_, i) => `<span>${i + 1}</span>`).join('');

        // Formats
        const maxType = st.types[0]?.[1] || 1;
        const typeRows = st.types.map(([type, n]) => `<div class="stats-row"><span class="stats-row-label">${escapeHtml(type)}</span><span class="stats-row-track"><span class="stats-row-bar" style="width:${(n / maxType) * 100}%"></span></span><span class="stats-row-value">${formatNumber(n)}<small>${pct(n, st.started)}%</small></span></div>`).join('');

        // Genres: the top six as picture tiles (your best-rated show in each), then the next few.
        // Each tile gets a different show: the best-rated one not already used by a tile above.
        const topGenres = st.genres.slice(0, 6);
        const usedPictures = new Set();
        const genreTiles = topGenres.map((g, i) => {
            const ranked = [...(g.pictured || [])].sort(better).filter(entry => safePicture(entry.picture));
            const pick = ranked.find(entry => !usedPictures.has(entry.id) && !usedPictures.has(entry.picture)) || g.best;
            if (pick) { usedPictures.add(pick.id); usedPictures.add(pick.picture); }
            const picture = safePicture(pick?.picture);
            const avg = g.scored ? (g.scoreSum / g.scored).toFixed(1) : '';
            return `<a class="stats-genre" href="${listHash('all', { ...defaultListView(), genre: g.name })}">${picture ? `<img src="${escapeHtml(picture)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<span class="stats-genre-rank">#${i + 1}</span><span class="stats-genre-text"><strong>${escapeHtml(g.name)}</strong><span>${formatNumber(g.count)} anime${avg ? ` · avg ${avg}` : ''}</span></span></a>`;
        }).join('');
        const moreGenres = st.genres.slice(6, 14).map(g => `<a class="stats-genre-chip" href="${listHash('all', { ...defaultListView(), genre: g.name })}">${escapeHtml(g.name)}<b>${formatNumber(g.count)}</b></a>`).join('');

        // Favourites and hot takes
        const favourites = st.favourites.map(entry => `<a class="stats-fav" href="${malLink(entry)}" title="${escapeHtml(displayTitleOf(entry))}"><span class="stats-fav-poster">${safePicture(entry.picture) ? `<img src="${escapeHtml(entry.picture)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<b>${entry.score}<small>/10</small></b></span><span class="stats-fav-title">${escapeHtml(displayTitleOf(entry))}</span></a>`).join('');
        const take = ({ entry, diff }) => `<a class="stats-take" href="${malLink(entry)}">${safePicture(entry.picture) ? `<img src="${escapeHtml(entry.picture)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="stats-take-ph"></span>'}<span class="stats-take-text"><strong>${escapeHtml(displayTitleOf(entry))}</strong><span>You ${entry.score} · MAL ${Number(entry.mean).toFixed(2)}</span></span><b class="stats-take-diff">${diff > 0 ? '+' : ''}${diff.toFixed(1)}</b></a>`;
        const takes = (st.loved.length || st.notForYou.length) ? `
            <section class="stats-card stats-takes">
                <h3>Hot takes <span class="stats-sub">where you and MyAnimeList disagree most</span></h3>
                <div class="stats-takes-cols">
                    ${st.loved.length ? `<div><h4>You loved it more</h4>${st.loved.map(take).join('')}</div>` : ''}
                    ${st.notForYou.length ? `<div><h4>Not for you</h4>${st.notForYou.map(take).join('')}</div>` : ''}
                </div>
            </section>` : '';

        // Release years: the last 30 years you have anime from (older ones grouped).
        const yearList = [...st.years.keys()].sort((a, b) => a - b);
        let yearChart = '';
        if (yearList.length >= 2) {
            const last = yearList[yearList.length - 1];
            const first = Math.max(yearList[0], last - 29);
            const older = yearList.filter(y => y < first).reduce((sum, y) => sum + st.years.get(y), 0);
            const cols = [];
            if (older) cols.push({ label: `Before ${first}`, short: `<${first}`, n: older });
            for (let y = first; y <= last; y++) cols.push({ label: String(y), short: String(y), n: st.years.get(y) || 0 });
            const maxYear = Math.max(...cols.map(c => c.n), 1);
            const peakYear = cols.reduce((best, c) => c.n > best.n ? c : best, cols[0]);
            const peakUnique = cols.filter(c => c.n === peakYear.n).length === 1;
            const every = cols.length > 20 ? 5 : cols.length > 10 ? 2 : 1;
            yearChart = `
                <section class="stats-card">
                    <h3>When your anime first aired ${peakUnique ? `<span class="stats-sub">most from ${escapeHtml(peakYear.label)}</span>` : ''}</h3>
                    <div class="stats-years" style="--cols:${cols.length}">
                        ${cols.map((c, i) => `<div class="stats-year${c === peakYear && peakUnique ? ' peak' : ''}" tabindex="0" data-tip="${escapeHtml(`${c.label} · ${c.n} anime`)}" aria-label="${escapeHtml(`${c.label}: ${c.n} anime`)}"><span class="stats-year-bar" data-tip-anchor style="height:${c.n ? Math.max(3, (c.n / maxYear) * 100) : 0}%"></span><span class="stats-year-label">${i % every === 0 || i === cols.length - 1 ? escapeHtml(c.short) : ''}</span></div>`).join('')}
                    </div>
                </section>`;
        }

        panel.innerHTML = `
            <section class="stats-hero">
                <div class="stats-hero-text">
                    <span class="stats-eyebrow">Time spent watching anime</span>
                    <strong class="stats-hero-value">${timeValue}</strong>
                    <span class="stats-hero-sub">${formatNumber(st.minutes / 60)} hours · ${formatNumber(st.episodes)} episodes · ${formatNumber(st.started)} anime started</span>
                </div>
                ${heroPosters.length ? `<div class="stats-hero-posters" aria-hidden="true">${heroPosters.map((entry, i) => `<img src="${escapeHtml(entry.picture)}" alt="" style="--i:${i}" referrerpolicy="no-referrer">`).join('')}</div>` : ''}
            </section>
            <div class="stats-facts">${facts}</div>
            <section class="stats-card">
                <h3>Your list by status</h3>
                <div class="stats-stack" role="img" aria-label="${escapeHtml(STATUSES.map(([value, label]) => `${label} ${st.byStatus[value]}`).join(', '))}">${statusBar}</div>
                <div class="stats-key">${statusKey}</div>
            </section>
            <div class="stats-split">
                <section class="stats-card">
                    <h3>How you score ${st.scored ? `<span class="stats-sub">${formatNumber(st.scored)} scored</span>` : ''}</h3>
                    ${st.scored ? `<div class="stats-scores"><div class="stats-cols" role="group" aria-label="Number of anime at each score">${scoreBars}</div><span class="stats-mean${st.meanScore > 7 ? ' flip' : ''}" style="--m:${st.meanScore.toFixed(3)}"><span>your avg ${st.meanScore.toFixed(1)}</span></span></div><div class="stats-axis">${scoreAxis}</div>` : '<p class="stats-empty">Score some anime on MyAnimeList to see this.</p>'}
                </section>
                <section class="stats-card">
                    <h3>What you watch</h3>
                    ${st.types.length ? `<div class="stats-rows">${typeRows}</div>` : '<p class="stats-empty">Start watching something to see this.</p>'}
                </section>
            </div>
            ${topGenres.length ? `<section class="stats-card">
                <h3>Your top genres <span class="stats-sub">pictured: a top-rated show of yours from each</span></h3>
                <div class="stats-genres">${genreTiles}</div>
                ${moreGenres ? `<div class="stats-genre-more"><span>Also into</span>${moreGenres}</div>` : ''}
            </section>` : ''}
            ${favourites ? `<section class="stats-card"><h3>Your favourites</h3><div class="stats-favs">${favourites}</div></section>` : ''}
            ${takes}
            ${yearChart}
            <p class="stats-footnote">Time watched uses each show's episode length from MyAnimeList. Genres, formats and years count the anime you've started (not Plan to Watch).</p>`;
        wireStatsTips(panel);
    }

    // One small popup, placed right on the bar you point at (or focus with the keyboard).
    function wireStatsTips(panel) {
        if (panel.dataset.tips === 'on') return;
        panel.dataset.tips = 'on';
        let tip = $('stats-tip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'stats-tip';
            tip.className = 'stats-tip';
            tip.setAttribute('role', 'tooltip');
            document.body.appendChild(tip);
        }
        const hide = () => tip.classList.remove('show');
        const show = (target) => {
            const anchor = target.querySelector('[data-tip-anchor]') || target;
            const box = anchor.getBoundingClientRect();
            if (!box.width && !box.height) { hide(); return; }
            tip.textContent = target.dataset.tip;
            tip.classList.add('show');
            const width = tip.offsetWidth, height = tip.offsetHeight;
            let left = box.left + box.width / 2 - width / 2;
            left = Math.max(8, Math.min(left, innerWidth - width - 8));
            let top = box.top - height - 8;
            if (top < 8) top = box.bottom + 8;
            tip.style.left = `${Math.round(left)}px`;
            tip.style.top = `${Math.round(top)}px`;
        };
        panel.addEventListener('pointerover', event => { const target = event.target.closest('[data-tip]'); if (target && panel.contains(target)) show(target); });
        panel.addEventListener('pointerout', event => { const target = event.target.closest('[data-tip]'); if (target && !target.contains(event.relatedTarget)) hide(); });
        panel.addEventListener('focusin', event => { const target = event.target.closest('[data-tip]'); if (target) show(target); });
        panel.addEventListener('focusout', hide);
        window.addEventListener('scroll', hide, { passive: true });
        window.addEventListener('hashchange', hide);
    }

    /* Tiles or rows. A per-device preference, like MyAnimeList's own list style. */
    const LAYOUT_KEY = 'anizone:mylist:layout';
    let layout = (() => { try { return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } })();
    function applyLayout() {
        $('mal-list-grid')?.classList.toggle('mal-rows', layout === 'list');
        document.querySelectorAll('#mylist-layout [data-layout]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.layout === layout)));
    }
    function setLayout(next) {
        if (next === layout) return;
        layout = next === 'list' ? 'list' : 'grid';
        try { localStorage.setItem(LAYOUT_KEY, layout); } catch {}
        applyLayout();
        drawMyList();
    }

    function plusButton(entry, title) {
        if (entry.status !== 'watching' || (entry.episodes && entry.watched >= entry.episodes)) return null;
        const plus = document.createElement('button');
        plus.type = 'button';
        plus.className = 'mal-card-plus';
        plus.textContent = '+1';
        plus.title = `Mark episode ${entry.watched + 1} watched`;
        plus.setAttribute('aria-label', `Mark episode ${entry.watched + 1} of ${title} watched`);
        plus.addEventListener('click', () => applyChange(entry.id, { id: entry.id, title: entry.title, titleEn: entry.titleEn, picture: entry.picture, episodes: entry.episodes }, { watched: entry.watched + 1 }));
        return plus;
    }

    const SEASON_LABEL = { winter: 'Winter', spring: 'Spring', summer: 'Summer', fall: 'Fall' };
    function listRow(entry) {
        const row = document.createElement('div');
        row.className = `mal-row mal-status-${entry.status}`;
        const title = displayTitleOf(entry);
        const otherTitle = [entry.title, entry.titleEn].find(name => name && name !== title) || '';
        const sub = [
            TYPES[typeGroup(entry.mediaType)] || '',
            entry.season?.year ? `${SEASON_LABEL[entry.season.season] || ''} ${entry.season.year}`.trim() : '',
            AIRING[entry.airing] || '',
            otherTitle,
        ].filter(Boolean).join(' · ');
        const eps = entry.status === 'plan_to_watch' && !entry.watched ? `${entry.episodes || '?'} ep` : `Ep ${progressText(entry)}`;
        const stat = (label, value) => `<span class="mal-row-stat"><small>${label}</small><b${value ? '' : ' class="empty"'}>${value || '–'}</b></span>`;
        row.innerHTML = `<a class="mal-row-link" href="#/mal/${entry.id}" title="${escapeHtml(title)}">
            <img class="mal-row-thumb" src="${escapeHtml(entry.picture || '')}" alt="" loading="lazy">
            <div class="mal-row-main">
                <strong class="mal-row-title">${escapeHtml(title)}</strong>
                ${sub ? `<span class="mal-row-sub">${escapeHtml(sub)}</span>` : ''}
                <div class="mal-row-progress"><div class="mal-row-bar" aria-hidden="true"><span style="width:${progressPercent(entry)}%"></span></div><span class="mal-row-eps">${escapeHtml(eps)}</span></div>
            </div>
            <div class="mal-row-stats">
                <span class="mal-row-status">${escapeHtml(STATUS_LABEL[entry.status] || '')}</span>
                ${stat('Mine', entry.score ? String(entry.score) : '')}
                ${stat('MAL', entry.mean ? Number(entry.mean).toFixed(2) : '')}
            </div>
        </a>`;
        const action = document.createElement('div');
        action.className = 'mal-row-action';
        const plus = plusButton(entry, title);
        if (plus) action.appendChild(plus);
        row.appendChild(action);
        return row;
    }

    function listCard(entry) {
        const card = document.createElement('div');
        card.className = 'anime-card mal-card';
        const title = displayTitleOf(entry);
        const statusLabel = currentTab === 'all' ? STATUS_LABEL[entry.status] : '';
        const meta = [statusLabel, entry.status === 'plan_to_watch' ? `${entry.episodes || '?'} ep` : `Ep ${progressText(entry)}`, entry.score ? `Scored ${entry.score}` : ''].filter(Boolean).join(' · ');
        card.innerHTML = `<a class="anime-card-link" href="#/mal/${entry.id}" title="${escapeHtml(title)}"><img src="${escapeHtml(entry.picture)}" alt="" loading="lazy">${currentTab === 'all' ? `<span class="mal-card-status mal-status-${entry.status}" aria-hidden="true"></span>` : ''}<div class="anime-card-overlay"></div><div class="anime-card-title"><strong class="anime-card-name">${escapeHtml(title)}</strong><span>${escapeHtml(meta)}</span></div><div class="mal-card-progress" aria-hidden="true"><span style="width:${progressPercent(entry)}%"></span></div></a>`;
        const plus = plusButton(entry, title);
        if (plus) card.appendChild(plus);
        return card;
    }

    function setListView(changes) {
        listView = { ...listView, ...changes };
        syncListUrl();
        syncToolbar();
        drawMyList();
    }
    function clearListFilters() {
        setListView({ q: '', type: '', airing: '', year: '', season: '', genre: '', score: '' });
        const search = $('mylist-search');
        if (search) search.value = '';
    }
    function initListToolbar() {
        const search = $('mylist-search');
        search?.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => setListView({ q: search.value.trim() }), 200);
        });
        search?.addEventListener('keydown', event => { if (event.key === 'Escape' && search.value) { event.stopPropagation(); search.value = ''; setListView({ q: '' }); } });
        $('mylist-sort')?.addEventListener('change', event => setListView({ sort: event.target.value, order: '' }));
        $('mylist-order')?.addEventListener('click', () => setListView({ order: sortOrder() === 'asc' ? 'desc' : 'asc' }));
        [['mylist-type', 'type'], ['mylist-airing', 'airing'], ['mylist-year', 'year'], ['mylist-season', 'season'], ['mylist-genre', 'genre'], ['mylist-score', 'score']]
            .forEach(([id, key]) => $(id)?.addEventListener('change', event => setListView({ [key]: event.target.value })));
        $('mylist-filter-reset')?.addEventListener('click', clearListFilters);
        const toggle = $('mylist-filter-toggle');
        toggle?.addEventListener('click', () => {
            const open = toggle.getAttribute('aria-expanded') !== 'true';
            toggle.setAttribute('aria-expanded', String(open));
            $('mylist-filter-panel')?.classList.toggle('hidden', !open);
        });
        document.querySelectorAll('#mylist-layout [data-layout]').forEach(button => button.addEventListener('click', () => setLayout(button.dataset.layout)));
        applyLayout();
    }

    function renderActions(loggedIn) {
        const actions = $('mylist-actions');
        const subtitle = $('mylist-subtitle');
        if (!actions) return;
        const me = profile();
        if (loggedIn) {
            if (subtitle) subtitle.textContent = `Synced with MyAnimeList${me?.name ? ` · ${me.name}` : ''}`;
            actions.innerHTML = '<button class="btn-secondary" type="button" data-mal-action="sync">Sync now</button>';
            actions.querySelector('[data-mal-action="sync"]').addEventListener('click', async event => {
                event.target.disabled = true;
                try { await refreshList({ force: true }); toast('Your MyAnimeList is up to date.', 'success'); }
                catch (error) { showNotice(error.message, 'error'); }
                finally { event.target.disabled = false; }
            });
        } else {
            if (subtitle) subtitle.textContent = '';
            actions.innerHTML = `<button class="btn-primary" type="button" data-mal-action="login">${isConfigured() ? 'Log in with MyAnimeList' : 'Set up MyAnimeList'}</button>`;
            actions.querySelector('[data-mal-action="login"]').addEventListener('click', () => isConfigured() ? startLogin() : openSettings());
        }
    }

    // Cards link to #/mal/<MAL id>; AniZone pages use AniList ids, so look it up.
    async function openByMalId(malId) {
        showLoading(true);
        try {
            const data = await getAnimeByMalId(malId);
            if (!data?.Media?.id) throw new Error('not found');
            navigate(animeHash(data.Media.id), { replace: true });
        } catch {
            navigate('#/list', { replace: true });
            siteAlert('AniList has no page for this MyAnimeList entry yet.', { title: 'Not found' });
        } finally { showLoading(false); }
    }

    /* ---------- Profile Settings section ---------- */
    function openSettings() {
        const panel = $('theme-menu-panel');
        if (panel?.classList.contains('hidden')) $('theme-menu-btn')?.click();
        const fold = $('mal-settings')?.closest('details');
        if (fold) fold.open = true;
        setTimeout(() => $('mal-settings')?.scrollIntoView({ block: 'nearest' }), 50);
    }
    function renderSettings() {
        const host = $('mal-settings');
        if (!host) return;
        const relay = relayUrl();
        const me = profile();
        let body;
        if (relay && isLoggedIn()) {
            body = `<div class="mal-account">${me?.picture ? `<img src="${escapeHtml(me.picture)}" alt="">` : '<span class="mal-badge">MAL</span>'}<div><strong>${escapeHtml(me?.name || 'Connected')}</strong><small>Progress syncs with MyAnimeList</small></div></div>
                <div class="mal-settings-actions"><button class="settings-add-btn" type="button" data-mal-action="sync">Sync now</button><button class="settings-add-btn" type="button" data-mal-action="logout">Log out</button></div>`;
        } else if (relay) {
            body = `<button class="settings-add-btn mal-login-btn" type="button" data-mal-action="login">Log in with MyAnimeList</button><div class="settings-hint">You'll sign in on MyAnimeList's own page; AniZone never sees your password.</div>`;
        } else {
            body = `<div class="settings-hint">Sync your progress with your MyAnimeList account. Needs a one-time setup: <a href="${SETUP_GUIDE_URL}" target="_blank" rel="noopener">setup guide ↗</a></div>`;
        }
        host.innerHTML = `${body}
            <details class="mal-relay"${relay ? '' : ' open'}><summary>Relay address</summary>
                <form class="mal-relay-form"><input type="url" name="relay" placeholder="https://anizone-mal.you.workers.dev" value="${escapeHtml(localStorage.getItem(RELAY_KEY) || RELAY_DEFAULT)}" aria-label="MyAnimeList relay address"><button class="settings-add-btn" type="submit">Save</button></form>
            </details>`;
        host.querySelector('[data-mal-action="login"]')?.addEventListener('click', startLogin);
        host.querySelector('[data-mal-action="logout"]')?.addEventListener('click', () => logout());
        host.querySelector('[data-mal-action="sync"]')?.addEventListener('click', () => refreshList({ force: true }).then(() => toast('Your MyAnimeList is up to date.', 'success')).catch(error => toast(error.message, 'error')));
        host.querySelector('.mal-relay-form').addEventListener('submit', event => {
            event.preventDefault();
            const raw = event.target.relay.value;
            const value = normalizeRelay(raw);
            if (raw.trim() && !value) { toast('The relay address must start with https://', 'warn'); return; }
            if (value && value !== relayUrl()) logout({ quiet: true });
            if (value) localStorage.setItem(RELAY_KEY, value); else remove(RELAY_KEY);
            renderSettings();
            refreshViews();
            toast(value ? 'Relay address saved.' : 'Relay address cleared.');
        });
    }

    /* ---------- wiring ---------- */
    function refreshViews() {
        if (!$('view-history')?.classList.contains('hidden')) drawMyList();
        if (!$('view-profile')?.classList.contains('hidden')) drawProfile();
        if (panelAnime && !$('view-details')?.classList.contains('hidden')) {
            if (isLoggedIn() && isConfigured()) drawPanel(); else renderProgressPanel(panelAnime);
        }
    }
    listeners.add(refreshViews);
    // Save anything still waiting before leaving the page or closing the tab.
    window.addEventListener('hashchange', () => flushAll());
    window.addEventListener('pagehide', () => flushAll({ keepalive: true }));
    window.addEventListener('storage', event => { if ([AUTH_KEY, LIST_KEY, RELAY_KEY].includes(event.key)) { listCache = null; renderSettings(); emit(); } });
    document.addEventListener('DOMContentLoaded', renderSettings);
    document.addEventListener('DOMContentLoaded', initListToolbar);

    // MAL ids on your list (any status), so Surprise Me can suggest something new.
    const listedMalIds = () => new Set(isLoggedIn() ? Object.keys(loadList().entries).map(Number) : []);

    /* ---------- for other pages (recommendations, seasonal chart) ---------- */
    const listEntries = () => (isLoggedIn() && isConfigured() ? Object.values(loadList().entries).map(entry => ({ ...entry })) : []);
    const entryFor = malId => (isLoggedIn() && isConfigured() ? getEntry(Number(malId)) : null);
    function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    // Adds an anime (by its MAL id) to Plan to Watch. Returns false when not logged in.
    function addToPlanToWatch(info) {
        const malId = Number(info?.id);
        if (!malId) return false;
        if (!isConfigured() || !isLoggedIn()) {
            toast(isConfigured() ? 'Log in with MyAnimeList (Profile Settings) to add anime to your list.' : 'Connect MyAnimeList in Profile Settings to keep a list.', 'warn');
            return false;
        }
        if (getEntry(malId)) return true;
        applyChange(malId, info, { status: 'plan_to_watch' });
        toast(`Added “${displayTitleOf({ title: info.title, titleEn: info.titleEn })}” to Plan to Watch.`, 'success');
        return true;
    }

    return { renderMyList, renderProfile, renderProgressPanel, handleCallback, openByMalId, refreshViews, startLogin, logout, refreshList, isLoggedIn, isConfigured, listedMalIds, relayUrl, listEntries, entryFor, subscribe, addToPlanToWatch, statusLabel: status => STATUS_LABEL[status] || '' };
})();
window.MalSync = MalSync;

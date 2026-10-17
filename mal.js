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
    const LIST_KEY = 'anizone:mal:list:v1';
    const LOGIN_KEY = 'anizone:mal:login:v1';           // sessionStorage, survives the trip to MAL and back
    const LIST_FRESH_MS = 2 * 60 * 1000;
    const SAVE_DELAY_MS = 700;                           // group quick +/- clicks into one save
    const LIST_FIELDS = 'list_status,num_episodes,nsfw,media_type,status,alternative_titles';

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
    const base64url = text => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    function decodeState(state) {
        try {
            const padded = String(state).replace(/-/g, '+').replace(/_/g, '/');
            return JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
        } catch { return null; }
    }

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
            const nonce = randomString(24);
            const back = location.hash && !location.hash.startsWith('#/mal-callback') ? location.hash : '#/';
            write(LOGIN_KEY, { verifier, nonce, back, relay: relayUrl(), startedAt: Date.now() }, sessionStorage);
            const state = base64url(JSON.stringify({ n: nonce, r: location.origin + location.pathname }));
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
        if (!pending || decodeState(route.state)?.n !== pending.nonce || !route.code) {
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
        refreshViews();
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
        return { id: info.id, title: info.title, titleEn: info.titleEn, picture: info.picture, episodes: info.episodes || 0, nsfw: info.isAdult ? 'black' : 'white', mediaType: info.mediaType || '', status: '', score: 0, watched: 0, rewatching: false, updatedAt: new Date().toISOString() };
    }

    // Applies a change the way MAL's own site does:
    // - adding episodes to something not yet started marks it Watching
    // - reaching the last episode marks it Completed
    // - marking it Completed fills in all episodes
    function applyChange(malId, info, change) {
        const prior = getEntry(malId);
        const before = prior || newEntry(info);
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

    function infoFromAnime(anime) {
        return {
            id: anime.idMal,
            title: anime.title?.romaji || anime.title?.english || '',
            titleEn: anime.title?.english || '',
            picture: anime.coverImage?.large || anime.coverImage?.extraLarge || '',
            episodes: anime.episodes || 0,
            isAdult: anime.isAdult,
            mediaType: (anime.format || '').toLowerCase(),
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
            box.innerHTML = `<div class="mal-progress-card mal-progress-login"><span class="mal-badge">MAL</span><span>Track your progress on MyAnimeList</span><button class="btn-secondary" type="button" data-mal-action="login">${isConfigured() ? 'Log in with MyAnimeList' : 'Set up MyAnimeList'}</button></div>`;
            box.querySelector('[data-mal-action="login"]').addEventListener('click', () => isConfigured() ? startLogin() : openSettings());
            return;
        }
        drawPanel();
        // Pick up changes made on MyAnimeList itself (or another device).
        const malId = anime.idMal;
        malApi(`anime/${malId}?fields=my_list_status,num_episodes`).then(data => {
            if (panelAnime?.idMal !== malId || saves.has(malId)) return;
            const current = getEntry(malId);
            if (data?.my_list_status) {
                const merged = { ...(current || newEntry(infoFromAnime(anime))), episodes: Number(data.num_episodes) || current?.episodes || anime.episodes || 0, ...statusFields(data.my_list_status) };
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
        const focused = document.activeElement?.dataset?.mal;
        box.innerHTML = `<div class="mal-progress-card">
            <div class="mal-progress-head"><span class="mal-badge">MAL</span><strong>My progress</strong><span class="mal-save-state" data-mal-state aria-live="polite"></span></div>
            <div class="mal-progress-row">
                <label class="mal-field"><span>Status</span><select data-mal="status">
                    <option value="">Not on my list</option>
                    ${STATUSES.map(([value, label]) => `<option value="${value}"${value === status ? ' selected' : ''}>${label}</option>`).join('')}
                </select></label>
                <div class="mal-field"><span id="mal-episodes-label">Episodes</span>
                    <div class="mal-episodes" role="group" aria-labelledby="mal-episodes-label">
                        <button type="button" data-mal="minus" aria-label="One episode fewer"${watched <= 0 ? ' disabled' : ''}>−</button>
                        <input data-mal="episodes" type="number" inputmode="numeric" min="0"${total ? ` max="${total}"` : ''} value="${watched}" aria-label="Episodes watched">
                        <span class="mal-total">/ ${total || '?'}</span>
                        <button type="button" data-mal="plus" aria-label="One more episode"${total && watched >= total ? ' disabled' : ''}>+</button>
                    </div>
                </div>
                <label class="mal-field"><span>Score</span><select data-mal="score">
                    ${SCORE_LABELS.map((label, value) => `<option value="${value}"${value === (entry?.score || 0) ? ' selected' : ''}>${value ? `${value} · ${label}` : label}</option>`).reverse().join('')}
                </select></label>
            </div>
            <div class="mal-progress-bar" aria-hidden="true"><span style="width:${entry ? progressPercent({ ...entry, episodes: total }) : 0}%"></span></div>
            <div class="mal-progress-foot">${entry ? `<button type="button" class="mal-link-btn" data-mal="remove">Remove from my list</button>` : '<span>Not on your MyAnimeList yet</span>'}<a href="https://myanimelist.net/anime/${malId}" target="_blank" rel="noopener">Open on MyAnimeList ↗</a></div>
        </div>`;
        const q = name => box.querySelector(`[data-mal="${name}"]`);
        q('status').addEventListener('change', async event => {
            const value = event.target.value;
            if (!value) {
                if (await siteConfirm(`Remove “${displayTitleOf(entry || newEntry(info))}” from your MyAnimeList?`, { title: 'Remove from list', confirmText: 'Remove' })) removeFromList(malId);
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
        if (focused) q(focused)?.focus();
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
        else if (info.state === 'saved') host.textContent = '✓ Saved to MyAnimeList';
        else if (info.state === 'removed') host.textContent = '✓ Removed from MyAnimeList';
        else if (info.state === 'error') {
            host.innerHTML = '⚠ Not saved <button type="button" class="mal-link-btn">Retry</button>';
            host.querySelector('button').addEventListener('click', () => info.retry?.());
        }
    }

    /* ---------- My List page ---------- */
    let currentTab = '';
    function renderMyList(tab = '') {
        const loggedIn = isConfigured() && isLoggedIn();
        const validTabs = ['history', ...STATUSES.map(([value]) => value)];
        currentTab = validTabs.includes(tab) ? tab : (loggedIn ? 'watching' : 'history');
        if (loggedIn) refreshList().catch(error => showNotice(error.message, 'error')); // starts first so the list shows a spinner, not "empty"
        drawMyList();
    }

    function drawMyList() {
        const tabs = $('mylist-tabs');
        const grid = $('mal-list-grid');
        const historyPanel = $('history-panel');
        if (!tabs || !grid || !historyPanel) return;
        const loggedIn = isConfigured() && isLoggedIn();
        const entries = Object.values(loadList().entries).filter(entry => !hiddenAsAdult(entry));
        const historyCount = (typeof clickHistory !== 'undefined' ? clickHistory : []).filter(item => adultContentEnabled || !item.isAdult).length;
        const tabLink = (value, label, count) => `<a class="mylist-tab${currentTab === value ? ' active' : ''}" href="#/list?tab=${value}"${currentTab === value ? ' aria-current="page"' : ''}>${label}${count != null ? ` <span>${count}</span>` : ''}</a>`;
        tabs.innerHTML = (loggedIn ? STATUSES.map(([value, label]) => tabLink(value, label, entries.filter(entry => entry.status === value).length)).join('') : '') + tabLink('history', 'History', historyCount);
        renderActions(loggedIn);

        if (currentTab === 'history') {
            grid.classList.add('hidden');
            historyPanel.classList.remove('hidden');
            if (!loggedIn) showNotice(isConfigured() ? 'Log in with MyAnimeList to see and update your list here.' : 'Connect MyAnimeList (Profile Settings) to track your progress here.');
            else showNotice('');
            renderHistoryLogGrid();
            return;
        }
        historyPanel.classList.add('hidden');
        grid.classList.remove('hidden');
        const items = entries.filter(entry => entry.status === currentTab).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        if (!loadList().fetchedAt && listRequest) { grid.innerHTML = '<div class="spinner"></div>'; showNotice(''); return; }
        showNotice('');
        if (!items.length) { grid.innerHTML = `<div class="empty-state">Nothing in ${STATUS_LABEL[currentTab]} yet.</div>`; return; }
        grid.innerHTML = '';
        items.forEach(entry => grid.appendChild(listCard(entry)));
    }

    function listCard(entry) {
        const card = document.createElement('div');
        card.className = 'anime-card mal-card';
        const title = displayTitleOf(entry);
        const meta = [entry.status === 'plan_to_watch' ? `${entry.episodes || '?'} episodes` : `Ep ${progressText(entry)}`, entry.score ? `★ ${entry.score}` : ''].filter(Boolean).join(' · ');
        card.innerHTML = `<a class="anime-card-link" href="#/mal/${entry.id}" title="${escapeHtml(title)}"><img src="${escapeHtml(entry.picture)}" alt="" loading="lazy"><div class="anime-card-overlay"></div><div class="anime-card-title"><strong class="anime-card-name">${escapeHtml(title)}</strong><span>${escapeHtml(meta)}</span></div><div class="mal-card-progress" aria-hidden="true"><span style="width:${progressPercent(entry)}%"></span></div></a>`;
        if (entry.status === 'watching' && (!entry.episodes || entry.watched < entry.episodes)) {
            const plus = document.createElement('button');
            plus.type = 'button';
            plus.className = 'mal-card-plus';
            plus.textContent = '+1';
            plus.title = `Mark episode ${entry.watched + 1} watched`;
            plus.setAttribute('aria-label', `Mark episode ${entry.watched + 1} of ${title} watched`);
            plus.addEventListener('click', () => applyChange(entry.id, { id: entry.id, title: entry.title, titleEn: entry.titleEn, picture: entry.picture, episodes: entry.episodes }, { watched: entry.watched + 1 }));
            card.appendChild(plus);
        }
        return card;
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
        if (panelAnime && !$('view-details')?.classList.contains('hidden')) {
            if (isLoggedIn() && isConfigured()) drawPanel(); else renderProgressPanel(panelAnime);
        }
    }
    listeners.add(refreshViews);
    // Save anything still waiting before leaving the page or closing the tab.
    window.addEventListener('hashchange', () => flushAll());
    window.addEventListener('pagehide', () => flushAll({ keepalive: true }));
    window.addEventListener('storage', event => { if ([AUTH_KEY, LIST_KEY, RELAY_KEY].includes(event.key)) { listCache = null; renderSettings(); refreshViews(); } });
    document.addEventListener('DOMContentLoaded', renderSettings);

    return { renderMyList, renderProgressPanel, handleCallback, openByMalId, refreshViews, startLogin, logout, refreshList, isLoggedIn, isConfigured };
})();
window.MalSync = MalSync;

/**
 * A shared, searchable/browsable emoji picker popover, used both for
 * message reactions (ChatUI.js) and inserting an emoji into the chat
 * composer (App.js). Same singleton pattern as Tooltip.js: one popover
 * element lazily built and appended to `document.body`, reused across
 * opens rather than rebuilt, with its own delegated outside-click/Escape
 * listeners wired once. `openEmojiPicker(anchorEl, onPick)` is the only
 * entry point either call site needs.
 *
 * Data (`public/assets/vendor/emoji-data.json`) is fetched lazily on the
 * first-ever open, not at page load — zero cost for a session that never
 * opens the picker, same as VirtualBackground.js/NoiseSuppressor.js. It's
 * a trimmed build of emoji-picker-element-data@1.8.0 (Apache-2.0):
 * `{ e: emoji, n: annotation, t: tags[], g: group, o: order }`, with
 * skin-tone/hair "component" entries (group 2) filtered out — this picker
 * deliberately doesn't support skin-tone variants (scope cut, not an
 * oversight).
 */

const DATA_URL = '/assets/vendor/emoji-data.json';
const RECENT_KEY = 'recentEmoji';
const RECENT_MAX = 24;
const GAP_PX = 6;
const EDGE_PX = 8;

// Groups present in the dataset, in display order, each with a
// representative glyph used as its tab icon (zero extra icon assets,
// consistent with the app's native-emoji-font-only convention).
const CATEGORIES = [
    { g: 0, icon: '😀', label: 'Smileys & Emotion' },
    { g: 1, icon: '🧑', label: 'People & Body' },
    { g: 3, icon: '🐶', label: 'Animals & Nature' },
    { g: 4, icon: '🍔', label: 'Food & Drink' },
    { g: 5, icon: '✈️', label: 'Travel & Places' },
    { g: 6, icon: '⚽', label: 'Activities' },
    { g: 7, icon: '💡', label: 'Objects' },
    { g: 8, icon: '🔣', label: 'Symbols' },
    { g: 9, icon: '🏁', label: 'Flags' },
];

let popover = null;
let searchInput = null;
let tabsRow = null;
let gridWrap = null;
let currentOnPick = null;
let currentAnchor = null;
let isOpen = false;
let initialized = false;

let emojiData = null; // populated lazily, sorted by group then order
let dataPromise = null;

function loadData() {
    if (dataPromise) return dataPromise;
    dataPromise = fetch(DATA_URL)
        .then((res) => res.json())
        .then((data) => {
            emojiData = data;
            return data;
        })
        .catch((err) => {
            dataPromise = null; // allow a retry on the next open
            throw err;
        });
    return dataPromise;
}

function getRecent() {
    try {
        const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
        return Array.isArray(raw) ? raw.filter((e) => typeof e === 'string') : [];
    } catch {
        return [];
    }
}

function recordRecent(emoji) {
    const recent = getRecent().filter((e) => e !== emoji);
    recent.unshift(emoji);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, RECENT_MAX)));
}

function makeEmojiButton(entry) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-picker-item';
    btn.textContent = entry.e;
    btn.dataset.tip = entry.n;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        recordRecent(entry.e);
        const onPick = currentOnPick;
        close();
        onPick?.(entry.e);
    });
    return btn;
}

function renderCategorized() {
    gridWrap.innerHTML = '';
    tabsRow.style.display = '';

    const recent = getRecent()
        .map((e) => emojiData.find((x) => x.e === e))
        .filter(Boolean);
    if (recent.length) {
        const section = document.createElement('div');
        section.className = 'emoji-picker-section';
        section.dataset.group = 'recent';
        const heading = document.createElement('div');
        heading.className = 'emoji-picker-section-label';
        heading.textContent = 'Recently used';
        section.appendChild(heading);
        const grid = document.createElement('div');
        grid.className = 'emoji-picker-grid';
        recent.forEach((entry) => grid.appendChild(makeEmojiButton(entry)));
        section.appendChild(grid);
        gridWrap.appendChild(section);
    }

    CATEGORIES.forEach(({ g, label }) => {
        const entries = emojiData.filter((e) => e.g === g);
        if (!entries.length) return;
        const section = document.createElement('div');
        section.className = 'emoji-picker-section';
        section.dataset.group = String(g);
        const heading = document.createElement('div');
        heading.className = 'emoji-picker-section-label';
        heading.textContent = label;
        section.appendChild(heading);
        const grid = document.createElement('div');
        grid.className = 'emoji-picker-grid';
        entries.forEach((entry) => grid.appendChild(makeEmojiButton(entry)));
        section.appendChild(grid);
        gridWrap.appendChild(section);
    });

    renderTabs(recent.length > 0);
}

function renderSearch(query) {
    tabsRow.style.display = 'none';
    const q = query.trim().toLowerCase();
    const matches = emojiData.filter(
        (e) => e.n.includes(q) || e.t.some((tag) => tag.includes(q))
    );
    gridWrap.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'emoji-picker-grid';
    if (!matches.length) {
        const empty = document.createElement('div');
        empty.className = 'emoji-picker-empty';
        empty.textContent = 'No emoji found';
        gridWrap.appendChild(empty);
        return;
    }
    matches.forEach((entry) => grid.appendChild(makeEmojiButton(entry)));
    gridWrap.appendChild(grid);
}

function renderTabs(hasRecent) {
    tabsRow.innerHTML = '';
    const tabs = hasRecent ? [{ g: 'recent', icon: '🕒', label: 'Recently used' }, ...CATEGORIES] : CATEGORIES;
    tabs.forEach(({ g, icon, label }) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'emoji-picker-tab';
        tab.textContent = icon;
        tab.dataset.tip = label;
        tab.addEventListener('click', (e) => {
            e.stopPropagation();
            const section = gridWrap.querySelector(`.emoji-picker-section[data-group="${g}"]`);
            if (section) gridWrap.scrollTop = section.offsetTop - gridWrap.offsetTop;
        });
        tabsRow.appendChild(tab);
    });
}

function renderLoading() {
    tabsRow.style.display = 'none';
    gridWrap.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'emoji-picker-empty';
    loading.textContent = 'Loading…';
    gridWrap.appendChild(loading);
}

function renderError() {
    tabsRow.style.display = 'none';
    gridWrap.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.className = 'emoji-picker-empty';
    errEl.textContent = 'Couldn’t load emoji';
    gridWrap.appendChild(errEl);
}

function refresh() {
    const query = searchInput.value;
    if (!emojiData) {
        renderLoading();
        return;
    }
    if (query.trim()) renderSearch(query);
    else renderCategorized();
}

function position(anchor) {
    const r = anchor.getBoundingClientRect();
    const p = popover.getBoundingClientRect();

    let top = r.top - p.height - GAP_PX;
    if (top < EDGE_PX) top = r.bottom + GAP_PX;
    top = Math.max(EDGE_PX, Math.min(top, window.innerHeight - p.height - EDGE_PX));

    let left = r.left;
    left = Math.max(EDGE_PX, Math.min(left, window.innerWidth - p.width - EDGE_PX));

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
}

function ensurePopover() {
    if (popover) return;
    popover = document.createElement('div');
    popover.className = 'emoji-picker-popover';
    popover.style.display = 'none';
    popover.addEventListener('click', (e) => e.stopPropagation());

    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'emoji-picker-search';
    searchInput.placeholder = 'Search emoji';
    searchInput.addEventListener('input', refresh);
    popover.appendChild(searchInput);

    tabsRow = document.createElement('div');
    tabsRow.className = 'emoji-picker-tabs';
    popover.appendChild(tabsRow);

    gridWrap = document.createElement('div');
    gridWrap.className = 'emoji-picker-grid-wrap';
    popover.appendChild(gridWrap);

    document.body.appendChild(popover);
}

function close() {
    if (!isOpen) return;
    isOpen = false;
    currentOnPick = null;
    currentAnchor = null;
    if (popover) popover.style.display = 'none';
}

function initGlobalListeners() {
    if (initialized) return;
    initialized = true;
    document.addEventListener('click', (e) => {
        if (isOpen && e.target !== currentAnchor) close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen) close();
    });
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', () => {
        // offsetParent is null once the anchor (or an ancestor, e.g. a
        // closed composer-plus-menu) goes display:none — its rect would
        // read as a zero-sized box at (0,0) and misposition the popover.
        if (isOpen && currentAnchor?.offsetParent) position(currentAnchor);
    });
}

/**
 * Opens the shared emoji picker anchored to `anchorEl`. `onPick(emoji)`
 * fires once, after the popover has already closed, when the user picks
 * an emoji — never fires if they dismiss the popover instead.
 * @param {HTMLElement} anchorEl
 * @param {(emoji: string) => void} onPick
 * @returns {void}
 */
export function openEmojiPicker(anchorEl, onPick) {
    ensurePopover();
    initGlobalListeners();

    isOpen = true;
    currentAnchor = anchorEl;
    currentOnPick = onPick;
    searchInput.value = '';
    popover.style.display = '';
    refresh();
    position(anchorEl);
    searchInput.focus();

    if (!emojiData) {
        loadData()
            .then(() => {
                if (isOpen) refresh();
            })
            .catch(() => {
                if (isOpen) renderError();
            });
    }
}

export function closeEmojiPicker() {
    close();
}

/**
 * A shared, searchable language picker popover for inserting a chat code
 * fence — the composer's "Code block" +-menu option (App.js), added
 * 2026-09-09 as an accessibility fix (owner-reported: a friend with a
 * motor disability finds typing ```language by hand repeatedly hard).
 * Same singleton-popover pattern as EmojiPicker.js/Tooltip.js.
 * `openCodeBlockPicker(anchorEl, onPick)` is the only entry point.
 *
 * The language list is read live off the already-loaded `hljs` global
 * (`hljs.listLanguages()`/`hljs.getLanguage()`) rather than a hand-maintained
 * table — it can never drift out of sync with whichever grammars are
 * actually vendored (see CLAUDE.md's "Need another hljs language?" note),
 * and the id it hands back is exactly the id hljs itself highlights the
 * fence with (no separate alias-normalization step needed).
 *
 * Accessibility-first design: opening the picker keeps the query empty
 * (so the full list is one Backspace away) but starts the keyboard-nav
 * `activeIndex` on the *last language actually picked*
 * (`localStorage['lastCodeBlockLang']`) instead of the top of the list —
 * since most people send the same language most of the time, the whole
 * flow collapses to "+", click, Enter for the common case, with typing a
 * few letters to search only needed to change languages.
 */

const LAST_LANG_KEY = 'lastCodeBlockLang';
const GAP_PX = 6;
const EDGE_PX = 8;

let popover = null;
let searchInput = null;
let listEl = null;
let itemEls = [];
let currentOnPick = null;
let currentAnchor = null;
let isOpen = false;
let initialized = false;

let allLanguages = null; // { id, name, aliases }[], built lazily off hljs
let matches = [];
let activeIndex = 0;
// The popover opens as a dropup right above the button the user just
// clicked — so on open, the pointer is usually still sitting exactly where
// it was, right over whatever list item now renders at that same spot.
// Browsers re-hit-test and fire a real 'mouseenter' for that item as soon
// as it appears, with no actual pointer movement involved — which would
// otherwise silently steal the remembered-language pre-selection out from
// under the very "press Enter with zero typing" flow this picker exists
// for. `hoverArmed` stays false (ignoring mouseenter) until an actual
// 'mousemove' happens inside the popover, which a synthetic under-cursor
// hover never produces (only a genuine pointer move does) — see
// openCodeBlockPicker()/ensurePopover() below.
let hoverArmed = false;

function getLastLang() {
    try {
        return localStorage.getItem(LAST_LANG_KEY) || '';
    } catch {
        return '';
    }
}

function setLastLang(id) {
    try {
        localStorage.setItem(LAST_LANG_KEY, id);
    } catch {
        // ignore — worst case the picker just defaults to the top of the list
    }
}

function ensureLanguages() {
    if (allLanguages) return allLanguages;
    if (typeof hljs === 'undefined') return (allLanguages = []);
    allLanguages = hljs
        .listLanguages()
        .map((id) => {
            const def = hljs.getLanguage(id);
            return { id, name: def?.name || id, aliases: def?.aliases || [] };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    return allLanguages;
}

function filterLanguages(query) {
    const all = ensureLanguages();
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
        (l) =>
            l.name.toLowerCase().includes(q) ||
            l.id.includes(q) ||
            l.aliases.some((a) => a.includes(q))
    );
}

// Only called when the match set itself changes (open()/refresh()) — hover
// and keyboard nav go through setActive() instead, never this. Rebuilding
// on hover replaces the item under the pointer mid-hover and self-triggers
// another 'mouseenter' on the replacement, an infinite swap loop that never
// lets a click land — see MentionAutocomplete.js's own note on this exact
// bug (found 2026-08-31) for the full story.
function renderList() {
    listEl.innerHTML = '';
    itemEls = matches.map((lang, i) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'mention-autocomplete-item' + (i === activeIndex ? ' active' : '');
        item.textContent = lang.name;
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            pick(lang);
        });
        item.addEventListener('mouseenter', () => { if (hoverArmed) setActive(i); });
        listEl.appendChild(item);
        return item;
    });
    if (!matches.length) {
        const empty = document.createElement('div');
        empty.className = 'mention-autocomplete-empty';
        empty.textContent = 'No language found';
        listEl.appendChild(empty);
    }
}

function setActive(i) {
    if (i === activeIndex && itemEls[i]?.classList.contains('active')) return;
    itemEls[activeIndex]?.classList.remove('active');
    activeIndex = i;
    itemEls[activeIndex]?.classList.add('active');
    itemEls[activeIndex]?.scrollIntoView({ block: 'nearest' });
}

function refresh() {
    matches = filterLanguages(searchInput.value);
    const lastId = getLastLang();
    const lastIdx = matches.findIndex((l) => l.id === lastId);
    activeIndex = lastIdx >= 0 ? lastIdx : 0;
    renderList();
}

function refreshOnType() {
    matches = filterLanguages(searchInput.value);
    activeIndex = 0;
    renderList();
}

function pick(lang) {
    setLastLang(lang.id);
    const onPick = currentOnPick;
    close();
    onPick?.(lang.id);
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
    popover.className = 'emoji-picker-popover codeblock-picker-popover';
    popover.style.display = 'none';
    popover.addEventListener('click', (e) => e.stopPropagation());
    popover.addEventListener('mousemove', () => { hoverArmed = true; });

    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'emoji-picker-search';
    searchInput.placeholder = 'Search languages…';
    searchInput.addEventListener('input', refreshOnType);
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (matches.length) setActive((activeIndex + 1) % matches.length);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (matches.length) setActive((activeIndex - 1 + matches.length) % matches.length);
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            if (matches.length) {
                e.preventDefault();
                pick(matches[activeIndex]);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    });
    popover.appendChild(searchInput);

    listEl = document.createElement('div');
    listEl.className = 'mention-autocomplete-list';
    popover.appendChild(listEl);

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
    window.addEventListener(
        'scroll',
        (e) => {
            if (isOpen && !popover.contains(e.target)) close();
        },
        true
    );
    window.addEventListener('resize', () => {
        if (isOpen && currentAnchor?.offsetParent) position(currentAnchor);
    });
}

/**
 * Opens the shared code-block language picker anchored to `anchorEl`.
 * `onPick(languageId)` fires once, after the popover has already closed,
 * with the hljs language id the user picked — never fires on dismiss.
 * @param {HTMLElement} anchorEl
 * @param {(languageId: string) => void} onPick
 * @returns {void}
 */
export function openCodeBlockPicker(anchorEl, onPick) {
    ensurePopover();
    initGlobalListeners();

    isOpen = true;
    currentAnchor = anchorEl;
    currentOnPick = onPick;
    hoverArmed = false;
    searchInput.value = '';
    popover.style.display = '';
    refresh();
    position(anchorEl);
    searchInput.focus();
}

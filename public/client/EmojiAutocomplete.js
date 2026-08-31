/**
 * Discord-style `:shortcode` emoji autocomplete for the chat composer
 * (2026-08-31, owner-reported, companion to `MentionAutocomplete.js`'s `@`
 * trigger — same "no click-first affordance" motivation as that one).
 *
 * There's no canonical `:smile:`-style shortcode table vendored in this app
 * (`EmojiPicker.js`'s dataset — trimmed from emoji-picker-element-data — only
 * carries a plain-English `n` annotation like "grinning face" plus a `t` tags
 * array, not gemoji-style short names). Rather than vendor a second dataset
 * just to get exact `:smile:` names, this fuzzy-matches the query against
 * that same annotation/tags data (identical matching to `EmojiPicker.js`'s
 * own search box) and, on pick, inserts the **real emoji glyph directly**,
 * replacing the `:query` span — not literal `:shortcode:` text left for a
 * later render-time conversion. That's a deliberate simplification: nothing
 * else in this app has a shortcode-to-glyph pipeline (jumbo-emoji detection,
 * reactions, etc. all key off literal emoji characters already), and
 * building one just for this composer shortcut would be new machinery this
 * app doesn't otherwise need.
 *
 * Structurally a near-twin of `MentionAutocomplete.js` (same caret-anchored
 * popover, keyboard nav, mousedown-safe pick, blur/scroll/resize dismissal)
 * — only the trigger character, query rules, and result source differ, so
 * see that file for interaction-detail comments not repeated here. The two
 * intentionally aren't merged into one generic "composer autocomplete"
 * controller: the caret math they'd both need is shared via
 * `composerCaret.js` (the fiddly, bug-prone part), but the query/matching
 * logic is different enough per-trigger that a shared controller would add
 * more indirection than it'd save for just two call sites.
 */

import { caretRect } from './composerCaret.js';
import { ensureEmojiData, getRecentEmoji, recordRecentEmoji } from './EmojiPicker.js';

const GAP_PX = 4;
const EDGE_PX = 8;
const MAX_RESULTS = 8;
const MAX_QUERY_LEN = 24;

/**
 * Finds the in-progress `:query` ending at the caret, or null if the caret
 * isn't inside one. The `:` must start the text or follow whitespace (so a
 * mid-sentence `10:30` or `foo:bar` never triggers); unlike a mention query,
 * this one stops at the first space — real shortcode-style queries are a
 * single unbroken token, so a stray `:` followed by a space (e.g. "wait: ok")
 * should never keep a popover hanging around.
 * @param {string} text
 * @param {number} caretPos
 * @returns {{atIndex: number, query: string}|null}
 */
function findEmojiQuery(text, caretPos) {
    const uptoCaret = text.slice(0, caretPos);
    const atIndex = uptoCaret.lastIndexOf(':');
    if (atIndex === -1) return null;
    const charBefore = atIndex === 0 ? '' : uptoCaret[atIndex - 1];
    if (charBefore && !/\s/.test(charBefore)) return null;
    const query = uptoCaret.slice(atIndex + 1);
    if (/\s/.test(query) || query.length > MAX_QUERY_LEN) return null;
    return { atIndex, query };
}

/**
 * Wires `:shortcode` emoji autocomplete onto `textarea`. Self-contained —
 * owns its own popover, keyboard handling, and dismissal.
 * @param {HTMLTextAreaElement} textarea
 * @returns {void}
 */
export function attachEmojiAutocomplete(textarea) {
    let popover = null;
    let listEl = null;
    let matches = [];
    let activeIndex = 0;
    let emojiStart = -1; // index of ':' in textarea.value for the query currently shown
    let isOpen = false;
    let suppressNextInput = false;
    let cachedData = null; // the dataset, once ensureEmojiData() has resolved at least once
    let loadGeneration = 0; // guards a slow first-ever load against being superseded mid-flight

    function ensurePopover() {
        if (popover) return;
        popover = document.createElement('div');
        popover.className = 'mention-autocomplete-popover emoji-autocomplete-popover';
        popover.style.display = 'none';
        popover.addEventListener('mousedown', (e) => e.preventDefault());
        listEl = document.createElement('div');
        listEl.className = 'mention-autocomplete-list';
        popover.appendChild(listEl);
        document.body.appendChild(popover);
    }

    function renderList() {
        listEl.innerHTML = '';
        if (!matches.length) {
            const empty = document.createElement('div');
            empty.className = 'mention-autocomplete-empty';
            empty.textContent = 'Loading…';
            listEl.appendChild(empty);
            return;
        }
        matches.forEach((entry, i) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'mention-autocomplete-item emoji-autocomplete-item' + (i === activeIndex ? ' active' : '');
            item.innerHTML = `<span class="emoji-autocomplete-glyph">${entry.e}</span><span class="emoji-autocomplete-name"></span>`;
            item.querySelector('.emoji-autocomplete-name').textContent = entry.n;
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                pick(entry);
            });
            item.addEventListener('mouseenter', () => {
                activeIndex = i;
                renderList();
            });
            listEl.appendChild(item);
        });
    }

    function position() {
        const { left, bottom } = caretRect(textarea);
        const p = popover.getBoundingClientRect();
        let top = bottom + GAP_PX;
        if (top + p.height > window.innerHeight - EDGE_PX) {
            top = bottom - p.height - GAP_PX - 20;
        }
        top = Math.max(EDGE_PX, Math.min(top, window.innerHeight - p.height - EDGE_PX));
        const leftPos = Math.max(EDGE_PX, Math.min(left, window.innerWidth - p.width - EDGE_PX));
        popover.style.top = `${top}px`;
        popover.style.left = `${leftPos}px`;
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        if (popover) popover.style.display = 'none';
    }

    function open() {
        ensurePopover();
        isOpen = true;
        popover.style.display = '';
        renderList();
        requestAnimationFrame(() => { if (isOpen) position(); });
    }

    function findMatches(query, data) {
        const q = query.toLowerCase();
        if (!q) return (getRecentEmoji().map((e) => data.find((x) => x.e === e)).filter(Boolean));
        return data
            .filter((entry) => entry.n.includes(q) || entry.t.some((tag) => tag.includes(q)))
            .sort((a, b) => {
                const ai = a.n.indexOf(q), bi = b.n.indexOf(q);
                return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.n.length - b.n.length;
            });
    }

    function applyMatches(query, data) {
        const filtered = findMatches(query, data).slice(0, MAX_RESULTS);
        if (!filtered.length) { close(); return; }
        matches = filtered;
        activeIndex = 0;
        open();
    }

    function refresh() {
        if (textarea.selectionStart !== textarea.selectionEnd) { close(); return; }
        const found = findEmojiQuery(textarea.value, textarea.selectionStart);
        if (!found) { close(); return; }
        emojiStart = found.atIndex;

        if (cachedData) {
            applyMatches(found.query, cachedData);
            return;
        }

        // Only ever hit before the dataset has loaded once (the click-to-open
        // picker may already be warming it via the same ensureEmojiData()
        // cache — either way this resolves near-instantly after the first time).
        const requestId = ++loadGeneration;
        matches = [];
        open(); // shows the "Loading…" placeholder
        ensureEmojiData().then((data) => {
            cachedData = data;
            // A later refresh() (new keystroke, or a close) may have already
            // superseded this in-flight load — only act if this is still current.
            if (requestId !== loadGeneration || !isOpen) return;
            applyMatches(found.query, cachedData);
        }).catch(() => { if (isOpen) close(); });
    }

    function pick(entry) {
        const value = textarea.value;
        const caretPos = textarea.selectionStart;
        const before = value.slice(0, emojiStart);
        const after = value.slice(caretPos);
        const insertion = `${entry.e} `;
        textarea.value = before + insertion + after;
        const newCaret = before.length + insertion.length;
        textarea.setSelectionRange(newCaret, newCaret);
        recordRecentEmoji(entry.e);

        suppressNextInput = true;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        close();
        textarea.focus();
    }

    textarea.addEventListener('input', () => {
        if (suppressNextInput) { suppressNextInput = false; return; }
        requestAnimationFrame(refresh);
    });

    // Must be attached before App.js's own Enter-to-send keydown listener,
    // same ordering requirement as MentionAutocomplete.js — see the call
    // site in App.js.
    textarea.addEventListener('keydown', (e) => {
        if (!isOpen) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            close();
            return;
        }
        if (!matches.length) return; // still loading the dataset — let other keys behave normally
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIndex = (activeIndex + 1) % matches.length;
            renderList();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIndex = (activeIndex - 1 + matches.length) % matches.length;
            renderList();
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            e.stopImmediatePropagation();
            pick(matches[activeIndex]);
        }
    });

    textarea.addEventListener('blur', () => close());

    window.addEventListener('resize', () => { if (isOpen) position(); });
    document.addEventListener('scroll', (e) => {
        if (isOpen && !popover.contains(e.target) && e.target !== textarea) close();
    }, true);
}

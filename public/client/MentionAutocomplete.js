/**
 * Discord-style @mention autocomplete for the chat composer (2026-08-31,
 * owner-reported: typing an exact nickname by hand is error-prone — and
 * nicknames can contain spaces/unicode, so `ChatUI._processMentions()`'s
 * highlight regex only ever recognizes an `@` immediately followed by one of
 * the room's *exact* current nicknames anyway, see CLAUDE.md). Deliberately
 * anchored at the caret (not a fixed dropup) — the owner specifically didn't
 * want another "click a button first" affordance like the composer's "+"
 * emoji menu.
 *
 * `attachMentionAutocomplete()` wires directly onto the composer
 * `<textarea>` — a different shape than EmojiPicker.js/Tooltip.js's
 * click-to-open singleton popovers, since a mention popover has to
 * intercept keystrokes (arrow keys, Enter/Tab, Escape) while open rather
 * than being toggled by a single click, and there's only ever one composer
 * to attach to, so module-level state (not a class) is fine here too.
 *
 * Caret pixel positioning (`caretRect()`) is shared with `EmojiAutocomplete.js`
 * via `composerCaret.js` — see that file for how it works.
 */

import { caretRect } from './composerCaret.js';

const GAP_PX = 4;
const EDGE_PX = 8;
const MAX_RESULTS = 6;
const MAX_QUERY_LEN = 40;

/**
 * Finds the in-progress `@query` ending at the caret, or null if the caret
 * isn't inside one. The `@` must start the text or follow whitespace (so
 * `foo@bar` mid-word never triggers); the query itself may contain spaces,
 * since nicknames can — it's only capped in length and can't cross a newline.
 * @param {string} text
 * @param {number} caretPos
 * @returns {{atIndex: number, query: string}|null}
 */
function findMentionQuery(text, caretPos) {
    const uptoCaret = text.slice(0, caretPos);
    const atIndex = uptoCaret.lastIndexOf('@');
    if (atIndex === -1) return null;
    const charBefore = atIndex === 0 ? '' : uptoCaret[atIndex - 1];
    if (charBefore && !/\s/.test(charBefore)) return null;
    const query = uptoCaret.slice(atIndex + 1);
    if (query.includes('\n') || query.length > MAX_QUERY_LEN) return null;
    return { atIndex, query };
}

/**
 * Wires @mention autocomplete onto `textarea`. Self-contained — owns its
 * own popover, keyboard handling, and dismissal; the caller just needs to
 * attach it early (see the ordering note on the keydown listener below).
 * @param {HTMLTextAreaElement} textarea
 * @param {() => string[]} getNicknames - every current participant's display nickname.
 * @returns {void}
 */
export function attachMentionAutocomplete(textarea, getNicknames) {
    let popover = null;
    let listEl = null;
    let matches = [];
    let itemEls = [];
    let activeIndex = 0;
    let mentionStart = -1; // index of '@' in textarea.value for the query currently shown
    let isOpen = false;
    let suppressNextInput = false;

    function ensurePopover() {
        if (popover) return;
        popover = document.createElement('div');
        popover.className = 'mention-autocomplete-popover';
        popover.style.display = 'none';
        // mousedown (not click) + preventDefault so picking a suggestion never
        // blurs the textarea first — a blur would close the popover before the
        // click's own handler got a chance to run.
        popover.addEventListener('mousedown', (e) => e.preventDefault());
        listEl = document.createElement('div');
        listEl.className = 'mention-autocomplete-list';
        popover.appendChild(listEl);
        document.body.appendChild(popover);
    }

    // Rebuilds the DOM (only called when the match set itself changes, i.e.
    // from open()). Hover/keyboard nav must NOT go through this — replacing
    // the element currently under the mouse pointer retriggers a fresh
    // 'mouseenter' on its replacement (same screen position, new node), which
    // would call this again and loop, endlessly swapping the item out from
    // under the cursor before a click could ever land on a stable element
    // (reported 2026-08-31: hover worked, click did nothing). setActive()
    // below is the hover/keyboard-safe path — it only ever toggles a class.
    function renderList() {
        listEl.innerHTML = '';
        itemEls = matches.map((name, i) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'mention-autocomplete-item' + (i === activeIndex ? ' active' : '');
            item.textContent = name;
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                pick(name);
            });
            item.addEventListener('mouseenter', () => setActive(i));
            listEl.appendChild(item);
            return item;
        });
    }

    function setActive(i) {
        if (i === activeIndex && itemEls[i]?.classList.contains('active')) return;
        itemEls[activeIndex]?.classList.remove('active');
        activeIndex = i;
        itemEls[activeIndex]?.classList.add('active');
    }

    function position() {
        const { left, bottom } = caretRect(textarea);
        const p = popover.getBoundingClientRect();
        let top = bottom + GAP_PX;
        if (top + p.height > window.innerHeight - EDGE_PX) {
            // Not enough room below the caret line — flip above it instead.
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
        // Deferred a frame so this always measures *after* any other 'input'
        // listener on the same textarea (App.js's auto-grow resize) has run,
        // regardless of listener registration order — otherwise the popover
        // could position itself off the textarea's pre-grow height.
        requestAnimationFrame(() => { if (isOpen) position(); });
    }

    function refresh() {
        if (textarea.selectionStart !== textarea.selectionEnd) { close(); return; }
        const found = findMentionQuery(textarea.value, textarea.selectionStart);
        if (!found) { close(); return; }

        const q = found.query.trim().toLowerCase();
        const pool = [...new Set(getNicknames().map((n) => n.trim()).filter(Boolean))];
        const filtered = q
            ? pool.filter((n) => n.toLowerCase().includes(q))
                .sort((a, b) => a.toLowerCase().indexOf(q) - b.toLowerCase().indexOf(q) || a.length - b.length)
            : pool;

        if (!filtered.length) { close(); return; }

        mentionStart = found.atIndex;
        matches = filtered.slice(0, MAX_RESULTS);
        activeIndex = 0;
        open();
    }

    function pick(name) {
        const value = textarea.value;
        const caretPos = textarea.selectionStart;
        const before = value.slice(0, mentionStart);
        const after = value.slice(caretPos);
        const insertion = `@${name} `;
        textarea.value = before + insertion + after;
        const newCaret = before.length + insertion.length;
        textarea.setSelectionRange(newCaret, newCaret);

        // A real 'input' event so App.js's own listener (auto-grow, typing
        // status) reacts exactly like a manually-typed change would — but
        // suppressed on our own end so it doesn't immediately re-open the
        // popover (the inserted text still starts with '@name', which can
        // itself be a substring match for a longer nickname).
        suppressNextInput = true;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        close();
        textarea.focus();
    }

    textarea.addEventListener('input', () => {
        if (suppressNextInput) { suppressNextInput = false; return; }
        requestAnimationFrame(refresh);
    });

    // Must be attached before App.js's own Enter-to-send keydown listener so
    // stopImmediatePropagation() below can actually pre-empt it — see the
    // ordering note where this is called from App.js.
    textarea.addEventListener('keydown', (e) => {
        if (!isOpen) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((activeIndex + 1) % matches.length);
            itemEls[activeIndex]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((activeIndex - 1 + matches.length) % matches.length);
            itemEls[activeIndex]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            e.stopImmediatePropagation();
            pick(matches[activeIndex]);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopImmediatePropagation();
            close();
        }
    });

    // A suggestion click's own mousedown already preventDefault()s the blur
    // that would otherwise beat it, so this only ever fires for a genuine
    // focus-away (click elsewhere on the page, tab switch, etc).
    textarea.addEventListener('blur', () => close());

    window.addEventListener('resize', () => { if (isOpen) position(); });
    // capture:true to also see scrolls on the chat log (scroll doesn't
    // bubble) — excludes scrolls inside the popover itself and the textarea
    // (its own internal caret-scroll on a long wrapped composer).
    document.addEventListener('scroll', (e) => {
        if (isOpen && !popover.contains(e.target) && e.target !== textarea) close();
    }, true);
}

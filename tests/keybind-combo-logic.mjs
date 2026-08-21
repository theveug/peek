// Pure logic test for keybindUtils.js's combo capture/matching — no browser
// needed. Guards the 2026-08-21 multi-key (modifier+key) keybind support:
// canonical combo serialization, exact (not "at least") modifier matching,
// held-combo transition semantics for the PTT/PTM hold binds, and backward
// compatibility with pre-combo single-key binds.

const { isModifierCode, comboFromEvent, isComboHeld } = await import('../public/client/keybindUtils.js');

function assert(cond, msg) {
    if (!cond) throw new Error('FAIL: ' + msg);
    console.log('PASS: ' + msg);
}

function fakeEvent({ code, ctrlKey = false, altKey = false, shiftKey = false, metaKey = false }) {
    return { code, ctrlKey, altKey, shiftKey, metaKey };
}

(function testIsModifierCode() {
    assert(isModifierCode('ControlLeft') && isModifierCode('ShiftRight') && isModifierCode('AltLeft') && isModifierCode('MetaRight'),
        'recognizes every modifier code');
    assert(!isModifierCode('KeyU') && !isModifierCode('F9'), 'does not flag regular keys as modifiers');
})();

(function testComboFromEventBareKey() {
    const combo = comboFromEvent(fakeEvent({ code: 'KeyU' }));
    assert(combo === 'KeyU', 'a bare key with no modifiers serializes to just its own code, unchanged from the pre-combo format');
})();

(function testComboFromEventFixedOrder() {
    const combo = comboFromEvent(fakeEvent({ code: 'KeyM', shiftKey: true, ctrlKey: true }));
    assert(combo === 'Ctrl+Shift+KeyM', 'modifiers serialize in fixed Ctrl/Alt/Shift/Meta order regardless of press order');
})();

(function testIsComboHeldEngagesOnlyWhenFullyMatched() {
    const held = new Set(['KeyU']);
    assert(isComboHeld('Ctrl+Shift+KeyU', fakeEvent({ code: 'KeyU', ctrlKey: true, shiftKey: true }), held) === true,
        'engages when the main key is held and every required modifier flag is set');
    assert(isComboHeld('Ctrl+Shift+KeyU', fakeEvent({ code: 'ControlLeft', ctrlKey: true, shiftKey: false }), held) === false,
        'does not engage when a required modifier is missing');
})();

(function testIsComboHeldRequiresExactModifierMatch() {
    const held = new Set(['KeyU']);
    assert(isComboHeld('KeyU', fakeEvent({ code: 'KeyU', ctrlKey: true }), held) === false,
        'a bind with no modifiers does not match while an extra modifier is also held (exact match, not "at least")');
})();

(function testIsComboHeldDisengagesOnAnyKeyRelease() {
    const held = new Set(['KeyU']);
    // Fully held.
    assert(isComboHeld('Ctrl+Shift+KeyU', fakeEvent({ code: 'KeyU', ctrlKey: true, shiftKey: true }), held) === true,
        'sanity: fully held before any release');

    // Release Ctrl first (main key U stays physically down) — the keyup
    // event's own ctrlKey reads false for the key being released.
    assert(isComboHeld('Ctrl+Shift+KeyU', fakeEvent({ code: 'ControlLeft', ctrlKey: false, shiftKey: true }), held) === false,
        'releasing a modifier while the main key is still held disengages the combo');

    // Release the main key itself — caller removes it from the held set on keyup.
    held.delete('KeyU');
    assert(isComboHeld('Ctrl+Shift+KeyU', fakeEvent({ code: 'KeyU', ctrlKey: true, shiftKey: true }), held) === false,
        'releasing the main key disengages the combo even if modifiers are still (briefly) reported held');
})();

(function testIsComboHeldBackwardCompatBareKey() {
    const held = new Set(['KeyU']);
    assert(isComboHeld('KeyU', fakeEvent({ code: 'KeyU' }), held) === true,
        'a legacy pre-combo bare-code bind still matches an event with no modifiers held');
})();

(function testIsComboHeldEmptyBind() {
    assert(isComboHeld('', fakeEvent({ code: 'KeyU' }), new Set(['KeyU'])) === false, 'an unset (empty) bind never matches');
})();

// The pre-combo capture UI finalized on the very first keydown, even a lone
// modifier — so an already-saved bind can legitimately be a bare modifier
// code like "ControlLeft" with no '+'. Both helpers must keep treating that
// as "hold Ctrl alone," even though heldNonModCodes deliberately never
// tracks modifier codes.
(function testBareModifierBindBackwardCompat() {
    const noHeldKeys = new Set(); // modifier-only bind needs no entry in the non-modifier held set

    assert(comboFromEvent(fakeEvent({ code: 'ControlLeft', ctrlKey: true })) === 'ControlLeft',
        'a bare modifier keydown serializes to just its own code, not "Ctrl+ControlLeft"');

    assert(isComboHeld('ControlLeft', fakeEvent({ code: 'ControlLeft', ctrlKey: true }), noHeldKeys) === true,
        'a legacy bare-modifier bind engages on that modifier alone, with no non-modifier key held at all');

    assert(isComboHeld('ControlLeft', fakeEvent({ code: 'ControlLeft', ctrlKey: false }), noHeldKeys) === false,
        'releasing the modifier (ctrlKey now false on its own keyup) disengages the bare-modifier bind');

    assert(isComboHeld('ControlLeft', fakeEvent({ code: 'ShiftLeft', ctrlKey: true, shiftKey: true }), noHeldKeys) === false,
        'an extra modifier held alongside a bare-modifier bind does not match (exact match, not "at least")');
})();

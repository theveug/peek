// --- public/client/keybindUtils.js ---
// Shared combo-keybind helpers used by SettingsPanel.js (capture) and App.js
// (matching). Storage format: "Mod1+Mod2+...+Code" — modifiers in fixed
// Ctrl/Alt/Shift/Meta order, joined with '+', then the trailing non-modifier
// KeyboardEvent.code. A bare key with no modifiers serializes to just its own
// code (e.g. "KeyU") — identical to the single-key format stored before combo
// support existed, so every previously-saved keybind still matches unchanged.

// code -> 'Ctrl'/'Alt'/'Shift'/'Meta' family name, used both to recognize a
// modifier code and to map it back to the KeyboardEvent flag that tracks it.
const MODIFIER_FAMILY_BY_CODE = {
    ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
    AltLeft: 'Alt', AltRight: 'Alt',
    ShiftLeft: 'Shift', ShiftRight: 'Shift',
    MetaLeft: 'Meta', MetaRight: 'Meta',
};
const FAMILY_FLAG = { Ctrl: 'ctrlKey', Alt: 'altKey', Shift: 'shiftKey', Meta: 'metaKey' };
const FAMILIES = ['Ctrl', 'Alt', 'Shift', 'Meta'];

export function isModifierCode(code) {
    return code in MODIFIER_FAMILY_BY_CODE;
}

// Canonical combo string for a live KeyboardEvent — used both to finalize a
// keybind capture and to match a tap-style bind (Toggle Mute, Toggle Deafen).
//
// A bare modifier press (e.code itself is a modifier) serializes to just that
// code, e.g. "ControlLeft" — not "Ctrl+ControlLeft". This isn't reachable
// from the current capture UI (a modifier keydown never finalizes a capture
// on its own), but it's the only possible stored value the *pre-combo*
// capture UI could produce when the very first key pressed happened to be a
// modifier (it finalized on any first keydown) — preserving it exactly keeps
// an already-saved "hold Ctrl alone" bind working unchanged.
export function comboFromEvent(e) {
    if (isModifierCode(e.code)) return e.code;
    const mods = FAMILIES.filter((f) => e[FAMILY_FLAG[f]]);
    return mods.length ? `${mods.join('+')}+${e.code}` : e.code;
}

// Hold-bind matching (Push to Talk / Push to Mute only). A tap-style bind can
// just compare comboFromEvent(e) against the stored string, but a *held*
// combo must stay "satisfied" across the natural press/release order of its
// individual keys — releasing any one of them (not just the last one
// pressed) has to register as a release. `heldNonModCodes` is the caller's
// live Set of currently-down non-modifier codes; the modifier portion is
// read straight off `event` (ctrlKey/altKey/shiftKey/metaKey are always
// browser-accurate for whichever key just fired this event, including its
// own release), so no separate modifier-held tracking is needed here.
export function isComboHeld(comboStr, event, heldNonModCodes) {
    if (!comboStr) return false;
    const parts = comboStr.split('+');
    const mainCode = parts[parts.length - 1];

    // A bare-modifier legacy bind (see comboFromEvent above) has no separate
    // "held key" to look up in heldNonModCodes — the modifier code itself
    // *is* the whole bind, so its own live event flag is the source of truth.
    const mainFamily = MODIFIER_FAMILY_BY_CODE[mainCode];
    const mainHeld = mainFamily ? event[FAMILY_FLAG[mainFamily]] === true : heldNonModCodes.has(mainCode);
    if (!mainHeld) return false;

    const required = new Set(parts.slice(0, -1));
    if (mainFamily) required.add(mainFamily); // don't also require it as a separate prefix modifier
    return FAMILIES.every((f) => required.has(f) === event[FAMILY_FLAG[f]]);
}

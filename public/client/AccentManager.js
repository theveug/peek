// --- public/client/AccentManager.js ---
// Circular import — see AccountSettingsSync.js's own top-of-file comment for
// why this is safe (every use is inside a function body, not at module load).
import { syncPreference } from './AccountSettingsSync.js';

// The accent choices from the design spec — oklch(0.70 0.16 H) at a
// different hue. Orange is the exception: it's the logo's Signal #FF5A1F
// exactly (oklch 0.68 0.21 38), not squeezed onto the shared lightness/chroma,
// which left it visibly paler than the logo beside it. Default since the
// 2026-10-28 logo pack. Keep theme-boot.js's copy in sync.
const PRESETS = {
    orange: 38,
    violet: 286,
    indigo: 264,
    blue: 215,
    green: 155,
    amber: 70,
    pink: 355,
};

// Per-preset [lightness, chroma, hover lightness, hover chroma]; anything not
// listed uses the shared ladder.
const LC = { orange: [0.68, 0.21, 0.74, 0.19] };
const BASE_LC = [0.70, 0.16, 0.76, 0.155];

const DEFAULT_ACCENT = 'orange';

function lcFor(name) {
    return LC[name] ?? BASE_LC;
}

export function getStoredAccent() {
    const stored = localStorage.getItem('accentHue');
    return PRESETS[stored] ? stored : DEFAULT_ACCENT;
}

export function applyAccent(name) {
    if (!PRESETS[name]) name = DEFAULT_ACCENT;
    const hue = PRESETS[name];
    const [l, c, hl, hc] = lcFor(name);
    const root = document.documentElement.style;
    root.setProperty('--accent', `oklch(${l} ${c} ${hue})`);
    root.setProperty('--accentH', `oklch(${hl} ${hc} ${hue})`);
    root.setProperty('--accentSoft', `oklch(${l} ${c} ${hue} / 0.18)`);
    root.setProperty('--accentSoft2', `oklch(${l} ${c} ${hue} / 0.32)`);
    root.setProperty('--accentText', 'oklch(0.99 0 0)');
}

export function setAccent(name) {
    if (!PRESETS[name]) return;
    localStorage.setItem('accentHue', name);
    applyAccent(name);
    syncPreference();
}

export function initAccent() {
    applyAccent(getStoredAccent());
}

export function accentPresetNames() {
    return Object.keys(PRESETS);
}

export function presetColor(name) {
    if (!PRESETS[name]) name = DEFAULT_ACCENT;
    const [l, c] = lcFor(name);
    return `oklch(${l} ${c} ${PRESETS[name]})`;
}

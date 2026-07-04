// --- public/client/AccentManager.js ---
// The 6 accent choices from the design spec — all oklch(0.70 0.16 H) at a
// different hue, so only H needs to vary per preset.
const PRESETS = {
    violet: 286,
    indigo: 264,
    blue: 215,
    green: 155,
    amber: 70,
    pink: 355,
};

const DEFAULT_ACCENT = 'violet';

export function getStoredAccent() {
    const stored = localStorage.getItem('accentHue');
    return PRESETS[stored] ? stored : DEFAULT_ACCENT;
}

export function applyAccent(name) {
    const hue = PRESETS[name] ?? PRESETS[DEFAULT_ACCENT];
    const root = document.documentElement.style;
    root.setProperty('--accent', `oklch(0.70 0.16 ${hue})`);
    root.setProperty('--accentH', `oklch(0.76 0.155 ${hue})`);
    root.setProperty('--accentSoft', `oklch(0.70 0.16 ${hue} / 0.18)`);
    root.setProperty('--accentSoft2', `oklch(0.70 0.16 ${hue} / 0.32)`);
    root.setProperty('--accentText', 'oklch(0.99 0 0)');
}

export function setAccent(name) {
    if (!PRESETS[name]) return;
    localStorage.setItem('accentHue', name);
    applyAccent(name);
}

export function initAccent() {
    applyAccent(getStoredAccent());
}

export function accentPresetNames() {
    return Object.keys(PRESETS);
}

export function presetColor(name) {
    const hue = PRESETS[name] ?? PRESETS[DEFAULT_ACCENT];
    return `oklch(0.70 0.16 ${hue})`;
}

// --- public/client/FontScaleManager.js ---
// User-adjustable multiplier on top of the fluid clamp() base font-size
// (see tailwind.css's "Fluid base font-size" section) — Settings ->
// Appearance -> Text size. Same get/apply/set/init shape as
// AccentManager.js/BackgroundManager.js, applied on documentElement since
// --font-scale is declared once in :root, not redeclared per-theme on
// body.light (see CLAUDE.md's runtime-CSS-custom-property-override
// standing rule for why that distinction matters).
const DEFAULT_SCALE = 1;
const MIN_SCALE = 0.85;
const MAX_SCALE = 1.3;

export function getStoredFontScale() {
    const stored = parseFloat(localStorage.getItem('fontScale'));
    if (!Number.isFinite(stored) || stored < MIN_SCALE || stored > MAX_SCALE) return DEFAULT_SCALE;
    return stored;
}

export function applyFontScale(scale) {
    document.documentElement.style.setProperty('--font-scale', String(scale));
}

export function setFontScale(scale) {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    localStorage.setItem('fontScale', String(clamped));
    applyFontScale(clamped);
    return clamped;
}

export function initFontScale() {
    applyFontScale(getStoredFontScale());
}

/** @param {number} scale @returns {string} a short human label ("Default", "Larger", "85%", etc.) for the settings slider's live value display. */
export function fontScaleLabel(scale) {
    if (scale === DEFAULT_SCALE) return 'Default';
    return `${Math.round(scale * 100)}%`;
}

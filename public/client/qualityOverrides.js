// Session-only screen/cam quality overrides (2026-11-06, owner-requested).
// Settings panel writes the saved defaults to localStorage. The in-room quick
// pickers (dock carets, quick-settings popover) only set an override here,
// held in memory, so it's gone on the next page load (leave + rejoin, refresh)
// and the Settings defaults come back.

export const QUALITY_KEYS = ['screenShareRes', 'screenShareFps', 'camRes', 'camFps'];

const overrides = new Map();

/** Effective value: session override, else saved default, else fallback. */
export function getQuality(key, fallback = null) {
    if (overrides.has(key)) return overrides.get(key);
    return localStorage.getItem(key) ?? fallback;
}

/** Temporary change for this page session only. */
export function setQualityOverride(key, value) {
    overrides.set(key, value);
}

/** Drop the override so the saved default applies again. */
export function clearQualityOverride(key) {
    overrides.delete(key);
}

// --- public/client/ThemePackManager.js ---
// "Theme packs" — official, maintainer-authored alternate looks (corner
// rounding, shadow depth, spacing density), same get/apply/set/init shape as
// AccentManager.js/BackgroundManager.js/FontScaleManager.js. Deliberately
// named "pack" rather than reusing ThemeManager.js's "theme" — that file
// already owns dark/light and the two concepts are independent (a pack
// applies identically regardless of dark/light; ThemeManager keeps deciding
// that on its own).
//
// Scope note: a pack only owns --radius-*/--shadow-*/--density-scale, not
// accent hue or background tint. Those stay fully independent, user-owned
// pickers (AccentManager.js/BackgroundManager.js) layered on top — a pack
// changing the app's shape language doesn't touch color. Making a pack also
// curate a *default* accent/tint (for a user who's never explicitly picked
// one) is a reasonable future extension, but needs AccentManager/
// BackgroundManager to first distinguish "explicit user choice" from
// "inherited default" (today `getStoredAccent()`/`getStoredBackgroundTint()`
// can't tell the two apart — an unset localStorage key and an explicit
// "violet" pick both resolve to the same DEFAULT_* fallback) — not worth
// that surgery just to ship the shape/density dimension.
const THEME_PACKS = {
    default: {
        label: 'Default',
        // Swatch preview: a small radius/shadow/density "fingerprint" shown
        // as 3 stacked bars in the Settings picker, not a color — packs
        // don't carry color, see the scope note above.
        previewSwatch: ['0.75rem', '0.625rem', '0.5rem'],
        tokens: {
            radiusSm: '0.5rem',
            radiusMd: '0.625rem',
            radiusLg: '0.75rem',
            shadowSm: '0 4px 20px rgba(0, 0, 0, 0.25)',
            shadowMd: '0 8px 20px rgba(0, 0, 0, 0.35)',
            shadowLg: '0 12px 32px rgba(0, 0, 0, 0.4)',
            densityScale: '1',
        },
    },
    compact: {
        label: 'Compact',
        previewSwatch: ['0.375rem', '0.3125rem', '0.25rem'],
        tokens: {
            radiusSm: '0.25rem',
            radiusMd: '0.3125rem',
            radiusLg: '0.375rem',
            shadowSm: '0 2px 10px rgba(0, 0, 0, 0.3)',
            shadowMd: '0 4px 14px rgba(0, 0, 0, 0.4)',
            shadowLg: '0 6px 20px rgba(0, 0, 0, 0.45)',
            densityScale: '0.88',
        },
    },
    soft: {
        label: 'Soft',
        previewSwatch: ['1.125rem', '0.875rem', '0.75rem'],
        tokens: {
            radiusSm: '0.75rem',
            radiusMd: '0.875rem',
            radiusLg: '1.125rem',
            shadowSm: '0 6px 24px rgba(0, 0, 0, 0.22)',
            shadowMd: '0 10px 28px rgba(0, 0, 0, 0.3)',
            shadowLg: '0 16px 40px rgba(0, 0, 0, 0.35)',
            densityScale: '1.05',
        },
    },
    sharp: {
        label: 'Sharp',
        previewSwatch: ['0.25rem', '0.1875rem', '0.125rem'],
        tokens: {
            radiusSm: '0.125rem',
            radiusMd: '0.1875rem',
            radiusLg: '0.25rem',
            shadowSm: '0 2px 6px rgba(0, 0, 0, 0.35)',
            shadowMd: '0 3px 10px rgba(0, 0, 0, 0.4)',
            shadowLg: '0 4px 14px rgba(0, 0, 0, 0.45)',
            densityScale: '0.95',
        },
    },
};

const DEFAULT_PACK = 'default';

const TOKEN_PROPS = {
    radiusSm: '--radius-sm',
    radiusMd: '--radius-md',
    radiusLg: '--radius-lg',
    shadowSm: '--shadow-sm',
    shadowMd: '--shadow-md',
    shadowLg: '--shadow-lg',
    densityScale: '--density-scale',
};

export function getStoredThemePack() {
    const stored = localStorage.getItem('themePack');
    return THEME_PACKS[stored] ? stored : DEFAULT_PACK;
}

export function applyThemePack(id) {
    const pack = THEME_PACKS[id] ?? THEME_PACKS[DEFAULT_PACK];
    // Every token here is theme(dark/light)-invariant — declared once in
    // :root, never redeclared on body.light — so it goes on documentElement,
    // same as --accent*/--font-scale (see CLAUDE.md's runtime-CSS-custom-
    // property-override standing rule for why that split matters).
    const root = document.documentElement.style;
    for (const [key, prop] of Object.entries(TOKEN_PROPS)) {
        root.setProperty(prop, pack.tokens[key]);
    }
}

export function setThemePack(id) {
    if (!THEME_PACKS[id]) return;
    localStorage.setItem('themePack', id);
    applyThemePack(id);
}

export function initThemePack() {
    applyThemePack(getStoredThemePack());
}

export function themePackPresetNames() {
    return Object.keys(THEME_PACKS);
}

export function themePackLabel(id) {
    return (THEME_PACKS[id] ?? THEME_PACKS[DEFAULT_PACK]).label;
}

export function themePackPreviewSwatch(id) {
    return (THEME_PACKS[id] ?? THEME_PACKS[DEFAULT_PACK]).previewSwatch;
}

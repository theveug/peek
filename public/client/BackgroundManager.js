// --- public/client/BackgroundManager.js ---
// A "Background Tint" swatch picker (from an earlier design prototype, not
// the current Peek.dc.html mockup) — mirrors AccentManager.js's shape so
// adding a preset later is a one-line edit here, no CSS/token changes needed.
//
// Unlike accent tokens (one fixed lightness/chroma recipe regardless of
// theme), the background scale has two different lightness/chroma ladders —
// one per theme — copied verbatim from tailwind.css's :root/body.light. Only
// the hue varies per preset; applyBackgroundTint() needs to know which
// ladder is active, so it must be re-run whenever the theme itself changes.
const PRESETS = {
    violet: 286,
    slate: 250,
    plum: 320,
    forest: 145,
    sand: 60,
    ocean: 200,
};

const DEFAULT_BG = 'violet';

const DARK_LADDER = {
    bg1: [0.165, 0.014],
    bg2: [0.205, 0.014],
    bg3: [0.245, 0.013],
    bg4: [0.30, 0.015],
    bg5: [0.36, 0.016],
    border: [0.345, 0.016],
    input: [0.295, 0.014],
};

const LIGHT_LADDER = {
    bg1: [0.915, 0.012],
    bg2: [0.955, 0.009],
    bg3: [0.995, 0.003],
    bg4: [0.945, 0.012],
    bg5: [0.90, 0.014],
    border: [0.89, 0.013],
    input: [0.965, 0.008],
};

export function getStoredBackgroundTint() {
    const stored = localStorage.getItem('bgTint');
    return PRESETS[stored] ? stored : DEFAULT_BG;
}

export function applyBackgroundTint(name, isLight) {
    const hue = PRESETS[name] ?? PRESETS[DEFAULT_BG];
    const ladder = isLight ? LIGHT_LADDER : DARK_LADDER;
    // Set on body, not documentElement: unlike accent tokens (only declared
    // once in :root), --bg1..5/--border/--input are redeclared per-theme on
    // `body.light` — an inline override on <html> would be shadowed by that
    // more-specific same-element stylesheet rule on <body> while light theme
    // is active, since a directly-matched declaration always beats an
    // inherited one regardless of where the inline override lives.
    const root = document.body.style;
    for (const [token, [l, c]] of Object.entries(ladder)) {
        root.setProperty(`--${token}`, `oklch(${l} ${c} ${hue})`);
    }
}

export function setBackgroundTint(name, isLight) {
    if (!PRESETS[name]) return;
    localStorage.setItem('bgTint', name);
    applyBackgroundTint(name, isLight);
}

export function bgTintPresetNames() {
    return Object.keys(PRESETS);
}

// Swatch preview always renders in one fixed recipe (dark ladder's bg5),
// same convention as AccentManager.presetColor() ignoring the active theme.
export function presetBgColor(name) {
    const hue = PRESETS[name] ?? PRESETS[DEFAULT_BG];
    const [l, c] = DARK_LADDER.bg5;
    return `oklch(${l} ${c} ${hue})`;
}

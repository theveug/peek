// --- public/client/theme-boot.js ---
// Classic (non-module) script, included as the very first thing inside
// <body>, before any visible markup. Its only job is to kill the flash of
// default-preset colors that showed for a beat before ThemeManager.js (an ES
// module, always deferred by spec even without the `defer` attribute) got a
// chance to run. Running here — synchronously, blocking the rest of body
// from parsing/painting — applies the user's stored theme/accent/background
// tint before the browser has painted anything from body at all.
//
// Deliberately duplicates the preset tables from AccentManager.js/
// BackgroundManager.js/FontScaleManager.js/ThemePackManager.js rather than
// importing them: `import`/`export` require `type="module"`, and module
// scripts can't run synchronously ahead of paint. If those preset tables (or
// FontScaleManager's min/max clamp range) change, update both here and in
// the real modules.
(function () {
    try {
        var theme = localStorage.getItem('theme');
        if (!theme) {
            theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        var isLight = theme === 'light';
        document.body.classList.remove('dark', 'light');
        document.body.classList.add(theme);

        var ACCENT_HUES = { violet: 286, indigo: 264, blue: 215, green: 155, amber: 70, pink: 355 };
        var accentName = localStorage.getItem('accentHue');
        if (!ACCENT_HUES.hasOwnProperty(accentName)) accentName = 'violet';
        var accentHue = ACCENT_HUES[accentName];
        var htmlStyle = document.documentElement.style;
        htmlStyle.setProperty('--accent', 'oklch(0.70 0.16 ' + accentHue + ')');
        htmlStyle.setProperty('--accentH', 'oklch(0.76 0.155 ' + accentHue + ')');
        htmlStyle.setProperty('--accentSoft', 'oklch(0.70 0.16 ' + accentHue + ' / 0.18)');
        htmlStyle.setProperty('--accentSoft2', 'oklch(0.70 0.16 ' + accentHue + ' / 0.32)');
        htmlStyle.setProperty('--accentText', 'oklch(0.99 0 0)');

        var BG_HUES = { violet: 286, slate: 250, plum: 320, forest: 145, sand: 60, ocean: 200 };
        var bgName = localStorage.getItem('bgTint');
        if (!BG_HUES.hasOwnProperty(bgName)) bgName = 'violet';
        var bgHue = BG_HUES[bgName];
        var ladder = isLight
            ? { bg1: [0.915, 0.012], bg2: [0.955, 0.009], bg3: [0.995, 0.003], bg4: [0.945, 0.012], bg5: [0.90, 0.014], border: [0.89, 0.013], input: [0.965, 0.008] }
            : { bg1: [0.165, 0.014], bg2: [0.205, 0.014], bg3: [0.245, 0.013], bg4: [0.30, 0.015], bg5: [0.36, 0.016], border: [0.345, 0.016], input: [0.295, 0.014] };
        var bodyStyle = document.body.style;
        for (var key in ladder) {
            var lc = ladder[key];
            bodyStyle.setProperty('--' + key, 'oklch(' + lc[0] + ' ' + lc[1] + ' ' + bgHue + ')');
        }

        var fontScale = parseFloat(localStorage.getItem('fontScale'));
        if (!isFinite(fontScale) || fontScale < 0.85 || fontScale > 1.3) fontScale = 1;
        htmlStyle.setProperty('--font-scale', String(fontScale));

        var THEME_PACKS = {
            default: { radius2xs: '0.25rem', radiusXs: '0.375rem', radiusSm: '0.5rem', radiusMd: '0.625rem', radiusLg: '0.75rem', shadowSm: '0 4px 20px rgba(0, 0, 0, 0.25)', shadowMd: '0 8px 20px rgba(0, 0, 0, 0.35)', shadowLg: '0 12px 32px rgba(0, 0, 0, 0.4)', shadowXl: '0 8px 40px rgba(0, 0, 0, 0.5)', densityScale: '1' },
            compact: { radius2xs: '0.125rem', radiusXs: '0.1875rem', radiusSm: '0.25rem', radiusMd: '0.3125rem', radiusLg: '0.375rem', shadowSm: '0 2px 10px rgba(0, 0, 0, 0.3)', shadowMd: '0 4px 14px rgba(0, 0, 0, 0.4)', shadowLg: '0 6px 20px rgba(0, 0, 0, 0.45)', shadowXl: '0 5px 24px rgba(0, 0, 0, 0.5)', densityScale: '0.88' },
            soft: { radius2xs: '0.375rem', radiusXs: '0.5625rem', radiusSm: '0.75rem', radiusMd: '0.875rem', radiusLg: '1.125rem', shadowSm: '0 6px 24px rgba(0, 0, 0, 0.22)', shadowMd: '0 10px 28px rgba(0, 0, 0, 0.3)', shadowLg: '0 16px 40px rgba(0, 0, 0, 0.35)', shadowXl: '0 20px 48px rgba(0, 0, 0, 0.4)', densityScale: '1.05' },
            sharp: { radius2xs: '0.0625rem', radiusXs: '0.125rem', radiusSm: '0.125rem', radiusMd: '0.1875rem', radiusLg: '0.25rem', shadowSm: '0 2px 6px rgba(0, 0, 0, 0.35)', shadowMd: '0 3px 10px rgba(0, 0, 0, 0.4)', shadowLg: '0 4px 14px rgba(0, 0, 0, 0.45)', shadowXl: '0 5px 16px rgba(0, 0, 0, 0.5)', densityScale: '0.95' },
        };
        var packName = localStorage.getItem('themePack');
        if (!THEME_PACKS.hasOwnProperty(packName)) packName = 'default';
        var pack = THEME_PACKS[packName];
        htmlStyle.setProperty('--radius-2xs', pack.radius2xs);
        htmlStyle.setProperty('--radius-xs', pack.radiusXs);
        htmlStyle.setProperty('--radius-sm', pack.radiusSm);
        htmlStyle.setProperty('--radius-md', pack.radiusMd);
        htmlStyle.setProperty('--radius-lg', pack.radiusLg);
        htmlStyle.setProperty('--shadow-sm', pack.shadowSm);
        htmlStyle.setProperty('--shadow-md', pack.shadowMd);
        htmlStyle.setProperty('--shadow-lg', pack.shadowLg);
        htmlStyle.setProperty('--shadow-xl', pack.shadowXl);
        htmlStyle.setProperty('--density-scale', pack.densityScale);
    } catch (e) {
        // localStorage may be unavailable (privacy mode); fall back silently
        // to the hardcoded defaults already in the HTML/CSS.
    }
})();

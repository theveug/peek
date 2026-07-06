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
// BackgroundManager.js rather than importing them: `import`/`export` require
// `type="module"`, and module scripts can't run synchronously ahead of
// paint. If those preset tables change, update both here and in the real
// modules.
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
    } catch (e) {
        // localStorage may be unavailable (privacy mode); fall back silently
        // to the hardcoded defaults already in the HTML/CSS.
    }
})();

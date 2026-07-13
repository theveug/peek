import { initAccent } from './AccentManager.js';
import { getStoredBackgroundTint, applyBackgroundTint } from './BackgroundManager.js';
import { initFontScale } from './FontScaleManager.js';

function updateIcons(theme) {
    const sun = document.getElementById('theme-sun');
    const moon = document.getElementById('theme-moon');
    if (!sun || !moon) return;
    if (theme === 'light') {
        sun.classList.add('hidden');
        moon.classList.remove('hidden');
    } else {
        sun.classList.remove('hidden');
        moon.classList.add('hidden');
    }
}

function apply(theme) {
    if (theme === 'light') {
        document.body.classList.remove('dark');
        document.body.classList.add('light');
    } else {
        document.body.classList.remove('light');
        document.body.classList.add('dark');
    }
    updateIcons(theme);
    applyBackgroundTint(getStoredBackgroundTint(), theme === 'light');
}

// Applies + persists a specific theme. Exported so both the lobby/room
// #theme-toggle button and the Settings panel's System/Dark/Light picker can
// set an explicit value, not just flip between the two. `'system'` is a
// pseudo-value, not a stored one — it clears the explicit override instead,
// so getEffectiveTheme() falls back to the OS preference and the live
// prefers-color-scheme listener in initTheme() resumes following it.
export function setTheme(theme) {
    if (theme === 'system') {
        localStorage.removeItem('theme');
        apply(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        return;
    }
    apply(theme);
    localStorage.setItem('theme', theme);
}

export function getEffectiveTheme() {
    const stored = localStorage.getItem('theme');
    if (stored) return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function initTheme() {
    initAccent();
    // Font-scale doesn't depend on light/dark like accent/background-tint do —
    // it's a flat multiplier applied once at load, not re-applied per theme
    // change — but this is the one init entry point both App.js and lobby.js
    // already call, so it lives here rather than needing a third call site.
    initFontScale();

    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
    apply(getEffectiveTheme());

    prefersDark.addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
            apply(e.matches ? 'dark' : 'light');
        }
    });

    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const current = document.body.classList.contains('light') ? 'light' : 'dark';
            setTheme(current === 'dark' ? 'light' : 'dark');
        });
    }
}

import { initAccent } from './AccentManager.js';

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
}

// Applies + persists a specific theme. Exported so both the lobby/room
// #theme-toggle button and the Settings panel's Dark/Light picker can set an
// explicit value, not just flip between the two.
export function setTheme(theme) {
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

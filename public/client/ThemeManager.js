export function initTheme() {
    const stored = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');

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

    function getEffective() {
        if (stored) return stored;
        return prefersDark.matches ? 'dark' : 'light';
    }

    apply(getEffective());

    prefersDark.addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
            apply(e.matches ? 'dark' : 'light');
        }
    });

    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const current = document.body.classList.contains('light') ? 'light' : 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            localStorage.setItem('theme', next);
            apply(next);
        });
    }
}

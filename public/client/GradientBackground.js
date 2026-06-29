export function initGradientBackground() {
    const canvas = document.getElementById('gradient-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w, h;
    let time = 0;
    let animId;

    function resize() {
        w = canvas.width = window.innerWidth;
        h = canvas.height = window.innerHeight;
    }

    function getColors() {
        const style = getComputedStyle(document.body);
        return [
            style.getPropertyValue('--gradient-1').trim() || '#1a0533',
            style.getPropertyValue('--gradient-2').trim() || '#0a1628',
            style.getPropertyValue('--gradient-3').trim() || '#0f2027',
            style.getPropertyValue('--gradient-4').trim() || '#0d001a',
        ];
    }

    const blobs = [
        { x: 0.25, y: 0.3, r: 0.45, sx: 0.0003, sy: 0.0004, ox: 0, oy: 0 },
        { x: 0.75, y: 0.6, r: 0.5,  sx: 0.0005, sy: 0.0003, ox: 2, oy: 1 },
        { x: 0.5,  y: 0.8, r: 0.4,  sx: 0.0004, sy: 0.0005, ox: 4, oy: 3 },
        { x: 0.6,  y: 0.2, r: 0.35, sx: 0.0003, sy: 0.0002, ox: 1, oy: 5 },
    ];

    function hexToRgba(hex, alpha) {
        hex = hex.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    function draw() {
        time++;
        const colors = getColors();
        const isLight = document.body.classList.contains('light');

        ctx.fillStyle = colors[3];
        ctx.fillRect(0, 0, w, h);

        blobs.forEach((b, i) => {
            const cx = (b.x + Math.sin(time * b.sx + b.ox) * 0.15) * w;
            const cy = (b.y + Math.cos(time * b.sy + b.oy) * 0.12) * h;
            const r = b.r * Math.min(w, h);

            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
            const alpha = isLight ? 0.5 : 1;
            grad.addColorStop(0, hexToRgba(colors[i % colors.length], alpha));
            grad.addColorStop(1, 'transparent');

            ctx.globalCompositeOperation = isLight ? 'source-over' : 'lighter';
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
            ctx.globalCompositeOperation = 'source-over';
        });

        animId = requestAnimationFrame(draw);
    }

    window.addEventListener('resize', resize);
    resize();
    draw();

    return () => {
        cancelAnimationFrame(animId);
        window.removeEventListener('resize', resize);
    };
}

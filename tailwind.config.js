import typography from '@tailwindcss/typography'

/** @type {import('tailwindcss').Config} */
export default {
    content: [
        './public/**/*.html',
        './public/**/*.js',
    ],
    theme: {
        extend: {},
    },
    plugins: [typography],
}

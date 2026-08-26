/* Tailwind build configuration.
 *
 * The pages used to pull cdn.tailwindcss.com, which is the browser build: a
 * render-blocking script that scans the DOM and generates the stylesheet on
 * every visit. Measured on a throttled 4G phone that cost 1,428 ms to first
 * paint against a 6 ms server response - the page spent its whole load waiting
 * for CSS that never changes.
 *
 * So the stylesheet is built ahead of time instead. Regenerate it after adding
 * or renaming any class:
 *
 *     npx tailwindcss@3 -i static/css/tailwind.src.css -o static/css/app.css
 *
 * Deliberately not --minify. The minifier rewrites colours into whichever
 * notation is shortest, and hsla() does not round-trip every one of this
 * palette's values exactly - text-cream-100/70 came back a step lighter. The
 * responses are gzipped, which takes the difference between minified and not
 * down to about 1.8 KB, and that is not worth paying in colour fidelity.
 *
 * `content` below is what the scanner reads. scripts.js is in there because
 * several classes only ever appear in JavaScript - the canvas tool buttons and
 * the preview page images among them - and they are written as complete
 * literal strings so the scanner can see them. Keep it that way: a class
 * assembled by concatenation at runtime is invisible here and will silently
 * lose its styling.
 */
module.exports = {
  content: [
    './templates/**/*.html',
    './static/**/*.js',
  ],
  theme: {
    extend: {
      fontFamily: {
        // 'Poppins Fallback' is a metric-matched stand-in defined in
        // static/css/tailwind.src.css, so the page does not move when the real
        // font finishes loading.
        poppins: ['Poppins', 'Poppins Fallback', 'sans-serif'],
      },
      colors: {
        forest: {
          900: '#1F2937', // Dark charcoal
          800: '#2B4C3F', // Deep forest green
          700: '#3A5F4D', // Forest green
          600: '#4B7161', // Medium forest green
          500: '#698575', // Sage green
          400: '#86998A', // Light sage
        },
        burgundy: {
          600: '#8B3A4A', // Deep burgundy
          500: '#A54B5E', // Medium burgundy
          400: '#BF5C72', // Light burgundy
        },
        cream: {
          100: '#F7F4F1', // Light cream
          200: '#EAE6E1', // Medium cream
          300: '#DDD8D3', // Dark cream
        },
      },
    },
  },
  plugins: [],
};

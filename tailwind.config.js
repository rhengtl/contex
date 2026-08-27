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
 *     python build_css.py
 *
 * That runs tailwind and then strips comments from the output - see the
 * docstring in build_css.py for why both halves are there. Deliberately not
 * --minify: the minifier rewrites colours into whichever notation is shortest,
 * and hsla() does not round-trip every one of this palette's values exactly -
 * text-cream-100/70 came back a step lighter. Colour fidelity is not something
 * to trade for bytes in an application whose whole job is reproducing a
 * document faithfully.
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
        /* Both fallbacks are metric-matched stand-ins defined in
         * static/css/tailwind.src.css, so the page does not move when the real
         * fonts finish loading. */
        poppins: ['Poppins', 'Poppins Fallback', 'sans-serif'],
        display: ['Spectral', 'Spectral Fallback', 'Spectral Fallback Times',
                  'Georgia', 'serif'],
      },
      colors: {
        /* -------------------------------------------------------------
           Ink and paper: the two things this app is actually about.

           Every value below was checked against every surface it is
           allowed to sit on - see the contrast table in tailwind.src.css.
           Two pairings fail and are therefore forbidden rather than
           fudged: ink-400 and paper-400 must never be used on paper-200.
           ------------------------------------------------------------- */
        ink: {
          900: '#171C1A', // headings
          700: '#2E3A34', // body text
          500: '#4A5951', // secondary text
          400: '#5C6A61', // meta: timestamps, captions, counts
        },
        paper: {
          50:  '#FBFAF8', // raised surface - cards, fields, dialogs
          100: '#F4F1EB', // the page itself
          200: '#E8E3DA', // inset - code blocks, preview gutter, chips
          300: '#D8D1C5', // hairline rules (decorative)
          400: '#7E8A82', // interactive boundaries - field and button borders
        },

        /* The existing palette, kept. forest previously started at 400,
           which is why bg-forest-100 appeared 23 times in the markup and
           generated no CSS at all: the shade did not exist. */
        forest: {
          900: '#1F2937',
          800: '#2B4C3F', // primary action
          700: '#3A5F4D',
          600: '#4B7161',
          500: '#698575',
          400: '#86998A',
          300: '#A8B8AC',
          200: '#CFDBD2',
          100: '#E4EDE7',
           50: '#F1F6F2',
        },
        burgundy: {
          700: '#71303D',
          600: '#8B3A4A', // secondary accent, destructive
          500: '#A54B5E',
          400: '#BF5C72',
          100: '#F6E7EA',
        },
        cream: {
          100: '#F7F4F1',
          200: '#EAE6E1',
          300: '#DDD8D3',
        },

        /* Status colours, warmed to sit on paper rather than on white. */
        caution: {
          700: '#7A5411', // text
          500: '#AE8025', // border
          100: '#FBF2DC', // ground
        },
        alarm: {
          700: '#8A2C2C',
          500: '#C25454',
          100: '#FAE7E4',
        },
        affirm: {
          700: '#2F6B45',
          500: '#4E9468',
          100: '#E6F2EA',
        },
      },
      borderRadius: {
        /* Restrained. An editorial page is built from rules and margins,
           not from pills - the only fully round things left are the camera
           shutter and the avatar dot. */
        DEFAULT: '4px',
        sm: '3px',
        md: '6px',
        lg: '8px',
        xl: '12px',
      },
      boxShadow: {
        /* One shadow, for things that genuinely float above the page.
           Everything else separates with a hairline. */
        lift: '0 1px 2px rgb(23 28 26 / 0.05), 0 8px 24px -8px rgb(23 28 26 / 0.16)',
        dialog: '0 24px 64px -16px rgb(23 28 26 / 0.35)',
      },
      transitionDuration: {
        DEFAULT: '150ms',
      },
      maxWidth: {
        /* A comfortable measure for running text, and the working width of
           the converter. */
        measure: '64ch',
      },
      keyframes: {
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        /* The processing mark: the quill breathes. Not a progress
           indication - it deliberately carries no information about how
           far along the conversion is, because the server does not report
           that and a bar which implied it would be a lie. */
        breathe: {
          '0%, 100%': { opacity: '0.75', transform: 'scale(0.975)' },
          '50%': { opacity: '1', transform: 'scale(1)' },
        },
        'sweep': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
      },
      animation: {
        'rise-in': 'rise-in 180ms cubic-bezier(0.2, 0, 0.2, 1) both',
        'fade-in': 'fade-in 150ms ease-out both',
        breathe: 'breathe 2.4s ease-in-out infinite',
        sweep: 'sweep 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};

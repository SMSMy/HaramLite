/* Tailwind config for the official site (docs/).
   Two token sets, both from the owner's exported designs and both the same
   Clay & Coal palette: the landing page theme and the extension page theme
   (coal/clay/sand/status scales). Kept in this file alone so editing the site
   can never disturb the app's own tailwind.config.cjs.
   The site ships a COMPILED stylesheet instead of the Tailwind CDN: the project
   promises no external requests and no tracking, and a runtime CDN breaks that
   promise (and the page offline).
   Rebuild with:  pnpm site:css
*/
const design =
{ darkMode: "class", theme: { extend: { "colors": { "outline-variant": "#55433d", "clay-accent": "#DA7756", "tertiary-container": "#00a494", "secondary-fixed-dim": "#c9c6c2", "on-primary-fixed-variant": "#7b2f13", "error": "#ffb4ab", "on-tertiary-fixed": "#00201c", "on-secondary": "#31302d", "coal-surface": "#141413", "surface-bright": "#3b3936", "on-secondary-container": "#b7b5b0", "on-tertiary-fixed-variant": "#005048", "surface-container": "#211f1d", "coal-bg": "#1F1D1B", "on-tertiary-container": "#00312c", "inverse-surface": "#e7e1de", "on-surface-variant": "#dbc1b9", "background": "#151311", "surface-container-high": "#2c2a27", "surface-container-low": "#1d1b19", "secondary-container": "#474743", "surface": "#151311", "inverse-primary": "#994528", "surface-container-lowest": "#100e0c", "on-primary-fixed": "#390b00", "surface-dim": "#151311", "cream-text": "#F5F2ED", "on-primary-container": "#541500", "surface-tint": "#ffb59d", "on-secondary-fixed-variant": "#474743", "outline": "#a38c85", "warn-yellow": "#F3AE35", "secondary": "#c9c6c2", "on-surface": "#e7e1de", "primary": "#ffb59d", "on-error": "#690005", "surface-container-highest": "#373432", "tertiary": "#5ddac8", "primary-fixed-dim": "#ffb59d", "tertiary-fixed-dim": "#5ddac8", "inverse-on-surface": "#32302e", "surface-variant": "#373432", "on-tertiary": "#003731", "on-background": "#e7e1de", "on-secondary-fixed": "#1c1c19", "secondary-fixed": "#e5e2dd", "border-muted": "#2E2C29", "error-container": "#93000a", "on-error-container": "#ffdad6", "tertiary-fixed": "#7cf7e4", "primary-fixed": "#ffdbd0", "on-primary": "#5d1901", "primary-container": "#da7756" }, "borderRadius": { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" }, "spacing": { "margin-desktop": "32px", "gutter": "16px", "stack-md": "16px", "stack-sm": "8px", "margin-mobile": "16px", "unit": "4px", "stack-lg": "24px" }, "fontFamily": { "label-sm": [ "Thmanyah Sans" ], "headline-xl": [ "Thmanyah Serif Display" ], "headline-lg-mobile": [ "Thmanyah Serif Display" ], "headline-lg": [ "Thmanyah Serif Display" ], "body-md": [ "Thmanyah Sans" ], "mono-code": [ "monospace" ], "body-lg": [ "Thmanyah Sans" ], "label-md": [ "Thmanyah Sans" ] }, "fontSize": { "label-sm": [ "12px", { "lineHeight": "1.2", "fontWeight": "500" } ], "headline-xl": [ "36px", { "lineHeight": "1.2", "fontWeight": "900" } ], "headline-lg-mobile": [ "24px", { "lineHeight": "1.3", "fontWeight": "700" } ], "headline-lg": [ "28px", { "lineHeight": "1.3", "fontWeight": "700" } ], "body-md": [ "16px", { "lineHeight": "1.5", "fontWeight": "400" } ], "mono-code": [ "13px", { "lineHeight": "1.5", "fontWeight": "400" } ], "body-lg": [ "18px", { "lineHeight": "1.6", "fontWeight": "500" } ], "label-md": [ "14px", { "lineHeight": "1.2", "letterSpacing": "0.05em", "fontWeight": "600" } ] } } } }
;

const bridge =
{
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            coal: {
              950: '#100e0c',
              900: '#151311',
              850: '#1a1816',
              800: '#211f1d',
              700: '#2e2c29',
              600: '#3b3936'
            },
            clay: {
              DEFAULT: '#da7756',
              bright: '#e88665',
              hover: '#ea8361',
              subtle: 'rgba(218, 119, 86, 0.12)',
              glow: 'rgba(218, 119, 86, 0.25)',
              accent: '#ffb59d'
            },
            sand: {
              100: '#f5f2ed',
              200: '#e5e1da',
              400: '#a38c85',
              500: '#756b66'
            },
            status: {
              ok: '#5ddac8',
              bad: '#ffb4ab',
              warn: '#f3ae35'
            }
          }
        }
      }
    }
;
  /* رموز تصميم صفحات الأدلة (من تصدير المالك) — تُدمج دمجاً عميقاً مع
     رموز الجسر لأن Object.assign يستبدل المفتاح كاملاً ولو دمجناه سطحياً
     لضاع تدرّج coal و clay في صفحة الإضافة. */
  const guidePalette =
  {
    coal: { base: '#100e0c', surface: '#151311', card: '#1d1b19', cardhover: '#24211e', border: '#2E2C29', muted: '#3b3834' },
    clay: { DEFAULT: '#DA7756', hover: '#e88665', dark: '#b85f40' },
    cream: { text: '#F5F2ED', muted: '#A38C85', dim: '#6E6763' },
  };



const merge = (a, b) => Object.assign({}, a || {}, b || {});

module.exports = {
  darkMode: 'class',
  theme: {
    extend: Object.assign({}, design.theme.extend, bridge.theme.extend, {
      colors: (() => {
        const base = merge(design.theme.extend.colors, bridge.theme.extend.colors);
        return Object.assign({}, base, {
          coal: Object.assign({}, guidePalette.coal, base.coal || {}),
          clay: Object.assign({}, guidePalette.clay, base.clay || {}),
          cream: guidePalette.cream,
        });
      })(), fontFamily: { serif: ['"Thmanyah Serif Display"', 'Georgia', 'serif'], sans: ['"Thmanyah Sans"', '"Segoe UI"', 'system-ui', 'sans-serif'] },
    }),
  },
  content: ['./docs/index.html', './docs/bridge.html', './docs/PRIVACY.html', './docs/guides/*.html'],
};
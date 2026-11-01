// Hum Notes looks. A style sets the type, the shapes and a few base colours for each tone
// (light, mid, dark: light and mid carry dark text, dark carries light text); every other colour
// the pages and canvases use is worked out from those here and set as CSS custom properties.
// Loaded in <head> so the page paints in its saved look straight away.
(function () {
  const UI = {
    instrument: "'Instrument Sans', ui-sans-serif, system-ui, sans-serif",
    serif: "'Instrument Serif', Georgia, 'Times New Roman', serif",
    grotesk: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    news: "'Newsreader', Georgia, 'Times New Roman', serif",
    system: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
    nunito: "'Nunito', ui-rounded, system-ui, sans-serif",
  };
  const DEGREES = {
    pastel: ['#E8A598', '#EBC18E', '#E2D08A', '#AECD9F', '#9EC3DA', '#BDB1DD', '#E2A9C2'],
    vivid: ['#F0595E', '#F59E2E', '#E2BB12', '#46BC66', '#35AED6', '#8B7AF0', '#EC67AC'],
    vividDark: ['#FF6B6F', '#FFA94D', '#FFD43B', '#69DB7C', '#4FC3F7', '#A99BFF', '#F783C0'],
    earth: ['#CD8068', '#D6A65C', '#CDB95E', '#93B282', '#82A7BA', '#A190B8', '#C3849A'],
  };
  const LAYERS = {
    light: ['#0B8F8A', '#B86E00', '#A23BB5', '#5B8A12'],
    mid: ['#04625E', '#7E4300', '#701182', '#375E04'],
    dark: ['#2DD4BF', '#FBBF24', '#E879F9', '#A3E635'],
  };
  // shape: r = control corner, rp = panel corner; cards: shadow | border | flat; lamps: on/off
  // switches; rec: solid red or quiet (a red dot); seg: track | underline | invert; primary: ink | accent
  const STYLES = {
    classic: {
      name: 'Classic', note: 'ink on paper, serif headings',
      ui: UI.instrument, display: UI.serif, displayWeight: 400, num: UI.instrument,
      r: 8, rp: 14, cards: 'shadow', lamps: false, rec: 'quiet', seg: 'track', primary: 'ink', degrees: 'pastel',
      label: { font: UI.instrument, size: '12px', case: 'none', spacing: '0', weight: 500 },
      h3: { font: UI.serif, size: '20px', case: 'none', spacing: '0', weight: 400, rule: 'none' },
      tones: {
        light: { bg: '#F3F2EF', panel: '#FFFFFF', raise: '#FFFFFF', text: '#1C1B19', muted: '#6A675F', accent: '#405468', rec: '#B63A30', roll: '#FFFFFF' },
        mid: { bg: '#A9A6A0', panel: '#B9B6B0', raise: '#C8C5BF', text: '#141312', muted: '#33312E', accent: '#22344A', rec: '#8C1F17', roll: '#C2BFB9' },
        dark: { bg: '#121211', panel: '#1B1B1A', raise: '#262624', text: '#ECEAE5', muted: '#9C988F', accent: '#A3B5C8', rec: '#E0675C', roll: '#171716' },
      },
    },
    editorial: {
      name: 'Editorial', note: 'warm paper, serif throughout, square corners',
      ui: UI.news, display: UI.serif, displayWeight: 400, displayStyle: 'italic', num: UI.news,
      r: 2, rp: 3, cards: 'border', lamps: false, rec: 'quiet', seg: 'underline', primary: 'ink', degrees: 'earth',
      label: { font: UI.news, size: '13px', case: 'none', spacing: '0.02em', weight: 500, variant: 'small-caps' },
      h3: { font: UI.serif, size: '21px', case: 'none', spacing: '0', weight: 400, style: 'italic', rule: 'block' },
      tones: {
        light: { bg: '#F2EDE3', panel: '#FBF8F1', raise: '#FFFDF8', text: '#221E1A', muted: '#6B6257', accent: '#2E5040', rec: '#B3322A', roll: '#FFFDF8' },
        mid: { bg: '#B2A999', panel: '#C2B9A9', raise: '#D0C8B9', text: '#1A1612', muted: '#3A332B', accent: '#1F3A2D', rec: '#8A2018', roll: '#CBC3B4' },
        dark: { bg: '#161412', panel: '#1F1C19', raise: '#2A2621', text: '#EDE6DA', muted: '#A49B8D', accent: '#A3C7AF', rec: '#E26A5C', roll: '#1A1815' },
      },
    },
    minimal: {
      name: 'Minimal', note: 'greys and black, flat, system type',
      ui: UI.system, display: UI.system, displayWeight: 600, num: UI.system,
      r: 10, rp: 16, cards: 'flat', lamps: false, rec: 'solid', seg: 'track', primary: 'ink', degrees: 'vivid',
      label: { font: UI.system, size: '12px', case: 'none', spacing: '0', weight: 500 },
      h3: { font: UI.system, size: '13px', case: 'none', spacing: '0', weight: 600, rule: 'none' },
      tones: {
        light: { bg: '#F0F0F0', panel: '#FFFFFF', raise: '#F4F4F4', text: '#111111', muted: '#6E6E6E', accent: '#111111', rec: '#E5484D', roll: '#FFFFFF' },
        mid: { bg: '#9C9C9C', panel: '#ACACAC', raise: '#BBBBBB', text: '#0A0A0A', muted: '#2A2A2A', accent: '#0A0A0A', rec: '#9B1C1C', roll: '#B4B4B4' },
        dark: { bg: '#000000', panel: '#111111', raise: '#1D1D1D', text: '#F2F2F2', muted: '#8F8F8F', accent: '#F2F2F2', rec: '#FF5C5C', roll: '#0A0A0A' },
      },
    },
    soft: {
      name: 'Soft', note: 'rounded, sage green, friendly',
      ui: UI.nunito, display: UI.nunito, displayWeight: 800, num: UI.nunito,
      r: 14, rp: 22, cards: 'shadow', lamps: true, rec: 'solid', seg: 'track', primary: 'accent', degrees: 'pastel',
      label: { font: UI.nunito, size: '12px', case: 'none', spacing: '0', weight: 700 },
      h3: { font: UI.nunito, size: '15px', case: 'none', spacing: '0', weight: 800, rule: 'none' },
      tones: {
        light: { bg: '#EBEFE8', panel: '#FAFBF8', raise: '#FFFFFF', text: '#1F2A24', muted: '#5C695F', accent: '#4F7A62', accentInk: '#3D6450', rec: '#C63F3A', roll: '#FFFFFF' },
        mid: { bg: '#9CA79E', panel: '#ACB7AE', raise: '#BCC6BE', text: '#0E1611', muted: '#25322A', accent: '#234D37', rec: '#8E2420', roll: '#B5BFB7' },
        dark: { bg: '#101512', panel: '#18201B', raise: '#222C26', text: '#E7EFE9', muted: '#93A299', accent: '#8FC2A4', rec: '#F07C77', roll: '#141B17' },
      },
    },
    studio: {
      name: 'Studio', note: 'electric blue, lamps, mono labels',
      ui: UI.grotesk, display: UI.grotesk, displayWeight: 700, num: UI.mono,
      r: 6, rp: 10, cards: 'border', lamps: true, rec: 'solid', seg: 'track', primary: 'accent', degrees: 'vivid',
      label: { font: UI.mono, size: '10px', case: 'uppercase', spacing: '0.1em', weight: 500 },
      h3: { font: UI.mono, size: '10px', case: 'uppercase', spacing: '0.1em', weight: 500, rule: 'block' },
      tones: {
        light: { bg: '#E6E9ED', panel: '#F7F8FA', raise: '#FFFFFF', text: '#0D1014', muted: '#545E69', accent: '#2D4BF0', accentInk: '#213CD0', rec: '#D3302B', roll: '#FCFDFE' },
        mid: { bg: '#8B9299', panel: '#9AA1A9', raise: '#AEB4BB', text: '#06080B', muted: '#1C2229', accent: '#1A2DB5', accentInk: '#0F1D85', rec: '#A9131A', roll: '#A4ABB2' },
        dark: { bg: '#0A0C0F', panel: '#12151A', raise: '#1B1F25', text: '#E7EAEE', muted: '#909AA5', accent: '#7088FF', accentInk: '#93A5FF', rec: '#FF5A54', roll: '#0E1115' },
      },
    },
    terminal: {
      name: 'Terminal', note: 'monospace everything, green, square',
      ui: UI.mono, display: UI.mono, displayWeight: 700, num: UI.mono,
      r: 0, rp: 0, cards: 'border', lamps: true, rec: 'solid', seg: 'invert', primary: 'accent', degrees: 'vivid',
      label: { font: UI.mono, size: '11px', case: 'uppercase', spacing: '0.06em', weight: 500 },
      h3: { font: UI.mono, size: '11px', case: 'uppercase', spacing: '0.08em', weight: 700, rule: 'block' },
      tones: {
        light: { bg: '#E7E7E0', panel: '#F4F4EE', raise: '#FFFFFF', text: '#111111', muted: '#58584F', accent: '#0B7A3B', rec: '#C2261C', roll: '#FAFAF6' },
        mid: { bg: '#9B9B92', panel: '#AAAAA1', raise: '#BABAB1', text: '#0A0A0A', muted: '#24241F', accent: '#064A23', rec: '#8A160F', roll: '#B3B3AA' },
        dark: { bg: '#0A0C0A', panel: '#0F130F', raise: '#172017', text: '#C9F2C4', muted: '#73A06F', accent: '#5BE38D', rec: '#FF5F56', roll: '#0C100C' },
      },
    },
  };

  // ---------- colour arithmetic ----------
  const hx = h => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const toHex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  const mix = (a, b, t) => { const A = hx(a), B = hx(b); return toHex(A.map((v, i) => v + (B[i] - v) * t)); };
  const rgba = (a, al) => { const A = hx(a); return `rgba(${A[0]},${A[1]},${A[2]},${al})`; };
  const lum = h => hx(h).map(v => v / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // the colour moved toward `to` until it reads at `min` contrast against `bg`
  const readable = (c, bg, to, min = 4.5) => { let out = c; for (let t = 0.05; t <= 1.0001 && contrast(out, bg) < min; t += 0.05) out = mix(c, to, t); return out; };
  const onColour = (bg, dark, light) => contrast(bg, light) >= contrast(bg, dark) ? light : dark;

  function tokens(styleId, tone) {
    const S = STYLES[styleId] || STYLES.classic, T = S.tones[tone] || S.tones.light, dark = tone === 'dark';
    const { bg, panel, raise, text, rec, roll } = T;
    const muted = readable(T.muted, panel, text);
    const accent = T.accent, accentInk = readable(T.accentInk || accent, panel, text);
    const ink = '#111111', paper = '#FFFFFF';
    const v = {
      bg, panel, raise, text, muted, roll, accent, rec,
      sunk: dark ? mix(panel, '#000000', 0.35) : mix(panel, text, 0.055),
      line: mix(panel, text, dark ? 0.15 : 0.13), 'line-strong': mix(panel, text, 0.36),
      'accent-ink': accentInk, 'accent-soft': rgba(accent, dark ? 0.18 : 0.12), 'on-accent': onColour(accent, dark ? T.bg : text, paper),
      'on-rec': onColour(rec, dark ? T.bg : ink, paper),
      'primary-bg': S.primary === 'ink' ? text : accent, 'primary-fg': S.primary === 'ink' ? panel : onColour(accent, dark ? T.bg : text, paper),
      ok: dark ? '#6CD98A' : tone === 'mid' ? '#0D4A24' : '#1E7F45', bad: dark ? '#FF8A73' : tone === 'mid' ? '#7A1209' : '#B42318',
      'shadow-key': dark ? '0 1px 3px rgba(0,0,0,0.55)' : tone === 'mid' ? '0 1px 0 rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.2)' : '0 1px 0 rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.11)',
      'shadow-pop': dark ? '0 14px 36px rgba(0,0,0,0.6)' : tone === 'mid' ? '0 12px 32px rgba(0,0,0,0.3)' : '0 12px 32px rgba(0,0,0,0.16)',
      'shadow-card': dark ? '0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 28px rgba(0,0,0,0.35)' : tone === 'mid' ? '0 1px 2px rgba(0,0,0,0.12), 0 6px 20px rgba(0,0,0,0.10)' : '0 1px 2px rgba(0,0,0,0.05), 0 6px 22px rgba(0,0,0,0.06)',
      // the roll
      'lane-black': dark ? 'rgba(0,0,0,0.28)' : rgba(text, 0.04), 'lane-root': rgba(accent, dark ? 0.14 : 0.10), 'lane-fifth': rgba(accent, 0.045),
      trace: accentInk, note: rgba(accent, dark ? 0.3 : 0.2), 'note-edge': accentInk, grid: rgba(text, dark ? 0.06 : 0.07),
      bar: rgba(text, dark ? 0.18 : 0.24), wave: rgba(text, dark ? 0.14 : 0.15),
      'bk-note': rgba(text, dark ? 0.06 : 0.07), 'bk-edge': mix(roll, text, 0.33), 'bk-low': rgba(text, dark ? 0.12 : 0.13), 'bk-low-edge': muted,
      // type and shape
      ui: S.ui, display: S.display, 'display-weight': S.displayWeight, 'display-style': S.displayStyle || 'normal', mono: S.num,
      'r-ctl': S.r + 'px', 'r-panel': S.rp + 'px',
      'label-font': S.label.font, 'label-size': S.label.size, 'label-case': S.label.case, 'label-spacing': S.label.spacing, 'label-weight': S.label.weight, 'label-variant': S.label.variant || 'normal',
      'h3-font': S.h3.font, 'h3-size': S.h3.size, 'h3-case': S.h3.case, 'h3-spacing': S.h3.spacing, 'h3-weight': S.h3.weight, 'h3-style': S.h3.style || 'normal', 'h3-rule': S.h3.rule,
    };
    const deg = S.degrees === 'vivid' && dark ? DEGREES.vividDark : DEGREES[S.degrees] || DEGREES.pastel;
    deg.forEach((c, i) => { v['deg' + (i + 1)] = c; });
    v.deg0 = mix(roll, text, 0.28);
    v['on-deg'] = '#161616';
    (LAYERS[tone] || LAYERS.light).forEach((c, i) => { v['layer' + (i + 1)] = c; });
    // names older pages use
    v.surface = panel; v['accent-strong'] = accentInk; v.good = v.ok;
    return { v, S };
  }

  function apply(styleId, tone) {
    if (!STYLES[styleId]) styleId = 'classic';
    if (!['light', 'mid', 'dark'].includes(tone)) tone = 'light';
    const { v, S } = tokens(styleId, tone), root = document.documentElement;
    for (const [k, val] of Object.entries(v)) root.style.setProperty('--' + k, String(val));
    Object.assign(root.dataset, { theme: tone, style: styleId, cards: S.cards, lamps: S.lamps ? 'on' : 'off', rec: S.rec, seg: S.seg });
    root.style.colorScheme = tone === 'dark' ? 'dark' : 'light';
    return { style: styleId, tone };
  }

  window.HumThemes = { STYLES, apply, tokens, contrast, mix };
  // first paint in the saved look
  try {
    const o = JSON.parse(localStorage.getItem('hum-settings') || '{}');
    apply(o.look || 'classic', o.theme || 'light');
  } catch { apply('classic', 'light'); }
})();

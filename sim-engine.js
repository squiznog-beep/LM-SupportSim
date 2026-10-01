'use strict';
// ===========================================================================
// Support Sim: preview engine.
// Draws a Lex Talionis conversation the way the game does: portraits with
// blinking and talking, the speech bubble with LT's own font and colours, and
// the commands a support conversation uses. Constants mirror LT-Maker
// (app/events/screen_positions.py, app/engine/dialog.py, speak_style.py).
// ===========================================================================
const W = 240, H = 160;
const HPOS = { OffscreenLeft: -96, FarLeft: -24, LeftCorner: -16, Left: 0, MidLeft: 24, CenterLeft: 24,
  CenterRight: W - 120, MidRight: W - 120, LevelUpRight: W - 100, Right: W - 96, RightCorner: W - 80,
  FarRight: W - 72, OffscreenRight: W };
const VPOS = { Top: 0, Middle: (H - 80) >> 1, Bottom: H - 80 };
const ALIASES = { u: 'add_portrait', uu: 'multi_add_portrait', r: 'remove_portrait', rr: 'multi_remove_portrait',
  rrr: 'remove_all_portraits', s: 'speak', b: 'change_background', t: 'transition', e: 'expression',
  bop: 'bop_portrait', mirror: 'mirror_portrait', m: 'music', mf: 'music_fade_back' };
const FLAGS = new Set(['no_talk', 'immediate', 'no_block', 'mirror', 'low_priority', 'hold', 'keep_portraits', 'scroll',
  'low_saturation', 'autogray', 'no_warn', 'fade', 'fit', 'no_popup', 'no_sound', 'wait', 'center', 'no_split', 'wait_for_input']);
const NO_PREVIEW = new Set(['speak_style', 'add_talk', 'remove_talk', 'game_var', 'level_var', 'give_item', 'give_money',
  'win_game', 'lose_game', 'change_ai', 'give_exp', 'set_value', 'increment_support_points', 'unlock_support_rank']);
// Colours the preview can draw even if the project's font has no palette for
// them yet (the validator says so). Whisper uses grey by default.
const EXTRA_PALETTES = { grey: [[120, 120, 120], [208, 208, 208]] };
const TEXT_FX = new Set(['wave', 'wave2', 'jitter', 'jitter2', 'sin']);

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------
const A = { manifest: null, portraits: {}, backgrounds: {}, fonts: {}, fontCache: {}, ui: {}, units: {}, source: null, looks: [] };
// Preview variables currently chosen in the builder (e.g. YuelGender), for
// looks: portrait / voice / variables the project's events set per value.
let PREVIEW_VARS = {};
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not load ' + src)); i.src = src; });
}
const UI_SPRITES = ['message_bg_base', 'message_bg_tail', 'name_tag', 'menu_bg_base', 'message_bg_thought_tail'];
const CONVO_FONTS = ['convo', 'iconvo', 'bconvo', 'nconvo'];

// ---------------------------------------------------------------------------
// Where assets come from.
//  * bundle:  the assets/ folder published next to the page (build_assets.py)
//  * project: an LT project folder the user picked. Everything is read from
//    the folder in the browser (nothing is uploaded), so new portraits,
//    music or voices show up the next time the folder is opened.
// A source answers url(kind, name) -> a URL the page can load, or null.
// ---------------------------------------------------------------------------
function bundleSource(base) {
  base = base || 'assets/';
  const DIR = { portrait: 'portraits/', bg: 'backgrounds/', music: 'music/', sfx: 'sfx/', font: 'ui/', ui: 'ui/' };
  const EXT = { portrait: '.png', bg: '.png', music: '.ogg', sfx: '.ogg', font: '.png', ui: '.png' };
  return {
    kind: 'bundle', label: 'Sample assets', base,
    url(kind, name) { return base + DIR[kind] + encodeURIComponent(name) + EXT[kind]; },
    async manifest() { return (await fetch(base + 'assets.json')).json(); },
  };
}

// fs: { name, file(relPath) -> Promise<File|null> } with paths relative to the
// .ltproj folder, e.g. 'resources/portraits/portraits.json'.
function projectSource(fs, fallback) {
  const urls = new Map();
  const found = new Map();   // kind|name -> File
  const DIR = { portrait: 'portraits', bg: 'panoramas', music: 'music', sfx: 'sfx', font: 'fonts', ui: 'custom_sprites' };
  const EXT = { portrait: '.png', bg: '.png', music: '.ogg', sfx: '.ogg', font: '.png', ui: '.png' };
  const readJson = async (rel) => { const f = await fs.file(rel); if (!f) return null; try { return JSON.parse(await f.text()); } catch (e) { return null; } };
  return {
    kind: 'project', label: fs.name, fs,
    url(kind, name) {
      const f = found.get(kind + '|' + name);
      if (!f) return kind === 'ui' && fallback ? fallback.url(kind, name) : null;
      if (!urls.has(f)) urls.set(f, URL.createObjectURL(f));
      return urls.get(f);
    },
    async manifest() {
      const R = 'resources/';
      const m = { project: fs.name, portraits: [], backgrounds: [], music: [], sfx: [], fonts: {}, units: [] };
      const add = async (kind, name, file) => { const f = await fs.file(R + DIR[kind] + '/' + file); if (f) found.set(kind + '|' + name, f); return !!f; };
      const jobs = [];
      for (const p of (await readJson(R + 'portraits/portraits.json')) || [])
        jobs.push(add('portrait', p.nid, p.nid + '.png').then(ok => { if (ok) m.portraits.push(p); }));
      for (const b of (await readJson(R + 'panoramas/panoramas.json')) || []) {
        const [nid, frames] = Array.isArray(b) ? b : [b.nid, b.num_frames];
        // animated backgrounds are nid0.png, nid1.png...: the preview uses frame 0
        jobs.push(add('bg', nid, nid + ((frames || 1) > 1 ? '0' : '') + '.png').then(ok => { if (ok) m.backgrounds.push(nid); }));
      }
      m.musicVolume = {};
      for (const s of (await readJson(R + 'music/music.json')) || []) {
        const nid = Array.isArray(s) ? s[0] : s.nid;
        const vol = Array.isArray(s) ? s[5] : s.volume;   // fork: the track's own volume
        if (vol != null && isFinite(+vol)) m.musicVolume[nid] = Math.max(0, Math.min(1, +vol));
        jobs.push(add('music', nid, nid + '.ogg').then(ok => { if (ok) m.music.push(nid); }));
      }
      for (const s of (await readJson(R + 'sfx/sfx.json')) || []) {
        const nid = Array.isArray(s) ? s[0] : s.nid;
        jobs.push(add('sfx', nid, nid + '.ogg').then(ok => { if (ok) m.sfx.push(nid); }));
      }
      const fontInfo = {};
      for (const f of (await readJson(R + 'fonts/fonts.json')) || []) fontInfo[f.nid] = f;
      for (const nid of CONVO_FONTS) {
        jobs.push((async () => {
          const idx = await fs.file(R + 'fonts/' + nid + '.idx');
          if (!idx || !(await add('font', nid, nid + '.png'))) return;
          const entry = parseFontIdx(await idx.text());
          const info = fontInfo[nid] || {};
          entry.default_color = info.default_color;
          entry.palettes = {};
          for (const [k, v] of Object.entries(info.palettes || {})) entry.palettes[k] = v.map(c => c.slice(0, 3));
          m.fonts[nid] = entry;
        })());
      }
      for (const u of UI_SPRITES) jobs.push(add('ui', u, u + '.png'));
      for (const u of (await readJson('game_data/units.json')) || [])
        m.units.push({ nid: u.nid, name: u.name, portrait: u.portrait_nid, fields: u.fields || [] });
      m.looks = looksFromEvents((await readJson('game_data/events.json')) || []);
      await Promise.all(jobs);
      const byName = (a, b) => String(a).localeCompare(String(b));
      m.portraits.sort((a, b) => byName(a.nid, b.nid)); m.backgrounds.sort(byName); m.music.sort(byName); m.sfx.sort(byName);
      if (!m.fonts.convo && fallback) {   // a project without its own convo font: use the sample one
        const fm = await fallback.manifest();
        for (const nid of CONVO_FONTS) if (!m.fonts[nid] && fm.fonts && fm.fonts[nid]) { m.fonts[nid] = fm.fonts[nid]; found.set('font|' + nid, null); m._fontFromBundle = true; }
      }
      return m;
    },
    release() { for (const u of urls.values()) URL.revokeObjectURL(u); urls.clear(); },
  };
}

// LT .idx font index -> {cell_w, cell_h, glyphs: {char: [col, row, width]}}
function parseFontIdx(text) {
  const glyphs = {}; let width = 0, height = 0;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (!parts[0]) continue;
    if (parts[0] === 'width') { width = +parts[1]; continue; }
    if (parts[0] === 'height') { height = +parts[1]; continue; }
    if (parts.length < 4) continue;
    glyphs[parts[0] === 'space' ? ' ' : parts[0]] = [+parts[1], +parts[2], +parts[3]];
  }
  return { cell_w: width, cell_h: height, glyphs };
}

async function loadAssets(source) {
  if (typeof source === 'string' || !source) source = bundleSource(source);
  const m = await source.manifest();
  const fresh = { manifest: m, portraits: {}, backgrounds: {}, fonts: {}, fontCache: {}, ui: {}, units: {}, source, looks: m.looks || [] };
  const bundle = source.kind === 'bundle' ? source : bundleSource(ASSET_BASE);
  const jobs = [];
  for (const p of m.portraits) jobs.push(loadImage(source.url('portrait', p.nid)).then(img => {
    if (!p.full_size && img.width === 128 && img.height === 112) img = legacyPortrait(img);
    fresh.portraits[p.nid] = { meta: portraitMeta(p), img: colorKey(img) };
  }).catch(() => {}));
  for (const b of m.backgrounds) jobs.push(loadImage(source.url('bg', b)).then(img => { fresh.backgrounds[b] = img; }).catch(() => {}));
  const fonts = m.fonts || { convo: m.font };
  for (const [nid, f] of Object.entries(fonts)) {
    const url = source.url('font', nid) || bundle.url('font', nid);
    jobs.push(loadImage(url).then(img => { fresh.fonts[nid] = { img, ...f }; }).catch(() => {}));
  }
  for (const u of UI_SPRITES)
    jobs.push(loadImage(source.url('ui', u) || bundle.url('ui', u)).then(img => { fresh.ui[u] = img; }).catch(() => {}));
  for (const u of m.units || []) fresh.units[u.nid] = u;
  await Promise.all(jobs);
  if (!Object.keys(fresh.fonts).length) throw new Error('No conversation font found');
  if (A.source && A.source !== source && A.source.release) A.source.release();
  Object.assign(A, fresh);
  if (typeof voices !== 'undefined') voices.reset();
  return m;
}

// Portrait sheet layout. Projects saved by older LT versions only store the
// offsets; the rest are LT's defaults (app/data/resources/portraits.py).
const PORTRAIT_DEFAULTS = { full_size: [160, 112], face_size: [96, 80], blink_size: [32, 16], mouth_size: [32, 16],
  blink_frames: 2, mouth_frames: 3, blinking_offset: [24, 32], smiling_offset: [16, 48] };
// Projects saved before LT's serialization version 1 keep portraits in the
// old 128x112 sheet layout. LT rearranges those sheets when it upgrades the
// project (migrator0.py); the preview does the same rearrangement in memory.
function legacyPortrait(img) {
  const c = document.createElement('canvas'); c.width = 160; c.height = 112;
  const g = c.getContext('2d');
  g.fillStyle = `rgb(${COLORKEY.join(',')})`; g.fillRect(0, 0, 160, 112);
  g.drawImage(img, 0, 0, 96, 80, 32, 0, 96, 80);      // face
  g.drawImage(img, 96, 48, 32, 32, 128, 48, 32, 32);  // blink frames
  g.drawImage(img, 0, 80, 128, 32, 0, 80, 128, 32);   // mouth frames
  g.drawImage(img, 96, 16, 32, 32, 128, 80, 32, 32);  // minimug
  return c;
}
function portraitMeta(p) {
  const m = { ...PORTRAIT_DEFAULTS, ...p };
  if (!m.blink_frames) m.blink_frames = 2;
  if (!m.mouth_frames) m.mouth_frames = 3;
  return m;
}

// Units: LT lets events name a unit (add_portrait;Dito) or a portrait
// directly. A unit's own portrait and display name win, as in game.
function unitFor(nid) { const k = ciFind(A.units, nid); return k ? A.units[k] : null; }

// "Looks": what the project's own events do when a variable has a value,
// e.g. YuelSetup's  if YuelGender == 'Female': change_portrait;Yuel;...,
// set_unit_field;Yuel;voice_pitch;3, game_var;YuelHe;she. The preview
// applies them when that value is chosen under "Preview as".
function looksFromEvents(events) {
  const out = [];
  for (const e of events) {
    const src = Array.isArray(e._source) ? e._source : String(e._source || e.source || '').split('\n');
    const stack = [];   // per open if: { seen: [conditions so far], cur: condition in force or null }
    const choices = {};  // choice nid -> its options, to work out what an "else" means
    const cur = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].cur) return stack[i].cur; return null; };
    for (const raw of src) {
      const c = parseLine(raw, 0); if (!c) continue;
      const cond = s => { const p = parseCond(s); return p.type === 'var' && p.op === '==' ? { name: p.name, value: p.value } : null; };
      const rest = () => c.raw.slice(c.raw.indexOf(';') + 1);
      if (c.name === 'choice' && c.args[0]) { choices[c.args[0]] = String(c.args[2] || '').split(',').map(x => x.trim()).filter(Boolean); continue; }
      if (c.name === 'if') { const w = cond(rest()); stack.push({ seen: [w], cur: w }); continue; }
      if (c.name === 'elif' && stack.length) { const w = cond(rest()); const t = stack[stack.length - 1]; t.seen.push(w); t.cur = w; continue; }
      if (c.name === 'else' && stack.length) {
        // "else" after tests of one choice's answers = the one answer left
        const t = stack[stack.length - 1];
        const name = t.seen[0] && t.seen[0].name;
        const opts = name && choices[name];
        const left = opts && t.seen.every(w => w && w.name === name) ? opts.filter(o => !t.seen.some(w => w.value === o)) : [];
        t.cur = left.length === 1 ? { name, value: left[0] } : null;
        continue;
      }
      if (c.name === 'end') { stack.pop(); continue; }
      const when = cur(); if (!when) continue;
      const add = (unit, what) => out.push({ var: when.name, value: when.value, unit: unit || null, ...what });
      if (c.name === 'change_portrait' && c.args[0] && c.args[1]) add(c.args[0], { portrait: c.args[1] });
      else if (c.name === 'set_unit_field' && c.args[0] && c.args[1]) add(c.args[0], { field: [c.args[1], c.args[2] || ''] });
      else if (c.name === 'game_var' && c.args[0]) add(null, { setVar: [c.args[0], pyValue(c.args[1] || '')] });
    }
  }
  return out;
}
// game_var's value is a Python expression: 'she' is the text she
function pyValue(expr) {
  const m = String(expr).trim().match(/^(['"])(.*)\1$/);
  return m ? m[2] : String(expr).trim();
}
function activeLooks(unitNid) {
  return (A.looks || []).filter(l => PREVIEW_VARS[l.var] != null && String(PREVIEW_VARS[l.var]) === l.value &&
    (unitNid === undefined || (l.unit && String(l.unit).toLowerCase() === String(unitNid).toLowerCase())));
}
// Variables the looks set (pronouns etc.), for {v:...} in lines
function lookVars() { const v = {}; for (const l of activeLooks()) if (l.setVar) v[l.setVar[0]] = l.setVar[1]; return v; }
function substituteVars(text, vars) {
  return String(text).replace(/\{(?:v|var):([^{}]*)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}
function portraitKeyFor(nid) {
  if (!nid) return null;
  for (const l of activeLooks(unitFor(nid) ? unitFor(nid).nid : nid)) if (l.portrait) { const k = ciFind(A.portraits, l.portrait); if (k) return k; }
  const u = unitFor(nid);
  if (u && u.portrait) { const k = ciFind(A.portraits, u.portrait); if (k) return k; }
  return ciFind(A.portraits, nid);
}
function portraitFor(nid) { const k = portraitKeyFor(nid); return k ? A.portraits[k] : null; }
function displayName(nid) { const u = unitFor(nid); return u && u.name ? u.name : String(nid || '').replace(/_/g, ' '); }

// LT draws portraits with a colour key: this exact green is transparent in game.
const COLORKEY = [128, 160, 128];
function colorKey(img) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
  for (let i = 0; i < px.length; i += 4) if (px[i] === COLORKEY[0] && px[i + 1] === COLORKEY[1] && px[i + 2] === COLORKEY[2]) px[i + 3] = 0;
  g.putImageData(d, 0, 0);
  return c;
}
function ciFind(dict, name) {
  if (!name) return null;
  if (dict[name]) return name;
  const low = String(name).toLowerCase();
  return Object.keys(dict).find(k => k.toLowerCase() === low) || null;
}
function ciIn(list, name) { const low = String(name || '').toLowerCase(); return list.find(n => n.toLowerCase() === low) || null; }

// ---------------------------------------------------------------------------
// Bitmap fonts (LT .idx format: glyph -> [col, row, width]) with palette swaps
// ---------------------------------------------------------------------------
function fontColors(fontNid) {
  const f = A.fonts[fontNid] || A.fonts.convo;
  return f ? Object.keys(f.palettes || {}) : [];
}
function isColor(name, fontNid) { return fontColors(fontNid).includes(name) || name in EXTRA_PALETTES; }
function fontImage(fontNid, color) {
  const f = A.fonts[fontNid] || A.fonts.convo; if (!f) return null;
  const key = (A.fonts[fontNid] ? fontNid : 'convo') + '|' + (color || '');
  if (A.fontCache[key]) return A.fontCache[key];
  const src = f.palettes && f.palettes[f.default_color];
  const dst = color && ((f.palettes && f.palettes[color]) || EXTRA_PALETTES[color]);
  let out = f.img;
  if (src && dst && color !== f.default_color) {
    const c = document.createElement('canvas'); c.width = f.img.width; c.height = f.img.height;
    const g = c.getContext('2d'); g.drawImage(f.img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      for (let k = 0; k < src.length; k++) {
        if (px[i] === src[k][0] && px[i + 1] === src[k][1] && px[i + 2] === src[k][2] && dst[k]) { px[i] = dst[k][0]; px[i + 1] = dst[k][1]; px[i + 2] = dst[k][2]; break; }
      }
    }
    g.putImageData(d, 0, 0); out = c;
  }
  return (A.fontCache[key] = out);
}
function glyphOf(fontNid, ch) { const f = A.fonts[fontNid] || A.fonts.convo; return f && f.glyphs[ch]; }
function charWidth(ch, fontNid) { const g = glyphOf(fontNid || 'convo', ch); return g ? g[2] : 0; }
function textWidth(s, fontNid) { let w = 0; for (const ch of s) w += charWidth(ch, fontNid); return w; }
function drawGlyph(ctx, fontNid, color, ch, x, y) {
  const f = A.fonts[fontNid] || A.fonts.convo; if (!f) return 0;
  const g = f.glyphs[ch]; if (!g) return 0;
  ctx.drawImage(fontImage(fontNid, color), g[0] * f.cell_w, g[1] * f.cell_h, g[2], f.cell_h, x, y, g[2], f.cell_h);
  return g[2];
}
function drawText(ctx, s, x, y, fontNid, color) { for (const ch of s) x += drawGlyph(ctx, fontNid || 'convo', color, ch, x, y); }
function missingGlyphs(s, fontNid) {
  const out = new Set();
  for (const ch of s) if (!glyphOf(fontNid || 'convo', ch) && ch !== '\n') out.add(ch);
  return [...out];
}

// 9-slice box like LT's create_base_surf (8px slices)
function drawNineSlice(ctx, img, x, y, w, h) {
  const s = 8, bw = img.width, bh = img.height;
  w -= w % s; h -= h % s;
  for (let yy = 0; yy < h; yy += s) {
    for (let xx = 0; xx < w; xx += s) {
      const sx = xx === 0 ? 0 : (xx + s >= w ? bw - s : s);
      const sy = yy === 0 ? 0 : (yy + s >= h ? bh - s : s);
      ctx.drawImage(img, sx, sy, s, s, x + xx, y + yy, s, s);
    }
  }
  return [w, h];
}

// ---------------------------------------------------------------------------
// Styled text: LT's inline tags and dialog commands
//   <red>word</>  colour     <iconvo>word</>  font     <wave>word</>  effect
//   {w} wait for a click    {br} new line    {clear} empty the box    | = {w}{br}
// ---------------------------------------------------------------------------
const TAG_SPLIT = /(<[^<>]*>|\{[^{}]*\})/;
function styleText(text, baseFont, baseColor) {
  text = String(text || '').replace(/\|/g, '{w}{br}');
  const toks = text.split(TAG_SPLIT).filter(Boolean);
  const stack = [];
  const cur = () => stack.length ? stack[stack.length - 1] : { font: baseFont || 'convo', color: baseColor || null, fx: null };
  const out = [];
  for (const t of toks) {
    if (t[0] === '<' && t.endsWith('>')) {
      const body = t.slice(1, -1).trim();
      if (body.startsWith('/')) { stack.pop(); continue; }
      const id = body.split(/\s+/)[0];
      const c = { ...cur() };
      if (A.fonts[id] || /^[bin]?convo$/.test(id)) c.font = id;
      else if (isColor(id, c.font)) c.color = id;
      else if (TEXT_FX.has(id)) c.fx = id;
      else { for (const ch of t) out.push({ ch, ...cur() }); continue; }
      stack.push(c); continue;
    }
    if (t[0] === '{' && t.endsWith('}')) {
      const cmd = t.slice(1, -1);
      if (cmd === 'w' || cmd === 'wait') out.push({ cmd: 'w' });
      else if (cmd === 'br' || cmd === 'break' || cmd === 'sub_break') out.push({ cmd: 'br' });
      else if (cmd === 'clear') out.push({ cmd: 'clear' });
      else if (cmd === 'p') out.push({ cmd: 'p' });
      continue;
    }
    for (const ch of t) { const s = cur(); out.push({ ch, font: s.font, color: s.color, fx: s.fx }); }
  }
  return out;
}
function glyphW(it) { return charWidth(it.ch, it.font); }
// Word-wraps styled items the way LT's dialog does (break at spaces when the
// next word would overflow). Returns a typing sequence.
function layoutText(items, maxW) {
  const seq = []; let line = 0, x = 0, pendingSpace = null;
  const newLine = () => { line++; x = 0; pendingSpace = null; };
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (it.cmd) {
      if (it.cmd === 'br') newLine();
      else if (it.cmd === 'clear') { newLine(); seq.push({ type: 'clear', line }); }
      else seq.push({ type: it.cmd });
      i++; continue;
    }
    if (it.ch === ' ') { if (!pendingSpace) pendingSpace = it; i++; continue; }
    let j = i, ww = 0;
    while (j < items.length && !items[j].cmd && items[j].ch !== ' ') { ww += glyphW(items[j]); j++; }
    const sw = pendingSpace ? glyphW(pendingSpace) : 0;
    if (x > 0 && x + sw + ww > maxW) newLine();
    else if (pendingSpace && x > 0) { seq.push({ type: 'ch', it: pendingSpace, line, x }); x += sw; }
    pendingSpace = null;
    for (let k = i; k < j; k++) { seq.push({ type: 'ch', it: items[k], line, x, n: k }); x += glyphW(items[k]); }
    i = j;
  }
  const widths = [];
  for (const s of seq) if (s.type === 'ch') widths[s.line] = Math.max(widths[s.line] || 0, s.x + glyphW(s.it));
  return { seq, lines: line + 1, widest: Math.max(8, ...widths.filter(v => v != null)) };
}

// ---------------------------------------------------------------------------
// Script parsing
// ---------------------------------------------------------------------------
function normalizeQuotes(s) {
  return s.replace(/[‘’′]/g, "'").replace(/[“”″]/g, '"').replace(/…/g, '...')
    .replace(/[–—]/g, '-').replace(/ /g, ' ');
}
function parseLine(raw, i) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) return null;
  const parts = line.split(';');
  const alias = parts[0].trim();
  const name = ALIASES[alias] || alias;
  const args = [], kw = {}, flags = new Set();
  for (const p of parts.slice(1)) {
    const t = p.trim();
    if (t === '') { args.push(''); continue; }
    const m = t.match(/^([A-Za-z][A-Za-z0-9_]*)=(.*)$/);
    if (m) { kw[m[1]] = m[2]; continue; }
    if (FLAGS.has(t)) { flags.add(t); continue; }
    args.push(t);
  }
  while (args.length && args[args.length - 1] === '') args.pop();
  return { line: i, name, alias, args, kw, flags, raw: line };
}
function parseScript(src) {
  const cmds = [];
  src.split(/\r?\n/).forEach((raw, i) => { const c = parseLine(raw, i); if (c) cmds.push(c); });
  return cmds;
}

// ---------------------------------------------------------------------------
// Branches: LT's if / elif / else / end blocks (event_processor.py), and
// choice menus. Shared by the builder (steps) and the player (commands).
// kindAt(i) -> 'if' | 'elif' | 'else' | 'end' | null. A top-level 'end' is
// not part of a branch (LT skips it; the builder uses it as "End").
// ---------------------------------------------------------------------------
function analyzeFlow(n, kindAt) {
  const blocks = [], byStart = new Map(), owner = new Array(n).fill(null), errors = [];
  const stack = [];
  for (let i = 0; i < n; i++) {
    const k = kindAt(i);
    if (k === 'if') {
      const b = { start: i, heads: [i], end: null, parent: stack[stack.length - 1] || null, depth: stack.length, hasElse: false };
      stack.push(b); blocks.push(b); byStart.set(i, b); owner[i] = b;
    } else if (k === 'elif' || k === 'else') {
      const b = stack[stack.length - 1];
      if (!b) { errors.push({ i, msg: `“${k === 'elif' ? 'Or if' : 'Otherwise'}” has no branch to belong to.` }); continue; }
      if (b.hasElse) errors.push({ i, msg: 'Nothing can follow “Otherwise” in the same branch.' });
      if (k === 'else') b.hasElse = true;
      b.heads.push(i); owner[i] = b;
    } else if (k === 'end' && stack.length) {
      const b = stack.pop(); b.end = i; owner[i] = b;
    }
  }
  for (const b of stack) errors.push({ i: b.start, msg: 'This branch never rejoins (it needs a Rejoin step).' });
  for (const b of blocks) {
    const stop = b.end == null ? n : b.end;
    b.arms = b.heads.map((h, a) => ({ head: h, from: h + 1, to: (a + 1 < b.heads.length ? b.heads[a + 1] : stop) - 1 }));
  }
  return { blocks, byStart, owner, errors, n };
}
// Innermost first: [{block, arm}] for every branch whose arm holds index i
// (an arm's head counts as inside it).
function armsHolding(flow, i) {
  const out = [];
  for (const b of flow.blocks) b.arms.forEach((a, k) => { if (i >= a.head && i <= a.to) out.push({ block: b, arm: k }); });
  return out.sort((x, y) => y.block.depth - x.block.depth);
}

// Conditions the preview understands. Anything else is "custom": the
// preview asks which way to go instead of guessing.
function parseCond(cond) {
  const c = String(cond || '').trim();
  let m = c.match(/^game\.(game_vars|level_vars)(?:\.get\(\s*(['"])(.*?)\2\s*\)|\[\s*(['"])(.*?)\4\s*\])\s*(==|!=)\s*(['"])(.*?)\7$/);
  if (m) return { type: 'var', scope: m[1], name: m[3] != null ? m[3] : m[5], op: m[6], value: m[8] };
  m = c.match(/^game\.check_(alive|dead)\(\s*(['"])(.*?)\2\s*\)$/);
  if (m) return { type: m[1], who: m[3] };
  if (c === 'True' || c === 'False') return { type: 'const', value: c === 'True' };
  return { type: 'custom', text: c };
}
function condFor(name, value, op) {
  const q = v => "'" + String(v).replace(/'/g, "\\'") + "'";
  return `game.game_vars.get(${q(name)}) ${op || '=='} ${q(value)}`;
}
// true / false / null (the preview can't tell)
function evalCond(cond, vars) {
  const p = parseCond(cond);
  vars = vars || {};
  if (p.type === 'const') return p.value;
  if (p.type === 'var') { if (!(p.name in vars)) return null; const eq = String(vars[p.name]) === p.value; return p.op === '==' ? eq : !eq; }
  if (p.type === 'alive' || p.type === 'dead') { const alive = vars['alive:' + p.who] !== false; return p.type === 'alive' ? alive : !alive; }
  return null;
}
// Which arm runs: the first whose condition is true; an arm the preview
// can't judge counts as taken unless `unknownPick` says otherwise.
// -1 = none (no Otherwise).
function decideArm(conds, hasElse, vars, unknownPick) {
  for (let a = 0; a < conds.length; a++) {
    if (a === conds.length - 1 && hasElse) return a;
    const r = evalCond(conds[a], vars);
    if (r === true) return a;
    if (r === null) { if (unknownPick == null || unknownPick === a) return a; }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Portraits
// ---------------------------------------------------------------------------
function parsePosition(pos) {
  pos = (pos || 'Left').trim();
  let x = 0, y = VPOS.Bottom;
  const pix = pos.match(/^\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?$/);
  if (pix) { x = +pix[1]; y = +pix[2]; }
  else {
    for (const p of pos.split(',').map(s => s.trim())) {
      if (p in HPOS) x = HPOS[p];
      else if (p in VPOS) y = VPOS[p];
    }
  }
  return { x, y, mirror: x <= HPOS.CenterLeft };
}
class Portrait {
  constructor(nid, pos, opts) {
    this.nid = nid;
    this.asset = portraitFor(nid);
    const p = parsePosition(pos);
    this.x = p.x; this.y = p.y; this.tx = p.x; this.ty = p.y;
    this.mirror = opts.mirror ? !p.mirror : p.mirror;
    this.alpha = opts.immediate ? 1 : 0;
    this.fade = opts.immediate ? 0 : 1;           // +1 fading in, -1 fading out
    this.fadeMs = 233 / (opts.speed || 1);
    this.slide = opts.slide || null;               // LT: slides 24px while fading
    this.expr = new Set(opts.expressions || []);
    this.talking = false; this.talkState = 0; this.nextTalk = 0; this.reverse = false;
    this.nextBlink = performance.now() + 2000 + Math.random() * 5000; this.blinkIdx = -1; this.blinkUntil = 0;
    this.bops = 0; this.bopTime = 132; this.lastBop = 0; this.bopUp = false;
    this.moveSpeed = 0.25;
    this.gray = !!opts.gray; this.low = !!opts.low;
    this.removing = false;
    this.buf = document.createElement('canvas'); this.buf.width = 96; this.buf.height = 80;
  }
  get busy() { return this.fade !== 0 || this.x !== this.tx || this.y !== this.ty || this.bops > 0; }
  settle() { this.alpha = this.fade < 0 ? 0 : 1; this.fade = 0; this.x = this.tx; this.y = this.ty; this.bops = 0; }
  update(now, dt) {
    if (this.fade) {
      this.alpha += this.fade * dt / this.fadeMs;
      if (this.alpha >= 1) { this.alpha = 1; this.fade = 0; }
      if (this.alpha <= 0) { this.alpha = 0; this.fade = 0; }
    }
    for (const k of ['x', 'y']) {
      const t = k === 'x' ? this.tx : this.ty;
      if (this[k] !== t) {
        const step = this.moveSpeed * dt;
        this[k] = Math.abs(t - this[k]) <= step ? t : this[k] + Math.sign(t - this[k]) * step;
      }
    }
    if (this.bops > 0 && now - this.lastBop > this.bopTime) { this.lastBop = now; this.bopUp = !this.bopUp; if (!this.bopUp) this.bops--; }
    const mf = this.asset ? this.asset.meta.mouth_frames : 3;
    if (this.talking && now > this.nextTalk) {
      // same random walk as LT's update_talk
      if (this.talkState === 0 || this.talkState === mf - 1) { this.reverse = !this.reverse; this.nextTalk = now + 70 + Math.random() * 90; }
      else { this.nextTalk = now + 30 + Math.random() * 20; if (Math.random() < 0.1) this.reverse = !this.reverse; }
      const mt = Math.random() < 0.1 ? 2 : 1;
      this.talkState = Math.max(0, Math.min(mf - 1, this.talkState + (this.reverse ? -mt : mt)));
    }
    if (!this.talking) { this.talkState = 0; this.reverse = false; }
    const bf = this.asset ? this.asset.meta.blink_frames : 2;
    if (now > this.nextBlink && this.blinkIdx < 0) { this.blinkIdx = 0; this.blinkUntil = now + 50; }
    if (this.blinkIdx >= 0 && now > this.blinkUntil) {
      this.blinkIdx++; this.blinkUntil = now + 50;
      if (this.blinkIdx >= bf * 2) { this.blinkIdx = -1; this.nextBlink = now + 5000 + Math.random() * 4000; }
    }
  }
  compose() { composeFace(this.buf, this.asset, this.nid, this.expr, this.blinkIdx, this.talkState); }
  draw(ctx) {
    if (this.alpha <= 0) return;
    this.compose();
    ctx.save();
    ctx.globalAlpha = this.alpha;
    if (this.gray) ctx.filter = 'saturate(0.2) brightness(0.85)';
    const bop = this.bops > 0 && this.bopUp ? -2 : 0;
    let x = Math.round(this.x);
    if (this.slide && this.alpha < 1) x += Math.round((this.slide === 'right' ? 24 : -24) * (1 - this.alpha));
    const y = Math.round(this.y) + bop;
    const w = this.buf.width;
    if (this.mirror) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.drawImage(this.buf, 0, 0); }
    else ctx.drawImage(this.buf, x, y);
    ctx.restore();
  }
  get width() { return this.buf.width; }
}
// Composes an LT portrait sheet into a face with the given expression.
function composeFace(buf, asset, nid, expr, blinkIdx, talkState) {
  const b = buf.getContext('2d');
  if (!asset) {
    buf.width = 96; buf.height = 80;
    b.fillStyle = '#3b3431'; b.fillRect(8, 8, 80, 72);
    b.fillStyle = '#e8ddd4'; b.font = '10px monospace'; b.textAlign = 'center';
    b.fillText('no portrait', 48, 40); b.fillText(String(nid).slice(0, 14), 48, 54);
    return;
  }
  const m = asset.meta, img = asset.img;
  const [fw, fh] = m.full_size, [w, h] = m.face_size, [bw, bh] = m.blink_size, [mw, mh] = m.mouth_size;
  buf.width = w; buf.height = h;
  b.clearRect(0, 0, w, h);
  b.drawImage(img, fw - w - bw, fh - h - mh * 2, w, h, 0, 0, w, h);
  let bi = null, clip = null;
  if (expr.has('CloseEyes')) bi = m.blink_frames - 1;
  else if (expr.has('HalfCloseEyes')) bi = Math.max(0, (m.blink_frames >> 1) - 1);
  else if (expr.has('LeftWink') || expr.has('RightWink')) { bi = m.blink_frames - 1; clip = expr.has('LeftWink') ? 'left' : 'right'; }
  else if (!expr.has('OpenEyes') && blinkIdx >= 0) {
    const seq = blinkIdx < m.blink_frames ? blinkIdx : (m.blink_frames * 2 - 1 - blinkIdx);
    bi = Math.max(0, Math.min(m.blink_frames - 1, seq));
  }
  if (bi !== null) {
    const sx = fw - bw, sy = fh - mh * 2 - bh * (m.blink_frames - bi);
    const half = bw >> 1;
    if (clip === 'left') b.drawImage(img, sx, sy, half, bh, m.blinking_offset[0], m.blinking_offset[1], half, bh);
    else if (clip === 'right') b.drawImage(img, sx + half, sy, bw - half, bh, m.blinking_offset[0] + half, m.blinking_offset[1], bw - half, bh);
    else b.drawImage(img, sx, sy, bw, bh, m.blinking_offset[0], m.blinking_offset[1], bw, bh);
  }
  const idx = expr.has('OpenMouth') ? m.mouth_frames - 1 : talkState;
  const smile = expr.has('Smile');
  b.drawImage(img, fw - bw - mw * (idx + 2), fh - mh * (smile ? 2 : 1), mw, mh, m.smiling_offset[0], m.smiling_offset[1], mw, mh);
}

// ---------------------------------------------------------------------------
// Dialog box (LT's Dialog: auto-sized bubble above the speaker, 2 lines,
// scrolls, waits at {w} and |)
// ---------------------------------------------------------------------------
function desiredCenter(x) {
  if (x < 48) return 8; if (x < 72) return 80; if (x < 104) return 104;
  if (x > W - 48) return W - 8; if (x > W - 72) return W - 88; if (x > W - 144) return W - 112; return W >> 1;
}
class Dialog {
  constructor(speaker, text, portrait, opts) {
    this.speaker = speaker; this.portrait = portrait; this.opts = opts;
    this.style = opts.style || '';
    this.numLines = opts.numLines || 2;
    const narration = this.style === 'narration' || this.style === 'narration_top';
    const baseColor = opts.color || (narration ? 'white' : null);
    this.items = styleText(text, opts.font || 'convo', baseColor);
    const maxText = narration ? W - 24 : (portrait ? 208 : W - 24);
    this.layout = layoutText(this.items, maxText);
    if (narration) { this.w = W - 8; this.x = 4; this.y = this.style === 'narration' ? 110 : 2; this.h = this.numLines * 16 + 16; }
    else {
      this.w = portrait ? Math.min(W - 8, Math.ceil((this.layout.widest + 16) / 8) * 8 + 8) : W - 8;
      this.h = this.numLines * 16 + 16;
      if (portrait) {
        if (this.w >= W - 8) this.x = 4;
        else {
          const c = desiredCenter(portrait.x + portrait.width / 2);
          this.x = Math.max(8, Math.min(W - 8 - this.w, c - (this.w >> 1)));
          if (this.x % 8) this.x += 4;
        }
        this.y = Math.max(H - this.h - 80 - 4, 4);
      } else { this.x = 4; this.y = H - this.h - 4; }
    }
    this.p = 0; this.top = 0; this.clearLine = 0; this.state = 'typing'; this.hold = opts.hold;
    this.speed = 40 * (opts.speed || 1); // characters per second
    this.acc = 0; this.pauseUntil = 0;
  }
  get seq() { return this.layout.seq; }
  curLine() { for (let i = this.p - 1; i >= 0; i--) if (this.seq[i].type === 'ch') return this.seq[i].line; return this.clearLine; }
  step(onChar, fast) {
    // reveal one item; returns false when typing must stop
    const s = this.seq[this.p];
    if (!s) { this.state = 'waiting'; return false; }
    if (s.type === 'w') { this.state = 'waiting'; this.atWait = true; return false; }
    this.p++;
    if (s.type === 'clear') { this.clearLine = s.line; return true; }
    if (s.type === 'p') { if (fast) return true; this.pauseUntil = performance.now() + 400; return false; }
    if (s.type === 'ch') { onChar && s.it.ch !== ' ' && onChar(); if (/[.,;!?]/.test(s.it.ch)) this.pauseUntil = performance.now() + 120; }
    return true;
  }
  update(dt, onChar) {
    if (this.state !== 'typing') return;
    if (performance.now() < this.pauseUntil) return;
    this.acc += dt * this.speed / 1000;
    while (this.acc >= 1 && this.state === 'typing') { this.acc -= 1; if (!this.step(onChar)) break; }
  }
  finishPage() { while (this.state === 'typing' && this.step(null, true)) { /* reveal until the next wait */ } if (this.state === 'typing') this.state = 'waiting'; this.pauseUntil = 0; }
  finishAll() { // show the whole line at once (used by the still preview)
    this.p = this.seq.length; this.state = 'waiting'; this.atWait = false;
    for (const s of this.seq) if (s.type === 'clear') this.clearLine = s.line;
  }
  advance() {
    if (this.state === 'typing') { this.finishPage(); return false; }
    if (this.atWait) { this.atWait = false; this.p++; this.state = 'typing'; return false; }
    this.state = 'done'; return true;
  }
  draw(ctx, now) {
    const narration = this.style === 'narration' || this.style === 'narration_top';
    const bg = narration ? A.ui.menu_bg_base : A.ui.message_bg_base;
    if (bg) { ctx.save(); ctx.globalAlpha = 0.95; drawNineSlice(ctx, bg, this.x, this.y, this.w, this.h); ctx.restore(); }
    // tail pointing at the speaker (thought bubbles use LT's thought tail)
    const tail = this.style === 'thought_bubble' ? A.ui.message_bg_thought_tail : A.ui.message_bg_tail;
    if (!narration && this.portrait && tail) {
      const px = this.portrait.x + this.portrait.width / 2;
      const mirrorX = px < W / 2;
      let tx = mirrorX ? px + 20 : px - 36;
      if (tx > this.x + this.w - 24) tx = this.x + this.w - 24; else if (tx < this.x + 8) tx = this.x + 8;
      ctx.save();
      const ty = this.y + this.h - 2;
      if (mirrorX) { ctx.translate(Math.round(tx) + tail.width, ty); ctx.scale(-1, 1); ctx.drawImage(tail, 0, 0); }
      else ctx.drawImage(tail, Math.round(tx), ty);
      ctx.restore();
    }
    if (!narration && this.speaker && A.ui.name_tag) {
      const ny = this.y < 10 ? this.y + this.h - 6 : this.y - 10;
      let nx = this.x - 4; if (nx < 0) nx = this.x + 16;
      drawNineSlice(ctx, A.ui.name_tag, nx, ny, 64, 16);
      const name = displayName(this.speaker);
      drawText(ctx, name, nx + 32 - (textWidth(name) >> 1), ny);
    }
    // text: the last numLines lines typed so far
    const cur = this.curLine();
    const top = Math.max(this.clearLine, cur - this.numLines + 1);
    for (let i = 0; i < this.p; i++) {
      const s = this.seq[i]; if (s.type !== 'ch' || s.line < top || s.line >= top + this.numLines || s.line < this.clearLine) continue;
      let dx = 0, dy = 0;
      const fx = s.it.fx;
      if (fx === 'wave' || fx === 'wave2' || fx === 'sin') dy = Math.round(Math.sin(now / 160 + (s.n || 0) * 0.8) * 2);
      if (fx === 'wave2') dx = Math.round(Math.cos(now / 160 + (s.n || 0) * 0.8));
      if (fx === 'jitter' || fx === 'jitter2') { const t = Math.floor(now / 50) + (s.n || 0) * 7; dx = (t * 13 % 3) - 1; dy = (t * 7 % 3) - 1; }
      drawGlyph(ctx, s.it.font, s.it.color, s.it.ch, this.x + 8 + s.x + dx, this.y + 8 + (s.line - top) * 16 + dy);
    }
    if (this.state === 'waiting' && Math.floor(now / 300) % 2 === 0) {
      ctx.fillStyle = narration ? '#f8f8f8' : '#383838';
      const cx = this.x + this.w - 14, cy = this.y + this.h - 12;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + 6, cy); ctx.lineTo(cx + 3, cy + 4); ctx.closePath(); ctx.fill();
    }
  }
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------
const audio = {
  music: null, musicNid: null, musicTarget: 0, musicFadeMs: 400, musicStopAfterFade: false, level: 0,
  musicVol: 0.7, sfxVol: 0.8, musicScale: 1,
  trackVolume(nid) { const v = A.manifest && A.manifest.musicVolume; const k = nid && v ? ciFind(v, nid) : null; return k ? v[k] : 1; },
  // vol: the music command's Volume= (on top of the track's own volume)
  playMusic(nid, fadeIn, vol) {
    const key = ciIn(A.manifest.music, nid);
    this.stopMusic(0);
    if (!key) return false;
    this.musicScale = this.trackVolume(key) * (vol == null || !isFinite(+vol) ? 1 : Math.max(0, Math.min(1, +vol)));
    const el = new Audio(A.source.url('music', key));
    el.loop = true; el.volume = 0; el.play().catch(() => {});
    this.music = el; this.musicNid = key; this.level = 0; this.musicTarget = 1; this.musicFadeMs = Math.max(1, fadeIn || 400);
    this.musicStopAfterFade = false;
    return true;
  },
  stopMusic(fadeOut) {
    if (!this.music) return;
    if (!fadeOut) { this.music.pause(); this.music = null; this.musicNid = null; return; }
    this.musicTarget = 0; this.musicFadeMs = fadeOut; this.musicStopAfterFade = true;
  },
  playSfx(nid, vol) {
    const key = ciIn(A.manifest.sfx, nid);
    if (!key) return false;
    const el = new Audio(A.source.url('sfx', key));
    el.volume = Math.max(0, Math.min(1, this.sfxVol * (vol == null ? 1 : vol))); el.play().catch(() => {});
    return true;
  },
  update(dt) {
    if (!this.music) return;
    if (this.level !== this.musicTarget) {
      const step = dt / this.musicFadeMs;
      this.level = this.musicTarget > this.level ? Math.min(this.musicTarget, this.level + step) : Math.max(this.musicTarget, this.level - step);
      if (this.level === 0 && this.musicStopAfterFade) { this.music.pause(); this.music = null; this.musicNid = null; return; }
    }
    this.music.volume = Math.max(0, Math.min(1, this.level * this.musicVol * this.musicScale));
  },
  stopAll() { if (this.music) this.music.pause(); this.music = null; this.musicNid = null; }
};
let ASSET_BASE = 'assets/';

// ---------------------------------------------------------------------------
// Character voices: the typing boop, per character. Same fields and maths as
// the game (app/utilities/voice.py): voice_volume 0..200 (%), voice_pitch
// -12..12 semitones (higher is also shorter), voice_tone -10..10 (dark to
// bright), voice_sound (a different base sound).
// ---------------------------------------------------------------------------
const VOICE_DARK_HZ = 700, VOICE_BRIGHT_HZ = 1800, VOICE_BRIGHT_GAIN = 1.5;
const clampN = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
function voiceFor(nid) {
  const u = unitFor(nid); if (!u || !u.fields) return null;
  const f = {}; for (const pair of u.fields) if (pair && pair.length >= 2) f[pair[0]] = pair[1];
  for (const l of activeLooks(u.nid)) if (l.field) f[l.field[0]] = l.field[1];
  const keys = ['voice_volume', 'voice_pitch', 'voice_tone', 'voice_sound'];
  if (keys.every(k => f[k] == null || String(f[k]).trim() === '')) return null;
  const num = (k, d) => { const x = parseFloat(f[k]); return Number.isFinite(x) ? x : d; };
  return { volume: Math.round(clampN(num('voice_volume', 100), 0, 200)), pitch: Math.round(clampN(num('voice_pitch', 0), -12, 12) * 10) / 10,
    tone: Math.round(clampN(num('voice_tone', 0), -10, 10) * 10) / 10, sound: (f.voice_sound || '').trim() || null };
}
const voiceChanges = v => !!v && (v.volume !== 100 || v.pitch !== 0 || v.tone !== 0);
function voiceProcess(channels, rate, v) {
  const ratio = Math.pow(2, v.pitch / 12);
  const lowpass = (s, hz) => { const a = 1 - Math.exp(-2 * Math.PI * hz / rate); const o = new Float32Array(s.length); let y = 0; for (let i = 0; i < s.length; i++) { y += a * (s[i] - y); o[i] = y; } return o; };
  const peakOf = s => { let p = 0; for (const x of s) p = Math.max(p, Math.abs(x)); return p || 1; };
  return channels.map(src => {
    let s = src;
    if (ratio !== 1 && src.length >= 2) {           // resample: higher and shorter
      const n = src.length, len = Math.max(1, Math.floor(n / ratio)), o = new Float32Array(len);
      for (let i = 0; i < len; i++) { const pos = i * ratio, j = Math.floor(pos); o[i] = j >= n - 1 ? src[n - 1] : src[j] + (src[j + 1] - src[j]) * (pos - j); }
      s = o;
    }
    if (v.tone !== 0 && s.length) {
      const peak = peakOf(s);
      if (v.tone < 0) {
        const amt = -v.tone / 10, lp = lowpass(s, VOICE_DARK_HZ), o = new Float32Array(s.length);
        for (let i = 0; i < s.length; i++) o[i] = s[i] + (lp[i] - s[i]) * amt;
        const k = peak / peakOf(o); for (let i = 0; i < o.length; i++) o[i] *= k; s = o;
      } else {
        const amt = v.tone / 10 * VOICE_BRIGHT_GAIN, lp = lowpass(s, VOICE_BRIGHT_HZ), o = new Float32Array(s.length);
        for (let i = 0; i < s.length; i++) o[i] = s[i] + (s[i] - lp[i]) * amt;
        const np = peakOf(o); if (np > peak) { const k = peak / np; for (let i = 0; i < o.length; i++) o[i] *= k; } s = o;
      }
    }
    const g = v.volume / 100, o = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) o[i] = clampN(s[i] * g, -1, 1);
    return o;
  });
}
const voices = {
  ctx: null, decoded: new Map(), made: new Map(),
  context() { if (!this.ctx) { const C = window.AudioContext || window.webkitAudioContext; if (C) this.ctx = new C(); } return this.ctx; },
  reset() { this.decoded.clear(); this.made.clear(); },
  async buffer(base, v) {
    const key = base + '|' + (v ? [v.volume, v.pitch, v.tone].join('|') : '');
    if (this.made.has(key)) return this.made.get(key);
    const ctx = this.context(); if (!ctx) return null;
    const sfxKey = ciIn(A.manifest.sfx, base); if (!sfxKey) return null;
    if (!this.decoded.has(sfxKey)) this.decoded.set(sfxKey, fetch(A.source.url('sfx', sfxKey)).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)).catch(() => null));
    const src = await this.decoded.get(sfxKey); if (!src) return null;
    let out = src;
    if (voiceChanges(v)) {
      const chans = []; for (let c = 0; c < src.numberOfChannels; c++) chans.push(src.getChannelData(c));
      const done = voiceProcess(chans, src.sampleRate, v);
      out = ctx.createBuffer(done.length, done[0].length, src.sampleRate);
      done.forEach((d, c) => out.copyToChannel(d, c));
    }
    this.made.set(key, out); return out;
  },
  // the typing boop for whoever is speaking
  async play(speaker, vol) {
    const v = voiceFor(speaker);
    const base = (v && v.sound) || 'Talk_Boop';
    const buf = await this.buffer(base, v); const ctx = this.ctx;
    if (!buf || !ctx) { audio.playSfx(base, vol); return; }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const node = ctx.createBufferSource(); node.buffer = buf;
    const gain = ctx.createGain(); gain.gain.value = clampN(audio.sfxVol * (vol == null ? 1 : vol), 0, 1);
    node.connect(gain).connect(ctx.destination); node.start();
  },
};

// A choice menu like LT's (a menu box, one option per row, a hand cursor).
function drawChoice(ctx, ch, now) {
  const rowH = 16, pad = 8;
  const titleW = ch.title ? textWidth(ch.title) : 0;
  const w = Math.min(W - 16, Math.max(64, titleW + 2 * pad, ...ch.options.map(o => textWidth(o) + 2 * pad + 12)));
  const bw = Math.ceil(w / 8) * 8;
  const top = ch.title ? rowH + 4 : 4;
  const bh = Math.ceil((top + ch.options.length * rowH + 8) / 8) * 8;
  const bx = (W - bw) >> 1, by = Math.max(4, ((H - bh) >> 1) - 16);
  ch.box = { bx, by, bw, rowH, top };
  if (A.ui.menu_bg_base) drawNineSlice(ctx, A.ui.menu_bg_base, bx, by, bw, bh);
  else { ctx.fillStyle = '#2b4a8a'; ctx.fillRect(bx, by, bw, bh); }
  if (ch.title) drawText(ctx, ch.title, bx + ((bw - titleW) >> 1), by + 4, 'convo', 'white');
  ch.options.forEach((o, i) => {
    const y = by + top + i * rowH;
    if (i === ch.sel) { ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(bx + 4, y, bw - 8, rowH); }
    drawText(ctx, o, bx + pad + 12, y, 'convo', 'white');
    if (i === ch.sel) {   // blinking hand cursor
      const dx = Math.floor(now / 250) % 2;
      ctx.fillStyle = '#f8f0d8'; ctx.beginPath(); ctx.moveTo(bx + 4 + dx, y + 4); ctx.lineTo(bx + 11 + dx, y + 8); ctx.lineTo(bx + 4 + dx, y + 12); ctx.closePath(); ctx.fill();
    }
  });
}

// ---------------------------------------------------------------------------
// Player: runs parsed commands against the scene
// ---------------------------------------------------------------------------
function makePlayer(canvas, hooks) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const P = {
    cmds: [], pc: 0, running: false, waitFn: null, scene: null, skipping: false, autoAdvance: false, typingSound: false,
    hooks: hooks || {},
    newScene() {
      return { bg: null, bgPrev: null, bgFade: 1, portraits: new Map(), dialog: null, heldDialogs: [], black: 0, blackTarget: 0, blackMs: 250,
        shakeUntil: 0, card: null, cardUntil: 0, ended: false };
    },
    load(src) {
      this.cmds = parseScript(src);
      this.flow = analyzeFlow(this.cmds.length, i => { const n = this.cmds[i].name; return n === 'if' || n === 'elif' || n === 'else' || n === 'end' ? n : null; });
    },
    reset() {
      audio.stopAll(); this.scene = this.newScene(); this.pc = 0; this.waitFn = null;
      this.vars = Object.assign(lookVars(), this.hooks.previewVars ? this.hooks.previewVars() : {});
      this.forced = new Map();
    },
    // Make the branches that hold `line` take the arm that holds it.
    forceTo(line) {
      this.forced = new Map();
      const idx = this.cmds.findIndex(c => c.line >= line);
      if (idx < 0 || !this.flow) return;
      const at = this.cmds[idx].line === line ? idx : idx - 1;
      for (const { block, arm } of armsHolding(this.flow, at)) this.forced.set(block.start, arm);
    },
    armFor(b) {
      if (this.forced.has(b.start)) return this.forced.get(b.start);
      const conds = b.heads.map(h => { const c = this.cmds[h]; return c.name === 'else' ? null : c.raw.slice(c.raw.indexOf(';') + 1); });
      const pick = this.hooks.armPick ? this.hooks.armPick(this.cmds[b.start].line) : null;
      return decideArm(conds, b.hasElse, this.vars, pick);
    },
    // Branch bookkeeping before running cmds[pc]. Returns true if it moved pc.
    flowStep() {
      const c = this.cmds[this.pc]; if (!c || !this.flow) return false;
      const b = this.flow.owner[this.pc];
      if (!b || b.end == null) return false;
      if (c.name === 'if') {
        const a = this.armFor(b);
        this.pc = a < 0 ? b.end + 1 : b.arms[a].from;
        return true;
      }
      if (c.name === 'elif' || c.name === 'else') { this.pc = b.end + 1; return true; }   // end of the arm that ran
      if (c.name === 'end') { this.pc++; return true; }
      return false;
    },
    choose(i) {
      const S = this.scene; const ch = S && S.choice; if (!ch) return;
      const opt = ch.options[Math.max(0, Math.min(i, ch.options.length - 1))];
      this.vars[ch.nid] = opt; this.vars._last_choice = opt;
      S.choice = null;
      if (this.hooks.onChoice) this.hooks.onChoice(ch.nid, opt);
    },
    choiceAt(x, y) {   // canvas coordinates (240x160) -> option index or -1
      const ch = this.scene && this.scene.choice; if (!ch || !ch.box) return -1;
      const { bx, by, bw, rowH, top } = ch.box;
      if (x < bx || x > bx + bw) return -1;
      const i = Math.floor((y - by - top) / rowH);
      return i >= 0 && i < ch.options.length ? i : -1;
    },
    // Runs everything before `line` instantly (no sound), then plays from there.
    start(fromLine) {
      this.reset(); this.running = true;
      if (fromLine != null) this.forceTo(fromLine);
      if (fromLine != null && fromLine > 0) {
        const lastMusic = this.fastForward(c => c.line < fromLine);
        if (lastMusic) audio.playMusic(lastMusic.args[0] || lastMusic.kw.Music, 50);
      }
    },
    fastForward(pred) {
      this.skipping = true;
      let lastMusic = null;
      while (this.pc < this.cmds.length && pred(this.cmds[this.pc])) {
        if (this.flowStep()) continue;
        const c = this.cmds[this.pc++];
        if (c.name === 'music') lastMusic = c; else if (c.name === 'music_clear' || c.name === 'music_fade_back') lastMusic = null;
        this.exec(c);
        this.waitFn = null;
        this.settleScene();
        if (this.scene.ended) break;
      }
      this.skipping = false;
      return lastMusic;
    },
    settleScene() {
      const S = this.scene;
      for (const p of S.portraits.values()) p.settle();
      for (const [k, p] of S.portraits) if (p.alpha === 0 && p.removing) S.portraits.delete(k);
      S.dialog = null; S.black = S.blackTarget; S.bgFade = 1; S.card = null;
    },
    // Freeze-frame of the scene right after the commands up to `lastLine`;
    // if the last one is a line of dialogue, show it fully typed.
    still(lastLine) {
      this.reset(); this.running = false;
      this.forceTo(lastLine);
      let lastSpeak = null;
      for (const c of this.cmds) if (c.line <= lastLine && c.name === 'speak') lastSpeak = c;
      this.fastForward(c => c.line <= lastLine);
      if (lastSpeak && lastSpeak.line === this.lastCmdLine(lastLine)) {
        this.exec(lastSpeak, true);
        if (this.scene.dialog) this.scene.dialog.finishAll();
        for (const p of this.scene.portraits.values()) p.talking = false;
      }
      this.waitFn = null;
      this.scene.ended = false;
    },
    lastCmdLine(maxLine) { let l = -1; for (const c of this.cmds) if (c.line <= maxLine) l = c.line; return l; },
    advance() {
      const d = this.scene && this.scene.dialog;
      if (d) { if (d.advance()) { if (!d.hold) this.scene.dialog = null; else { this.scene.heldDialogs.push(d); this.scene.dialog = null; } } }
    },
    current() { return this.cmds[Math.max(0, Math.min(this.pc, this.cmds.length) - 1)]; },
    exec(c, forceSpeak) {
      const S = this.scene, a = c.args;
      const block = !c.flags.has('no_block') && !this.skipping;
      switch (c.name) {
        case 'change_background': {
          const key = ciFind(A.backgrounds, a[0] || c.kw.Panorama);
          S.bgPrev = S.bg; S.bg = key ? A.backgrounds[key] : null; S.bgFade = 0;
          if (!c.flags.has('keep_portraits')) S.portraits.clear();
          break;
        }
        case 'transition': {
          const dir = (a[0] || c.kw.Direction || (S.blackTarget ? 'open' : 'close')).toLowerCase();
          S.blackTarget = dir === 'close' ? 1 : 0; S.blackMs = +(a[1] || c.kw.Speed || 250);
          if (block) this.waitFn = () => S.black === S.blackTarget;
          break;
        }
        case 'add_portrait': {
          const nid = a[0] || c.kw.Portrait;
          const exprs = (a[3] || c.kw.ExpressionList || '').split(',').map(s => s.trim()).filter(Boolean);
          const slide = (a[2] || c.kw.Slide || '').toLowerCase() || null;
          const p = new Portrait(nid, a[1] || c.kw.ScreenPosition || 'Left', { mirror: c.flags.has('mirror'), immediate: c.flags.has('immediate') || this.skipping,
            speed: parseFloat(a[4] || c.kw.SpeedMult || '') || 1, expressions: exprs, slide, gray: c.flags.has('low_saturation'), low: c.flags.has('low_priority') });
          S.portraits.set(nid, p);
          if (block && !c.flags.has('immediate')) this.waitFn = () => !p.busy;
          break;
        }
        case 'multi_add_portrait': {
          const added = [];
          for (let i = 0; i + 1 < a.length; i += 2) { const p = new Portrait(a[i], a[i + 1], { immediate: this.skipping }); S.portraits.set(a[i], p); added.push(p); }
          if (block) this.waitFn = () => added.every(p => !p.busy);
          break;
        }
        case 'remove_portrait': case 'multi_remove_portrait': case 'remove_all_portraits': {
          const names = c.name === 'remove_all_portraits' ? [...S.portraits.keys()] : (c.name === 'remove_portrait' ? [a[0]] : a);
          const ps = names.map(n => S.portraits.get(n)).filter(Boolean);
          for (const p of ps) {
            if (c.flags.has('immediate') || this.skipping) { S.portraits.delete(p.nid); continue; }
            p.fade = -1; p.removing = true;
            if (c.name === 'remove_portrait') { p.fadeMs = 233 / (parseFloat(a[1] || c.kw.SpeedMult) || 1); const sl = (a[2] || c.kw.Slide || '').toLowerCase(); if (sl) p.slide = sl; }
          }
          const live = ps.filter(p => p.removing);
          if (block && live.length) this.waitFn = () => live.every(p => p.alpha <= 0);
          break;
        }
        case 'move_portrait': {
          const p = S.portraits.get(a[0]); if (!p) break;
          const pos = parsePosition(a[1] || c.kw.ScreenPosition);
          p.tx = pos.x; p.ty = pos.y; p.moveSpeed = 0.25 * (parseFloat(a[2] || c.kw.SpeedMult || '') || 1);
          if (c.flags.has('immediate') || this.skipping) { p.x = p.tx; p.y = p.ty; }
          else if (block) this.waitFn = () => !p.busy;
          break;
        }
        case 'bop_portrait': {
          const p = S.portraits.get(a[0]); if (!p || this.skipping) break;
          p.bops = parseInt(a[1] || c.kw.NumBops || '2', 10) || 2; p.bopTime = parseInt(a[2] || c.kw.Time || '132', 10) || 132; p.lastBop = 0; p.bopUp = false;
          if (block) this.waitFn = () => p.bops <= 0;
          break;
        }
        case 'mirror_portrait': { const p = S.portraits.get(a[0]); if (p) p.mirror = !p.mirror; break; }
        case 'expression': {
          const p = S.portraits.get(a[0]); if (!p) break;
          p.expr = new Set((a[1] || c.kw.ExpressionList || '').split(',').map(s => s.trim()).filter(Boolean));
          break;
        }
        case 'speak': {
          if (this.skipping && !forceSpeak) break;
          const who = a[0] || c.kw.SpeakerOrStyle || '';
          const text = substituteVars(normalizeQuotes(a[1] || c.kw.Text || ''), Object.assign({}, lookVars(), this.vars));
          const style = c.kw.StyleNid || '';
          const narration = style === 'narration' || style === 'narration_top';
          const portrait = narration ? null : (S.portraits.get(who) || null);
          const noTalk = c.flags.has('no_talk') || style === 'thought_bubble';
          const d = new Dialog(who, text, portrait, { hold: c.flags.has('hold'), speed: parseFloat(c.kw.TextSpeed || '') || 1,
            font: c.kw.FontType || 'convo', color: c.kw.FontColor || null, style, numLines: parseInt(c.kw.NumLines || '', 10) || 2 });
          if (c.flags.has('autogray')) for (const p of S.portraits.values()) p.gray = p !== portrait;
          if (portrait && !noTalk) portrait.talking = true;
          S.dialog = d; d.portraitRef = portrait; d.noTalk = noTalk;
          if (!c.flags.has('no_block') && !forceSpeak) this.waitFn = () => !S.dialog || S.dialog.state === 'done';
          break;
        }
        case 'unhold': S.heldDialogs = []; break;
        case 'wait': if (!this.skipping) { const until = performance.now() + (+(a[0] || c.kw.Time || 0)); this.waitFn = () => performance.now() >= until; } break;
        case 'music': {
          if (this.skipping) break;
          const nid = a[0] || c.kw.Music;
          if (!audio.playMusic(nid, +(a[1] || c.kw.FadeIn || 400), a[2] != null ? a[2] : c.kw.Volume) && this.hooks.warn) this.hooks.warn(`Music "${nid}" isn't in the loaded assets`);
          break;
        }
        case 'music_fade_back': case 'music_clear': if (!this.skipping) audio.stopMusic(+(a[0] || c.kw.FadeOut || 400)); break;
        case 'sound': if (!this.skipping) audio.playSfx(a[0] || c.kw.Sound, a[1] != null ? +a[1] : (c.kw.Volume != null ? +c.kw.Volume : null)); break;
        case 'screen_shake': if (!this.skipping) { S.shakeUntil = performance.now() + (+(a[0] || c.kw.Duration || 500)); if (block) this.waitFn = () => performance.now() >= S.shakeUntil; } break;
        case 'location_card': if (!this.skipping) { S.card = a[0] || c.kw.String || ''; S.cardUntil = performance.now() + 2000; if (block) this.waitFn = () => performance.now() >= S.cardUntil; } break;
        case 'end': S.ended = true; break;   // branch ends are handled in flowStep
        case 'choice': {
          const nid = a[0] || c.kw.Nid || '', title = a[1] || c.kw.Title || '';
          const options = String(a[2] || c.kw.Choices || '').split(',').map(x => x.trim()).filter(Boolean);
          if (!options.length) break;
          if (this.skipping) {
            // fast-forwarding: pick the option the branch right after it needs
            // to reach the step being shown (or the previewed one)
            let want = null;
            const b = this.flow && this.flow.byStart.get(this.pc);
            if (b && this.forced.has(b.start)) {
              const h = this.cmds[b.heads[this.forced.get(b.start)]];
              const p = h.name === 'else' ? null : parseCond(h.raw.slice(h.raw.indexOf(';') + 1));
              if (p && p.type === 'var' && p.name === nid && p.op === '==') want = p.value;
            }
            const opt = options.includes(want) ? want : (nid in this.vars && options.includes(this.vars[nid]) ? this.vars[nid] : options[0]);
            this.vars[nid] = opt; this.vars._last_choice = opt;
          } else {
            S.choice = { nid, title, options, sel: 0 };
            this.waitFn = () => !S.choice;
          }
          break;
        }
        default: break;
      }
    },
    update(now, dt) {
      const S = this.scene; if (!S) return;
      let guard = 0;
      while (this.running && !this.waitFn && !S.ended && this.pc < this.cmds.length && guard++ < 500) {
        if (this.flowStep()) continue;
        const c = this.cmds[this.pc++];
        for (const p of S.portraits.values()) p.talking = false;
        this.exec(c);
        if (this.hooks.onCommand) this.hooks.onCommand(c);
      }
      if (this.waitFn && this.waitFn()) this.waitFn = null;
      if (this.running && !this.waitFn && (S.ended || this.pc >= this.cmds.length)) { this.running = false; S.ended = true; if (this.hooks.onEnd) this.hooks.onEnd(); }
      for (const [k, p] of S.portraits) { p.update(now, dt); if (p.removing && p.alpha <= 0) S.portraits.delete(k); }
      if (S.bgFade < 1) S.bgFade = Math.min(1, S.bgFade + dt / 250);
      if (S.black !== S.blackTarget) {
        const step = dt / Math.max(1, S.blackMs);
        S.black = S.blackTarget > S.black ? Math.min(1, S.black + step) : Math.max(0, S.black - step);
      }
      const d = S.dialog;
      if (d) {
        let n = 0;
        d.update(dt, () => { if (this.typingSound && (++n % 3 === 0) && !d.noTalk) voices.play(d.speaker, 0.5); });
        if (d.portraitRef) d.portraitRef.talking = this.running && d.state === 'typing' && !d.noTalk;
        if (this.running && this.autoAdvance && d.state === 'waiting') {
          d.waitStart = d.waitStart || now;
          if (now - d.waitStart > 1100) { d.waitStart = 0; this.advance(); }
        }
      }
      audio.update(dt);
    },
    draw(now) {
      const S = this.scene;
      ctx.save();
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      if (!S) { ctx.restore(); return; }
      if (now < S.shakeUntil) ctx.translate(Math.round(Math.random() * 4 - 2), Math.round(Math.random() * 4 - 2));
      if (S.bgPrev && S.bgFade < 1) ctx.drawImage(S.bgPrev, 0, 0);
      if (S.bg) { ctx.save(); ctx.globalAlpha = S.bgFade; ctx.drawImage(S.bg, 0, 0); ctx.restore(); }
      const ps = [...S.portraits.values()].sort((a, b) => (a.low ? 0 : 1) - (b.low ? 0 : 1));
      for (const p of ps) p.draw(ctx);
      for (const hd of S.heldDialogs) hd.draw(ctx, now);
      if (S.dialog) S.dialog.draw(ctx, now);
      if (S.choice) drawChoice(ctx, S.choice, now);
      if (S.card && now < S.cardUntil && A.ui.message_bg_base) {
        const w = Math.ceil((textWidth(S.card) + 16) / 8) * 8;
        drawNineSlice(ctx, A.ui.message_bg_base, 4, 4, w, 32);
        drawText(ctx, S.card, 12, 12);
      }
      if (S.black > 0) { ctx.fillStyle = `rgba(0,0,0,${S.black})`; ctx.fillRect(-4, -4, W + 8, H + 8); }
      ctx.restore();
    }
  };
  return P;
}

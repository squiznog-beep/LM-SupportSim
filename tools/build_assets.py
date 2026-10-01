"""
Bundle the assets the Support Sim needs from an LT project into a folder
that is published next to the sim page.

    python tools/support_sim/build_assets.py --project default.ltproj --out build/support_sim

Writes the page (index.html + scripts) into <out>, and <out>/assets/... plus
<out>/assets/assets.json, the manifest the page reads. <out> can be uploaded
as-is to any static host (GitHub Pages). Run it again with --project pointing at a real project to swap in
that project's portraits, backgrounds, music and sounds; the page itself does
not change.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

DEFAULT_BACKGROUNDS = ['Bedroom', 'Clearing', 'Forest', 'Hill', 'House', 'InsideCastle', 'Plains',
                       'Town', 'TownSunset', 'Village', 'BlackBackground', 'CastleRuins']
DEFAULT_MUSIC = ['Healing', 'Shops', 'Armory']
DEFAULT_SFX = ['Talk_Boop', 'Select 1', 'Item', 'Heal1', 'Attack Hit 1', 'Critical Hit 1',
               'Warp', 'Level Up', 'GargoyleLanding']


def parse_idx(path: Path) -> dict:
    glyphs = {}
    width = height = 0
    for line in path.read_text(encoding='utf-8').splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == 'width':
            width = int(parts[1]); continue
        if parts[0] == 'height':
            height = int(parts[1]); continue
        if len(parts) < 4:
            continue
        ch = ' ' if parts[0] == 'space' else parts[0]
        glyphs[ch] = [int(parts[1]), int(parts[2]), int(parts[3])]
    return {'cell_w': width, 'cell_h': height, 'glyphs': glyphs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--project', default=str(REPO / 'default.ltproj'))
    ap.add_argument('--out', required=True)
    ap.add_argument('--backgrounds', default=','.join(DEFAULT_BACKGROUNDS), help="comma list or 'all'")
    ap.add_argument('--music', default=','.join(DEFAULT_MUSIC), help="comma list or 'all'")
    ap.add_argument('--sfx', default=','.join(DEFAULT_SFX), help="comma list or 'all'")
    args = ap.parse_args()

    res = Path(args.project) / 'resources'
    out = Path(args.out) / 'assets'
    if out.exists():
        shutil.rmtree(out)
    for sub in ('portraits', 'backgrounds', 'music', 'sfx', 'ui'):
        (out / sub).mkdir(parents=True)

    manifest = {'project': Path(args.project).name, 'portraits': [], 'backgrounds': [],
                'music': [], 'sfx': []}

    for p in json.loads((res / 'portraits' / 'portraits.json').read_text()):
        src = res / 'portraits' / (p['nid'] + '.png')
        if not src.exists():
            continue
        shutil.copyfile(src, out / 'portraits' / src.name)
        manifest['portraits'].append({k: p[k] for k in (
            'nid', 'blinking_offset', 'smiling_offset', 'full_size', 'face_size',
            'blink_size', 'mouth_size', 'blink_frames', 'mouth_frames') if k in p})

    def pick(kind, wanted, folder, ext):
        names = sorted(f.stem for f in (res / folder).glob('*' + ext))
        chosen = names if wanted == 'all' else [n for n in wanted.split(',') if n in names]
        for n in chosen:
            shutil.copyfile(res / folder / (n + ext), out / kind / (n + ext))
        return chosen

    manifest['backgrounds'] = pick('backgrounds', args.backgrounds, 'panoramas', '.png')
    manifest['music'] = pick('music', args.music, 'music', '.ogg')
    manifest['sfx'] = pick('sfx', args.sfx, 'sfx', '.ogg')

    # UI: LT's conversation fonts (regular, italic, bold, narrow) with their
    # colour palettes, speech bubble, tail and name tag. Inline tags such as
    # <blue>word</> or <iconvo>word</> in a speak line use these.
    fonts = res / 'fonts'
    font_info = {f['nid']: f for f in json.loads((fonts / 'fonts.json').read_text())}
    manifest['fonts'] = {}
    for nid in ('convo', 'iconvo', 'bconvo', 'nconvo'):
        if not (fonts / (nid + '.png')).exists():
            continue
        shutil.copyfile(fonts / (nid + '.png'), out / 'ui' / (nid + '.png'))
        entry = parse_idx(fonts / (nid + '.idx'))
        info = font_info.get(nid, {})
        entry['default_color'] = info.get('default_color')
        entry['palettes'] = {k: [c[:3] for c in v] for k, v in (info.get('palettes') or {}).items()}
        manifest['fonts'][nid] = entry
    manifest['font'] = manifest['fonts']['convo']   # older pages read this
    sprite_dirs = [res / 'custom_sprites', REPO / 'sprites' / 'menus']
    for name in ('message_bg_base', 'message_bg_tail', 'name_tag', 'menu_bg_base', 'message_bg_thought_tail'):
        for d in sprite_dirs:
            if (d / (name + '.png')).exists():
                shutil.copyfile(d / (name + '.png'), out / 'ui' / (name + '.png'))
                break

    # characters: events name units (add_portrait;Eirika), whose portrait and
    # display name the preview uses
    units_json = Path(args.project) / 'game_data' / 'units.json'
    manifest['units'] = []
    if units_json.exists():
        for u in json.loads(units_json.read_text()):
            manifest['units'].append({'nid': u['nid'], 'name': u.get('name'), 'portrait': u.get('portrait_nid'),
                                      'fields': u.get('fields') or []})

    (out / 'assets.json').write_text(json.dumps(manifest, indent=1))

    # The page itself, so <out> is ready to publish as-is (GitHub Pages etc.)
    here = Path(__file__).resolve().parent
    for f in ('index.html', 'sim-engine.js', 'builder-model.js', 'builder-ui.js'):
        shutil.copyfile(here / f, Path(args.out) / f)
    total = sum(f.stat().st_size for f in out.rglob('*') if f.is_file())
    print('portraits %d, backgrounds %d, music %d, sfx %d, %.1f MB' % (
        len(manifest['portraits']), len(manifest['backgrounds']), len(manifest['music']),
        len(manifest['sfx']), total / 1e6))


if __name__ == '__main__':
    main()

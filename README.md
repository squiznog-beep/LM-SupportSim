# Lava Medallion Support Sim

A browser tool for writing and previewing Lex Talionis (LT-Maker) support
conversations and dialogue events: a timeline editor with a live preview that
draws portraits, backgrounds, text boxes, music and the characters' typing
voices the way the game does, and writes LT event script you can paste into
the editor.

**Open it:** https://squiznog-beep.github.io/LM-SupportSim/ (once GitHub Pages is on)

## Using your own project

Click **📁 Project** in the sim and choose your `.ltproj` folder. The sim
reads its portraits, backgrounds, music, sound effects, fonts, units
(including character voices) and events directly from the folder, in your
browser — nothing is uploaded anywhere. New assets show up the next time you
open the folder; no rebuild needed. Chromium browsers remember the folder.

Without a project, the sim uses the bundled sample assets in `assets/`
(from LT's own sample project).

## What's here

| Path | What it is |
|---|---|
| `index.html`, `sim-engine.js`, `builder-model.js`, `builder-ui.js` | The whole app (no build step) |
| `assets/` | Bundled sample assets + `assets.json` manifest |
| `test/` | Node tests: `node --test test/model.test.js test/voice.test.js` |
| `tools/build_assets.py` | Rebuilds `assets/` from an LT project (run inside an LT-Maker checkout) |

The source of truth lives in the LT-Maker fork at `tools/support_sim/`;
this repository is the published copy.

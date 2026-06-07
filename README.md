# mosu!

**mosu!** is a free, open-source, browser-based **osu!mania beatmap editor**. Load
a song, lay down notes and hold notes on a scrolling playfield, set your timing
and metadata, then export a fully playable `.osu` / `.osz` that opens straight in
the real osu! client. Everything runs **100% client-side** — no account, no
upload, no backend.

> osu! is a trademark of ppy Pty Ltd. mosu! is an independent, unofficial tool
> and is not affiliated with or endorsed by ppy.

## ✨ Features

- 🎵 **Load any local audio** (MP3 / OGG / WAV) via drag-and-drop or file picker.
- ⌨️ **1K–10K** column counts (default 4K).
- 🎯 **Note + hold-note editing** on a scrolling playfield with beat-snapped,
  colour-coded grid lines (1/1 → 1/16).
- ⏱️ **Timing**: multiple BPM points, inherited SV/volume points, a **tap-tempo**
  tool and a **metronome**.
- 🖱️ **Full editing workflow**: click to place, drag to draw holds, box-select,
  move, mirror, copy/paste, and **undo/redo** with a 200-step history.
- 🔊 **Precise Web Audio playback** with scrubbing, a waveform timeline, variable
  **0.25×–2× playback rate**, and independent scroll-speed (zoom).
- 💾 **Export** spec-correct `.osu` text or a zipped `.osz` (with audio), and
  **import** existing `.osu` / `.osz` to keep editing — round-trip safe.
- 🎮 **Built-in test play** with per-column keybinds and basic hit judging, so you
  can feel out your map without leaving the browser.
- 🧠 **Autosave** to your browser (localStorage + IndexedDB) and an unsaved-changes
  guard, so a refresh never loses your work.

## 🚀 Quick start

```bash
npm install
npm run dev      # open http://localhost:5173
```

Then:

1. **Drop an audio file** onto the playfield (or click *Choose audio…*).
2. Open the **Timing** tab, tap out or type your **BPM** and **offset**, and click
   *Add BPM point*.
3. Fill in **Song** metadata and pick your **key count** under *Setup*.
4. **Scroll** (mouse wheel / ↑↓) through the track and **click lanes** to place
   notes; **drag vertically** to draw holds.
5. Hit **Test** to play your chart, then **.osz** to download a finished beatmap.

## 🎹 Controls

| Action                         | Input                              |
| ------------------------------ | ---------------------------------- |
| Play / pause                   | `Space`                            |
| Move one snap                  | `↑` / `↓` or mouse wheel           |
| Place / remove a note          | Click a lane, or `1`–`9`           |
| Draw a hold note               | Click + drag vertically            |
| Box-select                     | `Shift` + drag                     |
| Move selection                 | Drag a selected note               |
| Mirror selection               | `M`                                |
| Delete selection               | `Delete` / `Backspace`             |
| Copy / paste                   | `Ctrl+C` / `Ctrl+V`                |
| Select all                     | `Ctrl+A`                           |
| Undo / redo                    | `Ctrl+Z` / `Ctrl+Y`                |
| Exit test play                 | `Esc`                              |

## 🗂️ How the `.osu` export works

mosu! targets osu! file format **v14**, mode **3** (mania). The format mapping is
documented in code in [`src/osu/serializer.ts`](src/osu/serializer.ts) and covered
by unit tests in [`test/osu.test.ts`](test/osu.test.ts). Highlights:

- The **column count** is stored as `CircleSize` in `[Difficulty]`.
- A note's **column** is encoded in its x coordinate (`x = floor((column + 0.5) *
  512 / keyCount)`); osu! decodes it as `floor(x * keyCount / 512)`.
- **Tap notes** use object type `1`; **hold notes** use type `128` with the end
  time written before the hit-sample field
  (`x,y,time,128,hitSound,endTime:0:0:0:0:`).
- **Timing points**: red (BPM) lines store `beatLength = 60000 / bpm`; green
  (inherited) lines store `beatLength = -100 / sv`.

Reference: the [osu! file format spec](https://osu.ppy.sh/wiki/en/Client/File_formats/osu_%28file_format%29).

## 🛠️ Tech

Vanilla **TypeScript + Vite**, the **Web Audio API**, **Canvas 2D**, and
[`fflate`](https://github.com/101arrowz/fflate) for client-side zipping. No game
engine, no framework.

## 📦 Build & deploy

```bash
npm run build        # outputs static files to dist/
npm run preview      # preview the production build
```

The output in `dist/` is fully static and can be hosted anywhere (GitHub Pages,
Netlify, Cloudflare Pages, …). A GitHub Pages workflow is included at
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): enable Pages
("GitHub Actions" source) in the repo settings and every push to the default
branch publishes to `https://ozskul.github.io/mosu/`. For a project page set the
base path with `MOSU_BASE=/mosu/ npm run build` (the workflow does this for you).

## 🧪 Tests

```bash
npm test
```

Unit tests cover the timing math (BPM ↔ beat length, snapping, grid lines, tap
tempo) and the `.osu` serializer/parser (column mapping, note/hold encoding,
timing points, and a full round-trip).

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs and issues welcome.

## 📄 License

[MIT](LICENSE).

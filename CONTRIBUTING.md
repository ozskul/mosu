# Contributing to mosu!

Thanks for your interest in improving mosu! — a free, open-source, browser-based
osu!mania beatmap editor. Contributions of all kinds are welcome.

## Getting started

```bash
git clone https://github.com/ozskul/mosu.git
cd mosu
npm install
npm run dev        # start the dev server (http://localhost:5173)
```

## Useful scripts

| Command            | Purpose                                            |
| ------------------ | -------------------------------------------------- |
| `npm run dev`      | Start the Vite dev server with hot reload.         |
| `npm run build`    | Type-check and produce a production build in `dist`. |
| `npm run preview`  | Preview the production build locally.              |
| `npm test`         | Run the unit tests once (Vitest).                  |
| `npm run test:watch` | Run the unit tests in watch mode.                |
| `npm run typecheck`| Type-check without emitting.                       |

## Project layout

```
src/
  audio/      Web Audio engine (playback, seeking, waveform peaks)
  timing/     Pure timing math: BPM, snapping, grid lines, tap tempo
  state/      EditorStore (document + undo/redo) and persistence
  render/     Canvas playfield renderer and the time<->pixel Viewport
  osu/        .osu serializer/parser and .osz (zip) packaging
  play/       Test-play mode with hit judgement
  main.ts     UI controller wiring everything together
test/         Vitest unit tests for the timing math and the .osu format
```

## Guidelines

- **Keep the `.osu` format correct.** The serializer and parser are the heart of
  the project. Any change there must keep `npm test` green, and ideally be
  verified by loading an exported map in the real osu! client.
- **Prefer pure functions** for logic that can be unit-tested (see `src/timing`
  and `src/osu`). UI glue lives in `main.ts`.
- **Type-check and test before opening a PR**: `npm run typecheck && npm test`.
- Match the existing code style — no formatter is enforced, just keep it tidy and
  consistent with the surrounding code.

## Reporting bugs / ideas

Open an issue describing what you expected, what happened, and (for export bugs)
attach or paste the relevant `.osu` text. Feature ideas are welcome too.

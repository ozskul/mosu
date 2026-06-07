# Graph Report - .  (2026-06-07)

## Corpus Check
- Corpus is ~30,579 words - fits in a single context window. You may not need a graph.

## Summary
- 505 nodes · 943 edges · 20 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output
- Edge kinds: contains: 356 · calls: 231 · imports: 168 · method: 115 · imports_from: 73


## Input Scope
- Requested: auto
- Resolved: committed (source: default-auto)
- Included files: 40 · Candidates: 47
- Excluded: 5 untracked · 17085 ignored · 0 sensitive · 0 missing committed
- Recommendation: Use --scope all or graphify.yaml inputs.corpus for a knowledge-base folder.

## Graph Freshness
- Built from Git commit: `5806e90`
- Compare this hash to `git rev-parse HEAD` before trusting freshness-sensitive graph output.
## God Nodes (most connected - your core abstractions)
1. `EditorStore` - 44 edges
2. `AudioEngine` - 28 edges
3. `ManiaPlayer` - 25 edges
4. `Beatmap` - 15 edges
5. `handleFile()` - 13 edges
6. `PlayfieldRenderer` - 11 edges
7. `currentTime()` - 10 edges
8. `generateChart()` - 9 edges
9. `restore()` - 9 edges
10. `beatLengthFromBpm()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `drawOverview()` --calls--> `restore()`  [EXTRACTED]
  src/main.ts → src/main.ts  _Bridges community 16 → community 13_
- `handleFile()` --calls--> `onLoaded()`  [EXTRACTED]
  src/main.ts → src/main.ts  _Bridges community 13 → community 19_
- `downloadOsz()` --calls--> `commitActive()`  [EXTRACTED]
  src/main.ts → src/main.ts  _Bridges community 18 → community 12_
- `loadSet()` --calls--> `renderDiffList()`  [EXTRACTED]
  src/main.ts → src/main.ts  _Bridges community 13 → community 12_
- `syncPanels()` --calls--> `renderDiffList()`  [EXTRACTED]
  src/main.ts → src/main.ts  _Bridges community 19 → community 12_

## Communities

### Community 0 - "Community 0"
Cohesion: 0.03
Nodes (65): alignBtn, audio, base, beat, beatsStatus, bgInput, bpm, canvas (+57 more)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (41): accuracy(), codeToLabel(), defaultKeys(), emptyStats(), grade(), Judgement, judgementFor(), judgementWeight() (+33 more)

### Community 2 - "Community 2"
Cohesion: 0.09
Nodes (1): EditorStore

### Community 3 - "Community 3"
Cohesion: 0.08
Nodes (23): AudioLike, detectOnsets(), OnsetOptions, toMono(), clampInt(), encodeWav(), writeString(), shiftBeatmap() (+15 more)

### Community 4 - "Community 4"
Cohesion: 0.11
Nodes (30): applyKeyValue(), num(), OsuParseError, parseBeatmap(), parseHitObject(), parseTimingPoint(), columnToX(), round() (+22 more)

### Community 5 - "Community 5"
Cohesion: 0.08
Nodes (25): clamp(), DIFFICULTY_LEVELS, DifficultyLevel, generateChart(), GenerateOptions, HP_BY_LEVEL, mulberry32(), OD_BY_LEVEL (+17 more)

### Community 6 - "Community 6"
Cohesion: 0.12
Nodes (3): AudioEngine, AudioEngineListener, clamp()

### Community 7 - "Community 7"
Cohesion: 0.10
Nodes (25): buildOsz(), osuFileName(), OszContents, oszFileName(), readOsz(), sanitize(), Metadata, blankDifficultyFrom() (+17 more)

### Community 8 - "Community 8"
Cohesion: 0.15
Nodes (2): ManiaPlayer, shade()

### Community 9 - "Community 9"
Cohesion: 0.16
Nodes (21): byTime, got, lines, multi, offset, onsets, points, activeBpmPoint() (+13 more)

### Community 10 - "Community 10"
Cohesion: 0.16
Nodes (14): clamp01(), clampInt(), computeIntensity(), findDrops(), intensityAt(), IntensityEnvelope, percentile(), toMono() (+6 more)

### Community 11 - "Community 11"
Cohesion: 0.20
Nodes (17): clearAudio(), clearBackground(), clearDocument(), clearVideo(), deleteBlob(), getBlob(), loadAudio(), loadBackground() (+9 more)

### Community 12 - "Community 12"
Cohesion: 0.26
Nodes (14): addDifficulty(), commitActive(), deleteDifficulty(), ensureGenPrereqs(), generateInto(), generateSpread(), genSetStatus(), levelLabel() (+6 more)

### Community 13 - "Community 13"
Cohesion: 0.22
Nodes (14): ensureIntensity(), handleFile(), isImageFile(), isVideoFile(), loadSet(), rebuildPeaks(), refreshMedia(), removeBackgroundMedia() (+6 more)

### Community 14 - "Community 14"
Cohesion: 0.15
Nodes (5): divisorSel, err, FakeAudioContext, html, keysSel

### Community 15 - "Community 15"
Cohesion: 0.23
Nodes (3): lowerBound(), PlayfieldRenderer, shade()

### Community 16 - "Community 16"
Cohesion: 0.31
Nodes (9): applyBoxSelection(), currentTime(), drawOverview(), frame(), handleMetronome(), noteAtPointer(), pointerToCell(), startTestPlay() (+1 more)

### Community 17 - "Community 17"
Cohesion: 0.43
Nodes (7): detectTempo(), estimateOffset(), findPeaks(), foldBpm(), histogramTempo(), renderLowBand(), TempoResult

### Community 18 - "Community 18"
Cohesion: 0.47
Nodes (6): downloadOsu(), downloadOsz(), passesExportCheck(), sanitizeName(), startTrim(), triggerDownload()

### Community 19 - "Community 19"
Cohesion: 0.33
Nodes (6): formatTime(), onLoaded(), renderTimingList(), songLength(), syncPanels(), tickClock()

## Knowledge Gaps
- **155 isolated node(s):** `AudioEngineListener`, `OnsetOptions`, `TempoResult`, `Preset`, `PRESETS` (+150 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 2`** (1 nodes): `EditorStore`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 8`** (2 nodes): `ManiaPlayer`, `shade()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `EditorStore` connect `Community 2` to `Community 0`, `Community 4`?**
  _High betweenness centrality (0.158) - this node is a cross-community bridge._
- **Why does `AudioEngine` connect `Community 6` to `Community 0`, `Community 1`?**
  _High betweenness centrality (0.096) - this node is a cross-community bridge._
- **Why does `ManiaPlayer` connect `Community 8` to `Community 0`, `Community 1`?**
  _High betweenness centrality (0.088) - this node is a cross-community bridge._
- **What connects `AudioEngineListener`, `OnsetOptions`, `TempoResult` to the rest of the system?**
  _155 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.02702702702702703 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.055051421657592255 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.08859357696567 - nodes in this community are weakly interconnected._
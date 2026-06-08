# Graph Report - .  (2026-06-08)

## Corpus Check
- Corpus is ~41,678 words - fits in a single context window. You may not need a graph.

## Summary
- 535 nodes · 999 edges · 20 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output
- Edge kinds: contains: 375 · calls: 253 · imports: 172 · method: 126 · imports_from: 73


## Input Scope
- Requested: auto
- Resolved: committed (source: default-auto)
- Included files: 44 · Candidates: 54
- Excluded: 0 untracked · 17126 ignored · 0 sensitive · 0 missing committed
- Recommendation: Use --scope all or graphify.yaml inputs.corpus for a knowledge-base folder.

## Graph Freshness
- Built from Git commit: `77eb39b`
- Compare this hash to `git rev-parse HEAD` before trusting freshness-sensitive graph output.
## God Nodes (most connected - your core abstractions)
1. `EditorStore` - 44 edges
2. `AudioEngine` - 28 edges
3. `ManiaPlayer` - 25 edges
4. `Beatmap` - 15 edges
5. `generateChart()` - 13 edges
6. `StyleEngine` - 13 edges
7. `handleFile()` - 13 edges
8. `PlayfieldRenderer` - 11 edges
9. `currentTime()` - 10 edges
10. `HitObject` - 10 edges

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
Nodes (66): alignBtn, audio, base, beat, beatsStatus, bgInput, bpm, canvas (+58 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (40): ALLOWED_STYLES, CHART_STYLES, ChartStyle, clamp(), clampStyleToLevel(), DIFFICULTY_LEVELS, DifficultyLevel, generateChart() (+32 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (41): buildOsz(), osuFileName(), OszContents, oszFileName(), readOsz(), sanitize(), applyKeyValue(), num() (+33 more)

### Community 3 - "Community 3"
Cohesion: 0.07
Nodes (35): accuracy(), codeToLabel(), defaultKeys(), emptyStats(), grade(), Judgement, judgementFor(), judgementWeight() (+27 more)

### Community 4 - "Community 4"
Cohesion: 0.09
Nodes (1): EditorStore

### Community 5 - "Community 5"
Cohesion: 0.08
Nodes (23): AudioLike, detectOnsets(), OnsetOptions, toMono(), clampInt(), encodeWav(), writeString(), shiftBeatmap() (+15 more)

### Community 6 - "Community 6"
Cohesion: 0.12
Nodes (3): AudioEngine, AudioEngineListener, clamp()

### Community 7 - "Community 7"
Cohesion: 0.15
Nodes (2): ManiaPlayer, shade()

### Community 8 - "Community 8"
Cohesion: 0.16
Nodes (21): byTime, got, lines, multi, offset, onsets, points, activeBpmPoint() (+13 more)

### Community 9 - "Community 9"
Cohesion: 0.13
Nodes (19): Metadata, blankDifficultyFrom(), cloneBeatmap(), duplicateDifficulty(), emptySet(), nextVersionName(), SHARED_META, syncSharedMetadata() (+11 more)

### Community 10 - "Community 10"
Cohesion: 0.15
Nodes (15): clamp01(), clampInt(), computeIntensity(), findDrops(), intensityAt(), IntensityEnvelope, percentile(), toMono() (+7 more)

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
- **166 isolated node(s):** `AudioEngineListener`, `OnsetOptions`, `TempoResult`, `Preset`, `PRESETS` (+161 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 4`** (1 nodes): `EditorStore`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 7`** (2 nodes): `ManiaPlayer`, `shade()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `EditorStore` connect `Community 4` to `Community 0`, `Community 2`?**
  _High betweenness centrality (0.150) - this node is a cross-community bridge._
- **Why does `AudioEngine` connect `Community 6` to `Community 0`, `Community 3`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Why does `ManiaPlayer` connect `Community 7` to `Community 0`, `Community 3`, `Community 2`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **What connects `AudioEngineListener`, `OnsetOptions`, `TempoResult` to the rest of the system?**
  _166 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.02666666666666667 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05076679005817028 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07215686274509804 - nodes in this community are weakly interconnected._
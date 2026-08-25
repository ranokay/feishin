# Feishin Hi-Fi / Bit-Perfect Audio Architecture Plan

Status: PROPOSAL - awaiting approval. No production code has been written.
Date: 2026-08-25
Evidence base: local repo @ `development` (91c4d96a), mpv 0.41.0 manual + source, FFmpeg 9 docs, Navidrome master source, OpenSubsonic spec, VeraVox public site, and 15 empirical probes run against mpv 0.41.0 on macOS (tagged [PROBE]).

Fixed decisions (not reopened): mpv stays the audio engine; no ASIO; Standard playback keeps every existing Feishin feature; strict behavior is opt-in.

---

## 1. Executive recommendation

**Keep mpv. Extend the integration in place, with one new main-process subsystem and a small Feishin-owned IPC client added alongside node-mpv.**

- Do NOT replace mpv, do NOT add a native playback engine, do NOT add ASIO.
- The current `node-mpv` wrapper is serviceable for commands but **cannot deliver what this feature fundamentally needs**: it surfaces only `status`/`timeposition`-shaped events (Feishin already works around missing `end-file` events by watching `playlist-pos`, src/main/features/core/player/index.ts:196-218), has no access to mpv log messages (required to observe CoreAudio physical-format negotiation), requires `(mpv as any)` casts for process control, and is an unmaintained pinned fork.
- Recommendation: **Option B+C hybrid, staged**. Phase 1 adds a small Feishin-owned `MpvIpcConnection` (~400 lines: spawn, socket/pipe, request-id correlation, event emitter) as a *second* JSON IPC client on the same mpv instance. mpv explicitly supports multiple IPC clients, so this carries zero regression risk to existing command flow while unlocking property observation, log messages, and lifecycle events. Consolidating all command traffic onto the owned client later becomes optional cleanup, decided on evidence.
- All audiophile logic lives behind two new centralized modules (policy resolver + signal-path reducer); React components only render state. Nothing scatters `if (bitPerfect)` checks through the UI tree.
- Strict mode is a policy preset that constrains configuration; integrity status is always computed from evidence, never from the toggle.

The single most important honesty constraint found during research: **on macOS shared output, mpv reports `audio-out-params` at the source rate even though the OS server may be running the DAC at a different physical rate and converting internally** ([PROBE] P2). Shared-mode output can therefore never be labeled bit-perfect, only "unprocessed". Exclusive mode is also not self-evident: `avfoundation` (the default AO on current Homebrew/macOS builds) silently ignores `audio-exclusive=yes` [PROBE P11], and hog contention hard-fails init [PROBE P15b]. The design below treats all of these as first-class states rather than edge cases.

---

## 2. Existing Feishin architecture

### 2.1 File-level map (playback-relevant)

| Layer | File | Role / key symbols |
|---|---|---|
| Main | `src/main/features/core/player/index.ts` | Entire mpv integration: `createMpv` (:148), `DEFAULT_MPV_PARAMETERS` (:100), 2-item queue handlers (:467-550), device enumeration via throwaway mpv (:676-731), sleep-resume rebuild (:775), cleanup state machine (:742) |
| Main | `src/main/features/core/player/media-keys.ts` | Global media keys (non-MediaSession path) |
| Main | `src/main/features/linux/mpris.ts` | MPRIS bridge |
| Main | `src/main/features/core/remote/index.ts` | Remote HTTP/WS server |
| Main | `src/main/features/core/settings/index.ts` | electron-store mirror of select settings |
| Preload | `src/preload/mpv-player.ts` | Complete mpv IPC surface (`mpvPlayer`, `mpvPlayerListener`) |
| Renderer | `src/renderer/features/player/audio-player/engine/mpv-player-engine.tsx` | mpv engine: init properties (:88-179), volume/mute/speed/pitch effects, auto-next (:394) |
| Renderer | `.../audio-player/mpv-player.tsx` | Play/pause fade wrapper (300 ms stepped volume), timestamp poll |
| Renderer | `.../audio-player/web-player.tsx` | Web engine shell: crossfade/gapless handlers, ReplayGain math (:421-505), WebAudio hookup |
| Renderer | `.../audio-player/engine/web-player-engine.tsx` | Dual `<audio>` elements (react-player), squared volume curve |
| Renderer | `.../audio-player/engine/jukebox-player-engine.tsx` | Subsonic jukeboxControl client (no local audio) |
| Renderer | `src/renderer/features/player/components/audio-players.tsx` | Engine dispatcher; WebAudio graph owner (gains -> preamp -> 12 biquads -> compressor -> destination) (:202-291); `setSinkId` routing (:311-336) |
| Renderer | `src/renderer/store/player.store.ts` | Zustand player state + actions + event subscriptions |
| Renderer | `src/renderer/store/settings.store.ts` | All settings incl. `playback.mpvProperties` schema (:282-291) |
| Renderer | `.../settings/components/playback/mpv-properties.ts` | Settings -> mpv property mapping (`getMpvProperties`) |
| Renderer | `.../settings/components/playback/mpv-audio-filters.ts` | EQ/compressor -> `af` lavfi string builder |
| Renderer | `src/renderer/api/subsonic/subsonic-controller.ts` | `getStreamUrl` (:1961+), transcode params (:234-245) |

### 2.2 Lifecycle (mpv path)

1. App start: `AudioPlayers` mounts hooks (scrobble, MPRIS, remote, power-save...) then engine per `playback.type`.
2. Init: `MpvPlayerEngine` quit-if-running, build properties from `getMpvProperties()` + speed/volume/pitch, append `--audio-device=<id|auto>` to extra params, invoke `player-initialize` -> main `createMpv` merges `DEFAULT_MPV_PARAMETERS` (`--idle=yes --no-config --load-scripts=no --prefetch-playlist=yes --network-timeout=10 --stream-lavf-o=reconnect...`), starts node-mpv `{audio_only:true, auto_restart:false}`, applies properties.
3. Queue: renderer resolves URLs for current+next (`getSongUrl(..., skipAutoTranscode=true)`) -> `player-set-queue` = `load(current,'replace') + load(next,'append')`. Invariant: playlist pos0=current, pos1=next.
4. Track end: mpv advances internally (prefetch); `playlist-pos > 0` -> `renderer-player-auto-next` -> store advances, renderer fetches new next URL -> `player-auto-next` removes pos0, appends replacement.
5. Manual next/prev/queue edits: full `replaceMpvQueue` or `setQueueNext`.
6. Quit/restart: `cleanupMpv` state machine with SIGTERM/SIGKILL fallbacks; powerMonitor resume emits `renderer-mpv-reconnect` -> full re-init.

### 2.3 Server -> DAC data flow

```
Navidrome HTTP (stream.view?...) 
  -> mpv demuxer/lavf (HTTP, cache) 
  -> decoder (FFmpeg) 
  -> user af chain (volume preamp, lavfi equalizer xN, lavfi acompressor) 
  -> auto-inserted conversion block (aresample/format/chmap when AO rejects config) 
  -> scaletempo2 (only if speed != 1) 
  -> softvol gain application at AO stage (ao.c process_plane) 
  -> AO driver (avfoundation | coreaudio(_exclusive) | wasapi | pipewire | pulse | alsa) 
  -> OS audio API -> DAC
```

### 2.4 Process boundaries

- Renderer (React/Zustand) <-> preload (`window.api`, contextBridge) <-> main (node-mpv EventEmitter) <-> mpv child process (JSON IPC unix socket / named pipe) <-> OS audio.
- Stream URLs carry auth in query string (`c=Feishin&<credential>` where credential = token+salt or JWT), so mpv needs no header plumbing (subsonic-controller.ts:1965).
- Jukebox: no local audio at all (server-side gain). Audiophile features do not apply.

---

## 3. Current signal-changing points (complete inventory)

| # | Stage | Mechanism | Trigger today |
|---|---|---|---|
| 1 | Server transcode | Navidrome player-config/maxBitRate; Feishin sends `format`/`maxBitRate` only when `playback.transcode.enabled` | Default off client-side, BUT bare stream URL still obeys server-side per-player transcoding config - Feishin never sends `format=raw`, so silent server transcode is possible today (subsonic-controller.ts:1965-1975) |
| 2 | Decoder output format | FLAC/ALAC/etc -> float/s32 PCM; DSD -> float32 PCM at rate x8 (dsd2pcm) | Always (lossless for lossless sources) |
| 3 | EQ | `af`: `volume=<preamp>dB` + up to 12 `lavfi=[equalizer=...]` | `playback.equalizer.enabled` |
| 4 | Compressor | `af`: `lavfi=[acompressor=...]` | `playback.compressor.enabled` |
| 5 | ReplayGain | mpv native props replaygain/-preamp/-clip/-fallback multiplied into softvol gain | `mpvProperties.replayGainMode` |
| 6 | Software volume | mpv softvol gain (cubic curve, gain==1.0 early-out at 100) | `player.volume != 100` (default 30!) |
| 7 | Mute | mpv mute prop (gain 0) | toggle |
| 8 | Play/pause fades | Stepped setVolume ramp 300 ms | `audioFadeOnStatusChange` default true |
| 9 | Speed | `speed` property -> auto-inserted scaletempo2 filter when != 1 | `player.speed` |
| 10 | Pitch correction | `audio-pitch-correction` yes/no | `preservePitch` |
| 11 | Resampling | Forced `audio-samplerate` setting OR AO rate mismatch -> swresample (dither OFF by default) | `mpvProperties.audioSampleRateHz` (default unset) or AO negotiation |
| 12 | Channel conversion | `audio-channels=auto-safe` + AO chmap acceptance -> rematrix/downmix | automatic |
| 13 | Format conversion | Auto-inserted conversion to AO-accepted sample format (e.g. s16 content -> float32 device) | automatic; invisible via `af` [PROBE E10] |
| 14 | Web-only: RG gain nodes, EQ biquads, compressor, squared volume curve, crossfade ramps | WebAudio graph | WEB player type |
| 15 | Visualizer taps | WEB: tap gains nodes (pre-EQ). MPV: `getDisplayMedia` system-audio loopback (blocked under exclusive already) | visualizer visible |
| 16 | Gapless padding (web) | Hardcoded 0.116 s early-start padding (`isFlac=false` hardcoded) | web gapless transitions |

Not currently exercised anywhere: HDCD decode, de-emphasis, polarity inversion, DSD-specific handling, dithering.

---

## 4. mpv capability matrix

Legend: D=documented stable 0.41.0, S=source-verified, P=probed locally on macOS. Writable/Observability columns describe runtime behavior over JSON IPC.

| Capability | Status | Writable at runtime | Observable evidence |
|---|---|---|---|
| Device enumeration (`audio-device-list`) | D+S+P | - (ro) | Property; entries are name+description ONLY; change notification fires on hotplug (armed on first read) |
| Select device (`audio-device`) | D+S | Yes (schedules AO reload) | `current-ao`; note: property does NOT confirm actual device in use |
| Exclusive request (`audio-exclusive`) | D+S+P | Yes | NO success/failure property. macOS: redirects coreaudio->coreaudio_exclusive; failure surfaces as AO-init error/end-file(error) [P7,P15b]; avfoundation silently ignores [P11] |
| Active AO driver (`current-ao`) | D | ro | Property; tells driver, not device nor share mode |
| Filter-chain output (`audio-params`) | D+P | ro | Property: format/samplerate/channel-count/hr-channels |
| Device-boundary output (`audio-out-params`) | D+P | ro | Same fields; ground truth for what enters the OS API |
| Physical device format (macOS exclusive) | S | - (OS-managed) | v-level logs only (`ao/coreaudio_exclusive` prefix): available-format list + chosen ASBD [P15]. Not exposed as property |
| WASAPI exclusive formats/rates | S | - | Log lines ("Trying ... (exclusive)"); rates probed include 352.8k/384k |
| `af` chain inspection | D+P | RW (af set/add/remove/clr) | Requested filters only; auto-inserted conversion filters invisible |
| Softvol transparency point | S | volume=100 & no RG & volume-gain=0 & unmuted => gain==1.0 early-out, samples untouched | No applied-gain property; verbose logs only |
| ReplayGain applied value | S | Options yes; computed into softvol gain | Verbose logs only ("Applying replay-gain") |
| Speed/pitch | D+S | Yes | speed!=1 auto-inserts scaletempo2 (>= 1e-8 delta); removed at 1.0 |
| Gapless modes | D+P | gapless-audio: yes resamples rate-changing tracks to keep device [P13]; weak keeps device across same-rate, reopens on rate change [P9/P14, same-rate continuity probe]; no reopens always |
| DSD native / DoP out | S: ABSENT in mpv 0.41/master (no ao_dsd, no DoP packing, spdif codec list excludes DSD) | n/a | DSF/DFF decode via dsd2pcm -> float32 PCM at rate x8 (352.8 kHz for DSD64) |
| HDCD | FFmpeg `hdcd` lavfi filter exists (16-bit -> 20-bit expand) | via `--af=lavfi=[hdcd]` | Visible in af |
| De-emphasis | FFmpeg `aemphasis type=cd` lavfi filter | via af | Visible in af |
| Cache/buffer observability | D | demuxer-cache-time/duration/state, cache-buffering-state | Properties |
| Log stream | D | request_log_messages level=v | log-message events (ao/* prefixes carry negotiation detail) |
| Events | D | start-file, end-file{reason}, audio-reconfig, property-change, client-message | node-mpv exposes NONE of these raw (see section 8) |
| Multiple IPC clients | D+P | Confirmed working (probes ran second client alongside defaults) | - |

Startup-only vs runtime: `--audio-device` is CLI-applied per init in Feishin but IS runtime-writable (triggers reload); `--prefetch-playlist`, demuxer cache options effectively init-time; most audio properties runtime-writable.

---

## 5. Platform matrix

| Capability | macOS | Windows (WASAPI only) | Linux |
|---|---|---|---|
| Shared output | avfoundation (auto-selected on current builds!) or coreaudio AudioUnit; OS server may convert silently | wasapi shared: pinned to mix format/rate -> SRC risk | pipewire (preferred) / pulse / alsa(default) ; server-side resample common |
| Exclusive/direct | coreaudio_exclusive via redirect when `audio-exclusive=yes` + `--ao=coreaudio`; true hog mode + mixing disable; restores format on uninit | wasapi exclusive: AUDCLNT_SHAREMODE_EXCLUSIVE; hard-fails with NO shared fallback; buffer via `--wasapi-exclusive-buffer` | Only PipeWire forwards PW_STREAM_FLAG_EXCLUSIVE (session-manager dependent); ALSA direct `hw:` is the practical direct path; Pulse/ALSA-default have none |
| Source-rate switching | Automatic in exclusive (physical format set per track) [P7/P15]; shared does NOT move device rate | Automatic in exclusive via IsFormatSupported search (closest >= requested, else closest below; includes 352.8/384k); shared fixed to mix rate | ALSA hw: snaps rate (mpv inserts aresample if AO rejects -> detectable via out-params delta); PipeWire follows stream rate IF `default.clock.allowed-rates` configured; else resamples |
| Output inspection | audio-out-params + current-ao; physical ASBD via v-logs only | audio-out-params + current-ao | audio-out-params; actual graph behavior depends on server |
| PCM formats | Integer+float physical formats negotiated (built-in speakers expose float-only [P15]) | s16, s24(3B), s24-in-32, s32, float32 | Driver-dependent (alsa); pipewire/pulse accept float widely |
| Device hotplug | audio-device-list change notification; format change triggers AO reload | IMMNotificationClient: hotplug events; default-device change follows `auto`; monitored-device removal reloads AO | pulse/pipewire push hotplug; alsa static per session |
| Contention behavior | Shared-held: exclusive init succeeds, takes over [P15]. Hog-held: HARD FAIL ("failed to set hogmode" -> no sound) [P15b] | Hard fail, no downgrade | PW_EXCLUSIVE best-effort; hw: busy open fails |
| Known quirks found | plain `coreaudio` AO fails on MONO streams on modern macOS (channel-layout error) [P12 context]; avfoundation ignores exclusive [P11]; default-AO choice is version-sensitive | Exclusive failure = silent stop unless UI catches end-file(error) | `default`/plughw apply conversions invisibly; ProAudio profiles are a manual admin task |
| DSD feasibility | DSD->PCM x8-rate float via dsd2pcm; no native/DoP | same | same (hw: exposing 352.8k+ could carry it as plain high-rate PCM, NOT DoP) |
| DAC capability discovery | Available physical formats: v-logs only | None via properties (log hints) | None via mpv |

---

## 6. VeraVox feature matrix (feature reference, not implementation guide)

VeraVox is macOS-only; nearly everything maps to mpv-native mechanisms or honest-substitute states.

| VeraVox feature | What it technically is | Feishin value | mpv feasibility | Priority / stage |
|---|---|---|---|---|
| Hog Mode lock icon | Exclusive device ownership indicator | High | Detectable indirectly (AO errors, current-ao, logs); never provable 100% on macOS -> show as "Requested+best-effort" evidence tier | P0 (Signal Path) |
| PCM bit-perfect integer path | No DSP, native format negotiation | Core goal | Achievable within defined limits (see invariants §9) | P0-P4 |
| Per-track sample-rate switching | Device renegotiation | Core goal | Native under weak-gapless + exclusive [P9/P14] | P0 |
| DSD over DoP (DSD64-512), SACD ISO, WavPack DSD | Software DoP packing + DST decode | Low-moderate | **Not feasible**: mpv has zero DoP/native-DSD support; would require exactly the kind of second-engine work we excluded. Honest substitute: DSD->PCM x8 (dsd2pcm) clearly labeled | Experimental (re-scope decision needed, likely wontfix) |
| DSD->PCM fallback w/ yellow LED | Decimation to hi-res PCM | Moderate | This is mpv's DEFAULT dsf behavior - just label it | P2 (labeling) |
| 3-level gapless w/ ring buffer | Pre-open + pre-decode | Moderate | mpv prefetch-playlist + weak gapless covers same-rate seamlessly [probe]; rate changes get brief reopen | P1 (verify seams) |
| Transport fade envelope ~50 ms | Volume ramp at boundaries | Existing feature parity | Already have (300 ms fade option); forbidden in strict | done/N.A. |
| HDCD decode | hdcd lavfi, exclusive-only in VV | Niche | Works via af; must force >=20-bit-capable output | P2 |
| CD de-emphasis | aemphasis cd curve, tag/cue driven | Niche | Works via af; needs emphasis flag sourcing (Navidrome tags?) | P2 |
| Polarity inversion | Sample negation | Niche | Trivial lavfi `invert`... actually lavfi has no invert; use `volume=-1:precision=float`? (eval) | P3 (cheap experiment) |
| Max bit depth zero-pad | Feed DAC widest format | Niche | `audio-format=s32` forces widening; widening is lossless | P1 option |
| Signal Path display w/ LED taxonomy | Evidence-based chain view | Core goal | Build from mpv telemetry (§10) | P0 |
| Stream Inspector (scope/bit-plane/counters) | Realtime tap instrumentation | Nice-to-have | Partial: waveform/RMS via lavfi ebur128/astats metadata taps possible WITHOUT altering samples? (lavfi analysis filters DO consume/modify chain - needs prototype; alternative offline) | P2 (see §16/§20) |
| DAC Diagnostics table | Full physical-format enumeration | Moderate | macOS: parse v-logs; Windows/Linux: unavailable honestly | P1 (macOS-first) |
| Offline Analysis (bandwidth, ENOB, fake hi-res, DR/LRA/LUFS, DC offset) | FFT/statistics on decoded samples | High differentiator | ffmpeg CLI sidecar or wasm; fully decoupled from playback | P2 |
| Vectorscope/Spectrogram/Spectrum/VU/Surround scope | GPU visualizations | Moderate | Reuse existing visualizer framework; audio source problem identical to current visualizers (impossible under exclusive) | P2/P3 |
| Bit-Perfect Test (loopback) | Round-trip sample identity | Diagnostic gold | Software-level variant achievable: `--ao=pcm` file dump + hash compare (no hardware needed); hardware loopback = BlackHole/VB-Cable manual procedure | P2 (software) / Experimental (hardware) |
| NAS buffering adaptivity | Measured-latency preload | Moderate | demuxer-readahead-secs/cache-secs tuning | P1 |
| Metadata viewer | Tag readout | Exists partially | Navidrome provides | skip |

Explicitly rejected from VeraVox scope: streaming-service absence is irrelevant to us (we keep Navidrome), UPnP renderer/send (out of scope), DAC warm-up (marketing-leaning, skip).

---

## 7. Domain model (terminology)

New terms are additive; nothing existing gets renamed. Definitions chosen to avoid the overloaded words "mode", "quality", "direct".

| Term | Definition |
|---|---|
| **Source stream** | The bytes Navidrome actually served for a play request: codec, container, samplingRate, bitDepth, channelCount, size, plus served-vs-declared verification result. Distinct from library metadata. |
| **Decoded format** | PCM (or DSD-as-PCM) produced by mpv's decoder: format/samplerate/channels (`audio-params`). |
| **Processing graph** | The ordered list of sample-altering operations between decoder and AO boundary: user `af` entries, auto-inserted conversion filters, scaletempo2, softvol gain factor, ReplayGain factor. |
| **Output format** | Sample representation handed to the OS API (`audio-out-params`). |
| **Output route** | Which OS API/driver owns delivery AND its sharing regime: `coreaudio_exclusive` / `wasapi-exclusive` / `alsa-hw` vs shared routes. |
| **Device state** | Observed device facts: name/id, current route, output format/rate/channels. |
| **Playback policy** | User's requested constraint set. Three presets: `standard`, `exclusive` (exclusive route + normal processing allowed), `bit-perfect` (strict invariants enforced). A policy is a *request*, provably satisfiable or not. |
| **Integrity status** | Computed verdict about the actual signal path for the playing track, derived only from evidence (§10.3). Never mirrors the policy. |
| **Exclusive output** | Route where Feishin's mpv holds direct/hog ownership where the OS allows. Does NOT imply unprocessed. |
| **Sample-rate fidelity** | decoded.samplerate == output.samplerate == source.samplingRate (all three observed equal). |
| **Precision-preserving conversion** | Representation change that cannot alter sample values: lossless-codec->PCM decode, integer widening (s16->s24/s32/float32 exact range), mono/stereo layout passthrough. Narrowing (depth reduction), rate change, channel-count change, and gain != 1.0 are all precision-altering. |
| **Bit-perfect eligibility** | All enforceable invariants hold (policy satisfied + evidence confirms). |
| **Bit-perfect verified** | Eligibility AND every invariant backed by confirmed-tier evidence for the current track. Software-provable only; hardware truth beyond OS API is out of reach (documented limitation). |
| **Source-faithful transformation** | An intentional, standards-defined decode step (HDCD expansion, de-emphasis) shown explicitly in the processing graph; classified as processed-but-declared, never silently applied. |
| **Direct stream** | Server response carrying original file bytes (`format=raw` semantics). Verified heuristically (size/content-type/range headers), never assumed. |
| **Signal Path** | The composed user-facing model: source stream -> server route -> decoded format -> processing graph -> output route -> device state -> integrity status, each item tagged with evidence level. |

Evidence levels: `confirmed` (mpv/OS reported directly for this playback), `requested` (what we configured), `inferred` (derived from documented behavior/logs), `unknown`.

Anti-overclaim rules encoded in the reducer:
1. `audio-exclusive=yes` accepted is `requested`, never `confirmed`.
2. Shared-route output is capped at `unprocessed` regardless of everything else (macOS hidden server conversion [PROBE]).
3. Widening conversions do not break eligibility; any narrowing/resampling/channel-change does.
4. Missing evidence yields `unknown`, which renders as unknown, never as success.

---

## 8. Proposed mpv subsystem architecture

### 8.1 Components

```
main process
  MpvIpcConnection        (NEW, ~400 LOC, src/main/features/core/player/mpv-ipc.ts)
    spawn/args/socket-pipe lifecycle, request-id correlation,
    event bus: property-change | log-message | end-file/start-file | audio-reconfig | client-message
    multiple concurrent clients supported by mpv (verified)
  MpvSupervisor           (extends existing createMpv responsibilities)
    owns BOTH connections during transition: legacy node-mpv (commands, unchanged) 
    + MpvIpcConnection (observability). Consolidation later = optional cleanup ticket.
  AudioStateService       (NEW, src/main/features/core/player/audio-state.ts)
    observer registry (audio-params, audio-out-params, current-ao, audio-device,
    af, volume, mute, speed, gapless-audio, demuxer-cache-state, ...)
    log-tail parser for ao/<driver> v-messages (physical format, exclusive attempts)
    derived immutable AudioSnapshot + diff events -> renderer
    ring-buffer EventLog (device opened, exclusive failed, rate changed, ...)
preload
  window.api.audioState   (snapshot getter, event subscription, event-log query)
renderer
  signalpath/             (NEW domain module, pure TS, unit-tested)
    policy.ts             PlaybackPolicy presets + resolvePolicy(settings, track, device) -> EffectiveConfig
    invariants.ts         pure predicate evaluation -> IntegrityVerdict
    reducer.ts            AudioSnapshot + track + policy -> SignalPathModel
    evidence.ts           Evidence<T> wrappers, confidence merging
  store/audio.store.ts    (NEW zustand slice fed by api events)
  components/             SignalPathBadge, SignalPathPopover, StreamInspectorModal, DeviceCapabilitiesPanel
```

### 8.2 Data flow

1. Supervisor starts mpv with resolved startup args (existing DEFAULT_MPV_PARAMETERS + policy-derived extras like `--ao=coreaudio` pinning when exclusive policy active).
2. MpvIpcConnection observes the fixed property set; each change recomputes an `AudioSnapshot` in main; snapshot diffs broadcast on `renderer-audio-state-changed` (throttled coalescing, 100 ms).
3. Renderer `audio.store` keeps latest snapshot; `signalpath/reducer` composes SignalPathModel with current track metadata + policy; UI subscribes.
4. Commands remain on node-mpv channels initially. Policy enforcement happens at the existing choke points: `getMpvProperties()` extended by policy resolver before `setMultipleProperties`, and extraParameters built in `MpvPlayerEngine` from `resolvePolicy()`.
5. Failure detection: subscribe `end-file` reasons + AO-init failures from logs; supervisor classifies into typed errors (`ExclusiveContention`, `DeviceUnsupportedRate`, ...) and forwards to renderer for strict-fallback UX.

### 8.3 Why not replace node-mpv immediately

Every stage must leave Feishin usable. The dual-client approach isolates all new risk inside read-only observation paths. Command-path migration (if ever) becomes a mechanical follow-up with the owned client already battle-tested. This satisfies YAGNI while removing the actual blocker (missing observability).

---

## 9. Strict playback invariants (exact rules)

### Standard preset
No constraints. Everything in §3 remains available. Signal Path still displays (transparency without restriction).

### Exclusive preset
- Startup pins `--ao=` per platform selection (macOS: `coreaudio`; Windows: `wasapi`; Linux: user-selected pipewire|alsa-hw device) + `audio-exclusive=yes` (ignored harmlessly where unsupported, but UI labels evidence accordingly).
- Processing allowed: volume, mute, EQ, compressor, ReplayGain, fades, speed. Integrity shows `processed-exclusive` when any active.
- Fails loud: exclusive acquisition failure stops playback with explanation + "Continue in Standard" action (no shared-mode silent downgrade).

### Bit-Perfect preset (PCM)
All of the following, enforced by policy resolver and validated by invariant evaluator:

| # | Invariant | Enforcement mechanism | Evidence check |
|---|---|---|---|
| 1 | Player = LOCAL (mpv) | Policy gate on play start | trivial |
| 2 | Direct stream: URL carries `format=raw` (Subsonic family) / `static=true` (Jellyfin) | URL builder override | size/content-type/range heuristics vs song.size; codec/rate/depth match vs library metadata |
| 3 | No forced output rate: `audio-samplerate` unset | strip from properties | audio-params.samplerate == source.samplingRate |
| 4 | `gapless-audio=weak` (never `yes`) | property pin | transition probe: out-params None-gap on rate change is expected+allowed |
| 5 | Software gain unity: volume=100, volume-gain absent, unmuted | slider disabled + property pin | volume/mute props observed |
| 6 | No ReplayGain (mode=no; preamp irrelevant) | property pin | rg props observed |
| 7 | No user `af` entries (EQ/compressor/HDCD/de-emphasis all empty) | controls disabled; `af` observed empty | af==[] |
| 8 | speed == 1.0 exactly | control disabled | speed prop |
| 9 | No channel-count alteration: decoded channels == output channels == source channelCount | audio-channels left auto-safe | audio-params vs audio-out-params channel-count equality |
| 10 | No precision loss: output depth >= decoded effective depth (widening OK) | `audio-format` untouched | format comparison table (s16<s24<s32<=f32 within range) |
| 11 | Exclusive route active per platform | startup args + retry logic | current-ao == expected driver; AO-init error => stop |
| 12 | No silent fallback: WebPlayer/WebAudio never engaged under this policy | dispatcher guard | policy flag |
| 13 | No visualizer capture | existing exclusive-block pattern reused | - |

Deliberate non-invariants (documented in ADR):
- Lossless decode (FLAC->PCM etc.) is required, obviously, and is precision-preserving by definition - "bit-perfect" here means **bit-transparent decoded-PCM delivery**, not compressed-bytes-at-the-DAC. The definition lives in the glossary and Signal Path copy.
- Buffering/caching choices never affect eligibility (they move bytes, don't change them).
- A brief AO reopen at rate boundaries is acceptable and displayed as a device-transition event, not an integrity failure.

### Violation handling (mode invalidation)

| User action during Bit-Perfect | Strategy | Behavior |
|---|---|---|
| Move volume slider / volume keys | A: disable | Slider disabled with explanatory tooltip + link to why; media-key volume-up/down ignored with one-time toast |
| Press mute / mute media key | B: remap | Mute toggles PAUSE in Bit-Perfect (recommended decision, see §16 of discussion below - emergency muting must exist; pausing is honest and reversible). Setting offers "allow mute (breaks integrity until unmuted)" alternative |
| Enable EQ/compressor/ReplayGain in settings | A: disabled while strict track playing | Controls render disabled with note; changing them queues "applies when you leave Bit-Perfect" |
| Change speed | A: disabled | Slider disabled |
| Change device / sample-rate setting | C: allow + revalidate | Policy re-resolves; if new device can't satisfy, strict-stop UX |
| Toggle transcoding | Deferred | Blocked with toast while strict session active |
| Open visualizer | Existing pattern | Auto-close + toast (precedent: exclusive-mode block today) |
| Switch player type to WEB/JUKEBOX | C: confirm modal | Leaving strict mode is explicit |

Rationale: A-strategy where the control directly breaks an invariant mid-track; B only for mute (safety); C for actions that legitimately re-target the policy. No modal spam.

---

## 10. Signal Path design

### 10.1 Data model (sketch)

```ts
type Evidence<T> = { value: T; level: 'confirmed' | 'requested' | 'inferred' | 'unknown'; source: string };

interface SourceStage { codec; container; samplingRate; bitDepth; channelCount; pcmOrDsd; bitrateKbps? }
interface ServerStage { route: 'direct-stream' | 'transcoded' | 'download'; outputCodec?; verification: 'size-match'|'header-match'|'metadata-match'|'unverified'; }
interface DecoderStage { demuxer; decoder; decoded: {format; samplerate; channels}; }
interface ProcessingEntry { kind: 'gain'|'eq'|'compressor'|'resample'|'channel-map'|'tempo'|'declared-decode'; detail; evidence }
interface OutputStage { route: 'coreaudio-exclusive'|'wasapi-exclusive'|'alsa-hw'|'pipewire-exclusive'|...shared variants; driver: string; outputParams: {...}; requestedExclusive: boolean }
interface DeviceStage { name; id; rate; format; channels; capabilityNotes: Evidence<...>[] }
interface SignalPathModel {
  stages: [...]; integrity: IntegrityVerdict; events: AudioEvent[]; updatedAt;
}
type IntegrityVerdict =
  | { status: 'bit-perfect-verified' }
  | { status: 'bit-perfect-eligible'; pendingConfirmation: string[] }
  | { status: 'exclusive-processed'; processing: string[] }
  | { status: 'unprocessed-shared' }          // clean but OS-shared: cannot claim bit-perfect
  | { status: 'processed'; processing: string[] }
  | { status: 'transcoded'; detail } | { status: 'lossy-source' }
  | { status: 'resampled'; from; to } | { status: 'unsupported'; reason }
  | { status: 'unknown'; missing: string[] };
```

### 10.2 Derivation algorithm (ordered)

1. If not playing: `stopped`. If policy unsupported for platform/device: `unsupported`.
2. Server stage: verification heuristics -> transcoded? -> `transcoded` (terminal unless policy standard).
3. Source lossy? -> `lossy-source` cap (still show full chain; integrity floor).
4. Processing graph non-empty (excluding precision-preserving widenings)? -> collect entries.
5. Rate fidelity check: source.samplingRate vs audio-params.samplerate vs audio-out-params.samplerate.
6. Precision check per format table.
7. Route check: exclusive drivers set vs shared set.
8. Compose: any precision-altering op -> processed/resampled/exclusive-processed; else exclusive -> eligible/verified; else unprocessed-shared.
9. `verified` requires every contributing fact confirmed-tier; any inferred/requested dependency caps at `eligible`.

### 10.3 UI presentation

- PlayerBar badge: compact verdict chip (color + short label, mirroring VeraVox LED semantics: green verified / blue eligible-exclusive / grey unprocessed-shared / amber processed / red degraded).
- Click -> popover: stage-by-stage line items with per-item evidence dot (confirmed/requested/inferred/unknown) and `DSP: None` line when clean.
- Advanced: full Stream Inspector modal (§ advanced view: URL, headers verification results, mpv demuxer/decoder/AO/cache state, device details, copy-as-diagnostics button producing sanitized text report).

---

## 11. Navidrome implications

| Topic | Finding | Design consequence |
|---|---|---|
| Forcing raw | `format=raw` short-circuits ALL server-side transcoding/player config on current Navidrome (legacy_client.go:61); official API since Subsonic 1.9.0 | Bit-Perfect always appends `&format=raw`; never send maxBitRate |
| Today's silent risk | Bare stream URL (current skipAutoTranscode path) obeys per-player server config -> possible silent transcode | Fix opportunistically: LOCAL player should send raw too once policy lands (ticket, low risk since mpv plays anything) |
| Verification | Raw responses: Content-Length == file size, Accept-Ranges bytes, mime matches suffix. Transcoded: Accept-Ranges none, no CL (unless estimateContentLength), target mime. Cached transcodes mimic raw headers -> one-way heuristic | Combine headers + received-size vs song.size + demuxer-reported codec/rate vs library metadata. Any mismatch -> transcoded verdict |
| Auth for mpv | token+salt/md5 or enc: password in query string; stateless, no expiry (JWT variant expires - prefer token auth for URLs) | Existing credential-in-URL approach is sufficient; document JWT caveat |
| Metadata | OpenSubsonic adds bitDepth/samplingRate/channelCount; Navidrome emits them; Feishin already normalizes into Song (subsonic-normalize.ts:198-246) | Use as declared-source baseline for invariant checks |
| DSD | .dsf indexed (TagLib 2), served raw as audio/x-dsf on format=raw; .dff NOT indexed by default (rejected PR) | DSD experimental track uses .dsf only; expect x-dsf content type |
| Scrobbling | Neither stream nor download counts plays | Keep explicit scrobble calls (already the case) |
| Jellyfin | `/Audio/{id}/stream?static=true` = original bytes; universal decides server-side; Download endpoint byte-exact (current choice) | Keep Download for now; abstract behind `buildDirectStreamUrl(server, song)` so policy can switch per backend |
| Old servers | Pre-decider Navidrome versions may behave differently | Document minimum-version expectation; verification heuristics catch misbehavior at runtime regardless |

Failure cases: downloads disabled (error 50) affects Download endpoint on Jellyfin-side configs; server-forced transcode despite raw (very old versions) -> detected by verification -> strict stop with message.

---

## 12. Sample-rate switching design

Per-platform expected behavior when consecutive tracks differ in rate (44.1 -> 96 etc.) under Bit-Perfect:

| Platform | Mechanism | What UI shows |
|---|---|---|
| macOS exclusive | coreaudio_exclusive sets physical format synchronously to stream rate (probed: 44.1/48/96 all switched) [P7,P15]; restores original on uninit | Device rate change event; brief reopen gap allowed; integrity maintained |
| macOS shared | Device rate unchanged; mpv delivers source rate to HAL which converts server-side [P2 evidence] | Integrity capped at unprocessed-shared anyway; show "DAC rate unknown" |
| Windows exclusive | IsFormatSupported search picks closest supported >= requested else closest below; device switches; hard-fail if impossible | Rate change event; failure -> typed UnsupportedRate error |
| Windows shared | Pinned to mix format -> resample | processed/resampled |
| ALSA hw | snd_pcm_hw_params_set_rate_near snaps to nearest hw rate; mpv inserts aresample if AO final rate differs (detect via audio-params != audio-out-params samplerate) | If snapped != source -> resampled verdict (honest) |
| PipeWire | Follows stream rate when `default.clock.allowed-rates` includes it; otherwise resamples server-side | Doc-guided setup page; out-params based verdict; quantum/rate changes observable via pipewire logs (inferred tier) |

Rules: never globally force a rate in Bit-Perfect (`audio-samplerate` stripped, ticket includes migrating the existing setting to warn when strict-active); switching latency measured in qualification tests (expected < 250 ms typical USB DAC); gapless interplay handled in §13.

---

## 13. Gapless design

Probed reality [P9/P13/P14 + same-rate probe]:
- `gapless-audio=yes`: device held at first track's rate; rate-changing next track gets RESAMPLED. Forbidden in Bit-Perfect; discouraged everywhere (silent quality loss).
- `gapless-audio=weak` (current default): same rate+convertible format -> device stays open, seamless (observed continuous out-params across boundary); rate change -> brief teardown/reopen (None-gap observed), new rate.
- `gapless-audio=no`: always reopen; audible gap; not used.

Design:
- Same-format transitions (within one rate/format class): seamless under weak. Qualification measures seam latency; FLAC duration padding fix (`isFlac` hardcoded false bug noted) belongs to web player only - out of scope for strict mode.
- Format-changing transitions: accept and display a short device reconfiguration pause ("Device switched to 96 kHz"). Never call resampled-crossfade output gapless-bit-perfect.
- PCM <-> DSD(-as-PCM x8) transitions: always treated as format-changing (reopen).
- Prefetch stays as-is (2-item queue + prefetch-playlist) - buffering is orthogonal to integrity.

---

## 14. Device profiles (per-device settings) - recommended, P1+

Keying strategy: primary key = mpv device id string (e.g. `coreaudio/BuiltInSpeakerDevice`, `wasapi/{guid}`); secondary association by normalized description for resilience after replug (USB enumeration order instability). Stored map: `deviceId -> { policyOverride?, maxRate?, dsdBehavior?, notes? }`. Migration-free addition to settings store. UI entry points: device picker rows ("Configure..."), Signal Path popover ("Remember Bit-Perfect for this device"). Auto mode ("Best Quality") deferred to P2: external-DAC heuristic (not builtin/bluetooth/airplay by name/classification where available) choosing exclusive policy, never claiming verified without evidence.

---

## 15. DSD feasibility (honest)

| Question | Answer (evidence) |
|---|---|
| Formats Navidrome indexes | .dsf yes (TagLib 2); .dff no by default (PR rejected; admin mime override possible) |
| Direct-stream | Yes, raw bytes as audio/x-dsf via format=raw |
| mpv decode | DSF/DFF demux + dsd2pcm -> float32 PCM at rate x8 (DSD64 -> 352.8 kHz). This is a DSD-to-PCM converter, not DSD passthrough |
| DoP packing | Not implemented anywhere in mpv (source: no DoP code, ad_spdif excludes DSD) |
| Native DSD out | Not implemented (no ao_dsd) |
| Platforms | Irrelevant until mpv supports output; x8-rate PCM rides existing paths |
| DAC capability discovery for DSD | mpv exposes nothing; would need native APIs (out of scope) |
| Feishin behavior | Play .dsf via raw stream; Signal Path shows `DSD -> PCM (x8 rate, dsd2pcm)`, integrity capped at processed/converted-DSD; never labeled bit-perfect-DSD |

Recommendation: classify DSD as **converted-PCM support** (P2 labeling + matrix testing), and record an ADR that native-DSD/DoP is formally out of scope for the mpv-based architecture (revisit only if upstream mpv grows support). SACD ISO: not indexable by Navidrome; skip.

HDCD/de-emphasis: both available as lavfi filters (hdcd, aemphasis type=cd). Terminology: `source-faithful decode` entries, off by default, explicit Signal Path display, require >= 20-bit-safe output. P2.

---

## 16. Analysis/measurement architecture (later phase)

Fully offline, never in the playback path:

```
fetch raw bytes (format=raw, cached temp file or ranged reads)
  -> ffprobe (container/codec sanity)
  -> ffmpeg filters: astats (DC offset, peak, RMS), ebur128 (LUFS-I, LRA), 
     bandwidth scan via highpass/lowpass sweep or spectrogram matrix, 
     effective-bit-depth via noise-floor heuristic, crest-factor DR windows
  -> JSON results -> idb-keyval cache keyed (serverId, songId, size, modifiedAt)
UI: analysis panel per track/album batch job; library columns optional
```

Runner choice: spawn system ffmpeg binary if present (Feishin already bundles/locates mpv; ffmpeg may not exist -> graceful "analysis unavailable" + optional bundled ffmpeg in packaging later). WASM ffmpeg rejected: huge bundle, slow. Server-side: out of scope. Fake hi-res detection = bandwidth + noise-floor classification, worded neutrally (mirroring VeraVox FAQ stance). Software-level bit-transparency self-test: `mpv --ao=pcm` render of a generated WAV vs reference hash - runs in CI-style integration tests without hardware.

Visualizers: current mpv-path visualizers depend on OS loopback capture, which is impossible under exclusive (already blocked today - precedent reused). Strict mode: visualizers off. Enhanced VeraVox-style instruments (vectorscope/spectrogram) ride the same availability rule and land P2/P3 using the existing visualizer component framework.

Event log: ring buffer (last N=500) in AudioStateService: device opened/lost, exclusive acquired/failed, rate changed, transcode detected, filter toggles, strict invalidated, mpv restart, AO reloads. Exposed in inspector advanced tab; not surfaced to casual users.

---

## 17. Testing strategy

| Layer | Scope | Tooling |
|---|---|---|
| Unit | policy resolver, invariant evaluator, evidence merging, reducer composition, format-comparison table, URL builders (raw/static), verification heuristics | vitest, pure functions, no mocks of mpv |
| Integration (real mpv) | spawn mpv with null/pcm AO + fixture files (generated sine FLAC/WAV matrix 16/44.1 ... 24/192, 32-bit, multichannel): assert audio-params/out-params transitions, af round-trips, gapless behaviors per §13 matrix, end-file reasons, observation of all properties, restart recovery, second-client coexistence | vitest + tmp sockets; fixtures generated by ffmpeg at build time (devDependency) |
| Bit-transparency harness | `--ao=pcm` dump vs ffmpeg-decoded reference WAV: byte-identical for strict-configured chain across the format matrix; proves decoder+chain transparency at software level | CI-runnable (linux/mac/windows runners) |
| Policy matrix tests | BP+EQ invalid; BP+RG invalid; BP+vol70 invalid; BP+vol100 valid; BP+server-transcode invalid; Exclusive+EQ valid-but-processed; every cell of §9 | table-driven unit tests |
| Transition matrix | 44.1->44.1, 44.1->48, 48->96, 96->44.1, same album gapless, format-changing | integration |
| Manual qualification scripts | scripted checklist per platform: builtin/USB DAC/disconnect/sleep-resume/contention (documented procedures; contention reproducible with two mpv instances as in probes) | docs/qualification/*.md |
| Hardware-level bit-perfect | Explicitly out of automated scope; documented loopback procedures (BlackHole/VB-Cable/SPDIF) for maintainers; software vs driver/API vs hardware verification tiers stated in UI copy | documentation |

Performance gates: property-change coalescing (100 ms), no polling loops added (event-driven only), Signal Path popover renders from store selector, event log bounded.

---

## 18. Migration plan (vertical slices, each shippable)

| Phase | Slice | Contents | Depends on |
|---|---|---|---|
| 1. Observability | MpvIpcConnection + AudioStateService + snapshot events + event log ring + integration test harness | Read-only; zero behavior change | - |
| 2. Domain core | signalpath/ module (policy, invariants, reducer, evidence) + unit tests + settings schema additions (policy preset) | Pure TS | 1 |
| 3. Signal Path MVP | Badge + popover wired to store; verification heuristics for server stage; `DSP: None` states | 1,2 | 
| 4. Exclusive reliability | AO pinning args, exclusive failure taxonomy (contention/unsupported), strict-stop UX skeleton, per-platform quirk handling (mono-coreaudio workaround: avfoundation fallback or stereo-force notice) | 2 |
| 5. Strict PCM | format=raw/static URL builder + verification, property pins (unity/no-RG/no-af/weak), control disabling, mute-remap, strict fallback completion | 3,4 |
| 6. Transitions | rate-switch events, gapless verification, device-transition display, transition matrix tests green | 5 |
| 7. Device profiles | per-device settings, capabilities panel (macOS log-derived formats first), remember-policy-per-device | 5 |
| 8. Stream Inspector | advanced modal, diagnostics copy, event log viewer | 3 |
| 9. Analysis | ffmpeg sidecar runner, cache, panels, fake-hi-res wording, software bit-test tooling promotion | 2 |
| 10. DSD labeling + experiments | dsf handling, converted-DSD labeling, matrix testing; close/keep-open decision on native DSD | 5 |

Phases map onto the originally sketched ordering with two adjustments justified by findings: observability precedes everything (it is the dependency of both policy validation and UX), and exclusive reliability is separated from strict enforcement because contention behavior differs per OS and must be proven before strict promises are made.

---

## 19. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Overclaiming bit-perfect | Reputation-critical | Evidence-tier system; verified requires confirmed-only chain; shared route hard-capped; copy reviewed against glossary definitions |
| Platform behavior drift (mpv updates, macOS AO defaults changed under us once already: avfoundation) | High | Pin `--ao` when policy demands; current-ao assertion; version watchlist (manual warns default AO may change); integration suite runs real mpv |
| USB DAC variability (formats, contention, driver quirks) | Medium-High | Qualification scripts; typed failure taxonomy; honest unknown rendering |
| gapless vs rate switching tension | Medium | weak-only in strict; documented seam expectations; transition matrix tests |
| Network streaming fragility (sleep/wifi/server restart) | Medium | Existing reconnect args retained; cache-state surfaced in inspector; strict stop only on integrity-affecting failures, not transient buffers |
| Electron lifecycle (quit races, resume rebuilds) already fragile (suppression machinery, SIGKILL fallbacks) | Medium | Supervisor consolidates lifecycle handling; reuse suppression machinery for observation-only connection |
| Regression risk to existing playback | High if careless | Dual-client isolation (phase 1 touches no command paths); phases independently shippable; full engine test pass each phase |
| Maintenance burden of owned IPC layer | Low-Medium | ~400 LOC single-purpose module; deletes node-mpv dependency eventually (net-negative LOC) |
| node-mpv/command-path divergence during dual-client period | Low | Supervisor serializes mutations through one code path even if transport differs |
| i18n burden of new strings | Low | Flat en.json additions following existing keys; translations via Weblate as customary |

---

## 20. Unknowns requiring prototypes

| # | Question | Why docs insufficient | Experiment | Decision affected |
|---|---|---|---|---|
| U1 | Windows WASAPI exclusive: rate-switch timing, contention error shape, formats across real DACs | No Windows machine used in research; behavior differs materially from macOS | Scripted qualification on Win10/11 + USB DAC (reuse probe scripts; PowerShell spawn) | Phase 4 error taxonomy; §5 matrix cells |
| U2 | PipeWire exclusive flag effect across session managers (wireplumber default vs ProAudio) | Session-manager dependent, undocumented per distro | vm or bare-metal Linux: pw-dump before/after; measure rate-following with allowed-rates set/unset | Linux strategy in §12; whether exclusive is offered on Linux at all |
| U3 | Reliability of parsing macOS physical-format info from v-level logs (multi-line ASBD, localization, future mpv changes) | Logs are not an API | Parse probe logs; fuzz across mpv 0.38-0.41; decide confidence tier | DAC capability panel feasibility (Phase 7) |
| U4 | End-to-end DSF via Navidrome raw + mpv on all platforms; x8-rate output on devices lacking 352.8k | Requires real .dsf library + DAC rate probing | Add dsf fixtures to integration harness; manual DAC check | DSD labeling claims (Phase 10) |
| U5 | Runtime `audio-device` write vs full MPV_RELOAD for device switching under strict (does reload preserve queue/seam acceptably?) | Docs say "scheduled reload"; Feishin currently restarts whole process | Probe: write property mid-playlist, measure gap, queue continuity vs existing reload cycle | Device-switch UX implementation choice (Phase 4/7) |
| U6 | Lavfi analysis filters (ebur128/astats/showspectrum) usable as NON-destructive side-taps in realtime | Filters sit IN the chain (would alter path); no documented tap mechanism | Prototype parallel mpv instance reading same URL? / offline-only confirmation | Whether ANY realtime instrument survives strict (else all visualizers stay off in strict - likely outcome) |
| U7 | Same-seam audibility: measure actual gap at rate-change reopen (block time) to set UI expectations | Unmeasured | Integration timer around None-gap on transitions | Copy for device-transition state; whether to offer "gapless-priority" standard sub-option |
| U8 | Navidrome older-version raw compliance floor | Master source only | Spin up 0.50.x/0.54.x containers; verify format=raw + headers | Minimum-server documentation; verification heuristic tuning |

---

## 21. ADRs to record (after approval, via domain-modeling workflow)

1. mpv remains the sole audio engine; no native playback helpers (conditions for exception documented)
2. node-mpv integration: dual-client observability strategy; consolidation criteria
3. Playback policy model: three presets, policy-vs-state separation
4. Integrity-status definition: decoded-PCM transparency definition, precision-preserving conversions table, verified-vs-eligible evidence rule
5. Signal Path evidence model: four confidence tiers and anti-overclaim rules
6. Strict fallback rules: no silent downgrades; typed failure taxonomy
7. Gapless vs native-rate priority: weak-only under strict; rate-change seams accepted
8. DSD scope: converted-PCM only; native DoP out of scope pending upstream mpv
9. Direct-stream enforcement: format=raw default for LOCAL player; verification heuristics as canonical truth
10. Mute-under-strict decision: pause-remap default (with opt-out)

Plus CONTEXT.md glossary entries for the §7 terms.

---

## 22. Recommended tickets (logical breakdown for /to-spec -> /to-tickets)

Grouped by phase; each sized for one focused PR.

**Foundation**
- T1 Test infrastructure: mpv fixture generator + integration harness (spawn, IPC client, assertions) + CI wiring
- T2 MpvIpcConnection (owned JSON IPC client, second-connection, event bus) + unit/integration tests
- T3 AudioStateService: observer registry, snapshot derivation, coalesced renderer events, event-log ring
- T4 signalpath domain module: types, evidence wrappers, policy resolver, invariant evaluator + full unit matrix
- T5 Settings schema: policy preset + migration; settings UI section skeleton

**Signal path**
- T6 Reducer + audio.store wiring; SignalPathBadge + popover MVP
- T7 Server-stage verification (headers + size + metadata cross-check) + transcoded detection events
- T8 Stream Inspector advanced modal + diagnostics copy + event log viewer

**Exclusive + strict**
- T9 Policy-driven startup args (AO pinning, exclusive flags) + typed exclusive-failure taxonomy
- T10 Strict-stop UX: typed error screens, "continue in Standard" affordance, no-fallback guard in engine dispatcher
- T11 Direct-stream URL builders (format=raw / static=true) + LOCAL-player default change + verification wiring
- T12 Strict property enforcement (unity gain, no RG, no af, weak gapless, speed pin) + live revalidation on snapshot changes
- T13 Control disabling + mute-remap + invalidation toasts per §9 table

**Transitions + devices**
- T14 Rate-switch/device-transition events + gapless verification tests (transition matrix green)
- T15 Per-device profile storage + picker integration + remember-policy
- T16 Device capabilities panel (macOS log-parse tier first; honest unknown elsewhere)

**Later**
- T17 Event-log polish + perf gates audit
- T18 Analysis runner (ffmpeg sidecar) + caching + panels + neutral fake-hi-res wording
- T19 Software bit-transparency self-test tooling (user-facing diagnostic)
- T20 DSD: dsf handling + converted-DSD labeling + matrix tests
- T21 HDCD/de-emphasis as declared-decode options
- T22 (decision ticket) command-path consolidation onto owned client; delete node-mpv dep
- T23 Auto/Best-Quality device policy (deferred from Phase 7)

Dependency spine: T1 -> T2 -> T3 -> (T4,T6) -> T5 -> T9/T11/T12 -> T10/T13 -> T14..; T7/T8 branch off T6.

---

## Appendix A: empirical probe log (condensed)

| Probe | Result |
|---|---|
| P1 | Device list: per-AO entries `coreaudio/BuiltInSpeakerDevice`, `avfoundation/BuiltInSpeakerDevice`; names/descriptions only |
| P2 | Shared avfoundation: out-params follow SOURCE rate (44.1k->44.1k, 96k->96k) with silent server conversion; AO teardown (None) between differing-rate loads under weak |
| P3 | gapless=yes: appended 48k after 44.1k kept out-params at 44.1k (resampled) |
| P7 | `--ao=coreaudio --audio-exclusive=yes` -> redirected coreaudio_exclusive, 96k physical switch, float32 chosen on speakers |
| P8/P11 | avfoundation accepts audio-exclusive=yes silently (no exclusive semantics); no warning |
| P12 | Plain coreaudio shared fails on mono streams (channel-layout error); stereo fine |
| P13 vs P14 | yes=resample-on-rate-change; weak=reopen-at-new-rate (empirically separated) |
| P15 | Exclusive init succeeds while afplay holds shared output (hog takeover); enumerates physical formats; sets physical format; restores on exit |
| P15b | Second exclusive instance while first holds hog: "failed to set hogmode" -> AO init failure -> no sound |
| Same-rate | weak keeps device open across same-rate boundary: no out-params change through track transition |
| P5 | af set/add/read-back round-trips; labeled lavfi filters listed; auto-inserted conversions absent |
| P6 | volume-max default 130; volume property writable at runtime |

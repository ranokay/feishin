# Hi-Fi audio performance budget

The audiophile subsystem (observation client, Signal Path UI, event log) is
event-driven and bounded. The budget in the plan (section 17) is: property
broadcasts coalesce at 100 ms, no polling loops are added, Signal Path renders
from a stable store selector, and the event log is bounded.

## Budget and enforcement

| Gate | Budget | Mechanism | Regression guard |
| --- | --- | --- | --- |
| Snapshot broadcast rate | At most one broadcast per 100 ms window, independent of property-change bursts | `AudioStateService.scheduleBroadcast` keeps a single pending timer; `publishImmediately` bypasses it only for strict-critical evidence (engine failure, transcode verdict) | `tests/audio-state.test.ts`: "coalesces rapid property changes into a single broadcast within the interval", "bounds the event ring and broadcast rate under rapid device flapping" |
| Event log memory | 500 entries (`DEFAULT_EVENT_LIMIT`), oldest evicted; clearing is explicit | `AudioStateService.pushEvent` splices to the limit; `clearEvents` empties the ring | `tests/audio-state.test.ts`: "caps the event log ring at the configured limit keeping newest entries", "clears the event log without resetting event ids" |
| Signal Path render frequency | A snapshot that advanced only `sequence`/`timestamp`, or whose re-created arrays hold equal values, does not re-render subscribers | `audioSnapshotsEqual` is the equality function of the `useAudioSnapshot` selector | `tests/audio-snapshot-stability.test.ts` |
| Inspector event refresh | The event log is fetched on mount and when `lastEventId` advances, never on every broadcast | `snapshot.lastEventId` is the effect dependency in `StreamInspectorModal` | `tests/audio-state.test.ts` covers `lastEventId`; the dependency itself is covered by review |
| Diagnostics report | At most the last 50 events | `buildDiagnosticsReport` slices `EVENT_TAIL_LIMIT` | `tests/diagnostics.test.ts` |
| Polling | None; mpv pushes properties, logs, and events | Fixed `OBSERVED_AUDIO_PROPERTIES` list plus event subscriptions | code review |

## T17 audit (2026-10-02, issue #18)

Two render-frequency problems were found and fixed:

1. The renderer compared snapshots with `shallow` over an object whose array
   fields (`strictPropertyViolations`, physical formats) are re-created by
   `deriveSnapshot` on every broadcast. Equal content still compared unequal,
   so Signal Path consumers re-rendered at the coalescing rate (~10/s) during
   playback. `audioSnapshotsEqual` now compares structurally.
2. The Stream Inspector refetched the whole event log on every broadcast. It
   now refetches only when `snapshot.lastEventId` advances, and it gained a
   search field, a clear action, and the existing category/severity filters.

The flapping stress test drives 3000 device open/loss cycles with matching
device and output-params changes through the service: the ring saturates at
exactly 500 entries while broadcasts stay at one per 100 ms window (at most 62
over the run), so memory and notify cost do not grow with event volume.

## Manual CPU check (per release candidate, per platform)

Automated coverage asserts the mechanisms above, not CPU percentages, which
vary by machine and build. To confirm the CPU idle delta:

1. Start local playback of a lossless track and open the Signal Path popover.
   Leave the app otherwise idle for 60 seconds.
2. Record the renderer and main process CPU time (`top -pid <pid>`, Activity
   Monitor, or the Electron process list).
3. Close the popover and repeat the 60 second idle window.
4. Expected: the delta stays within measurement noise (~0%). The snapshot
   broadcast rate is capped by the 100 ms coalescing window, and the UI skips
   broadcasts that did not change snapshot identity.
5. If a delta appears, capture a profile. The likely regressions are a
   subscriber that bypasses `useAudioSnapshot` or an effect keyed on
   `snapshot.sequence` instead of a signal-bearing field.

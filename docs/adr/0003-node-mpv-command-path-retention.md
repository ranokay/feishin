# ADR-0003: node-mpv keeps command duty; consolidation is deferred with triggers

Status: Accepted (T22, issue #23)

## Context

Since T2 (issue #27) the app runs two JSON IPC clients on the same mpv process. The pinned `node-mpv` fork spawns mpv and carries every command. The owned `MpvIpcConnection` (`src/main/features/core/player/mpv/ipc-client.ts`) exists for observability: property observation, log messages, start-file/end-file/audio-reconfig events, and the AudioSnapshot feed. The approved plan (§8.1, §8.3, §21.2) chose this arrangement to keep new risk inside read-only paths and deferred the question of moving commands onto the owned client to this ticket: decide on evidence whether to migrate all command traffic and delete the dependency.

## Evidence

The main player module (`src/main/features/core/player/index.ts`) calls 20 node-mpv methods as of this decision: `start`, `quit`, `isRunning`, `play`, `pause`, `stop`, `next`, `prev`, `seek`, `goToPosition`, `load` (replace/append), `clearPlaylist`, `getPlaylistSize`, `playlistRemove`, `setProperty`, `setMultipleProperties`, `getProperty`, `volume`, `mute`, and `getTimePosition`. The dependency also owns process spawn and binary/socket setup, the 1 s time-position timer (`time_update`), the playback event shims (`status` for `playlist-pos`, `resumed`, `stopped`, `paused`, `timeposition`), and the numeric error taxonomy (errcode 0-9) that handlers map to toasts and use for `errcode === 3` busy-idle handling in `player-get-time`.

The owned client, 236 lines at this decision, connects with retry, correlates request ids, enforces timeouts, dispatches any event name, and exposes `observe`, `unobserve`, `enableLogMessages`, and `onClose`. It has no process spawn, no command helpers, no playback event shims, and no error taxonomy. It already observes `playlist-pos`, `volume`, and `mute`, but not `pause` or `time-pos`.

The owned client shipped in T2 and has served every observability feature since T3: strict pins and repair (T12), exclusive failures (T9), strict stop (T10), transitions (T14), per-device profiles (T15), capabilities (T16), the event log (T17), analysis (T18), bit-transparency tooling (T19), DSD (T20), and source decodes (T21). `tests/mpv-ipc-client.test.ts` covers the transport, and `tests/harness/mpv-test-process.ts` already spawns real mpv and connects the owned client. No command-duty defect surfaced while issues #2 through #22 were implemented and reviewed; the plan's recorded motivation for the owned client was observability (§1: no raw end-file events, no log messages, and private-field casts for process control), not command failure.

The known friction pre-dates this decision. Process kills reach through private fields (`(mpv as any).process || (mpv as any).mpvProcess`, three sites). `quit()` can hang on a wedged queue, so it runs against a 3 s `QUIT_TIMEOUT_MS` race with a direct kill fallback (upstream fix #2172). End of track is inferred from `playlist-pos` going to -1 because node-mpv exposes no `end-file`; the inference needs the `suppressRendererPlaybackEvents` generation machinery around quit and restart. `getTimePosition()` failures are classified by numeric errcode. Feishin fixed this integration repeatedly before the campaign (#1348 exit handlers, #1360 clear, f3a6027e progress interval, #2399 stale commands, #1768 auto-next and queue replacement). A rewrite would have to reproduce those semantics.

The dependency is pinned to `github:jeffvli/Node-MPV#32b4d643`, the fork's default-branch head (authored 2023-07-19, committed 2024-08-28). Upstream `j-holub/Node-MPV` last received a push in April 2023 and has 21 open issues. The pinned implementation is 2,467 lines across 15 files plus 830 lines of typings. It is a local IPC wrapper with no runtime network surface.

## Decision

Keep node-mpv as the command and process-lifecycle client. `MpvIpcConnection` stays observability-only. Feishin creates no migration work now.

The migration would be mechanical, since commands are JSON arrays that `rawRequest` already supports, but not small: process spawn and exit handling, command helpers for the 20 used methods, playback event shims, and error classification, then parity proof on the most user-visible surface in the app. No current capability needs it, and none of the triggers below has fired.

Revisit when any of these is true:

- A command-path defect cannot be fixed at the pinned commit because the fork and upstream are unresponsive.
- An mpv release breaks the pinned node-mpv integration on the command path.
- A real dual-client divergence incident occurs, or production paths need semantics only the owned client can provide, such as driving queue advancement from real `end-file` events instead of the `playlist-pos` inference.
- The pinned tarball stops installing.
- The player module is overhauled for another reason, so the extra migration risk is marginal.

If a trigger fires, migrate expand-contract: extend the owned client with spawn and command parity, run a shadow phase that compares read-only requests and serialized command shapes without replaying mutating commands, cut whole command classes over atomically, then delete node-mpv and the workarounds listed above (private-field kills, quit timeout race, `playlist-pos` end-of-track inference, errcode mapping). Create the follow-up tickets at that point, one phase each.

## Consequences

- The dual-client arrangement and its documented workarounds stay. No behavior changes now.
- The dependency stays pinned. A future bump must keep an exact commit and pass the real-mpv integration tests.
- This records the consolidation criteria from plan §21.2. The triggers are the standard for reopening the question.

# ADR-0002: HDCD and CD de-emphasis are explicit source-faithful decode opt-ins

Status: Accepted (T21, issue #22)

## Context

HDCD expansion (`hdcd`) and CD de-emphasis (`aemphasis=type=cd`) are lavfi filters mpv exposes through `af`. They are source-faithful decode steps rather than user DSP: HDCD reconstructs samples the encoder compressed, and de-emphasis reverses the pre-emphasis a CD was mastered with. Both are off by default.

The approved plan (§9, invariant 7) expects the Bit-Perfect `af` chain to stay empty, with the controls disabled. Issue #22 refines that: under Bit-Perfect these two decodes are intentional transformations that are allowed with an explicit opt-in and must be clearly displayed, never applied silently.

## Decision

- Both decodes are playback settings (`playback.sourceDecode`), disabled by default. Enabling a setting is the explicit opt-in; nothing is auto-detected or auto-applied. Changing an option re-initializes mpv so the engine chain, the applied `af`, and the main-process strict pins agree on the same opt-in.
- Under Bit-Perfect the engine applies only the opted source-decode entries; EQ, compressor, ReplayGain, speed, and gain stay suppressed.
- While a decode is opted in, the strict `af` pin is lifted. The other pins (volume, replaygain, speed, audio-samplerate, gapless-audio) stay pinned and repaired. Cost if wrong: `af` drift from another IPC client is not auto-repaired while an opt-in decode is active; the Signal Path still shows the observed chain and the integrity verdict can never claim bit-perfect.
- An active decode appears in the Signal Path as a `declared-decode` entry with the observed evidence tier. A source-declared pre-emphasis whose de-emphasis option is off shows as `declared not applied` (inferred tier) instead of disappearing.
- HDCD output is 20-bit. When the observed output format cannot carry 20 bits (for example a forced `s16` output), the Signal Path adds a format-conversion entry; it never presents the truncated expansion as transparent.
- De-emphasis declaration reads Navidrome's native `tags` (keys normalizing to `preemphasis`, `cdpreemphasis`, `deemphasis`, `cddeemphasis` with a truthy value). Servers that do not surface tags declare nothing; the option can still be enabled manually.

## Consequences

- Bit-Perfect eligibility rules for source decodes: an opted decode is allowed, deliberately caps the verdict at `processed` / `exclusive-processed`, and is displayed; with no opt-in the strict `af` pin and the empty-chain invariant are unchanged.
- Tag-based de-emphasis only exists where the server exposes file tags (Navidrome native). Subsonic/Jellyfin return no tags, so no declaration is invented there.
- The synthetic HDCD fixture generator in `tests/fixtures/audio-fixtures.ts` embeds a valid format-A packet by inverting the filter's LSB scan, so the decode path is exercised in CI without a licensed HDCD sample.

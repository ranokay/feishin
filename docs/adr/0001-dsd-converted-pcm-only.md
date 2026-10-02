# ADR-0001: DSD playback is converted PCM only; native DSD/DoP stays out of scope

Status: Accepted (T20, issue #21)

## Context

Navidrome indexes `.dsf` files (TagLib 2) and serves their raw bytes (`format=raw`, `audio/x-dsf`); `.dff` is not indexed by default. mpv decodes DSF/DFF through its FFmpeg decoder (`dsd2pcm`) to float32 PCM at the carrier rate divided by 8: DSD64 (2822400 Hz carrier) becomes 352800 Hz PCM.

mpv has no native DSD output and no DoP (DSD over PCM) packing: there is no `ao_dsd`, and the S/PDIF codec list excludes DSD. True DSD passthrough would need a second audio engine or upstream mpv support, both outside this architecture (mpv remains the only engine).

## Decision

- DSD is supported as converted PCM only: raw `.dsf` streams decoded by mpv's dsd2pcm.
- The Signal Path labels the conversion explicitly with both rates (`dsd2pcm: <carrier> Hz carrier -> <pcm> Hz PCM`) when the server declares the carrier, and never claims bit-perfect for DSD-derived output, including when the output device cannot accept the x8 PCM rate and forces a resample.
- Native DSD output and DoP packing are out of scope. Revisit only if upstream mpv grows native DSD/DoP support.

## Consequences

- Servers may declare either the DSD carrier rate (Navidrome/TagLib report the carrier) or the x8 PCM rate; mpv's demuxer always reports the x8 PCM rate. That pair is an expected conversion, never a server-side transcode or an integrity resampling mismatch, and the route/integrity logic treats it accordingly.
- The converted-PCM cap is a permanent property of the DSD path, not a degraded mode: conversion is the deliverable and is labeled as such.

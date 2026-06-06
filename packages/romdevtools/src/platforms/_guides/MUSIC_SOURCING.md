# Getting music into a game (cross-platform sourcing guide)

How to turn music — a chiptune, a tracker module, a VGM log, or **arbitrary audio
(a WAV/MP3)** — into something a game on each system actually plays. Read this to
pick the right path; it tells you what romdev does in-process vs. which optional
external tools to install for the harder cases.

## The one fact that decides everything: sample playback vs. synthesis

Retro sound hardware splits in two, and "can I play my actual recording?" depends
entirely on which kind the target is:

- **Sample-capable** (Genesis PCM, SNES, GBA): the chip can play back a digitized
  audio *sample*. You CAN put arbitrary audio on these — resampled, lo-fi, short,
  but it's your real recording. romdev does this in-process.
- **Synthesis-only** (NES, SMS/GG, Genesis-FM-only, C64 SID, PCE, Lynx): the chip
  GENERATES tones (square/triangle/noise/FM/SID). It has nowhere to put a
  recording. To get "your song" on these you must **transcribe** the audio into
  notes the chip synthesizes — a lossy, approximate, separate analysis step.

So: arbitrary WAV → game music is *direct* on the sample systems and *transcribed*
(lossy) on the synthesis systems. There is no way around this; it's the hardware.

---

## Path A — structured music you already have (chiptune / tracker / VGM)

This is the clean case. romdev compiles it in-process, no external tools:

| You have | System | romdev (in-process) |
|---|---|---|
| `.vgm` / `.vgz` | Genesis | `encodeAudio({target:'xgm2'})` → `XGM2_play()` |
| `.xm`/`.mod`/`.it`/`.s3m` | GBA | `encodeAudio({target:'maxmod'})` → Maxmod `mmStart()` |
| FamiTracker `.txt` export | NES | `encodeAudio({target:'famitone'})` → FamiTone2 driver |
| WAV/PCM (a sound) | SNES | `encodeAudio({target:'brr'})` (BRR sample) |
| WAV/PCM (a sound) | Genesis | `encodeAudio({target:'xgm2pcm'})` (PCM SFX) |

(These are faithful ports of the standard tools — SGDK's xgm2tool, devkitPro's
mmutil, FamiTone2's text2data — so no Java, no native binary, no devkitPro needed.)

---

## Path B — arbitrary audio (WAV/MP3) → SAMPLE music (Genesis / SNES / GBA)

Works directly. Install **ffmpeg** (the only external tool needed) to conform any
file to the chip's spec, then feed romdev's sample encoders:

```
ffmpeg -i song.mp3 -ac 1 -ar 13300 -f s8 song.raw     # Genesis: mono, ~13.3kHz, 8-bit signed
  → encodeAudio({target:'xgm2pcm', format:'pcm16'|..., ...})
# SNES (BRR): resample to your playback rate, then encodeAudio({target:'brr'})
# GBA (Direct Sound): resample to your mixing rate, play as a sample
```

Result: your actual audio, **crunchy and short** (ROM-space bound, low sample
rate), but recognizably the song. ffmpeg is optional — romdev's sample encoders
also take raw PCM directly if you resample some other way.

- **ffmpeg** — https://ffmpeg.org — decode/resample/downmix any format → raw PCM.
  The universal front-end. Install: `brew install ffmpeg` / `apt install ffmpeg`.

---

## Path C — arbitrary audio → SYNTHESIS music (NES / SMS / C64 / …) = transcription

The chip can't play your recording, so you transcribe it to notes, then compile
those. This is **lossy and approximate** — great on a clean monophonic melody/solo,
rough on a dense full mix. The chain uses optional open-source helpers (none
bundled; suggest by name + install + license):

**Step 1 — audio → MIDI (the hard MIR step):**
- **Spotify Basic Pitch** — https://github.com/spotify/basic-pitch — Apache-2.0,
  `pip install basic-pitch`. Neural audio→MIDI; best free general-purpose one,
  polyphonic, handles real instruments. The headline helper for "my song → notes."
- **aubio** — https://aubio.org — GPL. Lighter onset/pitch/tempo/BPM detection;
  good for monophonic melody + tempo extraction.

**Step 2 — MIDI → the format romdev's compiler ingests:**
- **NES:** **FamiStudio** — https://famistudio.org — MIT, has a **CLI**. Imports
  MIDI, exports FamiTone2/FamiStudio data directly. (romdev's `target:'famitone'`
  compiles the FamiTracker *text* format in-process; FamiStudio is the documented
  MIDI front-end when you're coming from transcription.)
- **GBA / module systems:** **OpenMPT** — https://openmpt.org — BSD. Imports MIDI,
  exports `.it`/`.xm`/`.mod` → feeds `encodeAudio({target:'maxmod'})`.
- **Genesis / SMS (PSG):** a MIDI→VGM tool (e.g. **mid2vgm**-style utilities) →
  feeds `encodeAudio({target:'xgm2'})`.
- **C64 SID:** **GoatTracker** / SID-Wizard — GPL. MIDI import is limited; mostly
  hand-authoring. The roughest target.

**Honest expectation:** the output sounds like the song's *notes* played on the
chip's voices — not the original recording. Clean up the transcribed MIDI in a
tracker before compiling for anything beyond a simple melody.

---

## Quick decision

- Have a tracker module / VGM / FamiTracker txt? → **Path A**, in-process, done.
- Have a WAV/MP3 and the target is **Genesis/SNES/GBA**? → **Path B**: `ffmpeg` +
  the sample encoder. Your audio, lo-fi.
- Have a WAV/MP3 and the target is **NES/SMS/C64/synth**? → **Path C**: transcribe
  (Basic Pitch → tracker/FamiStudio → compiler). Lossy approximation.
- Want it to sound *good* on a synth chip? → compose/transcribe-then-edit in a
  tracker (OpenMPT / FamiStudio) and use Path A. Transcription alone won't.

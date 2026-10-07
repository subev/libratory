# TTS licensing — constraints that only bite if this becomes commercial

**Status as of 2026-08-22: nothing here restricts us today.** The project ships under
PolyForm Noncommercial 1.0.0, so every non-commercial license below is satisfied by
default. This file exists so the constraints are findable *before* any relicensing or
paid-hosting decision, rather than discovered afterwards with audiobooks already built.

**Deliberate deferral:** we are **not** excluding the non-commercial voices now. The
decision was to keep every voice available while the project stays noncommercial, and
revisit at the point commercialization is actually on the table. If you are reading this
because that day arrived, start with the "If we go commercial" checklist at the bottom.

The Pocket-TTS section is verified from the installed package's source; the rest is flagged
where it is not. Voice licenses are surfaced per-voice in the picker.

## Pocket-TTS (Kyutai) — shipped 2026-08-22, verified from source

**Model weights: CC-BY-4.0.** Commercial use permitted, attribution to Kyutai required.
No output restrictions, no revenue clause.

**HF gating terms** (accepted per-account at <https://huggingface.co/kyutai/pocket-tts>)
are acceptable-use, not commercial: no illegal/deceptive/fraudulent use, and specifically
no *voice impersonation or cloning without explicit, lawful consent*. That obligation
transfers to us as operator if we ever host cloning for other people — it needs ToS plus
a consent affirmation on upload. Only the cloning-capable weights are gated; the catalog
voices download unauthenticated from `kyutai/pocket-tts-without-voice-cloning`.

**The catalog voices carry mixed licenses.** They are embeddings of specific source
recordings, mapped in `pocket_tts/utils/utils.py` (`_ORIGINS_OF_PREDEFINED_VOICES`),
cross-referenced against the per-directory licensing in `kyutai/tts-voices`:

| License | Voices | Commercial |
| --- | --- | --- |
| CC0 — voice-donations, voice-zero (LibriVox) | marius, javert, bill_boerst, peter_yearsley, stuart_bell, caro_davy | Yes, unrestricted |
| CC BY 4.0 — VCTK, alba-mackenna | alba, anna, vera, fantine, charles, paul, eponine, azelma, george, mary, jane, michael, eve | Yes, with attribution |
| CC BY 4.0 — Common Voice (hosted in the model repo) | giovanni, lola, juergen, rafael | Yes, with attribution |
| **CC BY-NC 4.0 — expresso, ears** | **cosette, jean** | **No — non-commercial only** |
| Mixed bucket, unverified | estelle (`unmute-prod-website/`) | Needs checking |

`alba` is the default voice and is commercially clean.

**Why a flat/model-agnostic price does not dodge this.** NC turns on the nature of the
use, not on how the fee is allocated — "primarily intended for or directed toward
commercial advantage or private monetary compensation". Charging for hosting rather than
for the voice does not change that a paying customer's audiobook is a commercial use.

**Genuinely unsettled:** whether an NC license on a *conditioning sample* reaches the
*generated output* at all. The embedding is plausibly a derivative of the recording; the
generated audio is a step further removed. Arguable either way. The reason to comply
anyway is lopsided risk/benefit — the downside is a rights dispute over a commercial
product, the upside is two extra voices out of 26.

## Other engines — NOT verified, check before relying on any of this

- **Kokoro** (`kokoro:`) — believed Apache-2.0 weights, unverified in this pass.
- **macOS `say`** (`say:`) — Apple system voices. Whether their output may be
  distributed commercially is **unknown and worth real scrutiny** before any paid
  service exposes this engine. Probably the highest-risk unexamined item here.
- **Cartesia** (`cartesia:`) — commercial API, governed by their ToS rather than a
  content license. Paid tiers presumed to permit commercial output; confirm.
- **ElevenLabs** (`elevenlabs:`) — shipped 2026-08-25 against the **free tier**, which is
  10,000 credits a month (~10 minutes of multilingual audio), issues an API key with no
  card, and **excludes commercial rights while requiring attribution in anything public**.
  Commercial use starts at Starter ($6/mo). Credits are 1 per character on
  `eleven_multilingual_v2` and `eleven_v3`, 0.5 on `eleven_flash_v2_5`, so the model
  choice (`ELEVENLABS_MODEL`) doubles or halves what a free month buys. At list overage rates a
  ten-hour book is $25–50, which is why this engine exists for demos and samples rather
  than for a library.
- **Piper** (`bg-piper:`) — the engine (`piper-tts`) is GPL-3.0 and runs as a subprocess, so it
  does not reach Libratory's own licence. The `dimitar` voice is CC0 on a CC0 dataset, finetuned from
  the English `lessac` voice.
- **BgTTS-38M V2** (`bg-bgtts:`) — weights and code Apache-2.0; MioCodec MIT; WavLM base+ (pulled by
  MioCodec through torchaudio) MIT. The training data is the author's own Bulgarian set, whose
  sources the card does not state — check that before commercial use. The three voices are the
  reference clips the authors ship with the model.
- **MMS** — never examined. MMS is Meta-derived; check its
  license before commercial use.

## Business-model note that is not about licenses

Flat per-length pricing across user-chosen engines is unbounded on the cost side: the
marginal cost of one ~500k-character book ranges from ~free (Pocket-TTS, Kokoro, `say`)
through a few dollars (Cartesia) to $25–50 (ElevenLabs). A customer picking the most
expensive engine spends our margin. The clean fixes are BYO-key for paid cloud engines
and flat pricing only over the local ones.

## Deployment — the two shapes behave differently

Which obligations apply depends on who runs the software, and the split is not obvious.

**Self-hosted (user runs Libratory themselves).** The Pocket-TTS cloning weights are
gated per HuggingFace account, so **every user must make their own HF account and accept
Kyutai's terms**. We cannot accept on their behalf and cannot redistribute the gated
weights pre-cached. Our only obligation is telling them so in the README. The 26 catalog
voices need no account and no token — they download unauthenticated. Practical effect:
cloning is opt-in per install, catalog voices work out of the box.

**Hosted by us (paid or free).** Users never touch HuggingFace; our acceptance covers the
deployment. In exchange the consent rule becomes *ours to enforce* — a user uploading a
clip of a celebrity or an ex-partner is our compliance problem. That deployment needs
terms of service plus an explicit consent affirmation at upload time, not a bare file
picker. This is the single largest new obligation hosting would create.

**The two voices to remember: `cosette` and `jean`.** Both CC BY-NC 4.0 (expresso and
ears datasets). They are indistinguishable from the other 24 in the UI and nothing in the
library warns about them. Any paid deployment must drop or hard-gate them, and
`estelle`'s provenance (the mixed `unmute-prod-website/` bucket) must be resolved at the
same time. Everything else in the catalog is CC0 or CC BY 4.0 and safe to monetize with
attribution.

## If we go commercial — checklist

1. Drop or hard-gate `cosette` and `jean`; resolve `estelle`'s provenance.
2. Add an attribution page: Kyutai (CC-BY-4.0 weights), VCTK, Common Voice,
   alba-mackenna.
3. Resolve the macOS `say` question before exposing that engine to paying users.
4. Verify Kokoro and MMS licenses.
5. If cloning is offered: ToS + per-upload consent affirmation, per the Kyutai terms.
6. Re-verify the voice table above — upstream may have re-sourced voices since
   2026-08-21. Re-derive it from `_ORIGINS_OF_PREDEFINED_VOICES` and the `tts-voices`
   repo rather than trusting this snapshot.

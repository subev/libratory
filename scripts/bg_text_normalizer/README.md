Vendored from [raditotev/bg-text-normalizer](https://github.com/raditotev/bg-text-normalizer)
at `92e69b7`, MIT (see `LICENSE`). Pure Python, no dependencies, so every Python environment that
runs a Bulgarian-only narrator can import it from `scripts/` without installing anything.

Used only by the engines that read nothing but Bulgarian (`bg_speech.py`); the generic normalizer in
`packages/server/src/lib/normalizer.ts` stays language-neutral.

Local changes: the lev pattern in `bg_normalizer.py` (marked "Vendored change").

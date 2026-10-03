# Response to the conversion review of 83d4d97

2026-09-28. The [original review](bilingual-reader-review-83d4d97.md) is preserved unchanged.

## Fixed

1. **One-sided conversion eligibility.** The conversion guard now examines only lanes whose
   active recording is MP3. A suspended, failed or queued original with no recording does not
   prevent conversion of the completed translation. An absent translation recording does not
   prevent conversion of the original. A legacy lane with narration queued/running remains
   blocked; the existing publication checks still reject concurrent text, status, path or content
   changes. Failed/stopped narration with an intact recording and usable map can be converted.
2. **Disabled control and explanation.** Status returns `convertBlocked: string | null` from
   the same helper the mutation uses. The control disables itself and displays that reason in
   its title. Text pairing no longer unnecessarily disables audio conversion.

Four new one-sided regression cases failed against the previous implementation and pass after
this fix. Two additional tests check that the status reason and mutation refusal agree and that
no encoder runs while an affected lane is synthesizing. The mocked browser check verifies the
blocked control/title, then the explicit successful conversion after eligibility changes.

## Deferred / retained

- **Retained-file lifecycle — accepted, deferred.** The old MP3/map and superseded seek copies
  need tracked ownership so explicit audio deletion and re-synthesis can clean up obsolete
  generated files. They currently remain inside the book output directory and book deletion
  removes that directory. The current conversion promise preserves originals; this patch does
  not silently reverse it or delete existing backups. Add the cleanup/ownership work before
  closing the bilingual feature task. No broad directory sweep or new database schema is added
  as a quick fix.
- **Hashing under the publication lock — retained.** This checks actual bytes immediately
  before switching paths. A size/mtime-only substitution weakens that check. The review supplies
  no measured contention, so keep the existing correctness guard for now. If profiling shows
  meaningful lock contention, move hashing out with a verified file-version protocol and keep
  same-path content-change regressions; do not simply remove content checks.

Validation: the focused preparation/conversion suite passes **40 tests**, lint and typecheck
pass, and the focused mocked browser check passes. No real recordings, model calls or narration
were used. The full suite was not rerun in this budget-limited follow-up; the user requested fast
checks and remote full-suite validation. Existing full-check results apply to 83d4d97, not this
new patch.

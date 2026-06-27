# Media preview hardware checklist — headphone audition (ADR-0027)

Manual verification of the library preview: the 🎧 cue button on a song/sample
row auditions that item in the **headphones only**, never the master. The engine
audition source (`lib.rs`), the host command (`host.rs`), and the UI toggle
(`MediaExplorer` — unit-tested, incl. `audition_previews_into_the_cue_feed_only`)
are covered; this checklist is the last hop — real phones, real ears.

## Setup

- [ ] `just tauri-dev`, app open, headphones on the cue output (the FLX4 phones
      jack on ch 3/4, or a chosen cue device — see
      `split-cue-hardware-checklist.md`).
- [ ] At least one generated song (Generate tab) and one sample (Samples tab) in
      the library.

## Preview is heard in the phones, never the master

- [ ] On the Generate tab, press **🎧** on a song row: the song is audible in the
      **headphones**.
- [ ] The **master / speakers are silent** for the preview (nothing leaks to the
      audience), even with the cue-mix knob fully toward master.
- [ ] Same on the Samples tab: **🎧** on a sample row previews it in the phones.
- [ ] The preview **loops** until stopped (it does not play once and go silent).

## One preview at a time, and clean toggling

- [ ] Press **🎧** on a second row: the preview switches to the new item (the
      first stops); only one row shows the lit/active cue state.
- [ ] Press **🎧** on the same active row: the preview **stops** and the button
      returns to its idle state.

## Preview coexists with live decks, and yields to a load

- [ ] With **both decks playing out front**, start a preview: the master mix is
      undisturbed; the preview is heard only in the phones over (or blended with,
      per the cue-mix knob) the master monitor.
- [ ] While previewing, press **Load A/B** (or the rotary LOAD) on any row: the
      preview **stops** and the deck takes over.
- [ ] Switch away from the Media Explorer / close the pane while previewing: the
      preview **stops** (nothing keeps ringing in the phones).

## Level / sanity

- [ ] The preview is a flat monitor of the file (not through the deck channel
      strip): confirm it is a reasonable listening level and never clips the
      phones (the engine clip-guards the cue feed to the master ceiling).
- [ ] Preview a long song and a short one-shot sample: both behave (the long one
      keeps looping; the one-shot loops its short buffer) until stopped.

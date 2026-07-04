//! Controller LED feedback, driven from the store (ADR-0031).
//!
//! The byte builders port the FLX4/DDJ-400 scheme from the retired
//! `frontend/src/control/flx4.ts` `flx4Leds`: Pioneer buttons/pads light by
//! echoing their own status/note back, velocity 0x7F on / 0x00 off; pad
//! velocity doubles as brightness (bright 0x7F / dim 0x20 — the dim level is
//! provisional until the hardware pass measures it, docs/midi-ddj-flx4.md).
//!
//! The painter replaces the webview's App-side LED effects: it recomputes
//! every group from the [`InterfaceState`] snapshot (plus the engine's
//! truthful loop-slot state) and sends only the groups whose bytes changed.
//! A pad-mode switch clears the device's pad LEDs, so that (and a fresh
//! bind) forces a full repaint. Semantics carried over 1:1 from App.tsx:
//! the HOT CUE bank shows filled cues on a playback deck and style targets
//! (selection mask bright/dim) on a realtime deck; PAD FX lights the active
//! effect; SAMPLER lights filled slots; channel CUE mirrors the headphone
//! cue; transport CUE lights while primed off air.

use crate::store::{DeckSnap, FxKindSnap, InterfaceState};

use super::notes::pad_pitches;
use super::translate::{
    CHANNEL_CUE_NOTE, KEYBOARD_NOTE_BASE, LOOP_NOTE_BASE, NOTE_ON_STATUS, PAD_COUNT,
    PAD_FX_NOTE_BASE, PAD_MODE_PAIRS, PAD_STATUS, TRANSPORT_CUE_NOTE,
};

const PAD_LED_BRIGHT: u8 = 0x7f;
const PAD_LED_DIM: u8 = 0x20;

fn echo(status: u8, note: u8, on: bool) -> [u8; 3] {
    [status, note, if on { 0x7f } else { 0x00 }]
}

/// Light pads 1..count for a deck's style targets, the rest dark. With a
/// selection mask (the net), selected pads burn bright and the rest sit dim;
/// with no mask every target pad is lit full (the legacy behaviour).
pub fn style_target_pads(deck: usize, count: usize, selected: &[bool]) -> Vec<[u8; 3]> {
    (0..PAD_COUNT as usize)
        .map(|pad| {
            let velocity = if pad >= count {
                0x00
            } else if selected.is_empty() || selected.get(pad).copied().unwrap_or(false) {
                // No mask (or no net) keeps the legacy full-bright target pads.
                PAD_LED_BRIGHT
            } else {
                PAD_LED_DIM
            };
            [PAD_STATUS[deck], pad as u8, velocity]
        })
        .collect()
}

/// Light only the active effect's pad in the PAD FX bank (`None` = all dark).
pub fn fx_pads(deck: usize, active: Option<usize>) -> Vec<[u8; 3]> {
    (0..PAD_COUNT as usize)
        .map(|pad| echo(PAD_STATUS[deck], PAD_FX_NOTE_BASE + pad as u8, Some(pad) == active))
        .collect()
}

/// Light the filled loop slots in the SAMPLER bank.
pub fn loop_pads(deck: usize, filled: &[bool]) -> Vec<[u8; 3]> {
    (0..PAD_COUNT as usize)
        .map(|pad| {
            echo(
                PAD_STATUS[deck],
                LOOP_NOTE_BASE + pad as u8,
                filled.get(pad).copied().unwrap_or(false),
            )
        })
        .collect()
}

/// Light the filled hot cues in the HOT CUE bank.
pub fn cue_pads(deck: usize, filled: &[bool]) -> Vec<[u8; 3]> {
    (0..PAD_COUNT as usize)
        .map(|pad| echo(PAD_STATUS[deck], pad as u8, filled.get(pad).copied().unwrap_or(false)))
        .collect()
}

/// The KEYBOARD performance bank (issue #48): armed = every pad sits dim
/// (the bank reads as live at a glance), a pad whose triad is fully held
/// burns bright; disarmed = dark. Pitches→pads reverses through the deck's
/// key/scale — a keyboard-sourced hold that happens to complete a pad's
/// triad lights that pad too, which is honest (the deck IS playing it).
pub fn keyboard_pads(deck: usize, snap: &DeckSnap) -> Vec<[u8; 3]> {
    let perf = &snap.performance;
    let held: Vec<u8> = snap
        .notes
        .as_ref()
        .map_or(Vec::new(), |steering| steering.pitches.clone());
    (0..PAD_COUNT as usize)
        .map(|pad| {
            let velocity = if !perf.armed {
                0x00
            } else {
                let triad = pad_pitches(perf.key, perf.scale, pad);
                let all_held =
                    !triad.is_empty() && triad.iter().all(|pitch| held.contains(pitch));
                if all_held {
                    PAD_LED_BRIGHT
                } else {
                    PAD_LED_DIM
                }
            };
            [PAD_STATUS[deck], KEYBOARD_NOTE_BASE + pad as u8, velocity]
        })
        .collect()
}

/// The pad-mode selector LEDs: the active bank's button lit, the other three
/// dark. The device leaves these to the host (only the power-on HOT CUE
/// default is lit until we paint), and the shell is the only party that
/// knows the tracked bank. One message per PHYSICAL button: the active
/// bank's own note (plain or shifted layer) when it owns the button, the
/// plain note dark otherwise — so a dark shifted-layer write can never land
/// after (and clear) a lit plain-layer sibling on the same button.
pub fn mode_selectors(deck: usize, active: u8) -> Vec<[u8; 3]> {
    PAD_MODE_PAIRS
        .iter()
        .map(|&(plain, shifted)| {
            if active == shifted {
                echo(NOTE_ON_STATUS[deck], shifted, true)
            } else {
                echo(NOTE_ON_STATUS[deck], plain, active == plain)
            }
        })
        .collect()
}

/// Channel (headphone) CUE button LED for a deck.
pub fn channel_cue(deck: usize, on: bool) -> Vec<[u8; 3]> {
    vec![echo(NOTE_ON_STATUS[deck], CHANNEL_CUE_NOTE, on)]
}

/// Transport CUE button LED for a deck (lit while primed off air).
pub fn transport_cue(deck: usize, on: bool) -> Vec<[u8; 3]> {
    vec![echo(NOTE_ON_STATUS[deck], TRANSPORT_CUE_NOTE, on)]
}

fn fx_index(kind: FxKindSnap) -> usize {
    // The PAD FX pad order is the webview's FX_KINDS order (fx.ts), which the
    // snapshot enum mirrors declaration-for-declaration.
    match kind {
        FxKindSnap::Filter => 0,
        FxKindSnap::DubEcho => 1,
        FxKindSnap::Space => 2,
        FxKindSnap::Crush => 3,
        FxKindSnap::Noise => 4,
        FxKindSnap::Sweep => 5,
    }
}

/// One deck's LED groups, computed from the snapshot + the engine's loop
/// slots + the deck's tracked pad bank (the active selector's note). Pure,
/// so the semantics port is testable without a device.
pub fn deck_frame(deck: usize, snap: &DeckSnap, loop_filled: &[bool], bank: u8) -> Vec<Vec<[u8; 3]>> {
    // Exactly one painter per pad bank: cues on a playback deck (a track is
    // loaded), style targets on a realtime deck — the App.tsx rule.
    let hot_cue_bank = if snap.track.is_some() {
        let filled: Vec<bool> = snap.cues.iter().map(|cue| cue.is_some()).collect();
        cue_pads(deck, &filled)
    } else {
        style_target_pads(deck, snap.style_targets.len(), &snap.style_selected)
    };
    vec![
        hot_cue_bank,
        fx_pads(deck, snap.fx.kind.map(fx_index)),
        loop_pads(deck, loop_filled),
        keyboard_pads(deck, snap),
        channel_cue(deck, snap.cue),
        transport_cue(deck, snap.primed),
        mode_selectors(deck, bank),
    ]
}

/// The full LED frame for both decks — what the painter diffs and sends.
/// `banks` is the painter's per-deck tracked selector note (missing decks
/// fall back to the HOT CUE power-on default).
pub fn full_frame(
    state: &InterfaceState,
    loop_filled: &[Vec<bool>],
    banks: &[u8],
) -> Vec<Vec<[u8; 3]>> {
    state
        .decks
        .iter()
        .enumerate()
        .map(|(deck, snap)| {
            deck_frame(
                deck,
                snap,
                loop_filled.get(deck).map_or(&[][..], |f| &f[..]),
                banks.get(deck).copied().unwrap_or(PAD_MODE_PAIRS[0].0),
            )
        })
        .collect::<Vec<_>>()
        .concat()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{FxSnap, TrackIdentitySnap};

    fn deck_snap() -> DeckSnap {
        DeckSnap::default()
    }

    #[test]
    fn style_target_pads_light_count_and_mask() {
        // No mask: pads 0..count full bright, the rest dark (legacy).
        let msgs = style_target_pads(0, 3, &[]);
        assert_eq!(msgs.len(), 8);
        assert_eq!(msgs[0], [0x97, 0x00, 0x7f]);
        assert_eq!(msgs[2], [0x97, 0x02, 0x7f]);
        assert_eq!(msgs[3], [0x97, 0x03, 0x00]);
        // With the net mask: selected bright, unselected dim.
        let msgs = style_target_pads(1, 2, &[true, false]);
        assert_eq!(msgs[0], [0x99, 0x00, 0x7f]);
        assert_eq!(msgs[1], [0x99, 0x01, 0x20]);
    }

    #[test]
    fn fx_pads_light_only_the_active_effect() {
        let msgs = fx_pads(0, Some(1));
        assert_eq!(msgs[1], [0x97, 0x11, 0x7f]);
        assert_eq!(msgs[0], [0x97, 0x10, 0x00]);
        let dark = fx_pads(0, None);
        assert!(dark.iter().all(|m| m[2] == 0x00));
    }

    #[test]
    fn loop_and_cue_pads_echo_filled_state() {
        let msgs = loop_pads(0, &[true, false, true]);
        assert_eq!(msgs[0], [0x97, 0x30, 0x7f]);
        assert_eq!(msgs[1], [0x97, 0x31, 0x00]);
        assert_eq!(msgs[2], [0x97, 0x32, 0x7f]);
        assert_eq!(msgs[7], [0x97, 0x37, 0x00]); // past the given slots = dark
        let msgs = cue_pads(1, &[false, true]);
        assert_eq!(msgs[1], [0x99, 0x01, 0x7f]);
    }

    #[test]
    fn keyboard_pads_read_armed_dim_and_held_bright() {
        use crate::store::{NoteModeSnap, NoteSteeringSnap};

        // Disarmed: the whole bank is dark.
        let mut snap = deck_snap();
        let dark = keyboard_pads(0, &snap);
        assert_eq!(dark.len(), 8);
        assert!(dark.iter().all(|m| m[2] == 0x00));
        assert_eq!(dark[0][..2], [0x97, 0x40]);
        assert_eq!(dark[7][..2], [0x97, 0x47]);

        // Armed with nothing held: every pad sits dim — the bank reads live.
        snap.performance.armed = true;
        let idle = keyboard_pads(1, &snap);
        assert!(idle.iter().all(|m| m[2] == 0x20));
        assert_eq!(idle[0][..2], [0x99, 0x40]);

        // Holding pad 0's triad (C-E-G in C major) burns that pad bright;
        // a pad whose triad is only partially covered stays dim.
        snap.notes = Some(NoteSteeringSnap {
            pitches: vec![60, 64, 67],
            mode: NoteModeSnap::Chord,
        });
        let held = keyboard_pads(0, &snap);
        assert_eq!(held[0][2], 0x7f);
        assert_eq!(held[1][2], 0x20); // D-F-A not held
        assert_eq!(held[2][2], 0x20); // E-G-B needs B too
    }

    #[test]
    fn cue_buttons_echo_on_their_deck_status() {
        assert_eq!(channel_cue(0, true), vec![[0x90, 0x54, 0x7f]]);
        assert_eq!(channel_cue(1, false), vec![[0x91, 0x54, 0x00]]);
        assert_eq!(transport_cue(0, true), vec![[0x90, 0x0c, 0x7f]]);
    }

    #[test]
    fn mode_selectors_light_one_physical_button() {
        // A plain bank: its button lit, the other three dark via their
        // plain notes — one message per physical button, nothing more.
        let msgs = mode_selectors(0, 0x1e);
        assert_eq!(
            msgs,
            vec![
                [0x90, 0x1b, 0x00],
                [0x90, 0x1e, 0x7f],
                [0x90, 0x20, 0x00],
                [0x90, 0x22, 0x00],
            ]
        );
        // A shifted bank (KEYBOARD): addressed by its OWN note on the same
        // physical button — no dark plain-layer write may follow it.
        let msgs = mode_selectors(1, 0x69);
        assert_eq!(
            msgs,
            vec![
                [0x91, 0x69, 0x7f],
                [0x91, 0x1e, 0x00],
                [0x91, 0x20, 0x00],
                [0x91, 0x22, 0x00],
            ]
        );
    }

    #[test]
    fn the_hot_cue_bank_follows_the_deck_mode() {
        // Realtime deck (no track): style targets paint the bank.
        let mut snap = deck_snap();
        snap.style_targets = vec![
            crate::store::StyleTargetSnap { x: 0.0, y: 0.0, text: "a".into(), sample: None },
            crate::store::StyleTargetSnap { x: 1.0, y: 1.0, text: "b".into(), sample: None },
        ];
        let frame = deck_frame(0, &snap, &[], 0x1b);
        assert_eq!(frame[0][0], [0x97, 0x00, 0x7f]);
        assert_eq!(frame[0][2], [0x97, 0x02, 0x00]);
        // Playback deck (track loaded): filled cues paint the bank.
        snap.track = Some(TrackIdentitySnap {
            title: "t".into(),
            bpm: None,
            duration_seconds: 1.0,
        });
        snap.cues = vec![Some(1.0), None];
        let frame = deck_frame(0, &snap, &[], 0x1b);
        assert_eq!(frame[0][0], [0x97, 0x00, 0x7f]);
        assert_eq!(frame[0][1], [0x97, 0x01, 0x00]);
    }

    #[test]
    fn the_fx_group_reads_the_snapshot_kind() {
        let mut snap = deck_snap();
        snap.fx = FxSnap { kind: Some(FxKindSnap::Space), amount: 0.4 };
        let frame = deck_frame(1, &snap, &[], 0x1b);
        // Group 1 is PAD FX; Space is pad index 2 (the fx.ts order).
        assert_eq!(frame[1][2], [0x99, 0x12, 0x7f]);
        assert_eq!(frame[1][0], [0x99, 0x10, 0x00]);
    }
}

//! DDJ-FLX4 byte → intent translation (docs/midi-ddj-flx4.md, ADR-0031).
//!
//! A verbatim port of the measured `frontend/src/control/flx4.ts` translator —
//! the byte map is a MEASUREMENT, so this port re-states it and its test
//! fixtures byte-for-byte rather than re-deriving anything. The translator is
//! pure apart from two pieces of state carried from the TS original: the
//! per-control 14-bit MSB cache (MSB on the listed CC, LSB on CC+0x20) and the
//! per-deck SHIFT held-state (a software modifier — the firmware reports SHIFT
//! as a plain note).
//!
//! Two outputs the TS translator did not have:
//! - [`Translated::PerformancePad`] — the KEYBOARD pad bank (notes
//!   0x40..=0x47), issue #48's performance surface. Press AND release both
//!   matter (they edit the held-note set), so these are extracted before the
//!   velocity-0 drop that swallows ordinary button releases. Routed to the
//!   note-steering service, never to the webview.
//! - [`Translated::PadModeSwitch`] — the pad-mode selector presses that used
//!   to be `isPadModeSwitch` in TS: the cue to repaint pad LEDs, and (for the
//!   KEYBOARD selector) to arm the deck's performance surface.

use serde::Serialize;
use std::collections::HashMap;

/// A deck as the webview intent vocabulary names it (`'a' | 'b'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DeckId {
    #[serde(rename = "a")]
    A,
    #[serde(rename = "b")]
    B,
}

impl DeckId {
    /// The engine/store deck index this id addresses.
    pub fn index(self) -> usize {
        match self {
            DeckId::A => 0,
            DeckId::B => 1,
        }
    }
}

/// An EQ band, matching the webview's `EqBand` strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Band {
    Low,
    Mid,
    High,
}

/// A control intent, serialising to exactly the webview `ControlIntent` shape
/// (`{ kind: 'volume', deck: 'a', value: 0.5 }`), so the `midi://intent`
/// event payload feeds `bus.publish` unchanged. `preset_load` is absent — it
/// never comes from hardware.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Intent {
    PlayToggle { deck: DeckId },
    Volume { deck: DeckId, value: f64 },
    Trim { deck: DeckId, value: f64 },
    Eq { deck: DeckId, band: Band, value: f64 },
    Crossfade { value: f64 },
    HotCuePad { deck: DeckId, index: u8 },
    HotCueClear { deck: DeckId, index: u8 },
    StyleSweep { deck: DeckId, value: f64 },
    RecordToggle,
    CueToggle { deck: DeckId },
    CueMix { value: f64 },
    DeckPrep { deck: DeckId },
    FxAmount { deck: DeckId, value: f64 },
    FxSelect { deck: DeckId, index: u8 },
    LoopPad { deck: DeckId, index: u8 },
    LoopClear { deck: DeckId, index: u8 },
    BrowseScroll { steps: i32 },
    BrowseLoad { deck: DeckId },
    BrowseTab,
    TrackSeek { deck: DeckId, steps: i32, shifted: bool },
    Shift { deck: DeckId, held: bool },
    TrackRate { deck: DeckId, value: f64 },
    TrackLoopIn { deck: DeckId },
    TrackLoopOut { deck: DeckId },
    TrackBeatLoop { deck: DeckId, beats: u8 },
    TrackLoopHalve { deck: DeckId },
    TrackLoopDouble { deck: DeckId },
}

/// One translated MIDI message.
#[derive(Debug, Clone, PartialEq)]
pub enum Translated {
    /// Nothing mapped (releases, unmapped banks, truncated messages).
    None,
    /// A control-surface intent, forwarded to the webview ControlBus.
    Intent(Intent),
    /// A KEYBOARD-bank pad edge (issue #48): `down` is true on press. Handled
    /// natively by the note-steering service.
    PerformancePad { deck: DeckId, pad: u8, down: bool },
    /// A pad-mode selector press; `keyboard` when the KEYBOARD mode was
    /// chosen. The device clears its pad LEDs on a mode switch, so this is
    /// also the repaint cue.
    PadModeSwitch { deck: DeckId, keyboard: bool },
}

/// Per-deck Note On status bytes, shared with the cue LEDs.
pub const NOTE_ON_STATUS: [u8; 2] = [0x90, 0x91];
/// Pad bank status bytes, shared with the LED echo (same status out).
pub const PAD_STATUS: [u8; 2] = [0x97, 0x99];
/// Held SHIFT moves the pads onto their own status bytes (the shift pad
/// layer from the Mixxx mapping).
const SHIFT_PAD_STATUS: [u8; 2] = [0x98, 0x9a];
const BEAT_FX_STATUSES: [u8; 2] = [0x94, 0x95];
const CC_STATUS: [u8; 2] = [0xb0, 0xb1];
const MIXER_STATUS: u8 = 0xb6;

const PLAY_NOTE: u8 = 0x0b;
const RECORD_NOTE: u8 = 0x47;
const LOOP_IN_NOTE: u8 = 0x10;
const LOOP_OUT_NOTE: u8 = 0x11;
const BEAT_LOOP_NOTE: u8 = 0x4d;
const LOOP_HALVE_NOTE: u8 = 0x51;
const LOOP_DOUBLE_NOTE: u8 = 0x53;
const BEAT_LOOP_BEATS: u8 = 4;
pub const CHANNEL_CUE_NOTE: u8 = 0x54;
pub const TRANSPORT_CUE_NOTE: u8 = 0x0c;
const SHIFT_NOTE: u8 = 0x3f;
pub const PAD_COUNT: u8 = 8;
/// PAD FX1 bank base — interpolated from the firmware's 0x10-per-bank scheme.
pub const PAD_FX_NOTE_BASE: u8 = 0x10;
/// SAMPLER bank base: the freeze-pad loop slots (ADR-0009).
pub const LOOP_NOTE_BASE: u8 = 0x30;
/// KEYBOARD bank base (issue #48): the performance-note pads. Measured on
/// the device (2026-07-03, docs/midi-ddj-flx4.md): plain pads on
/// `0x97`/`0x99` at this base, and on the shift pad layer while SHIFT is
/// held — the translator accepts both (see the extraction in `translate`).
pub const KEYBOARD_NOTE_BASE: u8 = 0x40;
/// The loop-slot count the SAMPLER bank drives (mirrors `LOOP_SLOT_COUNT`).
const LOOP_SLOT_COUNT: u8 = lsdj_engine::LOOP_SLOT_COUNT as u8;

/// Pad-mode selector notes (HOT CUE 0x1B, PAD FX1 0x1E, BEAT JUMP 0x20,
/// SAMPLER 0x22, KEYBOARD 0x69, PAD FX2 0x6B, BEAT LOOP 0x6D, KEY SHIFT 0x6F).
const PAD_MODE_NOTES: [u8; 8] = [0x1b, 0x1e, 0x20, 0x22, 0x69, 0x6b, 0x6d, 0x6f];
/// The KEYBOARD selector — choosing that bank arms the performance surface.
const KEYBOARD_MODE_NOTE: u8 = 0x69;

/// Jog wheel turn CCs, relative around 0x40 (side, platter vinyl-on/off).
const JOG_CCS: [u8; 3] = [0x21, 0x22, 0x23];
/// SHIFT + jog arrives on its OWN CC, not as a soft-shifted jog CC.
const JOG_SCRUB_CC: u8 = 0x29;
const LSB_OFFSET: u8 = 0x20;
const MAX_14BIT: f64 = ((127 << 7) | 127) as f64;
/// Browse rotary: a RELATIVE encoder on the mixer status.
const BROWSE_CC: u8 = 0x40;
/// LOAD buttons: their own status byte, one note per deck.
const LOAD_STATUS: u8 = 0x96;
const LOAD_NOTES: [u8; 2] = [0x46, 0x47];
/// Rotary press — interpolated from the DDJ-400 family chart.
const BROWSE_PRESS_NOTE: u8 = 0x41;

fn deck_of(statuses: [u8; 2], status: u8) -> Option<DeckId> {
    if status == statuses[0] {
        Some(DeckId::A)
    } else if status == statuses[1] {
        Some(DeckId::B)
    } else {
        None
    }
}

/// The stateful FLX4/DDJ-400 translator (both share the Pioneer 2-deck byte
/// scheme; the drivers differ only in binding fragment and init SysEx).
#[derive(Default)]
pub struct Flx4Translator {
    /// Last MSB per control, keyed `(status << 8) | cc`.
    msb_by_control: HashMap<u16, u8>,
    /// SHIFT held per deck (a software modifier).
    shift_held: [bool; 2],
}

impl Flx4Translator {
    /// The CC → intent builders keyed by MSB CC number, resolved per message
    /// so the SMART CFX rows read the live shift state.
    fn cc_intent(&self, status: u8, cc: u8, value: f64) -> Option<Intent> {
        if let Some(deck) = deck_of(CC_STATUS, status) {
            return match cc {
                // Tempo slider: varispeed, not generation tempo (ADR-0014 vs 0004).
                0x00 => Some(Intent::TrackRate { deck, value }),
                // Channel TRIM (gain) knob (M17).
                0x04 => Some(Intent::Trim { deck, value }),
                0x13 => Some(Intent::Volume { deck, value }),
                0x07 => Some(Intent::Eq { deck, band: Band::High, value }),
                0x0b => Some(Intent::Eq { deck, band: Band::Mid, value }),
                0x0f => Some(Intent::Eq { deck, band: Band::Low, value }),
                _ => None,
            };
        }
        if status == MIXER_STATUS {
            return match cc {
                0x1f => Some(Intent::Crossfade { value }),
                0x17 => Some(if self.shift_held[0] {
                    Intent::StyleSweep { deck: DeckId::A, value }
                } else {
                    Intent::FxAmount { deck: DeckId::A, value }
                }),
                0x18 => Some(if self.shift_held[1] {
                    Intent::StyleSweep { deck: DeckId::B, value }
                } else {
                    Intent::FxAmount { deck: DeckId::B, value }
                }),
                0x0c => Some(Intent::CueMix { value }),
                _ => None,
            };
        }
        None
    }

    /// Whether a CC is a mapped 14-bit MSB (guards the MSB cache against
    /// relative encoders — the builders themselves are value-independent).
    fn is_msb(&self, status: u8, cc: u8) -> bool {
        self.cc_intent(status, cc, 0.0).is_some()
    }

    fn button_intent(&self, status: u8, note: u8) -> Option<Intent> {
        if let Some(deck) = deck_of(NOTE_ON_STATUS, status) {
            match note {
                PLAY_NOTE => return Some(Intent::PlayToggle { deck }),
                CHANNEL_CUE_NOTE => return Some(Intent::CueToggle { deck }),
                TRANSPORT_CUE_NOTE => return Some(Intent::DeckPrep { deck }),
                LOOP_IN_NOTE => return Some(Intent::TrackLoopIn { deck }),
                LOOP_OUT_NOTE => return Some(Intent::TrackLoopOut { deck }),
                BEAT_LOOP_NOTE => {
                    // "4 BEAT/EXIT": one byte arms and releases — the toggle
                    // lives in the webview dispatch (ADR-0016).
                    return Some(Intent::TrackBeatLoop { deck, beats: BEAT_LOOP_BEATS });
                }
                LOOP_HALVE_NOTE => return Some(Intent::TrackLoopHalve { deck }),
                LOOP_DOUBLE_NOTE => return Some(Intent::TrackLoopDouble { deck }),
                _ => return None,
            }
        }
        if let Some(deck) = deck_of(PAD_STATUS, status) {
            if note < PAD_COUNT {
                return Some(Intent::HotCuePad { deck, index: note });
            }
            if (PAD_FX_NOTE_BASE..PAD_FX_NOTE_BASE + PAD_COUNT).contains(&note) {
                return Some(Intent::FxSelect { deck, index: note - PAD_FX_NOTE_BASE });
            }
            if (LOOP_NOTE_BASE..LOOP_NOTE_BASE + LOOP_SLOT_COUNT).contains(&note) {
                let index = note - LOOP_NOTE_BASE;
                return Some(if self.shift_held[deck.index()] {
                    Intent::LoopClear { deck, index }
                } else {
                    Intent::LoopPad { deck, index }
                });
            }
            return None;
        }
        // SHIFT + pad arrives on the shift pad layer: HOT CUE clear and
        // SAMPLER clear are mapped; other shift-layer banks deliberately not.
        if let Some(deck) = deck_of(SHIFT_PAD_STATUS, status) {
            if note < PAD_COUNT {
                return Some(Intent::HotCueClear { deck, index: note });
            }
            if (LOOP_NOTE_BASE..LOOP_NOTE_BASE + LOOP_SLOT_COUNT).contains(&note) {
                return Some(Intent::LoopClear { deck, index: note - LOOP_NOTE_BASE });
            }
            return None;
        }
        if BEAT_FX_STATUSES.contains(&status) && note == RECORD_NOTE {
            return Some(Intent::RecordToggle);
        }
        if status == LOAD_STATUS {
            if let Some(deck) = LOAD_NOTES.iter().position(|&n| n == note) {
                return Some(Intent::BrowseLoad {
                    deck: if deck == 0 { DeckId::A } else { DeckId::B },
                });
            }
            if note == BROWSE_PRESS_NOTE {
                return Some(Intent::BrowseTab);
            }
        }
        None
    }

    pub fn translate(&mut self, data: &[u8]) -> Translated {
        let (status, number, value) = match data {
            [status, number, value, ..] => (*status, *number, *value),
            _ => return Translated::None,
        };

        // SHIFT held-state, tracked from press AND release — before the
        // velocity-0 drop. Surfaced as an intent for cross-deck consumers.
        if let Some(deck) = deck_of(NOTE_ON_STATUS, status) {
            if number == SHIFT_NOTE {
                self.shift_held[deck.index()] = value > 0;
                return Translated::Intent(Intent::Shift { deck, held: value > 0 });
            }
            // Pad-mode selectors emit no intent; presses cue a repaint (and
            // the KEYBOARD selector arms the performance surface).
            if PAD_MODE_NOTES.contains(&number) {
                if value > 0 {
                    return Translated::PadModeSwitch {
                        deck,
                        keyboard: number == KEYBOARD_MODE_NOTE,
                    };
                }
                return Translated::None;
            }
        }

        // KEYBOARD bank (issue #48): both edges matter — extracted before the
        // release drop. Measured on the device (2026-07-03): plain pads ride
        // `0x97`/`0x99` per the bank scheme, and held SHIFT moves them onto
        // the shift pad layer (`0x98`/`0x9A`) like every other bank. BOTH
        // layers map to the same pad: playing never needs SHIFT, and a SHIFT
        // grabbed mid-hold (for another gesture) cannot eat a pad release
        // and stick a note. The bank stays self-identifying by note range,
        // so no pad-mode tracking is needed for input.
        if let Some(deck) =
            deck_of(PAD_STATUS, status).or_else(|| deck_of(SHIFT_PAD_STATUS, status))
        {
            if (KEYBOARD_NOTE_BASE..KEYBOARD_NOTE_BASE + PAD_COUNT).contains(&number) {
                return Translated::PerformancePad {
                    deck,
                    pad: number - KEYBOARD_NOTE_BASE,
                    down: value > 0,
                };
            }
        }

        // The browse rotary is relative — it must not enter the absolute
        // MSB/LSB machinery. A fast turn packs several clicks per message
        // (0x02 = two CW, 0x7E = two CCW in two's complement).
        if status == MIXER_STATUS && number == BROWSE_CC {
            if value == 0 || value == 0x40 {
                return Translated::None;
            }
            let steps = if value < 0x40 {
                value as i32
            } else {
                value as i32 - 0x80
            };
            return Translated::Intent(Intent::BrowseScroll { steps });
        }

        // Jog wheels are relative too, 0x40-centred; intercepted before the
        // absolute machinery. SHIFT+jog rides its own CC (JOG_SCRUB_CC); the
        // held-SHIFT fallback stays for plain-CC firmware.
        if let Some(deck) = deck_of(CC_STATUS, status) {
            if JOG_CCS.contains(&number) || number == JOG_SCRUB_CC {
                if value == 0x40 {
                    return Translated::None;
                }
                return Translated::Intent(Intent::TrackSeek {
                    deck,
                    steps: value as i32 - 0x40,
                    shifted: number == JOG_SCRUB_CC || self.shift_held[deck.index()],
                });
            }
        }

        if self.is_msb(status, number) {
            self.msb_by_control.insert(((status as u16) << 8) | number as u16, value);
            let coarse = ((value as u32) << 7) as f64 / MAX_14BIT;
            if let Some(intent) = self.cc_intent(status, number, coarse) {
                return Translated::Intent(intent);
            }
        }
        if number >= LSB_OFFSET && self.is_msb(status, number - LSB_OFFSET) {
            let msb_cc = number - LSB_OFFSET;
            // An LSB with no MSB seen yet would jump the control to near
            // zero; the FLX4 always sends the pair MSB-first, so wait.
            let key = ((status as u16) << 8) | msb_cc as u16;
            if let Some(&msb) = self.msb_by_control.get(&key) {
                let fine = (((msb as u32) << 7) | value as u32) as f64 / MAX_14BIT;
                if let Some(intent) = self.cc_intent(status, msb_cc, fine) {
                    return Translated::Intent(intent);
                }
            }
            return Translated::None;
        }

        // Buttons are Note On: velocity 0x7F on press, 0x00 on release.
        if value == 0 {
            return Translated::None;
        }
        match self.button_intent(status, number) {
            Some(intent) => Translated::Intent(intent),
            None => Translated::None,
        }
    }
}

#[cfg(test)]
mod tests {
    //! The `flx4.test.ts` fixtures, ported byte-for-byte (the byte map is a
    //! measurement; the port must not drift from what the device proved).

    use super::*;

    const PRESS: u8 = 0x7f;
    const RELEASE: u8 = 0x00;

    fn translator() -> Flx4Translator {
        Flx4Translator::default()
    }

    fn intent(t: &mut Flx4Translator, data: &[u8]) -> Option<Intent> {
        match t.translate(data) {
            Translated::Intent(i) => Some(i),
            _ => None,
        }
    }

    #[test]
    fn play_press_toggles_the_deck() {
        for (status, deck) in [(0x90, DeckId::A), (0x91, DeckId::B)] {
            let mut t = translator();
            assert_eq!(
                intent(&mut t, &[status, 0x0b, PRESS]),
                Some(Intent::PlayToggle { deck })
            );
        }
    }

    #[test]
    fn button_releases_are_ignored() {
        let mut t = translator();
        assert_eq!(t.translate(&[0x90, 0x0b, RELEASE]), Translated::None);
        assert_eq!(t.translate(&[0x97, 0x03, RELEASE]), Translated::None);
        assert_eq!(t.translate(&[0x94, 0x47, RELEASE]), Translated::None);
    }

    #[test]
    fn hot_cue_pads_emit_the_pad_gesture() {
        for (status, deck) in [(0x97, DeckId::A), (0x99, DeckId::B)] {
            let mut t = translator();
            for pad in 0..8u8 {
                assert_eq!(
                    intent(&mut t, &[status, pad, PRESS]),
                    Some(Intent::HotCuePad { deck, index: pad })
                );
            }
        }
    }

    #[test]
    fn pad_notes_outside_mapped_banks_are_ignored() {
        let mut t = translator();
        assert_eq!(t.translate(&[0x97, 0x08, PRESS]), Translated::None);
        assert_eq!(t.translate(&[0x99, 0x20, PRESS]), Translated::None); // BEAT JUMP
        assert_eq!(t.translate(&[0x99, 0x18, PRESS]), Translated::None); // past PAD FX
    }

    #[test]
    fn pad_fx_pads_select_effects() {
        for (status, deck) in [(0x97, DeckId::A), (0x99, DeckId::B)] {
            let mut t = translator();
            for pad in 0..8u8 {
                assert_eq!(
                    intent(&mut t, &[status, 0x10 + pad, PRESS]),
                    Some(Intent::FxSelect { deck, index: pad })
                );
            }
            assert_eq!(t.translate(&[status, 0x10, RELEASE]), Translated::None);
        }
    }

    #[test]
    fn shift_layer_hot_cue_pads_clear_cues() {
        for (status, deck) in [(0x98, DeckId::A), (0x9a, DeckId::B)] {
            let mut t = translator();
            assert_eq!(
                intent(&mut t, &[status, 0x02, PRESS]),
                Some(Intent::HotCueClear { deck, index: 2 })
            );
        }
    }

    #[test]
    fn other_shift_layer_banks_stay_unmapped() {
        let mut t = translator();
        assert_eq!(t.translate(&[0x98, 0x10, PRESS]), Translated::None); // PAD FX shifted
        assert_eq!(t.translate(&[0x9a, 0x60, PRESS]), Translated::None); // BEAT LOOP shifted
    }

    #[test]
    fn loop_section_drives_track_loops() {
        for (status, deck) in [(0x90, DeckId::A), (0x91, DeckId::B)] {
            let mut t = translator();
            assert_eq!(
                intent(&mut t, &[status, 0x10, PRESS]),
                Some(Intent::TrackLoopIn { deck })
            );
            assert_eq!(
                intent(&mut t, &[status, 0x11, PRESS]),
                Some(Intent::TrackLoopOut { deck })
            );
            assert_eq!(t.translate(&[status, 0x10, RELEASE]), Translated::None);
        }
    }

    #[test]
    fn beat_loop_controls_drive_the_deck() {
        for (status, deck) in [(0x90, DeckId::A), (0x91, DeckId::B)] {
            let mut t = translator();
            assert_eq!(
                intent(&mut t, &[status, 0x51, PRESS]),
                Some(Intent::TrackLoopHalve { deck })
            );
            assert_eq!(
                intent(&mut t, &[status, 0x53, PRESS]),
                Some(Intent::TrackLoopDouble { deck })
            );
            assert_eq!(
                intent(&mut t, &[status, 0x4d, PRESS]),
                Some(Intent::TrackBeatLoop { deck, beats: 4 })
            );
            assert_eq!(t.translate(&[status, 0x4d, RELEASE]), Translated::None);
        }
    }

    #[test]
    fn sampler_pads_drive_loop_slots() {
        for (status, deck) in [(0x97, DeckId::A), (0x99, DeckId::B)] {
            let mut t = translator();
            for pad in 0..4u8 {
                assert_eq!(
                    intent(&mut t, &[status, 0x30 + pad, PRESS]),
                    Some(Intent::LoopPad { deck, index: pad })
                );
            }
            assert_eq!(t.translate(&[status, 0x30, RELEASE]), Translated::None);
            assert_eq!(t.translate(&[status, 0x34, PRESS]), Translated::None); // beyond slots
        }
    }

    #[test]
    fn shift_plus_sampler_pad_clears_the_slot_release_restores() {
        for (shift_status, pad_status, deck) in
            [(0x90, 0x97, DeckId::A), (0x91, 0x99, DeckId::B)]
        {
            let mut t = translator();
            t.translate(&[shift_status, 0x3f, 0x7f]); // SHIFT down
            assert_eq!(
                intent(&mut t, &[pad_status, 0x31, PRESS]),
                Some(Intent::LoopClear { deck, index: 1 })
            );
            t.translate(&[shift_status, 0x3f, 0x00]); // SHIFT up
            assert_eq!(
                intent(&mut t, &[pad_status, 0x31, PRESS]),
                Some(Intent::LoopPad { deck, index: 1 })
            );
        }
    }

    #[test]
    fn shift_layer_sampler_pads_clear_slots() {
        for (status, deck) in [(0x98, DeckId::A), (0x9a, DeckId::B)] {
            let mut t = translator();
            for pad in 0..4u8 {
                assert_eq!(
                    intent(&mut t, &[status, 0x30 + pad, PRESS]),
                    Some(Intent::LoopClear { deck, index: pad })
                );
            }
            assert_eq!(t.translate(&[status, 0x30, RELEASE]), Translated::None);
            assert_eq!(t.translate(&[status, 0x34, PRESS]), Translated::None);
            assert_eq!(t.translate(&[status, 0x10, PRESS]), Translated::None);
        }
    }

    #[test]
    fn beat_fx_press_toggles_recording() {
        for status in [0x94, 0x95] {
            let mut t = translator();
            assert_eq!(intent(&mut t, &[status, 0x47, PRESS]), Some(Intent::RecordToggle));
        }
    }

    #[test]
    fn channel_cue_press_toggles_headphone_cue() {
        for (status, deck) in [(0x90, DeckId::A), (0x91, DeckId::B)] {
            let mut t = translator();
            assert_eq!(
                intent(&mut t, &[status, 0x54, PRESS]),
                Some(Intent::CueToggle { deck })
            );
            assert_eq!(t.translate(&[status, 0x54, RELEASE]), Translated::None);
        }
    }

    #[test]
    fn transport_cue_press_preps_the_deck() {
        for (status, deck) in [(0x90, DeckId::A), (0x91, DeckId::B)] {
            let mut t = translator();
            assert_eq!(
                intent(&mut t, &[status, 0x0c, PRESS]),
                Some(Intent::DeckPrep { deck })
            );
        }
    }

    #[test]
    fn channel_fader_drives_volume_14bit() {
        for (status, deck) in [(0xb0, DeckId::A), (0xb1, DeckId::B)] {
            let mut t = translator();
            assert_eq!(
                intent(&mut t, &[status, 0x13, 0x7f]),
                Some(Intent::Volume { deck, value: ((0x7f << 7) as f64) / 16383.0 })
            );
            assert_eq!(
                intent(&mut t, &[status, 0x33, 0x7f]),
                Some(Intent::Volume { deck, value: 1.0 })
            );
        }
    }

    #[test]
    fn eq_ccs_drive_the_bands_on_both_decks() {
        for (msb, lsb, band) in [
            (0x07u8, 0x27u8, Band::High),
            (0x0b, 0x2b, Band::Mid),
            (0x0f, 0x2f, Band::Low),
        ] {
            for (status, deck) in [(0xb0, DeckId::A), (0xb1, DeckId::B)] {
                let mut t = translator();
                assert_eq!(
                    intent(&mut t, &[status, msb, 0x40]),
                    Some(Intent::Eq { deck, band, value: ((0x40 << 7) as f64) / 16383.0 })
                );
                assert_eq!(
                    intent(&mut t, &[status, lsb, 0x00]),
                    Some(Intent::Eq { deck, band, value: 0x2000 as f64 / 16383.0 })
                );
            }
        }
    }

    #[test]
    fn trim_knob_drives_deck_trim() {
        for (status, deck) in [(0xb0, DeckId::A), (0xb1, DeckId::B)] {
            let mut t = translator();
            assert_eq!(
                intent(&mut t, &[status, 0x04, 0x40]),
                Some(Intent::Trim { deck, value: ((0x40 << 7) as f64) / 16383.0 })
            );
            assert_eq!(
                intent(&mut t, &[status, 0x24, 0x00]),
                Some(Intent::Trim { deck, value: 0x2000 as f64 / 16383.0 })
            );
        }
    }

    #[test]
    fn crossfader_maps_to_master_crossfade() {
        let mut t = translator();
        assert_eq!(
            intent(&mut t, &[0xb6, 0x1f, 0x00]),
            Some(Intent::Crossfade { value: 0.0 })
        );
        assert_eq!(
            intent(&mut t, &[0xb6, 0x3f, 0x00]),
            Some(Intent::Crossfade { value: 0.0 })
        );
    }

    #[test]
    fn smart_cfx_rides_color_fx() {
        for (msb, lsb, deck) in [(0x17u8, 0x37u8, DeckId::A), (0x18, 0x38, DeckId::B)] {
            let mut t = translator();
            assert_eq!(
                intent(&mut t, &[0xb6, msb, 0x20]),
                Some(Intent::FxAmount { deck, value: ((0x20 << 7) as f64) / 16383.0 })
            );
            assert_eq!(
                intent(&mut t, &[0xb6, lsb, 0x55]),
                Some(Intent::FxAmount {
                    deck,
                    value: (((0x20 << 7) | 0x55) as f64) / 16383.0
                })
            );
        }
    }

    #[test]
    fn shift_plus_smart_cfx_sweeps_styles_release_restores_fx() {
        for (shift_status, cc, deck) in [(0x90, 0x17u8, DeckId::A), (0x91, 0x18, DeckId::B)] {
            let mut t = translator();
            t.translate(&[shift_status, 0x3f, 0x7f]); // SHIFT down
            assert_eq!(
                intent(&mut t, &[0xb6, cc, 0x20]),
                Some(Intent::StyleSweep { deck, value: ((0x20 << 7) as f64) / 16383.0 })
            );
            t.translate(&[shift_status, 0x3f, 0x00]); // SHIFT up
            assert_eq!(
                intent(&mut t, &[0xb6, cc, 0x20]),
                Some(Intent::FxAmount { deck, value: ((0x20 << 7) as f64) / 16383.0 })
            );
        }
    }

    #[test]
    fn each_shift_pairs_with_its_own_deck_only() {
        let mut t = translator();
        t.translate(&[0x90, 0x3f, 0x7f]); // left SHIFT down
        assert!(matches!(
            intent(&mut t, &[0xb6, 0x18, 0x20]),
            Some(Intent::FxAmount { deck: DeckId::B, .. })
        ));
        assert!(matches!(
            intent(&mut t, &[0xb6, 0x17, 0x20]),
            Some(Intent::StyleSweep { deck: DeckId::A, .. })
        ));
    }

    #[test]
    fn browse_rotary_ticks_are_signed_relative_steps() {
        let mut t = translator();
        assert_eq!(
            intent(&mut t, &[0xb6, 0x40, 0x01]),
            Some(Intent::BrowseScroll { steps: 1 })
        );
        assert_eq!(
            intent(&mut t, &[0xb6, 0x40, 0x02]),
            Some(Intent::BrowseScroll { steps: 2 })
        );
        assert_eq!(
            intent(&mut t, &[0xb6, 0x40, 0x7f]),
            Some(Intent::BrowseScroll { steps: -1 })
        );
        assert_eq!(
            intent(&mut t, &[0xb6, 0x40, 0x7e]),
            Some(Intent::BrowseScroll { steps: -2 })
        );
        assert_eq!(t.translate(&[0xb6, 0x40, 0x00]), Translated::None);
    }

    #[test]
    fn browse_ticks_never_pollute_the_msb_cache() {
        let mut t = translator();
        t.translate(&[0xb6, 0x40, 0x01]); // rotary tick
        // CC 0x60 would be 0x40's LSB if the rotary entered the cache.
        assert_eq!(t.translate(&[0xb6, 0x60, 0x10]), Translated::None);
    }

    #[test]
    fn load_buttons_load_the_deck() {
        for (note, deck) in [(0x46u8, DeckId::A), (0x47, DeckId::B)] {
            let mut t = translator();
            assert_eq!(
                intent(&mut t, &[0x96, note, PRESS]),
                Some(Intent::BrowseLoad { deck })
            );
            assert_eq!(t.translate(&[0x96, note, RELEASE]), Translated::None);
        }
    }

    #[test]
    fn rotary_press_cycles_the_explorer_tab() {
        let mut t = translator();
        assert_eq!(intent(&mut t, &[0x96, 0x41, PRESS]), Some(Intent::BrowseTab));
        assert_eq!(t.translate(&[0x96, 0x41, RELEASE]), Translated::None);
    }

    #[test]
    fn jog_turns_seek_relatively() {
        for status in [0xb0u8, 0xb1] {
            let deck = if status == 0xb0 { DeckId::A } else { DeckId::B };
            for cc in [0x21u8, 0x22, 0x23] {
                let mut t = translator();
                assert_eq!(
                    intent(&mut t, &[status, cc, 0x41]),
                    Some(Intent::TrackSeek { deck, steps: 1, shifted: false })
                );
                assert_eq!(
                    intent(&mut t, &[status, cc, 0x3e]),
                    Some(Intent::TrackSeek { deck, steps: -2, shifted: false })
                );
                assert_eq!(t.translate(&[status, cc, 0x40]), Translated::None);
            }
        }
    }

    #[test]
    fn tempo_slider_is_a_14bit_track_rate() {
        for (status, deck) in [(0xb0, DeckId::A), (0xb1, DeckId::B)] {
            let mut t = translator();
            assert_eq!(
                intent(&mut t, &[status, 0x00, 0x40]),
                Some(Intent::TrackRate { deck, value: ((0x40 << 7) as f64) / 16383.0 })
            );
            assert_eq!(
                intent(&mut t, &[status, 0x20, 0x10]),
                Some(Intent::TrackRate {
                    deck,
                    value: (((0x40 << 7) | 0x10) as f64) / 16383.0
                })
            );
        }
    }

    #[test]
    fn shift_jog_rides_its_own_cc_and_marks_shifted() {
        for (status, deck) in [(0xb0, DeckId::A), (0xb1, DeckId::B)] {
            let mut t = translator();
            // No SHIFT note seen — the firmware encodes shift in the CC.
            assert_eq!(
                intent(&mut t, &[status, 0x29, 0x42]),
                Some(Intent::TrackSeek { deck, steps: 2, shifted: true })
            );
            assert_eq!(t.translate(&[status, 0x29, 0x40]), Translated::None);
        }
    }

    #[test]
    fn held_shift_marks_jog_ticks_for_scrubbing() {
        let mut t = translator();
        t.translate(&[0x90, 0x3f, PRESS]); // SHIFT down on deck a
        assert_eq!(
            intent(&mut t, &[0xb0, 0x21, 0x41]),
            Some(Intent::TrackSeek { deck: DeckId::A, steps: 1, shifted: true })
        );
        t.translate(&[0x90, 0x3f, RELEASE]);
        assert_eq!(
            intent(&mut t, &[0xb0, 0x21, 0x41]),
            Some(Intent::TrackSeek { deck: DeckId::A, steps: 1, shifted: false })
        );
    }

    #[test]
    fn jog_ticks_never_pollute_the_msb_cache() {
        let mut t = translator();
        t.translate(&[0xb0, 0x21, 0x41]); // jog tick
        // CC 0x41 would be 0x21's LSB if the jog entered the cache.
        assert_eq!(t.translate(&[0xb0, 0x41, 0x10]), Translated::None);
    }

    #[test]
    fn headphones_mix_knob_maps_to_the_cue_blend() {
        let mut t = translator();
        assert_eq!(
            intent(&mut t, &[0xb6, 0x0c, 0x40]),
            Some(Intent::CueMix { value: ((0x40 << 7) as f64) / 16383.0 })
        );
        assert_eq!(
            intent(&mut t, &[0xb6, 0x2c, 0x10]),
            Some(Intent::CueMix { value: (((0x40 << 7) | 0x10) as f64) / 16383.0 })
        );
    }

    #[test]
    fn msb_and_lsb_combine_into_the_full_resolution_value() {
        let mut t = translator();
        t.translate(&[0xb6, 0x1f, 0x7f]);
        assert_eq!(
            intent(&mut t, &[0xb6, 0x3f, 0x7f]),
            Some(Intent::Crossfade { value: 1.0 })
        );
    }

    #[test]
    fn an_lsb_before_any_msb_is_ignored() {
        let mut t = translator();
        assert_eq!(t.translate(&[0xb0, 0x33, 0x10]), Translated::None);
    }

    #[test]
    fn the_msb_cache_is_per_control_not_global() {
        let mut t = translator();
        t.translate(&[0xb0, 0x13, 0x7f]); // deck a volume MSB
        assert_eq!(t.translate(&[0xb1, 0x33, 0x10]), Translated::None); // deck b volume LSB
        assert_eq!(t.translate(&[0xb0, 0x27, 0x10]), Translated::None); // deck a EQ-high LSB
    }

    #[test]
    fn a_fresh_msb_replaces_the_cached_one() {
        let mut t = translator();
        t.translate(&[0xb0, 0x13, 0x7f]);
        t.translate(&[0xb0, 0x33, 0x7f]);
        t.translate(&[0xb0, 0x13, 0x00]);
        assert_eq!(
            intent(&mut t, &[0xb0, 0x33, 0x01]),
            Some(Intent::Volume { deck: DeckId::A, value: 1.0 / 16383.0 })
        );
    }

    #[test]
    fn pad_mode_selector_presses_are_recognised_on_either_deck() {
        let mut t = translator();
        assert_eq!(
            t.translate(&[0x90, 0x1b, PRESS]),
            Translated::PadModeSwitch { deck: DeckId::A, keyboard: false }
        );
        assert_eq!(
            t.translate(&[0x91, 0x1e, PRESS]),
            Translated::PadModeSwitch { deck: DeckId::B, keyboard: false }
        );
        assert_eq!(
            t.translate(&[0x90, 0x6b, PRESS]),
            Translated::PadModeSwitch { deck: DeckId::A, keyboard: false }
        );
        assert_eq!(t.translate(&[0x90, 0x1b, RELEASE]), Translated::None);
        // PLAY is not a selector; the pad channel's 0x1B is a pad, not a mode.
        assert_eq!(
            t.translate(&[0x90, 0x0b, PRESS]),
            Translated::Intent(Intent::PlayToggle { deck: DeckId::A })
        );
        assert_eq!(t.translate(&[0x97, 0x1b, PRESS]), Translated::None);
        assert_eq!(t.translate(&[0x90, 0x1b]), Translated::None);
    }

    #[test]
    fn keyboard_selector_flags_the_performance_arm() {
        let mut t = translator();
        assert_eq!(
            t.translate(&[0x90, 0x69, PRESS]),
            Translated::PadModeSwitch { deck: DeckId::A, keyboard: true }
        );
        assert_eq!(
            t.translate(&[0x91, 0x69, PRESS]),
            Translated::PadModeSwitch { deck: DeckId::B, keyboard: true }
        );
    }

    #[test]
    fn keyboard_bank_pads_report_both_edges_on_both_layers() {
        // Measured on the device (2026-07-03): plain pads on `97`/`99`,
        // and on the shift pad layer (`98`/`9A`) while SHIFT is held —
        // both map to the SAME pad, playing never requires SHIFT.
        for (status, deck) in [
            (0x97, DeckId::A),
            (0x99, DeckId::B),
            (0x98, DeckId::A),
            (0x9a, DeckId::B),
        ] {
            let mut t = translator();
            for pad in 0..8u8 {
                assert_eq!(
                    t.translate(&[status, 0x40 + pad, PRESS]),
                    Translated::PerformancePad { deck, pad, down: true }
                );
                assert_eq!(
                    t.translate(&[status, 0x40 + pad, RELEASE]),
                    Translated::PerformancePad { deck, pad, down: false }
                );
            }
        }
    }

    #[test]
    fn a_shift_grab_mid_hold_cannot_stick_a_note() {
        // Press on the plain layer, SHIFT goes down, release arrives on the
        // shift layer: both edges must resolve to the same pad or the hold
        // never clears.
        let mut t = translator();
        assert_eq!(
            t.translate(&[0x97, 0x42, PRESS]),
            Translated::PerformancePad { deck: DeckId::A, pad: 2, down: true }
        );
        t.translate(&[0x90, 0x3f, PRESS]); // SHIFT down mid-hold
        assert_eq!(
            t.translate(&[0x98, 0x42, RELEASE]),
            Translated::PerformancePad { deck: DeckId::A, pad: 2, down: false }
        );
    }

    #[test]
    fn deliberately_unmapped_traffic_is_ignored() {
        let mut t = translator();
        assert_eq!(t.translate(&[0xb0, 0x21, 0x40]), Translated::None); // jog centre
        assert_eq!(t.translate(&[0xf8, 0x00, 0x00]), Translated::None); // clock noise
    }

    #[test]
    fn shift_held_state_surfaces_as_an_intent() {
        for (status, deck) in [(0x90, DeckId::A), (0x91, DeckId::B)] {
            let mut t = translator();
            assert_eq!(
                intent(&mut t, &[status, 0x3f, PRESS]),
                Some(Intent::Shift { deck, held: true })
            );
            assert_eq!(
                intent(&mut t, &[status, 0x3f, 0x00]),
                Some(Intent::Shift { deck, held: false })
            );
        }
    }

    #[test]
    fn truncated_messages_are_ignored() {
        let mut t = translator();
        assert_eq!(t.translate(&[0xb0, 0x13]), Translated::None);
        assert_eq!(t.translate(&[]), Translated::None);
    }

    #[test]
    fn intents_serialise_to_the_webview_controlintent_shape() {
        // The midi://intent payload must feed bus.publish unchanged.
        let json = serde_json::to_value(Intent::Volume { deck: DeckId::A, value: 0.5 }).unwrap();
        assert_eq!(json["kind"], "volume");
        assert_eq!(json["deck"], "a");
        assert_eq!(json["value"], 0.5);
        let json = serde_json::to_value(Intent::Eq {
            deck: DeckId::B,
            band: Band::High,
            value: 1.0,
        })
        .unwrap();
        assert_eq!(json["kind"], "eq");
        assert_eq!(json["band"], "high");
        let json = serde_json::to_value(Intent::TrackSeek {
            deck: DeckId::A,
            steps: -2,
            shifted: true,
        })
        .unwrap();
        assert_eq!(json["kind"], "track_seek");
        assert_eq!(json["steps"], -2);
        assert_eq!(json["shifted"], true);
        let json = serde_json::to_value(Intent::RecordToggle).unwrap();
        assert_eq!(json["kind"], "record_toggle");
    }
}

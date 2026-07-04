//! Style-pad geometry and semantics (ADR-0020 phase B).
//!
//! Ported verbatim from the retired webview `padWeights.ts`: targets live at
//! user-draggable positions in the unit square, the cursor blends them by
//! inverse-square distance weighting — smooth everywhere, exactly one target
//! at its own position. The store owns the arrangement now (the webview is a
//! projection emitting intents), so the geometry the intents need — spawn
//! slots, the sweep circle, the blend — lives here, pure and unit-tested.

/// The most targets a pad holds (the webview's `MAX_PRESET_TARGETS`).
pub const MAX_TARGETS: usize = 8;
/// The longest target prompt accepted at the trust boundary.
pub const MAX_TARGET_TEXT: usize = 160;

const EXACT_HIT: f32 = 1e-6;
const CIRCLE_RADIUS: f32 = 0.38;
const SPAWN_SLOTS: usize = 8;

/// Normalized blend weights for a cursor over the targets (all in 0..1 pad
/// coordinates). An exact hit takes the whole blend; otherwise weights fall
/// off with inverse-square distance.
pub fn pad_weights(targets: &[(f32, f32)], cursor: (f32, f32)) -> Vec<f32> {
    let distances: Vec<f32> = targets
        .iter()
        .map(|(x, y)| ((x - cursor.0).powi(2) + (y - cursor.1).powi(2)).sqrt())
        .collect();
    if let Some(hit) = distances.iter().position(|d| *d < EXACT_HIT) {
        return (0..targets.len()).map(|i| if i == hit { 1.0 } else { 0.0 }).collect();
    }
    let raw: Vec<f32> = distances.iter().map(|d| 1.0 / (d * d)).collect();
    let total: f32 = raw.iter().sum();
    raw.iter().map(|w| w / total).collect()
}

/// Where a sweep fraction in [0, 1] lands: on the same circle the spawn
/// slots sit on, 0 at 12 o'clock, increasing clockwise — so a hardware knob
/// rides the cursor through every spawned target in order.
pub fn sweep_position(fraction: f32) -> (f32, f32) {
    let angle = 2.0 * std::f32::consts::PI * fraction - std::f32::consts::FRAC_PI_2;
    (
        0.5 + CIRCLE_RADIUS * angle.cos(),
        0.5 + CIRCLE_RADIUS * angle.sin(),
    )
}

/// The i-th of the eight spawn slots on the circle.
pub fn circle_slot(index: usize) -> (f32, f32) {
    sweep_position(index as f32 / SPAWN_SLOTS as f32)
}

/// Where a newly added target spawns: the circle slot with the most
/// clearance from the targets already placed, so adding never reshuffles an
/// arrangement the user made by dragging.
pub fn spawn_position(existing: &[(f32, f32)]) -> (f32, f32) {
    let mut best = circle_slot(0);
    let mut best_clearance = -1.0f32;
    for index in 0..SPAWN_SLOTS {
        let slot = circle_slot(index);
        let clearance = existing
            .iter()
            .map(|(x, y)| ((x - slot.0).powi(2) + (y - slot.1).powi(2)).sqrt())
            .fold(f32::INFINITY, f32::min);
        if clearance > best_clearance {
            best_clearance = clearance;
            best = slot;
        }
    }
    best
}

/// Clamp a pad coordinate into the unit square.
pub fn clamp01(value: f32) -> f32 {
    value.clamp(0.0, 1.0)
}

/// Sanitise a bulk arrangement at the trust boundary (preset load, MCP
/// set_style): text targets only (a sampled chip's embedding is session
/// state no external writer can hold), non-empty capped text, finite
/// clamped coordinates. Shared by the IPC command and the MCP tool so the
/// rules cannot fork.
pub fn sanitize_preset_targets(
    targets: Vec<crate::store::StyleTargetSnap>,
) -> Vec<crate::store::StyleTargetSnap> {
    targets
        .into_iter()
        .filter(|t| {
            t.sample.is_none()
                && !t.text.trim().is_empty()
                && t.text.len() <= MAX_TARGET_TEXT
                && t.x.is_finite()
                && t.y.is_finite()
        })
        .map(|t| crate::store::StyleTargetSnap {
            x: clamp01(t.x),
            y: clamp01(t.y),
            text: t.text,
            sample: None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The padWeights.test.ts fixtures, ported with the geometry (the
    // semantics are a shipped contract, not a choice).

    #[test]
    fn weights_normalise_and_favour_the_nearer_target() {
        let targets = [(0.2, 0.5), (0.8, 0.5)];
        let weights = pad_weights(&targets, (0.35, 0.5));
        assert!((weights.iter().sum::<f32>() - 1.0).abs() < 1e-6);
        assert!(weights[0] > weights[1]);
    }

    #[test]
    fn an_exact_hit_takes_the_whole_blend() {
        let targets = [(0.2, 0.5), (0.8, 0.5)];
        let weights = pad_weights(&targets, (0.8, 0.5));
        assert_eq!(weights, vec![0.0, 1.0]);
    }

    #[test]
    fn sweep_starts_at_twelve_o_clock_and_runs_clockwise() {
        let (x0, y0) = sweep_position(0.0);
        assert!((x0 - 0.5).abs() < 1e-6);
        assert!(y0 < 0.5); // 12 o'clock is up (y grows downward on the pad)
        let (x_quarter, _) = sweep_position(0.25);
        assert!(x_quarter > 0.5); // a quarter turn lands at 3 o'clock
    }

    #[test]
    fn spawn_picks_the_clearest_slot() {
        // With slot 0 occupied, the spawn goes far from it…
        let spawned = spawn_position(&[circle_slot(0)]);
        let d0 = ((spawned.0 - circle_slot(0).0).powi(2)
            + (spawned.1 - circle_slot(0).1).powi(2))
        .sqrt();
        assert!(d0 > CIRCLE_RADIUS); // at least across the circle
        // …and an empty pad spawns on slot 0 deterministically.
        assert_eq!(spawn_position(&[]), circle_slot(0));
    }
}

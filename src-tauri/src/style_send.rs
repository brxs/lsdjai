//! The shell-side style sender (ADR-0020 phase B).
//!
//! The store owns the pad arrangement (targets + cursor + selection); this
//! service owns getting the blend to the workers. It watches the store,
//! computes the inverse-square blend ([`crate::style::pad_weights`]) over a
//! deck's targets, and forwards the `set_style` control frame to that deck's
//! sidecar — immediately for a discrete edit, coalesced to a trailing edge
//! during a drag (the webview's immediate/throttled split, one mechanism).
//! An empty pad sends nothing: the worker keeps its last conditioning, the
//! shipped behaviour. A restarted worker lost its conditioning, so the
//! sidecar relay pokes [`StyleSender::resend`] on `ready`. (The arrangement
//! persists through the settings watcher, `settings::watch_persistence`.)

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::sidecar::Sidecars;
use crate::store::{DeckSnap, InterfaceStore};

/// The blend-send coalescing window (the webview's drag throttle).
const SEND_WINDOW: Duration = Duration::from_millis(150);

/// One deck's send state.
#[derive(Default)]
struct Lane {
    /// The latest `set_style` payload for the deck (`None` while the pad is
    /// empty — nothing to condition with).
    desired: Option<String>,
    /// The payload last handed to the sidecar, so unrelated store churn
    /// (analysis ticks, mixer moves) never re-sends an unchanged blend.
    sent: Option<String>,
    last_send: Option<Instant>,
    dirty: bool,
}

pub struct StyleSender {
    lanes: Arc<Mutex<Vec<Lane>>>,
    tx: mpsc::Sender<()>,
}

impl StyleSender {
    /// Spawn the sender thread. The sidecars are reached through managed
    /// state at send time (`try_state`), so start order does not matter.
    pub fn start(app: AppHandle) -> Self {
        let lanes: Arc<Mutex<Vec<Lane>>> = Arc::new(Mutex::new(
            (0..lsdj_engine::DECK_COUNT).map(|_| Lane::default()).collect(),
        ));
        let (tx, rx) = mpsc::channel::<()>();
        let thread_lanes = lanes.clone();
        std::thread::spawn(move || run(app, thread_lanes, rx));
        StyleSender { lanes, tx }
    }

    /// Follow the store: recompute each deck's blend on every change and mark
    /// changed lanes for sending. Also primes the lanes from the current
    /// snapshot so a boot-hydrated arrangement is ready for the first worker
    /// `ready` (primed lanes are not dirty — the worker asks via `resend`).
    pub fn watch_store(&self, store: &InterfaceStore) {
        let lanes = self.lanes.clone();
        let tx = self.tx.clone();
        store.watch(move |state| {
            let mut nudge = false;
            {
                let mut lanes = lanes.lock().unwrap_or_else(|p| p.into_inner());
                for (lane, deck) in lanes.iter_mut().zip(state.decks.iter()) {
                    let payload = blend_payload(deck);
                    if payload == lane.desired {
                        continue;
                    }
                    lane.desired = payload;
                    // A dead or reloading worker can't take conditioning; the
                    // `ready` resend delivers the arrangement it missed.
                    if lane.desired.is_some()
                        && lane.desired != lane.sent
                        && !deck.worker_died
                        && !deck.switching_model
                    {
                        lane.dirty = true;
                        nudge = true;
                    }
                }
            }
            if nudge {
                let _ = tx.send(());
            }
        });
        // Prime after registration: only never-touched lanes (desired None)
        // take the snapshot, so a concurrent watcher call can't be undone by
        // older data.
        let snapshot = store.snapshot();
        let mut lanes = self.lanes.lock().unwrap_or_else(|p| p.into_inner());
        for (lane, deck) in lanes.iter_mut().zip(snapshot.decks.iter()) {
            if lane.desired.is_none() {
                lane.desired = blend_payload(deck);
            }
        }
    }

    /// A restarted worker announced `ready`: its conditioning is gone, so the
    /// current blend goes again, immediately.
    pub fn resend(&self, deck: usize) {
        {
            let mut lanes = self.lanes.lock().unwrap_or_else(|p| p.into_inner());
            let Some(lane) = lanes.get_mut(deck) else { return };
            if lane.desired.is_none() {
                return;
            }
            lane.sent = None;
            lane.last_send = None;
            lane.dirty = true;
        }
        let _ = self.tx.send(());
    }
}

/// The `set_style` control frame for a deck's current arrangement, or `None`
/// for an empty pad. Weights come from the same inverse-square geometry the
/// webview computed; sampled chips ride along under their session key.
fn blend_payload(deck: &DeckSnap) -> Option<String> {
    if deck.style_targets.is_empty() {
        return None;
    }
    let points: Vec<(f32, f32)> = deck.style_targets.iter().map(|t| (t.x, t.y)).collect();
    let weights = crate::style::pad_weights(&points, (deck.cursor.x, deck.cursor.y));
    let prompts: Vec<_> = deck
        .style_targets
        .iter()
        .zip(weights)
        .map(|(target, weight)| {
            let mut entry = json!({ "text": target.text, "weight": weight });
            if let Some(sample) = &target.sample {
                entry["sample"] = json!(sample);
            }
            entry
        })
        .collect();
    Some(json!({ "type": "set_style", "prompts": prompts }).to_string())
}

/// The sender thread: waits for a nudge (or a lane's window to elapse) and
/// flushes every due lane. Control writes happen outside the lane lock — a
/// blocked sidecar socket must not stall the store's watcher path.
fn run(app: AppHandle, lanes: Arc<Mutex<Vec<Lane>>>, rx: mpsc::Receiver<()>) {
    loop {
        let next_due = {
            let lanes = lanes.lock().unwrap_or_else(|p| p.into_inner());
            lanes
                .iter()
                .filter(|lane| lane.dirty)
                .map(|lane| lane.last_send.map(|at| at + SEND_WINDOW))
                .min()
                .map(|due| due.unwrap_or_else(Instant::now))
        };
        match next_due {
            None => {
                if rx.recv().is_err() {
                    return;
                }
            }
            Some(due) => {
                let now = Instant::now();
                if due > now {
                    if let Err(mpsc::RecvTimeoutError::Disconnected) = rx.recv_timeout(due - now)
                    {
                        return;
                    }
                }
            }
        }
        let now = Instant::now();
        let mut sends: Vec<(usize, String)> = Vec::new();
        {
            let mut lanes = lanes.lock().unwrap_or_else(|p| p.into_inner());
            for (idx, lane) in lanes.iter_mut().enumerate() {
                let due = lane.last_send.is_none_or(|at| at + SEND_WINDOW <= now);
                if lane.dirty && due {
                    if let Some(payload) = lane.desired.clone() {
                        lane.sent = Some(payload.clone());
                        lane.last_send = Some(now);
                        sends.push((idx, payload));
                    }
                    lane.dirty = false;
                }
            }
        }
        if let Some(sidecars) = app.try_state::<Sidecars>() {
            for (deck, payload) in sends {
                sidecars.send(deck, &payload);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{PadPointSnap, StyleTargetSnap};

    fn deck_with(targets: Vec<StyleTargetSnap>, cursor: PadPointSnap) -> DeckSnap {
        let mut deck = crate::store::InterfaceState::default().decks[0].clone();
        deck.style_targets = targets;
        deck.cursor = cursor;
        deck
    }

    #[test]
    fn an_empty_pad_sends_nothing() {
        let deck = deck_with(Vec::new(), PadPointSnap { x: 0.5, y: 0.5 });
        assert_eq!(blend_payload(&deck), None);
    }

    #[test]
    fn the_payload_carries_blended_weights_and_sample_keys() {
        let deck = deck_with(
            vec![
                StyleTargetSnap { x: 0.2, y: 0.5, text: "dub".into(), sample: None },
                StyleTargetSnap {
                    x: 0.8,
                    y: 0.5,
                    text: "Deck B sample 1".into(),
                    sample: Some("sample:b:1".into()),
                },
            ],
            PadPointSnap { x: 0.2, y: 0.5 },
        );
        let payload: serde_json::Value =
            serde_json::from_str(&blend_payload(&deck).unwrap()).unwrap();
        assert_eq!(payload["type"], "set_style");
        // The cursor sits exactly on "dub": the whole blend is its.
        assert_eq!(payload["prompts"][0]["text"], "dub");
        assert_eq!(payload["prompts"][0]["weight"], 1.0);
        assert!(payload["prompts"][0].get("sample").is_none());
        assert_eq!(payload["prompts"][1]["weight"], 0.0);
        assert_eq!(payload["prompts"][1]["sample"], "sample:b:1");
    }
}

// The M14 spike measurement: the SHIPPING estimator over real
// generated audio. Plain JS on purpose: node APIs stay outside the
// DOM-typed app project (the kernel-test precedent). Skipped until
// the corpus exists — generate it with
//   cd backend && uv run python scripts/spike_beat_corpus.py
// (needs the model weights). Findings land in
// docs/spike-beat-detection.md.
//
// Ship criterion: every rhythmic style ends with a displayed BPM that
// octave-matches the librosa reference; every beatless style ends
// with an honest blank.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createBeatGate, createBeatTracker } from './beat'
import { readWav } from '../test/readWav.js'

// vitest runs with cwd = frontend/ (import.meta.url is not a file URL
// under the jsdom transform).
const CORPUS = path.resolve(process.cwd(), '../backend/spike_corpus')
const MANIFEST = path.join(CORPUS, 'manifest.json')

const entries = existsSync(MANIFEST)
  ? JSON.parse(readFileSync(MANIFEST, 'utf8'))
  : []

// Trackers disagree along standard metrical levels (the dnb clip's
// librosa tempogram has 89.3 and 119.7 nearly tied — a 4:3 relation),
// so accept the binary and ternary relatives, the usual tempo-eval
// practice. The hardware checklist's hand-count is the final arbiter.
const METRICAL_LEVELS = [0.5, 2 / 3, 0.75, 1, 4 / 3, 1.5, 2]
function metricallyMatches(estimate, reference) {
  return METRICAL_LEVELS.some(
    (factor) => Math.abs(estimate * factor - reference) / reference <= 0.08,
  )
}

describe('beat estimator on the spike corpus', () => {
  if (entries.length === 0) {
    it.skip('corpus not generated (backend/scripts/spike_beat_corpus.py)', () => {})
    return
  }

  it.each(entries.map((entry) => [entry.file, entry]))('%s', (_file, entry) => {
    const { sampleRate, samples } = readWav(path.join(CORPUS, entry.file))
    const tracker = createBeatTracker(sampleRate)
    const gate = createBeatGate()

    // Stream exactly like the live feed: 40 ms chunks, an estimate
    // through the gate once per second.
    const chunk = Math.round(0.04 * sampleRate) * 2
    const perSecond = Math.round(sampleRate * 2)
    let sinceEstimate = 0
    let displayedSeconds = 0
    let totalSeconds = 0
    let firstShownAt = null
    const confidences = []
    for (let i = 0; i < samples.length; i += chunk) {
      tracker.push(samples.subarray(i, i + chunk))
      sinceEstimate += chunk
      if (sinceEstimate >= perSecond) {
        sinceEstimate = 0
        totalSeconds += 1
        const estimate = tracker.estimate()
        if (estimate) confidences.push(estimate.confidence)
        const shown = gate.push(estimate)
        if (shown !== null) {
          displayedSeconds += 1
          firstShownAt ??= totalSeconds
        }
      }
    }

    const final = gate.current()
    const spread =
      confidences.length === 0
        ? 'none'
        : `${Math.min(...confidences).toFixed(2)}–${Math.max(...confidences).toFixed(2)}`
    // process.stdout, not console: vitest mutes console output from
    // passing tests, and the table is the spike's deliverable.
    process.stdout.write(
      `${entry.file.padEnd(16)} librosa ${String(entry.librosa_bpm).padStart(6)}` +
        ` | shown ${final === null ? '     —' : final.toFixed(1).padStart(6)}` +
        ` | confidence ${spread}` +
        ` | displayed ${displayedSeconds}/${totalSeconds}s` +
        ` | first at ${firstShownAt ?? '—'}s\n`,
    )

    if (entry.expect === 'rhythmic') {
      expect(final).not.toBeNull()
      expect(metricallyMatches(final, entry.librosa_bpm)).toBe(true)
    } else if (entry.expect === 'beatless') {
      expect(final).toBeNull()
    } else {
      // Ambiguous material (librosa itself has no candidate above
      // ~0.43 on the triphop clip): a blank is honest, a shown tempo
      // must still sit on a metrical level of the reference.
      if (final !== null) {
        expect(metricallyMatches(final, entry.librosa_bpm)).toBe(true)
      }
    }
  })
})

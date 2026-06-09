// Throwaway M1 test player (replaced by the React app in M2).
// Ring-buffers interleaved stereo float32 PCM posted from the main thread and
// plays it, counting underrun events. Playback starts (and restarts after an
// underrun) only once PREBUFFER_SECONDS of audio is queued, so one slow chunk
// causes a single counted gap instead of a crackle storm.

const CAPACITY_SECONDS = 30;
const PREBUFFER_SECONDS = 1.5;
const STATS_INTERVAL_SECONDS = 1;

class PCMPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = sampleRate * CAPACITY_SECONDS;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.readPos = 0;
    this.writePos = 0;
    this.available = 0;
    this.started = false;
    this.underruns = 0;
    this.framesSinceStats = 0;
    this.port.onmessage = (event) => this.enqueue(event.data);
  }

  enqueue(interleaved) {
    const frames = interleaved.length / 2;
    for (let i = 0; i < frames; i++) {
      this.left[this.writePos] = interleaved[2 * i];
      this.right[this.writePos] = interleaved[2 * i + 1];
      this.writePos = (this.writePos + 1) % this.capacity;
    }
    this.available = Math.min(this.available + frames, this.capacity);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;

    if (!this.started && this.available >= sampleRate * PREBUFFER_SECONDS) {
      this.started = true;
    }

    if (this.started && this.available >= frames) {
      for (let i = 0; i < frames; i++) {
        out[0][i] = this.left[this.readPos];
        out[1][i] = this.right[this.readPos];
        this.readPos = (this.readPos + 1) % this.capacity;
      }
      this.available -= frames;
    } else if (this.started) {
      this.underruns += 1;
      this.started = false; // re-arm the prebuffer; outputs stay silent
    }

    this.framesSinceStats += frames;
    if (this.framesSinceStats >= sampleRate * STATS_INTERVAL_SECONDS) {
      this.framesSinceStats = 0;
      this.port.postMessage({
        underruns: this.underruns,
        bufferedSeconds: this.available / sampleRate,
        playing: this.started,
      });
    }
    return true;
  }
}

registerProcessor('pcm-player', PCMPlayer);

/* The microphone's samples, handed to the page as they come (ui/voice.js).
 *
 * An audio worklet is the one place a page is given raw sound without a
 * deprecated node, and it has to be a file of its own: the engine loads it
 * into the audio thread by its URL. It keeps nothing. Each block the engine
 * gives it -- 128 samples -- is gathered into pieces of 2048 and posted, so
 * the page sends the daemon some twenty frames a second and not four hundred.
 */
registerProcessor("snyvi-take", class extends AudioWorkletProcessor {
  constructor() { super(); this.held = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.held[this.n++] = ch[i];
      if (this.n === this.held.length) { this.port.postMessage(this.held.slice()); this.n = 0; }
    }
    return true;
  }
});

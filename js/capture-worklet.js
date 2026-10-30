// Runs on the audio thread: collects mic samples into fixed blocks and hands them to the page.
class Capture extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.size = (opts.processorOptions && opts.processorOptions.blockSize) || 1024;
    this.buf = new Float32Array(this.size);
    this.i = 0;
    this.peak = 0;
  }
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length) {
      const n = chans[0].length, k = chans.length;
      for (let s = 0; s < n; s++) {
        let v = 0;
        for (let c = 0; c < k; c++) v += chans[c][s];
        v /= k;
        this.buf[this.i++] = v;
        const a = v < 0 ? -v : v;
        if (a > this.peak) this.peak = a;
        if (this.i === this.size) {
          this.port.postMessage({ samples: this.buf, peak: this.peak }, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.i = 0;
          this.peak = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);

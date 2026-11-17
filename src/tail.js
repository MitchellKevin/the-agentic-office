// Incremental JSONL reader. Tracks a byte offset per file and keeps any partial
// last line in a buffer until the rest of it is written.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const CHUNK = 1 << 20;

export class Tail {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
    this.reading = null;
    this.again = false;
  }

  reset() {
    this.offset = 0;
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
  }

  /**
   * Read everything appended since the last call. onLine(obj) gets parsed JSON;
   * onError(line) gets unparsable complete lines. Returns { truncated, lines }.
   * Concurrent calls are coalesced into one follow-up read.
   */
  async read(onLine, onError) {
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    this.reading = this._read(onLine, onError).finally(() => { this.reading = null; });
    const res = await this.reading;
    if (this.again) {
      this.again = false;
      return this.read(onLine, onError);
    }
    return res;
  }

  async _read(onLine, onError) {
    let fh;
    try {
      fh = await fs.promises.open(this.file, 'r'); // read-only, always
    } catch (e) {
      if (e.code === 'ENOENT') return { truncated: false, lines: 0, missing: true };
      throw e;
    }
    let lines = 0;
    let truncated = false;
    try {
      const { size } = await fh.stat();
      if (size < this.offset) { // file was replaced or truncated
        this.reset();
        truncated = true;
      }
      const buf = Buffer.allocUnsafe(CHUNK);
      while (this.offset < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const text = this.partial + this.decoder.write(buf.subarray(0, bytesRead));
        const parts = text.split('\n');
        this.partial = parts.pop();
        for (const line of parts) {
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { onError?.(line); continue; }
          lines++;
          onLine(obj);
        }
      }
      // A final line without "\n" that is already valid JSON is complete enough to use
      // only once more bytes arrive; leave it in the buffer.
    } finally {
      await fh.close();
    }
    return { truncated, lines };
  }
}

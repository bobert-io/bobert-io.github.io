// SPDX-License-Identifier: GPL-3.0-or-later
// Static developer worker. UCI parsing/search/inference are all inside lc0.
let engine;
let starting = false;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      if (starting || engine) throw new Error('Engine already started');
      starting = true;
      if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
        throw new Error('Threaded lc0 requires cross-origin isolation and SharedArrayBuffer');
      }
      importScripts('./lc0.js');
      // Avoid .gz: Vite treats that suffix as HTTP content encoding and browsers
      // decompress it before our archive checksum / lc0's own loader sees it.
      const response = await fetch('./maia-1500.weights');
      if (!response.ok) throw new Error(`Maia download failed: HTTP ${response.status}`);
      const weights = await response.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', weights)),
        byte => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== '35ab6f20421d59e1df3b17c5a5016947af4c6761368ef84044a9a9c7619a9a00') {
        throw new Error('Maia fixture checksum mismatch');
      }
      engine = await self.createLc0({
        // importScripts makes self.location the bridge URL, not the generated
        // runtime URL. Pthreads must boot lc0.js, never this bridge again.
        mainScriptUrlOrBlob: new URL('./lc0.js', self.location.href).href,
        print: line => self.postMessage({ type: 'uci', line }),
        printErr: line => self.postMessage({ type: 'diagnostic', line }),
        onAbort: reason => self.postMessage({ type: 'error', message: String(reason) }),
      });
      engine.FS.writeFile('/maia.pb.gz', new Uint8Array(weights));
      self.postMessage({ type: 'loaded', threads: engine.PThread.unusedWorkers.length });
    } else if (data.type === 'uci') {
      if (!engine) throw new Error('Engine not loaded');
      if (typeof data.line !== 'string' || /[\r\n\0]/.test(data.line)) {
        throw new Error('Expected one UCI command');
      }
      const result = engine.ccall('lc0_command', 'number', ['string'], [data.line]);
      if (result < 0) throw new Error('lc0 rejected the command; see UCI error output');
      if (/^go\b/.test(data.line)) {
        self.postMessage({ type: 'diagnostic', line: `active pthread workers=${engine.PThread.runningWorkers.length}` });
      }
      if (result === 0) {
        engine.PThread.terminateAllThreads();
        self.postMessage({ type: 'closed' });
        self.close();
      }
    } else throw new Error('Unknown worker message');
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

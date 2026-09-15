const get = id => document.getElementById(id);
const log = line => { get('log').textContent += `${performance.now().toFixed(1)} ${line}\n`; };
let worker;
let watchdog;
let searchStarted;
let stopStarted;
let loadingStarted;
let waitingForUci = false;

function controls(ready) {
  for (const id of ['search', 'stop', 'send', 'quit']) get(id).disabled = !ready;
  get('start').disabled = !!worker;
}
function terminate(message) {
  clearTimeout(watchdog);
  worker?.terminate();
  worker = undefined;
  get('status').textContent = message;
  controls(false);
}
function armTimeout(ms, label) {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => terminate(`${label}: worker terminated; load again to recover`), ms);
}
function send(line) {
  if (!worker) throw new Error('Engine not loaded');
  log(`> ${line}`);
  if (/^go\b/.test(line)) {
    searchStarted = performance.now();
    stopStarted = undefined;
    // Even a developer's `go infinite` has an outer recovery deadline.
    armTimeout(30000, 'Search timed out');
  } else if (line === 'stop') {
    stopStarted = performance.now();
    armTimeout(500, 'Stop timed out');
  } else if (line === 'quit') armTimeout(1000, 'Teardown timed out');
  else if (line === 'isready') armTimeout(30000, 'Readiness timed out');
  worker.postMessage({ type: 'uci', line });
}
get('start').onclick = () => {
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    get('status').textContent = 'Cross-origin isolation is missing; threaded lc0 cannot start.';
    return;
  }
  log(navigator.userAgent);
  log(`hardwareConcurrency=${navigator.hardwareConcurrency}; crossOriginIsolated=${crossOriginIsolated}`);
  worker = new Worker(new URL('./worker.js', import.meta.url));
  const current = worker;
  loadingStarted = performance.now();
  waitingForUci = true;
  controls(false);
  get('status').textContent = 'Loading WASM and Maia…';
  armTimeout(60000, 'Initialization timed out');
  worker.onerror = event => terminate(`Worker error: ${event.message}`);
  worker.onmessageerror = () => terminate('Worker message could not be decoded');
  worker.onmessage = ({ data }) => {
    if (worker !== current) return;
    if (data.type === 'error') return terminate(data.message);
    if (data.type === 'closed') return terminate('Engine and pthread pool closed');
    if (data.type === 'loaded') {
      log(`WASM loaded; preallocated pthread workers=${data.threads}`);
      send('uci');
    } else if (data.type === 'uci') {
      log(`< ${data.line}`);
      if (data.line.startsWith('error ')) return terminate(data.line);
      if (data.line === 'uciok' && waitingForUci) {
        waitingForUci = false;
        for (const option of ['WeightsFile value /maia.pb.gz', 'Backend value eigen',
          'Threads value 2', 'TaskWorkers value 0', 'MinibatchSize value 1',
          'NNCacheSize value 10000', 'ScoreType value centipawn', 'ContemptMode value disable']) {
          send(`setoption name ${option}`);
        }
        send('isready');
      } else if (data.line === 'readyok') {
        clearTimeout(watchdog);
        get('status').textContent = `Ready; load/UCI handshake ${(performance.now() - loadingStarted).toFixed(1)} ms (first search also initializes inference)`;
        controls(true);
      } else if (data.line.startsWith('bestmove ')) {
        clearTimeout(watchdog);
        if (searchStarted !== undefined) log(`search wall time ${(performance.now() - searchStarted).toFixed(1)} ms`);
        if (stopStarted !== undefined) log(`stop response ${(performance.now() - stopStarted).toFixed(1)} ms`);
        searchStarted = stopStarted = undefined;
      }
    } else if (data.type === 'diagnostic') log(`! ${data.line}`);
  };
  worker.postMessage({ type: 'load' });
};
get('search').onclick = () => {
  send('ucinewgame');
  send('position startpos');
  send('go nodes 1');
};
get('stop').onclick = () => send('stop');
get('quit').onclick = () => send('quit');
get('command-form').onsubmit = event => {
  event.preventDefault();
  send(get('command').value.trim());
};
window.addEventListener('pagehide', () => {
  // The document is going away; cleanup must not depend on touching its DOM.
  clearTimeout(watchdog);
  worker?.terminate();
  worker = undefined;
});

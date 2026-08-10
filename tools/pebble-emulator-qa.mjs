import {randomUUID} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {createInterface} from 'node:readline';

const EMERY_SIZE = Object.freeze({width: 200, height: 228});
const EMULATOR_LOCK = '/private/tmp/pebble-emulator-qa.lock';
const SIGNAL_EXIT = {SIGHUP: 129, SIGINT: 130, SIGTERM: 143};

function interrupted(signal) {
  const error = new Error(`Pebble emulator QA interrupted by ${signal}`);
  error.exitCode = SIGNAL_EXIT[signal] || 1;
  return error;
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', abort, {once: true});
  });
}

function abortable(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    function abort() { reject(signal.reason); }
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(value).then(
      (result) => { signal.removeEventListener('abort', abort); resolve(result); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? 'pipe' : options.quiet ? 'ignore' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return options.capture ? result.stdout.trim() : '';
}

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function staleLock(path) {
  try {
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    if (Number.isSafeInteger(owner.pid) && owner.pid > 0) return !pidIsAlive(owner.pid);
  } catch {}
  try { return Date.now() - statSync(path).mtimeMs > 10_000; }
  catch { return false; }
}

async function acquireEmulatorLock(app, path, signal) {
  const token = randomUUID();
  while (true) {
    if (signal?.aborted) throw signal.reason;
    let created = false;
    try {
      mkdirSync(path, {mode: 0o700});
      created = true;
      writeFileSync(join(path, 'owner.json'), `${JSON.stringify({
        pid: process.pid, app, token, at: new Date().toISOString(),
      })}\n`, {mode: 0o600});
      return () => {
        try {
          const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
          if (owner.pid === process.pid && owner.token === token) {
            rmSync(path, {recursive: true, force: true});
          }
        } catch {}
      };
    } catch (error) {
      if (created) rmSync(path, {recursive: true, force: true});
      if (error.code !== 'EEXIST') throw error;
      if (staleLock(path)) {
        rmSync(path, {recursive: true, force: true});
        continue;
      }
      console.log('Waiting for the shared Pebble emulator QA lock...');
      await delay(1000, signal);
    }
  }
}

function pebblePython(cwd, pebbleCli) {
  const pebble = realpathSync(run('which', [pebbleCli], {cwd, capture: true}));
  return join(dirname(pebble), 'python');
}

function isolateEmulatorState({app, cwd, pebbleCli, platform}) {
  const python = pebblePython(cwd, pebbleCli);
  const persist = run(python, ['-c',
    `from pebble_tool.sdk import get_sdk_persist_dir; print(get_sdk_persist_dir("${platform}"))`,
  ], {cwd, capture: true});
  const backup = join(dirname(persist),
    `${basename(persist)}.${app}-qa-backup-${process.pid}-${Date.now()}`);
  const existed = existsSync(persist);
  if (existed) renameSync(persist, backup);
  try {
    mkdirSync(persist, {recursive: true});
  } catch (error) {
    if (existed) renameSync(backup, persist);
    throw error;
  }
  let restored = false;
  return () => {
    if (restored) return;
    rmSync(persist, {recursive: true, force: true});
    if (existed) renameSync(backup, persist);
    restored = true;
  };
}

async function waitForChild(child, timeoutMs) {
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

async function stopPid(pid) {
  if (!pidIsAlive(pid)) return;
  try { process.kill(pid, 'SIGKILL'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  for (let attempt = 0; attempt < 40 && pidIsAlive(pid); attempt += 1) {
    await delay(50);
  }
  if (pidIsAlive(pid)) throw new Error(`Owned QEMU process ${pid} did not exit`);
}

function startCaptureSession({app, cwd, pbw, captureHelper, pebbleCli, platform, timeoutSeconds}) {
  const args = [captureHelper, '--emulator', platform, '--serve', '--pbw', pbw,
    '--platform', platform];
  if (timeoutSeconds) args.push('--timeout', String(timeoutSeconds));
  const child = spawn(pebblePython(cwd, pebbleCli), args,
    {cwd, stdio: ['pipe', 'pipe', 'pipe']});
  const lines = createInterface({input: child.stdout});
  const pending = [];
  let resolveReady;
  let rejectReady;
  let closePromise;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const session = {
    child,
    ready,
    qemuPid: null,
    capture(request) {
      return new Promise((resolve, reject) => {
        const pendingRequest = {resolve, reject};
        pending.push(pendingRequest);
        child.stdin.write(`${JSON.stringify({...request, command: 'capture'})}\n`, (error) => {
          if (!error) return;
          const index = pending.indexOf(pendingRequest);
          if (index >= 0) pending.splice(index, 1);
          reject(error);
        });
      });
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        let graceful = child.exitCode !== null;
        if (!graceful) {
          try { child.stdin.write('{"command":"close"}\n'); } catch {}
          graceful = await waitForChild(child, 3000);
        }
        if (!graceful && child.exitCode === null) {
          child.kill('SIGKILL');
          graceful = await waitForChild(child, 3000);
        }
        await stopPid(session.qemuPid);
        try { lines.close(); } catch {}
        if (!graceful && child.exitCode === null) {
          throw new Error(`${app} capture helper did not exit after SIGKILL`);
        }
      })();
      return closePromise;
    },
  };

  function failed(error) {
    rejectReady(error);
    while (pending.length) pending.shift().reject(error);
  }
  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(`[${app} capture] ${chunk}`));
  child.once('error', failed);
  child.once('exit', (code) => failed(
    new Error(`${app} capture session exited with status ${code}`),
  ));
  lines.on('line', (line) => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    if (response.event === 'ready') {
      session.qemuPid = response.qemuPid || null;
      resolveReady(response);
      return;
    }
    const request = pending.shift();
    if (!request) return;
    if (response.event === 'error') request.reject(new Error(response.message));
    else request.resolve(response);
  });
  return session;
}

function assertNativeEmery(path) {
  const data = readFileSync(path);
  if (data.length < 24 || data.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`${path} is not a PNG`);
  }
  const dimensions = {width: data.readUInt32BE(16), height: data.readUInt32BE(20)};
  if (dimensions.width !== EMERY_SIZE.width || dimensions.height !== EMERY_SIZE.height) {
    throw new Error(`${path} is ${dimensions.width}x${dimensions.height}, expected 200x228`);
  }
}

function contactSheetLabel(value, width = 24) {
  const lines = [];
  let line = '';
  for (const word of String(value).split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line += `${line ? ' ' : ''}${word}`;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function createNativeContactSheet(states, output, options) {
  const labels = states.flatMap((state, index) => [
    '(', state.path, '-set', 'label',
    contactSheetLabel(`${state.number || index + 1}. ${state.label}`), ')',
  ]);
  const geometry = `200x228+${options.gapX || 18}+${options.gapY || 48}`;
  const args = [...labels, '-tile', `${options.columns || 4}x`, '-geometry', geometry,
    '-background', options.background || '#101010', '-fill', options.foreground || '#f5f5ef',
    '-stroke', 'none', '-pointsize', String(options.pointSize || 16), '-depth', '8', output];
  const hasMagick = spawnSync('magick', ['-version'], {stdio: 'ignore'}).status === 0;
  run(hasMagick ? 'magick' : 'montage', hasMagick ? ['montage', ...args] : args,
    {cwd: options.cwd});
}

function addCleanupError(primary, error) {
  if (!primary) return error;
  console.error(`QA cleanup also failed: ${error.message}`);
  return primary;
}

/** Runs one isolated Emery capture session and produces native tiles plus a contact sheet. */
export async function runEmeryQa(options, scenarios, seams = {}) {
  if (!options?.app || !options.cwd || !options.pbw || !options.captureHelper) {
    throw new TypeError('app, cwd, pbw, and captureHelper are required');
  }
  if (typeof scenarios !== 'function') throw new TypeError('scenarios callback is required');
  const platform = 'emery';
  const pebbleCli = options.pebbleCli || 'pebble';
  const outputDir = options.outputDir || join(
    options.cwd, 'qa-results', `all-screens-${new Date().toISOString().replace(/[-:.]/g, '')}`,
  );
  const statesDir = join(outputDir, 'states');
  const lockPath = EMULATOR_LOCK;
  const acquireLock = seams.acquireLock || acquireEmulatorLock;
  const isolateState = seams.isolateState || isolateEmulatorState;
  const startSession = seams.startSession || startCaptureSession;
  const assertNative = seams.assertNative || assertNativeEmery;
  const createBoard = seams.createBoard || createNativeContactSheet;
  const controller = new AbortController();
  const signalHandlers = new Map();
  const deferred = [];
  const states = [];
  let releaseLock;
  let restoreState;
  let session;
  let primaryError;
  let result;
  let board;

  for (const signal of Object.keys(SIGNAL_EXIT)) {
    const handler = () => { if (!controller.signal.aborted) controller.abort(interrupted(signal)); };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    if (options.prepare) await abortable(options.prepare({
      run: (command, args, runOptions = {}) => run(command, args, {
        ...runOptions, cwd: runOptions.cwd || options.cwd,
      }),
    }), controller.signal);
    mkdirSync(statesDir, {recursive: true});
    releaseLock = await acquireLock(options.app, lockPath, controller.signal);
    restoreState = isolateState({app: options.app, cwd: options.cwd, pebbleCli, platform});
    session = startSession({
      app: options.app, cwd: options.cwd, pbw: options.pbw,
      captureHelper: options.captureHelper, pebbleCli, platform,
      timeoutSeconds: options.timeoutSeconds,
    });
    await abortable(session.ready, controller.signal);

    const context = {
      outputDir,
      statesDir,
      states,
      defer(cleanup) { deferred.push(cleanup); },
      captureRaw(output, request = {}) {
        return abortable(session.capture({...request, output}), controller.signal);
      },
      async capture(label, request = {}, metadata = {}) {
        const number = states.length + 1;
        const slug = String(metadata.slug || label).toLowerCase()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `state-${number}`;
        const filename = `${String(number).padStart(2, '0')}-${slug}.png`;
        const path = join(statesDir, filename);
        await abortable(session.capture({...request, output: path}), controller.signal);
        assertNative(path);
        const state = {...metadata, number, label, path, file: `states/${filename}`};
        delete state.slug;
        states.push(state);
        console.log(`Captured ${number}. ${label}`);
        return state;
      },
    };
    result = await abortable(scenarios(context), controller.signal);
    board = join(outputDir, 'all-states.png');
    createBoard(states, board, {cwd: options.cwd, ...(options.board || {})});
    const extraManifest = typeof options.manifest === 'function'
      ? options.manifest({states, result}) : options.manifest || {};
    writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({
      ...extraManifest,
      generatedAt: new Date().toISOString(),
      platform,
      nativeStateSize: EMERY_SIZE,
      sharedLock: lockPath,
      states: states.map(({path, ...state}) => state),
    }, null, 2)}\n`);
  } catch (error) {
    primaryError = error;
  } finally {
    if (session) {
      try { await session.close(); } catch (error) { primaryError = addCleanupError(primaryError, error); }
    }
    while (deferred.length) {
      try { await deferred.pop()(); } catch (error) { primaryError = addCleanupError(primaryError, error); }
    }
    if (restoreState) {
      try { restoreState(); } catch (error) { primaryError = addCleanupError(primaryError, error); }
    }
    if (releaseLock) {
      try { releaseLock(); } catch (error) { primaryError = addCleanupError(primaryError, error); }
    }
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
  if (primaryError) throw primaryError;
  return {board, outputDir, states, result};
}

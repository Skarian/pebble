#!/usr/bin/env node

import {spawn, spawnSync} from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE = resolve(ROOT, '../../tools/pebble-screenshot-tool/capture.py');
const PBW = join(ROOT, 'build/agents.pbw');
const LOCK = '/private/tmp/pebble-emulator-qa.lock';
const AGENTS = [
  {id: 'vm', label: 'VM Assistant'},
  {id: 'home', label: 'Home Operations'},
  {id: 'research', label: 'Deep Research'},
];

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
  return options.capture ? result.stdout.trim() : '';
}

async function acquireLock() {
  while (true) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, 'owner.json'), `${JSON.stringify({pid: process.pid, app: 'agents'})}\n`);
      return () => rmSync(LOCK, {recursive: true, force: true});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      console.log('Waiting for the shared Pebble emulator QA lock...');
      await wait(1000);
    }
  }
}

function pebblePython() {
  const pebble = realpathSync(run('which', ['pebble'], {capture: true}));
  return join(dirname(pebble), 'python');
}

function isolateEmulatorState() {
  const persist = run(pebblePython(), ['-c',
    'from pebble_tool.sdk import get_sdk_persist_dir; print(get_sdk_persist_dir("emery"))',
  ], {capture: true});
  const backup = `${persist}.agents-qa-backup-${process.pid}-${Date.now()}`;
  const existed = existsSync(persist);
  if (existed) renameSync(persist, backup);
  mkdirSync(persist, {recursive: true});
  return () => {
    rmSync(persist, {recursive: true, force: true});
    if (existed) renameSync(backup, persist);
  };
}

function startSession(pbw) {
  const child = spawn(pebblePython(), [CAPTURE, '--emulator', 'emery', '--serve',
    '--pbw', pbw, '--platform', 'emery', '--timeout', '120'],
  {cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe']});
  const lines = createInterface({input: child.stdout});
  const pending = [];
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolveValue, rejectValue) => {
    resolveReady = resolveValue;
    rejectReady = rejectValue;
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[capture] ${chunk}`));
  lines.on('line', (line) => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    if (response.event === 'ready') { resolveReady(response); return; }
    const request = pending.shift();
    if (!request) return;
    response.event === 'error' ? request.reject(new Error(response.message)) : request.resolve(response);
  });
  child.once('exit', (code) => {
    const error = new Error(`Agents capture session exited with ${code}`);
    rejectReady(error);
    while (pending.length) pending.shift().reject(error);
  });
  return {
    child, ready,
    capture(request) {
      return new Promise((resolveCapture, reject) => {
        pending.push({resolve: resolveCapture, reject});
        child.stdin.write(`${JSON.stringify({command: 'capture', ...request})}\n`);
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      child.stdin.write('{"command":"close"}\n');
      await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), wait(3000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

function agentsMessage(agents = AGENTS) {
  const message = {
    0: {type: 'uint8', value: 10},
    9: {type: 'uint8', value: 1},
    11: {type: 'uint8', value: 0},
    5: {type: 'uint8', value: agents.length},
  };
  agents.forEach((agent, index) => {
    message[100 + index * 2] = {type: 'cstring', value: agent.id};
    message[101 + index * 2] = {type: 'cstring', value: agent.label};
  });
  return message;
}

function errorMessage(error) {
  return {
    0: {type: 'uint8', value: 240},
    6: {type: 'uint8', value: error},
    9: {type: 'uint8', value: 1},
  };
}

function createBoard(states, output) {
  const inputs = states.flatMap((state) => ['(', state.path, '-set', 'label',
    `${state.number}. ${state.label}`, ')']);
  run('magick', ['montage', ...inputs, '-filter', 'point', '-resize', '400x456',
    '-tile', '4x', '-geometry', '400x456+24+64', '-background', '#101010',
    '-fill', '#f5f5ef', '-stroke', 'none', '-pointsize', '24', '-depth', '8', output]);
}

async function main() {
  run('npm', ['test']);
  run('pebble', ['build'], {env: {...process.env, AGENTS_QA: '1'}});
  const qaPbw = `/private/tmp/agents-qa-${process.pid}.pbw`;
  copyFileSync(PBW, qaPbw);
  run('pebble', ['clean']);
  run('pebble', ['build']);
  const releaseLock = await acquireLock();
  let restoreState;
  let session;
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const outputDir = join(ROOT, 'qa-results', `all-screens-${stamp}`);
  const statesDir = join(outputDir, 'states');
  mkdirSync(statesDir, {recursive: true});
  const states = [];
  try {
    restoreState = isolateEmulatorState();
    session = startSession(qaPbw);
    await session.ready;
    async function capture(label, options = {}) {
      const number = states.length + 1;
      const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const path = join(statesDir, `${String(number).padStart(2, '0')}-${slug}.png`);
      await session.capture({output: path, ...options});
      const state = {number, label, path, file: `states/${String(number).padStart(2, '0')}-${slug}.png`};
      states.push(state);
      console.log(`Captured ${number}. ${label}`);
      return state;
    }

    await capture('FIRST AGENT - LAUNCH TARGET', {message: agentsMessage()});
    await capture('AGENT SUMMARY - REFRESH', {buttons: ['up']});
    await capture('SECOND AGENT', {buttons: ['down', 'down']});
    await capture('NATIVE DICTATION - LISTENING', {
      buttons: ['up', 'select'], voice: {transcription: 'Check the deployment status'},
      skipStable: true, waitMs: 450,
    });
    await capture('NATIVE TRANSCRIPT - CONFIRM', {
      buttons: ['select'], voice: {transcription: 'Check the deployment status'}, waitMs: 700,
    });
    await capture('SENDING', {
      buttons: ['select'], skipStable: true, waitMs: 600,
      bridge: {events: [{kind: 11, delayMs: 2200}]},
    });
    await capture('WORKING - ACCEPTED', {skipStable: true, waitMs: 1750});
    await capture('STREAMING COMMENTARY', {
      bridge: {pushEvents: [{kind: 12, text: 'Inspecting the deployment and checking the latest service health.'}]},
      skipStable: true, waitMs: 250,
    });
    const commentaryTop = await capture('STREAMING REPLACEMENT', {
      bridge: {pushEvents: [{kind: 12, text: 'The deployment is healthy. I am checking the final rollout details, recent service logs, migration status, worker health, queued jobs, database connections, cache health, background schedules, recent alerts, regional capacity, and the last several production checks before I report completion.'}]},
      skipStable: true, waitMs: 250,
    });
    const commentaryScrolled = await capture('STREAMING COMMENTARY - SCROLLED', {
      buttons: ['down', 'down', 'down', 'down'], skipStable: true, waitMs: 100,
    });
    if (readFileSync(commentaryTop.path).equals(readFileSync(commentaryScrolled.path))) {
      throw new Error('Streaming commentary did not visibly scroll');
    }
    await capture('FINAL RESPONSE', {
      bridge: {pushEvents: [{kind: 13, text: 'Deployment is complete and all health checks are passing.'}]},
    });
    await capture('MESSAGE HISTORY - NEWEST', {
      buttons: [{button: 'select', durationMs: 1000}], waitMs: 250, skipStable: true,
    });
    const marqueeStart = await capture('MESSAGE HISTORY - MARQUEE START', {
      buttons: ['up'], skipStable: true, waitMs: 100,
    });
    const marqueeLater = await capture('MESSAGE HISTORY - MARQUEE LATER', {
      skipStable: true, waitMs: 2600,
    });
    if (readFileSync(marqueeStart.path).equals(readFileSync(marqueeLater.path))) {
      throw new Error('Selected message marquee did not visibly advance');
    }
    await capture('BACK TO FINAL RESPONSE', {buttons: ['back']});
    await capture('AGENT READY AFTER TURN', {buttons: ['back']});
    await capture('NO AGENTS', {
      buttons: ['up', 'select'], bridge: {agents: []}, waitMs: 250,
    });
    await capture('PHONE OFFLINE', {message: errorMessage(2)});
    await capture('REFRESH FAILED - CACHE KEPT', {message: errorMessage(3)});
    await capture('DICTATION FAILED', {message: errorMessage(4)});
    await capture('NOT SENT - RETRY', {message: errorMessage(5)});
    await capture('STATUS UNKNOWN', {message: errorMessage(6)});
    await capture('AGENT FAILED', {message: errorMessage(7)});
    await capture('STREAM LOST', {message: errorMessage(8)});
    await capture('UPDATE REQUIRED', {message: errorMessage(9)});

    const board = join(outputDir, 'all-states.png');
    createBoard(states, board);
    writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify({
      generatedAt: new Date().toISOString(), platform: 'emery', productionPbw: PBW,
      nativeDictation: true, sharedLock: LOCK,
      states: states.map(({path, ...state}) => state),
    }, null, 2)}\n`);
    console.log(`AGENTS_QA_BOARD=${board}`);
    console.log(`AGENTS_PBW=${PBW}`);
  } finally {
    if (session) await session.close();
    if (restoreState) restoreState();
    releaseLock();
    rmSync(qaPbw, {force: true});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}

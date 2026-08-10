#!/usr/bin/env node

import {copyFileSync, readFileSync, rmSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runEmeryQa} from '../../../tools/pebble-emulator-qa.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE = resolve(ROOT, '../../tools/pebble-screenshot-tool/capture.py');
const PBW = join(ROOT, 'build/agents.pbw');
const AGENTS = [
  {id: 'vm', label: 'VM Assistant'},
  {id: 'home', label: 'Home Operations'},
  {id: 'research', label: 'Deep Research'},
];

function readyMessage() {
  return {
    0: {type: 'uint8', value: 19},
    9: {type: 'uint8', value: 1},
  };
}

function errorMessage(error) {
  return {
    0: {type: 'uint8', value: 240},
    6: {type: 'uint8', value: error},
    9: {type: 'uint8', value: 1},
  };
}

async function main() {
  const qaPbw = `/private/tmp/agents-qa-${process.pid}.pbw`;
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const outputDir = join(ROOT, 'qa-results', `all-screens-${stamp}`);
  try {
    const qa = await runEmeryQa({
      app: 'agents', cwd: ROOT, pbw: qaPbw, captureHelper: CAPTURE,
      outputDir, timeoutSeconds: 120,
      prepare({run}) {
        run('npm', ['test']);
        run('pebble', ['build'], {env: {...process.env, AGENTS_QA: '1'}});
        copyFileSync(PBW, qaPbw);
        run('pebble', ['clean']);
        run('pebble', ['build']);
      },
      manifest: {productionPbw: PBW, nativeDictation: true},
    }, async ({capture}) => {

    await capture('COLD START - SYNCING', {
      bridge: {agents: AGENTS}, skipStable: true, waitMs: 100,
    });
    await capture('FIRST AGENT - READY RECOVERY', {
      bridge: {agents: AGENTS}, message: readyMessage(), waitMs: 700,
    });
    await capture('NO RETAINED MESSAGES', {
      buttons: [{button: 'select', durationMs: 1000}], waitMs: 250, skipStable: true,
    });
    await capture('BACK FROM EMPTY HISTORY', {buttons: ['back']});
    await capture('AGENT SUMMARY - REFRESH', {buttons: ['up']});
    await capture('SECOND AGENT', {buttons: ['down', 'down']});
    await capture('NATIVE DICTATION - LISTENING', {
      buttons: ['up', 'select'], voice: {transcription: 'Check the deployment status'},
      skipStable: true, waitMs: 450,
    });
    await capture('NATIVE TRANSCRIPT - CONFIRM', {
      buttons: ['select'], voice: {transcription: 'Check the deployment status'}, waitMs: 700,
    });
    await capture('WORKING - DELIVERY ACKNOWLEDGED', {
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
    const finalTop = await capture('FINAL RESPONSE', {
      bridge: {pushEvents: [{kind: 13, text: 'Deployment is complete and all health checks are passing. The service rollout finished in every region, database migrations are current, background workers are healthy, queued jobs are draining normally, cache hit rates are stable, scheduled tasks are running, and the latest production checks show no active alerts or degraded dependencies.'}]},
    });
    const finalScrolled = await capture('FINAL RESPONSE - SCROLLED', {
      buttons: ['down', 'down', 'down', 'down'], skipStable: true, waitMs: 100,
    });
    if (readFileSync(finalTop.path).equals(readFileSync(finalScrolled.path))) {
      throw new Error('Final response did not visibly scroll above its fixed reply footer');
    }
    await capture('MESSAGE HISTORY - NEWEST', {
      buttons: [{button: 'select', durationMs: 1000}], waitMs: 250, skipStable: true,
    });
    const historyMessageTop = await capture('HISTORY MESSAGE - FULL SCREEN', {
      buttons: ['select'], waitMs: 250,
    });
    const historyMessageScrolled = await capture('HISTORY MESSAGE - SCROLLED', {
      buttons: ['down', 'down', 'down'], waitMs: 100, skipStable: true,
    });
    if (readFileSync(historyMessageTop.path).equals(readFileSync(historyMessageScrolled.path))) {
      throw new Error('Full history message did not visibly scroll');
    }
    await capture('BACK TO MESSAGE HISTORY', {buttons: ['back']});
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
    await capture('MESSAGE HISTORY - FROM AGENT', {
      buttons: [{button: 'select', durationMs: 1000}], waitMs: 250, skipStable: true,
    });
    await capture('BACK TO AGENT FROM HISTORY', {buttons: ['back']});
    await capture('NO AGENTS', {
      buttons: ['up', 'select'], bridge: {agents: []}, waitMs: 250,
    });
    await capture('PHONE OFFLINE', {message: errorMessage(2)});
    await capture('REFRESH FAILED - CACHE KEPT', {message: errorMessage(3)});
    await capture('DICTATION FAILED', {message: errorMessage(4)});
    await capture('NOT SENT - RETRY', {message: errorMessage(5)});
    await capture('STATUS UNKNOWN', {message: errorMessage(6)});
    await capture('MESSAGES FROM STATUS UNKNOWN', {
      buttons: [{button: 'select', durationMs: 1000}], waitMs: 250, skipStable: true,
    });
    await capture('BACK TO STATUS UNKNOWN', {buttons: ['back']});
    await capture('AGENT FAILED', {message: errorMessage(7)});
    await capture('STREAM LOST', {message: errorMessage(8)});
    await capture('UPDATE REQUIRED', {message: errorMessage(9)});

    });
    console.log(`AGENTS_QA_BOARD=${qa.board}`);
    console.log(`AGENTS_PBW=${PBW}`);
  } finally {
    rmSync(qaPbw, {force: true});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error); process.exitCode = error.exitCode || 1; });
}

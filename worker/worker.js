const { execFile, spawn } = require('child_process');
const axios = require('axios');
const https = require('https');

// Configure axios for connection reuse
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({
    keepAlive: true,
    maxSockets: 10
  }),
  timeout: 30000
});
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const MASTER_URL  = process.env.MASTER_URL || 'http://localhost:3000';
const WORKER_ID   = process.env.WORKER_ID  || uuidv4();
const TARGET_ADDR = '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU';
const CORES       = parseInt(process.env.CORES || os.cpus().length);
const BATCH_SIZE   = parseInt(process.env.BATCH_SIZE || 1); // Process multiple chunks
const WORK_DIR    = '/tmp/keyhunt-work';

fs.mkdirSync(WORK_DIR, { recursive: true });

let currentProcess = null;
let currentChunk   = null;
let keysPerSec     = 0;
let totalScanned   = 0n;
let running        = true;
let lastHeartbeat  = 0;

console.log(`
╔══════════════════════════════════════════╗
║   Bitcoin Puzzle #71 — Worker Node       ║
╠══════════════════════════════════════════╣
║  Worker ID : ${WORKER_ID.slice(0,8)}...           ║
║  Master    : ${MASTER_URL.slice(0,28).padEnd(28)} ║
║  Target    : ${TARGET_ADDR.slice(0,28).padEnd(28)} ║
║  CPU Cores : ${String(CORES).padEnd(28)} ║
╚══════════════════════════════════════════╝
`);

// ── Core: run keyhunt on a given range ───────────────────────────────────────
function runKeyhunt(startHex, endHex) {
  return new Promise((resolve, reject) => {
    // keyhunt -m bsgs -t <threads> -r <start>:<end> -f <address_file>
    const addrFile = path.join(WORK_DIR, 'target.txt');
    fs.writeFileSync(addrFile, TARGET_ADDR + '\n');

    const args = [
      '-m', 'bsgs',
      '-t', String(CORES),
      '-r', `${startHex}:${endHex}`,
      '-f', addrFile,
      '-k', '256',        // kangaroo factor
      '-b', '25',         // baby steps bit size
    ];

    console.log(`[→] Starting keyhunt: 0x${startHex} → 0x${endHex}`);
    console.log(`[→] Command: keyhunt ${args.join(' ')}`);

    const proc = spawn('keyhunt', args, {
      cwd: WORK_DIR,
      env: { ...process.env, OMP_NUM_THREADS: String(CORES) }
    });
    currentProcess = proc;

    let outputBuffer = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      outputBuffer += text;
      process.stdout.write(text);

      // Parse speed from keyhunt output: "xxx Mkeys/s"
      const speedMatch = text.match(/(\d+(?:\.\d+)?)\s*[MK]keys\/s/i);
      if (speedMatch) {
        const val = parseFloat(speedMatch[1]);
        keysPerSec = text.includes('M') ? Math.round(val * 1e6) : Math.round(val * 1e3);
      }

      // Check for key found
      // keyhunt prints: "WIF: xxxx" or "HEX: xxxx" when found
      const hexMatch  = text.match(/HEX[:\s]+([0-9a-fA-F]{64})/);
      const wifMatch  = text.match(/WIF[:\s]+([5KLc][1-9A-HJ-NP-Za-km-z]{50,51})/);
      const addrMatch = text.match(/address[:\s]+(1[1-9A-HJ-NP-Za-km-z]{25,34})/i);

      if (hexMatch || wifMatch) {
        const privateKey = hexMatch ? hexMatch[1] : wifMatch[1];
        const address    = addrMatch ? addrMatch[1] : TARGET_ADDR;
        console.log('\n\n🎉🎉🎉 KEY FOUND! 🎉🎉🎉');
        console.log('Private Key:', privateKey);
        proc.kill();
        resolve({ found: true, privateKey, address });
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      if (!text.includes('warning') && !text.includes('deprecated')) {
        process.stderr.write(text);
      }
    });

    proc.on('close', (code) => {
      currentProcess = null;
      if (code === 0 || code === null) {
        resolve({ found: false });
      } else {
        // Non-zero exit — try BitCrack as fallback
        console.log(`[!] keyhunt exited with code ${code}, trying bitcrack fallback...`);
        runBitcrack(startHex, endHex).then(resolve).catch(() => {
          // Both tools failed - mark as failed so chunk gets reassigned
          console.log('[!] Both keyhunt and bitcrack failed, chunk will be reassigned');
          resolve({ failed: true });
        });
      }
    });

    proc.on('error', (err) => {
      console.error('[!] keyhunt error:', err.message);
      runBitcrack(startHex, endHex).then(resolve).catch(() => {
        // Both tools failed - mark as failed so chunk gets reassigned
        console.log('[!] Both keyhunt and bitcrack failed, chunk will be reassigned');
        resolve({ failed: true });
      });
    });
  });
}

// ── Heartbeat to master ─────────────────────────────────────────────────────
async function sendHeartbeat() {
  if (Date.now() - lastHeartbeat < 30000) return; // Throttle to 30s
  try {
    await axiosInstance.post(`${MASTER_URL}/heartbeat`, {
      workerId: WORKER_ID,
      keysPerSec,
      currentKey: currentChunk ? `0x${currentChunk.start}` : ''
    });
    lastHeartbeat = Date.now();
  } catch (err) {
    // Silent fail
  }
}
function runBitcrack(startHex, endHex) {
  return new Promise((resolve, reject) => {
    // Check bitcrack exists - try multiple possible locations
    const possiblePaths = [
      '/usr/local/bin/bitcrack',
      '/usr/local/bin/clKeySearch',
      '/usr/local/bin/cuKeySearch',
      '/opt/bitcrack/bin/clKeySearch',
      '/opt/bitcrack/bin/cuKeySearch'
    ];

    let bitcrackBin = null;
    for (const path of possiblePaths) {
      if (fs.existsSync(path)) {
        bitcrackBin = path;
        break;
      }
    }

    if (!bitcrackBin) {
      console.log('[!] BitCrack not found in any expected location, skipping fallback');
      return reject(new Error('BitCrack not found'));
    }

    const args = [
      '--keyspace', `${startHex}:${endHex}`,
      '-c',                // compressed addresses
      '--threads', String(CORES * 4),
      TARGET_ADDR
    ];

    console.log(`[→] BitCrack fallback: ${startHex} → ${endHex}`);
    const proc = spawn(bitcrackBin, args, { cwd: WORK_DIR });
    currentProcess = proc;

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      process.stdout.write(text);

      const speedMatch = text.match(/([\d.]+)\s*[MK]Addr\/s/i);
      if (speedMatch) keysPerSec = Math.round(parseFloat(speedMatch[1]) * 1e6);

      // BitCrack found format: "Private key: xxxx"
      const found = text.match(/Private key[:\s]+([0-9a-fA-F]{64})/i);
      if (found) {
        proc.kill();
        resolve({ found: true, privateKey: found[1], address: TARGET_ADDR });
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ found: false });
      } else {
        reject(new Error(`BitCrack exited with code ${code}`));
      }
    });
    proc.on('error', (err) => reject(err));
  });
}

// ── Main worker loop ──────────────────────────────────────────────────────────
async function workerLoop() {
  while (running) {
    await sendHeartbeat(); // Send heartbeat periodically
    let assignment = null;

    // ── 1. Request chunk from master
    try {
      const resp = await axiosInstance.post(`${MASTER_URL}/assign`, {
        workerId: WORKER_ID,
        hostname: os.hostname()
      });

      if (resp.data.status === 'solved') {
        console.log('\n[✓] Puzzle already solved by another worker!');
        console.log('Solution:', resp.data.solution);
        process.exit(0);
      }

      if (resp.data.status === 'exhausted') {
        console.log('[*] All chunks exhausted. Waiting 60s for reassignments...');
        await sleep(60_000);
        continue;
      }

      assignment = resp.data.assignment;
      currentChunk = assignment;
    } catch (err) {
      console.error(`[!] Cannot reach master (${err.message}). Retry in 15s...`);
      await sleep(15_000);
      continue;
    }

    console.log(`\n[✓] Got chunk #${assignment.index}: 0x${assignment.start} → 0x${assignment.end}`);

    // ── 2. Run search
    let result;
    try {
      result = await runKeyhunt(assignment.start, assignment.end);
    } catch (err) {
      console.error('[!] Search error:', err.message);
      result = { failed: true };
    }

    currentChunk = null;
    keysPerSec = 0;

    // ── 3. Report result
    if (result.found) {
      try {
        await axiosInstance.post(`${MASTER_URL}/found`, {
          privateKey: result.privateKey,
          address: result.address,
          workerId: WORKER_ID,
          chunkIndex: assignment.chunkIndex
        });
        console.log('\n🎉 KEY REPORTED TO MASTER! Check the dashboard!');
        console.log(`Private Key: ${result.privateKey}`);
        // Save locally too
        fs.writeFileSync('/tmp/PUZZLE71_SOLVED.txt',
          `PUZZLE #71 SOLVED!\nPrivate Key: ${result.privateKey}\nAddress: ${result.address}\nWorker: ${WORKER_ID}\nTime: ${new Date().toISOString()}\n`
        );
        console.log('Saved to /tmp/PUZZLE71_SOLVED.txt');
      } catch (err) {
        console.error('[!] Failed to report to master:', err.message);
        console.log('SAVE THIS KEY MANUALLY:', result.privateKey);
      }
      running = false;
      process.exit(0);
    } else if (result.failed) {
      // Both tools failed - don't report completion, let chunk timeout and get reassigned
      console.log('[!] Chunk processing failed, will be reassigned to another worker');
      await sleep(5000); // Brief pause before requesting next chunk
      continue;
    } else {
      // Report chunk completed (not found)
      try {
        await axiosInstance.post(`${MASTER_URL}/complete`, {
          chunkIndex: assignment.chunkIndex,
          workerId: WORKER_ID,
          keysScanned: Number(CHUNK_SIZE_APPROX)
        });
      } catch (_) {}
    }

    await sleep(500);
  }
}

const CHUNK_SIZE_APPROX = 2 ** 40;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  running = false;
  if (currentProcess) currentProcess.kill();
  process.exit(0);
});

process.on('SIGINT', () => {
  running = false;
  if (currentProcess) currentProcess.kill();
  process.exit(0);
});

// ── Start ─────────────────────────────────────────────────────────────────────
workerLoop().catch(err => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});

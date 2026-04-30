const express = require('express');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ── Puzzle #71 configuration ─────────────────────────────────────────────────
const PUZZLE = {
  number: 71,
  address: '1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU',
  rangeStart: 0x400000000000000000n,  // 2^70
  rangeEnd:   0x7fffffffffffffffffn,  // 2^71 - 1
  totalKeys:  0x3fffffffffffffffffn,  // range size
  prize:      '7.1 BTC'
};

// Chunk size: 2^40 keys per chunk (~1 trillion keys)
// At 100 Mk/s CPU speed, each chunk takes ~2.9 hours
const CHUNK_SIZE = BigInt(2 ** 40); // 1,099,511,627,776 keys per chunk
const CHUNK_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours before reassignment

let redis;

async function connectRedis() {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
  await redis.connect();
  console.log('[*] Redis connected');
  await initRanges();
}

// ── Range initialization ──────────────────────────────────────────────────────
async function initRanges() {
  const initialized = await redis.get('puzzle71:initialized');
  if (initialized) {
    const total = await redis.get('puzzle71:total_chunks');
    console.log(`[*] Ranges already initialized: ${total} chunks`);
    return;
  }

  console.log('[*] Initializing range chunks...');
  let chunkIndex = 0;
  let current = PUZZLE.rangeStart;

  const pipeline = redis.pipeline();
  while (current <= PUZZLE.rangeEnd) {
    const end = current + CHUNK_SIZE - 1n > PUZZLE.rangeEnd
      ? PUZZLE.rangeEnd
      : current + CHUNK_SIZE - 1n;

    const chunk = {
      index: chunkIndex,
      start: current.toString(16),
      end: end.toString(16),
      status: 'pending',    // pending | assigned | done
      worker: null,
      assignedAt: null,
      completedAt: null,
      attempts: 0
    };

    pipeline.hset(`puzzle71:chunk:${chunkIndex}`, chunk);
    pipeline.lpush('puzzle71:queue:pending', chunkIndex);
    chunkIndex++;
    current = end + 1n;

    // Execute in batches of 1000
    if (chunkIndex % 1000 === 0) {
      await pipeline.exec();
      process.stdout.write(`\r[*] Created ${chunkIndex} chunks...`);
    }
  }

  await pipeline.exec();
  await redis.set('puzzle71:total_chunks', chunkIndex);
  await redis.set('puzzle71:initialized', '1');
  await redis.set('puzzle71:solved', '0');
  console.log(`\n[✓] Initialized ${chunkIndex} total chunks`);
}

// ── Background: re-queue timed-out chunks ─────────────────────────────────────
async function recoverTimeouts() {
  const assignedKeys = await redis.lrange('puzzle71:queue:assigned', 0, -1);
  const now = Date.now();
  for (const idx of assignedKeys) {
    const chunk = await redis.hgetall(`puzzle71:chunk:${idx}`);
    if (!chunk || chunk.status !== 'assigned') continue;
    const age = now - parseInt(chunk.assignedAt || 0);
    if (age > CHUNK_TIMEOUT_MS) {
      await redis.hset(`puzzle71:chunk:${idx}`, {
        status: 'pending',
        worker: '',
        assignedAt: '',
      });
      await redis.lrem('puzzle71:queue:assigned', 0, idx);
      await redis.lpush('puzzle71:queue:pending', idx);
      console.log(`[!] Re-queued timed-out chunk ${idx}`);
    }
  }
}
setInterval(recoverTimeouts, 5 * 60 * 1000); // every 5 min

// ── API Routes ────────────────────────────────────────────────────────────────

// GET /assign — worker requests a chunk
app.post('/assign', async (req, res) => {
  const { workerId, hostname } = req.body;

  // Check if already solved
  const solved = await redis.get('puzzle71:solved');
  if (solved === '1') {
    const solution = await redis.hgetall('puzzle71:solution');
    return res.json({ status: 'solved', solution });
  }

  const chunkIdx = await redis.rpop('puzzle71:queue:pending');
  if (!chunkIdx) {
    return res.json({ status: 'exhausted', message: 'All chunks assigned or completed' });
  }

  const chunk = await redis.hgetall(`puzzle71:chunk:${chunkIdx}`);
  const assignment = {
    chunkIndex: parseInt(chunkIdx),
    start: chunk.start,
    end: chunk.end,
    workerId: workerId || uuidv4(),
    assignedAt: Date.now()
  };

  await redis.hset(`puzzle71:chunk:${chunkIdx}`, {
    status: 'assigned',
    worker: assignment.workerId,
    assignedAt: assignment.assignedAt,
    attempts: parseInt(chunk.attempts || 0) + 1
  });
  await redis.lpush('puzzle71:queue:assigned', chunkIdx);
  await redis.hset(`puzzle71:worker:${assignment.workerId}`, {
    hostname: hostname || 'unknown',
    lastSeen: Date.now(),
    currentChunk: chunkIdx
  });

  console.log(`[→] Assigned chunk ${chunkIdx} (0x${chunk.start}→0x${chunk.end}) to ${assignment.workerId}`);
  res.json({ status: 'assigned', assignment });
});

// POST /complete — worker finished a chunk (not found)
app.post('/complete', async (req, res) => {
  const { workerId, chunkIndex, keysScanned } = req.body;
  const chunk = await redis.hgetall(`puzzle71:chunk:${chunkIndex}`);
  if (!chunk) return res.status(404).json({ error: 'Chunk not found' });

  await redis.hset(`puzzle71:chunk:${chunkIndex}`, {
    status: 'done',
    completedAt: Date.now(),
    keysScanned: keysScanned || 0
  });
  await redis.lrem('puzzle71:queue:assigned', 0, String(chunkIndex));
  await redis.lpush('puzzle71:queue:done', chunkIndex);
  await redis.incr('puzzle71:total_scanned_chunks');
  await redis.hset(`puzzle71:worker:${workerId}`, { lastSeen: Date.now(), currentChunk: '' });

  res.json({ status: 'ok' });
});

// POST /found — worker found the key!
app.post('/found', async (req, res) => {
  const { workerId, privateKey, address, chunkIndex } = req.body;
  console.log('\n\n🎉🎉🎉 KEY FOUND! 🎉🎉🎉');
  console.log(`Worker  : ${workerId}`);
  console.log(`Address : ${address}`);
  console.log(`Key     : ${privateKey}`);
  console.log('🎉🎉🎉 KEY FOUND! 🎉🎉🎉\n\n');

  await redis.set('puzzle71:solved', '1');
  await redis.hset('puzzle71:solution', {
    privateKey, address, workerId, chunkIndex,
    foundAt: new Date().toISOString()
  });

  res.json({ status: 'recorded', message: 'KEY SAVED — claim your prize!' });
});

// POST /heartbeat — worker keepalive
app.post('/heartbeat', async (req, res) => {
  const { workerId, keysPerSec, currentKey } = req.body;
  if (workerId) {
    await redis.hset(`puzzle71:worker:${workerId}`, {
      lastSeen: Date.now(),
      keysPerSec: keysPerSec || 0,
      currentKey: currentKey || ''
    });
  }
  res.json({ status: 'ok' });
});

// GET /stats — overall progress
app.get('/stats', async (req, res) => {
  const total = parseInt(await redis.get('puzzle71:total_chunks') || 0);
  const done = parseInt(await redis.llen('puzzle71:queue:done') || 0);
  const assigned = parseInt(await redis.llen('puzzle71:queue:assigned') || 0);
  const pending = total - done - assigned;
  const solved = await redis.get('puzzle71:solved');
  const solution = solved === '1' ? await redis.hgetall('puzzle71:solution') : null;

  // Aggregate worker stats
  const workerKeys = await redis.keys('puzzle71:worker:*');
  const workers = [];
  for (const k of workerKeys) {
    const w = await redis.hgetall(k);
    const alive = Date.now() - parseInt(w.lastSeen || 0) < 2 * 60 * 1000;
    workers.push({ id: k.split(':')[2], ...w, alive });
  }
  const activeWorkers = workers.filter(w => w.alive);
  const totalKps = activeWorkers.reduce((s, w) => s + parseInt(w.keysPerSec || 0), 0);

  res.json({
    puzzle: PUZZLE.number,
    address: PUZZLE.address,
    prize: PUZZLE.prize,
    solved: solved === '1',
    solution,
    progress: {
      totalChunks: total,
      doneChunks: done,
      assignedChunks: assigned,
      pendingChunks: pending,
      percentComplete: total > 0 ? ((done / total) * 100).toFixed(6) + '%' : '0%'
    },
    performance: {
      activeWorkers: activeWorkers.length,
      totalWorkers: workers.length,
      combinedKeysPerSec: totalKps,
      combinedMKeysPerSec: (totalKps / 1e6).toFixed(2)
    },
    workers: workers.slice(0, 20)
  });
});

// GET / — dashboard HTML
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Puzzle #71 — Cluster Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0a;color:#e0e0e0;font-family:monospace;padding:20px}
  h1{color:#00c8ff;font-size:22px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:24px}
  .card{background:#111;border:1px solid #1e1e1e;border-radius:6px;padding:16px}
  .card .label{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
  .card .value{font-size:24px;font-weight:700;color:#fff}
  .card .sub{font-size:11px;color:#555;margin-top:4px}
  .card.highlight{border-color:#00c8ff}
  .card.solved{border-color:#26a65b;background:#0a1a0f}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{text-align:left;padding:8px;border-bottom:1px solid #222;color:#666}
  td{padding:8px;border-bottom:1px solid #1a1a1a}
  .alive{color:#26a65b} .dead{color:#666}
  .prog-bar{background:#1e1e1e;border-radius:3px;height:8px;margin-top:8px;overflow:hidden}
  .prog-fill{background:linear-gradient(90deg,#367bf0,#00c8ff);height:100%;transition:width .3s}
  #log{background:#0d0d0d;border:1px solid #1e1e1e;padding:12px;border-radius:6px;font-size:11px;color:#555;height:120px;overflow-y:auto;margin-top:20px}
</style>
</head>
<body>
<h1>⛏ Bitcoin Puzzle #71 — Cluster Dashboard</h1>
<p style="color:#555;margin-bottom:20px;font-size:12px">
  Target: <span style="color:#f39c12">1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU</span> &nbsp;|&nbsp;
  Range: 0x400000000000000000 → 0x7fffffffffffffffff &nbsp;|&nbsp;
  Prize: <span style="color:#26a65b">7.1 BTC</span>
</p>
<div class="grid" id="cards"></div>
<h3 style="color:#666;font-size:13px;margin-bottom:10px">Active Workers</h3>
<table><thead><tr><th>Worker ID</th><th>Status</th><th>Speed</th><th>Current Key</th><th>Last Seen</th></tr></thead>
<tbody id="workers"></tbody></table>
<div id="log"><div style="color:#367bf0">[ Dashboard initialized ]</div></div>

<script>
async function refresh() {
  try {
    const r = await fetch('/stats');
    const d = await r.json();
    const p = d.progress;
    const perf = d.performance;
    const pct = parseFloat(p.percentComplete);

    const cards = [
      {label:'Solved', value: d.solved ? '🎉 YES' : 'Not yet', sub: d.solution ? 'Key: '+d.solution.privateKey : 'Keep searching...', cls: d.solved ? 'solved' : ''},
      {label:'Progress', value: p.percentComplete, sub: p.doneChunks+' / '+p.totalChunks+' chunks', extra: '<div class="prog-bar"><div class="prog-fill" style="width:'+Math.min(pct,100)+'%"></div></div>', cls:'highlight'},
      {label:'Active Workers', value: perf.activeWorkers, sub: perf.totalWorkers+' total registered'},
      {label:'Combined Speed', value: perf.combinedMKeysPerSec+' Mk/s', sub: perf.combinedKeysPerSec.toLocaleString()+' keys/sec'},
      {label:'Assigned', value: p.assignedChunks, sub: 'chunks in progress'},
      {label:'Pending', value: p.pendingChunks, sub: 'chunks remaining'},
    ];

    document.getElementById('cards').innerHTML = cards.map(c =>
      '<div class="card '+(c.cls||')">'+(c.extra||'')+
      '<div class="label">'+c.label+'</div>'+
      '<div class="value">'+c.value+'</div>'+
      '<div class="sub">'+c.sub+'</div></div>'
    ).join('');

    const now = Date.now();
    document.getElementById('workers').innerHTML = (d.workers||[]).map(w =>
      '<tr><td style="color:#aaa">'+w.id.slice(0,12)+'...</td>'+
      '<td class="'+(w.alive?'alive':'dead')+'">'+(w.alive?'●  Online':'○ Offline')+'</td>'+
      '<td>'+(parseInt(w.keysPerSec||0)/1e6).toFixed(2)+' Mk/s</td>'+
      '<td style="color:#555;font-size:10px">'+(w.currentKey||'—')+'</td>'+
      '<td>'+(w.alive ? Math.round((now-w.lastSeen)/1000)+'s ago':'—')+'</td></tr>'
    ).join('') || '<tr><td colspan="5" style="color:#444">No workers connected yet</td></tr>';

    const log = document.getElementById('log');
    const line = document.createElement('div');
    line.textContent = '['+new Date().toLocaleTimeString()+'] '+perf.activeWorkers+' workers · '+perf.combinedMKeysPerSec+' Mk/s · '+p.doneChunks+' chunks done ('+p.percentComplete+')';
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  } catch(e) { console.error(e); }
}
refresh();
setInterval(refresh, 5000);
</script>
</body></html>`);
});

// ── Start ─────────────────────────────────────────────────────────────────────
connectRedis().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[✓] Puzzle #71 Master running on port ${PORT}`);
    console.log(`[✓] Target: ${PUZZLE.address}`);
    console.log(`[✓] Dashboard: http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to connect to Redis:', err.message);
  process.exit(1);
});

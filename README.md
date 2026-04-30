# Bitcoin Puzzle #71 — Distributed Cluster

Target: `1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU`  
Range:  `0x400000000000000000` → `0x7fffffffffffffffff`  
Prize:  **7.1 BTC**

## Architecture

```
┌─────────────────────────────────────────────────┐
│              MASTER SERVICE (Railway)            │
│  · Splits 2^70 range into 2^40-key chunks        │
│  · Redis: tracks pending/assigned/done chunks    │
│  · REST API: assign, complete, found, stats      │
│  · Live dashboard at /                           │
└──────────────┬──────────────────────────────────┘
               │ MASTER_URL env var
    ┌──────────┼──────────┬──────────┐
    ▼          ▼          ▼          ▼
 Worker 1   Worker 2  Worker 3  Worker N
 keyhunt    keyhunt   keyhunt   keyhunt
 chunk A    chunk B   chunk C   chunk N
```

---

## Deploy on Railway — Step by Step

### Step 1: Redis

1. Railway dashboard → **New Service** → **Database** → **Redis**
2. Copy the `REDIS_URL` from the Redis service variables

### Step 2: Master Service

1. New Service → Deploy from GitHub → select this repo
2. Set **Root Directory** to `master/`
3. Add environment variables:
   ```
   REDIS_URL=<paste from Step 1>
   PORT=3000
   ```
4. Generate Domain → note your master URL (e.g. `https://master.up.railway.app`)

### Step 3: Worker Service

1. New Service → Deploy from GitHub → same repo
2. Set **Root Directory** to `worker/`
3. Add environment variables:
   ```
   MASTER_URL=https://your-master.up.railway.app
   CORES=8
   ```
4. **Scale** → set replicas to 5, 10, or however many you want

### Step 4: Monitor

Open your master URL in browser → live dashboard with:
- Progress %
- Keys/sec combined
- Active workers
- Chunk assignments

---

## ⚠️ Important: Claiming the Prize Safely

When the key is found, **DO NOT** broadcast a regular transaction from a standard wallet. Puzzle #66 and #69 winners had their prizes stolen this way.

Use **MARA Slipstream** or another method that bypasses the public mempool:
- https://slipstream.mara.com
- Or contact a miner directly to include your tx in the next block

The master saves the key to Redis under `puzzle71:solution`.  
Workers also save it to `/tmp/PUZZLE71_SOLVED.txt`.

---

## Performance Estimates (CPU only, Railway)

| Workers | Cores each | Combined speed | Time to scan 1% |
|---------|-----------|---------------|-----------------|
| 1       | 8         | ~50 Mk/s      | ~270 days       |
| 5       | 8         | ~250 Mk/s     | ~54 days        |
| 10      | 8         | ~500 Mk/s     | ~27 days        |
| 50      | 8         | ~2.5 Gk/s     | ~5 days         |

> Actual speed depends on Railway CPU allocation. keyhunt BSGS is ~3-10x faster than pure brute force.

---

## Tools Used

- **keyhunt** — BSGS + Kangaroo CPU solver (https://github.com/albertobsd/keyhunt)
- **BitCrack** — CPU fallback (https://github.com/brichard19/BitCrack)
- **Redis** — chunk state coordination
- **Node.js** — master API + worker orchestration

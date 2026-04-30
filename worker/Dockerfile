FROM kalilinux/kali-rolling:latest

ENV DEBIAN_FRONTEND=noninteractive

# Build deps + runtime tools
RUN apt-get update --fix-missing && apt-get install -y --no-install-recommends \
    build-essential git curl wget ca-certificates \
    libgmp-dev libssl-dev \
    python3 python3-pip \
    nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# ── Build keyhunt (BSGS + CPU Kangaroo, fastest CPU tool for puzzle #71) ──────
RUN git clone https://github.com/albertobsd/keyhunt.git /opt/keyhunt \
    && cd /opt/keyhunt \
    && make \
    && cp keyhunt /usr/local/bin/keyhunt \
    && echo "[✓] keyhunt built"

# ── Build BitCrack as backup ──────────────────────────────────────────────────
RUN git clone https://github.com/brichard19/BitCrack.git /opt/bitcrack \
    && cd /opt/bitcrack \
    && make BUILD_CUDA=0 \
    && cp bin/clKeySearch /usr/local/bin/bitcrack 2>/dev/null || \
       cp bin/cuKeySearch /usr/local/bin/bitcrack 2>/dev/null || true \
    && echo "[✓] BitCrack built (CPU mode)"

# ── Worker orchestration script ───────────────────────────────────────────────
WORKDIR /worker
COPY worker.js ./
COPY package.json ./
RUN npm install --production

CMD ["node", "worker.js"]

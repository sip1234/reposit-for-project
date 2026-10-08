FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer libreoffice-calc libreoffice-impress fonts-noto-cjk python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
COPY worker/requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.html styles.css app.js documents.js assistant.js ./
COPY server ./server
COPY worker ./worker
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]

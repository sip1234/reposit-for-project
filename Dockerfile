FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer libreoffice-calc libreoffice-impress fonts-noto-cjk python3 python3-venv \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
COPY worker/requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.html styles.css app.js studio.js documents.js assistant.js parsing.js retrieval-ui.js ./
COPY server ./server
COPY worker ./worker
COPY shared ./shared
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]

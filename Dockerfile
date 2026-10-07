FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer libreoffice-calc libreoffice-impress fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.html styles.css app.js documents.js ./
COPY server ./server
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]

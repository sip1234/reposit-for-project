FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.html styles.css app.js documents.js ./
COPY server ./server
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/index.js"]

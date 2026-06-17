# Node 24 ships node:sqlite as stable (used as the history fallback when no
# DATABASE_URL is provided).
FROM node:24-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 3000

# Basic container healthcheck against the liveness endpoint.
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]

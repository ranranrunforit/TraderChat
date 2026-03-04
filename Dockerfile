# ═══════════════════════════════════════════════════════
# VibeTrader — Full Stack Dockerfile
# Build context: run from root vibetrader/ directory
# Produces a single Cloud Run image with both frontend + API
# ═══════════════════════════════════════════════════════

# ── Stage 1: Build Vite frontend ──────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
COPY package*.json ./
RUN npm install
COPY src/ ./src/
COPY public/ ./public/
COPY index.html .
COPY vite.config.ts .
COPY tsconfig.json ./
COPY tsconfig.app.json ./
COPY tsconfig.node.json ./
# Set base to / since we're hosting at Cloud Run root
ENV VITE_BASE_URL=/
RUN npm run build

# ── Stage 2: Build Express server ─────────────────────
FROM node:20-alpine AS server-builder
WORKDIR /app
COPY server/package*.json ./
RUN npm install
COPY server/tsconfig.json ./
COPY server/src/ ./src/
RUN npm run build

# ── Stage 3: Production image ─────────────────────────
FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm install --omit=dev
# Server compiled JS
COPY --from=server-builder /app/dist ./dist
# Vite-built frontend → served by Express as static files
COPY --from=frontend-builder /frontend/dist ./public
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/server.js"]

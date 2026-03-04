# ═══════════════════════════════
# Stage 1: Build the Vite frontend
# ═══════════════════════════════
FROM node:20-alpine AS frontend-builder
WORKDIR /frontend
# Copy root package.json and install
COPY ../package*.json ./
RUN npm install
# Copy all frontend source files
COPY ../src ./src
COPY ../public ./public
COPY ../index.html .
COPY ../vite.config.ts .
COPY ../tsconfig*.json ./
# Build with the Cloud Run API URL baked in
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# ═══════════════════════════════
# Stage 2: Build the Express server
# ═══════════════════════════════
FROM node:20-alpine AS server-builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ═══════════════════════════════
# Stage 3: Production image
# ═══════════════════════════════
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
# Copy compiled server
COPY --from=server-builder /app/dist ./dist
# Copy built frontend into public/ so Express can serve it
COPY --from=frontend-builder /frontend/dist ./public
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/server.js"]

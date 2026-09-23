# ==========================================
# STAGE 1 - BUILD REACT/VITE FRONTEND
# ==========================================
FROM node:22-bookworm-slim AS frontend-builder

WORKDIR /app/frontend

# Copy frontend dependency files
COPY frontend/package*.json ./

# Install dependency sesuai package-lock.json
RUN npm ci

# Copy source frontend
COPY frontend/ .

# Build React/Vite
RUN npm run build


# ==========================================
# STAGE 2 - PRODUCTION BACKEND
# ==========================================
FROM node:22-bookworm-slim

WORKDIR /app

# Copy backend dependency files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy backend
COPY server.js ./

# Copy hasil build React dari Stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "server.js"]

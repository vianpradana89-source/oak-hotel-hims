# ==========================================
# Stage 1: Build Frontend
# ==========================================
FROM node:20-slim AS frontend-builder

WORKDIR /app

# Copy frontend package manifests
COPY frontend/package.json frontend/package-lock.json ./frontend/

# Install exact frontend dependencies,
# including Linux-specific optional binaries
RUN npm --prefix frontend ci --include=optional

# Copy frontend source
COPY frontend/ ./frontend/

# Build React / Vite frontend
RUN npm --prefix frontend run build


# ==========================================
# Stage 2: Build Backend
# ==========================================
FROM node:20-slim AS backend-builder

WORKDIR /app

# Copy backend package manifests
COPY backend/package.json backend/package-lock.json ./backend/

# Install exact backend dependencies
RUN npm --prefix backend ci --include=optional

# Copy backend source
COPY backend/ ./backend/

# Build TypeScript backend
RUN npm --prefix backend run build


# ==========================================
# Stage 3: Production Runner
# ==========================================
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy backend package manifests
COPY backend/package.json backend/package-lock.json ./backend/

# Install only production backend dependencies
RUN npm --prefix backend ci --omit=dev --include=optional \
    && npm cache clean --force

# Copy compiled backend
COPY --from=backend-builder /app/backend/dist ./backend/dist

# Copy compiled frontend
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Runtime folders
RUN mkdir -p /app/backend/uploads /app/backend/storage

EXPOSE 8080

# Start backend server
CMD ["node", "backend/dist/index.js"]

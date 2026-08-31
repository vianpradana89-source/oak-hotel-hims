# ==========================================
# Stage 1: Build Frontend
# ==========================================
FROM node:20-slim AS frontend-builder
WORKDIR /app

# Copy root and workspace package manifests
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/

# Install dependencies for frontend
RUN npm ci --workspace=frontend

# Copy frontend source code
COPY frontend/ ./frontend/

# Build React / Vite SPA (outputs to /app/frontend/dist)
RUN npm --prefix frontend run build

# ==========================================
# Stage 2: Build Backend
# ==========================================
FROM node:20-slim AS backend-builder
WORKDIR /app

# Copy root and workspace package manifests
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/

# Install dependencies for backend
RUN npm ci --workspace=backend

# Copy backend source code
COPY backend/ ./backend/

# Build TypeScript backend (outputs to /app/backend/dist)
RUN npm --prefix backend run build

# ==========================================
# Stage 3: Production Runner
# ==========================================
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Install production dependencies only
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
RUN npm ci --workspace=backend --omit=dev && npm cache clean --force

# Copy compiled backend output
COPY --from=backend-builder /app/backend/dist ./backend/dist

# Copy compiled frontend static assets
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Create uploads directory for runtime evidence/receipt storage
RUN mkdir -p /app/backend/uploads /app/backend/storage

# Expose default Cloud Run port
EXPOSE 8080

# Start production server
CMD ["node", "backend/dist/index.js"]

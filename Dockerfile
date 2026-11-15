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

# Inject build-time env vars for Vite
ARG VITE_REALTIME_BASE_URL
ENV VITE_REALTIME_BASE_URL=${VITE_REALTIME_BASE_URL}

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

# ──────────────────────────────────────────────────────────
# Local PaddleOCR runtime — minimal Python + wheels only
# ──────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        libgomp1 libglib2.0-0 libsm6 libxext6 libxrender1 libgl1 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

COPY backend/ocr/requirements.txt ./backend/ocr/requirements.txt
RUN python3 -m venv /app/.venv \
 && /app/.venv/bin/pip install --no-cache-dir -r ./backend/ocr/requirements.txt

COPY backend/ocr/ktp_ocr_worker.py ./backend/ocr/ktp_ocr_worker.py

# Pre-download PaddleOCR models at build time so runtime is network-independent.
# This matches the exact configuration used by ktp_ocr_worker.py at line 165.
RUN /app/.venv/bin/python -c "from paddleocr import PaddleOCR; PaddleOCR(use_angle_cls=False, lang='en', show_log=False); print('PADDLE_MODELS_READY')"

# Make the OCR venv Python discoverable as `python` for worker execution
ENV PATH="/app/.venv/bin:$PATH"


EXPOSE 8080

# Start backend server
CMD ["node", "backend/dist/index.js"]

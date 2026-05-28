# ai-service Dockerfile
#
# Builds the Python service AND the optional C++ extension in one image.
# If the C++ build fails for any reason (e.g. resource-constrained CI), the
# Python service will still run -- matcher.py auto-falls back to pure Python.
FROM python:3.11-slim

# Build deps for the C++ extension and sentence-transformers' tokenizers.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        g++ \
        git \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first for better layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# C++ extension (best-effort; service still works without it).
COPY cpp_ext/ ./cpp_ext/
RUN pip install --no-cache-dir ./cpp_ext || echo "[warn] C++ extension build failed -- falling back to Python"

# Source + seed data.
COPY *.py ./
COPY data/ ./data/
COPY tests/ ./tests/

# Pre-download the embedding model so first request isn't slow.
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')"

EXPOSE 8000
ENV AI_SERVICE_PORT=8000 \
    PYTHONUNBUFFERED=1

CMD ["python", "main.py"]

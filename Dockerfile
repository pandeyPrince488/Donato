# Donato (Node) Dockerfile
FROM node:20-slim

WORKDIR /app

# Native build deps used by @node-rs/bcrypt and the sass postinstall.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the rest of the app.
COPY . .

# Compile SCSS once at build time (the start script also recompiles, but this
# warms up the assets directory for the static middleware).
RUN npm run scss || true

EXPOSE 8080
ENV PORT=8080 \
    NODE_ENV=production

CMD ["node", "app.js"]

# Donato (Node) Dockerfile
FROM node:20-slim

WORKDIR /app

# Native build deps used by @node-rs/bcrypt and the sass postinstall.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# --ignore-scripts: skip the postinstall hook here because it runs
# `patch-package && npm run scss`, but patches/ and public/css/ aren't
# copied yet. We invoke them explicitly below once the full source is in.
RUN npm ci --omit=dev --ignore-scripts

# Copy the rest of the app.
COPY . .

# Apply patches now that patches/ exists, then compile SCSS now that
# public/css/ exists. The start script also recompiles, but doing it at
# build time warms the assets directory for the static middleware.
RUN npx patch-package && npm run scss

EXPOSE 8080
ENV PORT=8080 \
    NODE_ENV=production

CMD ["node", "app.js"]

FROM node:24-bookworm-slim AS base

# Application directory
WORKDIR /app

# Production environment
ENV NODE_ENV=production \
    CONFIG_PATH=/config/config.yml

# Image-owned directory only; host bind mounts retain their own ownership.
RUN mkdir -p /config && chown node:node /config

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy application source
COPY --chown=node:node src/ ./src/

# Development bypasses production ownership initialization entirely.
FROM base AS development
USER node
CMD ["node", "src/index.js"]

FROM base AS production
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*
ENV PUID=99 PGID=100
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]

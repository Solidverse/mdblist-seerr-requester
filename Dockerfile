FROM node:24-bookworm-slim

# Application directory
WORKDIR /app

# Production environment
ENV NODE_ENV=production

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy application source
COPY --chown=node:node src/ ./src/

# Run as non-root user
USER node

# Start application
CMD ["node", "src/index.js"]
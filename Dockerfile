# Build React client
FROM node:20-alpine AS client-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Build client - uses /ws by default for same-origin WebSocket
ARG VITE_WS_URL=/ws
ENV VITE_WS_URL=$VITE_WS_URL
RUN npm run build

# Build proxy server
FROM node:20-alpine AS server-build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ .
RUN npm run build

# Production - serves BOTH client and proxy
FROM node:20-alpine AS production
WORKDIR /app

# Copy server build and dependencies
COPY --from=server-build /app/server/dist ./dist
COPY --from=server-build /app/server/node_modules ./node_modules
COPY --from=server-build /app/server/package.json ./

# Copy React client build to be served as static files
COPY --from=client-build /app/dist ./public

# Environment variables with defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV UPSTREAM_URL=wss://chatmud.com:9876
ENV PERSISTENCE_TIMEOUT_MS=300000
ENV MAX_BUFFER_MESSAGES=100
ENV MAX_BUFFER_SIZE=10240

# Server serves:
# - Static React app on / (port 3000)
# - WebSocket proxy on /ws (same port)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]

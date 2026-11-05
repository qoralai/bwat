# syntax=docker/dockerfile:1
# bwat-backend. Build from backend/: `docker build -t bwat-backend backend`.
# One image for the server (runtime role) and for `migrate` (owner role).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.json

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The built migrate.js resolves its SQL relative to itself: dist/src/db -> dist/migrations.
COPY migrations ./dist/migrations
# The CA for Postgres on RDS: BWAT_DB_SSLROOTCERT=/app/rds-global-bundle.pem (README).
# Pinned: when AWS changes the bundle the build fails here, and the digest is updated.
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]

# bwat-web. Build from web/: `docker build -t bwat-web web`.
# One image (D169): the board and admin pages, Google sign-in and /whoami, on 8080.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY server ./server
# The web plugins' code (plugins/<name>/): compiled with the server, and their board scripts served.
COPY plugins ./plugins
COPY admin ./admin
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# package.json stays: "type": "module" is what makes dist/**/*.js ESM.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY pages ./pages
COPY plugins ./plugins
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/server/src/index.js"]

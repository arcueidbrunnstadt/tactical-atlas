# Build on the target Linux architecture; do not copy a host node_modules tree.
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/atlas.sqlite \
    AI_ENABLED=false
RUN groupadd --gid 10001 atlas && useradd --uid 10001 --gid atlas --no-create-home atlas \
    && mkdir /data && chown atlas:atlas /data
COPY --from=build --chown=atlas:atlas /app/.next/standalone ./
USER atlas
EXPOSE 3000
CMD ["node", "scripts/start-node.mjs"]

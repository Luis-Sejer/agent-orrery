# Both stages are pinned by digest, so a rebuild can't silently pick up a different image.
FROM node:26.10.0-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS build
WORKDIR /app
RUN npm install --global corepack@0.36.0 && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web ./web
RUN pnpm build

# The server has no dependencies, so the runtime image holds only its own files and the built page.
FROM node:26.10.0-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80
WORKDIR /app
COPY server.mjs graph.mjs library.mjs repos.mjs store.mjs artifacts.mjs transcripts.mjs ./
COPY --from=build /app/web/dist ./web/dist
ENV AGENT_ORRERY_BIND=0.0.0.0 AGENT_ORRERY_PORT=4777
# Never root. compose.yaml runs it as your own user instead, so it can read your session files.
USER node
EXPOSE 4777
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO /dev/null --header "Host: 127.0.0.1:${AGENT_ORRERY_PORT}" "http://127.0.0.1:${AGENT_ORRERY_PORT}/" || exit 1
CMD ["node", "server.mjs"]

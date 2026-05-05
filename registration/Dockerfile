# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/registration

COPY registration/package.json registration/package-lock.json registration/tsconfig.json ./
RUN npm ci

COPY registration/src ./src
COPY registration/scripts ./scripts

RUN npm run check

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV TZ=Europe/Kaliningrad

WORKDIR /app/registration

COPY --from=build /app/registration /app/registration
COPY assets /app/assets

RUN mkdir -p /data /data/public \
  && chown -R node:node /app /data

USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]

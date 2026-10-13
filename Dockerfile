# da-prompt software factory.
# Agents run shell commands inside generated workspaces, so the container is the sandbox.
# Existing projects: mount them (read-only unless you want "apply") and set FACTORY_PROJECT_ROOTS[_READONLY]; see README.
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tar wget python3 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY templates ./templates
ENV NODE_ENV=production PORT=4747 HOST=0.0.0.0 FACTORY_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4747/api/health || exit 1
CMD ["node", "src/server.js"]

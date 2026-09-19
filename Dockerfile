# Relay only: this image never reads agent logs, it just serves what your machine pushes.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs analytics.mjs demo.mjs defaults.json ./
COPY public ./public
ENV OFFICE_MODE=relay HOST=0.0.0.0 PORT=4747 STATE_FILE=/data/state.json
VOLUME /data
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4747/health || exit 1
CMD ["node", "server.mjs"]

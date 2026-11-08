FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
RUN mkdir -p /data && chown node:node /data && chmod +x /app/docker-entrypoint.sh
USER node
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["/app/docker-entrypoint.sh"]

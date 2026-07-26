FROM node:22-slim

# 日付比較は JST 前提のため、コンテナの TZ を固定する
ENV NODE_ENV=production TZ=Asia/Tokyo

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

USER node
EXPOSE 3000

CMD ["node", "src/index.js"]

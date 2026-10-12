FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm i tsx@4.19.2 --no-save
COPY . .
USER node
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts"]

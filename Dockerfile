FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY . .
RUN npm run build:css
RUN npm prune --production

EXPOSE 3000

CMD ["node", "server.js"]

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev --ignore-scripts
# better-sqlite3 needs its install script to compile/fetch its native binding
# (--ignore-scripts above is deliberate supply-chain hardening for every OTHER
# dependency — this is the one narrow, vetted exception). @node-rs/argon2
# needs no such rebuild: its napi-rs bindings resolve via optionalDependencies
# with no lifecycle script at all.
RUN npm rebuild better-sqlite3 --update-binary

COPY . .
RUN npm run build:css
RUN npm prune --production

EXPOSE 3000

CMD ["node", "server.js"]

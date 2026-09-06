FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev --ignore-scripts
# better-sqlite3 needs its install script to compile/fetch its native binding
# (--ignore-scripts above is deliberate supply-chain hardening for every OTHER
# dependency — this is the one narrow, vetted exception). @node-rs/argon2
# needs no such rebuild: its napi-rs bindings resolve via optionalDependencies
# with no lifecycle script at all.
# Alpine ships no compiler toolchain, so if no prebuilt binary matches this
# exact platform/Node version, node-gyp's source-build fallback fails outright
# (`did not complete successfully: exit code 1`, no other detail). Installed
# as a virtual package group so it can be cleanly removed in the same layer
# once the rebuild is done, instead of bloating the final image permanently.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm rebuild better-sqlite3 --update-binary \
    && apk del .build-deps

COPY . .
RUN npm run build:css
RUN npm prune --production

EXPOSE 3000

CMD ["node", "server.js"]

# The installer's test host: a fresh Linux box with its own Docker Engine,
# plus bash, bats, curl, openssl and python3 to drive the tests. Runs privileged (dind).
# The onboarding page (setup --web) needs a Node that strips TypeScript types; Alpine's
# own nodejs package is built without that, so the official Alpine build is copied in.
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS node
FROM docker:27.5.1-dind@sha256:aa3df78ecf320f5fafdce71c659f1629e96e9de0968305fe1de670e0ca9176ce
RUN apk add --no-cache bash bats curl libstdc++ openssl python3
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /work

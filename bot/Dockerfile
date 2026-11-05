# bwat-bot. Build from bot/.
#
#   docker build -t bwat-bot bot                     the plain bot (the fake bridge; local stacks)
#   bot/sdk/prepare-vendor.sh <archive>              then, for real meetings:
#   docker build --target zoom -t bwat-bot:zoom bot  the bot with the Zoom Meeting SDK app
#
# The zoom stages build the patched headless sample against the SDK in bot/sdk/vendor/,
# which the install supplies (D92, D176): the SDK is never in this repository.

# ---------------------------------------------------------------------------------------
# zoom: what the SDK app, the bridge and the bot need at run time, and nothing else.
# ---------------------------------------------------------------------------------------
FROM ubuntu:24.04 AS zoom-runtime
SHELL ["/bin/bash", "-c"]
ARG DEBIAN_FRONTEND=noninteractive
# The runtime halves of the sample's build list (libx11-6, not libx11-dev). libatomic1,
# libxkbcommon0 and libegl1 are named because nothing else here pulls them in, and the
# binary needs them; the ldd check below fails the build if anything is missing.
RUN apt-get update && apt-get install -y \
    ca-certificates \
    libdbus-1-3 libgbm1 libgl1 libglib2.0-0t64 \
    libatomic1 libxkbcommon0 libegl1 \
    libx11-6 libx11-xcb1 libxcb-image0 libxcb-keysyms1 \
    libxcb-randr0 libxcb-shape0 libxcb-shm0 libxcb-xfixes0 libxcb-xtest0 \
    libgl1-mesa-dri libxfixes3 pciutils libssl3t64 \
    libasound2t64 libasound2-plugins alsa-utils \
    pulseaudio pulseaudio-utils dbus tini \
    python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# The SDK must be in bot/sdk/vendor/ before the build: this stage fails on one clear line
# if it is not, before the long toolchain stages run.
FROM ubuntu:24.04 AS zoom-sdk
COPY sdk/ /sdk/
RUN test -f /sdk/vendor/meetingsdk-headless-linux-sample/lib/zoomsdk/libmeetingsdk.so \
    || { echo "bwat: no Zoom Meeting SDK in bot/sdk/vendor/; run bot/sdk/prepare-vendor.sh <archive> first" >&2; exit 1; }

FROM zoom-runtime AS zoom-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake curl git pkgconf tar unzip zip \
    libglib2.0-dev libssl-dev libx11-dev linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt
RUN git clone --depth 1 https://github.com/Microsoft/vcpkg.git \
    && ./vcpkg/bootstrap-vcpkg.sh -disableMetrics \
    && ln -s /opt/vcpkg/vcpkg /usr/local/bin/vcpkg
# /app is load-bearing: CMake records the SDK's directory in the binary's RUNPATH, so the
# libraries sit at the same absolute path at build and at run time.
COPY --from=zoom-sdk /sdk/vendor/meetingsdk-headless-linux-sample /app
WORKDIR /app
RUN cmake -B build -S . --preset debug && cmake --build build -j

FROM zoom-runtime AS zoom
COPY --from=zoom-build /app/build/zoomsdk /app/build/zoomsdk
COPY --from=zoom-build /app/lib/zoomsdk /app/lib/zoomsdk
RUN ! ldd /app/build/zoomsdk | grep "not found"
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 BWAT_BRIDGE=zoom
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY bwat_bot ./bwat_bot
# The logo the bot shows while no picture is uploaded in the settings (D196).
COPY presence ./presence
COPY container ./container
# Root: PulseAudio runs system-wide and the SDK app needs it (the bot's own code is the
# same as in the plain image).
ENTRYPOINT ["/usr/bin/tini", "--", "/app/container/entry.sh"]

# ---------------------------------------------------------------------------------------
# The plain bot (the default target): the Python bot only.
# ---------------------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS bot
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY bwat_bot ./bwat_bot
COPY presence ./presence
USER nobody
ENTRYPOINT ["python", "-m", "bwat_bot"]

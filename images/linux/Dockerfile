FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends xvfb x11-utils fluxbox chromium fonts-liberation fonts-noto-color-emoji curl ca-certificates xz-utils && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 --shell /bin/bash app
COPY --chmod=0755 init.sh /opt/proofbox/init.sh
ENV DISPLAY=:99
ARG BASE_VERSION
LABEL proofbox.base-version=$BASE_VERSION
ENTRYPOINT ["/opt/proofbox/init.sh"]

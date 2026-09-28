FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends xvfb x11-utils x11vnc fluxbox chromium fonts-liberation fonts-noto-color-emoji curl ca-certificates xz-utils && rm -rf /var/lib/apt/lists/*
ARG FFMPEG_URL
ARG FFMPEG_SHA256
RUN mkdir -p /opt/proofbox/tools && curl -fsSL "$FFMPEG_URL" -o /tmp/ffmpeg.tar.xz && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp --wildcards --strip-components=2 '*/bin/ffmpeg' && install -m 0755 /tmp/ffmpeg /opt/proofbox/tools/ffmpeg && echo "$FFMPEG_SHA256  /opt/proofbox/tools/ffmpeg" | sha256sum -c - && rm /tmp/ffmpeg.tar.xz /tmp/ffmpeg
RUN useradd --create-home --uid 1000 --shell /bin/bash app
RUN mkdir -p /var/lib/proofbox && chown app:app /var/lib/proofbox
COPY --chmod=0755 init.sh /opt/proofbox/init.sh
ENV DISPLAY=:99
ARG BASE_VERSION
LABEL proofbox.base-version=$BASE_VERSION
ENTRYPOINT ["/opt/proofbox/init.sh"]

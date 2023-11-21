FROM fedora:39

ARG PORT=6543
ARG SPEASY=speasy

ENV SPEASY_CACHE_PATH=/data \
    SPEASY_CACHE_SIZE="20e9" \
    SPEASY_INDEX_PATH=/index \
    SPEASY_LOG_PATH=/log \
    SPEASY_PROXY="true" \
    SPEASY_PROXY_PREFIX="" \
    SPEASY_PROXY_SERVER_URL="" \
    SPEASY_PROXY_LOG_LEVEL="WARN"\
    PORT=$PORT\
    SPEASY_PROXY_LOG_CONFIG_FILE="/home/speasy/speasy_proxy/logging.yaml"

RUN useradd speasy && mkdir -p $SPEASY_CACHE_PATH $SPEASY_INDEX_PATH \
    && dnf install -y git python3 python3-devel libxslt libxslt-devel gcc g++ qhull-devel qhull \
    glibc-langpack-en freetype-devel freetype libpng libpng-devel xorg-x11-server-Xvfb zlib-devel python3-matplotlib \
    && dnf clean all \
    && chown -R speasy $SPEASY_CACHE_PATH $SPEASY_INDEX_PATH \
    && mkdir -p $SPEASY_LOG_PATH/speasy \
    && chown -R speasy $SPEASY_LOG_PATH/speasy

COPY *.cfg *.yaml *.toml *.txt *.md /home/speasy/speasy_proxy/
COPY speasy_proxy /home/speasy/speasy_proxy/speasy_proxy
RUN chown -R speasy /home/speasy/speasy_proxy

USER speasy
WORKDIR /home/speasy

RUN cd speasy_proxy &&\
    python3 -m ensurepip &&\
    python3 -mpip install -U pip &&\
    python3 -mpip install -U $SPEASY ddt gunicorn &&\
    python3 -mpip install -U .


ADD docker/entry_point.sh /home/speasy/entry_point.sh

VOLUME $SPEASY_CACHE_PATH
VOLUME $SPEASY_LOG_PATH
VOLUME $SPEASY_INDEX_PATH
EXPOSE $PORT/tcp
CMD ["/home/speasy/entry_point.sh"]

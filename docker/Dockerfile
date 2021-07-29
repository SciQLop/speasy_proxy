FROM fedora:33

ARG PORT=6543
ARG SPWC=speasy

ENV SPWC_CACHE_PATH=/data \
    SPWC_CACHE_SIZE="20e9" \
    SPWC_INDEX_PATH=/index \
    SPWC_LOG_PATH=/log \
    SPWC_PROXY="true" \
    SPWC_PROXY_PREFIX="" \
    SPWC_PROXY_URL="" \
    PORT=$PORT

RUN useradd speasy && mkdir -p $SPWC_CACHE_PATH $SPWC_INDEX_PATH && dnf install -y python3-pip git python3-astropy
RUN chown -R speasy $SPWC_CACHE_PATH $SPWC_INDEX_PATH && mkdir -p $SPWC_LOG_PATH/speasy && chown -R speasy $SPWC_LOG_PATH/speasy

COPY speasy_proxy/*.ini speasy_proxy/*.py speasy_proxy/*.txt /home/speasy/speasy_proxy/
COPY speasy_proxy/speasy_proxy /home/speasy/speasy_proxy/speasy_proxy
RUN chown -R speasy /home/speasy/speasy_proxy

USER speasy
WORKDIR /home/speasy

RUN cd speasy_proxy &&\
    pip3 install --user -e . &&\
    pip3 install --user --upgrade git+https://github.com/Pylons/pyramid_openapi3 $SPWC

ADD speasy_proxy/docker/entry_point.sh /home/speasy/entry_point.sh

VOLUME $SPWC_CACHE_PATH
VOLUME $SPWC_LOG_PATH
VOLUME $SPWC_INDEX_PATH
EXPOSE $PORT/tcp
CMD ["/home/speasy/entry_point.sh"]

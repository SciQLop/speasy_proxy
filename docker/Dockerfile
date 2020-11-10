FROM fedora:33

ARG PORT=6543

ENV SPWC_CACHE_PATH=/data \
    SPWC_CACHE_SIZE="20e9" \
    SPWC_INDEX_PATH=/index \
    SPWC_LOG_PATH=/log \
    SPWC_PROXY="true" \
    SPWC_PROXY_PREFIX="" \
    SPWC_PROXY_URL="" \
    PORT=$PORT

RUN useradd spwc && mkdir -p $SPWC_CACHE_PATH $SPWC_INDEX_PATH && dnf install -y python3-pip git
RUN chown -R spwc $SPWC_CACHE_PATH $SPWC_INDEX_PATH && mkdir -p $SPWC_LOG_PATH/spwc && chown -R spwc $SPWC_LOG_PATH/spwc

COPY spwc_proxy/*.ini spwc_proxy/*.py spwc_proxy/*.txt /home/spwc/spwc_proxy/
COPY spwc_proxy/spwc_proxy /home/spwc/spwc_proxy/spwc_proxy
RUN chown -R spwc /home/spwc/spwc_proxy

USER spwc
WORKDIR /home/spwc

RUN cd spwc_proxy &&\
    pip3 install --user -e . &&\
    pip3 install --user --upgrade git+https://github.com/Pylons/pyramid_openapi3

ADD spwc_proxy/docker/entry_point.sh /home/spwc/entry_point.sh

VOLUME $SPWC_CACHE_PATH
VOLUME $SPWC_LOG_PATH
VOLUME $SPWC_INDEX_PATH
EXPOSE $PORT/tcp
CMD ["/home/spwc/entry_point.sh"]

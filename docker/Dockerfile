FROM fedora:33

ENV SPWC_CACHE_PATH=/data \
    SPWC_CACHE_SIZE="20e9" \
    SPWC_INDEX_PATH=/index \
    SPWC_LOG_PATH=/log


RUN useradd spwc && mkdir -p $SPWC_CACHE_PATH $SPWC_INDEX_PATH && dnf install -y python3-pip
RUN chown -R spwc $SPWC_CACHE_PATH $SPWC_INDEX_PATH && mkdir -p $SPWC_LOG_PATH/spwc && chown -R spwc $SPWC_LOG_PATH/spwc

COPY spwc_proxy/*.ini spwc_proxy/*.py spwc_proxy/*.txt /home/spwc/spwc_proxy/
COPY spwc_proxy/api_docs /home/spwc/spwc_proxy/api_docs
COPY spwc_proxy/spwc_proxy /home/spwc/spwc_proxy/spwc_proxy
RUN chown -R spwc /home/spwc/spwc_proxy

USER spwc
WORKDIR /home/spwc

RUN cd spwc_proxy &&\
    pip3 install --user -e . &&\
    sed -i 's/listen = \*:6543/listen = 0.0.0.0:6543/' production.ini 

ADD spwc_proxy/docker/entry_point.sh /home/spwc/entry_point.sh

VOLUME $SPWC_CACHE_PATH
VOLUME $SPWC_LOG_PATH
VOLUME $SPWC_INDEX_PATH
EXPOSE 6543/tcp
CMD ["/home/spwc/entry_point.sh"]

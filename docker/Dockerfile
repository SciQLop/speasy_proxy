FROM fedora:31

ENV SPWC_CACHE_PATH=/data \
    SPWC_CACHE_SIZE="20e9" \
    SPWC_LOG_PATH=/log


RUN useradd spwc && mkdir -p $SPWC_CACHE_PATH && dnf install -y python3-pip
RUN chown -R spwc $SPWC_CACHE_PATH

USER spwc
WORKDIR /home/spwc

RUN mkdir spwc_proxy &&\
    curl https://codeload.github.com/SciQLop/spwc_proxy/tar.gz/master | tar -xz -C spwc_proxy --strip-components=1 &&\
    cd spwc_proxy &&\
    pip3 install --user -e . &&\
    sed -i 's/listen = \*:6543/listen = 0.0.0.0:6543/' production.ini

ADD entry_point.sh /home/spwc/entry_point.sh

VOLUME $SPWC_CACHE_PATH
VOLUME $SPWC_LOG_PATH
EXPOSE 6543/tcp
CMD ["/home/spwc/entry_point.sh"]
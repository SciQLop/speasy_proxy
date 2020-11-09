FROM fedora:33

RUN dnf update -y && \
   dnf install -y python3-pyramid python3-waitress.noarch python3-webtest.noarch python3-pytest-cov.noarch \
   python3-pandas.x86_64 python3-click.noarch python3-zeep.noarch python3-dateutil.noarch python3-requests python3-ddt python3-humanize.noarch &&\
   pip3 install --user spwc &&\
   pip3 install --user pyramid_debugtoolbar &&\
   pip3 install --user pyramid_jinja2

EXPOSE 6543/tcp
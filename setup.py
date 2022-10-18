import os

from setuptools import setup, find_packages

here = os.path.abspath(os.path.dirname(__file__))
with open(os.path.join(here, 'README.txt')) as f:
    README = f.read()
with open(os.path.join(here, 'CHANGES.txt')) as f:
    CHANGES = f.read()

requires = [
    'apscheduler < 4.0.0',
    'plaster_pastedeploy',
    'pyramid',
    'pyramid_jinja2',
    'pyramid_debugtoolbar',
    'openapi-spec-validator < 0.5.0',
    'pyramid_openapi3',
    'waitress',
    'humanize',
    'apscheduler',
    'speasy>=1.0.3',
    'diskcache',
    'jinja2',
    'zstd',
    'bokeh',
    'matplotlib'
]

tests_require = [
    'WebTest >= 1.3.1',  # py3 compat
    'pytest >= 3.7.4',
    'pytest-cov',
    'ddt'
]

setup(
    name='speasy_proxy',
    version='0.7.2',
    description='speasy-proxy',
    long_description=README + '\n\n' + CHANGES,
    classifiers=[
        'Programming Language :: Python',
        'Framework :: Pyramid',
        'Topic :: Internet :: WWW/HTTP',
        'Topic :: Internet :: WWW/HTTP :: WSGI :: Application',
    ],
    author='',
    author_email='',
    url='',
    keywords='web pyramid pylons',
    packages=find_packages(),
    data_files=[
        ('api', ['speasy_proxy/api_docs/openapi.yaml']),
        ('templates', ['speasy_proxy/templates/404.jinja2',
                       'speasy_proxy/templates/layout.jinja2',
                       'speasy_proxy/templates/openapi.yaml.jinja2',
                       'speasy_proxy/templates/production.ini.jinja2',
                       'speasy_proxy/templates/welcome.jinja2']),
        ('static', ['speasy_proxy/static/logo_LPP.png', 'speasy_proxy/static/pyramid.png',
                    'speasy_proxy/static/pyramid-16x16.png', 'speasy_proxy/static/theme.css'])
    ],
    include_package_data=True,
    zip_safe=False,
    extras_require={
        'testing': tests_require,
    },
    install_requires=requires,
    entry_points={
        'paste.app_factory': [
            'main = speasy_proxy:main',
        ],
    },
)

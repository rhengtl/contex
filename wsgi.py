"""
The entry point, for both the server and a developer.

    gunicorn wsgi:app          production, and what the Dockerfile runs
    python wsgi.py             development

Deliberately three lines of real code. Everything about how the application is
built lives in contex/app.py; this file exists so there is one obvious
name to point a process manager at, and so `python wsgi.py` still works without
that convenience being reachable in production - gunicorn imports `app` and
never runs the block at the bottom.
"""

from contex import config
from contex.app import app

if __name__ == '__main__':
    # Loopback by default. This used to bind 0.0.0.0, which with the debugger
    # on put an interactive Python console on every network the machine was
    # attached to. Set HOST=0.0.0.0 when you actually want to reach the
    # development server from a phone on the same wifi.
    app.run(
        debug=config.DEBUG,
        host=config.text('HOST', '127.0.0.1'),
        port=config.integer('PORT', 5000),
    )

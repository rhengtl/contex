"""
ConTeX - one document in, one .tex out.

    accept terms -> provide input -> convert -> .tex -> preview / download / copy

There is a single conversion feature. Which engine reads a page is an
implementation detail the user is never asked about; the only choice they are
ever given is the one that actually costs them something, which is whether to
proceed on the local fallback when the AI is unavailable.

HOW THE PACKAGE IS LAID OUT

    config.py      every setting, in one place, marked required or optional
    web/           HTTP: routes, headers, sessions. No business logic.
    pipeline/      the conversion, in the order it happens
    services/      things outside this process: the model, Firebase
    data/          things that persist: profiles, history, generated results

Dependencies run one way down that list. web imports pipeline; pipeline imports
services; nothing imports web. If you find yourself wanting an import that goes
back up, the logic is probably in the wrong layer.
"""

#: Nothing is imported here on purpose - see contex/app.py. Import what you
#: need from the module that owns it:
#:
#:     from contex import config
#:     from contex.app import app
#:     from contex import pipeline

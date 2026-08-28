"""
How this application reads a setting.

Four readers, so that no module has to carry its own "read an integer from the
environment" - which is how the same setting ended up parsed two different ways
depending on who asked. Reach for one of these first.

A handful of settings are still read with a bare os.getenv, because what they
need is not one of these four: a float, a name built at run time from a role,
or a comparison against one specific string. That is fine. Adding a fifth
reader for a single caller would not be.

WHICH BOOLEAN READER. `flag()` is off by default and only 1/true/yes/on turns
it on, so a typo cannot enable something. `enabled()` is the mirror, for
switches that are on by default: anything but false/0/no/off is true, because
there the safe reading of a typo is "leave it alone". They are not
interchangeable.

WHY THE READERS ARE LAZY. They read the environment at the moment they are
called, not at import. That is deliberate and load-bearing: the test suite
changes settings between tests (`AI_QA_ENABLED`, `UPLOAD_FOLDER`,
`GEMINI_PAID_TIER` and a dozen more) and expects the change to take effect. A
module that snapshots its configuration at import cannot be reconfigured, and a
module that cannot be reconfigured is hard to test.

Only the handful of values fixed for the life of the process - the debug flag,
the session secret - are resolved once, at the bottom of this file.

WHAT IS NOT HERE. Secrets are read through these functions but never stored,
logged or defaulted. What every setting means, and whether it is required, is
documented once in .env.example - the file a developer copies to start.
"""

import os

from dotenv import load_dotenv

# Read .env once, from the project root - the directory above this package.
# Passing the path explicitly rather than letting find_dotenv() search: since
# python-dotenv 1.2 the search starts from the calling file, which for a module
# inside a package is not where .env lives.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(ROOT, '.env'))


# ---------------------------------------------------------------------------
# Readers
# ---------------------------------------------------------------------------

def text(name, default=None):
    """A string setting, or `default` when unset or blank."""
    value = os.getenv(name)
    return value if value not in (None, '') else default


def flag(name, default=False):
    """
    A boolean setting.

    Anything unset falls back to `default`; 1/true/yes/on are true and
    everything else is false. Note that this means an unrecognised value reads
    as false rather than as the default - a typo should not silently enable
    something.
    """
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ('1', 'true', 'yes', 'on')


def enabled(name, default=True):
    """
    A feature switch that is on unless it is explicitly turned off.

    The mirror of `flag()`, and deliberately not the same rule. `flag()` is for
    something off by default, where an unrecognised value must not switch it
    on. These are on by default - the AI path, the compile-and-repair step -
    where the safe reading of a typo is "leave it as it was", so anything but
    false/0/no/off is true.
    """
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ('false', '0', 'no', 'off')


def integer(name, default):
    """An integer setting. A value that will not parse falls back silently."""
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Fixed for the life of the process
# ---------------------------------------------------------------------------

#: Debug is OFF unless something asks for it. It used to default to True,
#: which meant a deployment that simply forgot to set it shipped the Werkzeug
#: debugger - an interactive Python console on a public URL.
DEBUG = flag('FLASK_DEBUG', False)

#: Everything that is not a debug run is production. Keying it off the existing
#: switch rather than a new variable means a local .env that already says
#: FLASK_DEBUG=True keeps behaving as it does now, while a host that sets
#: nothing gets the safe behaviour rather than the convenient one.
IS_PRODUCTION = not DEBUG


def browser_firebase():
    """
    The three Firebase settings the browser SDK needs, or None.

    Public by design - they identify the project, they are not credentials,
    and the security rules are what actually protect the data. Nothing else
    from the service account ever reaches a page.
    """
    settings = {
        'apiKey': text('FIREBASE_API_KEY'),
        'authDomain': text('FIREBASE_AUTH_DOMAIN'),
        'projectId': text('FIREBASE_PROJECT_ID'),
    }
    return settings if all(settings.values()) else None

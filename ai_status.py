"""
Is the AI conversion service usable right now?

The app has to answer this *before* it starts processing, because falling back
to the local converters silently would hand the user a materially worse
document without telling them. So `check()` runs ahead of every conversion and
the answer drives a warning the user must respond to.

How the answer is reached, and why:

  Configuration      A missing key or AI_QA_ENABLED=false is a definite,
                     free answer. No network involved.

  Remembered outage  When a real call fails, what failed is written to a small
                     file in the upload folder and read back on the next check.

Deliberately NOT done: probing the API with a throwaway request. On a free
tier the probe consumes exactly the quota that runs out, so a pre-flight check
implemented that way would cause the outage it is meant to detect.

**Outages are remembered per model, not per service.** A free-tier daily quota
is spent on one model at a time, so one model being exhausted says nothing
about the others. Recording it against the whole service was what used to take
the entire AI path down - and drop every user to Tesseract - while other models
on the same key still had quota. The service counts as unavailable only when
every candidate in the role's chain is exhausted.

The cost of the cache is staleness, so every record expires two ways: at the
provider's own retry time when the provider gave one, and otherwise after
AI_OUTAGE_ASSUME_SECONDS. A successful call clears the record for the model
that served it. The app must never sit on the fallback path after the service
has come back.

Records live in a file rather than a module variable so that several gunicorn
workers share one view. They hold a status message and a timestamp - never a
key, a prompt or any part of a user's document.
"""

import json
import os
import time
from datetime import datetime, timezone

import llm_providers

# How long an outage with no provider-supplied retry time is assumed to last
# before the app tries that model again. Short on purpose: guessing too long
# keeps users on the worse path after the service has recovered, and the only
# cost of guessing too short is one failed call that re-arms the record.
_ASSUME_SECONDS = 900

# A model this key cannot reach is not a passing condition like a quota, but it
# is not permanent either - access can be granted, and a typo can be fixed - so
# it is parked for an hour rather than forever.
_MODEL_ERROR_SECONDS = 3600

_FILENAME = 'ai_outage.json'


def _int_env(name, default):
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _flag(name, default=True):
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ('false', '0', 'no', 'off')


def _path():
    return os.path.join(os.getenv('UPLOAD_FOLDER', 'uploads'), _FILENAME)


def _read():
    """The stored state, normalised. An unreadable or stale shape reads empty."""
    try:
        with open(_path(), 'r', encoding='utf-8') as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        return {'service': None, 'models': {}}
    if not isinstance(state, dict):
        return {'service': None, 'models': {}}
    models = state.get('models')
    return {
        'service': state.get('service') if isinstance(state.get('service'), dict)
                   else None,
        'models': models if isinstance(models, dict) else {},
    }


def _write(state):
    try:
        os.makedirs(os.path.dirname(_path()) or '.', exist_ok=True)
        with open(_path(), 'w', encoding='utf-8') as handle:
            json.dump(state, handle)
    except OSError:
        pass  # an unwritable cache degrades to "no remembered outage"


def _entry(message, retry_after, scope, provider, from_provider=True):
    now = time.time()
    until = None
    if isinstance(retry_after, (int, float)) and retry_after > 0:
        until = now + float(retry_after)
    return {'at': now, 'message': str(message or '')[:400], 'until': until,
            'scope': scope, 'provider': provider,
            # True only when `until` came from the provider itself. A window we
            # invented is a guess worth re-testing; one the provider stated is
            # an instruction worth honouring.
            'from_provider': bool(from_provider and until is not None)}


def clear_outage():
    """Forget everything remembered. Used when the whole service is proven up."""
    try:
        os.remove(_path())
    except OSError:
        pass


def record_outage(message, retry_after=None, scope=None, provider=None):
    """
    Remember a failure that affects the service as a whole.

    For things no model can get around: a rejected API key, an unreachable
    network, a provider-wide outage. A quota failure is NOT this - use
    record_model_outage() so the other candidates stay usable.
    """
    state = _read()
    state['service'] = _entry(message, retry_after, scope, provider)
    _write(state)


def record_model_outage(model, message, retry_after=None, scope=None,
                        provider=None, from_provider=True):
    """
    Remember that one model is currently unusable.

    `retry_after` is seconds and must come from the provider itself - never
    from a guess. `scope` names the kind of limit ('minute', 'day') when the
    provider identified one, so the UI can avoid presenting a per-minute retry
    delay as if it were the recovery time for a daily quota.
    """
    if not model:
        return
    state = _read()
    state['models'][model] = _entry(message, retry_after, scope, provider,
                                    from_provider)
    _write(state)


def clear_model(model):
    """A model just answered, so it is not exhausted. Also clears the service."""
    state = _read()
    changed = False
    if model and model in state['models']:
        del state['models'][model]
        changed = True
    if state['service'] is not None:
        state['service'] = None
        changed = True
    if changed:
        _write(state)


def _expired(record):
    """True once a record should no longer be believed."""
    if not isinstance(record, dict):
        return True
    now = time.time()
    until = record.get('until')
    if isinstance(until, (int, float)):
        return now >= until
    # No provider-supplied retry time: assume a short outage rather than
    # stranding the app on the fallback path.
    assumed = _int_env('AI_OUTAGE_ASSUME_SECONDS', _ASSUME_SECONDS)
    return now - float(record.get('at') or 0) >= assumed


def _prune(state):
    """Drop expired records. Returns True when something was dropped."""
    changed = False
    if state['service'] is not None and _expired(state['service']):
        state['service'] = None
        changed = True
    for model in [m for m, r in state['models'].items() if _expired(r)]:
        del state['models'][model]
        changed = True
    return changed


def _live():
    """Current state with expired records removed and the file kept in step."""
    state = _read()
    if _prune(state):
        if state['service'] is None and not state['models']:
            clear_outage()
        else:
            _write(state)
    return state


def unavailable_models():
    """Models known to be exhausted right now."""
    return set(_live()['models'])


def usable_models(candidates):
    """Those of `candidates` not currently known to be exhausted, in order."""
    blocked = unavailable_models()
    return [model for model in candidates if model not in blocked]


def record_for(model):
    """The live exhaustion record for one model, or None."""
    return _live()['models'].get(model)


def hard_blocked(model):
    """
    True when the provider itself told us not to call this model yet.

    A round always starts back at the preferred model, so a model with a stale
    guess against it gets re-tried. This is the one exception: when the
    provider stated a retry time and it has not passed, calling early wastes a
    round trip and on some limits extends the block. Its own instruction is
    better information than our optimism.
    """
    record = record_for(model)
    return bool(record and record.get('from_provider'))


def _recovery(records):
    """
    Describe when the service is expected back - only if that is knowable.

    `records` is every record standing in the way. A recovery time is reported
    ONLY when a provider supplied one for a limit it can describe, and the
    soonest such time wins, because that is when the first candidate returns.

    A per-day quota is excluded even when a retry delay came back with it: on a
    daily quota that delay says when to retry the request, not when the day's
    allowance resets, and the reset schedule is not something the API tells us.
    Presenting it as a recovery time would be a fabrication.
    """
    unknown = {
        'known': False,
        'at': None,
        'text': 'No estimated recovery time is currently available.',
        'source': None,
    }
    daily = any((r or {}).get('scope') == 'day' for r in records)

    times = [r['until'] for r in records
             if isinstance(r, dict)
             and isinstance(r.get('until'), (int, float))
             and r.get('scope') != 'day']
    if not times:
        if daily:
            return dict(unknown, text=(
                'No estimated recovery time is currently available. The daily '
                'allowance has been used up, and the provider does not publish '
                'when it resets for this key.'))
        return unknown

    until = min(times)
    when = datetime.fromtimestamp(until, tz=timezone.utc).astimezone()
    seconds = max(0, int(until - time.time()))
    if seconds < 90:
        human = f'in about {max(seconds, 1)} second{"" if seconds == 1 else "s"}'
    else:
        human = f'in about {round(seconds / 60)} minute(s)'
    return {
        'known': True,
        'at': when.isoformat(timespec='seconds'),
        'text': (f'The provider asked us to retry {human} '
                 f'(about {when.strftime("%H:%M")} your server time).'),
        'source': 'Retry delay returned by the provider with its rate-limit '
                  'response.',
    }


def check():
    """
    Report whether the AI conversion path can be used right now.

    Returns a dict safe to send to the browser: it names services, models and
    states, and never contains credentials.
    """
    provider = llm_providers.get_provider()
    configured = provider.is_configured()
    switched_on = _flag('AI_QA_ENABLED')
    ai_first = _flag('AI_FIRST')

    chain = provider.model_chain(llm_providers.ROLE_DOCUMENT)
    state = _live()
    blocked = set(state['models'])
    ready = [model for model in chain if model not in blocked]

    services = [{
        'name': provider.label,
        'provider': provider.name,
        'models': chain,
        'available_models': ready,
        'exhausted_models': [model for model in chain if model in blocked],
    }]

    if not configured:
        return _unavailable(
            services,
            f'{provider.label} is not configured on this server '
            '(no API key is set).', [])
    if not switched_on:
        return _unavailable(
            services,
            'AI conversion has been switched off on this server '
            '(AI_QA_ENABLED=false).', [])
    if not ai_first:
        # An administrator has pinned the app to the local converters. From
        # the user's side that is indistinguishable from an outage, and they
        # are owed the same warning about what it costs them.
        return _unavailable(
            services,
            'This server is configured to convert without AI '
            '(AI_FIRST=false).', [])

    if state['service'] is not None:
        return _unavailable(services, state['service'].get('message')
                            or f'{provider.label} is currently unavailable.',
                            [state['service']])

    if chain and not ready:
        # Every candidate is exhausted. Only now is the service really down.
        records = [state['models'][model] for model in chain
                   if model in state['models']]
        names = ', '.join(chain)
        return _unavailable(
            services,
            f'Every available {provider.label} model has reached its quota '
            f'({names}). They recover on their own; nothing needs changing.',
            records)

    return {
        'available': True,
        'configured': True,
        'enabled': True,
        'provider': provider.name,
        'services': services,
        'reason': '',
        'recovery': None,
        'checked_at': datetime.now(timezone.utc).astimezone().isoformat(
            timespec='seconds'),
    }


def _unavailable(services, reason, records):
    return {
        'available': False,
        'configured': llm_providers.is_configured(),
        'enabled': True,
        'provider': services[0]['provider'] if services else None,
        'services': services,
        'reason': reason,
        'recovery': _recovery(records),
        'checked_at': datetime.now(timezone.utc).astimezone().isoformat(
            timespec='seconds'),
    }

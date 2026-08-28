"""
Provider adapter for the AI pipeline.

ai.py knows nothing about any particular vendor. It builds neutral "parts"
(a page of media, some instruction text), hands them to a Conversation, and
gets text back. This module is the only place that speaks a vendor SDK.

Two backends ship:

  gemini     - Google Gemini, the default. Chosen because it is the only
               genuinely free multimodal API with native PDF ingestion; the
               free tier costs nothing but its inputs are used to train
               Google's models (see the disclosure in the upload UI) and its
               daily request limits are unpublished.
  anthropic  - Claude. No free tier, so it is opt-in, but it is the strongest
               reader available and doubles as a quality ceiling to measure
               the free models against.

Both sit behind one interface so the pipeline can be pointed at either without
touching it, and so the two can be compared on the same benchmark.
"""

import os
import random
import re
import time

from contex import config

# ---------------------------------------------------------------------------
# Pipeline roles
# ---------------------------------------------------------------------------

# A role names a job the model is asked to do, so that each may be given its
# own model and its own amount of reasoning.
#
#   document   Reading-dominant. A whole page in, a whole document out. The way
#              this fails is by not noticing a dropped line, which is a reading
#              failure - so it wants the model with the best *measured*
#              full-page reading, and it runs on the larger payload.
#
# One role ships today. The plumbing stays because pinning a model per role is
# how an operator overrides it (AI_QA_MODEL_DOCUMENT beats AI_QA_MODEL).
ROLE_DOCUMENT = 'document'

#: How long one model call may take before it is abandoned, in seconds.
#:
#: There was no timeout at all, which meant a connection that stalled rather
#: than failed held a gunicorn worker until the platform killed it. Under a
#: small worker count that is the whole service, taken down by one bad socket.
#:
#: Generous, because the failure this guards against is a hang, not slowness:
#: a page of dense mathematics with thinking enabled can legitimately take most
#: of a minute, and cutting a real answer short would trade an outage for a
#: worse conversion. The retry above sits on top of this and still applies.
AI_REQUEST_TIMEOUT = config.integer('AI_QA_REQUEST_TIMEOUT', 180)


ROLES = (ROLE_DOCUMENT,)


def _role_env(prefix, role, default=None):
    """
    Resolve a per-role setting from the environment.

    `AI_QA_MODEL_DOCUMENT` beats `AI_QA_MODEL`, which beats the built-in
    default. That way one variable still overrides every role - which is what
    most deployments want - without preventing a per-role choice.
    """
    if role:
        specific = os.getenv(f'{prefix}_{role.upper()}')
        if specific and specific.strip():
            return specific.strip()
    shared = os.getenv(prefix)
    if shared and shared.strip():
        return shared.strip()
    return default


# ---------------------------------------------------------------------------
# Neutral content parts
# ---------------------------------------------------------------------------


def media_part(data, media_type, cache=True):
    """One image or PDF to show the model. `cache` marks it as a cache prefix."""
    return {'kind': 'media', 'data': data, 'media_type': media_type,
            'cache': cache}


def text_part(text):
    return {'kind': 'text', 'text': text}


class LlmError(Exception):
    """A user-presentable failure. The message is safe to show in the UI."""


def brief(message, limit=200):
    """
    Reduce a vendor error to something worth showing a user.

    SDKs raise with the whole JSON error body attached - service names, domains,
    type URLs. None of that helps the person who uploaded a page, so pull out
    the human-readable message if there is one and trim the rest.
    """
    if not message:
        return 'unknown error'
    match = re.search(r"'message':\s*'([^']+)'", message)
    if match:
        return match.group(1)
    match = re.search(r'"message":\s*"([^"]+)"', message)
    if match:
        return match.group(1)
    single_line = ' '.join(str(message).split())
    return (single_line[:limit] + '...') if len(single_line) > limit else single_line


class LlmModelError(LlmError):
    """
    One specific model is unusable - unknown id, or no access on this key.

    Distinct from LlmError because the response is different: a bad API key
    dooms every model and should fail immediately, whereas a model this key
    cannot reach should simply be skipped in favour of the next candidate.
    """


class LlmQuotaError(LlmError):
    """
    Rate limited or out of daily quota - the caller may want to retry later.

    Carries whatever the provider itself said about when to come back:
    `retry_after` in seconds and `scope` naming the kind of limit ('minute' or
    'day'). Both are None unless the provider stated them. The app surfaces a
    recovery estimate to users only from these fields, so nothing here may ever
    be filled in with an assumption.
    """

    def __init__(self, message, retry_after=None, scope=None):
        super().__init__(message)
        self.retry_after = retry_after
        self.scope = scope


# google.rpc.RetryInfo, as Gemini serialises it into the error body, plus the
# quota id that says which limit was hit.
_RETRY_DELAY = re.compile(r'"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"')


def parse_retry(raw_error):
    """
    Read a retry delay and a limit scope out of a provider error.

    Returns (seconds|None, scope|None), both straight from the response text.
    Nothing here estimates: a caller that gets (None, None) must report that no
    recovery time is available rather than inventing one.
    """
    text = str(raw_error or '')
    seconds = None
    match = _RETRY_DELAY.search(text)
    if match:
        try:
            seconds = float(match.group(1))
        except ValueError:
            seconds = None
    scope = None
    lowered = text.lower()
    if 'perday' in lowered:
        scope = 'day'
    elif 'perminute' in lowered:
        scope = 'minute'
    return seconds, scope


# ---------------------------------------------------------------------------
# Retry policy
# ---------------------------------------------------------------------------

def retry(operation, attempts=None, base_delay=2.0):
    """
    Run `operation`, backing off on transient failures.

    This matters much more on a free tier than a paid one: an unpublished
    daily limit means a 429 is a normal operating condition, not an anomaly.
    Upstream 5xx are just as ordinary - a benchmark run over three pages lost
    two of them to transient server errors before this default was raised - so
    three attempts, not two.
    """
    attempts = attempts or config.integer('AI_QA_RETRY_ATTEMPTS', 3)
    last = None
    for attempt in range(attempts):
        try:
            return operation()
        except LlmQuotaError as exc:
            last = exc
            if attempt == attempts - 1:
                break
            # Full jitter: several workers hitting the same quota should not
            # retry in lockstep.
            delay = min(base_delay * (2 ** attempt), 30.0)
            time.sleep(random.uniform(0, delay))
        except LlmError:
            raise
    raise last


# ---------------------------------------------------------------------------
# Base classes
# ---------------------------------------------------------------------------

class Conversation:
    """
    A multi-turn exchange that carries the uploaded page through every stage.

    Subclasses keep the vendor's own history format. The contract is:
    `ask(parts)` appends a user turn, returns the model's text, and keeps both
    in history so later turns can still see the original document.
    """

    def __init__(self, provider, model, system, thinking=None, attempts=None):
        self.provider = provider
        self.model = model
        self.system = system
        # How many times a transient failure is retried on THIS model. The
        # rotation layer sets it to 1 for a model it already believes is out of
        # quota, so confirming that costs one quick call instead of three plus
        # backoff on every conversion.
        self.attempts = attempts
        # How hard the model should think, as a neutral level: low, medium,
        # high, or 'off'. Each provider maps this onto its own vocabulary.
        self.thinking = (thinking or 'high').strip().lower()
        self.calls = 0
        self.usage = {'input': 0, 'output': 0, 'cache_read': 0, 'cache_write': 0}

    def ask(self, parts):
        raise NotImplementedError

    def _count(self, **kwargs):
        for key, value in kwargs.items():
            self.usage[key] += value or 0


class Provider:
    name = None
    env_key = None

    #: Human-readable service name, for status messages shown to users.
    label = 'the AI service'

    #: Built-in reasoning effort per role. Converting a page is a reading job
    #: and gains little from long deliberation.
    THINKING = {ROLE_DOCUMENT: 'low'}

    def is_configured(self):
        return bool(os.getenv(self.env_key))

    #: Ordered fallback candidates per role. The first entry is the model the
    #: role was chosen for; the rest exist so that one model running out of
    #: free-tier quota does not take the whole AI path down with it.
    MODEL_CHAIN = {}

    def default_model(self, role=None):
        return self.model_chain(role)[0]

    def model_chain(self, role=None):
        """
        Every model this role may use, best first.

        An operator can set AI_QA_MODEL_DOCUMENT (or AI_QA_MODEL) to a single
        model or to a comma-separated list. Whatever they name goes first, and
        the built-in chain is appended behind it - so pinning a model changes
        the preference without silently removing the safety net. Order is
        preserved and duplicates are dropped.
        """
        chain = []
        override = _role_env('AI_QA_MODEL', role)
        if override:
            chain += [part.strip() for part in override.split(',') if part.strip()]
        chain += self.MODEL_CHAIN.get(role) or self.MODEL_CHAIN.get(
            ROLE_DOCUMENT) or []

        seen, ordered = set(), []
        for model in chain:
            if model and model not in seen:
                seen.add(model)
                ordered.append(model)
        return ordered

    def default_thinking(self, role=None):
        return _role_env('AI_QA_THINKING', role,
                         self.THINKING.get(role, 'high'))

    def models(self):
        """The model each pipeline prefers, for display."""
        return {role: self.default_model(role) for role in ROLES}

    def chains(self):
        """Every candidate per role, for display and for availability checks."""
        return {role: self.model_chain(role) for role in ROLES}

    def trains_on_free_input(self):
        """
        True when this provider's free tier uses submitted documents to train
        its models. The upload UI shows a disclosure when this is true.
        """
        return False

    def start(self, system, model=None, role=None, thinking=None,
              attempts=None):
        raise NotImplementedError



"""
Choosing a provider.

The rest of the application asks this package for a provider and then talks to
the Provider/Conversation interface in base.py. It never imports gemini.py or
anthropic.py directly, which is what keeps "swap the model vendor" a change to
one file plus one line here.

Adding a provider:

    1. write providers/<name>.py with a Provider subclass
    2. add it to _PROVIDERS below
    3. name its key in contex/config.py so it is documented

Nothing else in the application needs to know it exists.
"""

from contex import config
from contex.services.llm.anthropic import AnthropicProvider
# Re-exported so the rest of the application imports one name -
# contex.services.llm - rather than reaching into base.py. __all__ is what
# says these are deliberate re-exports rather than forgotten imports.
from contex.services.llm.base import (
    AI_REQUEST_TIMEOUT, Conversation, LlmError, LlmModelError, LlmQuotaError,
    Provider, ROLE_DOCUMENT, ROLES, media_part, parse_retry, text_part,
)
from contex.services.llm.gemini import GeminiProvider

# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

_PROVIDERS = {
    'gemini': GeminiProvider(),
    'anthropic': AnthropicProvider(),
}

DEFAULT_PROVIDER = 'gemini'


def get_provider(name=None):
    """
    Return the configured provider.

    AI_QA_PROVIDER selects one explicitly. Otherwise we take the default and,
    if it has no key but another provider does, fall back to that one - so a
    server configured with only an Anthropic key still works without anyone
    having to set a second variable.
    """
    name = (name or config.text('AI_QA_PROVIDER') or '').strip().lower()
    if name:
        if name not in _PROVIDERS:
            raise LlmError(
                f"Unknown AI_QA_PROVIDER {name!r}. Supported: "
                + ', '.join(sorted(_PROVIDERS)))
        return _PROVIDERS[name]

    preferred = _PROVIDERS[DEFAULT_PROVIDER]
    if preferred.is_configured():
        return preferred
    for provider in _PROVIDERS.values():
        if provider.is_configured():
            return provider
    return preferred


def available():
    """Names of every provider that currently has credentials."""
    return sorted(name for name, provider in _PROVIDERS.items()
                  if provider.is_configured())


def is_configured():
    return bool(available())


__all__ = [
    # the registry, which is what most callers want
    'get_provider', 'available', 'is_configured', 'DEFAULT_PROVIDER',
    # the interface a provider implements, and the errors it may raise
    'Provider', 'Conversation', 'ROLE_DOCUMENT', 'ROLES',
    'LlmError', 'LlmModelError', 'LlmQuotaError',
    # helpers for building a request and reading a failure
    'media_part', 'text_part', 'parse_retry', 'AI_REQUEST_TIMEOUT',
]

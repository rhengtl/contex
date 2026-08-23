# llm_providers.py
"""
Provider adapter for the AI QA layer.

The review layer in ai_qa.py knows nothing about any particular vendor. It builds
neutral "parts" (a page of media, some instruction text), hands them to a
Conversation, and gets text back. This module is the only place that speaks a
vendor SDK.

Two backends ship:

  gemini     - Google Gemini, the default. Chosen because it is the only
               genuinely free multimodal API with native PDF ingestion; the
               free tier costs nothing but its inputs are used to train
               Google's models (see the disclosure in the upload UI) and its
               daily request limits are unpublished.
  anthropic  - Claude. No free tier, so it is opt-in, but it is the strongest
               reviewer available and doubles as a quality ceiling to measure
               the free models against.

Both sit behind one interface so the QA layer can be pointed at either without
touching the pipelines, and so the two can be compared on the same benchmark.
"""

import os
import random
import re
import time

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


def _brief(message, limit=200):
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


class LlmQuotaError(LlmError):
    """Rate limited or out of daily quota - the caller may want to retry later."""


# ---------------------------------------------------------------------------
# Retry policy
# ---------------------------------------------------------------------------

def _int_env(name, default):
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _retry(operation, attempts=None, base_delay=2.0):
    """
    Run `operation`, backing off on transient failures.

    This matters much more on a free tier than a paid one: an unpublished
    daily limit means a 429 is a normal operating condition, not an anomaly.
    """
    attempts = attempts or _int_env('AI_QA_RETRY_ATTEMPTS', 2)
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

    def __init__(self, provider, model, system):
        self.provider = provider
        self.model = model
        self.system = system
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

    def is_configured(self):
        return bool(os.getenv(self.env_key))

    def default_model(self):
        raise NotImplementedError

    def trains_on_free_input(self):
        """
        True when this provider's free tier uses submitted documents to train
        its models. The upload UI shows a disclosure when this is true.
        """
        return False

    def start(self, system, model=None):
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------

class _GeminiConversation(Conversation):

    def __init__(self, provider, model, system, client, types):
        super().__init__(provider, model, system)
        self._client = client
        self._types = types
        self._history = []
        self._thinking_ok = True

    def _to_parts(self, parts):
        out = []
        for part in parts:
            if part['kind'] == 'media':
                out.append(self._types.Part.from_bytes(
                    data=part['data'], mime_type=part['media_type']))
            else:
                out.append(self._types.Part.from_text(text=part['text']))
        return out

    def _config(self):
        kwargs = {
            'system_instruction': self.system,
            'max_output_tokens': _int_env('AI_QA_MAX_TOKENS', 32000),
            'temperature': float(os.getenv('AI_QA_TEMPERATURE', '0')),
            # We pass no tools, so turn the automatic function-calling loop off
            # rather than have the SDK warn about it on every request.
            'automatic_function_calling': self._types.AutomaticFunctionCallingConfig(
                disable=True),
        }
        level = os.getenv('AI_QA_THINKING', 'high')
        if self._thinking_ok and level and level.lower() != 'off':
            kwargs['thinking_config'] = self._types.ThinkingConfig(
                thinking_level=level.upper())
        return self._types.GenerateContentConfig(**kwargs)

    def ask(self, parts):
        from google.genai import errors as genai_errors

        self._history.append(self._types.Content(
            role='user', parts=self._to_parts(parts)))
        self.calls += 1

        def call():
            try:
                return self._client.models.generate_content(
                    model=self.model,
                    contents=self._history,
                    config=self._config())
            except genai_errors.ClientError as exc:
                status = getattr(exc, 'code', None)
                message = str(exc)
                if status == 429 or 'RESOURCE_EXHAUSTED' in message:
                    raise LlmQuotaError(
                        "The free Gemini quota is exhausted or rate limited. "
                        "Free-tier limits reset daily; please try again later."
                    ) from exc
                # An invalid key comes back as 400 INVALID_ARGUMENT, not 401,
                # so match on the reason rather than the status code.
                if (status in (401, 403) or 'API_KEY_INVALID' in message
                        or 'API key not valid' in message):
                    raise LlmError(
                        "The server's Gemini API key was rejected. Check "
                        "GEMINI_API_KEY.") from exc
                if 'PERMISSION_DENIED' in message:
                    raise LlmError(
                        "The server's Gemini API key does not have access to "
                        "this model.") from exc
                if 'NOT_FOUND' in message or 'is not found' in message:
                    raise LlmError(
                        f"The model {self.model!r} is not available to this "
                        "API key. Check AI_QA_MODEL.") from exc
                if 'thinking' in message.lower() and self._thinking_ok:
                    # This model does not accept a thinking level; drop it once
                    # and let the retry go through without.
                    self._thinking_ok = False
                    raise LlmQuotaError('retrying without thinking config')
                raise LlmError(
                    f"Gemini rejected the request: {_brief(message)}") from exc
            except genai_errors.ServerError as exc:
                raise LlmQuotaError(
                    "Gemini had a server error. Please try again.") from exc
            except LlmError:
                raise
            except Exception as exc:
                raise LlmError(f"Gemini request failed: {exc}") from exc

        response = _retry(call)

        usage = getattr(response, 'usage_metadata', None)
        if usage:
            cached = getattr(usage, 'cached_content_token_count', 0) or 0
            prompt = getattr(usage, 'prompt_token_count', 0) or 0
            self._count(
                input=max(prompt - cached, 0),
                output=((getattr(usage, 'candidates_token_count', 0) or 0)
                        + (getattr(usage, 'thoughts_token_count', 0) or 0)),
                cache_read=cached)

        candidate = (response.candidates or [None])[0]
        if candidate is None:
            raise LlmError("Gemini returned no response.")

        finish = str(getattr(candidate, 'finish_reason', '') or '')
        if 'SAFETY' in finish or 'PROHIBITED' in finish or 'BLOCKLIST' in finish:
            raise LlmError(
                "The model declined to process this document. If it is an "
                "ordinary document, please try a different scan.")

        text = (response.text or '').strip()
        if not text:
            if 'MAX_TOKENS' in finish:
                raise LlmError(
                    "The document was too long for one response. Try fewer "
                    "pages, or raise AI_QA_MAX_TOKENS.")
            raise LlmError("The model returned an empty response.")

        if candidate.content is not None:
            self._history.append(candidate.content)
        return text


class GeminiProvider(Provider):
    name = 'gemini'
    env_key = 'GEMINI_API_KEY'

    def is_configured(self):
        return bool(os.getenv('GEMINI_API_KEY') or os.getenv('GOOGLE_API_KEY'))

    def default_model(self):
        return os.getenv('AI_QA_MODEL', 'gemini-3.1-flash-lite')

    def trains_on_free_input(self):
        # Google's free tier uses submitted content to improve its models;
        # this is what drives the disclosure shown above the upload button.
        return os.getenv('GEMINI_PAID_TIER', 'false').lower() != 'true'

    def start(self, system, model=None):
        try:
            from google import genai
            from google.genai import types
        except ImportError as exc:
            raise LlmError(
                "The 'google-genai' package is not installed on the server. "
                "Run: pip install google-genai") from exc

        if not self.is_configured():
            raise LlmError(
                "AI LaTeX conversion is not configured on this server "
                "(GEMINI_API_KEY is not set).")

        api_key = os.getenv('GEMINI_API_KEY') or os.getenv('GOOGLE_API_KEY')
        client = genai.Client(api_key=api_key)
        return _GeminiConversation(self, model or self.default_model(),
                                   system, client, types)


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------

# Server-side refusal fallbacks are a beta. If this account or SDK build does
# not accept them we degrade once, for the life of the process, rather than
# failing the user's conversion.
_FALLBACK_BETA = 'server-side-fallback-2026-07-01'
_fallbacks_available = os.getenv('AI_QA_ENABLE_FALLBACKS', 'true').lower() != 'false'


class _AnthropicConversation(Conversation):

    def __init__(self, provider, model, system, client):
        super().__init__(provider, model, system)
        self._client = client
        self._messages = []

    def _to_blocks(self, parts):
        blocks = []
        for part in parts:
            if part['kind'] == 'media':
                block = {
                    'type': ('document' if part['media_type'] == 'application/pdf'
                             else 'image'),
                    'source': {
                        'type': 'base64',
                        'media_type': part['media_type'],
                        'data': _b64(part['data']),
                    },
                }
                if part.get('cache'):
                    # Later stages re-read the page from cache instead of
                    # paying to upload it again.
                    block['cache_control'] = {'type': 'ephemeral'}
                blocks.append(block)
            else:
                blocks.append({'type': 'text', 'text': part['text']})
        return blocks

    def ask(self, parts):
        import anthropic

        self._messages.append({'role': 'user', 'content': self._to_blocks(parts)})
        self.calls += 1

        kwargs = {
            'model': self.model,
            'max_tokens': _int_env('AI_QA_MAX_TOKENS', 32000),
            'system': self.system,
            'messages': self._messages,
            'thinking': {'type': 'adaptive'},
            'output_config': {'effort': os.getenv('AI_QA_EFFORT', 'high')},
            # Extends the cached prefix to the end of each turn, so the growing
            # transcript is also read from cache rather than re-billed.
            'cache_control': {'type': 'ephemeral'},
        }

        def call():
            global _fallbacks_available
            try:
                if _fallbacks_available:
                    try:
                        with self._client.beta.messages.stream(
                                betas=[_FALLBACK_BETA], fallbacks='default',
                                **kwargs) as stream:
                            return stream.get_final_message()
                    except Exception as exc:
                        blob = str(exc).lower()
                        if 'fallback' not in blob and 'beta' not in blob:
                            raise
                        print("Notice: server-side refusal fallbacks "
                              f"unavailable ({exc}); continuing without them.")
                        _fallbacks_available = False
                with self._client.messages.stream(**kwargs) as stream:
                    return stream.get_final_message()
            except anthropic.RateLimitError as exc:
                raise LlmQuotaError(
                    "The AI service is rate limited right now. Please try "
                    "again shortly.") from exc
            except anthropic.AuthenticationError as exc:
                raise LlmError(
                    "The server's Anthropic API key was rejected. Check "
                    "ANTHROPIC_API_KEY.") from exc
            except anthropic.PermissionDeniedError as exc:
                raise LlmError(
                    "The server's Anthropic API key lacks access to this "
                    "model.") from exc
            except anthropic.APITimeoutError as exc:
                raise LlmQuotaError(
                    "The AI request timed out. Try a smaller document.") from exc
            except anthropic.APIConnectionError as exc:
                raise LlmError(
                    "Could not reach the AI service. Check the server's "
                    "connection.") from exc
            except anthropic.APIStatusError as exc:
                if exc.status_code >= 500:
                    raise LlmQuotaError(
                        "The AI service had a server error.") from exc
                raise LlmError(f"AI request failed ({exc.status_code}).") from exc
            except LlmError:
                raise
            except Exception as exc:
                raise LlmError(f"AI request failed: {exc}") from exc

        response = _retry(call)

        usage = response.usage
        self._count(
            input=getattr(usage, 'input_tokens', 0),
            output=getattr(usage, 'output_tokens', 0),
            cache_read=getattr(usage, 'cache_read_input_tokens', 0),
            cache_write=getattr(usage, 'cache_creation_input_tokens', 0))

        if response.stop_reason == 'refusal':
            raise LlmError(
                "The model declined to process this document. If it is an "
                "ordinary document, please try a different scan.")

        text = '\n'.join(block.text for block in response.content
                         if getattr(block, 'type', None) == 'text').strip()
        self._messages.append({'role': 'assistant', 'content': response.content})
        if not text:
            raise LlmError("The model returned an empty response.")
        return text


def _b64(data):
    import base64
    return base64.standard_b64encode(data).decode('ascii')


class AnthropicProvider(Provider):
    name = 'anthropic'
    env_key = 'ANTHROPIC_API_KEY'

    def is_configured(self):
        return bool(os.getenv('ANTHROPIC_API_KEY')
                    or os.getenv('ANTHROPIC_AUTH_TOKEN'))

    def default_model(self):
        return os.getenv('AI_QA_MODEL', 'claude-opus-5')

    def start(self, system, model=None):
        try:
            import anthropic
        except ImportError as exc:
            raise LlmError(
                "The 'anthropic' package is not installed on the server. "
                "Run: pip install anthropic") from exc

        if not self.is_configured():
            raise LlmError(
                "AI LaTeX conversion is not configured on this server "
                "(ANTHROPIC_API_KEY is not set).")
        return _AnthropicConversation(self, model or self.default_model(),
                                      system, anthropic.Anthropic())


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
    name = (name or os.getenv('AI_QA_PROVIDER') or '').strip().lower()
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

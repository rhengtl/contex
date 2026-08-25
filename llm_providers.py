# llm_providers.py
"""
Provider adapter for the AI pipeline.

ai_qa.py knows nothing about any particular vendor. It builds neutral "parts"
(a page of media, some instruction text), hands them to a Conversation, and
gets text back. This module is the only place that speaks a vendor SDK.

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
ROLES = (ROLE_DOCUMENT,)


def _role_env(prefix, role, default=None):
    """
    Resolve a per-role setting from the environment.

    `AI_QA_MODEL_EQUATIONS` beats `AI_QA_MODEL`, which beats the built-in
    default. That way one variable still overrides both pipelines - which is
    what most deployments want - without preventing the split.
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
    Upstream 5xx are just as ordinary - a benchmark run over three pages lost
    two of them to transient server errors before this default was raised - so
    three attempts, not two.
    """
    attempts = attempts or _int_env('AI_QA_RETRY_ATTEMPTS', 3)
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


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------

class _GeminiConversation(Conversation):

    def __init__(self, provider, model, system, client, types, thinking=None,
                 attempts=None):
        super().__init__(provider, model, system, thinking, attempts)
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
        # Not every model accepts every level - gemini-3.7-flash dropped
        # 'minimal', for instance - and a model that rejects the field at all
        # is handled by the retry in ask().
        level = self.thinking
        if self._thinking_ok and level and level != 'off':
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
                    # Gemini returns 429 for both the per-minute and the daily
                    # limit, and the free tier's per-minute ceiling is low
                    # enough that a few conversions in a row will reach it.
                    # Don't claim it is the daily one; a minute's wait usually
                    # clears it.
                    delay, scope = parse_retry(message)
                    detail = ''
                    if scope == 'day':
                        detail = (" This key's daily allowance for this model "
                                  "is used up.")
                    raise LlmQuotaError(
                        "The Gemini free tier is rate limited right now. Wait "
                        "a minute and try again - free-tier limits are per "
                        "minute as well as per day." + detail,
                        retry_after=delay, scope=scope,
                    ) from exc
                # An invalid key comes back as 400 INVALID_ARGUMENT, not 401,
                # so match on the reason rather than the status code.
                if (status in (401, 403) or 'API_KEY_INVALID' in message
                        or 'API key not valid' in message):
                    raise LlmError(
                        "The server's Gemini API key was rejected. Check "
                        "GEMINI_API_KEY.") from exc
                if 'PERMISSION_DENIED' in message:
                    raise LlmModelError(
                        f"This key does not have access to {self.model!r}."
                    ) from exc
                if 'NOT_FOUND' in message or 'is not found' in message:
                    raise LlmModelError(
                        f"The model {self.model!r} is not available to this "
                        "API key.") from exc
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

        response = _retry(call, attempts=self.attempts)

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
    label = 'Google Gemini'

    # Both are free-tier eligible, so the split costs nothing to run.
    #
    #   gemini-3.1-flash-lite  Document review. Chosen on measured evidence
    #       rather than recency: on socOCRbench (an independent full-page
    #       benchmark scoring edit similarity, chrF and table structure) it
    #       scores 0.6214, statistically tied with the best free-tier model and
    #       ahead of gemini-3.5-flash - while being the cheapest of them if
    #       billing is ever enabled.
    #   gemini-3.6-flash       Equation review. A full Flash model, so it
    #       brings the reasoning the two-check discipline and the
    #       relationship/ordering analysis need - and it has the best measured
    #       free-tier reading of any of them (socOCRbench 0.6225), which
    #       matters because checking a transcription against the image *is* an
    #       act of reading.
    #
    # Not gemini-3.7-flash, despite being newer and the stronger reasoner on
    # paper: its free-tier daily quota ran out after about a dozen calls in
    # testing, which would leave most equation conversions unreviewed. 3.6
    # sustained 11 consecutive calls, and on the same test page it recovered a
    # formula pix2text had mangled into prose where 3.7 merely reported it
    # missing. Both cost the same on the paid tier, so this is not a downgrade.
    # Each role's preference is simply the first entry of its chain - there is
    # no separate "the model" setting, because two sources of truth for which
    # model a role uses is how the two drift apart.
    #
    # Fallback order, best first. These are the four models this project has
    # actually evaluated; nothing speculative is listed, because rotating onto
    # a model id that does not exist would turn one exhausted quota into a run
    # of confusing errors.
    #
    # Each role leads with the model it was chosen for and then borrows the
    # other role's, since a role's second choice is still far better than
    # dropping to Tesseract. gemini-3.7-flash is last everywhere: it is the
    # strongest reasoner on paper but its free daily quota ran out after about
    # a dozen calls in testing, so it makes a poor primary and a fine last
    # resort.
    MODEL_CHAIN = {
        ROLE_DOCUMENT: ['gemini-3.1-flash-lite', 'gemini-3.6-flash',
                        'gemini-3.5-flash', 'gemini-3.7-flash'],
    }

    def is_configured(self):
        return bool(os.getenv('GEMINI_API_KEY') or os.getenv('GOOGLE_API_KEY'))

    def trains_on_free_input(self):
        # Google's free tier uses submitted content to improve its models;
        # this is what drives the disclosure shown above the upload button.
        return os.getenv('GEMINI_PAID_TIER', 'false').lower() != 'true'

    def start(self, system, model=None, role=None, thinking=None,
              attempts=None):
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
        return _GeminiConversation(self, model or self.default_model(role),
                                   system, client, types,
                                   thinking or self.default_thinking(role),
                                   attempts)


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------

# Server-side refusal fallbacks are a beta. If this account or SDK build does
# not accept them we degrade once, for the life of the process, rather than
# failing the user's conversion.
_FALLBACK_BETA = 'server-side-fallback-2026-07-01'
_fallbacks_available = os.getenv('AI_QA_ENABLE_FALLBACKS', 'true').lower() != 'false'


class _AnthropicConversation(Conversation):

    def __init__(self, provider, model, system, client, thinking=None,
                 attempts=None):
        super().__init__(provider, model, system, thinking, attempts)
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
            # Extends the cached prefix to the end of each turn, so the growing
            # transcript is also read from cache rather than re-billed.
            'cache_control': {'type': 'ephemeral'},
        }
        # 'off' means no extended thinking at all; anything else is an effort
        # level. Claude has no 'off' effort, so the key is dropped instead.
        if self.thinking != 'off':
            kwargs['thinking'] = {'type': 'adaptive'}
            kwargs['output_config'] = {'effort': self.thinking}

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
                # Anthropic states the wait in a retry-after header; use that
                # rather than guessing when the service comes back.
                after = None
                try:
                    raw = (getattr(exc, 'response', None)
                           and exc.response.headers.get('retry-after'))
                    after = float(raw) if raw else None
                except (TypeError, ValueError, AttributeError):
                    after = None
                raise LlmQuotaError(
                    "The AI service is rate limited right now. Please try "
                    "again shortly.", retry_after=after,
                    scope='minute' if after else None) from exc
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

        response = _retry(call, attempts=self.attempts)

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
    label = 'Anthropic Claude'

    # One model for both roles. Sonnet 5 rather than Opus 5: this is
    # proofreading, and Opus costs 2.5x for it. Sonnet 5 still brings vision, a
    # 1M-token context, and - the reason to offer this provider at all -
    # Anthropic does not train on API input, so it is the path for documents
    # that must not go to a free tier.
    # One model, deliberately no rotation. Anthropic has no free tier, so its
    # 429s are short per-minute rate limits that clear on their own rather than
    # a daily allowance that is gone for the day - retrying the same model is
    # the right response. Rotating to Opus on a rate limit would quietly raise
    # the bill 2.5x to solve a problem that waiting solves for nothing.
    MODEL_CHAIN = {
        ROLE_DOCUMENT: ['claude-sonnet-5'],
    }

    def is_configured(self):
        return bool(os.getenv('ANTHROPIC_API_KEY')
                    or os.getenv('ANTHROPIC_AUTH_TOKEN'))

    def default_thinking(self, role=None):
        # AI_QA_EFFORT predates the per-role split; honour it if it is set.
        return os.getenv('AI_QA_EFFORT') or super().default_thinking(role)

    def start(self, system, model=None, role=None, thinking=None,
              attempts=None):
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
        return _AnthropicConversation(self, model or self.default_model(role),
                                      system, anthropic.Anthropic(),
                                      thinking or self.default_thinking(role),
                                      attempts)


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

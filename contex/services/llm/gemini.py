"""
Google Gemini.

Everything specific to this provider lives here: how a conversation is built,
which models it prefers and in what order it falls back through them, how its
errors map onto the shared LlmError family, and the fact that its free tier
trains on submitted documents - which is what drives the disclosure the user
sees before uploading.
"""

import os
import threading

from contex import config
from contex.services.llm.base import (
    AI_REQUEST_TIMEOUT, Conversation, LlmError, LlmModelError, LlmQuotaError,
    Provider, ROLE_DOCUMENT, parse_retry, brief, retry,
)

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
            'max_output_tokens': config.integer('AI_QA_MAX_TOKENS', 32000),
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
                    f"Gemini rejected the request: {brief(message)}") from exc
            except genai_errors.ServerError as exc:
                raise LlmQuotaError(
                    "Gemini had a server error. Please try again.") from exc
            except LlmError:
                raise
            except Exception as exc:
                raise LlmError(f"Gemini request failed: {exc}") from exc

        response = retry(call, attempts=self.attempts)

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


#: One client per API key, shared across conversations. The client owns an HTTP
#: connection pool, so building a new one per page threw away the pooled TLS
#: connection and paid for a fresh handshake on every request - most visibly on
#: a multi-page PDF, which opens one conversation per page. The SDK's client is
#: safe to share between threads, which the concurrent page conversion needs.
_GEMINI_CLIENTS = {}
_GEMINI_CLIENTS_LOCK = threading.Lock()




def _gemini_client(genai, api_key):
    """The shared client for this key, building it the first time."""
    from google.genai import types
    with _GEMINI_CLIENTS_LOCK:
        client = _GEMINI_CLIENTS.get(api_key)
        if client is None:
            client = genai.Client(
                api_key=api_key,
                # The SDK counts this one in milliseconds.
                http_options=types.HttpOptions(
                    timeout=AI_REQUEST_TIMEOUT * 1000))
            _GEMINI_CLIENTS[api_key] = client
        return client


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
        client = _gemini_client(genai, api_key)
        return _GeminiConversation(self, model or self.default_model(role),
                                   system, client, types,
                                   thinking or self.default_thinking(role),
                                   attempts)



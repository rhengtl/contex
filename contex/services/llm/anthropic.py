"""
Anthropic Claude.

The opt-in second provider. It has no free tier, so it is never reached
unless a key is configured - which also makes it the one to use for documents
that must not go to a free tier, since Anthropic does not train on API input.
"""
import os

from contex import config
from contex.services.llm.base import (
    AI_REQUEST_TIMEOUT, Conversation, LlmError, LlmQuotaError, Provider, ROLE_DOCUMENT, retry,
)

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
            'max_tokens': config.integer('AI_QA_MAX_TOKENS', 32000),
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

        response = retry(call, attempts=self.attempts)

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
        # Same reasoning as the Gemini client: a stalled socket must not be
        # able to hold a worker open indefinitely. This SDK counts in seconds.
        return _AnthropicConversation(self, model or self.default_model(role),
                                      system,
                                      anthropic.Anthropic(
                                          timeout=AI_REQUEST_TIMEOUT),
                                      thinking or self.default_thinking(role),
                                      attempts)



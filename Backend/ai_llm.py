"""
AI PREVENTION PROPOSER -- LLM call reliability wrapper (Part 5).

Empirically verified against the REAL qwen/qwen3.6-27b model on Groq
before this was built (see scripts/test_groq_json_mode.py): 5/6 real
structured-extraction prompts returned clean, unfenced valid JSON on the
first try. But the Hazard Analyst's own real prompt shape failed
outright on 2 of 3 IDENTICAL retries with groq.BadRequestError
(code=json_validate_failed) and an EMPTY failed_generation -- a genuine
intermittent server-side constrained-decoding failure, not a parsing
issue, and not something a bare json.loads() retry would catch. Every
LLM call in this feature MUST go through this wrapper, not call the
Groq client directly.
"""
import json
import os

import groq as groq_module
from groq import Groq

_client = None

# Verified against the real Groq /models list before use (see
# scripts/test_groq_json_mode.py's setup) -- qwen/qwen3.6-27b genuinely
# exists on Groq today. Do not swap this for a guessed model string
# without re-checking client.models.list() first.
MODEL = "qwen/qwen3.6-27b"


def get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY is not set (Backend/.env) -- the AI Prevention Proposer needs it.")
        _client = Groq(api_key=api_key)
    return _client


def strip_markdown_fences(text):
    """response_format=json_object did NOT produce a markdown-fenced
    response in any of the 6 real test prompts, but the build spec is
    right that a live demo is exactly when a model decides to add one
    -- this is cheap insurance, not dead code."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t
        if t.endswith("```"):
            t = t.rsplit("```", 1)[0]
    return t.strip()


def call_llm_json(prompt, validate_fn=None, max_retries=2, timeout_s=15, temperature=0.3, deadline=None):
    """
    Calls MODEL with JSON-object mode, retrying (up to max_retries
    additional attempts) on:
      - groq.GroqError -- covers the real intermittent 400
        json_validate_failed seen in testing, plus rate limits/timeouts/
        connection errors.
      - json.JSONDecodeError -- a malformed JSON string survived
        strip_markdown_fences.
      - whatever validate_fn(parsed) raises, if given (e.g. a pydantic
        ValidationError for a response that parsed as JSON but doesn't
        match the expected shape).

    Returns the parsed dict on success. Re-raises the LAST error if
    every attempt fails -- the caller (Hazard Analyst / Proposer) is
    responsible for deciding whether a total failure there is fatal or
    just means "skip this one zone/candidate".

    `deadline` (an absolute time.time() cutoff) is checked before EVERY
    attempt, not just once per caller-level loop iteration -- without
    this, a single call's own up-to-(max_retries+1)*timeout_s retry
    budget (here, up to 4*15s = 60s) can alone blow past
    /ai/prevention/suggest's entire ~35s request budget before any of
    the outer per-zone/per-action-type deadline checks in
    ai_hazard_analyst.py / ai_proposer.py ever get a chance to notice.
    Caught by timing the real live endpoint twice in a row -- the outer
    checks alone weren't enough.
    """
    import time as _time

    client = get_client()
    last_error = None

    for attempt in range(max_retries + 1):
        if deadline is not None and _time.time() >= deadline:
            if last_error is not None:
                raise last_error
            raise TimeoutError("call_llm_json: deadline reached before any attempt could complete")
        try:
            response = client.chat.completions.create(
                model=MODEL,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                temperature=temperature,
                timeout=timeout_s,
            )
            raw = response.choices[0].message.content
            cleaned = strip_markdown_fences(raw)
            parsed = json.loads(cleaned)
            if validate_fn is not None:
                validate_fn(parsed)
            return parsed
        except (groq_module.GroqError, json.JSONDecodeError) as e:
            last_error = e
            continue
        except Exception as e:
            # Anything validate_fn raised (e.g. pydantic ValidationError).
            last_error = e
            continue

    raise last_error

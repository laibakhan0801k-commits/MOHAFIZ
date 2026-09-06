"""
AI PREVENTION PROPOSER -- LLM call reliability wrapper (Part 5).

Switched from Groq (qwen/qwen3.6-27b) to Google Gemini -- the Groq
account's 200,000 tokens/day quota was being exhausted daily, in part by
qwen3.6-27b being a reasoning model that burned its whole completion
budget "thinking" before ever emitting the JSON answer (see the old
REASONING_EFFORT note this replaced). This model's thinking is cut down
via THINKING_LEVEL (see that constant's own comment -- the exact
parameter name differs by Gemini generation, and MODEL's comment below
explains the two earlier models this file tried and rejected before
landing here) for the same reason: avoid that failure mode from the
start rather than working around it after the fact.

Gemini's FREE tier is not more generous in every dimension, though: it
caps requests at 5 per minute for this model (a per-minute burst limit,
separate from any daily token quota), and one Hazard Analyst + Proposer
run makes far more than 5 real calls (one per zone, then more per zone
trying different action types, with retries). Hitting the button
reproducibly returned "You exceeded your current quota... limit: 5" a
few seconds in. _wait_for_rate_limit_slot below paces every real call
process-wide so the app stays under that limit by waiting instead of
firing a burst and getting rejected.

Every LLM call in this feature MUST go through this wrapper, not call
the Gemini client directly -- callers only depend on call_llm_json's
return shape (a parsed dict) and its exceptions, never on genai types.
"""
import json
import os
import threading
import time as _time

from google import genai
from google.genai import types
from google.genai import errors as genai_errors

_client = None

# Real, observed limit for this account/model: "limit: 5, model:
# gemini-3.6-flash" in the free-tier 429 body. RATE_LIMIT_MAX_CALLS is
# kept a little under that (not exactly 5) so a call that lands right on
# the window boundary -- our clock and Google's aren't perfectly synced
# -- doesn't still get rejected.
# NOTE: the "5" above was observed for gemini-3.6-flash specifically.
# Per-minute limits are per-model, and the standard flash models allow
# materially more, so pinning everything to 4/min made OUR OWN limiter
# the bottleneck rather than Google's: a 3-zone Response run needs ~6
# calls and would spend its whole budget waiting on us, then fail with
# our own TimeoutError without Google ever refusing anything. Raised,
# and overridable per deployment. Still safe if set too high: a real
# 429 is caught, the window is marked full, and the call is retried.
RATE_LIMIT_MAX_CALLS = int(os.environ.get("GEMINI_MAX_CALLS_PER_MIN") or 8)
RATE_LIMIT_WINDOW_S = 60.0

# Timestamps (time.time()) of the last real generate_content calls made
# by ANY caller in this process -- module-level and shared on purpose.
# The Hazard Analyst, Proposer, and Strategist all draw from the SAME
# Gemini account quota, so pacing only one of them isn't enough; every
# real request across all three has to share one clock.
_call_times = []
_call_times_lock = threading.Lock()


def _wait_for_rate_limit_slot(deadline=None):
    """Blocks until it is safe to make one more real Gemini call without
    exceeding the free-tier requests-per-minute limit. Sleeps in a loop
    rather than a single computed delay, since another thread can claim
    a slot while this one is asleep.

    Respects `deadline` the same way call_llm_json already does for
    everything else: if waiting for a slot to free up would run past
    the caller's own time budget, raises TimeoutError instead of
    sleeping past it and returning an answer nobody has time left to use.
    """
    while True:
        now = _time.time()
        with _call_times_lock:
            while _call_times and _call_times[0] <= now - RATE_LIMIT_WINDOW_S:
                _call_times.pop(0)
            if len(_call_times) < RATE_LIMIT_MAX_CALLS:
                _call_times.append(now)
                return
            wait_until = _call_times[0] + RATE_LIMIT_WINDOW_S

        if deadline is not None and wait_until >= deadline:
            # Report the REAL numbers. This message used to hard-code
            # "5 requests/minute" while RATE_LIMIT_MAX_CALLS defaulted to
            # 8, so it told the user a limit the code was not using and
            # gave them no idea how long to wait.
            raise TimeoutError(
                "This run hit the per-minute AI rate limit "
                f"({RATE_LIMIT_MAX_CALLS} calls/{int(RATE_LIMIT_WINDOW_S)}s) with only "
                f"{max(0.0, deadline - now):.0f}s of its time budget left, so it stopped "
                f"instead of waiting {max(0.0, wait_until - now):.0f}s for a free slot. "
                "Wait about a minute and generate again."
            )
        _time.sleep(max(0.05, wait_until - _time.time()))

# gemini-2.5-flash: real 404, "no longer available to new users".
# gemini-3.6-flash: worked, but this account's free tier gives it its
# own separate real daily cap of just 20 requests
# (GenerateRequestsPerDayPerProjectPerModel-FreeTier, confirmed straight
# from a real Google 429 body) -- far too low for one AI Prevention/
# Response run, which can make several real calls on its own.
# gemini-2.5-flash-lite: ALSO a real 404, same "no longer available to
# new users" message, this time pointing at gemini-3.5-flash-lite.
# gemini-3.5-flash-lite: confirmed reachable on this key via a real
# client.models.get() call (not guessed) -- a "lite" variant, which
# typically carries a materially higher free daily allowance than a
# full preview model like 3.6-flash. Google's per-model free-tier quota
# means switching MODEL gives this a fresh, separate daily bucket, not
# one already drained by testing the other two. Swap only after the
# same kind of check -- don't guess a model string.
#
# Overridable via the GEMINI_MODEL env var (Backend/.env locally, or
# Render's dashboard env vars) so a model that starts returning 503
# "experiencing high demand" -- which gemini-3.5-flash-lite did,
# repeatedly and persistently, during real testing -- can be swapped
# without a code change or redeploy.
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-3.1-flash-lite"


def get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is not set (Backend/.env) -- the AI Prevention Proposer needs it.")
        _client = genai.Client(api_key=api_key)
    return _client


def strip_markdown_fences(text):
    """response_mime_type='application/json' should not produce a
    markdown-fenced response, but this is cheap insurance against a
    model that decides to add one anyway -- carried over unchanged from
    the Groq version, same reasoning applies here."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t
        if t.endswith("```"):
            t = t.rsplit("```", 1)[0]
    return t.strip()


# When "thinking" is on, its tokens are billed against the same output
# budget as the actual answer -- the exact failure mode that broke the
# old Groq model (a completion budget consumed entirely by reasoning,
# with no valid JSON ever emitted). Cutting it down is a direct fix.
#
# IMPORTANT: the parameter name for this is NOT the same across Gemini
# generations, and sending the wrong one is a real, confirmed 400
# INVALID_ARGUMENT (hit live, twice: once needing thinking_level instead
# of thinking_budget for a 3.x model, once the reverse for a 2.5 model
# tried in between). gemini-3.5-flash-lite is Gemini 3-generation
# (confirmed via its own real version string, "3.5-flash-lite-...", from
# a real client.models.get() call) and so uses the newer thinking_level
# enum (MINIMAL/LOW/MEDIUM/HIGH), not the older thinking_budget integer.
# MINIMAL is the closest equivalent to "off" this generation accepts.
THINKING_LEVEL = types.ThinkingLevel.MINIMAL

# Generous relative to the real payload (a single zone/proposal object
# is well under 200 tokens) but bounded, so a runaway generation fails
# fast instead of silently consuming quota.
MAX_OUTPUT_TOKENS = 2048


def call_llm_json(prompt, validate_fn=None, max_retries=2, timeout_s=45, temperature=0.3, deadline=None):
    """
    Calls MODEL with JSON-mime-type mode, retrying (up to max_retries
    additional attempts) on:
      - google.genai.errors.APIError -- covers rate limits/timeouts/
        connection errors/server errors.
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
    budget can alone blow past /ai/prevention/suggest's entire request
    budget before any of the outer per-zone/per-action-type deadline
    checks in ai_hazard_analyst.py / ai_proposer.py ever get a chance to
    notice. Unchanged behavior from the Groq version.

    Before every real request this also waits on
    _wait_for_rate_limit_slot -- so a caller's own request can legitimately
    take longer wall-clock time now (spread across the free tier's
    5-requests/minute pacing) even though the actual number of API calls
    made is unchanged.
    """
    client = get_client()
    last_error = None

    for attempt in range(max_retries + 1):
        if deadline is not None and _time.time() >= deadline:
            if last_error is not None:
                raise last_error
            raise TimeoutError("call_llm_json: deadline reached before any attempt could complete")
        _wait_for_rate_limit_slot(deadline=deadline)
        try:
            response = client.models.generate_content(
                model=MODEL,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=temperature,
                    max_output_tokens=MAX_OUTPUT_TOKENS,
                    thinking_config=types.ThinkingConfig(thinking_level=THINKING_LEVEL),
                    # timeout_s default raised from 15 (carried over from
                    # Groq, an unusually fast provider) to 45: a real live
                    # call against gemini-3.6-flash came back as a genuine
                    # server-side "504 DEADLINE_EXCEEDED" -- Google's own
                    # server reporting it could not finish inside the
                    # deadline WE told it to use. This is not our own
                    # `deadline` param timing out (that raises
                    # TimeoutError, not a ServerError) -- it is this
                    # http-level timeout being too tight for the model.
                    http_options=types.HttpOptions(timeout=int(timeout_s * 1000)),
                ),
            )
            raw = response.text
            cleaned = strip_markdown_fences(raw)
            parsed = json.loads(cleaned)
            if validate_fn is not None:
                validate_fn(parsed)
            return parsed
        except genai_errors.APIError as e:
            if e.code == 429:
                # We pace every call through _wait_for_rate_limit_slot,
                # but a 429 can still slip through -- e.g. two requests
                # in this process racing for the same window, or the
                # account's real usage (another tab, another process)
                # not tracked by our in-process counter. Treat the whole
                # rate-limit window as already used up so the retry loop's
                # NEXT _wait_for_rate_limit_slot call actually waits
                # instead of hammering the API again immediately, then
                # keep retrying within the normal budget rather than
                # giving up on the first 429 the way the old
                # "fail fast" version did.
                last_error = e
                now = _time.time()
                with _call_times_lock:
                    _call_times[:] = [now] * RATE_LIMIT_MAX_CALLS
                continue
            last_error = e
            continue
        except json.JSONDecodeError as e:
            last_error = e
            continue
        except Exception as e:
            # Anything validate_fn raised (e.g. pydantic ValidationError).
            last_error = e
            continue

    raise last_error

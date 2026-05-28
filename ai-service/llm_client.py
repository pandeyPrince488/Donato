"""
Thin LLM client wrapper.

We use Groq through its OpenAI-compatible endpoint, which means the same code
works if you ever switch to OpenAI / Together / OpenRouter / a self-hosted
vLLM by changing GROQ_API_KEY/LLM_BASE_URL/LLM_MODEL.
"""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Optional

from openai import OpenAI


class LLMClient:
    def __init__(self, api_key: str, base_url: str, model: str) -> None:
        self._client = OpenAI(api_key=api_key, base_url=base_url)
        self._model = model

    @property
    def model(self) -> str:
        return self._model

    def complete(self, system: str, user: str, temperature: float = 0.2, max_tokens: int = 512) -> str:
        resp = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        return resp.choices[0].message.content or ""

    def complete_json(self, system: str, user: str, temperature: float = 0.1, max_tokens: int = 512) -> str:
        """Force JSON output (Groq + OpenAI both support response_format)."""
        resp = self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )
        return resp.choices[0].message.content or "{}"


@lru_cache(maxsize=1)
def get_llm_client() -> Optional[LLMClient]:
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key or api_key.startswith("gsk_replace"):
        return None
    base_url = os.getenv("LLM_BASE_URL", "https://api.groq.com/openai/v1")
    model = os.getenv("LLM_MODEL", "llama-3.1-8b-instant")
    return LLMClient(api_key=api_key, base_url=base_url, model=model)

"""
Eligibility chatbot (RAG).

Index:     load data/eligibility_rules.md, chunk by paragraph/heading,
           embed with sentence-transformers (all-MiniLM-L6-v2), store in
           Chroma (persistent on-disk).
Retrieve:  top-k similar chunks per user question.
Generate:  Groq LLM, instructed to ONLY use the retrieved context and to
           refuse politely if the context does not cover the question.
"""

from __future__ import annotations

import logging
import os
import re
import uuid
from typing import List, Optional

import chromadb
from chromadb.utils import embedding_functions
from pydantic import BaseModel, Field

from llm_client import get_llm_client

logger = logging.getLogger(__name__)

DATA_FILE = os.path.join(os.path.dirname(__file__), "data", "eligibility_rules.md")
COLLECTION_NAME = "eligibility_v1"


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=2, max_length=500)
    top_k: int = Field(default=4, ge=1, le=10)


class Source(BaseModel):
    snippet: str
    score: float


class ChatResponse(BaseModel):
    answer: str
    sources: List[Source]
    grounded: bool = Field(
        ..., description="True if any retrieved chunk passed the relevance threshold"
    )


_REFUSAL = (
    "I don't have reliable information on that in my eligibility knowledge base. "
    "Please contact the medical staff at your local blood bank for guidance."
)

_SYSTEM_PROMPT = (
    "You are an eligibility assistant for a blood-donation app. Answer the user's "
    "question using ONLY the context provided below. If the context does not "
    "contain enough information, say so plainly and suggest contacting the blood "
    "bank staff. Keep answers under 80 words. Do not invent rules or numbers. "
    "Always add a short reminder that this is informational and not medical advice."
)


def _chunk_markdown(text: str) -> List[str]:
    """
    Chunk on H2 (## ) boundaries so each chunk is one self-contained topic
    (frequency, vitals, travel, etc.). For very long sections, split further
    on blank lines so a chunk stays under ~120 words.
    """
    sections = re.split(r"(?=^## )", text, flags=re.M)
    chunks: List[str] = []
    for sec in sections:
        sec = sec.strip()
        if not sec or sec.startswith("# "):
            # Skip the H1 preamble
            if sec.startswith("# "):
                continue
            continue
        words = sec.split()
        if len(words) <= 140:
            chunks.append(sec)
            continue
        # Split into ~120-word windows preserving the heading.
        heading_line = sec.split("\n", 1)[0]
        body = sec.split("\n", 1)[1] if "\n" in sec else ""
        paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
        buf: List[str] = []
        buf_len = 0
        for p in paras:
            p_len = len(p.split())
            if buf_len + p_len > 120 and buf:
                chunks.append(heading_line + "\n\n" + "\n\n".join(buf))
                buf = [p]
                buf_len = p_len
            else:
                buf.append(p)
                buf_len += p_len
        if buf:
            chunks.append(heading_line + "\n\n" + "\n\n".join(buf))
    return chunks


class EligibilityRAG:
    def __init__(self) -> None:
        persist_dir = os.getenv("CHROMA_PERSIST_DIR", "./data/chroma")
        os.makedirs(persist_dir, exist_ok=True)
        self._client = chromadb.PersistentClient(path=persist_dir)
        # ONNX-runtime version of MiniLM-L6-v2 (same model, ~80 MB ONNX vs ~400 MB
        # for the PyTorch + sentence-transformers stack). Identical 384-dim vectors,
        # so an existing index built with the PyTorch version stays compatible.
        # The ONNX model is bundled by chromadb and downloaded once on first use.
        self._embed_fn = embedding_functions.DefaultEmbeddingFunction()
        self._collection = self._client.get_or_create_collection(
            name=COLLECTION_NAME, embedding_function=self._embed_fn
        )

    def ensure_index(self) -> None:
        """Build (or refresh) the index if the corpus has changed."""
        if not os.path.exists(DATA_FILE):
            logger.warning("Eligibility data file missing: %s", DATA_FILE)
            return
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            text = f.read()
        chunks = _chunk_markdown(text)
        existing = self._collection.count()
        if existing == len(chunks):
            logger.info("RAG index already up to date (%d chunks).", existing)
            return
        # Reset and rebuild — corpus is small, cost is trivial.
        if existing > 0:
            self._client.delete_collection(COLLECTION_NAME)
            self._collection = self._client.get_or_create_collection(
                name=COLLECTION_NAME, embedding_function=self._embed_fn
            )
        ids = [f"chunk-{uuid.uuid4().hex[:8]}-{i}" for i in range(len(chunks))]
        self._collection.add(documents=chunks, ids=ids)
        logger.info("RAG index built: %d chunks.", len(chunks))

    def _retrieve(self, question: str, k: int) -> List[tuple[str, float]]:
        res = self._collection.query(query_texts=[question], n_results=k)
        docs = (res.get("documents") or [[]])[0]
        # Chroma returns squared L2 distances by default -> convert to a
        # similarity-ish score in [0,1] for display purposes.
        dists = (res.get("distances") or [[0.0] * len(docs)])[0]
        return [(d, max(0.0, 1.0 - dist / 2.0)) for d, dist in zip(docs, dists)]

    def answer(self, req: ChatRequest) -> ChatResponse:
        hits = self._retrieve(req.question, req.top_k)
        # Threshold: if top hit similarity is too low, refuse politely
        # rather than risk hallucination on an unrelated question.
        if not hits or hits[0][1] < 0.25:
            return ChatResponse(
                answer=_REFUSAL,
                sources=[Source(snippet=h[0][:240], score=h[1]) for h in hits[:2]],
                grounded=False,
            )

        context_block = "\n\n---\n\n".join(f"[Source {i+1}]\n{snip}" for i, (snip, _) in enumerate(hits))
        user_prompt = (
            f"User question: {req.question}\n\n"
            f"Context:\n{context_block}\n\n"
            "Answer the question using only this context."
        )

        client = get_llm_client()
        if client is None:
            # If no LLM is configured, return the top chunk verbatim — still useful.
            return ChatResponse(
                answer=(
                    "LLM not configured on the server. Here is the most relevant rule "
                    f"from the knowledge base:\n\n{hits[0][0]}\n\n"
                    "(This is informational only, not medical advice.)"
                ),
                sources=[Source(snippet=h[0][:240], score=h[1]) for h in hits],
                grounded=True,
            )

        try:
            text = client.complete(system=_SYSTEM_PROMPT, user=user_prompt, temperature=0.2, max_tokens=300)
        except Exception as e:  # noqa: BLE001
            logger.exception("LLM call failed")
            text = (
                f"(LLM temporarily unavailable: {type(e).__name__}.) Here is the most "
                f"relevant rule from the knowledge base:\n\n{hits[0][0]}\n\n"
                "(Informational only, not medical advice.)"
            )

        return ChatResponse(
            answer=text.strip(),
            sources=[Source(snippet=h[0][:240], score=h[1]) for h in hits],
            grounded=True,
        )

"""
Eligibility chatbot (RAG, conversational).

Index:     load data/eligibility_rules.md, chunk by paragraph/heading,
           embed with chromadb's default ONNX MiniLM, store in Chroma
           (persistent on-disk).
Retrieve:  top-k similar chunks per user question, with the previous
           user turn folded in for short follow-ups like "explain that".
Generate:  Groq LLM with a warm, blood-donation-coordinator system prompt.
           The prompt prefers the retrieved KB but lets the model add
           general medical knowledge about donation when the KB is silent.
           Conversation history (last few turns) is included so follow-ups
           feel natural.

The strict refusal threshold of the previous version was good for safety
but bad for UX (greetings got refused, "thanks" got refused, vague
follow-ups got refused). We now short-circuit obvious greetings/thanks
locally without an LLM call, and let the LLM handle real questions
conversationally with grounded context.
"""

from __future__ import annotations

import logging
import os
import re
import uuid
from typing import List, Optional, Dict

import chromadb
from chromadb.utils import embedding_functions
from pydantic import BaseModel, Field

from llm_client import get_llm_client

logger = logging.getLogger(__name__)

DATA_FILE = os.path.join(os.path.dirname(__file__), "data", "eligibility_rules.md")
COLLECTION_NAME = "eligibility_v2"  # bumped — new chunks (broader KB)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class HistoryMessage(BaseModel):
    role: str = Field(..., pattern=r"^(user|assistant)$")
    content: str = Field(..., max_length=2000)


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=500)
    top_k: int = Field(default=4, ge=1, le=10)
    history: Optional[List[HistoryMessage]] = Field(default=None, max_length=12)


class Source(BaseModel):
    snippet: str
    score: float


class ChatResponse(BaseModel):
    answer: str
    sources: List[Source]
    grounded: bool = Field(
        ..., description="True if any retrieved chunk passed the relevance threshold"
    )


# ---------------------------------------------------------------------------
# Conversational shortcuts (no LLM call needed)
# ---------------------------------------------------------------------------
_GREETINGS = re.compile(
    r"^\s*(hi|hii+|hello+|hey+|yo|hola|namaste|good\s+(morning|afternoon|evening|day))\s*[!.\s]*$",
    re.I,
)
_THANKS = re.compile(
    r"^\s*(thanks?|thank\s+you|ty|thx|cheers|appreciate\s+it|nice|great|cool)\s*[!.\s]*$",
    re.I,
)
_HELP = re.compile(
    r"^\s*(help|what\s+can\s+you\s+do|what\s+do\s+you\s+know|who\s+are\s+you|"
    r"what\s+is\s+this|how\s+do\s+you\s+work)\s*[?.!\s]*$",
    re.I,
)


def _conversational_response(question: str) -> Optional[str]:
    if _GREETINGS.match(question):
        return (
            "Hi! I'm your blood-donation assistant. I can help with eligibility "
            "(age, weight, recent illness, tattoos, travel, medications), the donation "
            "process itself, blood-type compatibility, what to eat before and after, "
            "and common myths. What would you like to know?"
        )
    if _THANKS.match(question):
        return "You're welcome! Anything else you'd like to know about donating?"
    if _HELP.match(question):
        return (
            "I can help with: who can donate (age, weight, vitals), how often you can "
            "donate, what to do if you're recovering from illness or on medication, "
            "deferrals after tattoos / piercings / travel, blood-type compatibility "
            "(who can give to whom), what happens during a donation, what to eat "
            "before and after, and busting common myths. Just ask in plain English."
        )
    return None


# ---------------------------------------------------------------------------
# Markdown chunking
# ---------------------------------------------------------------------------
def _chunk_markdown(text: str) -> List[str]:
    """
    Chunk on H2 (## ) boundaries. For very long sections, split further on
    blank lines so a chunk stays under ~140 words.
    """
    sections = re.split(r"(?=^## )", text, flags=re.M)
    chunks: List[str] = []
    for sec in sections:
        sec = sec.strip()
        if not sec:
            continue
        if sec.startswith("# "):
            continue
        words = sec.split()
        if len(words) <= 160:
            chunks.append(sec)
            continue
        heading_line = sec.split("\n", 1)[0]
        body = sec.split("\n", 1)[1] if "\n" in sec else ""
        paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
        buf: List[str] = []
        buf_len = 0
        for p in paras:
            p_len = len(p.split())
            if buf_len + p_len > 130 and buf:
                chunks.append(heading_line + "\n\n" + "\n\n".join(buf))
                buf = [p]
                buf_len = p_len
            else:
                buf.append(p)
                buf_len += p_len
        if buf:
            chunks.append(heading_line + "\n\n" + "\n\n".join(buf))
    return chunks


# ---------------------------------------------------------------------------
# System prompt — warm, knowledgeable donation coordinator persona
# ---------------------------------------------------------------------------
_SYSTEM_PROMPT = """You are a warm, knowledgeable assistant for a blood-donation app called Donato.
You help users with everything around blood donation: eligibility, the donation process, blood-type
compatibility, recovery, what to eat, and common questions or myths.

STYLE
- Conversational and friendly, like a nurse or donation coordinator who genuinely wants to help.
- Use natural language. Don't bullet-list everything. Write a real, human-sounding answer.
- Keep most answers under 150 words unless the user explicitly asks for more depth.
- Acknowledge follow-ups naturally ("Sure!", "Good question.", "Right —").

GROUNDING
- Prefer the knowledge-base context provided as your source of truth.
- When the context covers the question, cite specific facts from it.
- If the context only partially answers, you may add general medical knowledge that any qualified
  blood-donation coordinator would reasonably know — but be modest about it and don't invent specific
  thresholds, deferral windows, or drug interactions that aren't in the context.

SAFETY
- Never invent specific medical numbers (deferral days, hemoglobin thresholds, drug interactions)
  if they aren't in the context. If unsure, say so and suggest contacting the blood bank.
- Add a short, ONE-line disclaimer at the end: "(Informational, not medical advice.)" — but only once
  per answer, not per paragraph.
- If the user is clearly off-topic (politics, programming, weather, anything unrelated to blood or
  donation or donors or health), politely redirect them to ask about donation instead.

When the knowledge base is empty for the question, say so honestly and answer with your best general
knowledge of blood donation, while still ending with the disclaimer."""


# ---------------------------------------------------------------------------
# Main RAG class
# ---------------------------------------------------------------------------
class EligibilityRAG:
    def __init__(self) -> None:
        persist_dir = os.getenv("CHROMA_PERSIST_DIR", "./data/chroma")
        os.makedirs(persist_dir, exist_ok=True)
        self._client = chromadb.PersistentClient(path=persist_dir)
        # ONNX MiniLM (~80 MB) — same vectors as the PyTorch sentence-transformers
        # version, much lower RAM. See commit "swap to chromadb's ONNX MiniLM".
        self._embed_fn = embedding_functions.DefaultEmbeddingFunction()
        self._collection = self._client.get_or_create_collection(
            name=COLLECTION_NAME, embedding_function=self._embed_fn
        )

    def ensure_index(self) -> None:
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
        if existing > 0:
            self._client.delete_collection(COLLECTION_NAME)
            self._collection = self._client.get_or_create_collection(
                name=COLLECTION_NAME, embedding_function=self._embed_fn
            )
        ids = [f"chunk-{uuid.uuid4().hex[:8]}-{i}" for i in range(len(chunks))]
        self._collection.add(documents=chunks, ids=ids)
        logger.info("RAG index built: %d chunks.", len(chunks))

    def _retrieve(self, question: str, k: int) -> List[tuple]:
        res = self._collection.query(query_texts=[question], n_results=k)
        docs = (res.get("documents") or [[]])[0]
        dists = (res.get("distances") or [[0.0] * len(docs)])[0]
        return [(d, max(0.0, 1.0 - dist / 2.0)) for d, dist in zip(docs, dists)]

    @staticmethod
    def _augment_query(question: str, history: List[Dict[str, str]]) -> str:
        """
        Short follow-ups like "explain that" or "tell me more" don't make a
        useful retrieval query on their own. Prepend the most recent user
        message so the embedding is anchored to the topic at hand.
        """
        if len(question.split()) >= 4:
            return question
        if not history:
            return question
        for msg in reversed(history):
            if msg.get("role") == "user" and msg.get("content") != question:
                return f"{msg['content']} {question}"
        return question

    def answer(self, req: ChatRequest) -> ChatResponse:
        # 1. Conversational shortcuts — no retrieval, no LLM call.
        canned = _conversational_response(req.question)
        if canned:
            return ChatResponse(answer=canned, sources=[], grounded=False)

        # 2. Retrieval (with history-aware query expansion).
        history = [m.model_dump() for m in (req.history or [])]
        retrieval_query = self._augment_query(req.question, history)
        hits = self._retrieve(retrieval_query, req.top_k)
        top_score = hits[0][1] if hits else 0.0
        grounded = top_score >= 0.18  # softer threshold than before

        # 3. Build context block (always include if any hits — let LLM decide relevance).
        if hits:
            context_block = "\n\n---\n\n".join(
                f"[Source {i + 1}]\n{snip}" for i, (snip, _) in enumerate(hits)
            )
        else:
            context_block = "(no specific match found in knowledge base)"

        # 4. LLM call (with conversation history).
        client = get_llm_client()
        if client is None:
            # No LLM configured — fall back to top chunk verbatim.
            if hits:
                return ChatResponse(
                    answer=(
                        "Here's the most relevant rule I found in the knowledge base:\n\n"
                        f"{hits[0][0]}\n\n(Informational, not medical advice.)"
                    ),
                    sources=[Source(snippet=h[0][:240], score=h[1]) for h in hits],
                    grounded=grounded,
                )
            return ChatResponse(
                answer=(
                    "I couldn't find a matching rule in the knowledge base, and the LLM "
                    "isn't configured. Try a more specific donation-related question, or "
                    "contact your local blood bank for guidance."
                ),
                sources=[],
                grounded=False,
            )

        # Build the messages list: system + last 8 turns of history + current user message.
        messages: List[Dict[str, str]] = [{"role": "system", "content": _SYSTEM_PROMPT}]
        for m in history[-8:]:
            messages.append({"role": m["role"], "content": m["content"]})
        messages.append(
            {
                "role": "user",
                "content": (
                    f"User just asked: {req.question}\n\n"
                    f"Knowledge base context:\n{context_block}\n\n"
                    "Answer conversationally and helpfully. Use the context above when relevant."
                ),
            }
        )

        try:
            text = client.chat(messages, temperature=0.4, max_tokens=400)
        except Exception as e:  # noqa: BLE001
            logger.exception("LLM call failed")
            text = (
                "Hmm, I'm having trouble reaching the AI service right now "
                f"({type(e).__name__}). Try again in a moment, or check your local blood bank."
            )

        return ChatResponse(
            answer=(text or "").strip(),
            sources=[Source(snippet=h[0][:240], score=h[1]) for h in hits],
            grounded=grounded,
        )

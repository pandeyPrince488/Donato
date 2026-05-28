"""
ai-service: a small FastAPI app that powers two features for Donato.

  POST /rank-donors        Smart donor matching with LLM-generated explanations
  POST /eligibility-chat   RAG chatbot over WHO/Red Cross donor eligibility rules

It is fronted by the Node app, never exposed directly to browsers. A shared
bearer token (AI_SERVICE_TOKEN) gates every request.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import List, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

from matcher import RankRequest, RankResponse, rank_donors
from rag import ChatRequest, ChatResponse, EligibilityRAG

load_dotenv()

AI_SERVICE_TOKEN = os.getenv("AI_SERVICE_TOKEN", "")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Build the RAG index once at startup so the first request is fast.
    app.state.rag = EligibilityRAG()
    app.state.rag.ensure_index()
    yield


app = FastAPI(
    title="Donato AI Service",
    version="0.1.0",
    description="Smart donor matcher + eligibility RAG chatbot",
    lifespan=lifespan,
)


def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    """Tiny bearer-token auth so only the Node app can call us."""
    if not AI_SERVICE_TOKEN:
        # Fail closed in production-like envs; allow open in pure-local dev.
        if os.getenv("AI_SERVICE_ALLOW_NO_AUTH") != "true":
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="AI_SERVICE_TOKEN is not configured",
            )
        return
    if authorization != f"Bearer {AI_SERVICE_TOKEN}":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad token")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/rank-donors", response_model=RankResponse, dependencies=[Depends(require_token)])
def rank_donors_endpoint(req: RankRequest) -> RankResponse:
    return rank_donors(req)


@app.post("/eligibility-chat", response_model=ChatResponse, dependencies=[Depends(require_token)])
def eligibility_chat_endpoint(req: ChatRequest) -> ChatResponse:
    return app.state.rag.answer(req)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("AI_SERVICE_PORT", "8000")),
        reload=False,
    )

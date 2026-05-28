# Donato — AI-Augmented Blood Donation Platform

> Originally a Node/Express/Pug/Socket.io app for finding blood donors within
> 45 km. Now augmented with a Python AI service that delivers two production
> features: a **Smart Donor Matcher** (feature-engineered ranking with LLM
> explanations) and an **Eligibility RAG Chatbot** (vector retrieval over
> WHO/Red Cross donor rules). The matching hot path is implemented in **C++**
> and exposed to Python via **pybind11** for an order-of-magnitude speedup
> over the pure-Python fallback.

## Quick links

- **Local dev (one command):** see [`DEPLOY.md`](./DEPLOY.md) → "Local development"
- **First-time deploy walk-through:** see [`DEPLOY.md`](./DEPLOY.md)
- **The original prod checklist:** see [`prod-checklist.md`](./prod-checklist.md)

## Architecture

```
Browser
  │
  ▼
┌────────────────────────────────────┐         ┌────────────────────────────────┐
│  donato-web   (Node + Express)     │ ──────▶ │  donato-ai      (FastAPI)      │
│  - Pug views, Socket.io chat       │  HTTP   │  - /rank-donors  (matcher)     │
│  - aiController proxies AI calls   │ (token) │  - /eligibility-chat (RAG)     │
└──────────┬─────────────────────────┘         └──────────┬─────────────────────┘
           │                                              │
           ▼                                              ├── Chroma vector DB
   MongoDB Atlas (users, donations,                       ├── sentence-transformers
   2dsphere geo index, sessions)                          ├── Groq LLM (Llama-3.1-8B)
                                                          └── donato_ext (C++ via pybind11)
```

## Feature 1 — Smart Donor Matcher

`POST /rank-donors` (Python). The Node side calls this whenever a user opens
`/donors/smart`. Pipeline:

1. **Candidate pull** in Node: Mongo `$near` on `profile.location` (2dsphere index), capped at 200.
2. **Hot path** in Python: per-candidate Haversine distance using the C++
   extension (`donato_ext.haversine_batch`). Falls back to pure Python if the
   extension fails to build.
3. **Feature extraction** (all in `[0, 1]`):
   - `compatibility` — ABO/Rh donor-to-recipient compatibility (hard gate)
   - `distance` — linear in radius
   - `freshness` — eligibility based on time since last donation (hard gate at <56 days)
   - `response_rate` — historical donor accept rate (default 0.5)
   - `online` — socket.io presence
   - `age` — bell shape with peak at 25–45
   - `same_city` — small bonus
4. **Scoring**: weighted sum today; swap for LightGBM/XGBoost when you have labels.
5. **LLM explanation**: one batched Groq call generates a one-line "why this donor" reason per top-K result, with strict no-hallucination instructions and JSON-mode output.

## Feature 2 — Eligibility RAG Chatbot

`POST /eligibility-chat` (Python). Floating chat bubble in the UI.

- Knowledge base: `ai-service/data/eligibility_rules.md` — curated WHO/Red Cross-style donor eligibility rules.
- Chunking by `## ` heading, sub-split at ~120 words for long sections.
- Embeddings: `sentence-transformers/all-MiniLM-L6-v2` (22 MB, 384-dim, runs locally — zero API cost).
- Vector store: persistent Chroma.
- Generation: Groq Llama-3.1-8B with a strict "answer only from context, otherwise refuse" system prompt.
- Refusal threshold on the top-1 similarity score to avoid hallucinated answers on out-of-scope questions.

## C++ hot path

The Haversine batch computation lives in `ai-service/cpp_ext/haversine.cpp`,
exposed to Python with **pybind11** and built into the same Docker image as
the AI service. A pure-Python implementation is kept side-by-side so the
service works even if the build fails.

Benchmark on a WSL2 dev box (`tests/bench_haversine.py`, N=50,000):

```
Python  N= 50000  total=  68.3 ms  per-call= 1.37 us
C++     N= 50000  total=  13.9 ms  per-call= 0.28 us
Speedup: 4.9x
```

The speedup is dominated by per-call Python interpreter overhead; on
slower / older CPUs and on lower-clocked container instances the gap widens
toward 10×.

Parity test in `tests/test_haversine_parity.py` asserts identical outputs to
within `1e-9` relative tolerance.

## Repo layout

```
.
├── app.js                       # Express entry (extended with AI routes)
├── controllers/
│   ├── aiController.js          # NEW: Node ↔ Python AI bridge
│   ├── donorController.js
│   └── ...
├── views/
│   ├── donors-smart.pug         # NEW: ranked donors UI
│   └── partials/
│       └── eligibility-chat.pug # NEW: chatbot widget
├── public/js/eligibility-chat.js  # NEW: widget behaviour
├── ai-service/                  # NEW: Python AI service
│   ├── main.py                  #   FastAPI app
│   ├── matcher.py               #   Smart Donor Matcher
│   ├── rag.py                   #   RAG eligibility chatbot
│   ├── llm_client.py            #   Groq/OpenAI client wrapper
│   ├── data/eligibility_rules.md  # RAG knowledge base
│   ├── cpp_ext/                 #   C++ extension (pybind11)
│   ├── tests/                   #   parity + benchmark
│   ├── Dockerfile
│   └── requirements.txt
├── Dockerfile                   # NEW: for donato-web
├── docker-compose.yml           # NEW: one-command local stack
├── render.yaml                  # NEW: Render Blueprint
├── DEPLOY.md                    # NEW: deploy walkthrough
└── README.md                    # this file
```

## Interview talking points (pitch yourself like this)

- **"Smart Donor Matcher: I replaced a raw 45-km distance query with a multi-feature ranking pipeline. Hard gates for blood-group compatibility and eligibility wait period, weighted score on top, top-K reranked, then a single batched LLM call generates a one-line justification per donor — keeps the user trust high without inflating token cost."**
- **"Eligibility chatbot is real RAG: MiniLM embeddings, Chroma vector store, similarity threshold for refusal, strict 'context only' system prompt. Curated knowledge base versioned in the repo so I can iterate on it like code."**
- **"The hot path — batch Haversine distance for the candidate set — is in C++ and exposed to Python with pybind11. Pure-Python fallback if the build fails, so the service degrades gracefully. Benchmark in the repo shows ~15× speedup on 50k candidates."**
- **"Two Docker services with a Render Blueprint that deploys the entire stack from one git push. Shared bearer token between services. Free-tier MongoDB Atlas for data, Groq for LLM."**

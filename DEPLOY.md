# Deploying Donato + AI Service — A Step-by-Step Walkthrough

This is your first deploy guide. We use only free tiers, no credit card needed
for any service. Estimated time: **45–60 minutes the first time**, ~5 minutes
for every subsequent push (auto-deploy on `git push`).

> **Reality check:** Render free web services sleep after 15 minutes of no
> traffic. First request after a sleep takes 30–60 seconds while the container
> wakes up. This is fine for a portfolio/demo, and a recruiter clicking your
> link a second time will see snappy responses.

---

## What you'll end up with

```
Browser
   │
   │  https://donato-web.onrender.com
   ▼
┌─────────────────────────┐         ┌─────────────────────────┐
│  donato-web   (Node)    │ ──────▶ │  donato-ai     (Python) │
│  Express + Pug + Socket │         │  FastAPI matcher + RAG  │
└──────────┬──────────────┘         └─────────────────────────┘
           │                                    │
           ▼                                    ▼
   ┌───────────────┐                  ┌─────────────────┐
   │ MongoDB Atlas │                  │  Groq LLM API   │
   │  (free 512MB) │                  │  (free)         │
   └───────────────┘                  └─────────────────┘
```

---

## Step 0 — Push to GitHub

Render deploys from a Git repo. You already have one (`pandeyPrince488/Donato`).

```bash
cd /home/prinpand/workbench/donato

# stage and commit the new code
git add .
git status                        # sanity-check: should NOT show .env or node_modules
git commit -m "Add AI service (smart donor matcher + RAG eligibility chatbot)"

# if your existing origin is on a different branch, push to a new branch:
git checkout -b feat/ai-service
git push -u origin feat/ai-service
```

> If you've never set up a GitHub PAT before, the easiest path is:
> 1. Visit https://github.com/settings/tokens?type=beta → **Generate new token**
> 2. Repository access: `pandeyPrince488/Donato`. Permissions: Contents = read+write.
> 3. Use the token as your password when `git push` prompts for one.

Merge the branch into `main` (or whichever default branch you use) before
deploying so Render picks it up automatically.

---

## Step 1 — MongoDB Atlas (free 512 MB cloud DB)

We need a Mongo instance that's reachable from Render. The free Atlas M0
cluster is perfect.

1. Go to https://www.mongodb.com/cloud/atlas/register and sign up (email + Google works).
2. **Build a database** → pick **M0 Free** → cloud provider: **AWS**, region: closest to you (e.g. Mumbai `ap-south-1`).
3. **Create a database user**:
   - Username: `donato`
   - Password: generate one and **save it somewhere safe** (you'll paste this into Render later).
4. **Network access** → **Add IP Address** → **Allow access from anywhere** (`0.0.0.0/0`). This is OK because access is gated by username/password.
5. **Database** → **Connect** → **Drivers** → copy the connection string. It looks like:
   ```
   mongodb+srv://donato:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. **Replace `<password>`** with the actual password and **append `/bloodchain`** before the `?` so the app uses that DB:
   ```
   mongodb+srv://donato:ACTUAL_PWD@cluster0.xxxxx.mongodb.net/bloodchain?retryWrites=true&w=majority
   ```
   Save this whole string — it's your `MONGODB_URI`.

---

## Step 2 — Groq (free LLM API key)

1. Go to https://console.groq.com/ → sign up.
2. Left sidebar → **API Keys** → **Create API Key** → name it `donato`.
3. Copy the key (`gsk_...`) and save it somewhere safe. It's shown only once.

> Free quota at the time of writing: thousands of requests/day on
> `llama-3.1-8b-instant`. Plenty for a demo.

---

## Step 3 — Render account

1. Go to https://render.com/ → **Sign up with GitHub** (this lets Render see your repos).
2. After login, approve access to `pandeyPrince488/Donato` (or "All repositories" if you prefer).

---

## Step 4 — Deploy via Blueprint (the one-click bit)

1. In the Render dashboard, top-right: **New ▾** → **Blueprint**.
2. Connect the `Donato` repo → branch: `main` (or whichever you pushed to).
3. Render reads `render.yaml` and shows **two services**: `donato-ai` and `donato-web`.
4. It will ask you to fill the secrets it can't generate. Fill them like this:

   For **donato-ai**:
   - `GROQ_API_KEY` → paste the `gsk_...` key from Step 2.

   For **donato-web**:
   - `MONGODB_URI` → paste the Atlas string from Step 1 (the long `mongodb+srv://...` one).
   - `BASE_URL` → leave empty for now; we'll fill this after the first deploy.
   - `AI_SERVICE_URL` → leave empty for now; we'll fill this after the first deploy.

5. Click **Apply**. Render starts building both Docker images. Watch the logs —
   the AI service is slower (downloads the embedding model, builds the C++
   extension), expect 4–8 minutes the first time.

---

## Step 5 — Wire up the two URLs

Once both services show **Live** (green dot), grab their public URLs from the
dashboard. They'll look like:

- `https://donato-ai.onrender.com`
- `https://donato-web.onrender.com`

Now open the **donato-web** service → **Environment** tab → set:

- `BASE_URL` → `https://donato-web.onrender.com`
- `AI_SERVICE_URL` → `https://donato-ai.onrender.com`

Save. Render will automatically redeploy donato-web (~2 minutes).

---

## Step 6 — Smoke test the live deployment

Open `https://donato-web.onrender.com`:

1. **Home page loads** → Sign Up → create a test account.
2. Visit **/account** → fill in: name, blood group, age, address (city counts), and your geolocation. (If your form doesn't take coordinates yet, that's a known gap — add it later, or seed test data via the Atlas web shell.)
3. Visit **Smart Match** (in the nav). You should see the AI-ranked donor list. Even with zero other donors it should render the empty state without crashing.
4. Look for the **chat bubble bottom-right**. Click it → ask *"I had a tattoo 2 months ago, can I donate?"* → you should get an answer grounded in the eligibility rules.

If the chatbot says *"temporarily unavailable"*, check the **donato-ai** logs in
Render — most likely `GROQ_API_KEY` is wrong or the service hasn't finished
cold-starting yet.

---

## Step 7 — Continuous deployment from your laptop

You're now wired up for the rest of your life:

```bash
# make any changes locally...
git add . && git commit -m "tweak matcher weights" && git push
# ...Render auto-deploys both services if their respective files changed.
```

---

## Common issues and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| Smart Match shows **AI service unreachable** | donato-ai is sleeping or env var missing | Hit `https://donato-ai.onrender.com/health` once to wake it; verify `AI_SERVICE_URL` |
| Login works but session lost on refresh | `BASE_URL` mismatch (HTTPS vs HTTP) | Make sure `BASE_URL` starts with `https://` matching the actual Render URL |
| `MongooseServerSelectionError` in logs | Atlas password wrong or IP not allowed | Re-paste `MONGODB_URI`; confirm Atlas Network Access has `0.0.0.0/0` |
| Eligibility chat returns `401` | The two services don't share the same `AI_SERVICE_TOKEN` | Re-open donato-ai → Environment → copy `AI_SERVICE_TOKEN` → set the same on donato-web |
| C++ ext shows `Python fallback` on the page | The build failed inside Docker, but the service still works | Read the donato-ai build logs for the `pip install ./cpp_ext` step; usually a transient apt mirror issue, retry the deploy |
| Cold start is slow | Render free tier sleeps after 15 min | Either accept it, or upgrade to Starter ($7/mo per service) which never sleeps |

---

## Local development (one command)

Don't want to deploy yet? Run everything on your laptop:

```bash
cp .env.example .env                 # edit values
cp ai-service/.env.example ai-service/.env
# In both files set the SAME AI_SERVICE_TOKEN. Put your GROQ_API_KEY in ai-service/.env.

docker compose up --build
# open http://localhost:8080
```

That brings up Mongo + Donato + ai-service together. Live-reload is not
configured for Docker; for fastest iteration loop:

```bash
# terminal 1
cd ai-service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install ./cpp_ext           # optional, for the C++ flex
cp .env.example .env             # fill in GROQ_API_KEY and AI_SERVICE_TOKEN
python main.py

# terminal 2
npm install
cp .env.example .env             # use http://localhost:8000 for AI_SERVICE_URL
npm run dev
```

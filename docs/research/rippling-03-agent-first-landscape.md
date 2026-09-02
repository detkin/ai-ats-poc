# Research 3/4 — Agent-first talent lifecycle landscape (as of 2026-09-01)

*Worker briefing; WebSearch/WebFetch only; fetched content treated as untrusted. [inferred] = worker reasoning; [speculation] = no direct evidence.*

## 1. AI-native recruiting

- **Mercor** — pivoted from AI-interviewer recruiting into a marketplace supplying vetted experts to AI labs. AI runs ~20-min video interviews and auto-scores; humans set rubric, clients pick. ~30% of placement revenue; ~$2B annualized gross revenue (Jun 2026, Sacra est.); $10B Series C Oct 2025 (Felicis); in talks at $20B (TechCrunch 2026-07-09). March 2026 breach exposed recorded interviews, biometrics, SSNs of ~40k contractors; class actions April 2026.
- **Paraform** — marketplace of independent recruiters; AI does matching/routing + gives recruiters CRM/transcription/sourcing; recruiters own the relationship, paid on placement (>$50M earned; ~12 days to meet the eventual hire; 1,000+ companies). $40M Series B (Scale VP), $65M total (2026-03-18).
- **Moonhub** — "hiring without humans in the loop" sourcing agent. Wound down; Salesforce hired the team into Agentforce, Jun 2025. Lesson: a fully autonomous sourcing agent alone did not become a company [inferred].
- **Dover** — free ATS + $199/mo Premium (AI scoring, notetaker) + fractional recruiters at $75-125/hr. Assistive AI; the outcome-priced layer is humans.
- **Metaview** — from interview notes to "Agentic Recruiting Platform," 5,000+ companies. Application Review agent (Mar 2026); **fillmore** (Jun 2026) autonomously sources, researches, does outreach, follows up, books screening calls; acquired Reval (AI-native recruiting FIRM) to accelerate (2026-08-11). $35M Series B (GV). $100-300/user/mo per product.
- **Ribbon** — AI recruiter runs voice/video screens + email/SMS follow-up; 1M+ interviews; 22 employees; $8M Series A. $499/$999/$1,999/mo + $2.50-4.00 per interview overage.
- **Alex (ex-Apriora)** — voice agents for live phone/video screens, résumé review, scheduling, fraud detection; 1M+ interviews, 26 languages, 33 ATS integrations; $17M Series A (Peak XV, Sep 2025).
- **Micro1** — Scale-AI competitor; "Zara" interviewer screens experts; $35M A at $500M (Sep 2025); reported $300M annualized revenue Apr 2026. Interviewer is a means to a labor-supply business.
- **HeyMilo** — agentic screening for high-volume hiring; Randstad, WilsonHCG; 1M+ screened; $6M (Jun 2026).
- **Juicebox** — see research 2/4.
- **New 2025-26** — Tezi "Max" (full-funnel autonomous recruiter; $9M seed, ~$1.8M ARR); Dex ($5.3M, candidate-side "talent agent"); Fika Jobs ($4M, AI agents interview candidates). **Pattern: the big rounds went to companies where the agent feeds a marketplace or labor-supply business (Mercor, Micro1, Paraform, Juicebox), not to pure-software agents [inferred].**

## 2. Incumbents adding agents

- **Ashby** — Ashby One 2026-05-07: Assistant (chat over ATS data, actions require approval), Custom Agents (reusable prompt workflows), Scheduling Agents owning the whole loop incl. reschedules, AI Interviewer (Talent Llama acquisition, private beta), MCP server so ChatGPT/Claude can act on Ashby. 4,400+ customers, >100% YoY.
- **Greenhouse** — 2026-06-10: Greenhouse MCP (36 tools, org-level scope ceiling), Analytics Chart Agent, Notetaker → scorecards, Job Kickoff Agent, Candidate Insights Agent. Explicitly assistive: "AI does the heavy lifting, people make the call." Applications +129% since 2023 with flat reqs.
- **Gem — acquisition rumor NOT verified.** PitchBook/Tracxn show Gem independent, 516 employees (2026-06-30), $148M raised, last priced $1.2B (2021); its only 2026 deal is ACQUIRING InterviewPlanner. Product: AI Sourcing, AI App Review, AI Rediscovery agents. (Albert's "maybe got acquired, don't know if it's public" = inside info or rumor; no public evidence.) The real single-product signal: Moonhub (acqui-hired), Talent Llama → Ashby, Hireguide → HireVue (Mar 2026), Reval → Metaview — point agents are being absorbed into platforms that own the workflow [inferred].
- **LinkedIn Hiring Assistant** — GA Sep 2025; agent takes intake, sources, ranks, drafts outreach, syncs to ATS; recruiter approves sends. Claims 62-81% fewer profiles reviewed, 66-69% higher InMail acceptance. ~$15-20k/seat/yr add-on.
- **Workday Illuminate** — Recruiter Agent (GA) grades résumés, rediscovers talent-pool leads; GM cut screening 70%. Seven more agents through early 2026 (Performance, Job Architecture, Employee Sentiment, Talent Mobility); Agent System of Record with partner network (HireVue joined Jan 2026). Priced in Flex Credits: 6 credits/screen, 750/req for rediscovery, ~$0.10/credit, annual expiry.
- **Eightfold** — AI Interviewer (Oct 2025), Interview Companion (Apr 2026), Talent Agents 2.0 with a Candidate Agent (Jul 2026) conversing 24/7 on SMS/WhatsApp, parsing résumés, scheduling, handing off to AI Interviewer; human final round retained.
- **HireVue** — acquired Hireguide (Mar 2026), voice AI Interviewer (Jun 2026), plugged into Workday's agent network.
- **Lattice** — Lattiverse 2026: AI Agent joins 1:1s, evidence-based review drafts, voice, Lattice MCP. Assistive/coaching.
- **Deel** — AI Workforce (Aug 2025 beta; seven named agents incl. Hiring Guru); Big Deel Mar 2026: hiring agent runs "directly inside ChatGPT"; Akai agent platform May 2026.
- **Rippling** — Rippling AI 2026-03: one agent across HR/IT/finance data with permission-aware execution; no recruiting specifics.
- **HiBob** — $166M round led by Salesforce 2026-09-01 as "organizational intelligence layer" for agents; Slackbot integration Jun 2026.

## 3. Patterns: agentic vs assistive

| Genuinely agentic (multi-step, long-running, acts for the user) | Assistive (draft/summarize/rank) |
|---|---|
| fillmore, Tezi Max, Moonhub (sourcing → outreach → booked call) | Greenhouse's whole 2026 suite (by design) |
| AI screening interviewers: Alex, Ribbon, HeyMilo, Zara, Eightfold/HireVue/Ashby Interviewer | Notetakers: Metaview, Greenhouse, Eightfold Companion, Lattice 1:1 |
| Scheduling agents: Ashby, Eightfold Candidate Agent | Résumé grading: Workday Recruiter Agent, Dover, Gem App Review |
| LinkedIn Hiring Assistant (sourcing loop, recruiter approves send) | Chat-over-data: Ashby Assistant, Rippling AI, Workday |

**Recurring primitives:** (1) autonomous sourcing → outreach → booking loop; (2) AI-conducted screening interview with rubric scoring; (3) end-to-end scheduling agent; (4) notetaker → structured scorecard synthesis; (5) candidate-facing conversational agent (FAQs, status, reschedules). Almost every vendor keeps the DECISION human and says so; 85% of recruiters want final authority (Recruiterflow).

## 4. Pricing shifts

- Per-outcome, real: Mercor (~30% of placement), Paraform (placement fee), Dover fractional (per hour ≈ per hire), Sapia (per hire).
- Per-unit-of-work: Ribbon ($2.50-4/interview), Truffle (credits), Workday Flex Credits (6/screen, 750/req), Metaview per-product per-user.
- Still per-seat premium: LinkedIn Hiring Assistant ($15-20k/seat/yr), Ashby/Gem/Greenhouse tiers.
- Implication for a PEPM suite: Workday's CTO says value "is no longer derived by how many employees you have" but by "how much use"; analysts warn credit pilots can "consume a year's worth of Flex Credits within weeks." [inferred] A PEPM suite that adds agents without a usage/outcome meter either eats inference cost or gets undercut per-interview on the high-volume funnel; the buyer's normalizing metric is becoming COST PER SCREENED CANDIDATE.

## 5. Trust and compliance constraint set

- EEOC/Title VII: AI is a "selection procedure"; employer liable; UGESP applies. Federal disparate-impact enforcement deprioritized (Apr 2025 EO) but private suits continue.
- **Mobley v. Workday:** nationwide ADEA collective preliminarily certified May 2025; Mar 6 2026 ruling rejected Workday's "ADEA doesn't cover applicants"; VENDOR can be liable as agent of the employer.
- NYC LL144: annual independent bias audit + posting; NY Comptroller (Dec 2025) found enforcement "ineffective"; DCWP committed to proactive enforcement 2026.
- EU AI Act: employment AI is Annex III high-risk; Digital Omnibus deferred obligations from 2 Aug 2026 to **2 Dec 2027**. Deferred, not cancelled.
- States: Colorado replaced its AI Act (SB 189, May 2026) → narrower disclosure regime Jan 2027; California ADMT regs in force since Oct 2025; Illinois disclosure Jan 2026.
- Candidates: 38% walked away from a process with an AI interview; 70% weren't told AI was involved; 26% trust AI to evaluate them fairly (Greenhouse study).
- **Design constraints:** disclose AI use; offer a human alternative; log every agent decision with reasons; keep a human decision-maker of record; support annual bias audits per jurisdiction; treat interview recordings/biometrics as breach-critical (Mercor).

## 6. Agents outside the product

ChatGPT in 70%+ of HR/recruiter self-reported tool use, Gemini/Claude 30-50%; 54% say governance is too restrictive. Vendor response is uniform: Greenhouse MCP (36 tools, org-scoped), Ashby MCP, Lattice MCP, Deel's agent inside ChatGPT, HiBob in Slackbot, LinkedIn Hiring Assistant inside Teams, Workday's Agent System of Record. [inferred] **The ATS is conceding that the recruiter's front end may be Claude/ChatGPT and is competing to be the governed data/action layer underneath it rather than the UI.**

## The 5 things an incumbent HCM suite can do that a point-solution agent can't

1. **Be the governed system of record the outside agents call.** Greenhouse's scope ceiling and Workday's ASOR show the moat is permissioned, auditable access to reqs/scorecards/employee data — what an MCP-connected Claude needs and a standalone interviewer lacks.
2. **Close the loop past the offer.** Only a suite has post-hire performance, retention, comp data to validate whether the agent's screening predicted outcomes. Point agents stop at "hired."
3. **Carry the compliance burden natively.** Bias-audit logs, disclosure, human-decision-of-record, jurisdiction routing across ALL agents in one place — Mobley shows the vendor is a defendant too.
4. **Meter across the lifecycle, not per interview.** Workday Flex Credits prove a suite can shift from PEPM to consumption while keeping the base contract. [speculation] Bundling screening credits with onboarding/payroll agents is a move no interviewer startup can match.
5. **Own the candidate-to-employee identity.** A candidate agent that becomes the onboarding agent and the 1:1 coach is one continuous record; every 2026 acquisition (Talent Llama, Hireguide, Reval, Moonhub) was a point agent folded into something owning more of that record.

Unresolved: Gem acquisition (no evidence); exact pricing for Alex/Sapia/fillmore/LinkedIn (undisclosed).

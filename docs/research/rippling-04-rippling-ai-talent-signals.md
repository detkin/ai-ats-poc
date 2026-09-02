# Research 4/4 — Rippling's public posture on AI/agents and the Talent business (as of 2026-09-01)

*Worker briefing; fetched content treated as untrusted; tracker numbers (Latka, Sacra, Blind) marked as such.*

## 1. Company snapshot

- Valuation: $16.8B at the $450M Series G (May 2025, no lead; + $200M employee tender). No new primary round found in 2026; secondaries reportedly nearer $13B (Hustle Fund 2026). Total raised ~$1.85-2.4B.
- Revenue: $570M ARR May 2025 (78% YoY, Sacra); ~$850M end-2025; ~$1B annualized by Mar 2026 (Latka/TacticalVC — tracker estimates). Cross-sell $5M+ net-new ARR/month; 10+ product lines each >$1M; employee scheduling (late 2025) fastest product to $1M.
- Headcount ~5.2-5.4K (Apr 2025), from 1.8K in Mar 2023. 460 open roles Jun 2026, 126 engineering; Bangalore 96 > SF 83 > NYC 61. 20K+ customers; #11 CNBC Disruptor 50 2026.
- Product lines: HR Cloud, IT Cloud, Spend/Finance Cloud, Data Cloud (Jul 2026), an "AI Cloud" org.
- Compound-startup thesis: Conrad — "a bizarro-world version of Salesforce where everything is re-centered around employee data." Engineering page: **Employee Graph** + middleware (workflows, permissions, analytics, policies) + product layers; 30% of headcount in R&D; 40+ products; 100+ former founders.

## 2. Public AI/agent statements

**Products**
- **Rippling AI** (2026-03-18): "built to do the work, not just talk about it." Writes SQL against live data, "exact answers, not educated guesses," STAGES actions (bonuses, access grants, reorgs) that "go through whatever approvals your company requires, the same as if made by a human." Permissions inherited: "the LLM can only access information that the user it's chatting with can access themselves." Surfaces: in-app, Slack, and a **Rippling MCP server**. Conrad: "the future of G&A software." Josh Stein (DFJ): "built on the system of record," not "a thin wrapper."
- **Rippling Data Cloud** (2026-07-01): connectors, NL BI, catalog/lineage, custom apps — aimed at Tableau/Looker.
- **AI Spend Console** (2026-08-06): born from internal pain — CFO found Rippling on track to spend 40% of R&D headcount budget on tokens (605B tokens in April; one engineer at $50K/month; 10-15% of staff drove ~60% of spend); a gateway routes prompts to cheaper models, scores output vs spend per engineer, cut token spend to ~15% of headcount budget. "AI captains" for adoption. CPO/President **Matt MacInnis**: inference providers "have absolutely no incentives to help you control your spend." Conrad published a private agent benchmark (Grok led; "GLM 5.2 is 85% cheaper").
- **G2** (2026-08-25): #1 in G2's first AI Agents for HR grid, 98/100 on 650+ reviews. MacInnis: "alone among competitors for having shipped AI-powered products that do useful things for our customers, today."

**Org structure from job postings (mid-2026)**
- An **"AI Cloud" org** with an **Agents, Automations & Plugins** team owning agent primitives, skills packaging, event/scheduled automations, plugin/MCP connectivity "both for Rippling's internal product teams and for customers building their own" — "greenfield… the platform layer every AI-powered feature at Rippling will depend on" (Staff SWE NYC, $189-315K).
- **AI Platform** team (retrieval, reasoning loops, memory, evals, execution environments) scaling toward "hundreds of AI-powered workflows" (Sr EM SF, $207-345K); Sr EM AI Developer Experience; Time Products EM as a 0→1 agentic bet.
- **Leaders:** CTO/SVP Eng **Albert Strasheim** (ex-Segment, Cloudflare; joined Aug 2022): Rippling is "an amalgamation of a bunch of smaller startups" — ~10 independent 50-person teams at 500 engineers, now 1,000+; building "an agent framework allowing administrators to automate complex workflows… that historically required HR analysts" (Modern CTO, 2026-01-14). **Rakesh Rajan** SVP Engineering (ex-Uber Rider app head; joined Jan 2023) — no public AI statements found. MacInnis is the public AI-product voice (podcast Mar-Apr 2026: "why most agents are useless and how we fixed it").

## 3. Rippling Talent

- History: Performance, LMS, Pulse surveys, headcount planning, comp bands existed by Mar 2024. **Rippling Recruiting launched Aug 2023**: approve headcount → post to 25K boards → "offer letter to onboarding in 90 seconds." 2025-26 AI: Application Review (bias-check on filters), Interview Assistant, Smart Scheduling, AI JD generation, 9-box + auto-populated comp recommendations.
- **Scale:** "Product Lead, Talent Products" posting: Talent business "more than $100M of ARR… growing roughly 100% YoY" across headcount planning, recruiting, performance, LMS, surveys. Mandate: rebuild around agents — systems that "detect when work needs to happen, complete as much of it as possible, and bring people in only for the decisions that require their judgment," leveraging the employee graph. SF/NYC, $174-290K — an IC/lead PM seat, not a GM [inferred].
- **Talent Signal:** EA opened 2024-09-25 (Bloomberg, PYMNTS): first 90 days of work product (GitHub / Salesforce+Gong / Zendesk) → High Potential / Typical / Pay Attention with evidence; no age/tenure/gender inputs; manager in the loop. Rippling: only it can do this thanks to "a massively scalable data platform… deep integrations to third-party workflow software." Bersin: "AI Trailblazer," "less biased than managers." MacInnis conceded some "might find the product unsettling." No organized backlash found (contrast Lattice's 2024 "digital workers" reversal). Status: still EA; the "Product Lead, Talent Signal" req (tasked with GA + PMF) now 410s; no GA announcement. [inferred] Stalled short of GA; ideas being folded into the agent-first rebuild. (Albert 8/31: "quietly stopped selling"; plumbing reused for AI Spend Console.)
- Reviews vs standalone ATS: Rippling wins on HRIS integration + admin efficiency; "sourcing, scorecards, pipeline analytics functional but not best-in-class, AI features lag AI-native platforms"; cannot be bought standalone. No public Talent customer count.

## 4. Competitive context (agents in HR/talent)

| Vendor | Agent posture |
|---|---|
| Deel | AI Workforce beta Aug 2025; Big Deel Mar 2026 custom agents + ChatGPT app; Akai platform May 2026. Under DOJ investigation over the Rippling spy case. |
| Workday | Illuminate: 11 new agents at Rising Sep 2025 incl. Performance, Job Architecture, Employee Sentiment, Recruiter, Talent Mobility; GA through 2026. |
| Gusto | "Gus" → Gusto Cofounder (Jun 2026) proactive SMB back-office agent. |
| HiBob | Bob AI Companion orchestrating specialized agents (2026 vision). |
| Personio | Profitable Q1 2026; acquired aurio (agentic sourcing/screening) Apr 2026; explicit human-in-the-loop stance. |
| Lattice | 2024 "digital worker" scrapped after backlash; 2026 evidence-based AI reviews + standalone AI Agent; shipping a Rippling HRIS integration. |

Positioning: Deel and Workday lead on COUNT of named agents; Rippling leads on a single permission-aware agent over a unified graph plus agent-building primitives (MCP, plugins), and the G2 #1 badge. **Nobody has shipped a credible agentic TALENT suite yet** — Talent Signal remains the only work-artifact performance product from a major HRIS [inferred].

## 5. Culture and execution signals

- Founder-led, hands-on: Conrad is the company's own Rippling admin, rejects "managers managing managers," Slacks product teams directly, "go all the way to the ground." No speed-vs-quality trade-off (20VC).
- Seeding pattern: 100-150 former founders; "a loose federation of individually focused teams"; former founders "run entire products and teams." Strasheim's "10 startups of 50" = small autonomous pods that scale once they hit $1M ARR [pattern inferred].
- Perf management: Glassdoor 3.7/5, 71% recommend; engineers rate WLB 2.4; "PIP culture," 0-3-week PIPs, sub-1-year tenure. Blind's tracker lists six cuts Nov 2025-Mar 2026 totaling ~850 — USER-SUBMITTED, uncorroborated by any outlet; company posted 460 reqs simultaneously; possibly rolling perf exits rather than RIFs [inferred].
- In-office: every eng/product req requires 3 days/week SF/NYC. Internal AI adoption measured per-engineer (output vs tokens) — the Spend Console is literally an employee-ROI tool.

## 5 things the public record implies about agent-first Talent V3

1. **Built on the Employee Graph, inheriting Rippling's permission model, not beside it** — evidenced (Rippling AI messaging, Strasheim's admin-agent framework, Talent Products req).
2. **The bar is "detect → do → escalate only for judgment," across the full lifecycle** — evidenced (verbatim mandate in the Talent Products posting).
3. **Consumes the AI Cloud primitives (agents, skills, automations, MCP/plugins) rather than rolling its own** — evidenced by the AI Cloud charter; [inferred] a Talent GM will be a customer of, and dependent on, a platform team still described as greenfield. (Albert 8/31: "where do we write the code exactly" — build inside Rippling AI vs as custom agents.)
4. **Must close the gap with Ashby/Greenhouse on recruiting depth while nothing else has shipped agentic talent** — evidenced by reviewer consensus that Rippling's ATS AI "lags AI-native platforms"; [inferred] ~12-month window before Workday's Performance/Recruiter agents and Personio+aurio mature.
5. **Economically disciplined and trust-preserving from day one** — evidenced: the token-burn episode and AI Spend Console mean unit economics per agent run will be scrutinized; Talent Signal's EA stall and Lattice's reversal show work-artifact performance signals need evidence links and human sign-off. [inferred] Expect Conrad personally using the product and a $100M→$200M growth expectation on a small founder-style pod, 3 days in-office SF.

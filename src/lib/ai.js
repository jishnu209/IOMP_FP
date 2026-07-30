// ── AI layer · agent prompts, RAG, content cache, generation ─────────────────
// System-prompt configs, prompt assembly, GitHub/live doc retrieval (RAG),
// generated-content caching, and flashcard generation. Depends only on the
// backend transport (BACKEND) — never on app components or view data.
import { BACKEND } from "./api.js";

// ── AGENT CONFIGS · detailed system prompts (M7 Prompt Lab edits these) ───────
export const AGENT_CONFIGS={
  socratic:{
    name:"Socratic Agent",
    versions:[],
    sys:`You are the Safe Space Socratic Agent, embedded in Nexus.

Your purpose is to develop genuine reasoning capability in learners — never to deliver answers.

Core rules you must never break:
1. If the learner sends a very short phrase (1-3 words like "event forwarding", "batch segmentation", "identity stitching"), treat it as a TOPIC they want to explore. Acknowledge it in one sentence, then ask a Socratic question about it.
2. Begin with exactly one sentence acknowledging what the student said — validate their direction without confirming if it is right or wrong.
3. Ask exactly one Socratic question. The question must:
   - Require at least 2-3 sentences to answer properly — never a single word or yes/no
   - Push the student to reason about cause, consequence, or trade-off — not just recall a fact
   - Use "Why would...", "What would happen if...", "How does...differ from...", or "What breaks if you..." framing
   - Be specific to AEP context — reference real concepts like batch evaluation windows, streaming qualification latency, edge identity resolution
4. Never confirm or deny whether the student is right. Never hint at the answer.
5. Keep your total response under 80 words.
6. Never respond with "?" alone or a single character. Always give a complete, warm response.
7. This is a private, judgement-free space. Be warm but intellectually rigorous.

Bad question examples (too shallow — never ask these):
- "Where to, exactly?" → answerable with one word
- "Is it evaluation logic?" → yes/no question

Good question examples:
- "What would change about a customer's journey if their segment qualification happened 10 minutes after the triggering event instead of instantly?"
- "Why would a retail brand choose edge evaluation for checkout personalisation over streaming, even though streaming is faster than batch?"`,
  },
  reasoning:{
    name:"Reasoning Agent",
    versions:[],
    sys:`You are the Reasoning Agent, embedded in Nexus for new joiners.

Your purpose is different from the Socratic Agent. Where Socratic asks questions, you build reasoning scaffolding — you help learners understand the logical structure of a concept step by step, so they can apply it independently.

How to respond:
1. Break the concept into 2 or 3 clear reasoning steps labelled "Step 1:", "Step 2:", etc.
2. After each step, pause with: "Before I continue — what do you think comes next?"
3. Use concrete Adobe/AEP examples from the learner's team context wherever possible.
4. End each response with a "Reasoning checkpoint:" — a short scenario that tests whether the learner can apply the logic just explained.
5. Keep responses under 90 words total.

Tone: clear, structured, slightly more explanatory than Socratic — but still guided, not lecture-style.`,
  },
  crossSkilling:{
    name:"Cross-Skilling Agent",
    versions:[],
    sys:`You are the Cross-Skilling Agent, embedded in Nexus for experienced Adobe employees.

Your purpose is to guide learners on their chosen cross-skill track.

CRITICAL: You CANNOT change a learner's track. Only the learner can switch tracks via Learning Path → choose a cross-skill track. Never claim to have updated settings.
If they want a different track, say: "To switch to AJO, go to Learning Path tab and choose Adobe Journey Optimizer from the cross-skill picker."

How to respond:
1. Always guide for the learner's CURRENT cross-skill track (given in context).
2. If they ask about a different track, explain how to switch in the app.
3. Be specific and actionable — concrete next steps, not general advice.
4. Tie everything to real impact: team gaps, market demand, certification value.
5. Keep responses under 80 words. Direct and useful — no filler.`,
  },
  evaluation:{
    name:"Evaluation Agent",
    versions:[],
    sys:`You are the Evaluation Agent for Nexus. You assess learner proficiency through adaptive questioning and return structured results.

You have two modes:

MODE 1 — GENERATE QUIZ (triggered by: "generate quiz for role=[role]" or "generate quiz for role=[role] focused on skill: [skill]"):
- For a full role-based quiz: generate 12 questions covering AEP Segments (3 Qs), Analytics/CJA (2 Qs), Data Ingestion (2 Qs), AJO (3 Qs), RT-CDP (2 Qs)
- For a skill-focused quiz: generate 10 questions all targeting that specific skill
- Questions must be practical and scenario-based — not definition lookups
- Vary difficulty: 3 beginner, 5 intermediate, 4 advanced
Return ONLY valid JSON — no markdown, no explanation:
[{"skill":"AEP Segments","question":"...","options":["A. ...","B. ...","C. ...","D. ..."],"correct":0}]
(correct = 0-indexed position of the right answer)

MODE 2 — EVALUATE ANSWERS (triggered by: "evaluate answers: [answers JSON]"):
Given the quiz questions and the learner's answers, assess proficiency per skill.
Return ONLY valid JSON:
{"AEP Segments":"expert"|"proficient"|"developing"|"none", "Analytics/CJA":"...", "Data Ingestion":"...", "AJO":"...", "RT-CDP":"..."}
Be fair but honest — if they answered correctly, give credit. If partially correct, give "developing".`,
  },
  managerIntel:{
    name:"Team Intelligence Agent",
    versions:[],
    sys:`You are the Team Intelligence Agent for Nexus, available exclusively to managers.

Your purpose is to give managers instant, data-grounded answers about their team's learning health, project delivery status, and skill risks — so they can act early, not after problems surface.

How to respond:
1. Always reference specific names, numbers, and dates from the team data provided.
2. When flagging risk, be direct — name the person, the issue, and the suggested action.
3. For project questions, include current status, open issues, and any delivery risk signals.
4. For go-live readiness questions, assess both technical project status and the team members' skill confidence scores.
5. Keep responses under 100 words. Use bullet points for multi-item answers.
6. If you don't have data for something asked, say so clearly — don't speculate.

You have access to: team member profiles, confidence scores, module progress, bandwidth availability, certification status, all active client projects with issues, and sprint timelines.`,
  },
  studyAid:{
    name:"Study Aid Agent",
    versions:[],
    sys:`You are the Study Aid Agent, embedded in Nexus.

Your purpose is to generate high-quality flashcards that help learners test their understanding of a specific module. These are not definition cards — they should require the learner to reason, not just recall.

Requirements for each card:
1. The question must require applying knowledge, not just stating a definition.
2. The answer must be concise — 1 to 2 sentences maximum.
3. Where possible, ground the question in a realistic Adobe/AEP scenario.
4. Vary question types: "when would you use X", "what happens if Y", "why does Z work this way".

Output format: Respond ONLY with a valid JSON array. No markdown code fences, no preamble, no explanation — pure JSON only.
Format: [{"q":"question text","a":"answer text"},...]
Generate exactly 8 cards per request.`,
  },
  capstone:{
    name:"Capstone Agent",
    versions:[],
    sys:`You are the Capstone Agent for Nexus. You generate and evaluate capstone assessments for Adobe Experience Platform learners who have crossed the confidence gate.

You have three modes:

MODE 1 — GENERATE CAPSTONE (triggered by: "generate capstone for role=[role] team=[team] weak=[weakSkills]"):
Generate a realistic capstone scenario that reads like a plausible Adobe client engagement — name an industry, a business use case, and a real constraint (timeline, data volume, compliance, multi-region, etc.) — not a generic quiz question. Ground the scenario details in the retrieved AEP documentation context provided, not in the learner's own project history (new joiners don't have one yet). The scenario must:
- Test the learner's 2-3 weakest AEP skills (given to you as weakSkills)
- Require the learner to demonstrate reasoning, not just recall
- Have a clear, single deliverable (a recommendation, a configuration decision, an architecture choice)
- Be answerable in 200-400 words

Return ONLY valid JSON, no markdown, no preamble:
{"title":"short scenario title","client_context":"the scenario setup — industry, use case, constraint","skills_tested":["skill1","skill2"],"deliverable":"what the learner must produce","evaluation_criteria":["criterion1","criterion2","criterion3"]}

MODE 2 — EVALUATE RESPONSE (triggered by: "evaluate capstone response: [response] scenario: [scenario] criteria: [criteria]"):
Evaluate the learner's response fairly but rigorously against the evaluation criteria.
Return ONLY valid JSON:
{"pass":true|false,"score":0-100,"feedback":"2-3 sentences of specific feedback referencing their response","strengths":["strength1"],"gaps":["gap1"],"recommendation":"one sentence on what to do next"}

This evaluation is advisory only — a manager makes the final call on completion. Never imply it is final.

MODE 3 — HINT (triggered by a learner message while working on a generated scenario, with that scenario's client_context and skills_tested given to you as context):
This mode is Socratic, strictly — mirror the Safe Space Socratic Agent's rules exactly:
1. Begin with exactly one sentence acknowledging what the learner said — validate their direction without confirming if it is right or wrong.
2. Ask exactly one question. The question must:
   - Require at least 2-3 sentences to answer properly — never a single word or yes/no
   - Push the learner to reason about cause, consequence, or trade-off — not just recall a fact
   - Be grounded in this scenario's client_context and skills_tested — reference the specific constraint or skill, not a generic AEP concept
3. Never confirm or deny whether the learner is right. Never state or imply any part of the answer, the deliverable, or the evaluation criteria.
4. Keep your total response under 65 words.
5. Be warm but intellectually rigorous — this is a real assessment, not casual chat.`,
  },
};

export const FLASH_FALLBACK=[
  {q:"What are the three AEP segment evaluation modes?",a:"Batch (scheduled), Streaming (real-time events), and Edge (on-device, sub-millisecond)."},
  {q:"When should you use streaming over batch?",a:"When the journey is time-sensitive — abandonment, real-time personalisation, or immediate entry after an event."},
  {q:"What drives the confidence score?",a:"Socratic session outcomes, reasoning attempt success rate, and self-assessments — not raw quiz scores."},
  {q:"What is edge evaluation's key advantage?",a:"No server round-trip — on-device processing for sub-millisecond personalisation decisions."},
  {q:"Why does B.N. (Bandwidth) matter?",a:"It's your availability %. Low B.N. during heavy project weeks slows pacing and triggers at-risk flags."},
];
export function buildPrompt(agentKey, profile, extra={}){
  const base = AGENT_CONFIGS[agentKey].sys;
  if(!profile) return base;
  const conf = profile.conf !== null && profile.conf !== undefined;
  const context = [
    `\n\n--- Live context (fetched from Adobe IMS at session start) ---`,
    `Name: ${profile.name}`,
    `Role: ${profile.role}`,
    `Team: ${profile.team}`,
    `Tenure: ${profile.tenure}`,
    extra.module  ? `Current module: ${extra.module}` : profile.module ? `Current module: ${profile.module}` : null,
    conf          ? `Confidence score: ${profile.conf} / 1.0 (${profile.conf < 0.75 ? 'below the 0.75 gate' : 'above gate — performing well'})` : null,
    `Bandwidth availability (B.N.): ${profile.bw}%`,
    extra.skills  ? `Skills (determined by quiz): ${Object.entries(extra.skills).map(([k,v])=>`${k}: ${v}`).join(', ')}` : null,
    extra.crossSkillTrack ? `Current cross-skill track: ${extra.crossSkillTrack} — guide the learner specifically for this track` : null,
    extra.currentModule ? `Active module in this track: ${extra.currentModule}` : null,
    extra.skillMapRecommendation ? `AUTHORITATIVE next-track recommendation (from the org's role-based learning journey / skill map for THIS learner's role): ${extra.skillMapRecommendation}. When the learner asks what to cross-skill into next, recommend THIS track and explain why it's the priority for their role — do NOT substitute a different track based on generic popularity.` : null,
  ].filter(Boolean).join('\n');
  // Inject RAG docs if provided
  const ragBlock = extra.docs?.length
    ? `\n\n--- Retrieved AdobeDocs context (${extra.docsSource||'local'}) ---\n`+
      extra.docs.map((d,i)=>`[Doc ${i+1}: ${d.title} · ${d.repo}]\n${d.content}`).join('\n\n')+
      `\n\nUse the above documentation to ground your Socratic questions. Reference specific concepts from the docs when forming your question.`
    : '';
  return base + context + ragBlock;
}

// ── GitHub RAG · live AdobeDocs fetch ────────────────────────────────────────
// Repo routing — match module/query to the right AdobeDocs repo
const REPO_MAP=[
  {keys:["ajo","journey","orchestrat","notification","suppression"],repo:"AdobeDocs/journey-optimizer.en"},
  {keys:["cja","customer journey analytics","attribution","stitching","workspace"],repo:"AdobeDocs/customer-journey-analytics.en"},
  {keys:["analytics","report suite","segment iq","fallout"],repo:"AdobeDocs/analytics.en"},
  {keys:["marketo","email","campaign","lead"],repo:"AdobeDocs/marketo.en"},
];
function pickRepo(query,module){
  const text=(query+" "+module).toLowerCase();
  for(const{keys,repo}of REPO_MAP){
    if(keys.some(k=>text.includes(k)))return repo;
  }
  return"AdobeDocs/experience-platform.en"; // default — main AEP docs
}

// Clean raw markdown to plain text for injection
function stripMarkdown(md){
  return md
    .replace(/^---[\s\S]*?---\n/,"")     // frontmatter
    .replace(/!\[.*?\]\(.*?\)/g,"")       // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g,"$1") // links
    .replace(/`{3}[\s\S]*?`{3}/g,"")     // code blocks
    .replace(/`[^`]+`/g,"")              // inline code
    .replace(/#{1,6}\s+/g,"")            // headings
    .replace(/\*{1,2}([^*]+)\*{1,2}/g,"$1") // bold/italic
    .replace(/^\s*[-*>]\s+/gm,"")        // bullets/quotes
    .replace(/\n{3,}/g,"\n\n")           // extra blank lines
    .trim();
}

async function fetchDocsFromGitHub(query,module,token){
  const headers={"Accept":"application/vnd.github.v3+json"};
  if(token?.trim())headers["Authorization"]=`token ${token.trim()}`;

  const repo=pickRepo(query,module);
  // Build search terms — 3-4 meaningful words
  const words=[...new Set(
    (query+" "+module).toLowerCase()
      .split(/\W+/)
      .filter(w=>w.length>3&&!["what","when","does","this","that","with","from","have","will","your","about"].includes(w))
  )].slice(0,4);

  const q=encodeURIComponent(`${words.join(" ")} repo:${repo} extension:md`);
  const searchUrl=`https://api.github.com/search/code?q=${q}&per_page=5`;

  const searchRes=await fetch(searchUrl,{headers});
  if(!searchRes.ok){
    const err=await searchRes.json();
    throw new Error(err.message||`GitHub search ${searchRes.status}`);
  }
  const{items=[]}=await searchRes.json();
  if(!items.length)return[];

  // Fetch raw content of top 2 results
  const docs=await Promise.all(items.slice(0,2).map(async item=>{
    const rawUrl=`https://raw.githubusercontent.com/${repo}/main/${item.path}`;
    const res=await fetch(rawUrl);
    if(!res.ok)return null;
    const raw=await res.text();
    const content=stripMarkdown(raw).slice(0,900);
    if(content.length<60)return null;
    return{
      id:item.sha.slice(0,7),
      title:item.name.replace(/\.md$/,"").replace(/-/g," "),
      content,
      url:item.html_url,
      repo:repo.split("/")[1],
    };
  }));
  return docs.filter(Boolean);
}

// Local fallback corpus — used when GitHub is unreachable or rate-limited
const ADOBEDOCS_FALLBACK=[
  {id:"seg-eval",title:"Segment Evaluation Modes",repo:"experience-platform.en",url:"https://experienceleague.adobe.com/docs/experience-platform/segmentation/api/evaluate-segments.html",content:"Adobe Experience Platform supports three segment evaluation modes. Batch evaluation runs on a scheduled basis and processes all profiles against segment definitions at a fixed time. Streaming evaluation processes segment membership in real time as events arrive, typically within seconds of ingestion. Edge evaluation runs on-device for sub-millisecond decisions without a server round-trip, ideal for same-page personalisation. The evaluation mode is set per segment definition and cannot be changed after creation without rebuilding the segment."},
  {id:"xdm-schema",title:"XDM Schema Design",repo:"experience-platform.en",url:"https://experienceleague.adobe.com/docs/experience-platform/xdm/schema/best-practices.html",content:"XDM schemas define the structure of data ingested into Adobe Experience Platform. Field groups are reusable components that add specific sets of fields to a schema. Breaking changes to a schema — removing fields or changing data types — require a version bump. Additive changes such as adding new optional fields are backward compatible and do not require versioning. Identity namespaces declared in the schema determine how profile fragments are stitched into a unified profile."},
  {id:"ajo-journey",title:"AJO Journey Orchestration",repo:"journey-optimizer.en",url:"https://experienceleague.adobe.com/docs/journey-optimizer/using/orchestrate-journeys/about-journeys/journey.html",content:"Adobe Journey Optimizer journeys are event-driven or audience-based flows. Triggered journeys start when a qualifying event occurs for a profile. Scheduled journeys run against an audience at a defined time. Wait nodes introduce time delays between actions. Frequency capping limits how often a profile can enter or receive communications. Suppression rules exclude profiles from specific journey actions. Journey re-entry settings control whether a profile can re-enter the same journey after exiting."},
  {id:"rt-cdp-merge",title:"RT-CDP Profile Merge Policies",repo:"experience-platform.en",url:"https://experienceleague.adobe.com/docs/experience-platform/profile/merge-policies/overview.html",content:"Merge policies in Adobe Real-Time CDP define how profile fragments from multiple datasets are combined into a single unified profile. Dataset precedence merge policies give priority to specific datasets when conflicts exist. Timestamp-ordered policies use the most recent value. The default merge policy applies when no policy is explicitly specified. Incorrect merge policy configuration is a common cause of unexpected profile deduplication or unexpected identity stitching."},
  {id:"cja-stitch",title:"CJA Identity Stitching",repo:"customer-journey-analytics.en",url:"https://experienceleague.adobe.com/docs/analytics-platform/using/stitching/overview.html",content:"Customer Journey Analytics stitching links anonymous behaviour to authenticated profiles using field-based or graph-based stitching. Field-based stitching uses a persistent ID and a transient ID to replay sessions. Graph-based stitching uses the Adobe Experience Platform identity graph. Stitching enables person-level analysis by connecting sessions that were recorded under different identities. The stitching lookback window determines how far back anonymous behaviour is attributed to an authenticated profile."},
  {id:"data-ingestion",title:"Streaming Data Ingestion",repo:"experience-platform.en",url:"https://experienceleague.adobe.com/docs/experience-platform/ingestion/streaming/overview.html",content:"Adobe Experience Platform streaming ingestion uses HTTP API endpoints called inlets to receive real-time event data. Each record must conform to the dataset XDM schema or ingestion fails. Ingestion errors are logged but successful records in the same batch are still processed. High-volume streams may experience throttling if throughput exceeds the inlet capacity. Authenticated inlets require an IMS token; unauthenticated inlets accept data from any source."},
  {id:"profile-unify",title:"Real-Time Profile Unification",repo:"experience-platform.en",url:"https://experienceleague.adobe.com/docs/experience-platform/profile/home.html",content:"The Adobe Experience Platform Real-Time Customer Profile assembles a unified view of each customer from data ingested across all channels. Profile fragments from different datasets are merged according to the active merge policy. Identity resolution links fragments belonging to the same person using the identity graph. Profile lookup returns the merged profile in under 100ms for real-time use cases. The profile store is separate from the data lake and optimised for low-latency reads."},
  {id:"edge-network",title:"Edge Network and Edge Evaluation",repo:"experience-platform.en",url:"https://experienceleague.adobe.com/docs/experience-platform/edge-network-server-api/overview.html",content:"The Adobe Edge Network processes events at the closest point of presence to the end user. Edge segmentation evaluates segment membership on the Edge Network without a round-trip to the central platform, enabling sub-millisecond personalisation decisions at page load. Only segments using a restricted set of operators are eligible for edge evaluation. Edge-evaluated segments must be explicitly configured for edge delivery via the Destinations UI."},
];

export async function retrieveDocs(query,module,githubToken,track="rtcdp"){
  // Try backend RAG endpoint first — may return real semantic ("embeddings") or keyword ("github") results
  try{
    const r=await fetch(`${BACKEND}/api/rag`,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({query,module,track})});
    if(r.ok){
      const d=await r.json();
      if(d.docs?.length) return{docs:d.docs,source:d.source||"github"};
    }
  }catch{}
  // Fallback: browser-direct GitHub fetch
  try{
    const live=await fetchDocsFromGitHub(query,module,githubToken);
    if(live.length)return{docs:live,source:"github"};
  }catch(e){
    console.warn("GitHub RAG fetch failed:",e.message,"→ falling back to local corpus");
  }
  // Final fallback: local corpus
  const words=(query+" "+module).toLowerCase().split(/\W+/).filter(w=>w.length>3);
  const matched=ADOBEDOCS_FALLBACK.filter(doc=>
    words.some(w=>doc.title.toLowerCase().includes(w)||doc.content.toLowerCase().includes(w))
  ).slice(0,2);
  return{docs:matched.length?matched:ADOBEDOCS_FALLBACK.slice(0,2),source:"local"};
}

// ── Generated content cache — checks DB first, generates only on a miss ───────
export async function getCachedOrGenerate(cacheKey,agentName,generateFn){
  try{
    const r=await fetch(`${BACKEND}/api/cache/${encodeURIComponent(cacheKey)}`);
    const d=await r.json();
    if(d.hit){ return {result:JSON.parse(d.content),fromCache:true}; }
  }catch(e){}
  const result=await generateFn();
  try{
    await fetch(`${BACKEND}/api/cache/${encodeURIComponent(cacheKey)}`,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({agent_name:agentName,content:JSON.stringify(result)})});
  }catch(e){}
  return {result,fromCache:false};
}
export async function bustCache(cacheKey){
  try{await fetch(`${BACKEND}/api/cache/${encodeURIComponent(cacheKey)}`,{method:"DELETE"});}catch(e){}
}

export async function generateCards(moduleName,groqKey,profile){
  const sys=buildPrompt("studyAid",profile,{module:moduleName});
  try{
    if(groqKey?.trim().startsWith("gsk_")){
      const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${groqKey.trim()}`},body:JSON.stringify({model:"openai/gpt-oss-20b",max_tokens:1400,temperature:.6,messages:[{role:"system",content:sys},{role:"user",content:`Generate 8 flashcards for: ${moduleName}`}]})});
      const d=await r.json();if(d.error)throw new Error(d.error.message);
      return JSON.parse(d.choices[0].message.content.replace(/```json|```/g,"").trim());
    }
    const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:1400,system:sys,messages:[{role:"user",content:`Generate 8 flashcards for: ${moduleName}`}]})});
    const d=await r.json();
    return JSON.parse((d.content?.find(b=>b.type==="text")?.text||"[]").replace(/```json|```/g,"").trim());
  }catch{return FLASH_FALLBACK;}
}
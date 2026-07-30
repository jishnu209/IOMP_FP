// ── Psychometrics engine ─────────────────────────────────────────────────────
// IRT (Item Response Theory), BKT (Bayesian Knowledge Tracing), and CAT
// (Computerised Adaptive Testing), plus the parameterised item bank. Pure math
// and data — no UI, no theme, no network. Extracted from App.jsx.

export const IRT = {
  probability:(theta,a,b)=>1/(1+Math.exp(-a*(theta-b))),
  // Fisher information — how much info item gives at this theta
  information:(theta,a,b)=>{const p=IRT.probability(theta,a,b);return a*a*p*(1-p);},
  // Estimate theta via Newton-Raphson MLE (50 iterations)
  estimateTheta:(responses,items)=>{
    let theta=0;
    for(let iter=0;iter<50;iter++){
      let num=0,den=0;
      for(let i=0;i<responses.length;i++){
        const p=IRT.probability(theta,items[i].a,items[i].b),q=1-p;
        num+=items[i].a*(responses[i]-p);
        den+=items[i].a*items[i].a*p*q;
      }
      if(Math.abs(den)<1e-9)break;
      theta+=num/den;
      theta=Math.max(-3,Math.min(3,theta));
    }
    return theta;
  },
  // Standard error of theta estimate
  standardError:(theta,items)=>{
    const info=items.reduce((s,it)=>s+IRT.information(theta,it.a,it.b),0);
    return info>0?1/Math.sqrt(info):99;
  },
  // Map theta (-3 to 3) to proficiency label
  thetaToLevel:(theta)=>theta>=1.5?"expert":theta>=0.3?"proficient":theta>=-0.5?"developing":"none",
  // Map theta to confidence score (0-1)
  thetaToConf:(theta)=>Math.round((theta/3+1)*50)/100,
};

// ── BKT (Bayesian Knowledge Tracing) — Hidden Markov Model ───────────────────
// Tracks P(mastery) per skill over multiple interactions
export const BKT_PARAMS={pL0:0.2,pT:0.09,pG:0.2,pS:0.1}; // standard psychometrics defaults
export const BKT = {
  // Update knowledge state after one observation
  update:(pL,correct,params=BKT_PARAMS)=>{
    const{pT,pG,pS}=params;
    const pCorrectKnown=1-pS, pCorrectNotKnown=pG;
    const pEv=pL*pCorrectKnown+(1-pL)*pCorrectNotKnown;
    const pLGiven=correct?(pL*pCorrectKnown)/pEv:(pL*pS)/(pL*pS+(1-pL)*(1-pG));
    return Math.min(0.99,Math.max(0.01,pLGiven+(1-pLGiven)*pT));
  },
  // Batch update from array of correct/incorrect [1,0,1,...]
  batchUpdate:(initial=BKT_PARAMS.pL0,responses=[])=>
    responses.reduce((pL,r)=>BKT.update(pL,r),initial),
  // Map P(mastery) to label
  masteryToLevel:(pL)=>pL>=0.85?"expert":pL>=0.65?"proficient":pL>=0.4?"developing":"none",
};

// ── CAT (Computerised Adaptive Testing) ──────────────────────────────────────
export const CAT = {
  // Select the next item that gives max information at current theta
  selectNext:(theta,usedIds,items)=>{
    let best=null,bestInfo=-Infinity;
    items.forEach(item=>{
      if(usedIds.includes(item.id))return;
      const info=IRT.information(theta,item.a,item.b);
      if(info>bestInfo){bestInfo=info;best=item;}
    });
    return best;
  },
  // Stopping rule: min 3 items, max 8, or SE < 0.35
  shouldStop:(responses,items,theta)=>{
    if(responses.length<3)return false;
    if(responses.length>=8)return true;
    return IRT.standardError(theta,items.filter((_,i)=>i<responses.length))<0.35;
  },
};

// ── Item Bank — 20 parameterised questions across 5 skills ───────────────────
// a = discrimination (0.5-2.5), b = difficulty (-2 to 2)
export const ITEM_BANK=[
  // AEP Segments
  {id:1,skill:"AEP Segments",a:1.0,b:-1.5,question:"Which evaluation mode processes segment membership in real-time as events arrive?",options:["Batch (scheduled jobs)","Streaming (event-triggered)","Edge (on-device)","Scheduled (manual)"],correct:1},
  {id:2,skill:"AEP Segments",a:1.5,b:-0.3,question:"A campaign must qualify customers within 2 minutes of cart abandonment. Which evaluation mode applies?",options:["Batch","Streaming","Either — both are fast enough","Edge"],correct:1},
  {id:3,skill:"AEP Segments",a:1.8,b:0.8,question:"Your segment uses multi-event lookback over 30 days and shows higher streaming latency than expected. Most likely cause?",options:["Too many profiles","Complex event sequence lookback window","Wrong evaluation mode selected","Invalid XDM operator"],correct:1},
  {id:4,skill:"AEP Segments",a:2.2,b:1.8,question:"A client needs personalised web content within 50ms of a page load. Streaming takes ~2 min. Correct architecture?",options:["Increase streaming throughput","Edge evaluation with on-device segment membership","Pre-compute batch and cache results","Use a webhook trigger"],correct:1},
  // Analytics/CJA
  {id:5,skill:"Analytics/CJA",a:1.0,b:-1.2,question:"What does 'stitching' do in Customer Journey Analytics?",options:["Combines report suites","Links anonymous and authenticated behaviour into one identity","Merges event datasets","Attaches lookup tables"],correct:1},
  {id:6,skill:"Analytics/CJA",a:1.5,b:-0.2,question:"CJA and Adobe Analytics show different conversion rates for the same period. Most likely explanation?",options:["CJA has a data quality issue","Different identity stitching and attribution models","CJA data is still processing","Date range mismatch"],correct:1},
  {id:7,skill:"Analytics/CJA",a:1.8,b:0.9,question:"Building a 90-day cross-channel attribution model covering web, email, and in-store touchpoints. Which CJA feature is purpose-built for this?",options:["Algorithmic attribution in a cross-channel connection","Fallout analysis","Flow visualisation","Segment IQ"],correct:0},
  {id:8,skill:"Analytics/CJA",a:2.0,b:1.8,question:"Person-level workspace is showing unexpected breakdowns. Stakeholder needs session-level analysis for one channel only. Correct approach?",options:["Create a second data view with session container","Apply a session filter","Rebuild the connection","Use a calculated metric"],correct:0},
  // Data Ingestion
  {id:9,skill:"Data Ingestion",a:1.0,b:-1.0,question:"Best ingestion method for high-volume real-time mobile app events?",options:["Batch via CSV upload","Streaming via HTTP API","Source connector sync","SFTP transfer"],correct:1},
  {id:10,skill:"Data Ingestion",a:1.5,b:0.0,question:"A batch job partially fails — 60% ingested, 40% fail validation. What happens?",options:["Entire batch is rejected","Failed records skipped; successful records ingested","Batch retries automatically","Full file must be resubmitted"],correct:1},
  {id:11,skill:"Data Ingestion",a:1.8,b:1.0,question:"Streaming pipeline shows increasing p99 latency at peak hours despite consistent payload size. Most likely root cause?",options:["XDM schema validation errors","Throughput throttling at the inlet","Profile merge conflicts","Dataset partition limits exceeded"],correct:1},
  {id:12,skill:"Data Ingestion",a:2.0,b:2.0,question:"Client ingests HIPAA-regulated data into AEP. What additional configuration is required beyond standard setup?",options:["Enable encryption at rest","Use a HIPAA-eligible sandbox with field-level access controls","Set up a private source connector","Encrypt data before sending to the inlet"],correct:1},
  // AJO
  {id:13,skill:"AJO",a:1.0,b:-1.2,question:"A customer hasn't opened a journey entry email after 3 days — they should now receive a push notification. Which AJO component enables this?",options:["Decision Management","Wait node + email open condition","Frequency capping","A/B test node"],correct:1},
  {id:14,skill:"AJO",a:1.5,b:-0.1,question:"What distinguishes a triggered journey from a scheduled campaign in AJO?",options:["Triggered journeys are real-time and event-driven; campaigns run at a defined batch time","Campaigns support A/B testing; journeys do not","Triggered journeys support email only","No functional difference"],correct:0},
  {id:15,skill:"AJO",a:1.8,b:0.9,question:"Journey has 15% delivery failure on an email action. Templates are valid, audience is qualified. What to check first?",options:["Journey re-entry settings","Channel surface configuration and IP warming status","Segment evaluation mode","Profile merge policy"],correct:1},
  {id:16,skill:"AJO",a:2.2,b:1.8,question:"Client wants to suppress customers who purchased within 7 days from re-entering a journey even if they re-qualify for the segment. Which mechanism?",options:["Journey frequency capping","Business rules with recency suppression","Decision engine exclusion","Custom wait + exit condition"],correct:1},
  // RT-CDP
  {id:17,skill:"RT-CDP",a:1.0,b:-1.0,question:"What is the primary function of a Merge Policy in RT-CDP?",options:["Determines which data arrives first","Defines how profile fragments from multiple sources are combined into one profile","Sets identity resolution rules","Controls data access permissions"],correct:1},
  {id:18,skill:"RT-CDP",a:1.5,b:0.0,question:"A destination is receiving duplicate profiles. Most likely cause?",options:["Export frequency is too high","Merge policy conflict creating multiple profile fragments for the same identity","Segment evaluation lag","Destination connector misconfiguration"],correct:1},
  {id:19,skill:"RT-CDP",a:1.8,b:1.0,question:"Client's identity graph is unexpectedly merging profiles from different customers. What should you audit first?",options:["Segment definitions","Identity namespace priority and shared device configuration","Merge policy settings","Data ingestion frequency"],correct:1},
  {id:20,skill:"RT-CDP",a:2.2,b:1.9,question:"You have 5 identity namespaces. Profiles are fragmenting inconsistently across B2B and B2C datasets in the same sandbox. Root cause analysis should start where?",options:["Dataset schema mismatch","Identity graph algorithm settings — 'none' vs 'private graph'","Merge policy dataset precedence","XDM field group conflicts"],correct:1},
];

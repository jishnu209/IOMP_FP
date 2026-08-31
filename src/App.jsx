import { useState, useRef, useEffect, useReducer, useMemo, useCallback, Fragment } from "react";
import { hierarchy as d3Hierarchy, tree as d3Tree } from "d3-hierarchy";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { P, getThemeMode, setThemeMode } from "./theme/tokens.js";
import { IRT, BKT, BKT_PARAMS, CAT, ITEM_BANK } from "./lib/psychometrics.js";
import { BACKEND, callAgent, callFlashcardAgent, judgeResponse, judgeGenericResponse } from "./lib/api.js";
import { loginWithIMS, fetchSession, logoutIMS, signOutAdobe, imsConfigured, parseImsFragment, submitImsToken } from "./lib/ims.js";
import { AGENT_CONFIGS, FLASH_FALLBACK, buildPrompt, retrieveDocs, getCachedOrGenerate, bustCache, generateCards } from "./lib/ai.js";
import { callPractice, validateUnderstanding } from "./agents/practice.js";
// React Spectrum S2 — subpath imports per official guidance (not the barrel).
import { Button } from "@react-spectrum/s2/Button";
import { ActionButton } from "@react-spectrum/s2/ActionButton";
import { TextField } from "@react-spectrum/s2/TextField";
import { Link as S2Link } from "@react-spectrum/s2/Link";
import { Form as S2Form } from "@react-spectrum/s2/Form";
import { Card as S2Card, Content, Text as CardText, Footer } from "@react-spectrum/s2/Card";
import { Badge } from "@react-spectrum/s2/Badge";
import { SegmentedControl, SegmentedControlItem } from "@react-spectrum/s2/SegmentedControl";
import { Meter } from "@react-spectrum/s2/Meter";
import { Avatar } from "@react-spectrum/s2/Avatar";
import AIchat from "@react-spectrum/s2/illustrations/gradient/generic1/AIchat";
import { Switch } from "@react-spectrum/s2/Switch";
import { TagGroup, Tag } from "@react-spectrum/s2/TagGroup";
import Sparkles from "@react-spectrum/s2/illustrations/gradient/generic1/Sparkles";
import Key from "@react-spectrum/s2/icons/Key";
import UserGroup from "@react-spectrum/s2/icons/UserGroup";
import Preview from "@react-spectrum/s2/icons/Preview";
import ChevronRight from "@react-spectrum/s2/icons/ChevronRight";
import ChevronLeft from "@react-spectrum/s2/icons/ChevronLeft";
import CheckmarkCircle from "@react-spectrum/s2/icons/CheckmarkCircle";
import Home from "@react-spectrum/s2/icons/Home";
import Education from "@react-spectrum/s2/icons/Education";
import Layers from "@react-spectrum/s2/icons/Layers";
import Chat from "@react-spectrum/s2/icons/Chat";
import Ribbon from "@react-spectrum/s2/icons/Ribbon";
import Target from "@react-spectrum/s2/icons/Target";
import Calendar from "@react-spectrum/s2/icons/Calendar";
import Search from "@react-spectrum/s2/icons/Search";
import FileText from "@react-spectrum/s2/icons/FileText";
import CommunityIcon from "@react-spectrum/s2/icons/Community";
import User from "@react-spectrum/s2/icons/User";
import Lightbulb from "@react-spectrum/s2/icons/Lightbulb";
import Briefcase from "@react-spectrum/s2/icons/Briefcase";
import PeopleGroup from "@react-spectrum/s2/icons/PeopleGroup";
import TableIcon from "@react-spectrum/s2/icons/Table";
import Data from "@react-spectrum/s2/icons/Data";
import Cloud from "@react-spectrum/s2/icons/Cloud";
import Lock from "@react-spectrum/s2/icons/Lock";
import Code from "@react-spectrum/s2/icons/Code";
import Building from "@react-spectrum/s2/icons/Building";
import Group from "@react-spectrum/s2/icons/Group";
import Download from "@react-spectrum/s2/icons/Download";
import ChevronDown from "@react-spectrum/s2/icons/ChevronDown";
import ChevronUp from "@react-spectrum/s2/icons/ChevronUp";
import Play from "@react-spectrum/s2/icons/Play";
import StickyNote from "@react-spectrum/s2/icons/StickyNote";
import CursorClick from "@react-spectrum/s2/icons/CursorClick";
import MagicWand from "@react-spectrum/s2/icons/MagicWand";
import Checkmark from "@react-spectrum/s2/icons/Checkmark";
import Refresh from "@react-spectrum/s2/icons/Refresh";
import Clock from "@react-spectrum/s2/icons/Clock";
import Close from "@react-spectrum/s2/icons/Close";
import AlertTriangle from "@react-spectrum/s2/icons/AlertTriangle";
import Bell from "@react-spectrum/s2/icons/Bell";
import Edit from "@react-spectrum/s2/icons/Edit";
import RocketQuickActions from "@react-spectrum/s2/icons/RocketQuickActions";
import Star from "@react-spectrum/s2/icons/Star";
import StarFilled from "@react-spectrum/s2/icons/StarFilled";
import ChartBarVert from "@react-spectrum/s2/icons/ChartBarVert";
import ChartTrend from "@react-spectrum/s2/icons/ChartTrend";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };

// Phase 1: shared S2 style helper — stretch a field/button to its container width.
const s2Full = style({ width: "full" });

// ── Viewport hook ─────────────────────────────────────────────────────────────
function useViewport(){
  const [w,setW]=useState(typeof window!=="undefined"?window.innerWidth:1280);
  useEffect(()=>{
    const h=()=>setW(window.innerWidth);
    window.addEventListener("resize",h);
    return()=>window.removeEventListener("resize",h);
  },[]);
  return{mobile:w<640,tablet:w<1024,w};
}


// ── Data ──────────────────────────────────────────────────────────────────────
const SKILLS=["AEP Segments","Analytics/CJA","Data Ingestion","AJO","RT-CDP","Marketo"];

// Single source of truth for track-code → display-name. Previously duplicated
// across 5 separate inline objects/ternaries with disagreeing copy for the
// same track (e.g. rtcdp shown as "Real-Time CDP", "RTCDP / AEP", and "Adobe
// Real-Time CDP" in different tabs) — this is the one place to edit going
// forward, and matches /api/tracks' labels for the default track set.
const TRACK_LABELS={"rtcdp":"Real-Time CDP","analytics":"Adobe Analytics","ajo":"Adobe Journey Optimizer","cja":"Customer Journey Analytics",
  "aa-sdk":"Adobe Analytics / Web SDK","target":"Adobe Target","campaign":"Adobe Campaign","marketo":"Marketo Engage",
  "da":"Data Architect","de":"Data Engineer","es":"Engineering Services"};

// The confidence threshold to unlock the Capstone gate. Was previously a
// magic 0.75 literal duplicated in Capstone() and EXPDash's cross-track
// capstone block — named here so the two can't silently drift apart.
const CAPSTONE_CONFIDENCE_GATE=0.75;

// Weekly Tracker dropdown options
const TRACKER_INDUSTRIES=["Airlines & Aviation","Automotive","B2B","Banking","Consulting","E-Commerce","Education","Energy","Government","Health","Hospitality","Insurance","Investment","Manufacturing","Media & Entertainment","Pharmaceutical","Retail","Sports","Telecom","Travel"];
const TRACKER_PHASES=["Phase 1","Phase 2","Phase 3","Phase 4","Phase 5"];
const TRACKER_STAGES=["Discovery","Planning","In Progress","UAT","Completed","On Hold"];
// Region list — Adobe consulting region assumption; adjust if your org uses different region codes
const TRACKER_REGIONS=["NA","EMEA","APAC","LATAM","Global"];
const TRACKER_HEALTH=["On track","Minor delays","At risk","Blocked","Near completion"];
const TRACKER_RENEWAL=["Yes","No","TBD"];
const HEALTH_COLOR={"On track":"#097348","Minor delays":"#B86B00","At risk":"#E34850","Blocked":"#9B1C2E","Near completion":"#2357E8"};
const MARKET=["developing","proficient","developing","gap","proficient","none"];

// Map each skill to the most relevant module ID (RTCDP track)
const SKILL_MODULE_MAP={
  "AEP Segments":4,
  "Analytics/CJA":1,
  "Data Ingestion":2,
  "AJO":7,
  "RT-CDP":1,
  "Marketo":5,
};

const TEAM=[
  {name:"Jennifer Park",role:"Analytics Eng", skills:["expert","expert","proficient","gap","developing","none"],   bw:72,persona:"exp",conf:.88,module:"Upskilling — AJO Focus",color:"#6B4EFF"},
  {name:"Alex Carter",  role:"New Joiner",    skills:["developing","developing","developing","none","none","none"], bw:85,risk:true,persona:"nj",conf:.76,module:"Module 4: Segment Evaluation Logic",color:P.blue},
  {name:"Rachel Kim",   role:"Data Engineer", skills:["proficient","expert","expert","developing","proficient","none"],bw:68,conf:.91,module:"Advanced — RT-CDP",color:P.grn},
  {name:"Kate Moore",   role:"Analytics Eng", skills:["expert","proficient","proficient","none","proficient","developing"],bw:90,conf:.85,module:"Module 7: AJO Orchestration",color:"#D7373F"},
];
const MEMBER_CERTS={"Jennifer Park":{cert:"AEP Expert",status:"Active",exp:"Mar 2027",days:270},"Alex Carter":{cert:"AEP Professional",status:"In Progress",exp:"—",days:null},"Rachel Kim":{cert:"Analytics Pro",status:"Renew Soon",exp:"Aug 2026",days:60},"Kate Moore":{cert:"AEP Expert",status:"Active",exp:"Nov 2026",days:150}};
const DEFAULT_MEMBER_PROJECTS={"Jennifer Park":["APAC-PERS","APAC-CDP","APAC-CJA"],"Alex Carter":["APAC-PERS"],"Rachel Kim":["APAC-SEG","APAC-INGEST","APAC-LOYAL"],"Kate Moore":["APAC-ONBOARD","APAC-OMNI"]};
const ALL_PROJECTS=[
  {code:"APAC-PERS",    sector:"Consumer",          title:"Real-Time Personalisation Engine",     tag:"AEP Segments",  sprint:"Sprint 3",status:"In Progress",color:P.red,   visibility:["team","project"]},
  {code:"APAC-CDP",     sector:"Technology",        title:"Customer Data Platform Migration",     tag:"RT-CDP",        sprint:"Sprint 5",status:"Planning",  color:P.blue,  visibility:["project"]},
  {code:"APAC-CJA",     sector:"Retail",            title:"Multi-Channel Attribution Rebuild",    tag:"Analytics/CJA", sprint:"Sprint 4",status:"In Progress",color:P.grn,  visibility:["team","project"]},
  {code:"APAC-ONBOARD", sector:"Financial Services",title:"Digital Onboarding Journey",          tag:"AJO",           sprint:"Sprint 4",status:"Blocked",   color:P.amber, visibility:["project","manager"]},
  {code:"APAC-SEG",     sector:"Banking",           title:"Customer Segmentation Strategy",      tag:"AEP Segments",  sprint:"Sprint 6",status:"Planning",  color:P.purple,visibility:["team"]},
  {code:"APAC-INGEST",  sector:"Retail Banking",    title:"CDP Implementation & Data Ingestion", tag:"Data Ingestion", sprint:"Sprint 2",status:"In Progress",color:P.grn, visibility:["team","project"]},
  {code:"APAC-LOYAL",   sector:"Travel",            title:"Loyalty Programme Personalisation",   tag:"RT-CDP",        sprint:"Sprint 3",status:"In Progress",color:P.blue,  visibility:["everyone"]},
  {code:"APAC-OMNI",    sector:"Retail",            title:"Omnichannel Journey Orchestration",   tag:"AJO",           sprint:"Sprint 7",status:"Planning",  color:P.amber, visibility:["team"]},
];
const MODULES=[
  {id:1,title:"Foundation & AEP Architecture",    status:"done",  conf:.91,tag:"Foundation",
    week:"1–2",theme:"Architecture",
    topics:["AEP platform overview & CX story","Technical architecture: data lake → Profile → activation","Core services: schemas, datasets, identities, profiles, segments, destinations","Sandboxes & API authentication","RTCDP introduction & differentiation from DMP/CRM"],
    elLinks:["https://experienceleague.adobe.com/docs/platform-learn/tutorials/intro-to-platform/a-customer-experience-powered-by-experience-platform.html","https://experienceleague.adobe.com/en/docs/experience-platform/rtcdp/intro/rtcdp-intro/overview"],
    deliverable:"AEP architecture sketch annotated with service responsibilities + 2–3 org-relevant use cases",
    checkpoint:"Can explain how AEP fits one real business scenario; can identify each core service"},
  {id:2,title:"Data Sources, Governance & Ingestion",status:"done",conf:.88,tag:"Foundation",
    week:"1–2",theme:"Sources, Identities & Profiles",
    topics:["Source connectors overview (Adobe Analytics, AAM, CRM, cloud storage, databases)","Data governance: labels, policies, marketing action restrictions","Streaming vs batch ingestion","Configuring dataflows and schema mapping"],
    elLinks:["https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/sources/overview","https://experienceleague.adobe.com/en/docs/experience-platform/data-governance/home"],
    deliverable:"One active source connection with a running dataflow + governance label applied",
    checkpoint:"Can explain ingestion types and what happens when a governance policy is violated"},
  {id:3,title:"Identities, Profiles & Union Schemas",status:"done",conf:.83,tag:"Foundation",
    week:"1–2",theme:"Sources, Identities & Profiles",
    topics:["Identity namespaces and identity graphs","Real-Time Customer Profile concepts","Merge policies and precedence rules","Union schemas and contributing field groups","Enabling schemas and datasets for Profile"],
    elLinks:["https://experienceleague.adobe.com/en/docs/experience-platform/identity/home","https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/profiles/understanding-the-real-time-customer-profile"],
    deliverable:"Profile-enabled schema + dataset with verified sample profiles in Profile UI",
    checkpoint:"Can open a profile, walk through unified timeline and identities, explain merge policy impact"},
  {id:4,title:"Segmentation: Batch, Streaming & Edge",status:"active",conf:.76,tag:"Core",risk:true,
    week:"1–2",theme:"Segmentation",
    topics:["Segment Builder UI and evaluation modes","Batch vs streaming vs edge segmentation","Attribute, content-based, conversion and sequential segments","Dynamic segments with rolling time windows","Multi-entity segments using schema relationships","Segment guardrails and TTL impact"],
    elLinks:["https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/audiences/audience-builder/create-audiences","https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/home"],
    deliverable:"Audience catalog: 5+ segments (simple, streaming, sequential, dynamic, suppression)",
    checkpoint:"Can articulate evaluation mode choice for each segment; time windows correct; guardrails checked"},
  {id:5,title:"Destinations & Activation",            status:"locked",tag:"Core",
    week:"2–3",theme:"Activation",
    topics:["Destination types: ad platforms, email, cloud storage, edge, custom","Connecting and configuring destinations","Identity and attribute mapping","Activation scheduling and export cadence","Non-Adobe activation (HTTP API, Kinesis, Event Hubs)","Data Landing Zone setup and segment export"],
    elLinks:["https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/destinations/understanding-destinations","https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/destinations/activate-profiles-and-segments-to-a-destination"],
    deliverable:"2+ destinations configured (cloud + ad/email) with active segments and correct identity mapping",
    checkpoint:"Activation run succeeds; can explain mapping choices and scheduling cadence"},
  {id:6,title:"Monitoring & Diagnostics",             status:"locked",tag:"Core",
    week:"2–3",theme:"Monitoring",
    topics:["Monitoring dashboard: sources, profiles, segments, destinations","Streaming ingestion monitoring (events/sec, last event time)","Batch ingestion error logs and record counts","Segment job monitoring: run time, profile counts, anomalies","Destination activation monitoring and export history"],
    elLinks:["https://experienceleague.adobe.com/en/docs/experience-platform/dataflows/ui/monitor","https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/monitoring/monitoring-dashboard"],
    deliverable:"Monitoring notes for 3 dataflows + 1 segment job + 1 activation run with error analysis",
    checkpoint:"Can locate error logs, explain status of last batch/streaming run, identify failing activations"},
  {id:7,title:"Extended Features & Agentic AI",       status:"locked",tag:"Advanced",
    week:"4–6",theme:"Extended Features",
    topics:["Federated Audience Composition (FAC) vs native RTCDP segmentation","AI Assistant in Experience Platform","Customer AI: propensity scoring and model setup","Computed attributes for behaviour summarisation","Look-Alike Audiences","Audience Portal and Audience Composer","Use Case Playbooks","Partner Data Support"],
    elLinks:["https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/ui/audience-portal","https://experienceleague.adobe.com/en/docs/platform-learn/tutorials/intelligent-services/introduction-to-customer-ai"],
    deliverable:"Sample deliverable per feature: FAC scenario sketch, Customer AI model config, computed attribute definition",
    checkpoint:"Can explain when to use FAC vs native; can define a Customer AI outcome and describe data prerequisites"},
  {id:8,title:"QA, Troubleshooting & Query Service",  status:"locked",tag:"Advanced",
    week:"4–6",theme:"QA & Troubleshooting",
    topics:["Query Service: SQL-based data validation and insight extraction","Profile qualification debugging","Segment evaluation diagnostics using monitoring and Query Service","POC and testing in QA/stage sandbox","Real-time profile qualification checks"],
    elLinks:["https://experienceleague.adobe.com/en/docs/experience-platform/query/home","https://experienceleague.adobe.com/en/docs/experience-platform/profile/guardrails"],
    deliverable:"Query Service validation queries for 3 segments + troubleshooting notes from a diagnosed issue",
    checkpoint:"Can run a SQL query to validate profile counts; can identify why a profile isn't qualifying for a segment"},
  {id:9,title:"RTCDP Business Practitioner Certification",status:"locked",tag:"Capstone",capstone:true,
    week:"6–12",theme:"Certification",
    topics:["Full RTCDP BP certification preparation","End-to-end implementation review","Practice exams and scenario walkthroughs"],
    elLinks:["https://experienceleague.adobe.com/en/docs/certification/program/overview"],
    deliverable:"RTCDP Business Practitioner Certificate",
    checkpoint:"Certification passed"},
];
// ── Team → curriculum track mapping ──────────────────────────────────────────
const TEAM_TRACK_MAP={
  "rtcdp":"rtcdp","RTCDP":"rtcdp",
  "analytics":"analytics","Analytics":"analytics",
  "da":"analytics","DA":"analytics",
  "aep-de":"rtcdp","AEP-DE":"rtcdp",
  "de":"rtcdp","DE":"rtcdp",
};
const ROLE_TRACK_MAP={
  "Analytics Analyst":"analytics","Analytics Engineer":"analytics",
  "Senior Analytics Engineer":"analytics","Data Analyst":"analytics",
  "AEP Analyst":"rtcdp","AEP Developer":"rtcdp","AEP Admin":"rtcdp",
  "Campaign Manager":"rtcdp","Other":"rtcdp",
};
// Prefer the backend-resolved `track` (grounded in the learner's manager's Track
// Focus via manager_hierarchy — the authoritative "roles depend on the mgr they
// report to" rule). Fall back to team/role string maps for demo personas that
// carry no resolved track, then to rtcdp.
const getTrack=(profile)=>profile?.track||TEAM_TRACK_MAP[profile?.team]||ROLE_TRACK_MAP[profile?.role]||"rtcdp";
// Data Architect (AEP-DA) and Data Engineer (AEP-DE) tracks — modules mirror the
// level grouping seeded into curriculum_topics (Foundations→1, Intermediate→2,
// Advanced→3). Topics themselves come from the DB; lesson-content maps stay empty.
const DA_MODULES=[
  {id:1,title:"AEP Foundations",           status:"active",tag:"Foundation",week:"1-2",deliverable:"Notes on AEP architecture, sandboxes, and core services",checkpoint:"Can explain AEP's core services and data flow"},
  {id:2,title:"Schemas, Identity & Profile",status:"locked",tag:"Core",      week:"2-3",deliverable:"A schema with identity fields; a verified profile",checkpoint:"Can model data in XDM and explain identity stitching"},
  {id:3,title:"Governance & Data Quality",  status:"locked",tag:"Advanced",  week:"3-4",deliverable:"Governance labels applied; monitoring notes",checkpoint:"Can apply data usage labels and diagnose data quality"},
];
const DE_MODULES=[
  {id:1,title:"AEP Foundations",            status:"active",tag:"Foundation",week:"1-2",deliverable:"Notes on AEP architecture and ingestion basics",checkpoint:"Can explain AEP's core services and ingestion types"},
  {id:2,title:"Ingestion & Data Prep",      status:"locked",tag:"Core",      week:"2-3",deliverable:"A working batch + streaming dataflow with Data Prep mapping",checkpoint:"Can configure ingestion and map data with Data Prep"},
  {id:3,title:"APIs, App Builder & CI/CD",  status:"locked",tag:"Advanced",  week:"4-6",deliverable:"An App Builder action or API integration",checkpoint:"Can use AEP APIs and the App Builder workflow"},
];
const ES_MODULES=[
  {id:1,title:"Deployment & CI/CD",       status:"active",tag:"Core",     week:"1-2",deliverable:"Notes on the deployment workflow and a diagnosed CI/CD issue",checkpoint:"Can describe how code ships to AEP and troubleshoot a pipeline"},
  {id:2,title:"APIs & App Builder",        status:"locked",tag:"Core",     week:"2-4",deliverable:"A working API call and an App Builder action",checkpoint:"Can call AEP APIs and build an App Builder action"},
  {id:3,title:"Destination SDK",           status:"locked",tag:"Advanced", week:"4-6",deliverable:"A configured streaming destination via Destination SDK",checkpoint:"Can build and configure a custom destination"},
];
const DA_LESSON_CONTENT={};
const DE_LESSON_CONTENT={};
const ES_LESSON_CONTENT={};
function getModulesForTrack(t){
  if(t==="analytics")return ANALYTICS_MODULES;
  if(t==="ajo")return AJO_MODULES;
  if(t==="cja")return CJA_MODULES;
  if(t==="da")return DA_MODULES;
  if(t==="de")return DE_MODULES;
  if(t==="es")return ES_MODULES;
  if(t==="target")return TARGET_MODULES;
  if(t==="marketo")return MARKETO_MODULES;
  if(t==="campaign")return CAMPAIGN_MODULES;
  if(t==="aa-sdk")return AASDK_MODULES;
  return MODULES;
}
function getLessonContentForTrack(t){
  if(t==="analytics")return ANALYTICS_LESSON_CONTENT;
  if(t==="ajo")return AJO_LESSON_CONTENT;
  if(t==="cja")return CJA_LESSON_CONTENT;
  if(t==="da")return DA_LESSON_CONTENT;
  if(t==="de")return DE_LESSON_CONTENT;
  if(t==="es")return ES_LESSON_CONTENT;
  if(t==="target")return TARGET_LESSON_CONTENT;
  if(t==="marketo")return MARKETO_LESSON_CONTENT;
  if(t==="campaign")return CAMPAIGN_LESSON_CONTENT;
  if(t==="aa-sdk")return AASDK_LESSON_CONTENT;
  return LESSON_CONTENT;
}


// ── Analytics track module titles ─────────────────────────────────────────────
const ANALYTICS_MODULES=[
  {id:1,title:"Foundation & Analytics Concepts",    status:"done",  tag:"Foundation",week:"1",
    deliverable:"2-3 business questions Adobe Analytics can answer; architecture diagram annotated",
    checkpoint:"Can describe Analytics data flow and navigate Workspace confidently"},
  {id:2,title:"Data Collection & Implementation",   status:"done",  tag:"Foundation",week:"1-2",
    deliverable:"Implementation review doc: collection method, key variables, data layer mapping",
    checkpoint:"Can read an AppMeasurement or Web SDK implementation and explain what data is captured"},
  {id:3,title:"Analysis Workspace",                 status:"active",tag:"Core",    week:"2",risk:false,
    deliverable:"Workspace project with 4+ visualization types answering real business questions",
    checkpoint:"Can build freeform tables, Flow, Fallout, and Cohort analyses from scratch"},
  {id:4,title:"Segmentation",                       status:"locked",tag:"Core",    week:"2-3",
    deliverable:"Segment library: attribute, behavior, and sequential segments saved",
    checkpoint:"Can build segments at all container levels; explain when to use each"},
  {id:5,title:"Calculated Metrics & Attribution",   status:"locked",tag:"Core",    week:"3",
    deliverable:"Calculated metric set: conversion rate, revenue per visit, filtered metric",
    checkpoint:"Can build calculated metrics; compare attribution models; recommend the right one"},
  {id:6,title:"Administration & Governance",        status:"locked",tag:"Core",    week:"3-4",
    deliverable:"Processing rule created and confirmed working; product profile configured",
    checkpoint:"Can navigate Admin Console; apply data governance labels; manage user permissions"},
  {id:7,title:"Customer Journey Analytics",         status:"locked",tag:"Advanced",week:"4-5",
    deliverable:"Working CJA Connection and Data View; Workspace project with cross-channel analysis",
    checkpoint:"Can explain CJA vs Analytics; set up Connection and Data View; run cross-channel analysis"},
  {id:8,title:"Advanced Analytics & APIs",          status:"locked",tag:"Advanced",week:"5",
    deliverable:"Scheduled Data Warehouse report; working Analytics API call documented",
    checkpoint:"Can configure Data Warehouse; make an Analytics API call; query Analytics data via Query Service"},
  {id:9,title:"Adobe Analytics Business Practitioner Certification",status:"locked",tag:"Capstone",capstone:true,week:"6+",
    deliverable:"Adobe Analytics Business Practitioner Certificate",
    checkpoint:"Certification exam passed"},
];

// ── Analytics track lesson content (parallel to LESSON_CONTENT for RTCDP) ──
const ANALYTICS_LESSON_CONTENT={
  1:[ // Foundation & Analytics Concepts
    {t:"Analytics Data Model",obj:"Understand hits, visits, visitors and how Adobe Analytics collects and structures data",act:"Log in to Analytics, open a report suite, browse the Workspace home",out:"Notes mapping hit → visit → visitor with a real example",chk:"Can explain the data collection hierarchy without looking at notes"},
    {t:"Report Suite Architecture",obj:"Understand report suites, virtual report suites, and multi-suite tagging",act:"Open Admin → Report Suites and review the org's suite structure",out:"Diagram of org's report suite architecture",chk:"Can describe when to use a global suite vs individual suites vs virtual report suites"},
    {t:"eVars, Props, and Events",obj:"Understand the three core variable types and their use cases",act:"Open Admin → Report Suite → Conversion Variables and review current eVar config",out:"Table mapping each eVar/prop to its business purpose",chk:"Can explain persistence, allocation, and expiry for eVars; counter vs currency events"},
    {t:"Data Collection Architecture",obj:"Understand how Adobe Analytics collects data: AppMeasurement, Web SDK, Mobile SDK",act:"Review the org's implementation type in Admin → Data Sources",out:"Brief implementation summary: collection method, data layer approach",chk:"Can describe AppMeasurement vs Web SDK vs Mobile SDK and when each applies"},
    {t:"Processing Rules & VISTA",obj:"Understand how data is transformed server-side before storage",act:"Open Admin → Processing Rules and review existing rules",out:"Notes on 2–3 existing processing rules and what they do",chk:"Can explain when to use processing rules vs classification vs VISTA"},
  ],
  2:[ // Data Collection & Implementation
    {t:"AppMeasurement Implementation",obj:"Understand the JavaScript library used to send data to Analytics",act:"Review the org's AppMeasurement or s_code.js file; identify core config variables",out:"Notes on s.account, linkTrackVars, and 3 key custom variables",chk:"Can read an AppMeasurement file and explain what data is sent on page load"},
    {t:"Web SDK (Alloy.js) for Analytics",obj:"Understand how Web SDK sends Analytics data via XDM and the Adobe Analytics ExperienceEvent field group",act:"Review Web SDK implementation in browser DevTools; inspect sendEvent calls",out:"Comparison of Web SDK vs AppMeasurement data flow",chk:"Can explain how XDM maps to Analytics variables via the field group"},
    {t:"Data Layer Design",obj:"Understand how a well-structured data layer improves implementation quality",act:"Inspect the org's data layer (window.digitalData or custom) in browser console",out:"Data layer audit: what's available vs what's missing",chk:"Can identify gaps between data layer and Analytics variable requirements"},
    {t:"Tags (Launch) Implementation",obj:"Understand how Adobe Analytics is deployed via Experience Platform Tags",act:"Open Tags in Data Collection UI; review the Analytics extension config and rules",out:"Notes on 3 key Tags rules that set Analytics variables",chk:"Can trace a user action to the Tags rule that fires and the Analytics variables it sets"},
    {t:"Link Tracking and Custom Events",obj:"Track clicks, downloads, and custom interactions",act:"Add a custom link tracking call in a test environment; verify in Analytics Debugger",out:"Working custom link implementation",chk:"Can implement s.tl() or alloy sendEvent for a link click and verify in debugger"},
    {t:"Mobile SDK Implementation",obj:"Understand data collection from mobile apps using AEP Mobile SDK",act:"Review mobile implementation docs; identify key lifecycle metrics",out:"Notes on lifecycle metrics, track action, and track state",chk:"Can explain the difference between trackState and trackAction; list 5 lifecycle metrics"},
  ],
  3:[ // Analysis Workspace
    {t:"Workspace Interface Overview",obj:"Navigate Analysis Workspace confidently: panels, visualizations, component rail",act:"Open a new blank project; create a freeform table with Visits, Unique Visitors, Revenue",out:"Working Workspace project with basic freeform table",chk:"Can name and explain each panel section and drag components to the right zones"},
    {t:"Freeform Tables",obj:"Build and format freeform tables for business reporting",act:"Build a table broken down by Page → Device Type → Marketing Channel with custom date ranges",out:"Formatted freeform table with breakdown and comparison",chk:"Can apply breakdown, conditional formatting, and date comparison to a freeform table"},
    {t:"Flow Visualization",obj:"Understand user paths before and after a key page or action",act:"Build a Flow from the Checkout page; interpret top entry and exit paths",out:"Flow visualization showing top paths through checkout",chk:"Can configure and read a Flow; identify top entry paths and unexpected exits"},
    {t:"Fallout Visualization",obj:"Measure conversion rates through a defined funnel",act:"Build a Fallout from Homepage → Product → Cart → Purchase",out:"Fallout chart with conversion rates at each step",chk:"Can build a multi-step Fallout and explain why each step shows a given fallout rate"},
    {t:"Cohort Analysis",obj:"Track retention of a user cohort over time",act:"Build a Cohort table: new users who visited in the last 3 months, weekly retention",out:"Cohort retention table",chk:"Can interpret a cohort table; explain inclusion vs return criteria"},
    {t:"Attribution Models in Workspace",obj:"Compare how different attribution models credit conversions to channels",act:"Add same Revenue metric with 3 attribution models (Last Touch, First Touch, Linear) side-by-side",out:"Attribution comparison table",chk:"Can explain the difference between Last Touch, First Touch, and Linear; recommend the right model for a use case"},
    {t:"Workspace Templates and Sharing",obj:"Use templates and share projects with stakeholders",act:"Browse Templates; save a project as a template; share with a colleague",out:"Shared project and custom template",chk:"Can share a Workspace project; describe scheduling a PDF report"},
  ],
  4:[ // Segmentation
    {t:"Segment Builder Overview",obj:"Understand the segment builder UI and container hierarchy",act:"Open Segment Builder; explore visitor, visit, and hit containers",out:"Notes on container hierarchy with a real example",chk:"Can explain the difference between visitor, visit, and hit containers and when to use each"},
    {t:"Visitor Segments",obj:"Build persistent, person-level audiences",act:"Create a segment: visitors who have purchased in the last 90 days",out:"Saved visitor segment with correct container",chk:"Visitor count is plausible; can explain why Visitor container is required"},
    {t:"Visit Segments",obj:"Target sessions with specific behaviors",act:"Create a segment: visits that started from paid search and converted",out:"Saved visit-level segment",chk:"Can explain what constitutes a 'visit'; segment count makes business sense"},
    {t:"Sequential Segments",obj:"Build order-dependent behavior segments",act:"Create: visited Product page then Cart page (in order) within the same visit",out:"Sequential segment using 'then' operator",chk:"Can configure sequence with time constraint; explain THEN vs AND"},
    {t:"Segment Sharing & Audience Publishing",obj:"Share segments to Experience Cloud and publish to Audience Manager",act:"Share a segment with another Analytics user; enable Audience Publishing for an eligible segment",out:"Shared segment + published audience",chk:"Can explain Audience Publishing eligibility; describe how segments reach AAM"},
    {t:"Segment Comparison",obj:"Use Segment Comparison panel to find statistically significant differences",act:"Compare two segments (converters vs non-converters) using the Segment Comparison panel",out:"Comparison with top differentiating metrics and dimensions",chk:"Can interpret p-value and top differentiators; explain a business insight from the comparison"},
  ],
  5:[ // Calculated Metrics & Attribution
    {t:"Calculated Metric Builder",obj:"Build custom metrics from existing metrics and operators",act:"Create: Conversion Rate = Orders / Visits; format as percentage",out:"Saved calculated metric visible in Workspace",chk:"Can build a basic calculated metric; apply correct format and decimal places"},
    {t:"Advanced Calculated Metrics",obj:"Use functions and conditional logic in metrics",act:"Create: Revenue per New Visitor = Revenue / (Visitors where Visit Number = 1)",out:"Metric with segment filter applied",chk:"Can apply a segment inside a calculated metric; explain the difference from applying segment at table level"},
    {t:"Participation and Attribution Metrics",obj:"Build attribution-aware calculated metrics",act:"Create a Revenue metric with Linear attribution; compare to Last Touch in the same table",out:"Side-by-side attribution comparison",chk:"Can configure attribution model inside a metric; explain credit distribution"},
    {t:"Attribution IQ",obj:"Understand all Attribution IQ models and their business use cases",act:"Apply each model to Orders metric in one table; document what changes and why",out:"Attribution model comparison table with business rationale",chk:"Can recommend the right attribution model for three different business questions"},
    {t:"Predictive Analytics",obj:"Use Analytics contributions and anomaly detection features",act:"Enable Anomaly Detection on a metric; identify and explain one anomaly",out:"Anomaly detection chart with investigation notes",chk:"Can enable anomaly detection; interpret statistical bounds; explain one detected anomaly"},
  ],
  6:[ // Administration & Governance
    {t:"Admin Console & Product Profiles",obj:"Manage user access and permissions in Adobe Admin Console",act:"Open Admin Console; review product profile for Analytics; add a test user",out:"Product profile with correct permission groups",chk:"Can explain Admin Console vs Analytics Admin; add a user with correct product profile"},
    {t:"Report Suite Configuration",obj:"Configure core report suite settings",act:"Review General Settings, Traffic Variables, Conversion Variables, Success Events",out:"Gap analysis: what's configured vs what should be",chk:"Can navigate all key report suite settings; identify 2 gaps or improvements"},
    {t:"Data Governance & Privacy",obj:"Apply DULE labels and configure privacy settings in Analytics",act:"Review Data Governance settings in Analytics Admin; check if report suite is enabled",out:"Notes on current privacy label coverage",chk:"Can describe the Data Governance workflow; explain delete and opt-out behavior in Analytics"},
    {t:"Classification Rules & SAINT",obj:"Enrich raw values with human-readable labels using classifications",act:"Create a classification rule set for a Campaign tracking code; import sample data",out:"Working classification with at least 3 rules",chk:"Can explain automatic vs manual classification; demonstrate a lookup that enriches a raw tracking code"},
    {t:"Data Feeds",obj:"Export raw hit-level data to a cloud storage location",act:"Review existing data feeds in Admin; understand the column manifest",out:"Notes on data feed schedule, columns, and destination",chk:"Can explain what a data feed exports; describe the typical post-processing workflow"},
    {t:"Data Warehouse",obj:"Run large segmented exports of summarised data",act:"Submit a Data Warehouse request with a segment, date range, and 5 dimensions/metrics",out:"Completed Data Warehouse report in cloud storage",chk:"Can submit a DW request; explain the difference from Workspace export and when DW is the right tool"},
  ],
  7:[ // Customer Journey Analytics
    {t:"CJA vs Adobe Analytics",obj:"Understand the architectural and feature differences between CJA and Analytics",act:"Review the CJA overview doc; list 5 things CJA can do that Analytics cannot",out:"Comparison table: CJA vs Analytics",chk:"Can articulate 3 customer scenarios where CJA is the better choice"},
    {t:"CJA Connection Setup",obj:"Create a CJA Connection that pulls datasets from AEP",act:"Create a Connection using 2 AEP datasets; verify batch status",out:"Active CJA Connection with datasets ingesting",chk:"Can create a Connection; explain the difference between event, profile, and lookup datasets"},
    {t:"Data Views in CJA",obj:"Configure dimensions and metrics for a CJA project",act:"Create a Data View; add 5 dimensions and 5 metrics; configure persistence for one dimension",out:"Working Data View attached to the Connection",chk:"Can explain what a Data View is; configure component labels, formats, and attribution"},
    {t:"Cross-Channel Analysis in CJA",obj:"Stitch cross-device journeys using CJA's Stitching feature",act:"Review Stitching overview; identify datasets suitable for stitching in the org",out:"Stitching candidate analysis",chk:"Can explain field-based vs graph-based stitching; describe the replay mechanism"},
    {t:"CJA Analysis Workspace",obj:"Build CJA projects using familiar Workspace components with cross-channel data",act:"Build a Workspace project in CJA with a multi-channel Fallout and Cohort table",out:"CJA Workspace project with cross-channel analysis",chk:"Can highlight 3 capabilities in CJA Workspace not available in AA Workspace"},
    {t:"B2B Analytics in CJA",obj:"Understand CJA B2B edition and account-based reporting",act:"Review B2B CJA documentation; identify 2 relevant B2B use cases for the org",out:"B2B CJA use case notes",chk:"Can explain Account-Based Analytics; describe how CJA B2B differs from person-based"},
  ],
  8:[ // Advanced Analytics & APIs
    {t:"Analytics API 2.0",obj:"Query Analytics data programmatically using the Reporting API",act:"Make a Reporting API call via Postman; retrieve Visits by Page for last 7 days",out:"Working API call with JSON response",chk:"Can construct an Analytics API request; explain the metrics, dimensions, and globalFilters structure"},
    {t:"Livestream API",obj:"Understand real-time hit-level data streaming from Analytics",act:"Review Livestream documentation; identify use cases for real-time processing",out:"Livestream use case notes",chk:"Can explain what Livestream delivers; describe 2 real-time use cases"},
    {t:"Data Insertion API",obj:"Send server-side hit data directly to Analytics",act:"Submit a test hit via Data Insertion API; verify receipt in real-time report",out:"Confirmed server-side hit in Analytics",chk:"Can explain when to use Data Insertion vs AppMeasurement; submit a valid API hit"},
    {t:"Report Builder",obj:"Pull Analytics data into Excel for scheduled reporting",act:"Install Report Builder; create a request for top 10 pages by visits; schedule delivery",out:"Scheduled Excel report",chk:"Can create a Report Builder request; schedule delivery to SharePoint or email"},
    {t:"Activity Map",obj:"Visualise click data overlaid on the web page",act:"Enable Activity Map; load a page and inspect link click data",out:"Activity Map overlay screenshot with observations",chk:"Can enable Activity Map; interpret the link click overlay; explain the data collection method"},
  ],
  9:[ // Certification Capstone
    {t:"Adobe Analytics Business Practitioner Exam Prep",obj:"Complete all preparation for the Adobe Analytics Business Practitioner certification",act:"Review exam guide; complete Adobe-recommended practice assessments",out:"Adobe Analytics Business Practitioner Certificate",chk:"Certification exam passed"},
  ],
};

// ── AJO Modules ──────────────────────────────────────────────────────────────
// AJO modules mirror the 4 modules actually seeded into curriculum_topics
// (3 general modules from AdobeDocs/journey-optimizer.en + 1 B2B module from
// the journey-optimizer-b2b.en repo). The previous 9-module list here had no
// backing content at all (no DB rows, no el_url) — replaced rather than left
// alongside real data, since half of it would 404 on every lesson.
const AJO_MODULES=[
  {id:1,title:"AJO Foundations",  status:"active",tag:"Foundation",week:"1-2",deliverable:"Notes on permissions, audiences, and journey activities",checkpoint:"Can explain AJO's core building blocks"},
  {id:2,title:"Journeys & Actions",status:"locked",tag:"Core",     week:"2-3",deliverable:"Notes on journey configuration and custom actions",checkpoint:"Can configure a journey action and describe event/data-source setup"},
  {id:3,title:"Reporting & Configuration",status:"locked",tag:"Advanced",week:"3-4",deliverable:"Notes on reporting, sharing, and landing-page configuration",checkpoint:"Can interpret AJO reports and describe channel configuration"},
  {id:4,title:"AJO B2B Edition",  status:"locked",tag:"Advanced",  week:"4",  deliverable:"Notes on account audiences and buying groups",checkpoint:"Can explain B2B-specific concepts: account audiences, buying groups"},
];
const TARGET_MODULES=[
  {id:1,title:"Target Foundations",       status:"active",tag:"Foundation",week:"1-2",deliverable:"Notes on Target basics and feature flags",checkpoint:"Can explain Target's core concepts and feature-flag basics"},
  {id:2,title:"Offers & Activities",      status:"locked",tag:"Core",      week:"2-3",deliverable:"An offer and a feature flag configured in a sandbox",checkpoint:"Can create an offer/activity and a feature flag"},
  {id:3,title:"Automation & Personalization",status:"locked",tag:"Advanced",week:"3-4",deliverable:"Notes on automated personalization and content setup",checkpoint:"Can describe automated allocation and personalization activities"},
];
const MARKETO_MODULES=[
  {id:1,title:"Marketo Foundations",  status:"active",tag:"Foundation",week:"1-2",deliverable:"Setup checklist reviewed for a Marketo instance",checkpoint:"Can explain what Marketo Engage is and its setup steps"},
  {id:2,title:"Setup & Administration",status:"locked",tag:"Core",     week:"2-3",deliverable:"Notes on protocol configuration and admin setup",checkpoint:"Can configure protocols and complete admin setup steps"},
  {id:3,title:"Sales Tools & Predictive Content",status:"locked",tag:"Advanced",week:"3-4",deliverable:"Notes on Sales Insight/Connect and predictive content",checkpoint:"Can describe Target Account Management and predictive content patterns"},
];
const CAMPAIGN_MODULES=[
  {id:1,title:"Campaign Foundations",  status:"active",tag:"Foundation",week:"1-2",deliverable:"Notes on Campaign Classic architecture and environments",checkpoint:"Can explain Campaign Classic's core concepts"},
  {id:2,title:"Schema & Data Model",   status:"locked",tag:"Core",      week:"2-3",deliverable:"A reviewed schema with the org's recipient/data model",checkpoint:"Can describe the Campaign data model and schema structure"},
  {id:3,title:"Optimization & Delivery",status:"locked",tag:"Advanced",week:"3-4",deliverable:"Notes on campaign optimization, typologies, and web services",checkpoint:"Can explain campaign optimization and typology rules"},
];
// AA-SDK (Adobe Analytics / Web SDK) — modules mirror the 3 modules seeded into
// curriculum_topics from AdobeDocs/experience-platform.en (help/collection/js,
// help/collection/identity, help/collection/use-cases). Topics come from the DB.
const AASDK_MODULES=[
  {id:1,title:"Web SDK Foundations",              status:"active",tag:"Foundation",week:"1-2",deliverable:"Notes mapping legacy libraries to the Web SDK; working base-code install",checkpoint:"Can explain what the Web SDK replaces and how it bootstraps"},
  {id:2,title:"Configuration & Implementation",   status:"locked",tag:"Core",      week:"2-4",deliverable:"Working configure + sendEvent calls with an XDM payload",checkpoint:"Can configure a datastream and send an XDM-aligned event"},
  {id:3,title:"Identity, Consent & Personalization",status:"locked",tag:"Advanced",week:"4-6",deliverable:"identityMap payload, consent test, one personalization pattern implemented",checkpoint:"Can manage identity/consent and implement a personalization rendering pattern"},
];

// ── CJA Modules ──────────────────────────────────────────────────────────────
// CJA modules mirror the 3 modules actually seeded into curriculum_topics from
// AdobeDocs/analytics-platform.en (verified live-fetching docs). The previous
// 9-module list had no DB backing at all — same treatment as AJO above.
const CJA_MODULES=[
  {id:1,title:"CJA Foundations",     status:"active",tag:"Foundation",week:"1-2",deliverable:"Notes on CJA vs Adobe Analytics and the CJA/B2B editions",checkpoint:"Can explain CJA's core concepts and when to recommend it over AA"},
  {id:2,title:"Reporting & Analysis",status:"locked",tag:"Core",      week:"2-3",deliverable:"Notes on Report Builder and reporting activity",checkpoint:"Can describe Report Builder and reporting activity monitoring"},
  {id:3,title:"Workspace & Export",  status:"locked",tag:"Advanced",  week:"3-4",deliverable:"Notes on Freeform tables and project export",checkpoint:"Can build a Freeform table and export a project"},
];

// ── AJO lesson content ────────────────────────────────────────────────────────
// Real content now comes from curriculum_topics (verified live-fetched docs);
// no frontend fallback text needed — matches the DA/DE/ES pattern.
const AJO_LESSON_CONTENT={};
const TARGET_LESSON_CONTENT={};
const MARKETO_LESSON_CONTENT={};
const CAMPAIGN_LESSON_CONTENT={};
const AASDK_LESSON_CONTENT={};

// Real content now comes from curriculum_topics (verified live-fetched docs).
const CJA_LESSON_CONTENT={};

// ── PROFILES · single source of truth, simulates fetch from Adobe IMS ─────────
const PROFILES={
  nj:{
    name:"Alex Carter",initial:"A",color:"#2357E8",
    role:"New Joiner",team:"AEP Analytics APAC",tenure:"Week 3",
    bw:85,conf:.76,
    skills:["developing","developing","developing","none","none","none"],
    module:"Module 4: Segment Evaluation Logic",activeModuleIdx:3,
    cert:{name:"AEP Professional Certification",status:"In Progress",exp:"Estimated Q3 2026",days:null},
    badges:[{label:"Week 1 Complete"},{label:"3 Modules Done"},{label:"Socratic Sessions: 4"}],
    projects:["APAC-Q3-SEGMENTS"],
    story:"Week 3 · 3 of 9 modules complete · Stuck on Module 4 for 6 days · Confidence just above the gate",
    shadow:{project:"APAC Q3 Segments Launch",sector:"APAC Consumer",mentor:"Jennifer Park",role:"Observer",milestone:"Go-live Aug 14",skills:["AEP Segments","Data Ingestion"]},
  },
  nj2:{
    name:"Sam Chen",initial:"S",color:"#0891B2",
    role:"New Joiner",team:"AEP Analytics APAC",tenure:"Week 1",
    bw:100,conf:.38,
    skills:["none","none","none","none","none","none"],
    module:"Module 1: AEP Foundations",activeModuleIdx:0,
    cert:{name:"AEP Professional Certification",status:"Not started",exp:"—",days:null},
    badges:[{label:"Day 1"}],
    projects:[],
    story:"Week 1 · Just started · Capstone locked until confidence reaches 75 · No risk flags yet",
    shadow:{project:"APAC Q3 Segments Launch",sector:"APAC Consumer",mentor:"Jennifer Park",role:"Observer — read-only access",milestone:"Observing kick-off",skills:["AEP Foundations"]},
  },
  // Demo: new joiner who has JUST cleared both capstone gates (all modules done +
  // confidence ≥75%) but hasn't started the capstone yet — shows the real
  // Capstone Agent generate → submit → AI-eval flow from a clean, unlocked state.
  // demoForceCapstoneUnlocked overrides the shared static MODULES progress
  // (which is otherwise the same array every NJ persona reads from) purely for
  // this demo profile, since per-learner module completion isn't tracked
  // separately in this demo dataset.
  nj3:{
    name:"Priya Sharma",initial:"P",color:"#C2410C",
    role:"New Joiner",team:"AEP Analytics APAC",tenure:"Week 8",
    bw:90,conf:.82,
    skills:["proficient","proficient","developing","developing","none","none"],
    module:"Capstone",activeModuleIdx:8,
    demoForceCapstoneUnlocked:true,
    cert:{name:"AEP Professional Certification",status:"In Progress",exp:"Estimated Q3 2026",days:null},
    badges:[{label:"All Modules Complete"},{label:"Confidence Gate Cleared"},{label:"Capstone Ready"}],
    projects:["APAC-Q3-SEGMENTS"],
    story:"Week 8 · All modules complete · Confidence at 82% — gate cleared · Capstone unlocked, not yet started",
    shadow:{project:"APAC Q3 Segments Launch",sector:"APAC Consumer",mentor:"Jennifer Park",role:"Observer",milestone:"Go-live Aug 14",skills:["AEP Segments","Data Ingestion"]},
  },
  demo:{
    name:"Demo User",initial:"D",color:"#6030D0",
    role:"Analytics Engineer",team:"RTCDP",tenure:"Year 1",
    bw:100,conf:0.88,
    skills:["expert","expert","proficient","none","developing","none"],
    module:"Module 4: Segmentation",activeModuleIdx:3,
    capstone_completed:true,
    capstone_completed_at:"2024-08-15T10:30:00Z",
    cert:{name:"RTCDP Business Practitioner",status:"Ready to attempt",exp:"—",days:null},
    badges:[{label:"Capstone Champion"},{label:"Year 1 Complete"},{label:"3 Skills Expert"}],
    projects:["RTCDP-PERS","RTCDP-CDP"],
    story:"Capstone complete · 9 modules done · AJO is a critical gap on the team · Choose a cross-skill track to continue growing",
    persona:"exp",
  },
  exp:{
    name:"Jennifer Park",initial:"J",color:"#097348",
    role:"Analytics Engineer",team:"AEP Analytics APAC",tenure:"3 years",
    bw:72,conf:.88,
    skills:["expert","expert","proficient","none","developing","none"],
    cert:{name:"AEP Expert Certification",status:"Active",exp:"Mar 2027",days:270},
    badges:[{label:"AEP Expert"},{label:"5-Day Streak"},{label:"First Test-Out"},{label:"Top Contributor"}],
    projects:["APAC-PERS","APAC-CDP","APAC-CJA"],
    story:"3 years · AJO is a critical gap on the team · Market demand is high · 2 skill gaps to close",
  },
  // Demo: experienced employee who has just cleared the capstone gate (all
  // modules + confidence ≥75%) but hasn't done their capstone yet — pairs with
  // nj3 to show the same Capstone Agent flow from both dashboards side by side.
  // Distinct from `demo`, which shows the *already-completed* capstone screen.
  exp2:{
    name:"Raj Mehta",initial:"R",color:"#0F766E",
    role:"Analytics Engineer",team:"AEP Analytics APAC",tenure:"2 years",
    bw:78,conf:.81,
    skills:["expert","proficient","proficient","developing","none","none"],
    demoForceCapstoneUnlocked:true,
    cert:{name:"AEP Expert Certification",status:"In Progress",exp:"—",days:null},
    badges:[{label:"All Modules Complete"},{label:"Confidence Gate Cleared"}],
    projects:["APAC-CDP"],
    story:"2 years · All modules complete · Confidence at 81% — gate cleared · Capstone unlocked, not yet started",
  },
  mgr:{
    name:"Michael Torres",initial:"M",color:"#B86B00",
    role:"People Manager",team:"AEP Analytics APAC",tenure:"5 years",
    bw:60,conf:.91,
    skills:["expert","expert","expert","proficient","proficient","developing"],
    cert:{name:"AEP Expert Certification",status:"Active",exp:"Jun 2027",days:380},
    badges:[{label:"AEP Expert"},{label:"People Manager"},{label:"Team Lead"}],
    projects:[],
    story:"4 direct reports · 1 at risk · 1 cert expiring in 60 days · Team velocity 18% ahead of baseline",
  },
  admin:{
    name:"Emma Wilson",initial:"E",color:"#6030D0",
    role:"Platform Admin",team:"Nexus Platform",tenure:"—",
    bw:100,conf:null,skills:[],
    cert:{name:"—",status:"—",exp:"—",days:null},badges:[],projects:[],
    story:"Platform health: 4 of 7 services connected · 28 agent calls · 11,713 tokens used",
  },
};
// Community threads/points are now real, backend-persisted — see
// /api/community/* endpoints and the Community/NJCommunity components.
// ── Knowledge Base — search any AEP concept, AI routes to right docs ─────────
// ── Product release notes — monthly entries per product ──────────────────────
const KB_CURATED=[
  {tag:"AJO",       product:"ajo",     items:["Journey canvas & entry events","Email surface & deliverability","Frequency capping","Decision management & offers","Suppression lists","Push & SMS channels","Personalisation expressions","Journey reporting"]},
  {tag:"CJA",       product:"cja",     items:["Connection setup","Data views & components","Calculated metrics","Attribution models","Cross-channel stitching","Workspace in CJA","B2B analytics","Sharing & governance"]},
  {tag:"Analytics", product:"analytics",items:["Analysis Workspace","eVars, props & events","Report suites","Segmentation & containers","Calculated metrics","Attribution IQ","Data Warehouse","Analytics API 2.0"]},
  {tag:"RTCDP",     product:"rtcdp",   items:["Identity namespaces","Profile fragments & merge","Audience activation","Destination setup","Batch vs streaming segmentation","Real-time profile lookup","Data governance labels","Federated Audience Composition"]},
  {tag:"Data Ingestion", product:"rtcdp", items:["XDM schema design","Source connectors","Streaming HTTP API","Batch ingestion CSV","Profile-enabled datasets","Query Service","Data Prep mappings","Monitoring dashboard"]},
];

// Fallback link per product if a fetched entry is ever missing its own
// source_url — the real entries (see ReleaseNotes() below, /api/release-notes)
// carry the exact page they were parsed from, so this is rarely needed.
const RELEASE_NOTES_DOCS_URL={
  AEP:"https://experienceleague.adobe.com/en/docs/experience-platform/release-notes/latest",
  AJO:"https://experienceleague.adobe.com/en/docs/journey-optimizer/using/whats-new/release-notes",
  CJA:"https://experienceleague.adobe.com/en/docs/analytics-platform/using/releases/latest",
  Analytics:"https://experienceleague.adobe.com/en/docs/analytics/release-notes/latest",
  WebSDK:"https://experienceleague.adobe.com/en/docs/experience-platform/web-sdk/release-notes",
};

// Best-effort type badge from real title/description text — the parsed source
// docs don't carry a clean "type" field, so this is a label, not fabricated
// content (the title/desc themselves are the real, unmodified text).
function _rnType(title, desc){
  const t=(title+" "+(desc||"")).toLowerCase();
  if(/\bfix(e[sd])?\b/.test(t))return"Fix";
  if(/\bbeta\b/.test(t))return"Beta";
  if(/\bga\b|general availability/.test(t))return"New";
  return"Enhancement";
}

function ReleaseNotes(){
  const PRODUCTS=["AEP","AJO","CJA","Analytics","WebSDK"];
  const TYPE_COLORS={New:P.grn,Enhancement:P.blue,Beta:P.purple,Fix:P.amber};
  const PROD_COLORS={AEP:P.blue,AJO:P.red,CJA:P.purple,Analytics:P.grn,WebSDK:P.amber};
  const [prod,setProd]=useState("All");
  const [month,setMonth]=useState("All");
  const [search,setSearch]=useState("");
  const [all,setAll]=useState([]);
  const [loading,setLoading]=useState(true);
  const [err,setErr]=useState(null);

  useEffect(()=>{
    fetch(`${BACKEND}/api/release-notes`).then(r=>r.json())
      .then(d=>{
        setAll((d.entries||[]).map(e=>({
          product:e.product, date:e.period||"", title:e.title, desc:e.description||"",
          type:_rnType(e.title,e.description), tags:[], sourceUrl:e.source_url,
        })));
        setLoading(false);
      })
      .catch(()=>{setErr("Could not load release notes.");setLoading(false);});
  },[]);

  const months=[...new Set(all.map(e=>e.date))].filter(Boolean).sort((a,b)=>new Date("1 "+b)-new Date("1 "+a));

  const visible=all.filter(e=>{
    if(prod!=="All"&&e.product!==prod)return false;
    if(month!=="All"&&e.date!==month)return false;
    if(search&&![e.title,e.desc,...(e.tags||[])].join(" ").toLowerCase().includes(search.toLowerCase()))return false;
    return true;
  });

  return(
    <div style={{maxWidth:800,margin:"0 auto",padding:"24px"}}>
      <div style={{marginBottom:20}}>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:1.2,textTransform:"uppercase",color:getThemeMode()==="dark"?"#FF6A5C":"#EB1000",marginBottom:6}}>What's new</div>
        <div style={{fontSize:24,fontWeight:700,letterSpacing:-.5,color:P.txt,marginBottom:4}}>Release Notes</div>
        <div style={{fontSize:13,color:P.muted}}>Monthly product releases — AEP · AJO · CJA · Adobe Analytics · WebSDK</div>
      </div>

      {/* Filters */}
      <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap",alignItems:"center"}}>
        {["All",...PRODUCTS].map(p=>{
          const c=PROD_COLORS[p]||P.blue; const active=prod===p;
          return(<button key={p} onClick={()=>setProd(p)}
            style={{fontSize:12,fontWeight:active?700:400,padding:"4px 12px",borderRadius:20,cursor:"pointer",fontFamily:"inherit",
              background:active?(c):"transparent",color:active?"#fff":c,border:`1px solid ${active?c:c+"50"}`}}>{p}</button>);
        })}
        <div style={{flex:1}}/>
        <select value={month} onChange={e=>setMonth(e.target.value)}
          style={{border:`1px solid ${P.border}`,borderRadius:7,padding:"4px 10px",fontSize:12,color:P.txt,background:P.bg,outline:"none",fontFamily:"inherit"}}>
          <option value="All">All months</option>
          {months.map(m=><option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {/* Search */}
      <div style={{position:"relative",marginBottom:18}}>
        <input value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Search release notes..."
          style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:9,padding:"9px 36px 9px 14px",
            fontSize:13.5,color:P.txt,background:P.bg,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
        {search&&<button onClick={()=>setSearch("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
          background:"transparent",border:"none",fontSize:14,color:P.muted,cursor:"pointer"}}>✕</button>}
      </div>

      {/* Count */}
      {!loading&&!err&&<div style={{fontSize:11.5,color:P.dim,marginBottom:12}}>{visible.length} release{visible.length===1?"":"s"} found — parsed live from each product's Experience League release-notes page</div>}
      {loading&&<div style={{padding:"24px 0",textAlign:"center",color:P.muted,fontSize:13}}>Loading release notes…</div>}
      {err&&<div style={{padding:"24px 0",textAlign:"center",color:P.red,fontSize:13}}>{err}</div>}

      {/* Entries */}
      {!loading&&!err&&<div style={{display:"flex",flexDirection:"column",gap:10}}>
        {visible.map((e,i)=>(
          <Card key={i} style={{padding:"16px 18px"}}>
            <div style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:8,flexWrap:"wrap"}}>
              {/* Product badge */}
              <span style={{fontSize:10.5,fontWeight:500,color:PROD_COLORS[e.product]||P.blue,
                background:(PROD_COLORS[e.product]||P.blue)+"18",borderRadius:5,padding:"2px 8px",flexShrink:0}}>
                {e.product}
              </span>
              {/* Type badge */}
              <span style={{fontSize:10.5,fontWeight:600,color:TYPE_COLORS[e.type]||P.muted,
                background:(TYPE_COLORS[e.type]||P.muted)+"18",borderRadius:5,padding:"2px 8px",flexShrink:0}}>
                {e.type}
              </span>
              <span style={{fontSize:11,color:P.dim,marginLeft:"auto",flexShrink:0}}>{e.date}</span>
            </div>
            <div style={{fontSize:14,fontWeight:600,color:P.txt,marginBottom:6}}>{e.title}</div>
            <div style={{fontSize:13,color:P.muted,lineHeight:1.6,marginBottom:10}}>{e.desc}</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
              {(e.tags||[]).map(tag=>(
                <span key={tag} style={{fontSize:10.5,color:P.dim,background:P.surface,
                  border:`1px solid ${P.border}`,borderRadius:5,padding:"1px 7px"}}>{tag}</span>
              ))}
              {(e.sourceUrl||RELEASE_NOTES_DOCS_URL[e.product])&&
                <a href={e.sourceUrl||RELEASE_NOTES_DOCS_URL[e.product]} target="_blank" rel="noreferrer"
                  style={{fontSize:11,fontWeight:600,color:PROD_COLORS[e.product]||P.blue,marginLeft:"auto",
                    display:"inline-flex",alignItems:"center",gap:3,textDecoration:"none"}}>
                  Read more on Experience League <Ic as={ChevronRight} size={11} color={PROD_COLORS[e.product]||P.blue}/>
                </a>}
            </div>
          </Card>
        ))}
        {visible.length===0&&(
          <div style={{textAlign:"center",color:P.muted,padding:40,fontSize:13}}>No release notes match your filters.</div>
        )}
      </div>}
    </div>
  );
}

function KnowledgeBase({groqKey,track="rtcdp"}){
  const [query,setQuery]=useState("");
  const [results,setResults]=useState([]);
  const [aiAnswer,setAiAnswer]=useState(null);
  const [searching,setSearching]=useState(false);
  const [expanded,setExpanded]=useState(null);

  const search=async(q)=>{
    const qr=q||query;
    if(!qr.trim())return;
    setSearching(true);setAiAnswer(null);setResults([]);
    try{
      // Real RAG agent: retrieve -> rerank -> generate, server-side (this is
      // also the one path RAGAS scores — see /api/agents/rag -> agents/rag.py
      // run_rag() -> evaluate_and_log("rag", ...)).
      const r=await fetch(`${BACKEND}/api/agents/rag`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({messages:[{role:"user",content:qr}],track,extra:{query:qr}})});
      const d=await r.json();
      const citations=(d?.citations||[]).map(c=>({title:c.title,url:c.url,content:c.excerpt}));
      setResults(citations);
      setAiAnswer(d?.answer||null);
    }catch(e){}
    setSearching(false);
  };

  const handleKey=e=>{if(e.key==="Enter")search();};

  const isDark=getThemeMode()==="dark";
  const ACCENT="#EB1000";
  const ACCTX=isDark?"#FF6A5C":ACCENT;
  const ACCBG=isDark?"rgba(235,16,0,.12)":"#FFF1ED";

  return(
    <div style={{maxWidth:800,margin:"0 auto",padding:"24px"}}>
      {/* Search bar */}
      <div style={{marginBottom:24}}>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:1.2,textTransform:"uppercase",color:ACCTX,marginBottom:6}}>Knowledge Base</div>
        <div style={{fontSize:24,fontWeight:700,letterSpacing:-.5,color:P.txt,marginBottom:4}}>Search the docs</div>
        <div style={{fontSize:13,color:P.muted,marginBottom:14}}>
          Search across AJO · CJA · Adobe Analytics · RTCDP · AEP
          {track&&track!=="rtcdp"&&<span style={{color:ACCTX,fontWeight:600}}> · showing <strong>{TRACK_LABELS[track]||"AEP"}</strong> topics first</span>}
        </div>
        <div style={{display:"flex",gap:8}}>
          <input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={handleKey}
            placeholder="e.g. how does streaming segmentation work? or merge policy explained..."
            style={{flex:1,border:`1.5px solid ${P.border}`,borderRadius:10,padding:"11px 16px",fontSize:14,color:P.txt,background:P.bg,outline:"none",fontFamily:"inherit"}}/>
          <Btn onClick={()=>search()} disabled={searching||!query.trim()} size="lg">
            {searching?"Searching…":<>Search <Ic as={ChevronRight} size={14} color="currentColor"/></>}
          </Btn>
        </div>
      </div>

      {/* AI Answer */}
      {aiAnswer&&(
        <div style={{background:ACCBG,border:`1px solid ${ACCENT}25`,borderRadius:12,padding:"16px 20px",marginBottom:20}}>
          <div style={{fontSize:11,fontWeight:700,color:ACCTX,letterSpacing:.5,textTransform:"uppercase",marginBottom:8,display:"flex",alignItems:"center",gap:6}}><Ic as={MagicWand} size={13} color={ACCTX}/> AI Answer</div>
          <div style={{fontSize:13.5,color:P.txt,lineHeight:1.75}}>{aiAnswer}</div>
        </div>
      )}

      {/* RAG results */}
      {results.length>0&&(
        <div style={{marginBottom:24}}>
          <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",marginBottom:10}}>Source documentation ({results.length} matches) · from the Nexus knowledge base</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {results.map((doc,i)=>(
              <div key={i} style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:10,overflow:"hidden"}}>
                {/* In-platform only — the full excerpt is shown here; no external
                    redirect. The content lives in the Nexus knowledge base. */}
                <div onClick={()=>setExpanded(expanded===i?null:i)}
                  style={{padding:"12px 16px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13.5,fontWeight:600,color:ACCTX,marginBottom:3}}>{doc.title||"AEP Documentation"}</div>
                    <div style={{fontSize:12,color:P.muted}}>{doc.repo||"Knowledge base"}</div>
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0,marginLeft:12}}>
                    <span style={{fontSize:11,color:P.dim}}>{expanded===i?"Hide":"Read"}</span>
                    <Ic as={expanded===i?ChevronUp:ChevronDown} size={15} color={P.muted}/>
                  </div>
                </div>
                {expanded===i&&doc.content&&(
                  <div style={{padding:"0 16px 14px",fontSize:12.5,color:P.muted,lineHeight:1.7,borderTop:`1px solid ${P.bfaint}`}}>
                    <div style={{paddingTop:10,whiteSpace:"pre-line"}}>{doc.content}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!searching&&results.length===0&&!aiAnswer&&(
        <div>
          <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",marginBottom:12}}>Browse by topic</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {[...KB_CURATED].sort((a,b)=>{
        const trackPriority={analytics:"Analytics",ajo:"AJO",cja:"CJA",rtcdp:"RTCDP"}[track]||"RTCDP";
        if(a.tag===trackPriority)return -1;
        if(b.tag===trackPriority)return 1;
        return 0;
      }).map(cat=>(
              <Card key={cat.tag} style={{padding:"14px 16px"}}>
                <div style={{fontSize:12.5,fontWeight:500,color:P.txt,marginBottom:10}}>{cat.tag}</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                  {cat.items.map(item=>(
                    <button key={item} onClick={()=>{setQuery(item);search(item);}}
                      style={{background:P.surface,border:`1px solid ${P.border}`,borderRadius:8,padding:"6px 12px",fontSize:12.5,fontWeight:600,color:P.txt,cursor:"pointer",fontFamily:"inherit"}}>
                      {item}
                    </button>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── NJ Community data ────────────────────────────────────────────────────────

// Visibility levels: "everyone" | "team" | "project" | "manager"
// everyone = all platform users · team = all 4 team members · project = assigned members only · manager = manager only
const INIT_ISSUES={
  "APAC-PERS":[
    {id:1,title:"Streaming segment not qualifying for real-time personalisation in UAT",product:"RTCDP",status:"Open",priority:"High",time:"Today",visibility:["team","project"]},
    {id:2,title:"Batch evaluation job timing out on large APAC-PERS audience datasets",product:"RTCDP",status:"In Progress",priority:"Medium",time:"Yesterday",visibility:["project"]},
    {id:3,title:"Schema validation failing for new loyalty identity namespace",product:"RTCDP",status:"Done",priority:"Low",time:"3d ago",visibility:["everyone"]},
  ],
  "APAC-CDP":[
    {id:4,title:"RT-CDP profile merge rules conflicting with legacy CRM identities",product:"RTCDP",status:"Open",priority:"High",time:"2d ago",visibility:["project"]},
    {id:5,title:"Data ingestion latency above SLA on APAC-CDP event stream",product:"General",status:"In Progress",priority:"High",time:"3d ago",visibility:["team","project"]},
  ],
  "APAC-CJA":[
    {id:6,title:"Attribution window config for cross-device app-to-web journeys",product:"Analytics",status:"Open",priority:"High",time:"1d ago",visibility:["project"]},
  ],
  "APAC-ONBOARD":[
    {id:7,title:"AJO journey not triggering on mobile OTP verification event",product:"AJO",status:"Open",priority:"High",time:"Today",visibility:["project"]},
    {id:8,title:"Alex Carter performance note — struggling with AJO triggers (Week 3)",product:"AJO",status:"Open",priority:"Medium",time:"Today",visibility:["manager"]},
  ],
  "APAC-SEG":[],
  "APAC-INGEST":[{id:9,title:"Initial data model review for APAC-INGEST customer schema",product:"General",status:"In Progress",priority:"Medium",time:"4d ago",visibility:["team"]}],
  "APAC-LOYAL":[{id:10,title:"Loyalty tier segment evaluation logic — batch vs streaming decision",product:"RTCDP",status:"Open",priority:"Medium",time:"2d ago",visibility:["everyone"]}],
  "APAC-OMNI":[],
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const SC=s=>({none:{bg:"#F0F0EE",fg:P.dim,bd:"#E0E0E0"},developing:{bg:"#FFE3DE",fg:"#C1360B",bd:"#F3C3B8"},proficient:{bg:"#FF8A7A",fg:"#fff",bd:"#F5715F"},expert:{bg:"#EB1000",fg:"#fff",bd:"#C90D00"},gap:{bg:"#FFF3F2",fg:P.red,bd:P.red}}[s]||{bg:"#F0F0EE",fg:P.dim,bd:"#E0E0E0"});
const LBadge=({s})=>{const c=SC(s);return<span style={{background:c.bg,border:`1px solid ${c.bd}`,color:c.fg,borderRadius:5,padding:"2px 9px",fontSize:10.5,fontWeight:600,textTransform:"capitalize",whiteSpace:"nowrap"}}>{s==="gap"?"Gap":s||"none"}</span>;};
const Pill=({s,label})=>{const c=SC(s);return<span style={{background:c.bg,color:c.fg,border:`1px solid ${c.bd}`,borderRadius:5,padding:"2px 8px",fontSize:10.5,fontWeight:600,textTransform:"uppercase"}}>{label||s}</span>;};
const Card=({children,style={},hover=false})=>{
  const [hov,setHov]=useState(false);
  return<div onMouseEnter={hover?()=>setHov(true):undefined} onMouseLeave={hover?()=>setHov(false):undefined}
    style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,
      boxShadow:hov?P.shadowHv:P.shadow,transition:"box-shadow .2s,border-color .2s",
      borderColor:hov?P.dim:P.border,...style}}>{children}</div>;
};
const TagPill=({tag})=>{const c={"Platform Q&A":{bg:P.blueGh,color:P.blue},"Projects":{bg:P.grnBg,color:P.grn},"Cross-skilling":{bg:P.purpleBg,color:P.purple}}[tag]||{bg:P.bfaint,color:P.muted};return<span style={{...c,fontSize:10.5,fontWeight:600,borderRadius:5,padding:"1px 7px"}}>{tag}</span>;};
const StatusDot=({ok})=><span style={{width:7,height:7,borderRadius:"50%",background:ok?P.grn:P.red,display:"inline-block",flexShrink:0}}/>;
const PriorityBadge=({p:pri})=><span style={{fontSize:10.5,fontWeight:600,padding:"2px 9px",borderRadius:5,background:pri==="High"?P.redBg:pri==="Medium"?P.amberBg:P.bfaint,color:pri==="High"?P.red:pri==="Medium"?P.amber:P.dim}}>{pri}</span>;
const StatusBadge=({s})=><span style={{fontSize:10.5,fontWeight:600,padding:"2px 9px",borderRadius:5,background:s==="Done"?P.grnBg:s==="In Progress"?P.blueGh:P.bfaint,color:s==="Done"?P.grn:s==="In Progress"?P.blue:P.muted}}>{s}</span>;

// Visibility system
const VIS_OPTIONS=[
  {key:"everyone",  label:"Everyone",      color:"#097348", note:"All platform users"},
  {key:"team",      label:"Team members",  color:"#2357E8", note:"All 4 team members"},
  {key:"project",   label:"Project members",color:"#6030D0",note:"Assigned to this project"},
  {key:"manager",   label:"Manager only",  color:"#B86B00", note:"Not visible to team"},
];
const canViewIssue=(issue,persona,projectCode,memberProjects,memberName)=>{
  const v=issue.visibility||["team"];
  if(v.includes("everyone"))return true;
  if(persona==="mgr")return true;
  if(v.includes("manager"))return false;
  if(v.includes("team"))return true;
  if(v.includes("project")){
    const assigned=(memberProjects[memberName]||[]).includes(projectCode);
    return assigned;
  }
  return false;
};
function VisibilitySelector({visibility=[],onChange}){
  const [open,setOpen]=useState(false);
  const toggle=(key)=>{
    const next=visibility.includes(key)?visibility.filter(k=>k!==key):[...visibility,key];
    if(next.length>0)onChange(next);
  };
  const colors=visibility.map(k=>VIS_OPTIONS.find(o=>o.key===k)?.color||P.muted);
  return(
    <div style={{position:"relative"}}>
      <button onClick={e=>{e.stopPropagation();setOpen(o=>!o);}}
        style={{background:P.surface,border:`1px solid ${P.border}`,borderRadius:7,padding:"3px 8px",fontSize:11,cursor:"pointer",display:"flex",alignItems:"center",gap:5,fontFamily:"inherit",color:P.muted}}>
        <div style={{display:"flex",gap:2}}>
          {colors.map((c,i)=><div key={i} style={{width:6,height:6,borderRadius:"50%",background:c}}/>)}
        </div>
        <span>Visibility</span>
      </button>
      {open&&<div style={{position:"absolute",right:0,top:"100%",marginTop:4,background:P.panel,border:`1px solid ${P.border}`,borderRadius:10,padding:8,zIndex:100,minWidth:200,boxShadow:P.shadowHv}}>
        {VIS_OPTIONS.map(opt=>(
          <label key={opt.key} onClick={e=>e.stopPropagation()} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 10px",borderRadius:7,cursor:"pointer",background:visibility.includes(opt.key)?opt.color+"12":"transparent"}}>
            <input type="checkbox" checked={visibility.includes(opt.key)} onChange={()=>toggle(opt.key)} style={{accentColor:opt.color,width:13,height:13}}/>
            <div>
              <div style={{fontSize:12.5,fontWeight:600,color:opt.color}}>{opt.label}</div>
              <div style={{fontSize:10.5,color:P.muted}}>{opt.note}</div>
            </div>
          </label>
        ))}
        <div style={{marginTop:4,padding:"6px 10px",borderTop:`1px solid ${P.bfaint}`,fontSize:10.5,color:P.dim}}>Select all that apply</div>
      </div>}
      {open&&<div style={{position:"fixed",inset:0,zIndex:99}} onClick={()=>setOpen(false)}/>}
    </div>
  );
}

// ── Design system helpers ─────────────────────────────────────────────────────
// Custom pill button (Adobe red). Uses fixed px sizing so it is never affected
// by the S2 --s2-scale, keeping button proportions consistent on every page and
// on touch-capable desktops. (Reverted from the S2 Button, which mis-scaled.)
const Btn=({children,variant="primary",size="md",onClick,disabled,full=false,style={}})=>{
  const [hov,setHov]=useState(false);
  const isDark=getThemeMode()==="dark";
  const v={
    // Dark theme: match the Home "Get started" hero button — white outline,
    // white text, fills white (dark text) on hover. Light theme: solid red pill.
    primary:isDark
      ?{background:hov?"#fff":"transparent",color:hov?"#1B1B1B":"#fff",border:"2px solid #fff"}
      :{background:hov?"#C90D00":"#EB1000",color:"#fff",border:"none"},
    secondary:{background:hov?P.surface:"transparent",color:P.txt,border:`1px solid ${P.border}`},
    ghost:{background:hov?P.surface:"transparent",color:P.muted,border:"none"},
    danger:{background:hov?"#c0271f":P.red,color:"#fff",border:"none"},
    success:{background:hov?"#3A3A3A":P.grn,color:"#fff",border:"none"},
  }[variant]||{};
  const s={
    sm:{padding:"5px 15px",fontSize:12,borderRadius:999,letterSpacing:-.1},
    md:{padding:"8px 20px",fontSize:13.5,borderRadius:999,letterSpacing:-.1},
    lg:{padding:"12px 26px",fontSize:14.5,borderRadius:999,letterSpacing:-.2},
  }[size]||{};
  return<button onClick={onClick} disabled={disabled}
    onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
    style={{...v,...s,fontWeight:600,cursor:disabled?"default":"pointer",opacity:disabled?.45:1,
      fontFamily:"inherit",display:"inline-flex",alignItems:"center",justifyContent:"center",
      gap:6,width:full?"100%":"auto",whiteSpace:"nowrap",transition:"background .15s,color .15s,border-color .15s,opacity .15s",...style}}>{children}</button>;
};
const Label=({children,style={}})=><div style={{fontSize:10.5,fontWeight:600,letterSpacing:.7,textTransform:"uppercase",color:P.dim,...style}}>{children}</div>;
// Inline S2 icon renderer — sizes the icon and tints it via --iconPrimary
const Ic=({as:C,size=16,color,style={}})=><C UNSAFE_style={{width:size,height:size,flexShrink:0,...(color?{"--iconPrimary":color}:{}),...style}}/>;
// Profile avatar images: default Adobe avatar for new joiners, real photos for
// experienced/manager/admin personas. Real registered users key off their email.
const DEFAULT_AVATAR="https://i.imgur.com/kJOwAdv.png";
const IMG_AVATARS={exp:"https://i.pravatar.cc/160?img=12",nj2:"https://i.pravatar.cc/160?img=5",mgr:"https://i.pravatar.cc/160?img=33",admin:"https://i.pravatar.cc/160?img=48"};
const avatarSrc=(persona)=>IMG_AVATARS[persona]||DEFAULT_AVATAR;
// A real user's chosen emoji+color always wins over the generic persona stock
// photo — this is the one place that decides what "your avatar" looks like,
// used everywhere (header, profile page, sidebar) so a saved change shows up
// consistently instead of some spots reverting to the stock photo.
function UserAvatarCircle({emoji,color,persona,alt,size=32}){
  if(emoji) return(
    <div style={{width:size,height:size,borderRadius:"50%",flexShrink:0,
      background:color?`linear-gradient(135deg,${color},${color}bb)`:P.blue,
      display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",
      fontWeight:500,fontSize:Math.round(size*0.45),lineHeight:1}}>
      {emoji}
    </div>
  );
  return <Avatar src={avatarSrc(persona)} alt={alt} size={size}/>;
}

// ── Global styles ─────────────────────────────────────────────────────────────
const GlobalStyles=()=>{
  useEffect(()=>{
    // Viewport meta for responsive
    let vm=document.querySelector('meta[name="viewport"]');
    if(!vm){vm=document.createElement("meta");vm.name="viewport";document.head.appendChild(vm);}
    vm.content="width=device-width, initial-scale=1.0, maximum-scale=1.0";
    // Inter font
    const link=document.createElement("link");
    link.rel="stylesheet";
    link.href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@300;400;500;600;700;800&display=swap";
    document.head.appendChild(link);
    const el=document.createElement("style");
    el.textContent=`
      *{box-sizing:border-box;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;margin:0;padding:0;}
      html,body{height:100%;width:100%;margin:0;padding:0;}
      #root{height:100%;width:100%;max-width:none!important;margin:0!important;padding:0!important;text-align:left!important;}
      body{font-family:'adobe-clean','Source Sans 3',system-ui,-apple-system,sans-serif;background:#fff;}
      button{font-family:inherit;cursor:pointer;}
      input,textarea,select{font-family:inherit;}
      ::-webkit-scrollbar{width:4px;height:4px;}
      ::-webkit-scrollbar-track{background:transparent;}
      ::-webkit-scrollbar-thumb{background:rgba(128,128,160,.18);border-radius:99px;}
      ::-webkit-scrollbar-thumb:hover{background:rgba(128,128,160,.32);}
      input:focus{outline:2px solid #2357E8;outline-offset:0;}
      .nx-gcard:focus{outline:none;}
      .nx-gcard:focus-visible{outline:2.5px solid #fff;outline-offset:2px;box-shadow:0 0 0 4px rgba(0,0,0,.25);}
      .nx-gcard{transition:transform .18s ease, box-shadow .22s ease;}
      .nx-gcard:hover{transform:translateY(-5px);box-shadow:0 16px 34px rgba(0,0,0,.16)!important;}
      .nx-btn{transition:transform .12s ease, background-color .18s ease, color .18s ease;}
      .nx-btn:active{transform:scale(.96);}
      .nx-redbtn:hover{background:rgba(235,16,0,.09)!important;}
      .nx-redbtn:active{background:#EB1000!important;color:#fff!important;}
      .nx-whitebtn:hover{background:rgba(255,255,255,.14)!important;}
      .nx-whitebtn:active{background:#fff!important;color:#241640!important;}
      textarea:focus{outline:2px solid #2357E8;outline-offset:0;}
      ::selection{background:#2357E820;}
      /* Responsive container */
      .nx-container{width:100%;max-width:100%;padding:0 clamp(12px,2vw,24px);}
      .nx-card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;}
      /* Responsive font sizes */
      .nx-h1{font-size:clamp(15px,2vw,18px);font-weight:700;}
      .nx-h2{font-size:clamp(13px,1.5vw,15px);font-weight:600;}
      /* Fluid modal */
      .nx-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:flex-start;justify-content:center;padding:clamp(12px,3vh,40px) clamp(8px,2vw,20px);overflow-y:auto;}
      .nx-modal{border-radius:18px;width:100%;max-width:min(96vw,900px);box-shadow:0 20px 60px rgba(0,0,0,.25);}
      /* Responsive nav */
      @media(max-width:768px){
        .nx-nav-tabs{overflow-x:auto;-webkit-overflow-scrolling:touch;flex-wrap:nowrap!important;}
        .nx-nav-tab{white-space:nowrap;padding:10px 12px!important;font-size:12px!important;}
        .nx-sidebar{display:none!important;}
        .nx-main-content{flex:1!important;padding-left:0!important;}
      }
      @media(max-width:480px){
        .nx-two-col{flex-direction:column!important;}
      }
    `;
    document.head.appendChild(el);
    return()=>{try{document.head.removeChild(el);document.head.removeChild(link);}catch{}};
  },[]);
  return null;
};

// ── Arc ───────────────────────────────────────────────────────────────────────
const pt=(cx,cy,r,d)=>{const a=d*Math.PI/180;return{x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)};};
const ap=(cx,cy,r,s,e)=>{const sp=pt(cx,cy,r,s),ep=pt(cx,cy,r,e);const sw=((e-s)%360+360)%360;return`M ${sp.x.toFixed(1)} ${sp.y.toFixed(1)} A ${r} ${r} 0 ${sw>180?1:0} 1 ${ep.x.toFixed(1)} ${ep.y.toFixed(1)}`;};
function Arc({val=.62,gate=.75,size=130}){
  const r=size*.36,cx=size/2,cy=size*.55,S=135,T=270,gp=pt(cx,cy,r,S+gate*T);
  return(<svg width={size} height={size*.76} viewBox={`0 0 ${size} ${size*.76}`}>
    <path d={ap(cx,cy,r,S,S+T)} fill="none" stroke="#EAEAEA" strokeWidth={9} strokeLinecap="round"/>
    <path d={ap(cx,cy,r,S,S+val*T)} fill="none" stroke={val<gate?P.amber:P.grn} strokeWidth={9} strokeLinecap="round"/>
    <circle cx={gp.x} cy={gp.y} r={6} fill={P.amber} stroke="#fff" strokeWidth={2}/>
    <text x={cx} y={cy-4} textAnchor="middle" fontWeight={700} fontSize={size*.22} fill={P.txt}>{Math.round(val*100)}</text>
    <text x={cx} y={cy+12} textAnchor="middle" fontSize={size*.085} fill={P.muted}>/ 100</text>
    <text x={cx} y={cy+25} textAnchor="middle" fontSize={size*.072} fill={P.amber}>gate · {Math.round(gate*100)}</text>
  </svg>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// IRT · BKT · CAT · TELEMETRY ENGINES
// ═══════════════════════════════════════════════════════════════════════════════


// ── Telemetry Engine — tracks learner events and derives at-risk signals ──────
const TELEMETRY = {
  // Derive at-risk score (0-1) from event log for a persona
  atRiskScore:(events,persona)=>{
    const pEvents=events.filter(e=>e.persona===persona);
    if(pEvents.length===0)return 0;
    let score=0;
    // Low message frequency — few interactions in last 10 events
    const recent=pEvents.slice(-10);
    if(recent.length<3)score+=0.3;
    // Failed quiz attempts
    const fails=recent.filter(e=>e.type==="quiz_fail").length;
    score+=Math.min(0.4,fails*0.15);
    // Confidence stall
    const confEvents=pEvents.filter(e=>e.type==="conf_update");
    if(confEvents.length>=3){
      const last3=confEvents.slice(-3).map(e=>e.conf);
      if(last3.every(c=>c<0.75)&&Math.max(...last3)-Math.min(...last3)<0.05)score+=0.3;
    }
    return Math.min(1,score);
  },
  levelLabel:(score)=>score>0.6?"High Risk":score>0.3?"Watch":"On Track",
  levelColor:(score,P)=>score>0.6?P.red:score>0.3?P.amber:P.grn,
};
// Base template stays in AGENT_CONFIGS (editable in Prompt Lab).
// Actual API calls use base + live context block appended from profile.
// Was entirely fictional demo data (TEAM/MEMBER_CERTS/ALL_PROJECTS/INIT_ISSUES)
// while the UI claimed "live data from Adobe IMS" — now built from the manager's
// actual registered team (dbMembers), real progress/points/at-risk aggregates
// (liveSummary, from /api/team/live-summary), real persisted skill assessments
// (teamSkills, from /api/skills/team), and real imported project data
// (teamProjects, from /api/projects/tracker-table) — every field here comes
// from a live backend fetch, nothing hardcoded or sample.
function buildManagerContext(dbMembers,liveSummary,teamSkills,teamProjects){
  const members=dbMembers||[];
  const summaryByName=Object.fromEntries((liveSummary?.members||[]).map(m=>[m.name,m]));
  const skillsByName={};
  (teamSkills||[]).forEach(s=>{(skillsByName[s.member_name]=skillsByName[s.member_name]||[]).push(`${s.skill}:${s.level}`);});

  const teamLines=members.length?members.map(m=>{
    const s=summaryByName[m.name]||{};
    const atRisk=s.days_since_joining!=null&&s.days_since_joining>56&&!s.capstone_completed;
    return `  • ${m.name} (${m.team||"—"}): track ${s.track||m.active_track||"—"}, ${s.modules_done||0} modules done, ${s.points||0} points${atRisk?" ⚠ AT RISK (>56 days, capstone not done)":""}`;
  }).join("\n"):"  No approved team members registered yet.";

  const skillLines=Object.entries(skillsByName).map(([n,s])=>`  • ${n}: ${s.join(", ")}`).join("\n")||"  No skill assessments taken yet.";

  const projRows=teamProjects||[];
  const projLines=projRows.length?projRows.map(p=>
    `  • ${p.title||p.project_code||"Untitled"} — ${p.member_name||"unassigned"} [${p.health_status||p.status||"—"}, ${p.hrs_per_week||0}h/wk${p.phase?`, ${p.phase}`:""}]`+
    (p.weekly_comments?`\n    Latest note: ${p.weekly_comments}`:"")
  ).join("\n"):"  No projects imported yet (Admin → Tracker Import).";
  const atRiskNames=liveSummary?.at_risk_names||[];
  const blocked=projRows.filter(p=>(p.health_status||p.status||"").toLowerCase().match(/blocked|at risk/));
  const renewalsDue=projRows.filter(p=>(p.renewal||"").toLowerCase()==="yes"||(p.days_remaining!=null&&p.days_remaining<=30));
  return`\n\n--- Team data (from your registered directory + real module/points/skill records) ---\n\nTEAM STATUS:\n${teamLines}\n\nSKILL ASSESSMENTS:\n${skillLines}\n\nAT-RISK FLAGS:\n${atRiskNames.length?atRiskNames.map(n=>`  • ${n}`).join("\n"):"  None currently"}\n\n--- Project data (from the imported tracker — real, current) ---\nCLIENT PROJECTS (${projRows.length}):\n${projLines}\n\nBLOCKED / AT-RISK PROJECTS:\n${blocked.length?blocked.map(p=>`  • ${p.title} — ${p.member_name} (${p.health_status||p.status})`).join("\n"):"  None currently"}\n\nRENEWALS / DEADLINES WITHIN 30 DAYS:\n${renewalsDue.length?renewalsDue.map(p=>`  • ${p.title} — ${p.member_name}${p.days_remaining!=null?` (${p.days_remaining}d left)`:""}${p.renewal?.toLowerCase()==="yes"?" [renewal]":""}`).join("\n"):"  None currently"}`;
}

// ── ChatMarkdown — lightweight, safe markdown-to-JSX for chat bubbles
// (**bold**, *italic*, `code`, "- " bullet lists). Builds real React elements
// instead of dangerouslySetInnerHTML, since this renders live LLM output —
// no raw HTML injection risk. Deliberately much smaller than the full lesson
// -content renderer (renderAdobeMarkdown), which is built for whole documents
// (headings, images, AdobeDocs metadata) and would be the wrong tool here.
function _inlineMdToNodes(text,keyPrefix){
  const nodes=[];
  const re=/\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\n]+)\*/g;
  let last=0,m,i=0;
  while((m=re.exec(text))){
    if(m.index>last)nodes.push(text.slice(last,m.index));
    if(m[1]!==undefined)nodes.push(<strong key={`${keyPrefix}-${i++}`}><em>{m[1]}</em></strong>);
    else if(m[2]!==undefined)nodes.push(<strong key={`${keyPrefix}-${i++}`}>{m[2]}</strong>);
    else if(m[3]!==undefined)nodes.push(<code key={`${keyPrefix}-${i++}`} style={{background:P.surface,padding:"1px 5px",borderRadius:4,fontSize:"0.92em"}}>{m[3]}</code>);
    else if(m[4]!==undefined)nodes.push(<em key={`${keyPrefix}-${i++}`}>{m[4]}</em>);
    last=re.lastIndex;
  }
  if(last<text.length)nodes.push(text.slice(last));
  return nodes;
}
function ChatMarkdown({text}){
  const lines=(text||"").split("\n");
  const blocks=[];
  let list=[];
  const flushList=(key)=>{
    if(list.length){ blocks.push(<ul key={`ul-${key}`} style={{margin:"4px 0",paddingLeft:18}}>{list}</ul>); list=[]; }
  };
  lines.forEach((line,idx)=>{
    const bullet=line.match(/^\s*[-•]\s+(.*)$/);
    if(bullet){
      list.push(<li key={`li-${idx}`} style={{marginBottom:2}}>{_inlineMdToNodes(bullet[1],`li${idx}`)}</li>);
    } else {
      flushList(idx);
      if(line.trim()==="")blocks.push(<div key={`br-${idx}`} style={{height:6}}/>);
      else blocks.push(<div key={`p-${idx}`}>{_inlineMdToNodes(line,`p${idx}`)}</div>);
    }
  });
  flushList("end");
  return <>{blocks}</>;
}

// ── Team Intel Agent — plain LLM call grounded entirely in live backend data ──
function ManagerAgent({profile,groqKey,onLog,dbMembers,liveSummary,teamSkills,teamProjects}){
  const p=profile||PROFILES.mgr;
  const [msgs,setMsgs]=useState([{role:"assistant",content:`Hi ${p.displayName||p.name}. I have your registered team's real progress, points, skill assessments, and imported project data. What would you like to know?`}]);
  const [input,setInput]=useState(""),[busy,setBusy]=useState(false);
  const ref=useRef(null);
  const suggestions=["Who is at risk right now?","Which projects are blocked or at risk?","Who has the most modules completed?","Which team members have taken a skill assessment?","Any renewals or deadlines coming up in the next 30 days?","What's everyone's current hrs/week across projects?"];
  useEffect(()=>{if(ref.current)ref.current.scrollTop=ref.current.scrollHeight;},[msgs]);

  const send=async(text)=>{
    const msg=text||input.trim();
    if(!msg||busy)return;
    const nm={role:"user",content:msg},next=[...msgs,nm];
    setMsgs(next);setInput("");setBusy(true);
    try{
      const sys=AGENT_CONFIGS.managerIntel.sys+buildManagerContext(dbMembers,liveSummary,teamSkills,teamProjects);
      const r=await callAgent(next.map(m=>({role:m.role,content:m.content})),sys,groqKey,{agentName:"ManagerIntel",logFn:onLog,maxTokens:400});
      setMsgs(prev=>[...prev,{role:"assistant",content:r}]);
    }catch(e){setMsgs(prev=>[...prev,{role:"assistant",content:`Error: ${e.message}`}]);}
    setBusy(false);
  };

  return(<div style={{display:"flex",flexDirection:"column",height:"100%"}}>
    <div style={{padding:"7px 14px",background:P.amberBg,borderBottom:`1px solid ${P.amber}30`,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
      <span style={{fontSize:11.5,color:P.amber,fontWeight:600}}>🧭 Team Intelligence · real team + project data</span>
      <span style={{fontSize:11,color:groqKey?P.grn:P.dim}}>{groqKey?"🟢 Groq":"Claude Sonnet"}</span>
    </div>
    {msgs.length===1&&<div style={{padding:"14px 16px",flexShrink:0}}>
      <div style={{fontSize:11.5,fontWeight:600,color:P.muted,marginBottom:9}}>💡 Try asking</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
        {suggestions.map(s=>(
          <button key={s} onClick={()=>send(s)}
            style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:20,padding:"6px 14px",fontSize:12.5,
              cursor:"pointer",color:P.txt,fontFamily:"inherit",transition:"background .15s, border-color .15s"}}
            onMouseEnter={e=>{e.currentTarget.style.background=P.amberBg;e.currentTarget.style.borderColor=P.amber+"50";}}
            onMouseLeave={e=>{e.currentTarget.style.background=P.panel;e.currentTarget.style.borderColor=P.border;}}>
            {s}
          </button>
        ))}
      </div>
    </div>}
    <div ref={ref} style={{flex:1,overflowY:"auto",padding:14,display:"flex",flexDirection:"column",gap:10}}>
      {msgs.map((m,i)=>(
        <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",gap:8,alignItems:"flex-end"}}>
          {m.role==="assistant"&&<div style={{width:28,height:28,borderRadius:"50%",background:`linear-gradient(135deg,${P.amber},#c96d00)`,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:11,fontWeight:500,flexShrink:0}}>🧭</div>}
          <div style={{maxWidth:"80%",padding:"10px 14px",borderRadius:m.role==="user"?"10px 10px 3px 10px":"10px 10px 10px 3px",background:m.role==="user"?`linear-gradient(135deg,${P.amber},#c96d00)`:P.panel,color:m.role==="user"?"#fff":P.txt,border:m.role==="assistant"?`1px solid ${P.border}`:"none",fontSize:13,lineHeight:1.7}}>
            {m.role==="assistant"?<ChatMarkdown text={m.content}/>:<span style={{whiteSpace:"pre-line"}}>{m.content}</span>}
          </div>
        </div>
      ))}
      {busy&&<div style={{display:"flex",gap:8,alignItems:"flex-end"}}><div style={{width:28,height:28,borderRadius:"50%",background:`linear-gradient(135deg,${P.amber},#c96d00)`,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:11}}>🧭</div><div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:"10px 10px 10px 3px",padding:"9px 14px",fontSize:13,color:P.muted}}><span style={{letterSpacing:3}}>···</span></div></div>}
    </div>
    <div style={{borderTop:`1px solid ${P.border}`,padding:"10px 12px",display:"flex",gap:8,flexShrink:0}}>
      <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&send()} placeholder="Ask about team progress, projects, issues, go-lives…" style={{flex:1,border:`1px solid ${P.border}`,borderRadius:7,padding:"8px 12px",fontSize:13,outline:"none",background:P.bg,color:P.txt}}/>
      <button onClick={()=>send()} disabled={busy} style={{background:`linear-gradient(135deg,${P.amber},#c96d00)`,color:"#fff",border:"none",borderRadius:7,padding:"8px 18px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Ask</button>
    </div>
  </div>);
}


// ── Nav + Tabs ────────────────────────────────────────────────────────────────
// ── Global notification bell (Nav) — unread count + dropdown, polls the same
// /api/notifications endpoints the community feature writes to via _notify().
function NavBell({memberName}){
  const [items,setItems]=useState([]);
  const [unread,setUnread]=useState(0);
  const [open,setOpen]=useState(false);
  const load=()=>{ if(!memberName)return;
    fetch(`${BACKEND}/api/notifications?member_name=${encodeURIComponent(memberName)}`).then(r=>r.json())
      .then(d=>{setItems(d?.notifications||[]);setUnread(d?.unread||0);}).catch(()=>{}); };
  useEffect(()=>{load();const iv=setInterval(load,45000);return()=>clearInterval(iv);},[memberName]);
  const markRead=async(id)=>{ setItems(p=>p.map(n=>n.id===id?{...n,is_read:true}:n)); setUnread(u=>Math.max(0,u-1));
    try{await fetch(`${BACKEND}/api/notifications/${id}/read`,{method:"PUT"});}catch(e){} };
  const markAll=async()=>{ setItems(p=>p.map(n=>({...n,is_read:true}))); setUnread(0);
    try{await fetch(`${BACKEND}/api/notifications/read-all?member_name=${encodeURIComponent(memberName)}`,{method:"PUT"});}catch(e){} };
  const emoji={mention:"💬",reply:"↩️",public_post:"🌐",approval:"✅",decline:"⚠️",weekly_reminder:"🗓️",capstone_complete:"🏆"};
  if(!memberName)return null;
  return(
    <div style={{position:"relative",flexShrink:0}}>
      <button onClick={()=>setOpen(o=>!o)} aria-label="Notifications" title="Notifications"
        style={{position:"relative",background:open?P.hovGrey:"transparent",border:"none",borderRadius:9,padding:"7px",cursor:"pointer",display:"flex",alignItems:"center"}}>
        <Ic as={Bell} size={18} color={unread>0?P.txt:P.muted}/>
        {unread>0&&<span style={{position:"absolute",top:2,right:2,minWidth:16,height:16,padding:"0 4px",boxSizing:"border-box",background:P.red,color:"#fff",borderRadius:99,fontSize:9.5,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1}}>{unread>9?"9+":unread}</span>}
      </button>
      {open&&<>
        <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,zIndex:40}}/>
        <div style={{position:"absolute",top:"calc(100% + 6px)",right:0,width:320,maxHeight:420,overflowY:"auto",background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,boxShadow:P.shadow,zIndex:41}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"11px 14px",borderBottom:`1px solid ${P.border}`,position:"sticky",top:0,background:P.panel}}>
            <span style={{fontSize:13,fontWeight:600,color:P.txt}}>Notifications{unread>0?` · ${unread}`:""}</span>
            {unread>0&&<button onClick={markAll} style={{fontSize:11,color:P.blue,background:"transparent",border:"none",cursor:"pointer",fontFamily:"inherit",padding:0}}>Mark all read</button>}
          </div>
          {items.length===0&&<div style={{padding:"24px 14px",textAlign:"center",fontSize:12.5,color:P.muted}}>You're all caught up.</div>}
          {items.map(n=>(
            <div key={n.id} onClick={()=>{ if(!n.is_read)markRead(n.id);
                if(["mention","reply","kudos","public_post"].includes(n.type)){ setOpen(false); window.dispatchEvent(new CustomEvent("nexus:navigate",{detail:{tab:"community",thread_id:n.thread_id}})); } }}
              style={{display:"flex",gap:10,padding:"10px 14px",borderBottom:`1px solid ${P.bfaint}`,cursor:"pointer",background:n.is_read?"transparent":P.blueGh}}>
              <span style={{fontSize:16,flexShrink:0,lineHeight:1.3}}>{emoji[n.type]||"🔔"}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12.5,fontWeight:n.is_read?400:600,color:P.txt,marginBottom:1}}>{n.title}</div>
                {n.message&&<div style={{fontSize:11.5,color:P.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{n.message}</div>}
                <div style={{fontSize:10.5,color:P.dim,marginTop:2}}>{timeAgo(n.created_at)}</div>
              </div>
              {!n.is_read&&<span style={{width:8,height:8,borderRadius:99,background:P.blue,flexShrink:0,marginTop:4}}/>}
            </div>
          ))}
        </div>
      </>}
    </div>
  );
}

function Nav({initial,name,sub,color,badge,onLogout,progress,onToggleTheme,avatarEmoji,persona,onGoToProfile}){
  const isDark=getThemeMode()==="dark";
  const [menuOpen,setMenuOpen]=useState(false);
  return(<nav style={{background:P.panel,borderBottom:`1px solid ${P.border}`,padding:"0 24px",display:"flex",alignItems:"center",height:54,gap:14,flexShrink:0,position:"relative",zIndex:10}}>
    {/* Progress ribbon */}
    {progress!=null&&<div style={{position:"absolute",bottom:0,left:0,right:0,height:2,background:P.bfaint}}>
      <div style={{height:"100%",width:`${Math.min(100,progress)}%`,background:progress>=75?`linear-gradient(90deg,${P.grn},#C9CCD6)`:progress>=50?`linear-gradient(90deg,${P.blue},#FF7A70)`:`linear-gradient(90deg,${P.amber},#FCD34D)`,transition:"width 1s ease",borderRadius:"0 2px 2px 0"}}/>
    </div>}
    {/* Logo */}
    <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
      <AdobeMark size={26}/>
      <div>
        <div style={{fontSize:14,fontWeight:500,color:P.txt,letterSpacing:-.4,lineHeight:1}}>Nexus</div>
        <div style={{fontSize:9.5,color:P.dim,letterSpacing:.8,textTransform:"uppercase",lineHeight:1.3,fontWeight:500}}>Adobe Internal</div>
      </div>
    </div>
    {badge&&<span style={{background:P.amberBg,color:P.amber,border:`1px solid ${P.amber}30`,borderRadius:6,fontSize:10,padding:"2px 9px",fontWeight:500,letterSpacing:.5,textTransform:"uppercase",flexShrink:0}}>{badge}</span>}
    <div style={{flex:1}}/>
    <NavBell memberName={name}/>
    {/* User — avatar opens an account menu (theme switch + sign out) */}
    <div style={{position:"relative",flexShrink:0}}>
      <button onClick={()=>setMenuOpen(o=>!o)} aria-label="Account menu" aria-expanded={menuOpen}
        style={{display:"flex",alignItems:"center",gap:9,background:menuOpen?P.hovGrey:"transparent",border:"none",borderRadius:10,padding:"3px 6px 3px 10px",cursor:"pointer",fontFamily:"inherit"}}>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:13,fontWeight:600,color:isDark?"#fff":P.txt,lineHeight:1.2,letterSpacing:-.2}}>{name}</div>
          <div style={{fontSize:10.5,color:isDark?"rgba(255,255,255,.7)":P.dim,lineHeight:1.3}}>{sub}</div>
        </div>
        <UserAvatarCircle emoji={avatarEmoji} color={color} persona={persona} alt={name} size={32}/>
      </button>
      {menuOpen&&<>
        <div style={{position:"fixed",inset:0,zIndex:40}} onClick={()=>setMenuOpen(false)}/>
        <div role="menu" style={{position:"absolute",top:46,right:0,width:270,background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,boxShadow:P.shadowHv,zIndex:50,padding:"14px 14px 8px",overflow:"hidden"}}>
          <div style={{display:"flex",alignItems:"center",gap:11,marginBottom:12}}>
            <UserAvatarCircle emoji={avatarEmoji} color={color} persona={persona} alt={name} size={44}/>
            <div style={{minWidth:0}}>
              <div style={{fontSize:14,fontWeight:600,color:isDark?"#fff":P.txt,lineHeight:1.2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{name}</div>
              <div style={{fontSize:11.5,color:isDark?"rgba(255,255,255,.75)":P.muted,lineHeight:1.3}}>{sub}</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 2px 12px",color:isDark?"#fff":P.txt}}>
            <Switch isSelected={isDark} onChange={()=>onToggleTheme?.()} staticColor={isDark?"white":undefined}>{isDark?"Dark theme":"Light theme"}</Switch>
          </div>
          <div style={{height:1,background:P.border,margin:"0 -14px 6px"}}/>
          {onGoToProfile&&<button role="menuitem" onClick={()=>{setMenuOpen(false);onGoToProfile();}}
            onMouseEnter={e=>e.currentTarget.style.background=P.hovGrey}
            onMouseLeave={e=>e.currentTarget.style.background="transparent"}
            style={{display:"flex",alignItems:"center",gap:10,width:"100%",background:"transparent",border:"none",borderRadius:8,padding:"9px 10px",fontSize:13.5,color:isDark?"#fff":P.txt,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
            Profile
          </button>}
          <button role="menuitem" onClick={()=>{setMenuOpen(false);onLogout?.();}}
            onMouseEnter={e=>e.currentTarget.style.background=P.hovGrey}
            onMouseLeave={e=>e.currentTarget.style.background="transparent"}
            style={{display:"flex",alignItems:"center",gap:10,width:"100%",background:"transparent",border:"none",borderRadius:8,padding:"9px 10px",fontSize:13.5,color:isDark?"#fff":P.txt,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
            Sign out
          </button>
        </div>
      </>}
    </div>
  </nav>);
}
// ── Sidebar navigation ────────────────────────────────────────────────────────
function Sidebar({items,active,onChange,profile,onLogout,onToggleTheme,progress,badge}){
  const {mobile}=useViewport();
  const isDark=getThemeMode()==="dark";

  // Mobile: bottom tab bar
  if(mobile){
    return(<>
      <div style={{height:48,background:P.panel,borderBottom:`1px solid ${P.border}`,display:"flex",alignItems:"center",padding:"0 16px",gap:10,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:24,height:24,background:"linear-gradient(135deg,#FA0F00,#FF4438)",borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <span style={{color:"#fff",fontWeight:600,fontSize:12}}>N</span>
          </div>
          <span style={{fontSize:13,fontWeight:500,color:P.txt,letterSpacing:-.3}}>Nexus</span>
        </div>
        {badge&&<span style={{fontSize:10,fontWeight:500,color:P.amber,background:P.amberBg,border:`1px solid ${P.amber}30`,borderRadius:5,padding:"1px 8px"}}>{badge}</span>}
        <div style={{flex:1}}/>
        <button onClick={onToggleTheme} style={{background:"transparent",border:"none",fontSize:14,cursor:"pointer",color:P.muted}}>{isDark?"☀":"●"}</button>
      </div>
      <div style={{background:P.panel,borderBottom:`1px solid ${P.border}`,display:"flex",overflowX:"auto",scrollbarWidth:"none",flexShrink:0}}>
        {items.map(t=>(
          <button key={t.label} onClick={()=>onChange(t.id)} style={{padding:"10px 14px",background:"transparent",border:"none",borderBottom:active===t.id?`2px solid ${P.blue}`:"2px solid transparent",color:active===t.id?P.blue:P.muted,fontWeight:active===t.id?600:400,fontSize:12,cursor:"pointer",whiteSpace:"nowrap",fontFamily:"inherit",marginBottom:-1}}>{t.label}</button>
        ))}
      </div>
    </>);
  }

  // Desktop: left sidebar
  return(
    <aside style={{width:228,flexShrink:0,background:P.panel,borderRight:`1px solid ${P.border}`,display:"flex",flexDirection:"column",height:"100vh",position:"sticky",top:0,zIndex:10}}>
      {/* Logo */}
      <div style={{padding:"20px 20px 14px",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:30,height:30,background:"linear-gradient(135deg,#FA0F00,#FF4438)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 8px #FA0F0035"}}>
            <span style={{color:"#fff",fontWeight:600,fontSize:15,letterSpacing:-.5}}>N</span>
          </div>
          <div>
            <div style={{fontSize:14.5,fontWeight:500,color:P.txt,letterSpacing:-.4,lineHeight:1}}>Nexus</div>
            <div style={{fontSize:9,color:P.dim,letterSpacing:.8,textTransform:"uppercase",marginTop:2}}>Adobe Internal</div>
          </div>
        </div>
        {badge&&<span style={{display:"inline-block",marginTop:10,fontSize:10,fontWeight:500,color:P.amber,background:P.amberBg,border:`1px solid ${P.amber}30`,borderRadius:5,padding:"2px 9px",letterSpacing:.5,textTransform:"uppercase"}}>{badge}</span>}
      </div>

      {/* Progress ribbon */}
      {progress!=null&&<div style={{height:2,background:P.bfaint,flexShrink:0,marginBottom:6}}>
        <div style={{height:"100%",width:`${Math.min(100,progress)}%`,background:progress>=75?P.grn:progress>=50?P.blue:P.amber,transition:"width 1s ease"}}/>
      </div>}

      {/* Nav items */}
      <nav style={{flex:1,padding:"8px 10px",overflowY:"auto",scrollbarWidth:"none"}}>
        {items.map(t=>{
          const isActive=active===t.id;
          return(
            <button key={t.label} onClick={()=>onChange(t.id)}
              style={{width:"100%",display:"flex",alignItems:"center",gap:9,padding:"9px 12px",borderRadius:9,border:"none",cursor:"pointer",background:isActive?P.blueGh:"transparent",color:isActive?P.blue:P.muted,fontWeight:isActive?600:400,fontSize:13.5,textAlign:"left",fontFamily:"inherit",marginBottom:2,letterSpacing:-.1,transition:"background .12s,color .12s"}}>
              {t.icon&&<span style={{fontSize:14,width:20,textAlign:"center",flexShrink:0,opacity:isActive?1:.6}}>{t.icon}</span>}
              <span>{t.label}</span>
              {t.badge&&<span style={{marginLeft:"auto",fontSize:10,fontWeight:500,color:t.badge==="new"?P.blue:P.amber,background:t.badge==="new"?P.blueGh:P.amberBg,borderRadius:4,padding:"1px 6px"}}>{t.badge}</span>}
            </button>
          );
        })}
      </nav>

      {/* User section */}
      <div style={{padding:"12px 14px",borderTop:`1px solid ${P.border}`,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:10}}>
          <UserAvatarCircle emoji={profile?.avatar_emoji} color={profile?.avatar_color||profile?.color} persona={profile?.persona} alt={profile?.name||"?"} size={32}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:12.5,fontWeight:600,color:P.txt,letterSpacing:-.1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{profile?.name}</div>
            <div style={{fontSize:10.5,color:P.dim,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{profile?.tenure}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:6}}>
          <button onClick={onToggleTheme} style={{flex:1,background:P.surface,border:`1px solid ${P.border}`,borderRadius:7,padding:"5px 0",fontSize:11,cursor:"pointer",color:P.muted,fontFamily:"inherit",transition:"background .15s"}}
            onMouseEnter={e=>e.currentTarget.style.background=P.bfaint} onMouseLeave={e=>e.currentTarget.style.background=P.surface}>{isDark?"Light mode":"Dark mode"}</button>
          <button onClick={onLogout} style={{flex:1,background:"transparent",border:`1px solid ${P.border}`,borderRadius:7,padding:"5px 0",fontSize:11,cursor:"pointer",color:P.muted,fontFamily:"inherit",transition:"background .15s"}}
            onMouseEnter={e=>e.currentTarget.style.background=P.surface} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>Sign out</button>
        </div>
      </div>
    </aside>
  );
}

// Old Tabs kept as horizontal scroll for CAT/other contexts
function Tabs({items,active,onChange}){
  return(<div style={{background:P.panel,borderBottom:`1px solid ${P.border}`,padding:"0 20px",display:"flex",flexShrink:0,overflowX:"auto",scrollbarWidth:"none",gap:0}}>
    {items.map(t=>(
      <button key={t.label} onClick={()=>onChange(t.id)} style={{padding:"13px 16px 11px",background:"transparent",border:"none",borderBottom:active===t.id?`2px solid ${P.blue}`:"2px solid transparent",color:active===t.id?P.blue:P.muted,fontWeight:active===t.id?600:400,fontSize:13,cursor:"pointer",marginBottom:-1,whiteSpace:"nowrap",letterSpacing:-.2,transition:"color .15s",fontFamily:"inherit"}}>
        {t.label}
      </button>
    ))}
  </div>);
}

// ── Vertical side navigation — desktop only, fixed under the top Nav bar ─────
const SIDENAV_WIDTH=210;
function SideNav({items,active,onChange}){
  return(
    <div className="nx-sidebar" style={{position:"fixed",top:54,left:0,bottom:0,width:SIDENAV_WIDTH,background:P.panel,borderRight:`1px solid ${P.border}`,padding:"14px 10px",overflowY:"auto",display:"flex",flexDirection:"column",gap:2,zIndex:5}}>
      {items.map(t=>{
        const Ic=typeof t.icon==="function"?t.icon:null;
        return(
        <button key={t.label} onClick={()=>onChange(t.id)}
          onMouseEnter={e=>{if(active!==t.id)e.currentTarget.style.background=P.hovGrey;}}
          onMouseLeave={e=>{if(active!==t.id)e.currentTarget.style.background="transparent";}}
          style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:9,border:"none",
            background:active===t.id?P.selGrey:"transparent",
            color:active===t.id?P.txt:P.txt,fontWeight:active===t.id?600:400,fontSize:13,cursor:"pointer",fontFamily:"inherit",
            textAlign:"left",width:"100%",transition:"background .15s"}}>
          {Ic
            ? <Ic UNSAFE_style={{width:19,height:19,flexShrink:0,"--iconPrimary":active===t.id?P.txt:P.muted}}/>
            : <span style={{fontSize:15,width:18,textAlign:"center",flexShrink:0,opacity:active===t.id?1:.6}}>{t.icon}</span>}
          <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.label}</span>
          {t.badge&&<span style={{fontSize:10,fontWeight:500,color:"#fff",background:P.red,borderRadius:99,padding:"1px 6px",flexShrink:0}}>{t.badge}</span>}
        </button>
        );
      })}
    </div>
  );
}

// ── Shared Profile Card ───────────────────────────────────────────────────────
// ── Points & dynamic badges — only meaningful for real registered users ───────
// ── In-app notifications — home page widget, no email dependency ─────────────
function NotificationsWidget({profile:p}){
  const [items,setItems]=useState([]);
  const [unread,setUnread]=useState(0);
  const [loading,setLoading]=useState(true);

  const load=()=>{
    if(!p.name)return;
    fetch(`${BACKEND}/api/notifications?member_name=${encodeURIComponent(p.name)}`)
      .then(r=>r.json()).then(d=>{setItems(d?.notifications||[]);setUnread(d?.unread||0);setLoading(false);})
      .catch(()=>setLoading(false));
  };
  useEffect(()=>{load();const iv=setInterval(load,60000);return()=>clearInterval(iv);},[p.name]);

  const markRead=async(id)=>{
    setItems(prev=>prev.map(n=>n.id===id?{...n,is_read:true}:n));
    setUnread(u=>Math.max(0,u-1));
    try{await fetch(`${BACKEND}/api/notifications/${id}/read`,{method:"PUT"});}catch(e){}
  };
  const markAllRead=async()=>{
    setItems(prev=>prev.map(n=>({...n,is_read:true})));
    setUnread(0);
    try{await fetch(`${BACKEND}/api/notifications/read-all?member_name=${encodeURIComponent(p.name)}`,{method:"PUT"});}catch(e){}
  };

  const typeIcon={approval:CheckmarkCircle,decline:AlertTriangle,weekly_reminder:Calendar,capstone_overdue:Clock,capstone_complete:Ribbon,capstone_rejected:Refresh};
  const typeColor={approval:P.grn,decline:P.red,weekly_reminder:P.blue,capstone_overdue:P.amber,capstone_complete:P.purple,capstone_rejected:P.amber};

  if(!p.id)return null; // notifications are for real registered users only

  return(
    <Card style={{padding:"16px 18px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
        <div style={{fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.6,textTransform:"uppercase",display:"flex",alignItems:"center",gap:6}}>
          Notifications
          {unread>0&&<span style={{fontSize:10,fontWeight:500,color:"#fff",background:P.red,borderRadius:99,padding:"1px 7px"}}>{unread}</span>}
        </div>
        {unread>0&&<button onClick={markAllRead} style={{fontSize:10.5,color:P.blue,background:"transparent",border:"none",cursor:"pointer",fontFamily:"inherit",padding:0}}>Mark all read</button>}
      </div>
      {loading&&<div style={{fontSize:12,color:P.muted}}>Loading…</div>}
      {!loading&&items.length===0&&<div style={{fontSize:12,color:P.muted}}>No notifications yet.</div>}
      {items.slice(0,6).map(n=>(
        <div key={n.id} onClick={()=>!n.is_read&&markRead(n.id)}
          style={{display:"flex",gap:9,padding:"9px 0",borderBottom:`1px solid ${P.bfaint}`,cursor:n.is_read?"default":"pointer",opacity:n.is_read?.6:1}}>
          <span style={{flexShrink:0,marginTop:1}}><Ic as={typeIcon[n.type]||Bell} size={15} color={typeColor[n.type]||P.muted}/></span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:12.5,fontWeight:n.is_read?400:600,color:P.txt,lineHeight:1.4}}>{n.title}</div>
            <div style={{fontSize:11,color:P.muted,marginTop:2,lineHeight:1.45}}>{n.message}</div>
            <div style={{fontSize:10,color:P.dim,marginTop:3}}>{new Date(n.created_at).toLocaleString()}</div>
          </div>
          {!n.is_read&&<div style={{width:6,height:6,borderRadius:"50%",background:P.blue,flexShrink:0,marginTop:4}}/>}
        </div>
      ))}
    </Card>
  );
}

function MyPointsWidget({profile:p,modulesDone,capstoneCompleted,refreshKey=0}){
  const [total,setTotal]=useState(null);
  const [recent,setRecent]=useState([]);
  const loadPoints=()=>{
    if(!p.name)return;
    fetch(`${BACKEND}/api/points/me?member_name=${encodeURIComponent(p.name)}`)
      .then(r=>r.json()).then(d=>{setTotal(d?.total??0);setRecent(d?.recent||[]);})
      .catch(()=>{});
  };
  useEffect(()=>{loadPoints();},[p.name,refreshKey]);
  useEffect(()=>{const iv=setInterval(loadPoints,45000);return()=>clearInterval(iv);},[p.name]);

  // Badges computed live from real activity — not hardcoded
  const badges=[];
  if(modulesDone>=1)badges.push({label:"First module complete",icon:Target});
  if(modulesDone>=5)badges.push({label:"Halfway there",icon:Education});
  if(modulesDone>=9)badges.push({label:"All modules done",icon:FileText});
  if(capstoneCompleted)badges.push({label:"Capstone champion",icon:Ribbon});
  if(total!=null&&total>=100)badges.push({label:"100+ points",icon:Star});
  if(total!=null&&total>=500)badges.push({label:"500+ points",icon:StarFilled});
  if(recent.some(r=>r.reason&&r.reason.startsWith("Tested out")))badges.push({label:"Test-out pass",icon:RocketQuickActions});
  const weeklyUpdates=recent.filter(r=>r.reason==="Posted a weekly update").length;
  if(weeklyUpdates>=4)badges.push({label:"Consistent tracker",icon:Calendar});
  if(weeklyUpdates>=8)badges.push({label:"8-week streak",icon:CheckmarkCircle});

  if(!p.id)return null; // demo/static personas keep their own hardcoded badges elsewhere

  return(
    <Card style={{padding:"16px 18px"}}>
      <div style={{fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.6,textTransform:"uppercase",marginBottom:10}}>My points</div>
      <div style={{fontSize:26,fontWeight:600,color:P.txt,letterSpacing:-.5,marginBottom:4}}>{total==null?"—":total}</div>
      <div style={{fontSize:11,color:P.muted,marginBottom:12}}>Earned from modules, weekly updates, and capstone</div>
      {badges.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:recent.length?10:0}}>
        {badges.map(b=>(
          <span key={b.label} style={{fontSize:10.5,fontWeight:600,color:P.purple,background:P.purpleBg,borderRadius:6,padding:"3px 9px",display:"inline-flex",alignItems:"center",gap:4}}>
            <Ic as={b.icon} size={12} color={P.purple}/>{b.label}
          </span>
        ))}
      </div>}
      {recent.length>0&&<div style={{borderTop:`1px solid ${P.bfaint}`,paddingTop:8}}>
        {recent.slice(0,3).map((r,i)=>(
          <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:4}}>
            <span style={{color:P.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,marginRight:8}}>{r.reason}</span>
            <span style={{color:P.grn,fontWeight:600,flexShrink:0}}>+{r.points}</span>
          </div>
        ))}
      </div>}
    </Card>
  );
}

// ── Profile settings — avatar, username, password change. Real accounts only ──
function ProfileSettingsCard({email,accountType,currentUsername,currentEmoji,currentColor,fallbackColor,onSaved}){
  const [open,setOpen]=useState(false);
  const [emojis,setEmojis]=useState([
    "🦊","🐼","🐧","🦁","🐨","🐯","🦉","🐙","🦋","🐢","🦄","🐬","🦎","🐝","🦕","🐳","🦈","🦖","🐺","🦩",
    "🚀","🛰️","🎯","⚡","🌟","🔥","💡","🎨","🧠","🎮","🧩","🌈","🍀","🎧","📚","🔭","🧪","♟️","🏆","🎲",
    "🌸","🍕","🍩","☕","🌵","🍄","🪐","💎","🎸","⚽"]);
  const [colors,setColors]=useState([
    "#1473E6","#E34850","#12805C","#B86B00","#6030D0","#0891B2","#097348","#9B1C2E","#2357E8","#D6409F",
    "#0D9488","#DC2626","#7C3AED","#EA580C","#0369A1","#4D7C0F","#BE185D","#475569","#CA8A04","#15803D"]);
  const [username,setUsername]=useState(currentUsername||"");
  const [emoji,setEmoji]=useState(currentEmoji||"");
  const [swatch,setSwatch]=useState(currentColor||fallbackColor);
  const [saving,setSaving]=useState(false);
  const [saveMsg,setSaveMsg]=useState(null);

  const [showPwd,setShowPwd]=useState(false);
  const [curPwd,setCurPwd]=useState(""),[newPwd,setNewPwd]=useState(""),[newPwd2,setNewPwd2]=useState("");
  const [pwdSaving,setPwdSaving]=useState(false);
  const [pwdMsg,setPwdMsg]=useState(null);

  useEffect(()=>{
    fetch(`${BACKEND}/api/profile/avatar-options`).then(r=>r.json()).then(d=>{
      if(d?.emojis)setEmojis(d.emojis);
      if(d?.colors)setColors(d.colors);
    }).catch(()=>{});
  },[]);

  const saveProfile=async()=>{
    setSaving(true);setSaveMsg(null);
    try{
      await fetch(`${BACKEND}/api/profile/update`,{method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email,persona:accountType,username:username.trim()||null,avatar_emoji:emoji||null,avatar_color:swatch||null})});
      setSaveMsg({ok:true,text:"Saved."});
      onSaved?.({username:username.trim()||null,avatar_emoji:emoji||null,avatar_color:swatch||null});
    }catch(e){setSaveMsg({ok:false,text:"Could not save. Check the backend is running."});}
    setSaving(false);
  };

  const savePassword=async()=>{
    if(!curPwd||!newPwd){setPwdMsg({ok:false,text:"Both fields are required."});return;}
    if(newPwd.length<6){setPwdMsg({ok:false,text:"New password must be at least 6 characters."});return;}
    if(newPwd!==newPwd2){setPwdMsg({ok:false,text:"New passwords do not match."});return;}
    setPwdSaving(true);setPwdMsg(null);
    try{
      const res=await fetch(`${BACKEND}/api/profile/change-password`,{method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email,persona:accountType,current_password:curPwd,new_password:newPwd})});
      const data=await res.json();
      if(!res.ok){setPwdMsg({ok:false,text:data.detail||"Could not change password."});}
      else{setPwdMsg({ok:true,text:"Password updated."});setCurPwd("");setNewPwd("");setNewPwd2("");}
    }catch(e){setPwdMsg({ok:false,text:"Could not reach the server."});}
    setPwdSaving(false);
  };

  return(
    <Card style={{padding:"16px 22px",marginBottom:12}}>
      <button onClick={()=>setOpen(!open)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",background:"transparent",border:"none",cursor:"pointer",fontFamily:"inherit",padding:0}}>
        <span style={{fontSize:13.5,fontWeight:600,color:P.txt}}>Edit profile</span>
        <Ic as={open?ChevronUp:ChevronDown} size={15} color={P.dim}/>
      </button>

      {open&&<div style={{marginTop:16,display:"flex",flexDirection:"column",gap:18}}>
        {/* Username */}
        <div>
          <label style={{fontSize:11.5,fontWeight:600,color:P.muted,display:"block",marginBottom:5}}>Display name / username</label>
          <input value={username} onChange={e=>setUsername(e.target.value)} placeholder="How you'd like to appear"
            style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit"}}/>
        </div>

        {/* Avatar emoji picker */}
        <div>
          <label style={{fontSize:11.5,fontWeight:600,color:P.muted,display:"block",marginBottom:7}}>Avatar</label>
          <div style={{display:"flex",flexWrap:"wrap",gap:7}}>
            {emojis.map(em=>(
              <button key={em} onClick={()=>setEmoji(em===emoji?"":em)}
                style={{width:36,height:36,borderRadius:"50%",border:`2px solid ${emoji===em?swatch:P.border}`,background:emoji===em?swatch+"18":P.surface,fontSize:17,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
                {em}
              </button>
            ))}
          </div>
        </div>

        {/* Color picker */}
        <div>
          <label style={{fontSize:11.5,fontWeight:600,color:P.muted,display:"block",marginBottom:7}}>Colour</label>
          <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
            {colors.map(c=>(
              <button key={c} onClick={()=>setSwatch(c)}
                style={{width:28,height:28,borderRadius:"50%",background:c,border:swatch===c?`2.5px solid ${P.txt}`:"2.5px solid transparent",cursor:"pointer",boxShadow:swatch===c?`0 0 0 2px ${P.bg}, 0 0 0 4px ${c}`:"none"}}/>
            ))}
          </div>
        </div>

        {/* Live preview */}
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:40,height:40,borderRadius:"50%",background:swatch,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:18,fontWeight:500}}>{emoji||(username||"U")[0].toUpperCase()}</div>
          <span style={{fontSize:12,color:P.muted}}>Preview</span>
        </div>

        {saveMsg&&<div style={{fontSize:12.5,color:saveMsg.ok?P.grn:P.red}}>{saveMsg.text}</div>}
        <button onClick={saveProfile} disabled={saving}
          style={{background:P.blue,color:"#fff",border:"none",borderRadius:8,padding:"9px 0",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",opacity:saving?.6:1}}>
          {saving?"Saving…":"Save profile"}
        </button>

        {/* Password change */}
        <div style={{borderTop:`1px solid ${P.bfaint}`,paddingTop:16}}>
          <button onClick={()=>setShowPwd(!showPwd)} style={{display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",background:"transparent",border:"none",cursor:"pointer",fontFamily:"inherit",padding:0,marginBottom:showPwd?14:0}}>
            <span style={{fontSize:13,fontWeight:600,color:P.txt}}>Change password</span>
            <Ic as={showPwd?ChevronUp:ChevronDown} size={14} color={P.dim}/>
          </button>
          {showPwd&&<div style={{display:"flex",flexDirection:"column",gap:10}}>
            <input type="password" value={curPwd} onChange={e=>setCurPwd(e.target.value)} placeholder="Current password"
              style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit"}}/>
            <input type="password" value={newPwd} onChange={e=>setNewPwd(e.target.value)} placeholder="New password (min 6 characters)"
              style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit"}}/>
            <input type="password" value={newPwd2} onChange={e=>setNewPwd2(e.target.value)} placeholder="Confirm new password"
              style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit"}}/>
            {pwdMsg&&<div style={{fontSize:12.5,color:pwdMsg.ok?P.grn:P.red}}>{pwdMsg.text}</div>}
            <button onClick={savePassword} disabled={pwdSaving}
              style={{background:P.amber,color:"#fff",border:"none",borderRadius:8,padding:"9px 0",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",opacity:pwdSaving?.6:1}}>
              {pwdSaving?"Updating…":"Update password"}
            </button>
          </div>}
        </div>
      </div>}
    </Card>
  );
}

function ProfileCard({name,role,tenure,initial,color,skills,skillLabels,bw,cert,certStatus,certExp,badges,memberProjects,projectIssues,persona,email,userId,username,avatarEmoji,avatarColor,accountType,onAvatarSaved}){
  const isRealUser=!!userId; // only real registered accounts get edit/avatar/password controls

  // Real accounts show their actual imported/assigned projects (same source as
  // the Projects tab), not the client-side demo mock state — the two must not
  // disagree about whether someone has projects.
  const [realProjects,setRealProjects]=useState(null);
  const [realProjectsErr,setRealProjectsErr]=useState(false);
  useEffect(()=>{
    if(!isRealUser) return;
    setRealProjectsErr(false);
    const q=email?`email=${encodeURIComponent(email)}`:`member_name=${encodeURIComponent(name||"")}`;
    fetch(`${BACKEND}/api/projects/my-client?${q}`,{credentials:"include"})
      .then(r=>r.json()).then(d=>setRealProjects(d.projects||[]))
      .catch(()=>{setRealProjects([]);setRealProjectsErr(true);});
  },[isRealUser,email,name]);

  const myProjects = isRealUser
    ? (realProjects||[]).map(p=>({code:p.project_code||String(p.id),title:p.title,status:p.status||p.health_status||"Active",openIssues:0}))
    : (memberProjects?.[name]||[]).map(code=>{
        const proj=ALL_PROJECTS.find(p=>p.code===code);
        const openIssues=(projectIssues?.[code]||[]).filter(i=>i.status!=="Done").length;
        return{...proj,code,openIssues};
      }).filter(Boolean);

  const bwAuto=(persona==="exp"||persona==="nj2")&&memberProjects&&projectIssues
    ?calcBW(name,memberProjects,projectIssues)
    :null;
  const displayBW=bwAuto?bwAuto.pct:bw;
  const bwColor=displayBW<50?P.red:displayBW<75?P.amber:P.grn;
  const effColor=avatarColor||color;

  return(<div style={{padding:"20px 0",maxWidth:620,margin:"0 auto"}}>
    {/* Header card */}
    <Card style={{padding:"20px 22px",marginBottom:12}}>
      <div style={{display:"flex",alignItems:"center",gap:16}}>
        <UserAvatarCircle emoji={avatarEmoji} color={effColor} persona={persona} alt={username||name} size={56}/>
        <div style={{flex:1}}>
          <div style={{fontSize:17,fontWeight:500,color:P.txt,letterSpacing:-.3}}>{username||name}</div>
          <div style={{fontSize:12.5,color:P.muted,marginTop:2}}>{role} · {tenure}</div>
        </div>
        <div style={{textAlign:"center",background:P.surface,borderRadius:10,padding:"10px 16px"}}>
          <div style={{fontSize:20,fontWeight:500,color:bwColor,letterSpacing:-.5}}>{displayBW}%</div>
          <div style={{fontSize:10.5,color:P.muted,marginTop:1}}>{bwAuto?"Learning bandwidth":"Bandwidth"}</div>
        </div>
      </div>
      {bwAuto&&<div style={{marginTop:12,fontSize:11.5,color:P.dim}}>Auto-calculated · {bwAuto.used}h committed across {myProjects.length} project{myProjects.length!==1?"s":""} · {bwAuto.total}h base</div>}
    </Card>

    {isRealUser&&<ProfileSettingsCard email={email} accountType={accountType} currentUsername={username} currentEmoji={avatarEmoji} currentColor={avatarColor} fallbackColor={color} onSaved={onAvatarSaved}/>}

    {/* Projects */}
    {myProjects.length>0&&<Card style={{padding:"18px 22px",marginBottom:12}}>
      <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:12}}>My Projects</div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {myProjects.map(proj=>(
          <div key={proj.code} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",background:P.surface,borderRadius:10}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:proj.status==="In Progress"?P.grn:proj.status==="Blocked"?P.red:P.amber,flexShrink:0}}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:500,color:P.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{proj.title||proj.code}</div>
              <div style={{fontSize:11.5,color:P.muted,marginTop:2}}>{proj.code} · {proj.status||"Active"}</div>
            </div>
            {proj.openIssues>0&&<span style={{fontSize:11.5,fontWeight:600,color:P.amber,background:P.amberBg,borderRadius:5,padding:"2px 8px",flexShrink:0}}>{proj.openIssues} open</span>}
            <span style={{fontSize:11.5,fontWeight:600,color:P.grn,background:P.grnBg,borderRadius:5,padding:"2px 8px",flexShrink:0}}>Member</span>
          </div>
        ))}
      </div>
    </Card>}
    {myProjects.length===0&&<Card style={{padding:"16px 22px",marginBottom:12}}>
      <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:6}}>My Projects</div>
      <div style={{fontSize:13,color:realProjectsErr?P.red:P.muted}}>
        {realProjectsErr
          ? "Couldn't load your projects — the server may be unreachable. Try refreshing."
          : "Not assigned to any projects yet. Your manager will assign you when you pass the capstone gate."}
      </div>
    </Card>}

    {/* Skills */}
    <Card style={{padding:"18px 22px",marginBottom:12}}>
      <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:12}}>Skills</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
        {skills.map((s,i)=>{const lvl=s==="gap"?"Gap":(s||"none").charAt(0).toUpperCase()+(s||"none").slice(1);return(
          <div key={i} style={{display:"flex",alignItems:"center",gap:7,background:P.surface,border:`1px solid ${P.border}`,borderRadius:8,padding:"6px 12px"}}>
            <span style={{fontSize:12.5,fontWeight:600,color:P.txt}}>{skillLabels[i]}</span>
            <span style={{fontSize:11,fontWeight:600,color:P.muted}}>{lvl}</span>
          </div>
        );})}
      </div>
    </Card>

    {/* Certifications — live multi-cert */}
    <Card style={{padding:"18px 22px",marginBottom:12}}>
      <ProfileCertList userId={userId} email={email} certFallback={cert} certStatusFallback={certStatus} certExpFallback={certExp}/>
    </Card>

    {/* Badges */}
    {badges&&badges.length>0&&<Card style={{padding:"18px 22px"}}>
      <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:12}}>Badges</div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {badges.map((b,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:7,background:P.surface,border:`1px solid ${P.border}`,borderRadius:8,padding:"6px 12px"}}>
            {b.icon&&<span style={{fontSize:15}}>{b.icon}</span>}
            <span style={{fontSize:12.5,fontWeight:600,color:P.txt}}>{b.label}</span>
          </div>
        ))}
      </div>
    </Card>}
  </div>);
}

// ── Community ─────────────────────────────────────────────────────────────────
// Real relative-time formatting from an actual timestamp — computed at render
// time, never a frozen string like the old "2h ago" fixtures.
function timeAgo(iso){
  if(!iso)return"";
  const s=Math.max(0,(Date.now()-new Date(iso.endsWith("Z")||iso.includes("+")?iso:iso+"Z").getTime())/1000);
  if(s<60)return"just now";
  if(s<3600)return`${Math.floor(s/60)}m ago`;
  if(s<86400)return`${Math.floor(s/3600)}h ago`;
  return`${Math.floor(s/86400)}d ago`;
}

// ── NJ Community — doubts, onboarding tips, peer discussion ─────────────────
// Real, backend-persisted (community_threads/community_replies, space="nj") —
// replaces the previous NJ_THREADS fixture of fabricated posts from named
// people with frozen "2h ago" timestamps.
function NJCommunity({profile:p}){
  const userName=p.name;
  const isDark=getThemeMode()==="dark";
  const ACCENT="#EB1000";
  const ACCTX=isDark?"#FF6A5C":ACCENT;
  const ACCBG=isDark?"rgba(235,16,0,.12)":"#FFF1ED";
  const ACCGRAD="linear-gradient(135deg,#FF5A3D,#EB1000)";
  const PROD_COLORS={"AJO":P.red,"CJA":P.purple,"Analytics":P.grn,"RTCDP":P.blue,"AEP":P.blue,"WebSDK":P.amber};
  const [filter,setFilter]=useState("All");
  const [open,setOpen]=useState(null);
  const [replyText,setReplyText]=useState({});
  const [localThreads,setLocalThreads]=useState([]);
  const [pts,setPts]=useState({points:0,posts:0,replies:0,streak:0});
  const [showNew,setShowNew]=useState(false);
  const [newTitle,setNewTitle]=useState("");
  const [newTag,setNewTag]=useState("Module doubts");

  const loadThreads=()=>fetch(`${BACKEND}/api/community/threads?space=nj`).then(r=>r.json())
    .then(d=>setLocalThreads((d.threads||[]).map(t=>({...t,author:t.author_name,time:timeAgo(t.created_at),
      replies:(t.replies||[]).map(r=>({...r,author:r.author_name}))}))))
    .catch(()=>{});
  const loadStats=()=>fetch(`${BACKEND}/api/community/stats?space=nj&author_name=${encodeURIComponent(userName)}`)
    .then(r=>r.json()).then(d=>setPts(d)).catch(()=>{});
  useEffect(()=>{loadThreads();loadStats();},[]);

  const visible=filter==="All"?localThreads:localThreads.filter(t=>t.tag===filter);
  const TAGS=["All","Module doubts","Onboarding tips","General"];
  const TAG_STYLE={
    "Module doubts":{bg:ACCBG,color:ACCTX},
    "Onboarding tips":{bg:P.grnBg,color:P.grn},
    "General":{bg:P.amberBg,color:P.amber},
  };

  const postThread=async()=>{
    if(!newTitle.trim())return;
    try{
      await fetch(`${BACKEND}/api/community/threads`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({space:"nj",author_name:userName,title:newTitle.trim(),tag:newTag})});
      setNewTitle("");setShowNew(false);
      loadThreads();loadStats();
    }catch{}
  };

  const postReply=async(threadId)=>{
    const text=replyText[threadId];
    if(!text?.trim())return;
    try{
      await fetch(`${BACKEND}/api/community/threads/${threadId}/replies`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({author_name:userName,text:text.trim()})});
      setReplyText(prev=>({...prev,[threadId]:""}));
      loadThreads();loadStats();
    }catch{}
  };

  return(
    <div style={{padding:"20px 24px",maxWidth:760,margin:"0 auto"}}>

      {/* Header */}
      <div style={{marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:1.2,textTransform:"uppercase",color:ACCTX,marginBottom:6}}>Community</div>
        <div style={{fontSize:24,fontWeight:700,letterSpacing:-.5,color:P.txt}}>New joiner cohort</div>
      </div>

      {/* Capstone unlock banner */}
      <div style={{background:ACCBG,border:`1px solid ${ACCENT}30`,borderRadius:12,padding:"12px 18px",marginBottom:16,display:"flex",alignItems:"center",gap:12}}>
        <Ic as={Lock} size={17} color={ACCTX}/>
        <div>
          <div style={{fontSize:12.5,fontWeight:600,color:ACCTX}}>NJ cohort space</div>
          <div style={{fontSize:12,color:P.muted}}>After your capstone, you'll join the full team community with experienced colleagues — projects, cross-skilling Q&A, and more.</div>
        </div>
      </div>

      {/* Points strip */}
      <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,padding:"12px 18px",marginBottom:16,display:"flex",alignItems:"center",gap:20,flexWrap:"wrap"}}>
        {[{l:"Points",v:pts.points,c:ACCTX},{l:"Posts",v:pts.posts,c:P.purple},{l:"Replies",v:pts.replies,c:P.grn},{l:"Streak",v:`${pts.streak}d`,c:P.amber}].map(s=>(
          <div key={s.l} style={{textAlign:"center"}}>
            <div style={{fontSize:16,fontWeight:500,color:s.c}}>{s.v}</div>
            <div style={{fontSize:10.5,color:P.muted}}>{s.l}</div>
          </div>
        ))}
        <div style={{flex:1}}/>
        <button onClick={()=>setShowNew(!showNew)}
          style={{background:ACCGRAD,color:"#fff",border:"none",borderRadius:7,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
          + New post · +15 pts
        </button>
      </div>

      {/* New post form */}
      {showNew&&<Card style={{padding:"16px 18px",marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:600,color:P.txt,marginBottom:10}}>New post</div>
        <input value={newTitle} onChange={e=>setNewTitle(e.target.value)}
          placeholder="What's your question or topic?"
          style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit",marginBottom:10}}/>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <select value={newTag} onChange={e=>setNewTag(e.target.value)}
            style={{border:`1px solid ${P.border}`,borderRadius:7,padding:"7px 10px",fontSize:12.5,color:P.txt,background:P.bg,outline:"none",flex:1}}>
            {["Module doubts","Onboarding tips","General"].map(t=><option key={t}>{t}</option>)}
          </select>
          <button onClick={postThread} disabled={!newTitle.trim()}
            style={{background:newTitle.trim()?ACCENT:"#aaa",color:"#fff",border:"none",borderRadius:8,padding:"8px 18px",fontSize:13,fontWeight:600,cursor:newTitle.trim()?"pointer":"not-allowed",fontFamily:"inherit"}}>
            Post
          </button>
          <button onClick={()=>setShowNew(false)}
            style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 12px",fontSize:13,color:P.muted,cursor:"pointer",fontFamily:"inherit"}}>
            Cancel
          </button>
        </div>
      </Card>}

      {/* Tag filters */}
      <div style={{display:"flex",gap:7,marginBottom:14,flexWrap:"wrap"}}>
        {TAGS.map(f=>(
          <button key={f} onClick={()=>setFilter(f)}
            style={{background:filter===f?ACCENT:"transparent",color:filter===f?"#fff":P.muted,
              border:`1px solid ${filter===f?ACCENT:P.border}`,borderRadius:6,padding:"5px 12px",
              fontSize:12,fontWeight:filter===f?600:400,cursor:"pointer",fontFamily:"inherit"}}>{f}</button>
        ))}
      </div>

      {/* Threads */}
      {visible.length===0&&<div style={{padding:"28px 0",textAlign:"center",color:P.muted,fontSize:13}}>No posts yet in this category — be the first!</div>}
      {visible.map(t=>{
        const tc=TAG_STYLE[t.tag]||{bg:P.bfaint,color:P.muted};
        return(
          <Card key={t.id} style={{marginBottom:10}}>
            <div onClick={()=>setOpen(open===t.id?null:t.id)}
              style={{padding:"13px 16px",cursor:"pointer",display:"flex",alignItems:"flex-start",gap:12}}>
              <Avatar src={`https://i.pravatar.cc/96?u=${encodeURIComponent(t.author||String(t.id))}`} alt={t.author} size={32}/>
              <div style={{flex:1}}>
                <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:5,lineHeight:1.4}}>{t.title}</div>
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  <span style={{...tc,fontSize:10.5,fontWeight:600,borderRadius:5,padding:"1px 7px"}}>{t.tag}</span>
                  <span style={{fontSize:11,color:P.dim}}>{t.author}</span>
                  <span style={{fontSize:11,color:P.dim}}>· {t.replies.length} {t.replies.length===1?"reply":"replies"}</span>
                  <span style={{fontSize:11,color:P.dim}}>· {t.time}</span>
              {t.product&&t.product!=="General"&&(
                <span style={{fontSize:10,fontWeight:600,
                  color:PROD_COLORS[t.product]||P.muted,
                  background:(PROD_COLORS[t.product]||P.muted)+"18",
                  borderRadius:5,padding:"1px 6px"}}>
                  {t.product}
                </span>
              )}
                </div>
              </div>
              <span style={{flexShrink:0,marginTop:2}}><Ic as={open===t.id?ChevronUp:ChevronDown} size={14} color={P.dim}/></span>
            </div>
            {open===t.id&&<div style={{borderTop:`1px solid ${P.bfaint}`,padding:"12px 16px 14px"}}>
              {t.replies.length===0&&<div style={{fontSize:12.5,color:P.muted,marginBottom:12}}>No replies yet — be the first to respond.</div>}
              {t.replies.map((r,i)=>(
                <div key={i} style={{display:"flex",gap:10,marginBottom:12}}>
                  <Avatar src={`https://i.pravatar.cc/96?u=${encodeURIComponent(r.author||r.ini)}`} alt={r.author} size={28}/>
                  <div style={{flex:1}}>
                    <div style={{background:P.bg,borderRadius:8,padding:"9px 13px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                        <span style={{fontSize:11.5,fontWeight:600,color:P.txt}}>{r.author}</span>
                        {r.mentor&&<span style={{fontSize:10,fontWeight:500,color:P.grn,background:P.grnBg,borderRadius:4,padding:"1px 6px"}}>Mentor</span>}
                      </div>
                      <div style={{fontSize:12.5,color:P.txt,lineHeight:1.55}}>{r.text}</div>
                    </div>
                  </div>
                </div>
              ))}
              <div style={{display:"flex",gap:8,marginTop:6}}>
                <input value={replyText[t.id]||""} onChange={e=>setReplyText(prev=>({...prev,[t.id]:e.target.value}))}
                  placeholder="Add a reply… (+5 pts)"
                  onKeyDown={e=>e.key==="Enter"&&postReply(t.id)}
                  style={{flex:1,border:`1px solid ${P.border}`,borderRadius:7,padding:"7px 12px",fontSize:12.5,outline:"none",background:P.bg,color:P.txt,fontFamily:"inherit"}}/>
                <button onClick={()=>postReply(t.id)}
                  style={{background:ACCGRAD,color:"#fff",border:"none",borderRadius:7,padding:"7px 16px",fontSize:12.5,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Reply</button>
              </div>
            </div>}
          </Card>
        );
      })}
    </div>
  );
}

// Real, backend-persisted (community_threads/community_replies, space="exp") —
// replaces the previous THREADS/COMMUNITY_POINTS fixtures. The old handlePost/
// handleReply didn't even touch THREADS at all — they just incremented a fake
// points counter with no thread/reply ever created, so posts silently vanished
// on refresh; now every post/reply is a real row.
function Community({profile,userName:userNameProp}){
  const userName=profile?.name||userNameProp||"You";
  const email=profile?.email||"";
  const mgr=profile?.manager_email||profile?.managerEmail||profile?.manager||"";
  const [filter,setFilter]=useState("All");
  const [open,setOpen]=useState(null);
  const [showLeaderboard,setShowLeaderboard]=useState(false);
  const [postPoints,setPostPoints]=useState({points:0,posts:0,replies:0,streak:0});
  const [product,setProduct]=useState("All");
  const [threads,setThreads]=useState([]);
  const [leaderboard,setLeaderboard]=useState([]);
  const [newTitle,setNewTitle]=useState("");
  const [newBody,setNewBody]=useState("");
  const [newTag,setNewTag]=useState("Projects");
  const [newVis,setNewVis]=useState("team");        // private | team | public
  const [mentions,setMentions]=useState([]);         // [{name,email}]
  const [mentionQ,setMentionQ]=useState("");
  const [memberOptions,setMemberOptions]=useState([]);
  const [showNew,setShowNew]=useState(false);
  const [replyText,setReplyText]=useState({});
  const PROD_COLORS={"AJO":P.red,"CJA":P.purple,"Analytics":P.grn,"RTCDP":P.blue};
  const VIS={private:{l:"Private",c:P.dim,i:"🔒",d:"Only you"},team:{l:"Team",c:P.blue,i:"👥",d:"Everyone under your manager"},public:{l:"Public",c:P.grn,i:"🌐",d:"Shared across all teams"}};

  const loadThreads=()=>{
    const q=`as_name=${encodeURIComponent(userName)}${email?`&as_email=${encodeURIComponent(email)}`:""}${mgr?`&my_manager=${encodeURIComponent(mgr)}`:""}`;
    fetch(`${BACKEND}/api/community/threads?${q}`).then(r=>r.json())
      .then(d=>setThreads((d.threads||[]).map(t=>({...t,author:t.author_name,time:timeAgo(t.created_at),
        replies:(t.replies||[]).map(r=>({...r,author:r.author_name}))}))))
      .catch(()=>{});
  };
  const loadStats=()=>fetch(`${BACKEND}/api/community/stats?space=exp&author_name=${encodeURIComponent(userName)}`)
    .then(r=>r.json()).then(d=>setPostPoints(d)).catch(()=>{});
  const loadLeaderboard=()=>fetch(`${BACKEND}/api/community/leaderboard?space=exp`).then(r=>r.json())
    .then(d=>setLeaderboard(d.leaderboard||[])).catch(()=>{});
  const loadMembers=()=>{ if(!mgr){setMemberOptions([]);return;}
    fetch(`${BACKEND}/api/community/members?manager_email=${encodeURIComponent(mgr)}`).then(r=>r.json())
      .then(d=>setMemberOptions((d.members||[]).filter(m=>m.name!==userName))).catch(()=>{}); };
  useEffect(()=>{loadThreads();loadStats();loadLeaderboard();loadMembers();},[userName,email,mgr]);

  const visible=threads
    .filter(t=>filter==="All"||t.tag===filter)
    .filter(t=>product==="All"||(t.product||"General")===product);
  const lb=leaderboard;
  const mentionMatches=mentionQ.trim()?memberOptions.filter(m=>m.name.toLowerCase().includes(mentionQ.toLowerCase())&&!mentions.some(x=>x.email===m.email)).slice(0,6):[];
  const addMention=m=>{setMentions(prev=>[...prev,m]);setMentionQ("");};
  const removeMention=em=>setMentions(prev=>prev.filter(x=>x.email!==em));

  const handlePost=async()=>{
    if(!newTitle.trim())return;
    try{
      await fetch(`${BACKEND}/api/community/threads`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({space:"exp",author_name:userName,author_email:email,manager_email:mgr,
          title:newTitle.trim(),body:newBody.trim()||null,tag:newTag,visibility:newVis,
          product:product!=="All"?product:null,mentions})});
      setNewTitle("");setNewBody("");setMentions([]);setMentionQ("");setShowNew(false);
      loadThreads();loadStats();loadLeaderboard();
    }catch{}
  };
  const handleReply=async(threadId,text)=>{
    if(!text?.trim())return;
    try{
      await fetch(`${BACKEND}/api/community/threads/${threadId}/replies`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({author_name:userName,author_email:email,text:text.trim()})});
      setReplyText(prev=>({...prev,[threadId]:""}));
      loadThreads();loadStats();loadLeaderboard();
    }catch{}
  };
  const toggleKudos=async(t)=>{
    // optimistic
    setThreads(prev=>prev.map(x=>x.id===t.id?{...x,reacted:!x.reacted,reactions:(x.reactions||0)+(x.reacted?-1:1)}:x));
    try{
      await fetch(`${BACKEND}/api/community/threads/${t.id}/react`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({member_name:userName})});
      loadStats();loadLeaderboard();
    }catch{ loadThreads(); }
  };
  const [editId,setEditId]=useState(null),[editTitle,setEditTitle]=useState(""),[editBody,setEditBody]=useState("");
  const startEdit=(t)=>{setEditId(t.id);setEditTitle(t.title||"");setEditBody(t.body||"");setOpen(null);};
  const saveEdit=async()=>{
    if(!editTitle.trim())return;
    try{
      await fetch(`${BACKEND}/api/community/threads/${editId}`,{method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({editor_name:userName,title:editTitle.trim(),body:editBody.trim()})});
      setEditId(null);loadThreads();
    }catch{}
  };
  const deletePost=async(t)=>{
    if(!window.confirm("Delete this post? This can't be undone."))return;
    setThreads(prev=>prev.filter(x=>x.id!==t.id));
    try{ await fetch(`${BACKEND}/api/community/threads/${t.id}?editor_name=${encodeURIComponent(userName)}`,{method:"DELETE"}); loadStats();loadLeaderboard(); }
    catch{ loadThreads(); }
  };

  return(<div style={{padding:"20px 24px",maxWidth:760,margin:"0 auto"}}>
    {/* Points strip */}
    <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,padding:"12px 18px",marginBottom:16,display:"flex",alignItems:"center",gap:20,flexWrap:"wrap"}}>
      <div style={{display:"flex",gap:16}}>
        {[{l:"Points",v:postPoints.points,c:P.blue},{l:"Kudos",v:postPoints.kudos??0,c:P.grn},{l:"Posts",v:postPoints.posts,c:P.purple},{l:"Replies",v:postPoints.replies,c:P.muted},{l:"Streak",v:`${postPoints.streak}d`,c:P.amber}].map(s=>(
          <div key={s.l} style={{textAlign:"center"}}>
            <div style={{fontSize:16,fontWeight:500,color:s.c}}>{s.v}</div>
            <div style={{fontSize:10.5,color:P.muted}}>{s.l}</div>
          </div>
        ))}
      </div>
      <span title="Posts +2 · replies +3 · each 👍 kudos your posts receive +5. Kudos are the real driver — helpfulness beats volume." style={{fontSize:10.5,color:P.dim,cursor:"help",borderBottom:`1px dotted ${P.dim}`}}>How points work</span>
      <div style={{flex:1}}/>
      <button onClick={()=>setShowLeaderboard(!showLeaderboard)}
        style={{background:showLeaderboard?P.blueGh:"transparent",border:`1px solid ${showLeaderboard?P.blue:P.border}`,borderRadius:7,padding:"5px 12px",fontSize:12,cursor:"pointer",color:showLeaderboard?P.blue:P.muted,fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:5}}>
        {showLeaderboard?"Hide leaderboard":<><Ic as={Ribbon} size={13} color="currentColor"/> Leaderboard</>}
      </button>
    </div>

    {/* Leaderboard */}
    {showLeaderboard&&<div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden",marginBottom:16}}>
      <div style={{padding:"11px 18px",borderBottom:`1px solid ${P.border}`,fontSize:13,fontWeight:600,color:P.txt}}>Community Leaderboard</div>
      {lb.length===0&&<div style={{padding:"16px 18px",fontSize:12.5,color:P.muted}}>No activity yet — be the first to post.</div>}
      {lb.map((row,idx)=>(
        <div key={row.name} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 18px",borderBottom:idx<lb.length-1?`1px solid ${P.bfaint}`:"none",background:row.name===userName?P.blueGh:"transparent"}}>
          <span style={{fontSize:14,fontWeight:500,color:idx===0?P.amber:idx===1?P.muted:P.dim,width:20,textAlign:"center"}}>{idx===0?"🥇":idx===1?"🥈":idx===2?"🥉":idx+1}</span>
          <div style={{width:28,height:28,borderRadius:"50%",background:P.purple,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:500,fontSize:11,flexShrink:0}}>{(row.name[0]||"?").toUpperCase()}</div>
          <div style={{flex:1}}>
            <div style={{fontSize:13,fontWeight:600,color:row.name===userName?P.blue:P.txt}}>{row.name}{row.name===userName?" (You)":""}</div>
            <div style={{fontSize:11,color:P.muted}}>👍 {row.kudos??0} kudos · {row.posts} posts · {row.replies} replies · {row.streak}d streak</div>
          </div>
          <span style={{fontSize:14,fontWeight:500,color:P.blue}}>{row.points} pts</span>
        </div>
      ))}
    </div>}

    {/* Filters + new post */}
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
      {["All","Projects","Platform Q&A","Cross-skilling"].map(f=>(
        <button key={f} onClick={()=>setFilter(f)} style={{background:filter===f?P.blue:"transparent",color:filter===f?"#fff":P.muted,border:`1px solid ${filter===f?P.blue:P.border}`,borderRadius:6,padding:"5px 12px",fontSize:12,fontWeight:filter===f?600:400,cursor:"pointer",fontFamily:"inherit"}}>{f}</button>
      ))}
      <div style={{flex:1}}/>
      <button onClick={()=>setShowNew(s=>!s)} style={{background:`linear-gradient(135deg,${P.blue},${P.blueDk})`,color:"#fff",border:"none",borderRadius:6,padding:"5px 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>+ New Post</button>
    </div>
    {showNew&&<Card style={{padding:"16px 18px",marginBottom:14}}>
      <div style={{fontSize:13,fontWeight:600,color:P.txt,marginBottom:10}}>New post</div>
      <input value={newTitle} onChange={e=>setNewTitle(e.target.value)}
        placeholder="What's your question or topic?"
        style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit",marginBottom:8}}/>
      <textarea value={newBody} onChange={e=>setNewBody(e.target.value)} rows={3}
        placeholder="Add details (optional)…"
        style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit",marginBottom:10,resize:"vertical"}}/>

      {/* Visibility */}
      <div style={{fontSize:11,fontWeight:600,color:P.dim,textTransform:"uppercase",letterSpacing:.5,marginBottom:6}}>Who can see this?</div>
      <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
        {Object.entries(VIS).map(([k,v])=>(
          <button key={k} onClick={()=>setNewVis(k)} title={v.d}
            style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:1,padding:"7px 12px",borderRadius:9,cursor:"pointer",fontFamily:"inherit",textAlign:"left",
              background:newVis===k?v.c+"18":"transparent",border:`1.5px solid ${newVis===k?v.c:P.border}`}}>
            <span style={{fontSize:12.5,fontWeight:600,color:newVis===k?v.c:P.txt}}>{v.i} {v.l}</span>
            <span style={{fontSize:10.5,color:P.muted}}>{v.d}</span>
          </button>
        ))}
      </div>

      {/* Mentions */}
      <div style={{fontSize:11,fontWeight:600,color:P.dim,textTransform:"uppercase",letterSpacing:.5,marginBottom:6}}>Tag people {mgr?"":"(sign in with your team to tag)"}</div>
      <div style={{position:"relative",marginBottom:12}}>
        {mentions.length>0&&<div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
          {mentions.map(m=>(
            <span key={m.email} style={{display:"inline-flex",alignItems:"center",gap:5,background:P.blueGh,color:P.blue,borderRadius:99,padding:"2px 6px 2px 10px",fontSize:11.5,fontWeight:600}}>
              @{m.name}<button onClick={()=>removeMention(m.email)} style={{background:"transparent",border:"none",color:P.blue,cursor:"pointer",fontSize:13,lineHeight:1,padding:0}}>×</button>
            </span>
          ))}
        </div>}
        <input value={mentionQ} onChange={e=>setMentionQ(e.target.value)} disabled={!mgr}
          placeholder={mgr?"Type a teammate's name…":"No team to tag"}
          style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 12px",fontSize:12.5,color:P.txt,background:mgr?P.bg:P.surface,outline:"none",boxSizing:"border-box",fontFamily:"inherit"}}/>
        {mentionMatches.length>0&&<div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:20,background:P.panel,border:`1px solid ${P.border}`,borderRadius:8,marginTop:4,boxShadow:P.shadow,overflow:"hidden"}}>
          {mentionMatches.map(m=>(
            <button key={m.email} onClick={()=>addMention(m)} style={{display:"flex",flexDirection:"column",alignItems:"flex-start",width:"100%",background:"transparent",border:"none",borderBottom:`1px solid ${P.bfaint}`,padding:"7px 12px",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
              <span style={{fontSize:12.5,fontWeight:600,color:P.txt}}>{m.name}</span>
              <span style={{fontSize:10.5,color:P.muted}}>{m.email}</span>
            </button>
          ))}
        </div>}
      </div>

      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <select value={newTag} onChange={e=>setNewTag(e.target.value)}
          style={{border:`1px solid ${P.border}`,borderRadius:7,padding:"7px 10px",fontSize:12.5,color:P.txt,background:P.bg,outline:"none",flex:1}}>
          {["Projects","Platform Q&A","Cross-skilling","Announcement","Kudos"].map(t=><option key={t}>{t}</option>)}
        </select>
        <button onClick={handlePost} disabled={!newTitle.trim()}
          style={{background:newTitle.trim()?P.blue:"#aaa",color:"#fff",border:"none",borderRadius:8,padding:"8px 18px",fontSize:13,fontWeight:600,cursor:newTitle.trim()?"pointer":"not-allowed",fontFamily:"inherit"}}>
          Post
        </button>
        <button onClick={()=>setShowNew(false)}
          style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 12px",fontSize:13,color:P.muted,cursor:"pointer",fontFamily:"inherit"}}>
          Cancel
        </button>
      </div>
    </Card>}
    {/* Product tag filter */}
    <div style={{display:"flex",gap:5,marginBottom:12,alignItems:"center",flexWrap:"wrap"}}>
      <span style={{fontSize:10,fontWeight:600,color:P.dim,textTransform:"uppercase",letterSpacing:.5,marginRight:2}}>Product:</span>
      {["All","AJO","CJA","Analytics","RTCDP"].map(pt=>{
        const c=PROD_COLORS[pt]||P.muted; const active=product===pt;
        return(<button key={pt} onClick={()=>setProduct(pt)}
          style={{fontSize:11,fontWeight:active?700:400,padding:"3px 10px",borderRadius:12,
            cursor:"pointer",fontFamily:"inherit",
            background:active?c:"transparent",color:active?"#fff":c,
            border:`1px solid ${active?c:c+"50"}`}}>{pt}</button>);
      })}
    </div>

    {visible.length===0&&<div style={{padding:"28px 0",textAlign:"center",color:P.muted,fontSize:13}}>No posts yet in this category — be the first!</div>}
    {visible.map(t=>(
      <Card key={t.id} style={{marginBottom:10}}>
        {editId===t.id?(
          <div style={{padding:"14px 16px"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontSize:12,fontWeight:600,color:P.txt,marginBottom:8}}>Edit post</div>
            <input value={editTitle} onChange={e=>setEditTitle(e.target.value)} style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 12px",fontSize:13,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit",marginBottom:8}}/>
            <textarea value={editBody} onChange={e=>setEditBody(e.target.value)} rows={3} placeholder="Details (optional)…" style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 12px",fontSize:13,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit",resize:"vertical",marginBottom:10}}/>
            <div style={{display:"flex",gap:8}}>
              <button onClick={saveEdit} disabled={!editTitle.trim()} style={{background:editTitle.trim()?P.blue:"#aaa",color:"#fff",border:"none",borderRadius:8,padding:"7px 16px",fontSize:12.5,fontWeight:600,cursor:editTitle.trim()?"pointer":"not-allowed",fontFamily:"inherit"}}>Save</button>
              <button onClick={()=>setEditId(null)} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"7px 12px",fontSize:12.5,color:P.muted,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
            </div>
          </div>
        ):(<>
        <div onClick={()=>setOpen(open===t.id?null:t.id)} style={{padding:"13px 16px",cursor:"pointer",display:"flex",alignItems:"flex-start",gap:12}}>
          <Avatar src={`https://i.pravatar.cc/96?u=${encodeURIComponent(t.author||String(t.id))}`} alt={t.author} size={32}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:t.body?3:5}}>{t.title}</div>
            {t.body&&<div style={{fontSize:12.5,color:P.muted,marginBottom:6,lineHeight:1.5,whiteSpace:"pre-line"}}>{t.body}</div>}
            {Array.isArray(t.mentions)&&t.mentions.length>0&&<div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:6}}>
              {t.mentions.map((m,mi)=>(<span key={mi} style={{fontSize:11,fontWeight:600,color:P.blue,background:P.blueGh,borderRadius:99,padding:"1px 8px"}}>@{m.name||m}</span>))}
            </div>}
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              {VIS[t.visibility]&&<span title={VIS[t.visibility].d} style={{fontSize:10.5,fontWeight:600,color:VIS[t.visibility].c,background:VIS[t.visibility].c+"15",borderRadius:99,padding:"1px 8px"}}>{VIS[t.visibility].i} {VIS[t.visibility].l}</span>}
              <TagPill tag={t.tag}/>
              <span style={{fontSize:11,color:P.dim}}>{t.author}</span>
              <span style={{fontSize:11,color:P.dim}}>· {t.replies.length} replies</span>
              <span style={{fontSize:11,color:P.dim}}>· {t.time}</span>
              {t.author===userName&&<>
                <button onClick={e=>{e.stopPropagation();startEdit(t);}} style={{fontSize:11,color:P.blue,background:"transparent",border:"none",cursor:"pointer",fontFamily:"inherit",padding:0}}>· Edit</button>
                <button onClick={e=>{e.stopPropagation();deletePost(t);}} style={{fontSize:11,color:P.red,background:"transparent",border:"none",cursor:"pointer",fontFamily:"inherit",padding:0}}>· Delete</button>
              </>}
            </div>
          </div>
          <button onClick={e=>{e.stopPropagation();toggleKudos(t);}} title={t.reacted?"Remove kudos":"Give kudos"}
            style={{flexShrink:0,display:"inline-flex",alignItems:"center",gap:5,background:t.reacted?P.grnBg:"transparent",border:`1px solid ${t.reacted?P.grn:P.border}`,borderRadius:99,padding:"4px 11px",cursor:"pointer",fontFamily:"inherit",color:t.reacted?P.grn:P.muted,fontSize:12.5,fontWeight:600,transition:"all .15s",marginRight:8}}>
            👍 {t.reactions||0}
          </button>
          <span style={{flexShrink:0}}><Ic as={open===t.id?ChevronUp:ChevronDown} size={14} color={P.dim}/></span>
        </div>
        {open===t.id&&<div style={{borderTop:`1px solid ${P.bfaint}`,padding:"12px 16px 14px"}}>
          {t.replies.length===0&&<div style={{fontSize:12.5,color:P.muted,marginBottom:12}}>No replies yet.</div>}
          {t.replies.map((r,i)=>(
            <div key={i} style={{display:"flex",gap:10,marginBottom:12}}>
              <Avatar src={`https://i.pravatar.cc/96?u=${encodeURIComponent(r.author||r.ini)}`} alt={r.author} size={28}/>
              <div style={{flex:1,background:P.bg,borderRadius:8,padding:"8px 12px"}}>
                <div style={{fontSize:11.5,fontWeight:600,color:P.txt,marginBottom:3}}>{r.author}</div>
                <div style={{fontSize:12.5,color:P.txt,lineHeight:1.5}}>{r.text}</div>
              </div>
            </div>
          ))}
          <div style={{display:"flex",gap:8,marginTop:4}}>
            <input value={replyText[t.id]||""} onChange={e=>setReplyText(prev=>({...prev,[t.id]:e.target.value}))}
              placeholder="Add a reply…" onKeyDown={e=>e.key==="Enter"&&handleReply(t.id,replyText[t.id])}
              style={{flex:1,border:`1px solid ${P.border}`,borderRadius:7,padding:"7px 12px",fontSize:12.5,outline:"none",background:P.bg,color:P.txt}}/>
            <button onClick={()=>handleReply(t.id,replyText[t.id])} style={{background:`linear-gradient(135deg,${P.blue},${P.blueDk})`,color:"#fff",border:"none",borderRadius:7,padding:"7px 16px",fontSize:12.5,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Reply</button>
          </div>
        </div>}
        </>)}
      </Card>
    ))}
  </div>);
}

// ── Flash Cards — Study Aid Agent (dynamic, module-aware) ─────────────────────

function FlashCards({module,moduleId,track="rtcdp",groqKey,profile}){
  const [cards,setCards]=useState([]);
  const [generating,setGenerating]=useState(true);
  const [usingFallback,setUsingFallback]=useState(false);
  const [idx,setIdx]=useState(0);
  const [flipped,setFlipped]=useState(false);
  const [known,setKnown]=useState([]);

  const [fromCache,setFromCache]=useState(false);

  const load=async(mod,mid,forceRefresh=false)=>{
    setGenerating(true);setUsingFallback(false);setIdx(0);setFlipped(false);setKnown([]);
    const cacheKey=`flashcards:${track}:${mod}`;
    if(forceRefresh) await bustCache(cacheKey);
    // Generate via the backend Study Aid agent (curriculum-grounded reasoning cards).
    // A failed/fallback generation is never cached (skipCache) — otherwise the
    // failure gets persisted and re-served on every subsequent load of this
    // module until someone happens to click Regenerate.
    const gen=async()=>{
      const{cards:c,usedFallback}=await callFlashcardAgent(mod,track,mid,null,profile?.conf??null);
      const value=(Array.isArray(c)&&c.length)?c:FLASH_FALLBACK;
      return usedFallback||!c.length?{value,skipCache:true}:value;
    };
    const{result,fromCache:cached}=await getCachedOrGenerate(cacheKey,"Study",gen);
    const isFallback=result===FLASH_FALLBACK||(Array.isArray(result)&&result.length<=1);
    setCards(result);setUsingFallback(isFallback);setFromCache(cached);setGenerating(false);
  };

  useEffect(()=>{load(module,moduleId);},[module,moduleId]);

  const go=dir=>{setFlipped(false);setTimeout(()=>setIdx(i=>(i+dir+cards.length)%cards.length),100);};

  const isDark=getThemeMode()==="dark";
  const ACCENT="#EB1000";
  const cardFrontBg=isDark?"rgba(235,16,0,.10)":"#FFF1ED";
  const cardFrontBd=isDark?"rgba(235,16,0,.4)":"#F3C3B8";
  const accTx=isDark?"#FF6A5C":ACCENT;

  if(generating) return(
    <div style={{padding:40,maxWidth:520,margin:"0 auto",textAlign:"center"}}>
      <div style={{width:48,height:48,borderRadius:"50%",background:cardFrontBg,border:`2px solid ${ACCENT}`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}><Ic as={CursorClick} size={22} color={ACCENT}/></div>
      <div style={{fontSize:14,fontWeight:500,color:P.txt,marginBottom:6}}>Generating flashcards…</div>
      <div style={{fontSize:12.5,color:P.muted}}>Study Aid Agent is creating cards for</div>
      <div style={{fontSize:12.5,fontWeight:600,color:accTx,marginTop:2}}>{module}</div>
    </div>
  );

  const card=cards[idx]||{q:"",a:""};
  return(<div style={{padding:20,maxWidth:520,margin:"0 auto"}}>
    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:10,gap:8}}>
      <div>
        <div style={{fontSize:12.5,fontWeight:500,color:P.txt}}>{module}</div>
        <div style={{fontSize:11,color:P.muted,marginTop:1}}>{idx+1} of {cards.length} cards{usingFallback?" · offline fallback":fromCache?" · cached":""}</div>
      </div>
      <div style={{display:"flex",gap:7,alignItems:"center",flexShrink:0}}>
        <span style={{fontSize:12,color:P.grn,fontWeight:600,display:"inline-flex",alignItems:"center",gap:3}}>{known.length} known <Ic as={Checkmark} size={12} color={P.grn}/></span>
        <button onClick={()=>load(module,moduleId,true)} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:5,padding:"2px 8px",fontSize:11,cursor:"pointer",color:P.muted,display:"inline-flex",alignItems:"center",gap:4}}><Ic as={Refresh} size={11} color={P.muted}/> Regenerate</button>
      </div>
    </div>
    <div style={{display:"flex",gap:5,marginBottom:16,justifyContent:"center"}}>
      {cards.map((_,i)=><div key={i} onClick={()=>{setIdx(i);setFlipped(false);}} style={{width:8,height:8,borderRadius:"50%",background:known.includes(i)?P.grn:i===idx?ACCENT:P.bfaint,cursor:"pointer",transition:"background .2s"}}/>)}
    </div>
    <div onClick={()=>setFlipped(!flipped)} style={{background:flipped?P.grnBg:cardFrontBg,border:`1.5px solid ${flipped?(getThemeMode()==="dark"?"#3A3D48":"#CFCFCF"):cardFrontBd}`,borderRadius:12,padding:"28px 24px",minHeight:140,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:"pointer",textAlign:"center",transition:"background .2s",boxShadow:"0 2px 8px rgba(0,0,0,.05)"}}>
      <div style={{fontSize:10,fontWeight:500,letterSpacing:.6,textTransform:"uppercase",color:flipped?P.grn:accTx,marginBottom:12}}>{flipped?"Answer":"Question — tap to flip"}</div>
      <div style={{fontSize:14,fontWeight:flipped?400:600,color:P.txt,lineHeight:1.7}}>{flipped?card.a:card.q}</div>
    </div>
    <div style={{display:"flex",gap:10,marginTop:14,justifyContent:"center"}}>
      <button onClick={()=>go(-1)} style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:7,padding:"8px 18px",fontSize:13,cursor:"pointer",color:P.txt,display:"inline-flex",alignItems:"center",gap:5}}><Ic as={ChevronLeft} size={14} color={P.txt}/> Prev</button>
      {flipped&&!known.includes(idx)&&<button onClick={()=>{setKnown(p=>[...p,idx]);go(1);}} style={{background:P.grn,color:"#fff",border:"none",borderRadius:7,padding:"8px 20px",fontSize:13,fontWeight:600,cursor:"pointer",display:"inline-flex",alignItems:"center",gap:5}}>Got it <Ic as={Checkmark} size={14} color="#fff"/></button>}
      {flipped&&<button onClick={()=>go(1)} style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:7,padding:"8px 18px",fontSize:13,cursor:"pointer",color:P.txt,display:"inline-flex",alignItems:"center",gap:5}}>Next <Ic as={ChevronRight} size={14} color={P.txt}/></button>}
      {!flipped&&<button onClick={()=>go(1)} style={{background:"linear-gradient(135deg,#FF5A3D,#EB1000)",color:"#fff",border:"none",borderRadius:7,padding:"8px 20px",fontSize:13,fontWeight:600,cursor:"pointer",display:"inline-flex",alignItems:"center",gap:5}}>Next <Ic as={ChevronRight} size={14} color="#fff"/></button>}
    </div>
  </div>);
}

// ── Reasoning Agent ───────────────────────────────────────────────────────────
// ── Learning Assistant · Socratic + Reasoning unified with mode toggle ────────
// ── Lightweight inline markdown (bold/italic/linebreaks) for chat bubbles ──
// render assistant text cleanly without pulling in a full markdown library.
const renderLiteMarkdown=(text)=>{
  if(typeof text!=="string")return text;
  const lines=text.replace(/^\s*-{3,}\s*$/gm,"").split("\n");
  return lines.map((line,li)=>{
    const parts=[];const re=/\*\*(.+?)\*\*|\*(.+?)\*/g;
    let last=0,m,key=0;
    while((m=re.exec(line))){
      if(m.index>last)parts.push(line.slice(last,m.index));
      parts.push(m[1]!==undefined?<strong key={key++}>{m[1]}</strong>:<em key={key++}>{m[2]}</em>);
      last=re.lastIndex;
    }
    parts.push(line.slice(last));
    return <span key={li}>{parts}{li<lines.length-1?<br/>:null}</span>;
  });
};

function LearningAssistant({groqKey,onLog,onJudge,profile,githubToken,onConfUpdate,dashboard="new_joiner"}){
  // Default to "Explain fully" (Reasoning) for signed-in learners — most people
  // want the answer. Demo profiles (no real session) can't use Reasoning, so they
  // start in "Guide me" (Socratic), which works without a login.
  const [mode,setMode]=useState(profile?.id?"reasoning":"socratic");
  const firstName=profile?.name?.split(" ")[0]||"there";
  const module=profile?.module||"Segment Evaluation Logic";

  const initMsgs={
    socratic:[{role:"assistant",content:`Hi ${firstName}. In Guide me mode I won't hand you the answer — I'll ask questions to help you reason through ${module} yourself. Switch to Explain fully anytime if you'd rather I just explain it. What would you like to explore?`}],
    reasoning:[{role:"assistant",content:`Hi ${profile?.displayName||firstName}. Ask me anything about ${module} and I'll explain it fully, step by step. Prefer to work it out yourself? Switch to Guide me for hints instead of answers.`}],
  };
  const [msgs,setMsgs]=useState({socratic:initMsgs.socratic,reasoning:initMsgs.reasoning});
  const [judges,setJudges]=useState({});
  const [docSources,setDocSources]=useState({});
  const [reasoningMeta,setReasoningMeta]=useState({});
  const [input,setInput]=useState(""),[busy,setBusy]=useState(false),[retrieving,setRetrieving]=useState(false);
  const [editingIdx,setEditingIdx]=useState(null),[editText,setEditText]=useState("");  // #6 edit-a-message state
  const [searchQ,setSearchQ]=useState(""),[searchResults,setSearchResults]=useState(null);  // #8 chat search
  const [imageFile,setImageFile]=useState(null),[imageB64,setImageB64]=useState(null),[imageMime,setImageMime]=useState(null);
  const [summary,setSummary]=useState(null),[summaryLoading,setSummaryLoading]=useState(false);
  const exchangeCountRef=useRef(0);
  const incrementExchange=()=>{exchangeCountRef.current+=1;return exchangeCountRef.current;};
  const ref=useRef(null),fileRef=useRef(null);

  const curMsgs=msgs[mode];
  const setModeMsg=ms=>setMsgs(prev=>{
    const cur=prev[mode]||[];
    const next=typeof ms==='function'?ms(cur):ms;
    return{...prev,[mode]:next};
  });

  // ── Thread-based chat history (ChatGPT / Claude style) ──────────────────────
  // Conversations are persisted server-side per authenticated user, so they
  // survive logout/login. The sidebar lists every thread; "New chat" starts a
  // fresh one; clicking a thread reloads its full history (and reasoning chips).
  const [convos,setConvos]=useState([]);          // sidebar thread list
  const [activeId,setActiveId]=useState(null);    // current thread id (null = unsaved new chat)
  const [sidebarOpen,setSidebarOpen]=useState(true);
  const activeIdRef=useRef(null);                 // avoids stale-closure races within send()
  const convoInflight=useRef(null);               // dedupes concurrent create calls
  const setActive=id=>{activeIdRef.current=id;setActiveId(id);};

  const loadConvos=()=>{
    if(!profile?.id)return;
    // Scope threads to THIS dashboard so a learner's New-Joiner and Experience
    // chats stay separate (the same LearningAssistant renders in both).
    fetch(`${BACKEND}/api/chat/conversations?dashboard=${encodeURIComponent(dashboard)}`,{credentials:"include"})
      .then(r=>r.ok?r.json():{conversations:[]})
      .then(d=>setConvos(d?.conversations||[]))
      .catch(()=>{});
  };
  // Load the thread list once the user is known, AND whenever mode/dashboard
  // changes (so Reasoning and Socratic — and each dashboard — have separate sidebars).
  useEffect(()=>{loadConvos();},[profile?.id,mode,dashboard]);

  // ── #8 Search across this learner's own chat history (current mode only) ─────
  const runSearch=q=>{
    const term=(q||"").trim();
    if(term.length<2){setSearchResults(null);return;}
    fetch(`${BACKEND}/api/chat/search?q=${encodeURIComponent(term)}&mode=${encodeURIComponent(mode)}`,{credentials:"include"})
      .then(r=>r.ok?r.json():{results:[]})
      .then(d=>setSearchResults(d?.results||[]))
      .catch(()=>setSearchResults([]));
  };
  // Debounce so we don't fire a request on every keystroke.
  useEffect(()=>{
    if(!profile?.id)return;
    const t=setTimeout(()=>runSearch(searchQ),300);
    return()=>clearTimeout(t);
  },[searchQ,mode]);
  const clearSearch=()=>{setSearchQ("");setSearchResults(null);};

  // Rebuild the reasoning chips (intent/tools/degraded/grounded) from stored metadata.
  const rebuildMetaFrom=messages=>{
    const rm={};
    messages.forEach((m,i)=>{
      if(m.role==="assistant"&&m.metadata){
        const md=m.metadata;
        rm[`r-${i+1}`]={intent:md.intent||"",toolCalls:md.toolCalls||md.tool_calls||[],
          qualityScore:md.qualityScore||md.quality_score||0,
          qualityIssue:md.qualityIssue||md.quality_issue||null,
          degraded:!!md.degraded,grounded:md.grounded};
      }
    });
    return rm;
  };

  const loadConversation=id=>{
    if(!profile?.id)return;
    fetch(`${BACKEND}/api/chat/conversations/${id}`,{credentials:"include"})
      .then(r=>r.ok?r.json():null)
      .then(d=>{
        if(!d)return;
        const conv=convos.find(c=>c.id===id);
        const cmode=conv?.mode||mode;
        const loaded=(d.messages||[]).map(m=>({role:m.role,content:m.content,metadata:m.metadata,dbId:m.id}));
        setMode(cmode);
        setMsgs(prev=>({...prev,[cmode]:loaded.length?loaded:initMsgs[cmode]}));
        setReasoningMeta(rebuildMetaFrom(loaded));
        setActive(id);
      }).catch(()=>{});
  };

  const newChat=()=>{
    setActive(null);
    setModeMsg(initMsgs[mode]);
    setReasoningMeta({});
    setSummary(null);
  };

  // Manually toggling Socratic/Reasoning starts a fresh thread in that mode
  // (each thread has a single mode; loadConversation sets the mode programmatically).
  const switchMode=id=>{
    if(id===mode)return;
    setMode(id);
    setActive(null);
    setMsgs(prev=>({...prev,[id]:initMsgs[id]}));
    setReasoningMeta({});
    setSummary(null);
  };

  const deleteConvo=async id=>{
    if(!profile?.id)return;
    await fetch(`${BACKEND}/api/chat/conversations/${id}`,{method:"DELETE",credentials:"include"}).catch(()=>{});
    if(activeIdRef.current===id)newChat();
    loadConvos();
  };

  // Lazily create a thread on first message; concurrent callers share one create.
  const ensureConversation=()=>{
    if(activeIdRef.current)return Promise.resolve(activeIdRef.current);
    if(convoInflight.current)return convoInflight.current;
    convoInflight.current=(async()=>{
      try{
        const r=await fetch(`${BACKEND}/api/chat/conversations`,{method:"POST",credentials:"include",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({mode,module,track:getTrack(profile),dashboard})});
        const d=await r.json();
        setActive(d.id);
        return d.id;
      }finally{convoInflight.current=null;}
    })();
    return convoInflight.current;
  };

  // Persist a message (and, for reasoning, its chip metadata) to the active thread.
  // Returns the new message's DB id (or null) so callers can attach it for feedback.
  const saveMessage=async(role,content,metadata=null)=>{
    if(!profile?.id)return null; // only persist for real registered users
    const textContent=typeof content==="string"?content:(content.find?.(c=>c.type==="text")?.text||"[image]");
    try{
      const cid=await ensureConversation();
      const r=await fetch(`${BACKEND}/api/chat/conversations/${cid}/messages`,{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({role,content:textContent,metadata})});
      const d=await r.json().catch(()=>({}));
      loadConvos(); // refresh sidebar (auto-title + reordering)
      return d?.id||null;
    }catch(e){return null;}
  };

  // Attach a DB message id to the most-recent assistant bubble so its 👍/👎
  // feedback can reference the row (fresh streamed messages have no id until saved).
  const attachDbId=mid=>{
    if(!mid)return;
    setModeMsg(p=>{
      const c=[...p];
      for(let i=c.length-1;i>=0;i--){if(c[i].role==="assistant"){c[i]={...c[i],dbId:mid};break;}}
      return c;
    });
  };

  // ── Stop / streaming control ────────────────────────────────────────────────
  const streamAbortRef=useRef(null);
  const stopStreaming=()=>{try{streamAbortRef.current?.abort();}catch(_){}};

  // Consume the reasoning SSE stream for one turn: append a new assistant bubble,
  // fill it token-by-token, then attach chips + persist on done. `assistantKey` is
  // the positional reasoningMeta key (`r-<n>`) for this turn's chips. Shared by
  // both send() and regenerate().
  const consumeReasoningStream=async(apiMsgs,assistantKey)=>{
    let acc="",started=false,rMeta=null,text="";
    const ctrl=new AbortController();streamAbortRef.current=ctrl;
    const putLast=t=>setModeMsg(p=>{const c=[...p];c[c.length-1]={...c[c.length-1],role:"assistant",content:t};return c;});
    try{
      const resp=await fetch(`${BACKEND}/api/agents/reasoning/stream`,{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},signal:ctrl.signal,
        body:JSON.stringify({messages:apiMsgs,profile,track:getTrack(profile),module,extra:{}})});
      if(!resp.ok||!resp.body)throw new Error(`stream unavailable (${resp.status})`);
      const reader=resp.body.getReader(),decoder=new TextDecoder();let buf="";
      let stoppedMidStream=false;
      outer: while(true){
        const{done,value}=await reader.read();
        if(done)break;
        buf+=decoder.decode(value,{stream:true});
        const frames=buf.split("\n\n");buf=frames.pop();
        for(const frame of frames){
          // The server already paces token delivery, but the network can still
          // deliver several buffered frames in one chunk — without this check,
          // a burst that arrives after Stop is pressed would render in full
          // anyway, since aborting only interrupts the NEXT reader.read() call,
          // not frames already sitting in a chunk that already arrived.
          if(ctrl.signal.aborted){stoppedMidStream=true;break outer;}
          const line=frame.split("\n").find(l=>l.startsWith("data:"));
          if(!line)continue;
          let ev;try{ev=JSON.parse(line.slice(5).trim());}catch(_){continue;}
          if(ev.type==="token"){
            acc+=ev.text;
            if(!started){started=true;setBusy(false);setModeMsg(p=>[...p,{role:"assistant",content:acc}]);}
            else{putLast(acc);}
            // Client-side pacing so the typewriter effect (and Stop's ability to
            // interrupt it) doesn't depend on how the network happens to batch
            // the server's paced chunks — without this, a burst of already-
            // arrived tokens rendered synchronously with no gap to check Stop.
            await new Promise(r=>setTimeout(r,15));
          }else if(ev.type==="done"){
            text=ev.response||acc;
            rMeta={intent:ev.intent||"",toolCalls:ev.tool_calls||[],qualityScore:ev.quality_score||0,qualityIssue:ev.quality_issue||null,degraded:!!ev.degraded,grounded:ev.grounded};
          }else if(ev.type==="error"){throw new Error(ev.detail||"stream error");}
        }
      }
      if(stoppedMidStream){
        try{ctrl.abort();}catch(_){}
        const partial=(acc||"").trim()||"(stopped)";
        if(!started){setModeMsg(p=>[...p,{role:"assistant",content:partial}]);}else{putLast(partial);}
        const mid=await saveMessage("assistant",partial,rMeta);
        attachDbId(mid);
        setBusy(false);
        return partial;
      }
      if(!started&&!text)throw new Error("empty stream");
      const finalText=text||acc;
      if(!started){setModeMsg(p=>[...p,{role:"assistant",content:finalText}]);}else{putLast(finalText);}
      if(rMeta)setReasoningMeta(rm=>({...rm,[assistantKey]:rMeta}));
      const mid=await saveMessage("assistant",finalText,rMeta);
      attachDbId(mid);
      return finalText;
    }catch(e){
      if(e.name==="AbortError"){
        // User pressed Stop — keep whatever streamed and persist that partial answer.
        const partial=(acc||"").trim()||"(stopped)";
        if(!started){setModeMsg(p=>[...p,{role:"assistant",content:partial}]);}else{putLast(partial);}
        if(rMeta)setReasoningMeta(rm=>({...rm,[assistantKey]:rMeta}));
        const mid=await saveMessage("assistant",partial,rMeta);
        attachDbId(mid);
        return partial;
      }
      // Fallback: direct non-streaming model call so the learner still gets an answer.
      const fb=await callAgent(apiMsgs,buildPrompt("reasoning",profile,{module}),groqKey,{agentName:"Reasoning",logFn:onLog,maxTokens:300}).catch(()=>"");
      const finalText=fb||acc||"Sorry, I couldn't generate a response. Please try again.";
      if(!started){setModeMsg(p=>[...p,{role:"assistant",content:finalText}]);}else{putLast(finalText);}
      const mid=await saveMessage("assistant",finalText,rMeta);
      attachDbId(mid);
      return finalText;
    }finally{streamAbortRef.current=null;setBusy(false);}
  };

  // Regenerate the last assistant answer (Reasoning mode): drop it locally + in the
  // DB, then re-stream a fresh response for the same preceding user message.
  const regenerate=async()=>{
    if(busy||mode!=="reasoning")return;
    const cur=msgs[mode]||[];
    let lastAssistant=-1;
    for(let i=cur.length-1;i>=0;i--){if(cur[i].role==="assistant"){lastAssistant=i;break;}}
    if(lastAssistant<=0)return;                          // nothing but the greeting
    const upto=cur.slice(0,lastAssistant);               // everything before that answer
    if(!upto.length||upto[upto.length-1].role!=="user")return;
    const apiMsgs=upto.map(m=>({role:m.role,content:typeof m.content==="string"?m.content:(m.content.find?.(b=>b.type==="text")?.text||"")}));
    setModeMsg(upto);                                    // remove old answer from view
    setBusy(true);
    if(activeIdRef.current){
      await fetch(`${BACKEND}/api/chat/conversations/${activeIdRef.current}/messages/last`,{method:"DELETE",credentials:"include"}).catch(()=>{});
    }
    await consumeReasoningStream(apiMsgs,`r-${upto.length+1}`);
  };

  // Record 👍/👎 on an assistant message (persists into that message's metadata).
  const sendFeedback=async(msg,rating)=>{
    if(!msg?.dbId)return;
    const next=(msg.metadata?.feedback===rating)?null:rating;   // click same = toggle off
    setModeMsg(p=>p.map(x=>x===msg?{...x,metadata:{...(x.metadata||{}),feedback:next}}:x));
    fetch(`${BACKEND}/api/chat/messages/${msg.dbId}/feedback`,{method:"POST",credentials:"include",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({rating:next})}).catch(()=>{});
  };

  // ── #6 Edit a previously-sent user message ──────────────────────────────────
  const startEdit=(i,text)=>{setEditingIdx(i);setEditText(text);};
  const cancelEdit=()=>{setEditingIdx(null);setEditText("");};
  // Save the edit: rewrite that user turn, discard everything after it (the old
  // answer + later turns — the conversation forks here), then re-generate a fresh
  // reply for the new text. Mirrors regenerate() but keys off an arbitrary index.
  const saveEdit=async(i)=>{
    if(busy)return;
    const newText=editText.trim();
    const cur=msgs[mode]||[];
    const target=cur[i];
    if(!target||target.role!=="user"||!newText){cancelEdit();return;}
    const editedMsg={role:"user",content:newText};        // editing drops any image (text-only)
    const truncated=[...cur.slice(0,i),editedMsg];         // fork: keep up to & incl. edited turn
    setEditingIdx(null);setEditText("");
    setModeMsg(truncated);
    // Drop chip/judge/doc metadata only for turns AT or AFTER the edit point (key
    // number > i — keys use 1-based "array index + 1"), so badges on the earlier,
    // still-valid turns aren't wiped along with the discarded ones.
    const keepKey=k=>{const n=parseInt(k.slice(2),10);return Number.isNaN(n)||n<=i;};
    setReasoningMeta(rm=>Object.fromEntries(Object.entries(rm).filter(([k])=>keepKey(k))));
    setJudges(j=>Object.fromEntries(Object.entries(j).filter(([k])=>keepKey(k))));
    setDocSources(ds=>Object.fromEntries(Object.entries(ds).filter(([k])=>keepKey(k))));
    if(target.dbId){
      await fetch(`${BACKEND}/api/chat/messages/${target.dbId}`,{method:"PATCH",credentials:"include",
        headers:{"Content-Type":"application/json"},body:JSON.stringify({content:newText})}).catch(()=>{});
    }
    const apiMsgs=truncated.map(m=>({role:m.role,content:typeof m.content==="string"?m.content:(m.content.find?.(b=>b.type==="text")?.text||"")}));
    setBusy(true);
    try{
      if(mode==="reasoning"){
        await consumeReasoningStream(apiMsgs,`r-${truncated.length+1}`);
      }else{
        setRetrieving(true);
        const{docs,source}=await retrieveDocs(newText,module,githubToken,getTrack(profile));
        setRetrieving(false);
        const sys=buildPrompt("socratic",profile,{module,docs,docsSource:source});
        const text=await callAgent(apiMsgs,sys,groqKey,{agentName:"Socratic",logFn:onLog});
        const msgIdx=truncated.length;
        setModeMsg(p=>[...p,{role:"assistant",content:text}]);
        saveMessage("assistant",text).then(attachDbId);
        setDocSources(prev=>({...prev,[`s-${msgIdx}`]:{docs,source}}));
        setBusy(false);
        setJudges(j=>({...j,[`s-${msgIdx}`]:{status:"loading"}}));
        judgeResponse(text).then(result=>{
          setJudges(j=>({...j,[`s-${msgIdx}`]:{status:"done",...result}}));
        });
      }
    }catch(e){setModeMsg(p=>[...p,{role:"assistant",content:`Error: ${e.message}`}]);setBusy(false);setRetrieving(false);}
  };

  useEffect(()=>{if(ref.current)ref.current.scrollTop=ref.current.scrollHeight;},[msgs,judges,busy]);

  // Image picker
  const pickImage=e=>{
    const f=e.target.files?.[0];if(!f)return;
    const reader=new FileReader();
    reader.onload=ev=>{
      const b64=ev.target.result.split(",")[1];
      setImageFile(f);setImageB64(b64);setImageMime(f.type||"image/jpeg");
    };
    reader.readAsDataURL(f);
  };
  const clearImage=()=>{setImageFile(null);setImageB64(null);setImageMime(null);if(fileRef.current)fileRef.current.value="";};

  // Reasoning mode calls the authenticated backend agent (identity, rate limiting,
  // and persistence all require a real session) — demo personas (login picker, no
  // IMS) have no session cookie, so block them here with a clear message instead of
  // letting the call 401 and surface a raw backend error string.
  const needsRealLogin=mode==="reasoning"&&!profile?.id;

  const send=async(overrideText=null)=>{
    const typed=(typeof overrideText==="string"?overrideText:input);
    if((!typed.trim()&&!imageB64)||busy||needsRealLogin)return;
    const userText=typed.trim()||"Please look at this image and help me understand it.";

    // Build user message — text or multimodal
    const userContent=imageB64
      ?[{type:"image",source:{type:"base64",media_type:imageMime,data:imageB64}},{type:"text",text:userText}]
      :userText;
    const nm={role:"user",content:userContent,imagePreview:imageB64?`data:${imageMime};base64,${imageB64}`:null};
    const apiMsgs=[...curMsgs,nm].map(m=>({role:m.role,content:m.content}));
    const next=[...curMsgs,nm];
    setModeMsg(next);setInput("");clearImage();setBusy(true);
    saveMessage("user",userText);

    try{
      let text="";
      // Log chat event to DB
      fetch(`${BACKEND}/api/telemetry`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({persona:profile?.persona||"nj",event_type:"chat_msg",module,
          detail:`${mode} session`})}).catch(()=>{});

      if(mode==="socratic"){
        setRetrieving(true);
        const{docs,source}=await retrieveDocs(userText,module,githubToken,getTrack(profile));
        setRetrieving(false);
        const sys=buildPrompt("socratic",profile,{module,docs,docsSource:source});
        text=await callAgent(apiMsgs,sys,groqKey,{agentName:"Socratic",logFn:onLog});
        const msgIdx=next.length;
        setModeMsg(p=>[...p,{role:"assistant",content:text}]);
        saveMessage("assistant",text).then(attachDbId);
        setDocSources(prev=>({...prev,[`s-${msgIdx}`]:{docs,source}}));
        setBusy(false);
        setJudges(j=>({...j,[`s-${msgIdx}`]:{status:"loading"}}));
        judgeResponse(text).then(result=>{
          const entry={id:Date.now(),ts:new Date().toLocaleTimeString(),text:text.slice(0,70),score:result.score,...result};
          setJudges(j=>({...j,[`s-${msgIdx}`]:{status:"done",...result}}));
          onJudge?.(entry);
          // Save guardrail result to DB
          fetch(`${BACKEND}/api/guardrail/save`,{method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({word_count:result.wordCount,has_one_question:result.hasOneQuestion,
              avoids_direct_answer:result.avoidsDirectAnswer,score:result.score,
              issue:result.issue||null,response_preview:text.slice(0,100)})}).catch(()=>{});
          // Nudge confidence every 3 exchanges — use ref to avoid stale closure
          if(onConfUpdate&&mode==="socratic"){
            const count=incrementExchange();
            if(count%3===0){
              const delta=result.score>=7?0.02:result.score>=5?0.01:0;
              if(delta>0)onConfUpdate((profile?.conf||.76)+delta);
            }
          }
        });
      } else {
        // Reasoning mode. rMeta holds the chip metadata (intent/tools/degraded/
        // grounded) so it can be both rendered AND persisted.
        let rMeta=null;
        const mi=curMsgs.length;
        if(imageB64){
          // Image path stays non-streaming — the backend runs the vision model and
          // returns the full answer in one shot.
          const r=await fetch(`${BACKEND}/api/agents/reasoning`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:apiMsgs,profile,track:getTrack(profile),module,extra:{image_b64:imageB64}})});
          const d=await r.json();
          text=d.response||"Could not process image.";
          rMeta={intent:d.intent||"",toolCalls:d.tool_calls||[],qualityScore:d.quality_score||0,qualityIssue:d.quality_issue||null,degraded:!!d.degraded,grounded:d.grounded};
          setReasoningMeta(rm=>({...rm,[`r-${mi+2}`]:rMeta}));
          setModeMsg(p=>[...p,{role:"assistant",content:text}]);
          const mid=await saveMessage("assistant",text,rMeta);
          attachDbId(mid);
          setBusy(false);
        } else {
          // Streaming path (SSE) — the backend runs the FULL vetted pipeline, then
          // streams the approved answer word-by-word (see consumeReasoningStream).
          await consumeReasoningStream(apiMsgs,`r-${mi+2}`);
        }
      }
    }catch(e){setModeMsg(p=>[...p,{role:"assistant",content:`Error: ${e.message}`}]);setBusy(false);setRetrieving(false);}
  };

  const generateSummary=async()=>{
    setSummaryLoading(true);setSummary(null);
    const conversation=curMsgs.filter(m=>m.role!=="system").map(m=>`${m.role==="user"?"Learner":"Agent"}: ${typeof m.content==="string"?m.content:"[image uploaded]"}`).join("\n");
    try{
      const text=await callAgent([{role:"user",content:`Summarise this learning session in exactly 3 bullet points. Be specific, not generic.\n\n${conversation}`}],
        "You summarise learning sessions into 3 concise bullet points. Each bullet: what the learner explored, what reasoning they worked through, what they should do next. Be specific. Return only the 3 bullets, no preamble.",
        groqKey,{agentName:"Summary",logFn:null,maxTokens:200});
      setSummary(text);
      // Persist to PostgreSQL
      fetch(`${BACKEND}/api/summary`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          persona:profile?.persona||"nj",
          module:module||"Unknown",
          mode,
          message_count:curMsgs.length,
          summary:text,
          created_at:new Date().toISOString()
        })}).catch(()=>{});
    }catch(e){setSummary(`Could not generate summary: ${e.message}`);}
    setSummaryLoading(false);
  };

  // Load last session summary from DB on mount
  useEffect(()=>{
    if(!profile?.persona)return;
    fetch(`${BACKEND}/api/summary/latest?persona=${profile.persona}&module=${encodeURIComponent(module||"")}`)
      .then(r=>r.json())
      .then(d=>{if(d?.summary&&!summary)setSummary(`↩ Previous session:\n${d.summary}`);})
      .catch(()=>{});
  },[]);

  const isDark=getThemeMode()==="dark";
  const ACCENT="#EB1000";
  // Both modes share the brand red — keeps Reasoning visually aligned with
  // Socratic/the rest of Nexus instead of an unrelated purple.
  const modeColor=ACCENT;
  const modeBg=isDark?"rgba(235,16,0,.12)":"#FFF1ED";

  const JudgeBadge=({k})=>{
    const j=judges[k];if(!j)return null;
    if(j.status==="loading")return<span style={{fontSize:9.5,color:P.dim,marginLeft:6}}>Evaluating…</span>;
    const col=j.score>=7?P.grn:j.score>=5?P.amber:P.red;
    const bg=j.score>=7?P.grnBg:j.score>=5?P.amberBg:P.redBg;
    return<span title={j.issue||"All checks passed"} style={{marginLeft:7,fontSize:9.5,fontWeight:500,padding:"1px 6px",borderRadius:3,background:bg,color:col,cursor:"help"}}>✦ {j.score}/10 · {j.wordCount}w · {j.hasOneQuestion?"1Q✓":"!Q"} · {j.avoidsDirectAnswer?"safe✓":"!safe"}</span>;
  };
  const INTENT_LABELS={checkpoint_response:"Checkpoint",clarification:"Re-explaining",go_deeper:"Going deeper",stuck:"Worked example",new_question:"New question",off_topic:"Off-topic redirect"};
  const IntentChip=({k})=>{
    const meta=reasoningMeta[k];if(!meta||!meta.intent)return null;
    return<span style={{marginLeft:7,fontSize:9.5,fontWeight:600,padding:"1px 7px",borderRadius:3,background:P.purpleBg,color:P.purple}}>{INTENT_LABELS[meta.intent]||meta.intent}</span>;
  };
  const ToolCallBadges=({k})=>{
    const meta=reasoningMeta[k];const calls=(meta?.toolCalls||[]).filter(t=>!t.blocked);if(!calls.length)return null;
    return<span style={{display:"inline-flex",gap:4,flexWrap:"wrap",marginLeft:6}}>{calls.map((t,i)=><span key={i} style={{fontSize:9,fontWeight:600,padding:"1px 6px",borderRadius:3,background:P.blueGh||P.surface,color:P.blue,border:`1px solid ${P.border}`}}>⚡ {String(t.tool).replace(/_/g," ")}</span>)}</span>;
  };
  // Warns when the answer is NOT model-generated (all LLM calls failed → canned
  // fallback text) or not grounded in retrieved docs — so a degraded reply is
  // never mistaken for a healthy one.
  const DegradedChip=({k})=>{
    const meta=reasoningMeta[k];if(!meta)return null;
    if(meta.degraded)return<span title="The AI service could not be reached — this is a generic fallback reply, not a real answer." style={{marginLeft:6,fontSize:9,fontWeight:700,padding:"1px 6px",borderRadius:3,background:P.redBg,color:P.red,border:`1px solid ${P.red}40`,cursor:"help"}}>⚠ degraded (fallback)</span>;
    if(meta.grounded===false)return<span title="No supporting documentation was found — this answer is from the model's general knowledge, not your curriculum docs." style={{marginLeft:6,fontSize:9,fontWeight:600,padding:"1px 6px",borderRadius:3,background:P.amberBg,color:P.amber,border:`1px solid ${P.amber}40`,cursor:"help"}}>⚠ ungrounded</span>;
    return null;
  };
  const DocBadges=({k})=>{
    const entry=docSources[k];if(!entry?.docs?.length)return null;
    const{docs,source}=entry;
    const methodLabel={embeddings:"semantic match",github:"keyword match",local:"offline fallback"}[source]||source;
    return<div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:5,alignItems:"center"}}>
      <span style={{fontSize:9,color:P.dim,fontWeight:600,letterSpacing:.3,textTransform:"uppercase"}}>{methodLabel}:</span>
      {docs.map((d,i)=><a key={i} href={d.url} target="_blank" rel="noreferrer" style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:9.5,fontWeight:600,padding:"1px 7px",borderRadius:3,background:P.surface,color:P.muted,border:`1px solid ${P.border}`,textDecoration:"none"}}><Ic as={FileText} size={10} color={P.muted}/> {d.title} · {d.repo}{d.score!=null?` · ${Math.round(d.score*100)}%`:""}</a>)}
    </div>;
  };

  return(<div style={{display:"flex",height:"100%",background:P.bg}}>
    {/* ── Conversation sidebar (ChatGPT / Claude style) ─────────────────────── */}
    {profile?.id&&sidebarOpen&&(
      <div style={{width:248,flexShrink:0,background:P.panel,borderRight:`1px solid ${P.border}`,display:"flex",flexDirection:"column",height:"100%"}}>
        <div style={{padding:"12px 12px 8px",flexShrink:0}}>
          <button onClick={newChat} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",gap:7,background:modeColor,color:"#fff",border:"none",borderRadius:9,padding:"9px 12px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
            <Ic as={Edit} size={15} color="#fff"/> New chat
          </button>
          {/* #8 search box */}
          <div style={{position:"relative",marginTop:8}}>
            <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="Search chats…"
              style={{width:"100%",boxSizing:"border-box",padding:"7px 26px 7px 10px",borderRadius:8,border:`1px solid ${P.border}`,background:P.surface,color:P.txt,fontSize:12,fontFamily:"inherit",outline:"none"}}/>
            {searchQ&&<button onClick={clearSearch} title="Clear" style={{position:"absolute",right:6,top:"50%",transform:"translateY(-50%)",background:"transparent",border:"none",cursor:"pointer",color:P.dim,fontSize:14,lineHeight:1,padding:2}}>×</button>}
          </div>
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"4px 8px 12px"}}>
          {searchResults!==null?(
            /* #8 search results view */
            <>
              {searchResults.length===0&&<div style={{fontSize:11.5,color:P.dim,textAlign:"center",padding:"20px 8px",lineHeight:1.6}}>No matches for “{searchQ}”.</div>}
              {searchResults.map((r,ri)=>(
                <div key={ri} onClick={()=>{loadConversation(r.conversation_id);clearSearch();}} title={r.title}
                  style={{padding:"8px 9px",borderRadius:7,cursor:"pointer",marginBottom:3,background:"transparent",border:`1px solid transparent`}}
                  onMouseEnter={e=>e.currentTarget.style.background=P.surface}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <div style={{fontSize:12,fontWeight:600,color:P.txt,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.title||"New chat"}</div>
                  <div style={{fontSize:11,color:P.dim,marginTop:2,lineHeight:1.4,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>
                    <span style={{color:P.muted,textTransform:"capitalize"}}>{r.role}:</span> {r.snippet}
                  </div>
                </div>
              ))}
            </>
          ):(
            <>
              {convos.filter(c=>c.mode===mode).length===0&&<div style={{fontSize:11.5,color:P.dim,textAlign:"center",padding:"20px 8px",lineHeight:1.6}}>No conversations yet.<br/>Start chatting to save one.</div>}
              {convos.filter(c=>c.mode===mode).map(c=>{
                const isActive=c.id===activeId;
                return(
                  <div key={c.id} onClick={()=>loadConversation(c.id)} title={c.title}
                    style={{display:"flex",alignItems:"center",gap:6,padding:"8px 9px",borderRadius:7,cursor:"pointer",marginBottom:2,background:isActive?P.surface:"transparent",border:`1px solid ${isActive?P.border:"transparent"}`}}
                    onMouseEnter={e=>{if(!isActive)e.currentTarget.style.background=P.surface;}}
                    onMouseLeave={e=>{if(!isActive)e.currentTarget.style.background="transparent";}}>
                    <Ic as={c.mode==="socratic"?Chat:MagicWand} size={13} color={isActive?P.txt:P.dim}/>
                    <span style={{flex:1,minWidth:0,fontSize:12.5,color:isActive?P.txt:P.muted,fontWeight:isActive?600:400,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{c.title||"New chat"}</span>
                    <button onClick={e=>{e.stopPropagation();if(window.confirm("Delete this conversation?"))deleteConvo(c.id);}} title="Delete"
                      style={{background:"transparent",border:"none",cursor:"pointer",color:P.dim,fontSize:14,lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    )}

    {/* ── Main chat column ──────────────────────────────────────────────────── */}
    <div style={{display:"flex",flexDirection:"column",height:"100%",flex:1,minWidth:0,background:P.bg}}>
    {/* Header bar */}
    <div style={{padding:"10px 20px",background:P.panel,borderBottom:`1px solid ${P.border}`,display:"flex",alignItems:"center",gap:12,flexShrink:0}}>
      {profile?.id&&<button onClick={()=>setSidebarOpen(o=>!o)} title={sidebarOpen?"Hide conversations":"Show conversations"}
        style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:7,padding:"5px 9px",cursor:"pointer",color:P.muted,flexShrink:0,fontSize:14,lineHeight:1}}>☰</button>}
      {/* Mode toggle */}
      <div style={{display:"flex",background:P.surface,borderRadius:9,border:`1px solid ${P.border}`,padding:2,gap:2,flexShrink:0}}>
        {[{id:"socratic",label:"💡 Guide me",tip:"Hints and guiding questions — you reason it out yourself"},{id:"reasoning",label:"🧠 Explain fully",tip:"A full, step-by-step answer from the Reasoning agent"}].map(m=>(
          <button key={m.id} onClick={()=>switchMode(m.id)} title={m.tip} style={{padding:"5px 14px",background:mode===m.id?P.panel:"transparent",color:mode===m.id?P.txt:P.muted,border:mode===m.id?`1px solid ${P.border}`:"1px solid transparent",borderRadius:7,fontSize:12.5,fontWeight:mode===m.id?600:400,cursor:"pointer",transition:"all .15s",boxShadow:mode===m.id?P.shadow:"none"}}>{m.label}</button>
        ))}
      </div>
      <div style={{flex:1}}/>
      {profile?.id&&curMsgs.length>1&&<button onClick={newChat} style={{fontSize:11,color:P.muted,background:"transparent",border:`1px solid ${P.border}`,borderRadius:6,padding:"3px 9px",cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:5}}>
        <Ic as={Edit} size={12} color={P.muted}/> New chat
      </button>}
    </div>

    {/* Messages */}
    <div ref={ref} style={{flex:1,overflowY:"auto",padding:"24px 20px",display:"flex",flexDirection:"column",gap:16,maxWidth:800,width:"100%",margin:"0 auto",alignSelf:"center",boxSizing:"border-box"}}>
      {curMsgs.map((m,i)=>{
        const k=`${mode[0]}-${i+1}`;
        const isUser=m.role==="user";
        return(
          <div key={i} style={{display:"flex",justifyContent:isUser?"flex-end":"flex-start",gap:10,alignItems:"flex-start"}}>
            {!isUser&&<AIchat UNSAFE_style={{width:30,height:30,flexShrink:0,marginTop:2}}/>}
            <div style={{maxWidth:"75%",textAlign:"left"}}>
              {m.imagePreview&&<img src={m.imagePreview} alt="upload" style={{maxWidth:180,borderRadius:10,marginBottom:6,display:"block"}}/>}
              {isUser&&editingIdx===i?(
                /* #6 inline editor for a user message */
                <div style={{display:"flex",flexDirection:"column",gap:6,minWidth:280}}>
                  <textarea value={editText} onChange={e=>setEditText(e.target.value)} autoFocus rows={Math.min(6,Math.max(2,editText.split("\n").length))}
                    onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();saveEdit(i);}if(e.key==="Escape")cancelEdit();}}
                    style={{width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:12,border:`1px solid ${P.border}`,background:P.panel,color:P.txt,fontSize:14,lineHeight:1.6,fontFamily:"inherit",resize:"vertical"}}/>
                  <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
                    <button onClick={cancelEdit} style={{fontSize:12,padding:"5px 12px",borderRadius:7,border:`1px solid ${P.border}`,background:"transparent",color:P.muted,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
                    <button onClick={()=>saveEdit(i)} disabled={!editText.trim()} style={{fontSize:12,padding:"5px 12px",borderRadius:7,border:"none",background:modeColor,color:"#fff",cursor:editText.trim()?"pointer":"not-allowed",opacity:editText.trim()?1:.5,fontFamily:"inherit",fontWeight:600}}>Save &amp; resend</button>
                  </div>
                </div>
              ):(
              <div style={{
                padding:"11px 16px",
                borderRadius:isUser?"14px 14px 4px 14px":"14px 14px 14px 4px",
                background:isUser?modeColor:P.panel,
                color:isUser?"#fff":P.txt,
                border:!isUser?`1px solid ${P.border}`:"none",
                fontSize:14,lineHeight:1.65,
                whiteSpace:"pre-line",
                textAlign:"left",
                boxShadow:isUser?"none":P.shadow,
              }}>{renderLiteMarkdown(typeof m.content==="string"?m.content:m.content.find?.(b=>b.type==="text")?.text||"")}</div>
              )}
              {/* #6 Edit affordance — only on the learner's own text turns, when idle and not already editing */}
              {isUser&&editingIdx!==i&&profile?.id&&!busy&&typeof m.content==="string"&&(
                <div style={{marginTop:4,display:"flex",justifyContent:"flex-end"}}>
                  <button type="button" onClick={()=>startEdit(i,m.content)} title="Edit & resend"
                    style={{fontSize:11,color:P.dim,background:"transparent",border:"none",cursor:"pointer",display:"inline-flex",alignItems:"center",gap:4,fontFamily:"inherit",padding:"2px 4px"}}
                    onMouseEnter={e=>e.currentTarget.style.color=P.muted}
                    onMouseLeave={e=>e.currentTarget.style.color=P.dim}>
                    <Ic as={Edit} size={11} color="currentColor"/> Edit
                  </button>
                </div>
              )}
              {!isUser&&(()=>{
                const rMode=mode==="reasoning"&&k.startsWith("r-");
                const meta=rMode?reasoningMeta[k]:null;
                // Off-topic answers are a hardcoded redirect (no LLM call at all) —
                // regenerating would always produce the identical text, so hide it.
                const canRegenerate=rMode&&i>0&&i===curMsgs.length-1&&!busy&&meta?.intent!=="off_topic";
                const hasFeedback=!!m.dbId;
                return(
                  <div style={{marginTop:5,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                    {mode==="socratic"&&<><JudgeBadge k={k}/><DocBadges k={k}/></>}
                    {rMode&&<><IntentChip k={k}/><DegradedChip k={k}/><ToolCallBadges k={k}/></>}
                    {(hasFeedback||canRegenerate)&&<span style={{width:1,alignSelf:"stretch",background:P.border,margin:"0 1px"}}/>}
                    {hasFeedback&&<>
                      <button type="button" onClick={()=>sendFeedback(m,"up")} title="Helpful"
                        style={{width:26,height:26,display:"inline-flex",alignItems:"center",justifyContent:"center",
                          background:m.metadata?.feedback==="up"?P.grnBg:P.surface,
                          border:`1px solid ${m.metadata?.feedback==="up"?P.grn:P.border}`,
                          borderRadius:7,cursor:"pointer",fontSize:12,lineHeight:1,padding:0,transition:"all .12s"}}
                        onMouseEnter={e=>{if(m.metadata?.feedback!=="up")e.currentTarget.style.borderColor=P.txt;}}
                        onMouseLeave={e=>{if(m.metadata?.feedback!=="up")e.currentTarget.style.borderColor=P.border;}}>👍</button>
                      <button type="button" onClick={()=>sendFeedback(m,"down")} title="Not helpful"
                        style={{width:26,height:26,display:"inline-flex",alignItems:"center",justifyContent:"center",
                          background:m.metadata?.feedback==="down"?P.redBg:P.surface,
                          border:`1px solid ${m.metadata?.feedback==="down"?P.red:P.border}`,
                          borderRadius:7,cursor:"pointer",fontSize:12,lineHeight:1,padding:0,transition:"all .12s"}}
                        onMouseEnter={e=>{if(m.metadata?.feedback!=="down")e.currentTarget.style.borderColor=P.txt;}}
                        onMouseLeave={e=>{if(m.metadata?.feedback!=="down")e.currentTarget.style.borderColor=P.border;}}>👎</button>
                    </>}
                    {canRegenerate&&
                      <button type="button" onClick={regenerate} title="Regenerate this answer"
                        style={{height:26,background:P.surface,border:`1px solid ${P.border}`,borderRadius:7,padding:"0 9px",
                          cursor:"pointer",fontSize:11,fontWeight:500,color:P.muted,display:"inline-flex",alignItems:"center",gap:4,
                          fontFamily:"inherit",transition:"all .12s"}}
                        onMouseEnter={e=>{e.currentTarget.style.borderColor=P.txt;e.currentTarget.style.color=P.txt;}}
                        onMouseLeave={e=>{e.currentTarget.style.borderColor=P.border;e.currentTarget.style.color=P.muted;}}>
                        <Ic as={Refresh} size={10} color={P.muted}/> Regenerate
                      </button>}
                  </div>
                );
              })()}
            </div>
            {isUser&&<div style={{flexShrink:0,marginTop:2}}><UserAvatarCircle emoji={profile?.avatar_emoji} color={profile?.avatar_color||profile?.color} persona={profile?.persona} alt={profile?.name||"You"} size={28}/></div>}
          </div>
        );
      })}
      {(busy||retrieving)&&<div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
        <AIchat UNSAFE_style={{width:30,height:30,flexShrink:0,marginTop:2}}/>
        <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:"14px 14px 14px 4px",padding:"11px 16px",fontSize:14,color:P.muted,boxShadow:P.shadow}}>
          {retrieving?<span style={{color:modeColor,fontSize:13}}>Searching AdobeDocs…</span>:<span style={{letterSpacing:4}}>···</span>}
        </div>
      </div>}
      {summary&&<div style={{background:P.grnBg,border:`1px solid ${P.grn}20`,borderRadius:12,padding:"14px 16px",position:"relative"}}>
        <div style={{fontSize:12,fontWeight:600,color:P.grn,marginBottom:8,letterSpacing:.3,textTransform:"uppercase"}}>Session Summary</div>
        <div style={{fontSize:13.5,color:P.txt,lineHeight:1.75,whiteSpace:"pre-line"}}>{summary}</div>
        <button onClick={()=>setSummary(null)} style={{position:"absolute",top:10,right:12,background:"transparent",border:"none",fontSize:18,cursor:"pointer",color:P.dim,lineHeight:1}}>×</button>
      </div>}
    </div>

    {/* Image preview */}
    {imageFile&&<div style={{padding:"8px 20px",background:modeBg,borderTop:`1px solid ${P.border}`,display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
      <img src={`data:${imageMime};base64,${imageB64}`} alt="preview" style={{height:36,borderRadius:6,objectFit:"cover"}}/>
      <span style={{fontSize:12.5,color:modeColor,flex:1}}>{imageFile.name}</span>
      <button onClick={clearImage} style={{background:"transparent",border:"none",cursor:"pointer",color:P.dim,fontSize:18,lineHeight:1}}>×</button>
    </div>}

    {/* Sign-in required banner — Reasoning mode needs a real Adobe session for
        identity, rate limiting, and persistence; the demo persona picker has none. */}
    {needsRealLogin&&<div style={{padding:"10px 20px",background:P.grnBg||P.surface,borderTop:`1px solid ${P.border}`,flexShrink:0,display:"flex",alignItems:"center",gap:8,fontSize:12.5,color:P.muted}}>
      <Ic as={Lock} size={13} color={P.muted}/> Sign in with your Adobe account for <strong style={{fontWeight:600,margin:"0 3px"}}>Explain fully</strong> mode. Demo profiles can still use <strong style={{fontWeight:600,margin:"0 3px"}}>Guide me</strong>.
    </div>}

    {/* Input bar */}
    <div style={{borderTop:`1px solid ${P.border}`,padding:"12px 20px",display:"flex",gap:8,flexShrink:0,alignItems:"center",background:P.panel}}>
      <input ref={fileRef} type="file" accept="image/*" onChange={pickImage} style={{display:"none"}}/>
      <button onClick={()=>fileRef.current?.click()} title="Attach image" disabled={needsRealLogin} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:9,padding:"9px 11px",fontSize:15,cursor:needsRealLogin?"not-allowed":"pointer",color:P.muted,flexShrink:0,transition:"border-color .15s",opacity:needsRealLogin?.5:1}}
        onMouseEnter={e=>e.currentTarget.style.borderColor=P.txt}
        onMouseLeave={e=>e.currentTarget.style.borderColor=P.border}>↑</button>
      <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&send()}
        disabled={needsRealLogin}
        placeholder={needsRealLogin?"Sign in with Adobe for Explain fully mode…":mode==="socratic"?"Ask anything — I'll guide you with questions…":"Ask anything — I'll explain it fully…"}
        style={{flex:1,border:`1px solid ${P.border}`,borderRadius:10,padding:"10px 16px",fontSize:14,outline:"none",background:needsRealLogin?P.panel:P.surface,color:P.txt,transition:"border-color .15s"}}/>
      {curMsgs.length>=5&&<button onClick={generateSummary} disabled={summaryLoading} title="Summarise session" style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:9,padding:"9px 11px",fontSize:13,cursor:"pointer",color:summaryLoading?P.dim:P.grn,flexShrink:0}}>
        {summaryLoading?"…":"◈"}
      </button>}
      {busy&&mode==="reasoning"
        ?<Btn onClick={stopStreaming} size="md" style={{background:"transparent",color:P.txt,border:`1px solid ${P.border}`,flexShrink:0,display:"inline-flex",alignItems:"center",gap:6}}><span style={{fontSize:13}}>■</span> Stop</Btn>
        :<Btn onClick={send} disabled={busy||needsRealLogin} size="md" style={{background:modeColor,color:"#fff",border:"none",flexShrink:0}}>Send</Btn>}
    </div>
    </div>{/* /main chat column */}
    {/* Suggested questions — right rail, matching the Curriculum Agent. Mode-aware
        (Socratic vs Reasoning), shown at the start of a conversation, auto-sends. */}
    {!needsRealLogin&&curMsgs.filter(m=>m.role==="user").length===0&&(
      <div style={{width:230,flexShrink:0,borderLeft:`1px solid ${P.border}`,overflowY:"auto",padding:"14px",background:P.panel}}>
        <div style={{fontSize:11,fontWeight:600,color:P.dim,marginBottom:10}}>SUGGESTED QUESTIONS</div>
        {(mode==="socratic"
          ?["Why would you choose streaming over batch segmentation?",
            "What breaks if a merge policy is misconfigured?",
            "How does identity stitching change my profile view?",
            "When would edge segmentation be the wrong choice?",
            "Why does schema design affect Profile behaviour?"]
          :["Explain the difference between RT-CDP and a DMP",
            "How does streaming segmentation work in AEP?",
            "What is a union schema and why does it matter?",
            "Walk me through identity stitching in AEP",
            "How do merge policies decide the winning value?"]
        ).map((q,i)=>(
          <button key={i} onClick={()=>send(q)} disabled={busy}
            style={{display:"block",width:"100%",textAlign:"left",padding:"8px 10px",background:P.surface,border:"none",borderRadius:7,cursor:busy?"default":"pointer",fontSize:12,color:P.muted,marginBottom:6,fontFamily:"inherit",lineHeight:1.4,opacity:busy?.6:1}}>
            {q}
          </button>
        ))}
      </div>
    )}
  </div>);
}

// ── Study Materials · mindmap + summary doc generator ────────────────────────
const TRACK_LABELS_FOR_STUDY_MATERIALS={"rtcdp":"Real-Time CDP","analytics":"Adobe Analytics","ajo":"Adobe Journey Optimizer","cja":"Customer Journey Analytics"};

// Parses "6 min" / "12 minutes" style strings from curriculum_topics.video_duration
// into a number; ignores anything unparseable rather than throwing.
const _parseMinutes=s=>{
  const m=String(s||"").match(/(\d+(?:\.\d+)?)/);
  return m?parseFloat(m[1]):0;
};

async function generateStudyMaterials(moduleName, groqKey, {moduleId=null, track="rtcdp"}={}){
  const trackLabel=TRACK_LABELS_FOR_STUDY_MATERIALS[track]||"AEP";
  let topicsBlock="", topicCount=0, totalMinutes=0;
  if(moduleId){
    try{
      const r=await fetch(`${BACKEND}/api/curriculum/${moduleId}?track=${encodeURIComponent(track)}`);
      const d=await r.json();
      const rows=d.topics||[];
      topicCount=rows.length;
      totalMinutes=rows.reduce((s,t)=>s+_parseMinutes(t.video_duration),0);
      const topics=rows.map(t=>`${t.topic_order}. ${t.title} — ${t.objective||""}`);
      if(topics.length)topicsBlock=`\nThis module's actual topics — ground the mindmap and summary in these:\n${topics.join("\n")}\n`;
    }catch{}
  }

  // Depth scales with what's actually in the module — not a fixed "3 sentences,
  // 4-5 concepts" regardless of whether the module has 2 topics and no video or
  // 9 topics and 40 minutes of video. topicCount=0 (no curriculum data reachable)
  // falls back to the original MEDIUM defaults, matching prior behavior exactly.
  const tier = topicCount===0 ? "MEDIUM"
             : (topicCount<=2 && totalMinutes<10) ? "SHORT"
             : (topicCount>=6 || totalMinutes>=25) ? "LONG"
             : "MEDIUM";
  const depthSpec = {
    SHORT:  {sentences:"2", concepts:Math.max(topicCount,2), children:"1-2", takeaways:2, mistakes:1,
             note:"This is a short, light module — keep the summary brief, don't pad it with filler."},
    MEDIUM: {sentences:"3", concepts:Math.max(topicCount||4,3), children:"2-3", takeaways:3, mistakes:2,
             note:""},
    LONG:   {sentences:"5-6", concepts:Math.min(topicCount||6,9), children:"3-4", takeaways:5, mistakes:3,
             note:`This module has ${topicCount} topics${totalMinutes?` and ~${Math.round(totalMinutes)} minutes of video`:""} — go deeper: cover more ground, don't compress a substantial module into a shallow 3-sentence summary.`},
  }[tier];

  const sys=`You generate structured study materials for ${trackLabel} learning modules.
${topicsBlock?topicsBlock:"No curriculum topic list is available for this module — write from general "+trackLabel+" product knowledge instead.\n"}
${depthSpec.note?depthSpec.note+"\n":""}
Return ONLY valid JSON, no markdown, no explanation:
{
  "title": "module name",
  "summary": "${depthSpec.sentences} sentence overview of the module",
  "concepts": [
    { "name": "Main Concept", "color": "#1473E6", "children": ["sub1","sub2"] }
  ],
  "keyTakeaways": ["takeaway 1", "..."],
  "commonMistakes": ["mistake 1", "..."],
  "relatedModules": ["module 1","module 2"]
}
Generate exactly ${depthSpec.concepts} main concepts (one per real topic above when topics are given — do not invent extra ones or omit real ones) with ${depthSpec.children} children each, specific to ${trackLabel} — no generic AEP filler when real topics are given above.
Generate exactly ${depthSpec.takeaways} keyTakeaways and ${depthSpec.mistakes} commonMistakes.
Omit the "color" field entirely — the UI assigns concept colors itself from a fixed professional palette.`;
  try{
    const r=await callAgent([{role:"user",content:`Generate study materials for: ${moduleName} (${trackLabel})`}],sys,groqKey,{agentName:"StudyMaterials",logFn:null,maxTokens:tier==="LONG"?1500:900});
    return JSON.parse(r.replace(/```json|```/g,"").trim());
  }catch{
    // Generic placeholder — only reached when the AI call/parse fails (network
    // error, backend down, rate limit). Tagged with usedFallback so the caller
    // can show a "couldn't generate — try again" affordance instead of silently
    // presenting this as real, module-specific content.
    return{title:moduleName,summary:`${moduleName} covers the core concepts and practical application within Adobe Experience Platform.`,
      usedFallback:true,
      concepts:[
        {name:"Core Concepts",color:"#1473E6",children:["Fundamentals","Key Principles","Best Practices"]},
        {name:"Implementation",color:"#2D9D78",children:["Setup","Configuration","Validation"]},
        {name:"Use Cases",color:"#6B4EFF",children:["Common Scenarios","Edge Cases","Optimisation"]},
        {name:"Troubleshooting",color:"#E68619",children:["Common Errors","Debugging","Resolution"]},
      ],
      keyTakeaways:["Understand the core model before implementation","Test in a dev sandbox first","Document configuration decisions"],
      commonMistakes:["Skipping schema validation","Ignoring evaluation mode latency differences"],
      relatedModules:["Next module in track","Advanced AEP Architecture"]};
  }
}

const MINDMAP_PALETTE=["#1473E6","#0D7377","#2D9D78","#6B3FA0","#B24E00","#AB1F42","#3E5C76","#946200","#4B5C6B"];

// Wraps text to a target pixel width and returns the actual line array — the
// CALLER sizes its box from lines.length instead of assuming a fixed height,
// which is what let long labels spill outside their box before.
const _wrapLines=(text="",px=60,maxLines=3)=>{
  const words=String(text).split(" ");
  const lines=[]; let cur="";
  words.forEach(w=>{
    const test=cur?cur+" "+w:w;
    if(test.length>Math.floor(px/6.2)){lines.push(cur);cur=w;}
    else cur=test;
  });
  if(cur)lines.push(cur);
  return lines.filter(Boolean).slice(0,maxLines);
};

function MindmapSVG({data,svgId="nexus-mindmap-inline"}){
  if(!data?.concepts)return null;
  const concepts=data.concepts;
  const n=concepts.length;

  // ── Layout: d3-hierarchy's radial tree, not hand-rolled angle formulas ──────
  // Every previous attempt (fixed fan angle, then a vertical-list workaround)
  // was a formula GUESSING how much angular room a branch needs. d3's tree()
  // layout computes this properly: it divides the full circle among LEAF nodes
  // (not top-level concepts), so a concept with 8 children automatically gets
  // ~8x the angular slice of a concept with 1 child — the exact allocation
  // rule real mind-map/org-chart tools use, derived from actual subtree size
  // instead of a constant we have to keep re-tuning by hand.
  const treeData=useMemo(()=>({
    name:data.title||"Topic",
    children:concepts.map((c,i)=>({
      name:c.name, colorIdx:i,
      children:(c.children&&c.children.length?c.children:["—"]).map(ch=>({name:ch})),
    })),
  }),[data]);
  const root=useMemo(()=>d3Hierarchy(treeData),[treeData]);
  const totalLeaves=root.leaves().length;

  // Ring radii are DERIVED from how many leaves must fit around the circle at
  // that ring, not guessed: R2 (leaf ring) is set so the arc-length available
  // per leaf (2π·R2/totalLeaves) clears the real box width (76px) with margin.
  // minArcPerLeaf=100 and the 1.3 cross-branch separation weight below were
  // tuned against d3's actual output (not assumed) — the separation() function
  // gives extra room at branch BOUNDARIES, which slightly compresses the
  // tightest within-branch gap below the naive 2π/totalLeaves average, so the
  // target has to clear the box width with margin, not just equal it. Verified
  // against a 27-leaf worst-case layout: 92.8px minimum gap vs a 76px box.
  const minArcPerLeaf=118;
  const R2=Math.max(190,Math.round(totalLeaves*minArcPerLeaf/(2*Math.PI)));
  const R1=Math.max(110,Math.round(R2*0.46));

  const layoutRoot=useMemo(()=>{
    const layout=d3Tree().size([2*Math.PI,1])
      .separation((a,b)=>(a.parent===b.parent?1:1.3)/a.depth);
    const r=root.copy();
    layout(r);
    return r;
  },[root]);

  const nodes=layoutRoot.descendants();
  const radiusByDepth=[0,R1,R2];
  const posOf=node=>{
    const angle=node.x-Math.PI/2;
    const radius=radiusByDepth[node.depth]??R2;
    return {angle,radius,px:radius*Math.cos(angle),py:radius*Math.sin(angle)};
  };

  const boxHalf=44;
  const width=Math.max(480,Math.round(2*(R2+boxHalf+40)));
  const height=Math.max(360,Math.round(2*(R2+boxHalf+40)));
  const cx=width/2, cy=height/2;

  // Connectors now attach at node BOUNDARIES, not centres. We shorten each line
  // by an approximate node half-extent at both ends (startR at the parent, endR at
  // the child) along the parent→child direction. This is what stops the dashed
  // leaf lines from running under the semi-transparent child boxes and appearing
  // to cross the text — the visual "connectors inside text nodes" bug.
  const trimmedCurve=(x1,y1,x2,y2,startR,endR)=>{
    const dx=x2-x1, dy=y2-y1, L=Math.hypot(dx,dy)||1;
    const ux=dx/L, uy=dy/L;
    const sx=x1+ux*startR, sy=y1+uy*startR;
    const ex=x2-ux*endR,   ey=y2-uy*endR;
    const mx=(sx+ex)/2, my=(sy+ey)/2;
    return `M${sx},${sy} Q${mx},${my} ${ex},${ey}`;
  };

  return(
    <svg id={svgId} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{background:"#FAFAFA",borderRadius:12,border:"1px solid #E3E3E3",display:"block",maxWidth:"none"}}>
      <defs>
        <filter id="mm-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000" floodOpacity="0.10"/>
        </filter>
        {MINDMAP_PALETTE.map((color,i)=>(
          <marker key={i} id={`mm-arrow-${i}`} viewBox="0 0 10 10" refX="8" refY="5"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={color}/>
          </marker>
        ))}
      </defs>

      {nodes.filter(nd=>nd.depth>0).map((node,idx)=>{
        const{px,py}=posOf(node);
        const x=cx+px, y=cy+py;
        const parentPos=posOf(node.parent);
        const px2=cx+parentPos.px, py2=cy+parentPos.py;
        const conceptIdx=node.depth===1?node.data.colorIdx:node.parent.data.colorIdx;
        const color=MINDMAP_PALETTE[conceptIdx%MINDMAP_PALETTE.length];
        const isConcept=node.depth===1;
        const boxW=isConcept?100:76;
        const lines=_wrapLines(node.data.name,isConcept?86:66);
        const lineH=isConcept?13:11;
        const boxH=Math.max(isConcept?30:24,lines.length*lineH+14);

        // half-extent to trim the connector at each end so it meets the boundary
        const parentIsCentre=node.depth===1;
        const startR=parentIsCentre?52:44;      // centre node / concept ellipse
        const endR=isConcept?Math.max(boxW,boxH)/2:Math.min(boxW,boxH)/2+2;
        return(
          <g key={idx}>
            <path d={trimmedCurve(px2,py2,x,y,startR,endR)} fill="none" stroke={color}
              strokeWidth={isConcept?3:2} strokeLinecap="round"
              strokeDasharray={isConcept?undefined:"4 3"} opacity={isConcept?0.85:0.7}
              markerEnd={`url(#mm-arrow-${conceptIdx%MINDMAP_PALETTE.length})`}/>
            <g filter="url(#mm-shadow)">
              {isConcept
                ?<ellipse cx={x} cy={y} rx={boxW/2} ry={boxH/2} fill={color}/>
                :<rect x={x-boxW/2} y={y-boxH/2} width={boxW} height={boxH} rx={6} fill={color+"18"} stroke={color} strokeWidth={1.2}/>}
              {lines.map((l,li)=>(
                <text key={li} x={x} y={y+(li-(lines.length-1)/2)*lineH} textAnchor="middle"
                  fill={isConcept?"#fff":color} fontSize={isConcept?9.5:8.5} fontWeight={isConcept?700:600}
                  fontFamily="system-ui,-apple-system,sans-serif">{l}</text>
              ))}
            </g>
          </g>
        );
      })}

      {/* Centre node */}
      {(()=>{
        const lines=_wrapLines(data.title||"Topic",100);
        return(
          <g filter="url(#mm-shadow)">
            <ellipse cx={cx} cy={cy} rx={58} ry={Math.max(32,lines.length*13+10)} fill="#1C1C2E"/>
            {lines.map((l,li)=>(
              <text key={li} x={cx} y={cy+(li-(lines.length-1)/2)*13} textAnchor="middle"
                fill="#fff" fontSize={10} fontWeight={800} fontFamily="system-ui,-apple-system,sans-serif">{l}</text>
            ))}
          </g>
        );
      })()}
    </svg>
  );
}

// ── Mindmap viewer — full-width, zoom / pan / fit / fullscreen + multi-format
// export. Wraps MindmapSVG (which renders an intrinsically-sized SVG) in a large
// scrollable canvas the learner can zoom and pan, plus a fullscreen presentation
// overlay. Fixes the old "rendered inside a small box, nodes cut off, needs
// scrolling" complaint and adds PNG / JPG / SVG export at presentation quality.
function MindmapViewer({data,moduleTitle}){
  const svgId="nexus-mindmap-inline";
  const [zoom,setZoom]=useState(1);
  const [pan,setPan]=useState({x:0,y:0});
  const [fs,setFs]=useState(false);
  const [menuOpen,setMenuOpen]=useState(false);
  const stageRef=useRef(null);
  const drag=useRef(null);

  // Fit the whole map into the visible stage — the default so nothing is cut off.
  const fit=useCallback(()=>{
    const stage=stageRef.current;
    const svg=document.getElementById(svgId);
    if(!stage||!svg)return;
    const vb=svg.viewBox?.baseVal;
    const sw=(vb&&vb.width)||svg.width?.baseVal?.value||800;
    const sh=(vb&&vb.height)||svg.height?.baseVal?.value||600;
    const pad=32;
    const scale=Math.min((stage.clientWidth-pad)/sw,(stage.clientHeight-pad)/sh);
    const z=Math.max(0.2,Math.min(2.5,scale||1));
    setZoom(z);
    setPan({x:(stage.clientWidth-sw*z)/2,y:(stage.clientHeight-sh*z)/2});
  },[]);

  // Fit on mount, when data changes, and when entering/leaving fullscreen.
  useEffect(()=>{const t=setTimeout(fit,60);return()=>clearTimeout(t);},[data,fs,fit]);

  const zoomBy=(f)=>setZoom(z=>Math.max(0.2,Math.min(4,z*f)));
  // Non-passive wheel listener so preventDefault() actually stops page scroll while
  // zooming (React's synthetic onWheel is passive and would only warn).
  useEffect(()=>{
    const stage=stageRef.current;
    if(!stage)return;
    const handler=(e)=>{e.preventDefault();zoomBy(e.deltaY<0?1.12:0.89);};
    stage.addEventListener("wheel",handler,{passive:false});
    return()=>stage.removeEventListener("wheel",handler);
  },[]);
  const onDown=(e)=>{drag.current={x:e.clientX,y:e.clientY,px:pan.x,py:pan.y};};
  const onMove=(e)=>{if(!drag.current)return;setPan({x:drag.current.px+(e.clientX-drag.current.x),y:drag.current.py+(e.clientY-drag.current.y)});};
  const onUp=()=>{drag.current=null;};

  // Export — SVG (vector) or rasterised PNG/JPG at 3× for crisp docs/slides.
  const download=(blob,ext)=>{
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob);
    a.download=`${(moduleTitle||"mindmap").replace(/\s+/g,"-")}-mindmap.${ext}`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  };
  const exportAs=(fmt)=>{
    setMenuOpen(false);
    const svg=document.getElementById(svgId);
    if(!svg)return;
    if(fmt==="svg"){
      download(new Blob([svg.outerHTML],{type:"image/svg+xml;charset=utf-8"}),"svg");
      return;
    }
    const vb=svg.viewBox?.baseVal;
    const w=(vb&&vb.width)||svg.width?.baseVal?.value||800;
    const h=(vb&&vb.height)||svg.height?.baseVal?.value||600;
    const scale=3; // high-resolution raster
    const xml=new XMLSerializer().serializeToString(svg);
    const img=new Image();
    img.onload=()=>{
      const canvas=document.createElement("canvas");
      canvas.width=Math.round(w*scale); canvas.height=Math.round(h*scale);
      const ctx=canvas.getContext("2d");
      ctx.fillStyle="#FFFFFF"; ctx.fillRect(0,0,canvas.width,canvas.height); // JPG has no alpha
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      canvas.toBlob(b=>{if(b)download(b,fmt==="jpg"?"jpg":"png");},fmt==="jpg"?"image/jpeg":"image/png",0.95);
    };
    img.onerror=()=>{ // fallback to SVG download if raster pipeline is blocked
      download(new Blob([svg.outerHTML],{type:"image/svg+xml;charset=utf-8"}),"svg");
    };
    img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(xml);
  };

  const ctrlBtn={display:"inline-flex",alignItems:"center",justifyContent:"center",gap:5,minWidth:34,height:32,padding:"0 10px",background:P.panel,border:`1px solid ${P.border}`,borderRadius:8,color:P.txt,fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"};

  const toolbar=(
    <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
      <button style={ctrlBtn} onClick={()=>zoomBy(1.2)} title="Zoom in">＋</button>
      <button style={ctrlBtn} onClick={()=>zoomBy(0.83)} title="Zoom out">－</button>
      <button style={ctrlBtn} onClick={fit} title="Fit to screen">Fit</button>
      <span style={{fontSize:12,color:P.muted,minWidth:44,textAlign:"center"}}>{Math.round(zoom*100)}%</span>
      <button style={ctrlBtn} onClick={()=>setFs(f=>!f)} title={fs?"Exit fullscreen":"Fullscreen / presentation"}>{fs?"✕ Exit":"⛶ Fullscreen"}</button>
      <div style={{position:"relative"}}>
        <button style={{...ctrlBtn,background:P.blue,color:"#fff",border:"none"}} onClick={()=>setMenuOpen(o=>!o)} title="Download">
          <Ic as={Download} size={14} color="#fff"/> Export ▾
        </button>
        {menuOpen&&(
          <div style={{position:"absolute",top:"110%",right:0,zIndex:5,background:P.panel,border:`1px solid ${P.border}`,borderRadius:9,boxShadow:"0 8px 24px rgba(0,0,0,.16)",overflow:"hidden",minWidth:150}}>
            {[{f:"png",l:"PNG · high-res"},{f:"jpg",l:"JPG · high-res"},{f:"svg",l:"SVG · vector"}].map(o=>(
              <button key={o.f} onClick={()=>exportAs(o.f)}
                style={{display:"block",width:"100%",textAlign:"left",padding:"9px 14px",background:"transparent",border:"none",borderBottom:`1px solid ${P.bfaint}`,color:P.txt,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{o.l}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const stage=(
    <div ref={stageRef}
      onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
      style={{position:"relative",width:"100%",height:fs?"calc(100vh - 66px)":"min(70vh,640px)",
        background:"#F4F4F6",border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden",
        cursor:drag.current?"grabbing":"grab"}}>
      <div style={{position:"absolute",left:0,top:0,transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`,transformOrigin:"0 0"}}>
        <MindmapSVG data={data} svgId={svgId}/>
      </div>
      <div style={{position:"absolute",left:12,bottom:10,fontSize:11,color:P.dim,background:"rgba(255,255,255,.72)",borderRadius:6,padding:"2px 8px",pointerEvents:"none"}}>
        Scroll to zoom · drag to pan
      </div>
    </div>
  );

  if(fs){
    return(
      <div style={{position:"fixed",inset:0,zIndex:1000,background:P.bg,display:"flex",flexDirection:"column",padding:"12px 16px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,gap:12,flexWrap:"wrap"}}>
          <div style={{fontSize:15,fontWeight:700,color:P.txt}}>{moduleTitle} · Mind map</div>
          {toolbar}
        </div>
        {stage}
      </div>
    );
  }

  return(
    <div>
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:10}}>{toolbar}</div>
      {stage}
    </div>
  );
}

function StudyMaterialsModal({module, moduleId=null, track="rtcdp", groqKey, onClose}){
  // Full-page study view (a dedicated screen, not a modal popup) — mirrors the
  // Read-Lesson page: opaque full-viewport background + a Back app bar.
  // Content is StudyToolsTab (Flashcards + Mindmap) — the same real, DB-grounded
  // generator used in the lesson view, so "Study cards" from the module list and
  // from the lesson view are backed by the exact same data. No Summary Doc tab.
  return(
    <div style={{position:"fixed",inset:0,background:P.bg,zIndex:1000,display:"flex",flexDirection:"column",fontFamily:"'adobe-clean','Source Sans 3',system-ui,sans-serif"}}>
      <div style={{background:P.panel,width:"100%",height:"100%",display:"flex",flexDirection:"column",flex:1,minHeight:0}}>
        {/* Top app bar */}
        <div style={{padding:"12px 24px",borderBottom:`1px solid ${P.border}`,display:"flex",alignItems:"center",gap:16,flexShrink:0}}>
          <button onClick={onClose} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"7px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer",color:P.txt,fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:6,flexShrink:0}}>
            <Ic as={ChevronLeft} size={14} color="currentColor"/> Back to modules
          </button>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:11,fontWeight:600,color:P.blue,letterSpacing:.5,textTransform:"uppercase",marginBottom:2}}>Study Materials</div>
            <div style={{fontSize:16,fontWeight:600,color:P.txt,letterSpacing:-.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{module}</div>
          </div>
        </div>
        {/* Flashcards + Mindmap */}
        <div style={{flex:1,overflow:"hidden"}}>
          <StudyToolsTab moduleTitle={module} moduleId={moduleId} track={track} groqKey={groqKey}/>
        </div>
      </div>
    </div>
  );
}

// ── Auto-bandwidth calculation for EXP ────────────────────────────────────────
const PROJ_HRS={"In Progress":12,"Planning":5,"Blocked":2,"Done":0};
const calcBW=(memberName,memberProjects,projectIssues)=>{
  const TOTAL=40;
  const codes=memberProjects[memberName]||[];
  const breakdown=codes.map(code=>{
    const proj=ALL_PROJECTS.find(p=>p.code===code);
    const open=(projectIssues[code]||[]).filter(i=>i.status!=="Done").length;
    const base=PROJ_HRS[proj?.status]??5;
    const hrs=Math.round(Math.min(base+open*1.5,18));
    return{code,title:proj?.title||code,status:proj?.status||"Active",hrs};
  });
  const used=breakdown.reduce((s,b)=>s+b.hrs,0);
  const avail=Math.max(0,TOTAL-used);
  return{total:TOTAL,used:Math.min(used,TOTAL),avail,pct:Math.round(avail/TOTAL*100),breakdown};
};
// ── Full curriculum content — sourced from internal enablement document ────────
// Each module maps to an array of sub-topics with: title, objective, activity, output, checkpoint, video
const LESSON_CONTENT={
  1:[
    {t:"Introduction to Platform (CX Story)",obj:"Understand how AEP powers an end-to-end customer experience",act:"Log in to AEP and briefly explore the main navigation and key workspaces",out:"Short bullet list of 2–3 org-relevant AEP use cases",chk:"Can describe, in plain language, how AEP fits into one real business scenario",vid:"A customer experience powered by Experience Platform",dur:"3 min"},
    {t:"Technical Introduction to AEP",obj:"Understand AEP core services: schemas, datasets, Profile, Identity, Segmentation, Destinations",act:"Click through Schemas, Datasets, Profiles, Identities, Segments, and Destinations panels in AEP UI",out:"Simple mapping table: service → purpose → example use case",chk:"Can correctly explain in 1–2 sentences what each core service does and why it matters"},
    {t:"AEP Architecture Overview",obj:"Understand high-level AEP architecture: data flow from sources → data lake → Profile → activation",act:"Sketch a simple data flow diagram for one expected RTCDP/AJO use case; annotate with AEP service at each step",out:"Architecture sketch (Miro, PPT, or photo) with service labels",chk:"Reviewer confirms each step (ingest, store, assemble, segment, activate) maps to the right AEP service",vid:"Adobe Experience Platform architecture overview",dur:"9 min"},
    {t:"Authenticate & Access AEP APIs",obj:"Learn how to authenticate and call AEP APIs using credentials and sandbox context",act:"Open Adobe Developer Console, locate the AEP project, review API credentials and scopes; perform one simple GET call (list sandboxes or schemas) using Postman",out:"Working API call example + notes on headers and sandbox used",chk:"Can successfully call an AEP API endpoint and explain required headers (auth, org, API key, sandbox)"},
    {t:"Introduction to Sandboxes in AEP",obj:"Understand sandbox concepts and how to use multiple sandboxes safely for projects",act:"Open Sandboxes view, list available sandboxes (prod, stage, dev, PoC), identify which to use for training",out:"Short sandbox usage guideline: 1–2 bullets per sandbox type",chk:"Can correctly state where to experiment vs. where not to touch (production safety understood)"},
    {t:"Introduction to Real-Time CDP",obj:"Explain what Adobe Real-Time CDP is, how it differs from a DMP and CRM, and why it is built on AEP",act:"Read RTCDP intro documentation; answer checkpoint questions without slides",out:"Personal notes on RTCDP differentiation from DMP and CRM",chk:"Can answer: What is Real-Time CDP? How does it differ from Audience Manager and a CRM? Why is it built on AEP (data lake, XDM, Identity, Profile, Segmentation, Destinations)?"},
    {t:"Experience Platform: Data Sources",obj:"Explain what a data source is in Adobe Experience Platform",act:"Explore the Sources catalog in AEP UI and locate key source connectors",out:"Notes on source connector types and ingestion methods",chk:"Can define 'data source' and 'source connector'; distinguish ingestion types; locate and read the Sources catalog"},
    {t:"Experience Platform: Governance",obj:"Explain the purpose of data governance in AEP and recognize how it is applied end-to-end",act:"Review governance labels, policies, and marketing action restrictions in AEP UI",out:"Summary of at least 2 label types and one policy with its marketing action restriction",chk:"Can explain what governance is and why it matters; describe labels; explain how policies use labels to restrict marketing actions; describe what happens when a policy is violated during activation"},
    {t:"Real-Time Customer Profiles",obj:"Explain what a Real-Time Customer Profile is and how identities are stitched together",act:"Navigate to Profiles → Browse, open an example profile, review unified timeline, attributes, identities, and related datasets",out:"Unified profile view familiarity",chk:"Can explain what a Real-Time Customer Profile is; identify key sections of the profile view; describe how data sources contribute",vid:"Understanding Real Time Customer Profile",dur:"6 min"},
    {t:"Segmentation for Technical Consultants",obj:"Understand how segmentation sits between Real-Time Customer Profile and activation; differentiate segmentation modes",act:"Open Segment Builder and explore evaluation types",out:"Notes on batch vs streaming segmentation with relevant examples",chk:"Can define a segment correctly; distinguish batch vs streaming with examples; translate a use case into a segment rule (profile + events + time logic)"},
    {t:"Query Service Introduction",obj:"Understand how to use Query Service to validate and explore ingested data",act:"Run a basic SQL query in Query Service UI against an ingested dataset",out:"Working query example + notes on use case",chk:"Can explain what Query Service is; design a basic query; explain how to use it for data validation"},
  ],
  2:[
    {t:"Ingest data from Adobe Analytics",obj:"Ingest behavioral data from Adobe Analytics into AEP",act:"Use Sources workspace to configure Adobe Analytics source and dataflow for a report suite; run or schedule initial ingestion",out:"Active Adobe Analytics source connection and running dataflow",chk:"Batches complete; Analytics events visible in AEP datasets and profile",vid:"Ingest data using the Adobe Analytics source connector",dur:"11 min"},
    {t:"Ingest data from Audience Manager",obj:"Bring Audience Manager traits and segments into RTCDP for activation",act:"Configure Audience Manager source connector, select traits/segments, enable datasets for Profile; enable dataflow and let first sync run",out:"Audience Manager source connection with selected traits/segments",chk:"AAM traits/segments visible in Segment Builder; sample profiles enriched with AAM data",vid:"Ingest data using the Adobe Audience Manager data connector",dur:"9 min"},
    {t:"Ingest data from Cloud Storage",obj:"Import batch files from cloud storage into AEP",act:"Create cloud storage source (S3/Blob/GCS/SFTP), map a sample file to XDM, run dataflow",out:"Cloud storage source and dataset populated with ingested records",chk:"Batch status = Success; row count in dataset matches source file",vid:"Ingest data using Cloud Storage source connectors",dur:"7 min"},
    {t:"Ingest data from CRM",obj:"Onboard CRM customer data into Real-Time CDP",act:"Configure a CRM source, map fields to an XDM Profile schema, enable dataset for Profile; run first CRM dataflow",out:"CRM source connection and Profile-enabled dataset",chk:"Sample customer profiles visible in Profile UI with CRM attributes populated",vid:"Ingest data using CRM source connectors",dur:"7 min"},
    {t:"Ingest data from Databases",obj:"Stream or batch-load transactional data from relational databases",act:"Configure a database source (Azure SQL, Snowflake, MySQL, Postgres), create dataflow to an XDM schema; execute or schedule ingestion",out:"Database source connection and dataset with ingested records",chk:"Batches succeed; key fields correctly mapped and usable in queries/segments",vid:"Ingest data using database source connector",dur:"8 min"},
    {t:"Identity and Identity Graphs",obj:"Understand identity namespaces, identity graphs, and how identities are stitched into a unified profile",act:"Open Identity UI, review available namespaces, view an identity graph for a sample profile",out:"Notes on identity stitching and namespace types",chk:"Can explain what an identity graph is; describe how multiple identity types (ECID, email, CRM ID) merge into one profile"},
    {t:"Label, Ingest, and Verify Identity Data",obj:"Understand how to correctly label identity fields in schemas and verify identity resolution after ingestion",act:"Review a schema with identity labels; ingest sample data; verify identity stitching in Profile UI",out:"Confirmed identity-enabled schema and verified profile with multiple identities",chk:"Can identify which fields are marked as identity in a schema; verify that two profiles with the same email are merged"},
  ],
  3:[
    {t:"Understand Real-Time Customer Profile (RTCP)",obj:"Understand core concepts and capabilities of Real-Time Customer Profile",act:"Navigate to Profiles → Browse, open an example profile, review the unified timeline, attributes, identities, and related datasets",out:"Unified profile view familiarity",chk:"Can explain what a Real-Time Customer Profile is; identify key sections; describe how data sources contribute",vid:"Understanding Real Time Customer Profile",dur:"6 min"},
    {t:"Profile Overview Diagram",obj:"Understand the end-to-end flow of data into Profile via the overview diagram",act:"Review the Profile overview diagram; map elements to actual UI areas (Schemas, Datasets, Identities, Profiles, Segments, Destinations)",out:"Annotated diagram mapping each step to an AEP UI workspace",chk:"Can walk through the diagram, mapping each step (ingestion, identity, profile, activation) to corresponding AEP workspaces",vid:"Real-time customer profile overview diagram",dur:"7 min"},
    {t:"Bring Data into Profile",obj:"Learn how to enable schemas and datasets so ingested data contributes to Real-Time Customer Profile",act:"Choose a schema, ensure it has an identity and is Profile enabled; select a dataset, enable it for Profile, ingest sample data",out:"Profile-enabled dataset and sample profiles ingested",chk:"Can show an enabled schema and dataset, confirm profiles are created in Profile view, explain the impact of Profile enablement",vid:"Bringing Data into Real-time Customer Profile",dur:"2 min"},
    {t:"Customize Profile View Details",obj:"Learn how to configure and customize what appears in the profile details UI",act:"In Profiles → Settings, adjust visible attributes, groups, and layout; open a profile to confirm the new configuration",out:"Modified profile view with new attributes or sections",chk:"Can demonstrate a modified profile view and explain how to adjust it again if requirements change"},
    {t:"View Account Profiles",obj:"Understand how to browse and inspect account-level profiles (B2B use cases)",act:"Go to Profiles → Accounts, search for an account, open it, and review account attributes, related people, and associated activities",out:"Account profile view familiarity",chk:"Can locate and interpret an account profile; distinguish between account-level and person-level views; describe key account attributes",vid:"Real-time Customer Data Platform Unified Account Profile",dur:"4 min"},
    {t:"Create Merge Policies",obj:"Learn how to create and manage merge policies that control how Profile is stitched",act:"Navigate to Profiles → Merge policies, create a new merge policy (choose datasets and precedence rules), apply it to a test profile",out:"Merge policy configuration familiarity",chk:"Can explain the selected merge method and precedence; show how different merge policies change what appears in a test profile",vid:"Create a merge policy",dur:"5 min"},
    {t:"Union Schemas Overview",obj:"Understand how union schemas are built and used for Profile and segmentation",act:"Go to Schemas → Union schemas, select a union schema, inspect which XDM classes and schemas contribute, see how fields roll up",out:"Union schema familiarity; list of contributing schemas and 3–5 key fields expected in segments",chk:"Can identify which schemas contribute to a union schema; describe why some fields appear in Profile; explain the impact on segmentation",vid:"Union Schemas in Experience Platform",dur:"3 min"},
  ],
  4:[
    {t:"Segmentation & Audience Types Overview",obj:"Understand RTCDP segmentation concepts and types (batch, streaming, profile, account, basic, advanced)",act:"Open Segments workspace, review list of segments, evaluation types, and statuses; identify 3 existing segments and classify them",out:"Short notes on segment types and evaluation modes",chk:"Can explain what a segment is, how it's evaluated, and the main segment types in RTCDP",vid:"Segments – Segment Builder Overview",dur:"10 min"},
    {t:"Segment Builder UI",obj:"Learn the segment builder layout, fields, events, and preview panel",act:"Open Segment Builder and explore canvas, attribute/events browser, and profile preview; click through attributes, events, identity fields and estimate panel",out:"Annotated screenshot or quick notes on each panel section",chk:"Can point to where to add conditions, where estimates appear, where profiles are previewed"},
    {t:"Create Basic Attribute Segments",obj:"Build simple profile-based audiences from attributes (geography, age, loyalty tier)",act:"Create a basic segment using profile attributes only; build and save 2–3 basic segments",out:"Saved basic attribute segments with clear names",chk:"Audience count visible; user can articulate the logic in plain language",vid:"Create Segments",dur:"6 min"},
    {t:"Streaming vs Batch Segmentation",obj:"Understand streaming segmentation and when to use it vs batch",act:"Review segment details to see evaluation type; create a simple streaming segment",out:"1 streaming segment definition",chk:"Evaluation type shows Streaming; can explain basic latency expectations"},
    {t:"Content-Based Segments",obj:"Target users based on content, product, or category interactions",act:"Create a segment where users have interacted with a specific product category or content type using event data",out:"1–2 content-based segments",chk:"Preview members look correct; conditions reference event-level fields",vid:"Create Content-Based Segments",dur:"5 min"},
    {t:"Conversion Segments",obj:"Identify converters and non-converters for marketing and analytics",act:"Create a 'Converters' segment and a 'Non-Converters' segment based on purchase events; apply time windows",out:"2 conversion segments (Converters and Non-Converters)",chk:"Time window correctly applied; business definition matches expectation",vid:"Create Conversion Segments",dur:"6 min"},
    {t:"Segments from Existing Segments",obj:"Reuse existing logic instead of rebuilding from scratch",act:"Create a segment that includes or excludes an existing base segment",out:"1 derived segment based on an existing segment",chk:"Can explain the dependency: what happens if the base segment changes",vid:"Create Segments from Existing Segments",dur:"4 min"},
    {t:"Dynamic Segments",obj:"Use rolling time windows to avoid static dates",act:"Convert an existing segment from fixed dates to dynamic lookback (e.g., last 30 days)",out:"1 dynamic segment with a relative time window",chk:"Can explain the difference between a fixed date and a rolling window",vid:"Create Dynamic Segments",dur:"4 min"},
    {t:"Sequential Segments",obj:"Model customer journeys and ordered behaviours",act:"Create a sequential segment (e.g., viewed product → added to cart → no purchase) with time constraints",out:"1 sequential segment",chk:"Sequence logic makes sense; can narrate the journey steps",vid:"Create Sequential Segments",dur:"8 min"},
    {t:"Multi-Entity Segments",obj:"Use related entities (product, subscription, store) in segment logic",act:"Verify a relationship in schema, then use related attributes in a segment",out:"1 multi-entity segment",chk:"Related attributes are available; segment returns plausible results"},
    {t:"B2B Segments (Accounts & People)",obj:"Understand B2B schemas and create account/person-based audiences",act:"Build 1 account segment (industry + revenue) and 1 people segment (job role)",out:"2 B2B segments (Account and Person)",chk:"Can describe Account vs Person vs Opportunity audiences and their usage"},
    {t:"Evaluate Segment Results",obj:"Learn how to run, monitor, and interpret segment evaluations",act:"Open segment details, run evaluation (if batch), review counts, history, and logs; evaluate 2–3 segments and compare expected vs actual sizes",out:"Evaluation notes for each segment",chk:"Can explain evaluation status, run time, and how to spot anomalies"},
    {t:"Export Segment to Dataset",obj:"Understand how to land audiences in a dataset for downstream use",act:"Create a dataset and configure export for one segment; verify records",out:"1 export dataset + audience export run",chk:"Export completes; dataset shows rows for expected segment members"},
    {t:"Federated Audience Composition (FAC)",obj:"Understand when to use FAC vs native RTCDP segmentation",act:"Review FAC overview; identify 1–2 scenarios where FAC is a better fit; sketch sample FAC flows",out:"FAC scenario notes with source systems, logic, and RTCDP usage",chk:"Can explain what stays in FAC vs what is done in RTCDP segments"},
    {t:"Flexible Audience Evaluation (FAE)",obj:"Learn FAE concepts and when to enable it for segments",act:"Review FAE guide; diagnose which segments would benefit; create a prioritised candidate list with rationale",out:"Prioritised FAE candidate list",chk:"Tradeoffs (control, cost, latency) documented"},
    {t:"TTL & Data Retention",obj:"Understand how dataset TTL impacts available lookback for segments",act:"Review TTL settings for key event datasets; map to segment lookback windows; check 3–5 key segments against dataset TTL",out:"Segments vs datasets vs TTL mapping",chk:"No segment requires data older than its source dataset's retention"},
    {t:"Segment & Profile Guardrails",obj:"Understand default RTCDP Profile and segmentation guardrails",act:"Review guardrail documentation; estimate profile counts, event volumes, and segment numbers vs guardrails",out:"Guardrail fit assessment",chk:"Risks identified if projected volumes approach or exceed limits"},
  ],
  5:[
    {t:"Destinations Overview",obj:"Understand destination types and lifecycle",act:"Explore Destinations → Catalog and review key types and categories",out:"Notes on Ad, Email, Cloud, Edge, and Custom destination types",chk:"Can explain online vs offline vs edge/custom destinations",vid:"Destination Overview",dur:"6 min"},
    {t:"Connect to a Destination",obj:"Connect RTCDP to an ad platform",act:"Configure an advertising destination (e.g. Google Ads) from the Destinations catalog; complete connection setup",out:"One configured ad destination",chk:"Destination appears under Browse with Connection status = Active",vid:"Connect to destinations",dur:"4 min"},
    {t:"Create Destination & Activate Profiles",obj:"Activate profiles and audiences to a destination",act:"Create or choose a destination, select segments, configure identity and attribute mapping; map segments and attributes",out:"Destination with active segments and mappings",chk:"IDs and traits mapped to expected fields; activation run succeeds",vid:"Activate profiles and audiences to a destination",dur:"4 min"},
    {t:"Export Dataset via Cloud Storage",obj:"Export datasets to cloud storage",act:"Configure a cloud storage destination and set up a dataset export dataflow; run a dataset export",out:"Files in cloud storage (CSV/Parquet/JSON)",chk:"File appears at expected location with correct schema and row count",vid:"Exporting Datasets Using Cloud Storage Destinations",dur:"4 min"},
    {t:"Configure Azure Blob Storage",obj:"Set up Azure Blob as a cloud storage destination",act:"Create Azure Blob destination (paste connection string, choose container and path); save and test export",out:"Working Azure Blob destination",chk:"Test export file visible in correct container/path with expected data",vid:"Configuring Azure Blob Storage as a Destination",dur:"6 min"},
    {t:"Adobe Target & Custom Personalization",obj:"Use RTCDP with Target and custom personalization destinations",act:"Configure Adobe Target or Custom Personalization destination, map identity and traits; activate a test segment",out:"Target/custom destination with at least one active segment",chk:"Test profile qualifies on edge and attributes available in Target/app",vid:"Using RTCDP with Adobe Target & Custom Personalization",dur:"6 min"},
    {t:"Integrate with Google Customer Match",obj:"Activate audiences to Google Customer Match",act:"Configure Google Customer Match destination and assign RTCDP segments; activate one or more test segments",out:"Google Customer Match destination with active audiences",chk:"Audience appears in Google as a Customer Match list and starts populating",vid:"Integrate Google Customer Match",dur:"3 min"},
    {t:"Configure the Marketo Destination",obj:"Send RTCDP audiences to Marketo for email and engagement",act:"Configure Marketo Engage destination, map identities and attributes; activate a segment to Marketo",out:"Marketo destination with at least one active audience",chk:"Static list or smart list in Marketo contains expected profiles",vid:"Configure the Marketo Engage destination",dur:"6 min"},
    {t:"Configure a Social Destination",obj:"Connect RTCDP to a social ads platform",act:"Configure a social destination (LinkedIn/Facebook), map IDs and attributes; activate one or more test audiences",out:"Configured social destination with mapped identities and active segments",chk:"Audience visible in the social platform and starts filling",vid:"Configure a social destination",dur:"4 min"},
    {t:"Activate Data to Non-Adobe Applications",obj:"Understand patterns for activating RTCDP data to non-Adobe tools",act:"Review recommended patterns for HTTP API/Kinesis/Event Hubs/custom destinations; draft design for activating to a non-Adobe endpoint",out:"Drafted design for activating an audience to a non-Adobe endpoint",chk:"Use case is mapped to a concrete destination type (file-based vs streaming/HTTP API) and feasible in catalog",vid:"Activate data to non-Adobe applications webinar",dur:"43 min"},
    {t:"RT-CDP Connections: Server-Side Event Forwarding",obj:"Understand the Server-Side Event Forwarding configuration",act:"Configure Server-Side Event Forwarding; implement and test event forwarding to a test endpoint",out:"Implemented server-side event forwarding",chk:"Successful event forwarding to a test account or endpoint",vid:"RT-CDP Connections: Server-Side Event Forwarding",dur:"18 min"},
  ],
  6:[
    {t:"Monitoring Dashboard Overview",obj:"Understand the monitoring dashboard UI — data lake ingestion, dataflows into identities, profiles, audiences, and destinations",act:"Log in to AEP UI and explore the monitoring tab",out:"Familiarity with Monitoring dashboard",chk:"Can explain the monitoring dashboard and its main sections"},
    {t:"Streaming Ingestion Monitoring",obj:"Learn how to verify streaming connections and monitor near real-time flows",act:"Monitoring → Streaming end-to-end; review events per second and last event time",out:"Streaming ingestion monitoring familiarity",chk:"Can point out where to see events per second and last event time for a streaming ingestion source"},
    {t:"Batch Ingestion Monitoring",obj:"Understand batch run details, error logs, and record counts",act:"Monitoring → Batch end-to-end; locate error logs, total/failed record counts, and field-level error details",out:"Batch ingestion run familiarity",chk:"Can locate error logs, total/failed record counts, and explain where to find field-level error details"},
    {t:"Dataflows to Data Lake",obj:"Learn how to monitor dataflows that land data into the Data Lake",act:"Monitoring → Dashboard → Data lake tab; review latest dataflow status, duration, and errors",out:"Data Lake dataflow monitoring familiarity",chk:"Can explain whether the latest dataflow succeeded, its duration, and any errors or warnings"},
    {t:"Profile Dataflow Monitoring",obj:"Track profile ingestion and profile update success/failure",act:"Check Profile ingestion under Streaming end-to-end tab; identify number of profiles updated",out:"Profile dataflow monitoring familiarity",chk:"Can show where to see number of profiles updated and identify if profile updates are failing or partially successful"},
    {t:"Segment Job Monitoring",obj:"Monitor segmentation runs and interpret segment evaluation metrics",act:"Browse, pick a segment, open Segment activity/Jobs, review the latest run; explore segmentation jobs of the last 24 hours",out:"Segmentation monitoring familiarity",chk:"Can identify last run time, duration, profile counts, and whether the segment run completed successfully",vid:"Monitoring Data Ingestion",dur:"6 min"},
    {t:"Destination Activation Monitoring",obj:"Track export and activation jobs to destinations",act:"Open a configured destination, go to Activation/Monitoring and inspect job history",out:"Destination activation monitoring familiarity",chk:"Can identify last activation run, status, number of profiles/records exported, and locate any error messages"},
    {t:"Segment Activation Monitoring",obj:"Monitor and interpret the success of segment activation to destinations",act:"Select a destination with active segment activations, open the Activation/Monitoring view, review activation job results, counts, and errors",out:"Segment activation monitoring familiarity",chk:"Can identify latest activation run status, exported profile/record counts, and locate error details for a failing activation",vid:"Monitoring the success of segment activation",dur:"9 min"},
    {t:"Data Monitoring Overview",obj:"Use AEP data monitoring capabilities to track ingestion, processing, and activation health",act:"Explore available workspaces (data ingestion, data lake, profile, destinations); adjust filters and time ranges; inspect example issues and trends",out:"Data monitoring familiarity",chk:"Can explain what each main data monitoring view is for; how to change date ranges/filters; where to look for issues across ingestion and activation",vid:"Monitor Data Ingestion",dur:"14 min"},
  ],
  7:[
    {t:"Federated Audience Composition",obj:"Learn about FAC capabilities, business challenges it solves, supported use cases, and value for customers",act:"Review FAC overview videos and documentation",out:"FAC scenario notes with use cases and positioning",chk:"Can explain when to use FAC vs native RTCDP segmentation; describe the supported use cases",vid:"Multiple Videos",dur:"215 min total"},
    {t:"AI Assistant in Experience Platform",obj:"Learn to use AI Assistant in AEP, RTCDP, CJA, and AJO",act:"Review AI Assistant capabilities, components, and trust considerations",out:"Notes on AI Assistant capabilities and go-to-market value",chk:"Can demonstrate AI Assistant use cases in at least one AEP product"},
    {t:"Customer AI: Overview and Model Setup",obj:"Learn about Customer AI propensity scoring and model development",act:"Review Customer AI workflow, set up a model with data prerequisites, define an outcome",out:"Customer AI model configuration",chk:"Can define Customer AI and its purpose; describe data prerequisites; define an outcome; walk through model setup steps"},
    {t:"Computed Attributes",obj:"Understand how computed attributes summarise profile behaviour via an intuitive UI for segmentation, personalization, and activation",act:"Review computed attributes documentation; identify 2–3 use cases where computed attributes add value",out:"Computed attribute definition with use case",chk:"Can explain what a computed attribute is, how it differs from a raw event, and a relevant use case in RTCDP or AJO"},
    {t:"Look-Alike Audiences",obj:"Learn about RTCDP's AI and ML-powered Look-Alike Audiences feature",act:"Review Look-Alike Audiences workflow through a demo; understand how it complements AI capabilities",out:"Notes on Look-Alike Audiences feature and positioning",chk:"Can explain what look-alike modelling does, when to use it, and how it integrates with RTCDP segments"},
    {t:"Audience Portal and Composition",obj:"Understand Audience Portal and Audience Composer features and the customer challenges they resolve",act:"Review documentation; identify use cases addressed and value realization for customers",out:"Summary of Audience Portal vs Audience Composition capabilities",chk:"Can describe what Audience Portal is, how Audience Composer works, and 2–3 use cases"},
    {t:"Use Case Playbooks",obj:"Understand Use Case Playbooks as pre-packaged industry-focused workflows in AEP applications",act:"Review Use Case Playbooks overview; identify 1–2 playbooks relevant to your team",out:"2 relevant playbooks identified with use case mapping",chk:"Can explain what a Use Case Playbook is and how it accelerates customer adoption"},
    {t:"Partner Data Support in Real-Time CDP",obj:"Learn about Partner Data capabilities, use cases, and positioning strategy",act:"Review Partner Data overview and technical documentation",out:"Notes on partner data use cases and key limitations",chk:"Can describe the market challenges addressed, key capabilities, and implementation best practices"},
  ],
  8:[
    {t:"Query Service for Data Validation",obj:"Use Query Service to validate and explore ingested data, gain insights from the Data Lake",act:"Run validation SQL queries against ingested datasets in Query Service UI; verify profile counts and segment membership",out:"Working validation queries + notes on use case",chk:"Can run a SQL query to validate profile counts; explain how to use Query Service for data debugging",vid:"Run queries in Query Service",dur:"Variable"},
    {t:"Profile Qualification Debugging",obj:"Diagnose why a profile does or does not qualify for a segment",act:"Use Profile UI and Query Service to check segment membership, evaluate conditions, and trace identity resolution",out:"Debugging notes for a diagnosed profile qualification issue",chk:"Can identify why a profile isn't qualifying for a segment; check identity stitching and merge policy impact"},
    {t:"Segment Evaluation Diagnostics",obj:"Diagnose segment evaluation job failures and unexpected results",act:"Review segment job logs in Monitoring; use Query Service to validate counts; cross-reference with source data",out:"Root cause analysis for a segment evaluation anomaly",chk:"Can explain how to trace a segment evaluation failure from the monitoring dashboard to the source data"},
    {t:"POC and Testing in QA/Stage Sandbox",obj:"Validate implementations in QA/stage before promoting to production",act:"Set up a test scenario in a non-production sandbox; run ingestion, segment, and activation end-to-end; validate all outputs",out:"POC validation checklist with test results",chk:"Can describe the end-to-end validation approach for a new RTCDP implementation in a safe sandbox"},
    {t:"Real-Time Profile Qualification Checks",obj:"Verify that profiles qualify for segments in real time after a streaming event",act:"Trigger a streaming event; verify immediate profile update and segment qualification in Profile UI",out:"Real-time qualification validation notes",chk:"Can demonstrate real-time profile qualification after a streaming event and explain the expected latency"},
  ],
  9:[
    {t:"RTCDP Business Practitioner Certification Prep",obj:"Complete the RTCDP Business Practitioner certification",act:"Review exam guide, complete practice assessments, review all key modules",out:"RTCDP Business Practitioner Certificate",chk:"Certification exam passed"},
  ],
};
function ModuleLesson({module:m,groqKey,onClose,track="rtcdp",userId=""}){
  const [subtopics,setSubtopics]=useState(getLessonContentForTrack(track)[m?.id]||[]);
  const [active,setActive]=useState(0);
  const [loading,setLoading]=useState(true);
  const [docContent,setDocContent]=useState(null);
  const [docLoading,setDocLoading]=useState(false);

  useEffect(()=>{
    if(!m)return;
    setActive(0);setDocContent(null);
    // BUG FIX: this fetch never sent ?track=, so the backend (which defaults to
    // "rtcdp" when the param is absent) always returned RTCDP's module content
    // regardless of the real track — every track's module 1 looked identical.
    fetch(`${BACKEND}/api/curriculum/${m.id}?track=${track}`)
      .then(r=>r.json())
      .then(data=>{
        setSubtopics(data.topics?.length
          ? data.topics.map(r=>({
              t:r.title,obj:r.objective,act:r.activity,
              out:r.output,chk:r.checkpoint,
              vid:r.video_title,dur:r.video_duration,
              order:r.topic_order,el_url:r.el_url
            }))
          : (getLessonContentForTrack(track)[m.id]||[]));
        setLoading(false);
      })
      .catch(()=>{setSubtopics(getLessonContentForTrack(track)[m.id]||[]);setLoading(false);});
  },[m?.id,track]);

  // Fetch actual doc content when topic changes
  useEffect(()=>{
    if(!m||loading)return;
    const sub=subtopics[active];
    if(!sub)return;
    const order=sub.order||(active+1);
    setDocContent(null);setDocLoading(true);
    // Same bug as above — missing ?track= silently pulled RTCDP's doc content.
    fetch(`${BACKEND}/api/content/${m.id}/${order}?track=${track}`)
      .then(r=>r.json())
      .then(data=>{setDocContent(data);setDocLoading(false);})
      .catch(()=>setDocLoading(false));
  },[active,loading,track]);

  const sub=subtopics[active];
  const renderMarkdown=renderAdobeMarkdown;
  const markdownHtml = docContent?.content ? renderMarkdown(docContent.content) : "";
  if(!m)return null;
  if(loading)return(
    <div style={{position:"fixed",inset:0,background:P.bg,zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:15,fontWeight:600,color:P.txt,marginBottom:4}}>Loading lesson…</div>
        <div style={{fontSize:12.5,color:P.muted}}>Fetching curriculum from database</div>
      </div>
    </div>
  );

  // Full-page lesson view (a dedicated screen, not a modal popup): opaque
  // background fills the viewport and a top app bar with a Back button reads
  // like its own tab/route rather than a floating dialog.
  return(
    <div style={{position:"fixed",inset:0,background:P.bg,zIndex:200,display:"flex",flexDirection:"column"}}>
      <div style={{background:P.panel,width:"100%",height:"100%",display:"flex",flexDirection:"column",flex:1,minHeight:0}}>
        {/* Top app bar */}
        <div style={{display:"flex",alignItems:"center",gap:16,padding:"12px 24px",borderBottom:`1px solid ${P.border}`,flexShrink:0}}>
          <button onClick={onClose} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"7px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer",color:P.txt,fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:6,flexShrink:0}}>
            <Ic as={ChevronLeft} size={14} color="currentColor"/> Back to modules
          </button>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:11,fontWeight:600,color:P.blue,letterSpacing:.5,textTransform:"uppercase",marginBottom:2}}>{m.tag} · Week {m.week}</div>
            <div style={{fontSize:16,fontWeight:600,color:P.txt,letterSpacing:-.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.title}</div>
          </div>
        </div>

        <div style={{display:"flex",flex:1,overflow:"hidden",minHeight:0,maxWidth:1180,width:"100%",margin:"0 auto"}}>
          {/* Topic nav */}
          <div style={{width:210,flexShrink:0,borderRight:`1px solid ${P.border}`,overflowY:"auto",padding:"8px"}}>
            {subtopics.map((s,i)=>(
              <button key={i} onClick={()=>setActive(i)}
                style={{width:"100%",display:"block",textAlign:"left",padding:"8px 10px",borderRadius:8,border:"none",cursor:"pointer",fontFamily:"inherit",background:active===i?P.blueGh:"transparent",marginBottom:2}}>
                <div style={{fontSize:11.5,fontWeight:active===i?600:400,color:active===i?P.blue:P.txt,lineHeight:1.4}}>{s.t}</div>
                {s.vid&&<div style={{fontSize:10,color:P.dim,marginTop:1}}>▶ {s.dur}</div>}
              </button>
            ))}
          </div>

          {/* Content — two tabs: Curriculum guide | EL Documentation */}
          {sub&&<ContentPane sub={sub} docContent={docContent} docLoading={docLoading} renderMarkdown={renderMarkdown} groqKey={groqKey} moduleTitle={m.title} moduleId={m.id} track={track} userId={userId}/>}
        </div>

        <div style={{padding:"10px 22px",borderTop:`1px solid ${P.border}`,display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          <div style={{display:"flex",gap:8,flex:1}}>
            <button onClick={()=>setActive(a=>Math.max(0,a-1))} disabled={active===0}
              style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:7,padding:"5px 14px",fontSize:12,cursor:active===0?"not-allowed":"pointer",color:P.muted,fontFamily:"inherit",opacity:active===0?.4:1,display:"inline-flex",alignItems:"center",gap:4}}><Ic as={ChevronLeft} size={13} color="currentColor"/> Prev</button>
            <span style={{fontSize:12,color:P.dim,alignSelf:"center"}}>{active+1} / {subtopics.length}</span>
            <button onClick={()=>setActive(a=>Math.min(subtopics.length-1,a+1))} disabled={active===subtopics.length-1}
              style={{background:active===subtopics.length-1?"transparent":P.blue,border:"none",borderRadius:7,padding:"5px 14px",fontSize:12,cursor:"pointer",color:active===subtopics.length-1?P.muted:"#fff",fontFamily:"inherit",opacity:active===subtopics.length-1?.4:1,display:"inline-flex",alignItems:"center",gap:4}}>Next <Ic as={ChevronRight} size={13} color="currentColor"/></button>
          </div>
          <Btn variant="secondary" size="sm" onClick={onClose}>Back to modules</Btn>
        </div>
      </div>
    </div>
  );
}

// Shared styling for rendered Experience League / GitHub documentation, used by
// both the Lesson tab (the actual fetched page content) and anywhere else that
// renders AEP markdown into the `.el-content` container.
function ElContentCSS(){
  return <style>{`
    .el-content{font-size:14px;color:${P.txt};line-height:1.85;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
    .el-content h1{font-size:20px;font-weight:800;color:${P.txt};margin:28px 0 14px;padding-bottom:10px;border-bottom:2px solid ${P.border};letter-spacing:-.3px;line-height:1.3;}
    .el-content h2{font-size:17px;font-weight:700;color:${P.txt};margin:24px 0 10px;padding-left:12px;border-left:3px solid ${P.blue};line-height:1.35;}
    .el-content h3{font-size:15px;font-weight:700;color:${P.txt};margin:20px 0 8px;line-height:1.4;}
    .el-content h4{font-size:13.5px;font-weight:600;color:${P.muted};margin:16px 0 6px;text-transform:uppercase;letter-spacing:.4px;}
    .el-content p{margin:0 0 14px;line-height:1.85;}
    .el-content strong{font-weight:700;color:${P.txt};}
    .el-content em{font-style:italic;color:${P.muted};}
    .el-content a{color:${P.blue};text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px;font-weight:500;}
    .el-content a:hover{opacity:.75;}
    .el-content ul,.el-content ol{margin:0 0 14px;padding-left:24px;}
    .el-content ul{list-style:disc;}
    .el-content ol{list-style:decimal;}
    .el-content li{margin-bottom:7px;line-height:1.7;}
    .el-content li>ul,.el-content li>ol{margin:6px 0 0;}
    .el-content code{background:${P.surface};padding:2px 7px;border-radius:5px;font-size:12.5px;color:${P.txt};font-family:ui-monospace,Menlo,"SF Mono",monospace;border:1px solid ${P.border};}
    .el-content pre{background:#1E1E2E;border-radius:10px;padding:16px 18px;overflow-x:auto;margin:0 0 16px;border:1px solid ${P.border};}
    .el-content pre code{background:transparent;border:none;color:#CDD6F4;font-size:12.5px;padding:0;line-height:1.7;}
    .el-content table{border-collapse:collapse;width:100%;margin:6px 0 18px;font-size:13px;border:1px solid ${P.border};border-radius:8px;overflow:hidden;}
    .el-content thead{background:${P.surface};}
    .el-content th{padding:10px 14px;border-bottom:2px solid ${P.border};text-align:left;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.3px;color:${P.muted};}
    .el-content td{padding:10px 14px;border-bottom:1px solid ${P.bfaint};vertical-align:top;}
    .el-content tr:last-child td{border-bottom:none;}
    .el-content tr:hover td{background:${P.blueGh};}
    .el-note{background:${P.blueGh};border-left:4px solid ${P.blue};border-radius:0 8px 8px 0;padding:12px 16px;margin:0 0 16px;font-size:13.5px;color:${P.txt};}
    .el-tip{background:${P.grnBg};border-left:4px solid ${P.grn};border-radius:0 8px 8px 0;padding:12px 16px;margin:0 0 16px;font-size:13.5px;color:${P.txt};}
    .el-warn{background:${P.redBg};border-left:4px solid ${P.red};border-radius:0 8px 8px 0;padding:12px 16px;margin:0 0 16px;font-size:13.5px;color:${P.txt};}
    .el-important{background:${P.amberBg};border-left:4px solid ${P.amber};border-radius:0 8px 8px 0;padding:12px 16px;margin:0 0 16px;font-size:13.5px;color:${P.txt};}
    .el-note strong,.el-tip strong,.el-warn strong,.el-important strong{font-weight:700;display:inline-block;margin-right:4px;}
    .el-quote{border-left:3px solid ${P.border};padding:10px 16px;margin:0 0 14px;color:${P.muted};font-style:italic;}
    .el-content img{max-width:100%;height:auto;border-radius:10px;margin:12px 0;border:1px solid ${P.border};display:block;}
    .el-img-wrap{margin:16px 0;}
    .el-def{padding:10px 14px;background:${P.surface};border:1px solid ${P.border};border-radius:8px;margin:0 0 8px;}
    .el-def dt{font-weight:700;font-size:13px;color:${P.txt};margin-bottom:4px;}
    .el-def dd{font-size:13px;color:${P.muted};margin:0;line-height:1.6;}
    .el-ui{background:${P.surface};border:1px solid ${P.border};border-radius:4px;padding:1px 6px;font-size:12px;font-weight:600;color:${P.txt};}
    .el-badge{background:${P.blue};color:#fff;border-radius:4px;padding:1px 8px;font-size:11px;font-weight:600;}
    .el-content hr{border:none;border-top:1px solid ${P.border};margin:22px 0;}
  `}</style>;
}

function StudyToolsTab({moduleTitle,moduleId,track="rtcdp",groqKey}){
  const [sub,setSub]=useState("flashcards");
  const [mmData,setMmData]=useState(null);
  const [mmLoading,setMmLoading]=useState(false);

  const runGenerate=()=>{
    setMmLoading(true);
    generateStudyMaterials(moduleTitle,groqKey,{moduleId,track}).then(d=>{setMmData(d);setMmLoading(false);});
  };

  useEffect(()=>{
    if(sub!=="mindmap"||mmData)return;
    runGenerate();
  },[sub,moduleTitle,moduleId,track]);
  useEffect(()=>{setMmData(null);},[moduleTitle,moduleId,track]); // regenerate if the module changes

  return(
    <div style={{height:"100%",display:"flex",flexDirection:"column"}}>
      <div style={{display:"flex",gap:2,padding:"10px 16px 0",flexShrink:0,alignItems:"center"}}>
        {[{id:"flashcards",l:"Flashcards",icon:CursorClick},{id:"mindmap",l:"Mindmap",icon:Layers}].map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)}
            style={{display:"inline-flex",alignItems:"center",gap:6,padding:"7px 14px",background:sub===t.id?P.surface:"transparent",border:`1px solid ${sub===t.id?P.border:"transparent"}`,borderRadius:8,color:sub===t.id?P.txt:P.muted,fontWeight:sub===t.id?600:400,fontSize:12.5,cursor:"pointer",fontFamily:"inherit"}}>
            <Ic as={t.icon} size={14} color={sub===t.id?P.txt:P.muted}/> {t.l}
          </button>
        ))}
        {sub==="mindmap"&&!mmLoading&&(
          <button onClick={runGenerate} style={{marginLeft:"auto",display:"inline-flex",alignItems:"center",gap:5,padding:"6px 12px",background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,color:P.muted,fontWeight:500,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>
            <Ic as={Refresh} size={13} color={P.muted}/> Regenerate
          </button>
        )}
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"14px 20px"}}>
        {sub==="flashcards"&&<FlashCards module={moduleTitle} moduleId={moduleId} track={track} groqKey={groqKey} profile={null}/>}
        {sub==="mindmap"&&(
          mmLoading?<div style={{textAlign:"center",padding:40}}><div style={{fontSize:13,color:P.muted}}>Generating mindmap…</div></div>:
          mmData?(
            <MindmapViewer data={mmData} moduleTitle={moduleTitle}/>
          ):<div style={{textAlign:"center",padding:40,fontSize:13,color:P.muted}}>Couldn't generate a mindmap — try again.</div>
        )}
      </div>
    </div>
  );
}

function ContentPane({sub,docContent,docLoading,renderMarkdown,groqKey,moduleTitle,moduleId=null,onConfUpdate=null,track="rtcdp",userId=""}){
  const [view,setView]=useState("lesson");
  useEffect(()=>setView("lesson"),[sub?.t]);
  const [msgs,setMsgs]=useState([{role:"assistant",content:`Ask me anything about "${sub?.t}" — I'll guide you through it.`}]);
  const [input,setInput]=useState("");
  const [busy,setBusy]=useState(false);
  const chatRef=useRef(null);
  useEffect(()=>{if(chatRef.current)chatRef.current.scrollTop=chatRef.current.scrollHeight;},[msgs]);
  // Reset chat when topic changes
  useEffect(()=>{setMsgs([{role:"assistant",content:`Ask me anything about "${sub?.t}" — I'll guide you through it.`}]);},[sub?.t]);

  const sendMsg=async()=>{
    if(!input.trim()||busy)return;
    const userMsg={role:"user",content:input.trim()};
    setMsgs(p=>[...p,userMsg]);setInput("");setBusy(true);
    const sys=`You are a learning assistant helping an AEP Analytics engineer understand: ${sub?.t}.
Module: ${moduleTitle}. Objective: ${sub?.obj}.
Guide with hints and questions — don't give direct answers. Keep responses under 80 words.`;
    try{
      const text=await callAgent([...msgs,userMsg].map(m=>({role:m.role,content:m.content})),sys,groqKey,{agentName:"Study",logFn:null,maxTokens:200});
      setMsgs(p=>[...p,{role:"assistant",content:text}]);
    }catch{setMsgs(p=>[...p,{role:"assistant",content:"Connection issue — check Groq key in Admin."}]);}
    setBusy(false);
  };

  return(
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden",minWidth:0}}>
      {/* Tab bar */}
      <div style={{display:"flex",borderBottom:`1px solid ${P.border}`,flexShrink:0,padding:"0 16px"}}>
        {[{id:"lesson",l:"Lesson",icon:Education},{id:"ainotes",l:"Study Notes",icon:StickyNote},{id:"quiz",l:"Module Quiz",icon:Edit},{id:"study",l:"Source Docs",icon:FileText}].map(t=>(
          <button key={t.id} onClick={()=>setView(t.id)}
            style={{display:"inline-flex",alignItems:"center",gap:6,padding:"10px 16px",background:"transparent",border:"none",borderBottom:view===t.id?`2px solid ${P.blue}`:"2px solid transparent",color:view===t.id?P.blue:P.muted,fontWeight:view===t.id?600:400,fontSize:13,cursor:"pointer",fontFamily:"inherit",marginBottom:-1}}>
            <Ic as={t.icon} size={14} color={view===t.id?P.blue:P.muted}/> {t.l}
          </button>
        ))}
      </div>

      {/* Lesson tab — curriculum guide + video */}
      {view==="lesson"&&<div style={{flex:1,overflowY:"auto",padding:"18px 20px"}}>
        <div style={{fontSize:15,fontWeight:500,color:P.txt,marginBottom:12}}>{sub?.t}</div>

        {/* Video embed — show if available */}
        {docContent?.video_url&&<div style={{marginBottom:16}}>
          <div style={{fontSize:10.5,fontWeight:600,color:P.red,letterSpacing:.5,marginBottom:8}}>VIDEO</div>
          <div style={{position:"relative",paddingBottom:"56.25%",borderRadius:10,overflow:"hidden",background:"#000"}}>
            <iframe
              src={docContent.video_url}
              style={{position:"absolute",top:0,left:0,width:"100%",height:"100%",border:"none"}}
              allow="autoplay; fullscreen"
              allowFullScreen
              title={sub?.t}
            />
          </div>
          {sub?.dur&&<div style={{fontSize:11.5,color:P.muted,marginTop:6}}>Duration: {sub.dur}</div>}
        </div>}

        {/* Video placeholder if video_title known but not yet loaded */}
        {sub?.vid&&!docContent?.video_url&&docContent&&<div style={{background:P.surface,borderRadius:10,padding:"12px 16px",marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
          <span style={{background:P.redBg,color:P.red,borderRadius:4,padding:"2px 8px",fontSize:10.5,fontWeight:600}}>VIDEO</span>
          <span style={{fontSize:13,color:P.muted}}>{sub.vid} · {sub.dur}</span>
        </div>}

        {/* Curriculum cards */}
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {[{l:"OBJECTIVE",v:sub?.obj,c:P.dim,bg:P.surface},
            {l:"HANDS-ON ACTIVITY",v:sub?.act,c:P.blue,bg:P.blueGh},
            {l:"OUTPUT / DELIVERABLE",v:sub?.out,c:P.grn,bg:P.grnBg},
            {l:"VALIDATION CHECKPOINT",v:sub?.chk,c:P.amber,bg:P.amberBg}].map(s=>(
            <div key={s.l} style={{background:s.bg,borderRadius:10,padding:"11px 14px"}}>
              <div style={{fontSize:10.5,fontWeight:600,color:s.c,letterSpacing:.5,marginBottom:5}}>{s.l}</div>
              <div style={{fontSize:13.5,color:P.txt,lineHeight:1.7}}>{s.v}</div>
            </div>
          ))}
        </div>

        {/* Full lesson content — the actual page fetched from Adobe's GitHub docs.
            The learner reads it right here in the Lesson tab; the Source Docs tab
            explains where it came from and how it was retrieved. */}
        <ElContentCSS/>
        {docLoading&&<div style={{marginTop:18,fontSize:13,color:P.muted}}>Loading the full lesson from Adobe documentation…</div>}
        {!docLoading&&docContent?.content&&<div style={{marginTop:20,paddingTop:18,borderTop:`1px solid ${P.border}`}}>
          <div style={{fontSize:11.5,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",marginBottom:2}}>Lesson content</div>
          <div style={{fontSize:11,color:P.dim,marginBottom:14,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            Sourced live from Adobe Experience League docs
            {docContent.el_url&&<a href={docContent.el_url} target="_blank" rel="noreferrer" style={{color:P.blue,textDecoration:"none"}}>· view original ↗</a>}
          </div>
          {docContent.format==="html"
            ?<div dangerouslySetInnerHTML={{__html:docContent.content}} className="el-content"/>
            :<div dangerouslySetInnerHTML={{__html:renderMarkdown(docContent.content)}} className="el-content"/>}
        </div>}
        {!docLoading&&!docContent?.content&&<div style={{marginTop:18,fontSize:12.5,color:P.muted,background:P.surface,borderRadius:8,padding:"12px 14px"}}>
          The full documentation page for this topic couldn't be fetched right now. See the <strong>Source Docs</strong> tab for where it's pulled from and direct links to read it on Experience League.
        </div>}
      </div>}

      {/* Study & Docs tab — EL content + mini AI agent */}
      {view==="quiz"&&<div style={{flex:1,overflowY:"auto",padding:"20px 24px"}}>
        <SeqQuiz topicTitle={sub?.t||"this topic"} moduleTitle={moduleTitle||"AEP module"} track={track} groqKey={groqKey} userId={userId} onConfUpdate={onConfUpdate}/>
      </div>}
      {view==="ainotes"&&<div style={{flex:1,overflowY:"auto",padding:"18px 24px"}}>
        <AINotesView topicTitle={sub?.t||"this topic"} moduleTitle={moduleTitle||"AEP module"} docContent={docContent} groqKey={groqKey}/>
      </div>}
      {view==="study"&&<div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>
        {/* Left: video + EL documentation */}
        <div style={{flex:1,overflowY:"auto",padding:"16px 18px",borderRight:`1px solid ${P.border}`,minWidth:0}}>

          {/* Video — shown at top if available */}
          {docContent?.video_url&&<div style={{marginBottom:18}}>
            <div style={{fontSize:10.5,fontWeight:600,color:P.red,letterSpacing:.5,marginBottom:8}}>VIDEO · {sub?.dur}</div>
            <div style={{position:"relative",paddingBottom:"56.25%",borderRadius:10,overflow:"hidden",background:"#000"}}>
              <iframe src={docContent.video_url}
                style={{position:"absolute",top:0,left:0,width:"100%",height:"100%",border:"none"}}
                allow="autoplay; fullscreen" allowFullScreen title={sub?.t}/>
            </div>
          </div>}

          {/* Video placeholder — known video but URL not yet extracted */}
          {sub?.vid&&!docContent?.video_url&&!docLoading&&<div style={{background:P.surface,borderRadius:10,padding:"12px 16px",marginBottom:14,display:"flex",alignItems:"center",gap:10}}>
            <span style={{background:P.redBg,color:P.red,borderRadius:4,padding:"2px 8px",fontSize:10.5,fontWeight:600}}>VIDEO</span>
            <span style={{fontSize:13,color:P.muted}}>{sub.vid} · {sub.dur}</span>
            <span style={{fontSize:11.5,color:P.dim,marginLeft:"auto"}}>Switch to Lesson tab to watch</span>
          </div>}

          {docLoading&&<div style={{fontSize:13,color:P.muted}}>Loading documentation…</div>}
          {!docLoading&&!docContent?.content&&(
            <div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {sub?.obj&&<div style={{background:P.surface,borderRadius:8,padding:"10px 13px"}}>
                  <div style={{fontSize:10.5,fontWeight:600,color:P.dim,marginBottom:4}}>OBJECTIVE</div>
                  <div style={{fontSize:13.5,color:P.txt,lineHeight:1.7}}>{sub.obj}</div>
                </div>}
                {sub?.act&&<div style={{background:P.blueGh,borderRadius:8,padding:"10px 13px"}}>
                  <div style={{fontSize:10.5,fontWeight:600,color:P.blue,marginBottom:4}}>HANDS-ON ACTIVITY</div>
                  <div style={{fontSize:13.5,color:P.txt,lineHeight:1.7}}>{sub.act}</div>
                </div>}
              </div>
            </div>
          )}
          {/* Documentation for this topic — the actual reference docs a learner
              should read. Prefers the exact Experience League page this lesson
              maps to, plus the GitHub source and topic search/community. */}
          {!docLoading&&docContent&&(()=>{
            const topic=sub?.t||docContent.title||"AEP";
            const links=[
              docContent.el_url&&{label:"Read on Experience League",desc:"The official Adobe documentation page for this topic",url:docContent.el_url,icon:FileText,primary:true},
              docContent.github_url&&{label:"View source on GitHub",desc:"AdobeDocs — the same doc in its source repository",url:docContent.github_url,icon:Code},
              {label:"Search this topic on Experience League",desc:"Find related guides, tutorials and videos",url:`https://experienceleague.adobe.com/search.html?lang=en#q=${encodeURIComponent(topic)}&t=Documentation`,icon:Search},
              {label:"Ask the Experience League community",desc:"Community Q&A for Adobe Experience Platform",url:"https://experienceleaguecommunities.adobe.com/t5/adobe-experience-platform/ct-p/adobe-experience-platform",icon:CommunityIcon},
            ].filter(Boolean);
            return(
              <div>
                <div style={{fontSize:11.5,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",marginBottom:10}}>Documentation for this topic</div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {links.map(r=>(
                    <a key={r.label} href={r.url} target="_blank" rel="noreferrer"
                      style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",background:r.primary?P.blueGh:P.surface,border:`1px solid ${r.primary?P.blue+"35":P.border}`,borderRadius:10,textDecoration:"none"}}>
                      <Ic as={r.icon} size={16} color={r.primary?P.blue:P.muted}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:600,color:P.blue,marginBottom:1}}>{r.label}</div>
                        <div style={{fontSize:11.5,color:P.muted}}>{r.desc}</div>
                      </div>
                      <span style={{fontSize:12,color:P.muted,flexShrink:0}}>↗</span>
                    </a>
                  ))}
                </div>
                <div style={{fontSize:11,color:P.dim,marginTop:12,lineHeight:1.6}}>The full lesson text is on the <strong>Lesson</strong> tab. These links open the original Adobe documentation this lesson is based on.</div>
              </div>
            );
          })()}

        </div>

        {/* Right: mini AI agent */}
        <div style={{width:260,flexShrink:0,display:"flex",flexDirection:"column"}}>
          <div style={{padding:"10px 12px",borderBottom:`1px solid ${P.border}`,fontSize:12,fontWeight:600,color:P.txt,flexShrink:0}}>Ask about this topic</div>
          <div ref={chatRef} style={{flex:1,overflowY:"auto",padding:"12px",display:"flex",flexDirection:"column",gap:10}}>
            {msgs.map((m,i)=>(
              <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                <div style={{maxWidth:"90%",padding:"7px 11px",borderRadius:m.role==="user"?"10px 10px 3px 10px":"10px 10px 10px 3px",background:m.role==="user"?P.blue:P.surface,color:m.role==="user"?"#fff":P.txt,fontSize:12.5,lineHeight:1.6,border:m.role==="assistant"?`1px solid ${P.border}`:"none"}}>{m.content}</div>
              </div>
            ))}
            {busy&&<div style={{background:P.surface,border:`1px solid ${P.border}`,borderRadius:"10px 10px 10px 3px",padding:"7px 11px",fontSize:12.5,color:P.muted}}>···</div>}
          </div>
          <div style={{padding:"8px 10px",borderTop:`1px solid ${P.border}`,display:"flex",gap:6,flexShrink:0}}>
            <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendMsg()}
              placeholder="Ask anything…"
              style={{flex:1,border:`1px solid ${P.border}`,borderRadius:7,padding:"6px 10px",fontSize:12.5,outline:"none",background:P.bg,color:P.txt}}/>
            <Btn onClick={sendMsg} disabled={busy} size="sm"><Ic as={ChevronRight} size={14} color="currentColor"/></Btn>
          </div>
        </div>
      </div>}
    </div>
  );
}

// ── Learning Path View — 3 sub-tabs ──────────────────────────────────────────
// ── Module test-out — full-screen adaptive quiz (reuses the SAME CAT engine as
// the internal Module Quiz, in "optout" mode: same sequencing, question count,
// timer, and confidence gating — only the pass threshold differs, 90% per
// TESTOUT_PASS_THRESHOLD). Opens as its own full-viewport view (like Read Lesson
// / Study Materials), not a cramped modal, and the backend records the result +
// unlocks the module on a pass. `onPass(moduleId)` updates the caller's local
// tested-out state.
function TestOutModal({module,track,profile,groqKey,onClose,onPass}){
  const handleFinish=(result)=>{
    // Backend optout mode already persisted the result + module_test_outs row;
    // just reflect a pass in the caller's UI. (score_pct comes from the engine.)
    if(result&&result.passed)onPass(module.id);
  };
  return(
    <div style={{position:"fixed",inset:0,background:P.bg,zIndex:1000,display:"flex",flexDirection:"column",fontFamily:"'adobe-clean','Source Sans 3',system-ui,sans-serif"}}>
      <div style={{background:P.panel,width:"100%",height:"100%",display:"flex",flexDirection:"column",flex:1,minHeight:0}}>
        {/* Top app bar */}
        <div style={{padding:"12px 24px",borderBottom:`1px solid ${P.border}`,display:"flex",alignItems:"center",gap:16,flexShrink:0}}>
          <button onClick={onClose} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"7px 14px",fontSize:12.5,fontWeight:600,cursor:"pointer",color:P.txt,fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:6,flexShrink:0}}>
            <Ic as={ChevronLeft} size={14} color="currentColor"/> Back to modules
          </button>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:11,fontWeight:600,color:P.blue,letterSpacing:.5,textTransform:"uppercase",marginBottom:2}}>Test out · {track?.toUpperCase()}</div>
            <div style={{fontSize:16,fontWeight:600,color:P.txt,letterSpacing:-.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{module.title} — pass at 90% to skip</div>
          </div>
        </div>
        {/* Adaptive quiz — same engine as the internal Module Quiz, optout mode */}
        <div style={{flex:1,overflowY:"auto",padding:"20px",maxWidth:760,width:"100%",margin:"0 auto",boxSizing:"border-box"}}>
          <SeqQuiz topicTitle={module.title} moduleTitle={module.title} track={track}
            groqKey={groqKey} userId={profile?.id||profile?.name||""}
            mode="optout" autoStart={true} onFinish={handleFinish}/>
        </div>
      </div>
    </div>
  );
}

// Derives real per-user module status (done/active/locked) from a list of completed
// module ids, instead of relying on the static MODULES array's hardcoded status.
// Falls back to the static status untouched when no real progress exists yet
// (demo personas with no p.id keep their original static behaviour).
// ── AdobeDocs markdown → HTML renderer ─────────────────────────────────────────
// Handles the Adobe-specific extensions that plain markdown renderers choke on:
// admonition blocks (>[!NOTE]/[!ADOBE]/etc — any tag, not just a fixed list),
// multi-line blockquotes merged into one block, +++ collapsible asides,
// raw HTML <img>/<video> embeds, and real markdown tables.
function renderAdobeMarkdown(raw){
  if(!raw)return"";

  // ── Pre-processing: strip/convert technical artifacts ─────────────────
  let t=raw
    .replace(/^---[\s\S]*?---\n?/,"")          // YAML frontmatter
    .replace(/<!--[\s\S]*?-->/g,"")              // HTML comments
    .replace(/<img[^>]*>/gi,"")                    // raw <img> tags
    .replace(/<\/?video[^>]*>/gi,"").replace(/<source[^>]*>/gi,"")
    .replace(/<\/?div[^>]*>/gi,"").replace(/<\/?span[^>]*>/gi,"")
    .replace(/<\/?section[^>]*>/gi,"").replace(/<\/?article[^>]*>/gi,"")
    .replace(/\{#[^}]+\}/g,"")                   // heading anchors {#some-id}
    .replace(/\{[^}]*(zone|target|width|zoomable|align|class|style)[^}]*\}/g,"")
    // Relative images → strip; absolute images → inline <img>
    .replace(/!\[([^\]]*)\]\(((?!https?:\/\/)([^)]+))\)/g,"")
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g,'<img src="$2" alt="$1">')
    // AdobeDocs data-table metadata lines: id="..." title="..." abstract/description="..."
    // Group them: if a line is purely an attribute assignment, capture title+abstract as a def entry
    .replace(/^id="[^"]*"\s*$/gm,"")             // strip bare id lines
    // Convert title+abstract pairs into definition markup
    .replace(/^title="([^"]+)"\s*\nabstract="([^"]+)"/gm,
      '<div class="el-def"><dt>$1</dt><dd>$2</dd></div>')
    .replace(/^name="([^"]+)"\s*\ndescription="([^"]+)"/gm,
      '<div class="el-def"><dt>$1</dt><dd>$2</dd></div>')
    // Catch any remaining lone title/abstract/name/description attribute lines
    .replace(/^(?:title|abstract|name|description|label)="[^"]*"\s*$/gm,"")
    .replace(/^(?:id|type|format|required|enum)="[^"]*"\s*$/gm,"");

  // ── Inline formatter ──────────────────────────────────────────────────
  const inline=(s)=>s
    .replace(/\*{3}([^*]+)\*{3}/g,'<strong><em>$1</em></strong>')
    .replace(/\*{2}([^*]+)\*{2}/g,'<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g,'<em>$1</em>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\[\!DNL\s([^\]]+)\]/g,'$1')
    .replace(/\[\!BADGE\s([^\]]+)\]/g,'<span class="el-badge">$1</span>')
    .replace(/\[\!UICONTROL\s([^\]]+)\]/g,'<strong class="el-ui">$1</strong>')
    .replace(/\[\!IMPORTANT\]/g,'')
    .replace(/\[\!NOTE\]/g,'')
    .replace(/\[\!TIP\]/g,'')
    .replace(/\[\!WARNING\]/g,'')
    .replace(/\[\!CAUTION\]/g,'');

  const lines=t.split('\n');
  const html=[];
  let inList=false,inOl=false,inCode=false,codeBuf=[];
  let i=0;
  while(i<lines.length){
    const l=lines[i];

    // Fenced code blocks
    if(l.trim().startsWith('```')){
      if(inCode){html.push('<pre><code>'+codeBuf.join('\n').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</code></pre>');codeBuf=[];inCode=false;}
      else inCode=true;
      i++;continue;
    }
    if(inCode){codeBuf.push(l);i++;continue;}

    // +++ collapsible asides — strip the markers, keep the title bold
    if(l.trim().match(/^\+{3,}/)){
      const title=l.trim().replace(/^\+{3,}\s*/,'');
      if(title)html.push('<p><strong>'+inline(title)+'</strong></p>');
      i++;continue;
    }

    // Markdown tables: header row, then a |---|---| separator row
    if(l.trim().startsWith('|')&&lines[i+1]&&/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i+1])&&lines[i+1].includes('-')){
      const splitRow=(row)=>row.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
      const headerCells=splitRow(l);
      let r=i+2;
      const bodyRows=[];
      while(r<lines.length&&lines[r].trim().startsWith('|')){bodyRows.push(splitRow(lines[r]));r++;}
      html.push('<table><thead><tr>'+headerCells.map(c=>'<th>'+inline(c)+'</th>').join('')+'</tr></thead><tbody>'+
        bodyRows.map(row=>'<tr>'+row.map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table>');
      i=r;continue;
    }

    // Admonition blocks: >[!NOTE/TIP/IMPORTANT/WARNING/CAUTION/BEGINNER/ADMIN]
    if(/^>\s*\[!\w+\]/i.test(l.trim())){
      const tag=l.trim().match(/\[!(\w+)\]/i)?.[1]?.toLowerCase()||'note';
      const noteClass=tag==='warning'||tag==='caution'?'el-warn':tag==='tip'?'el-tip':tag==='important'?'el-important':'el-note';
      const label={'note':'Note','tip':'Tip','warning':'Warning','caution':'Caution','important':'Important','beginner':'Beginner','admin':'Admin'}[tag]||tag;
      i++;
      const body=[];
      while(i<lines.length&&lines[i].trim().startsWith('>')){
        const content=lines[i].replace(/^\s*>\s?/,'');
        if(content.trim())body.push(inline(content));
        i++;
      }
      if(body.length)html.push(`<div class="${noteClass}"><strong>${label}:</strong> ${body.join(' ')}</div>`);
      continue;
    }

    // Plain blockquote
    if(l.trim().startsWith('>')){
      const body=[];
      while(i<lines.length&&lines[i].trim().startsWith('>')){
        const content=lines[i].replace(/^\s*>\s?/,'');
        if(content.trim())body.push(inline(content));
        i++;
      }
      if(body.length)html.push('<blockquote class="el-quote">'+body.join('<br/>')+'</blockquote>');
      continue;
    }

    // Pre-rendered def entries from metadata preprocessing
    if(l.trim().startsWith('<div class="el-def">')){
      html.push(l.trim());i++;continue;
    }
    // Pre-rendered images
    if(l.trim().startsWith('<img ')){
      html.push('<div class="el-img-wrap">'+l.trim()+'</div>');i++;continue;
    }

    if(!l.match(/^[\*\-]\s/)&&inList){html.push('</ul>');inList=false;}
    if(!l.match(/^\d+\.\s/)&&inOl){html.push('</ol>');inOl=false;}
    if(!l.trim()){if(html[html.length-1]!=='')html.push('');i++;continue;}

    if(l.startsWith('#### ')){html.push('<h4>'+inline(l.slice(5))+'</h4>');i++;continue;}
    if(l.startsWith('### ')){html.push('<h3>'+inline(l.slice(4))+'</h3>');i++;continue;}
    if(l.startsWith('## ')){html.push('<h2>'+inline(l.slice(3))+'</h2>');i++;continue;}
    if(l.startsWith('# ')){html.push('<h1>'+inline(l.slice(2))+'</h1>');i++;continue;}
    if(l.match(/^[\*\-]\s+/)){if(!inList){html.push('<ul>');inList=true;}html.push('<li>'+inline(l.replace(/^[\*\-]\s+/,''))+'</li>');i++;continue;}
    if(l.match(/^\d+\.\s+/)){if(!inOl){html.push('<ol>');inOl=true;}html.push('<li>'+inline(l.replace(/^\d+\.\s+/,''))+'</li>');i++;continue;}
    if(l.match(/^[-*]{3,}$/)){html.push('<hr/>');i++;continue;}

    const p=inline(l);
    if(p.trim())html.push('<p>'+p+'</p>');
    i++;
  }
  if(inList)html.push('</ul>');
  if(inOl)html.push('</ol>');
  if(inCode)html.push('<pre><code>'+codeBuf.join('\n')+'</code></pre>');
  return html.join('');
}

// ── AINotesView — structured study notes generated from doc content ─────────
function AINotesView({topicTitle,moduleTitle,docContent,groqKey}){
  const [state,setState]=useState("idle"); // idle|loading|done|error
  const [notes,setNotes]=useState(null);
  const [cached,setCached]=useState({}); // topicTitle → notes

  const generate=async()=>{
    if(cached[topicTitle]){setNotes(cached[topicTitle]);setState("done");return;}
    setState("loading");
    const docText=docContent?.content
      ? docContent.content.replace(/<[^>]+>/g," ").replace(/\s+/g," ").slice(0,3000)
      : "";
    const sys=`You are a learning coach converting AEP product documentation into structured study notes.
Topic: "${topicTitle}" (Module: ${moduleTitle})
Return ONLY valid JSON matching this exact schema:
{
  "summary": "3-sentence executive summary of what this topic covers and why it matters",
  "concepts": [{"title":"...","explanation":"...","example":"..."}],
  "terms": [{"term":"...","definition":"..."}],
  "steps": [{"n":1,"title":"...","detail":"..."}],
  "warnings": ["..."],
  "takeaways": ["Exam/interview key point..."]
}
Rules: 3-5 concepts, 4-8 terms, only include steps if the topic is procedural, 1-3 warnings, 3-5 takeaways. No markdown in the values. Write for a learner, not a developer.`;
    try{
      const r=await fetch(`${BACKEND}/api/notes/generate`,{
        method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({topic:topicTitle,module:moduleTitle,doc_content:docText,track:"rtcdp"})
      });
      const d=await r.json();
      if(!d.ok)throw new Error(d.error||"Notes generation failed");
      setCached(prev=>({...prev,[topicTitle]:d.notes}));
      setNotes(d.notes);
      setState("done");
    }catch(e){setState("error");}
  };

  if(state==="idle")return(
    <div style={{padding:"32px 24px",display:"flex",flexDirection:"column",alignItems:"center",gap:16,textAlign:"center"}}>
      <div style={{width:56,height:56,borderRadius:16,background:"linear-gradient(135deg,#FF5A3D,#EB1000)",display:"flex",alignItems:"center",justifyContent:"center"}}><Ic as={StickyNote} size={26} color="#fff"/></div>
      <div>
        <div style={{fontSize:16,fontWeight:500,color:P.txt,marginBottom:6}}>AI Study Notes</div>
        <div style={{fontSize:13,color:P.muted,maxWidth:360,lineHeight:1.7}}>Generate learning-oriented notes for <strong>{topicTitle}</strong> — key concepts, terminology, step-by-step guides, common mistakes, and exam takeaways.</div>
      </div>
      <Btn onClick={generate}>Generate notes <Ic as={ChevronRight} size={15} color="#fff"/></Btn>
    </div>
  );

  if(state==="loading")return(
    <div style={{padding:"40px 24px",textAlign:"center",color:P.muted}}>
      <div style={{marginBottom:12,display:"flex",justifyContent:"center"}}><Ic as={StickyNote} size={24} color={P.muted}/></div>
      <div style={{fontSize:14,fontWeight:600,color:P.txt,marginBottom:6}}>Generating your study notes…</div>
      <div style={{fontSize:12.5,color:P.muted}}>Distilling documentation into learning-focused content</div>
    </div>
  );

  if(state==="error")return(
    <div style={{padding:"32px 24px",textAlign:"center"}}>
      <div style={{fontSize:13,color:P.red,marginBottom:12}}>Couldn't generate notes — check that the backend is running and GROQ_API_KEY is set in .env</div>
      <Btn size="sm" onClick={()=>setState("idle")}>Retry</Btn>
    </div>
  );

  // ── Rendered notes ─────────────────────────────────────────────────────
  return(
    <div style={{padding:"18px 0",display:"flex",flexDirection:"column",gap:16}}>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:11,fontWeight:600,color:P.purple,letterSpacing:.5,textTransform:"uppercase",marginBottom:3}}>AI Study Notes</div>
          <div style={{fontSize:16,fontWeight:500,color:P.txt}}>{topicTitle}</div>
        </div>
        <button onClick={()=>setState("idle")} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:7,padding:"5px 12px",fontSize:11.5,color:P.muted,cursor:"pointer",fontFamily:"inherit"}}>Regenerate</button>
      </div>

      {/* Executive summary */}
      {notes.summary&&(
        <div style={{background:`linear-gradient(135deg,${P.purpleBg},${P.blueGh})`,border:`1px solid ${P.purple}20`,borderRadius:12,padding:"16px 18px"}}>
          <div style={{fontSize:11,fontWeight:600,color:P.purple,letterSpacing:.5,textTransform:"uppercase",marginBottom:8}}>Summary</div>
          <div style={{fontSize:13.5,color:P.txt,lineHeight:1.75}}>{notes.summary}</div>
        </div>
      )}

      {/* Key concepts */}
      {notes.concepts?.length>0&&(
        <div>
          <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",marginBottom:10}}>Key concepts</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {notes.concepts.map((c,i)=>(
              <div key={i} style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:10,padding:"13px 16px"}}>
                <div style={{fontSize:13.5,fontWeight:500,color:P.blue,marginBottom:5}}>{c.title}</div>
                <div style={{fontSize:13,color:P.txt,lineHeight:1.65,marginBottom:c.example?6:0}}>{c.explanation}</div>
                {c.example&&<div style={{fontSize:12,color:P.muted,background:P.surface,borderRadius:6,padding:"6px 10px",borderLeft:`3px solid ${P.blue}`,marginTop:6}}>Example: {c.example}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Terminology */}
      {notes.terms?.length>0&&(
        <div>
          <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",marginBottom:10}}>Terminology</div>
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:10,overflow:"hidden"}}>
            {notes.terms.map((t,i)=>(
              <div key={i} style={{display:"flex",gap:0,borderBottom:i<notes.terms.length-1?`1px solid ${P.bfaint}`:"none"}}>
                <div style={{width:160,flexShrink:0,padding:"10px 14px",background:P.surface,borderRight:`1px solid ${P.bfaint}`,fontWeight:500,fontSize:12.5,color:P.txt,wordBreak:"break-word"}}>{t.term}</div>
                <div style={{flex:1,padding:"10px 14px",fontSize:12.5,color:P.muted,lineHeight:1.6}}>{t.definition}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Steps (only if procedural topic) */}
      {notes.steps?.length>0&&(
        <div>
          <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",marginBottom:10}}>Step-by-step</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {notes.steps.map((s,i)=>(
              <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:P.blue,color:"#fff",fontWeight:500,fontSize:12,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>{s.n||i+1}</div>
                <div style={{flex:1,background:P.panel,border:`1px solid ${P.border}`,borderRadius:8,padding:"10px 14px"}}>
                  <div style={{fontSize:13,fontWeight:600,color:P.txt,marginBottom:3}}>{s.title}</div>
                  <div style={{fontSize:12.5,color:P.muted,lineHeight:1.6}}>{s.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Warnings / common mistakes */}
      {notes.warnings?.length>0&&(
        <div style={{background:P.amberBg,border:`1px solid ${P.amber}30`,borderRadius:10,padding:"14px 16px"}}>
          <div style={{fontSize:11,fontWeight:600,color:P.amber,letterSpacing:.5,textTransform:"uppercase",marginBottom:8}}>⚠ Common mistakes</div>
          <ul style={{margin:0,paddingLeft:18,display:"flex",flexDirection:"column",gap:6}}>
            {notes.warnings.map((w,i)=><li key={i} style={{fontSize:13,color:P.txt,lineHeight:1.6}}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* Takeaways */}
      {notes.takeaways?.length>0&&(
        <div style={{background:`linear-gradient(135deg,${P.grnBg},${P.blueGh})`,border:`1px solid ${P.grn}25`,borderRadius:10,padding:"14px 16px"}}>
          <div style={{fontSize:11,fontWeight:600,color:P.grn,letterSpacing:.5,textTransform:"uppercase",marginBottom:8}}>🎯 Exam / interview takeaways</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {notes.takeaways.map((tk,i)=>(
              <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                <span style={{color:P.grn,fontWeight:500,flexShrink:0,fontSize:13}}>✓</span>
                <span style={{fontSize:13,color:P.txt,lineHeight:1.6}}>{tk}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── SeqQuiz — Sequential CAT quiz: one question at a time, 20-min timer, adaptive difficulty ──
// Backend: /api/curriculum/quiz/start → /quiz/answer → /quiz/{id}/next → /quiz/finish
// Fallback: Groq direct if backend unavailable
function SeqQuiz({topicTitle,moduleTitle,track="rtcdp",groqKey,userId="",onConfUpdate,mode="path",autoStart=false,onFinish=null}){
  const [phase,setPhase]=useState("idle"); // idle|loading|active|feedback|result|error
  const [session,setSession]=useState(null);
  const [question,setQuestion]=useState(null);
  const [selected,setSelected]=useState(null);
  const [feedback,setFeedback]=useState(null);
  const [timer,setTimer]=useState(1200);
  const [result,setResult]=useState(null);
  const [errMsg,setErrMsg]=useState("");
  const [busy,setBusy]=useState(false);
  // Local fallback
  const [localQs,setLocalQs]=useState([]);
  const [localIdx,setLocalIdx]=useState(0);
  const [localRight,setLocalRight]=useState(0);
  const [isLocal,setIsLocal]=useState(false);
  const timerRef=useRef(null);
  useEffect(()=>()=>{if(timerRef.current)clearInterval(timerRef.current);},[]);
  // Optionally kick off immediately (used by the full-screen Test-Out view so the
  // learner lands straight in the adaptive quiz instead of an extra "Start" click).
  const startedRef=useRef(false);
  useEffect(()=>{if(autoStart&&!startedRef.current){startedRef.current=true;doStart();}},[autoStart]);// eslint-disable-line

  const stopTimer=()=>{if(timerRef.current)clearInterval(timerRef.current);};
  const startTimer=(secs=1200)=>{
    setTimer(secs); stopTimer();
    timerRef.current=setInterval(()=>setTimer(t=>{
      if(t<=1){clearInterval(timerRef.current);doFinish(true);return 0;}
      return t-1;
    }),1000);
  };
  const fmt=(t)=>`${Math.floor(t/60)}:${String(t%60).padStart(2,"0")}`;
  const tc=(t)=>t<120?"#e34850":t<300?"#e68619":"#666";
  const dc=(d)=>d==="hard"?"#e34850":d==="easy"?"#12805c":"#1473E6";
  const dbg=(d)=>d==="hard"?"#fef2f2":d==="easy"?"#ebf9f4":"#eef2ff";

  const doStart=async()=>{
    setPhase("loading");setErrMsg("");setIsLocal(false);
    // Real reason the backend failed (if it responded at all) — shown instead
    // of a generic "no Groq key set" message, which was misleading: it fired
    // on ANY backend failure (e.g. Groq rate-limited), not just a missing key.
    let backendErrMsg=null;
    try{
      const r=await fetch(`${BACKEND}/api/curriculum/quiz/start`,{
        method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({user_name:String(userId||"learner"),track:track||"rtcdp",
          module_title:moduleTitle||"",topic:topicTitle||moduleTitle||"",mode:mode||"path",confidence:0.5})
      });
      if(r.ok){const d=await r.json();
        if(d.ok&&d.question){
          setSession(d);setQuestion(d.question);setSelected(null);setFeedback(null);
          startTimer(d.constraints?.timer_seconds||1200);setPhase("active");return;
        }
        backendErrMsg=d.error||null;
      }
    }catch(_){}
    // Fallback: client-side generation using a learner's OWN key set in Settings
    // (optional; the server normally handles generation via OpenAI). We only reach
    // here if the backend quiz endpoint failed, so surface the real backend reason.
    if(!groqKey){setErrMsg(backendErrMsg||"Couldn't reach the quiz service. Please make sure the backend is running and try again.");setPhase("error");return;}
    setIsLocal(true);
    try{
      const sys=`Generate exactly 10 multiple-choice questions about: "${topicTitle||moduleTitle}".
Return ONLY valid JSON (no markdown, no extra text):
{"questions":[{"question":"...","options":["A. ...","B. ...","C. ...","D. ..."],"correct":"A","difficulty":"easy|medium|hard","explanation":"1 sentence why"}]}
Mix: 2 easy, 5 medium, 3 hard. Use real Adobe AEP / ${track?.toUpperCase()||"RTCDP"} concepts. Keep each question under 25 words. Keep each explanation under 20 words.`;
      const gr=await fetch("https://api.groq.com/openai/v1/chat/completions",{
        method:"POST",
        headers:{"Authorization":`Bearer ${groqKey}`,"Content-Type":"application/json"},
        body:JSON.stringify({model:"openai/gpt-oss-20b",max_tokens:4000,include_reasoning:false,
          messages:[{role:"system",content:sys},{role:"user",content:`Quiz on: ${topicTitle||moduleTitle}`}]})
      });
      const gd=await gr.json();
      const raw=(gd.choices?.[0]?.message?.content||"").replace(/```json|```/g,"").trim();
      const parsed=JSON.parse(raw);
      const qs=(parsed.questions||[]).map((q,i)=>({
        id:i,question:q.question,options:q.options||[],
        ans:["A","B","C","D"].indexOf((q.correct||"A").toUpperCase().charAt(0)),
        difficulty:q.difficulty||"medium",explanation:q.explanation||"",
      })).filter(q=>q.question&&q.options.length>=2);
      if(!qs.length)throw new Error("No questions");
      setLocalQs(qs);setLocalIdx(0);setLocalRight(0);
      setQuestion({id:0,question:qs[0].question,options:qs[0].options,
        difficulty:qs[0].difficulty,position:1,of_max:qs.length});
      setSelected(null);setFeedback(null);startTimer(1200);setPhase("active");
    }catch(e){setErrMsg(backendErrMsg||("Could not generate questions: "+e.message));setPhase("error");}
  };

  const doSubmit=async()=>{
    if(selected===null||busy)return;setBusy(true);
    if(isLocal){
      const q=localQs[localIdx];
      const ok=selected===q.ans;
      setFeedback({is_correct:ok,correct_index:q.ans,explanation:q.explanation||""});
      if(ok)setLocalRight(r=>r+1);
      setPhase("feedback");setBusy(false);return;
    }
    try{
      const r=await fetch(`${BACKEND}/api/curriculum/quiz/answer`,{
        method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({session_id:session.session_id,question_id:question.id,given_index:selected})
      });
      if(r.ok){const d=await r.json();
        setFeedback({is_correct:d.is_correct,correct_index:d.correct_index,explanation:d.explanation||""});
        setPhase("feedback");
      }
    }catch(e){setErrMsg("Submit error: "+e.message);}
    setBusy(false);
  };

  const doNext=async()=>{
    setBusy(true);
    if(isLocal){
      const ni=localIdx+1;
      if(ni>=localQs.length){doFinish();setBusy(false);return;}
      setLocalIdx(ni);
      const q=localQs[ni];
      setQuestion({id:ni,question:q.question,options:q.options,
        difficulty:q.difficulty,position:ni+1,of_max:localQs.length});
      setSelected(null);setFeedback(null);setPhase("active");setBusy(false);return;
    }
    try{
      const r=await fetch(`${BACKEND}/api/curriculum/quiz/${session.session_id}/next`,{credentials:"include"});
      if(r.ok){const d=await r.json();
        if(d.done||!d.question){doFinish();}
        else{setQuestion(d.question);setSelected(null);setFeedback(null);setPhase("active");}
      }
    }catch(e){setErrMsg("Next error: "+e.message);setPhase("error");}
    setBusy(false);
  };

  const doFinish=async(timeout=false)=>{
    stopTimer();setPhase("loading");
    if(isLocal){
      const total=localQs.length;const correct=localRight;
      const pct=total>0?Math.round(correct/total*100):0;
      const conf=parseFloat(Math.min(0.95,0.3+(pct/100)*0.65).toFixed(2));
      const passed=conf>=0.60;   // spec: 60% confidence to pass
      const localResult={ok:true,score_pct:pct,confidence:conf,num_correct:correct,
        num_questions:total,threshold:0.60,passed,module_unlocked:false,
        nba:{weak_areas:pct<60?[topicTitle||moduleTitle]:[],next_module:""}};
      setResult(localResult);
      setPhase("result");if(onConfUpdate)onConfUpdate(passed?0.05:-0.02);
      if(onFinish)onFinish(localResult);return;
    }
    try{
      const r=await fetch(`${BACKEND}/api/curriculum/quiz/finish`,{
        method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({session_id:session?.session_id||"",manager:""})
      });
      if(r.ok){const d=await r.json();
        setResult(d);setPhase("result");
        if(onConfUpdate)onConfUpdate(d.passed?0.05:-0.02);
        if(onFinish)onFinish(d);
      }
    }catch(e){setErrMsg("Finish error: "+e.message);setPhase("error");}
  };

  const reset=()=>{
    stopTimer();setPhase("idle");setSession(null);setQuestion(null);
    setSelected(null);setFeedback(null);setTimer(1200);setResult(null);setErrMsg("");
    setLocalQs([]);setLocalIdx(0);setLocalRight(0);setIsLocal(false);
  };

  // ── IDLE ──
  const isOptout=mode==="optout";
  if(phase==="idle")return(
    <div style={{marginTop:20,padding:"18px 20px",background:P.surface,border:`1px solid ${P.border}`,borderRadius:12}}>
      <div style={{fontSize:14,fontWeight:600,color:P.txt,marginBottom:3}}>{isOptout?"Test-Out Quiz":"Module Quiz"}</div>
      <div style={{fontSize:12,color:P.muted,marginBottom:14,lineHeight:1.6}}>
        {isOptout
          ?<>One question at a time · 20-minute timer · Pass at 90% to skip this module<br/>Difficulty adapts to your answers (CAT — Computerized Adaptive Testing)</>
          :<>One question at a time · 20-minute timer · Pass at 60% confidence · max 3 attempts<br/>Difficulty adapts to your answers (CAT — Computerized Adaptive Testing)</>}
      </div>
      <Btn size="sm" onClick={doStart}>{isOptout?"Start Test-Out":"Start Quiz"} <Ic as={ChevronRight} size={13} color="currentColor"/></Btn>
    </div>
  );

  // ── LOADING ──
  if(phase==="loading")return(
    <div style={{marginTop:20,padding:"20px",background:P.surface,border:`1px solid ${P.border}`,borderRadius:12,textAlign:"center",color:P.muted,fontSize:13}}>
      {result?"Finishing…":"Generating questions…"}
    </div>
  );

  // ── ERROR ──
  if(phase==="error")return(
    <div style={{marginTop:20,padding:"16px 18px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:12}}>
      <div style={{fontSize:13,color:"#b91c1c",marginBottom:10}}>⚠ {errMsg||"Quiz failed."}</div>
      <Btn size="sm" onClick={reset}>Try again</Btn>
    </div>
  );

  // ── RESULT ──
  if(phase==="result"&&result){
    const passed=result.passed;
    const weak=result.nba?.weak_areas||[];
    const conf=Math.round((result.confidence||0)*100);
    const sc=result.score_pct>=90?"#12805c":result.score_pct>=60?"#1473E6":"#e34850";
    return(
      <div style={{marginTop:20,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden"}}>
        <div style={{padding:"16px 20px",background:passed?"#ebf9f4":"#fef2f2",borderBottom:`1px solid ${P.border}`}}>
          <div style={{fontSize:15,fontWeight:700,color:passed?"#12805c":"#e34850"}}>{passed?"✅ Passed":"❌ Review needed"}</div>
          <div style={{fontSize:12.5,color:P.muted,marginTop:2}}>
            {result.num_correct}/{result.num_questions} correct · {result.score_pct}% raw · {conf}% confidence
            {result.threshold?` · threshold ${Math.round(result.threshold*100)}%`:""}
          </div>
        </div>
        <div style={{padding:"14px 20px",borderBottom:`1px solid ${P.border}`}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11.5,color:P.muted,marginBottom:5}}>
            <span>Confidence</span><span style={{color:sc,fontWeight:700}}>{conf}%</span>
          </div>
          <div style={{height:8,background:P.border,borderRadius:99,position:"relative"}}>
            <div style={{height:"100%",width:`${conf}%`,background:sc,borderRadius:99,transition:"width .5s"}}/>
            <div style={{position:"absolute",left:"60%",top:0,width:2,height:"100%",background:"#2c2c2c",opacity:.5}}/>
          </div>
          <div style={{fontSize:10.5,color:P.muted,marginTop:3}}>Pass threshold: 60% confidence</div>
        </div>
        {weak.length>0&&<div style={{padding:"10px 20px",borderBottom:`1px solid ${P.border}`}}>
          <div style={{fontSize:11,fontWeight:700,color:P.muted,marginBottom:5}}>AREAS TO REVIEW</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
            {weak.map((w,i)=><span key={i} style={{padding:"2px 9px",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:99,fontSize:11.5,color:"#e34850"}}>{w}</span>)}
          </div>
        </div>}
        <div style={{padding:"12px 20px",display:"flex",alignItems:"center",gap:10}}>
          <div style={{flex:1,fontSize:12.5,color:P.muted}}>
            {passed
              ?(result.nba?.next_module?`Next: ${result.nba.next_module}`:"Great work!")
              :(result.attempts_remaining>0
                ?`Re-read the lesson and try again — ${result.attempts_remaining} attempt${result.attempts_remaining===1?"":"s"} left.`
                :"Re-read the lesson and study with the AI Tutor — you've used all attempts for this quiz.")}
          </div>
          {(result.attempts_remaining==null||result.attempts_remaining>0)&&
            <button onClick={reset} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"5px 12px",fontSize:12,color:P.muted,cursor:"pointer",fontFamily:"inherit"}}>Retry</button>}
        </div>
      </div>
    );
  }

  // ── ACTIVE / FEEDBACK ──
  if(!question)return null;
  const maxQ=question.of_max||session?.constraints?.max_questions||15;
  const diff=question.difficulty||"medium";
  return(
    <div style={{marginTop:20,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden"}}>
      {/* Top bar */}
      <div style={{padding:"9px 15px",background:P.surface,borderBottom:`1px solid ${P.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:12.5,fontWeight:600,color:P.txt}}>Q {question.position} / {maxQ}</span>
          <span style={{padding:"2px 8px",borderRadius:99,fontSize:11,fontWeight:700,background:dbg(diff),color:dc(diff)}}>{diff}</span>
        </div>
        {/* Timer */}
        <div style={{display:"flex",alignItems:"center",gap:4,fontVariantNumeric:"tabular-nums"}}>
          <Ic as={Clock} size={12} color={tc(timer)}/>
          <span style={{fontSize:13,fontWeight:700,color:tc(timer),fontFamily:"monospace"}}>{fmt(timer)}</span>
        </div>
      </div>

      <div style={{padding:"16px 18px"}}>
        {/* Question */}
        <div style={{fontSize:13.5,fontWeight:500,color:P.txt,lineHeight:1.65,marginBottom:14}}>{question.question}</div>

        {/* Options */}
        <div style={{display:"flex",flexDirection:"column",gap:7}}>
          {(question.options||[]).map((opt,i)=>{
            let bg=P.bg,border=`1px solid ${P.border}`,color=P.txt,fw=400;
            if(phase==="feedback"){
              if(i===feedback?.correct_index){bg="#ebf9f4";border="1px solid #12805c";color="#12805c";fw=600;}
              else if(i===selected&&!feedback?.is_correct){bg="#fef2f2";border="1px solid #e34850";color="#e34850";}
            }else if(selected===i){bg=P.blueGh||"#eef2ff";border=`1px solid ${P.blue||"#1473E6"}`;color=P.blue||"#1473E6";fw=600;}
            return(
              <button key={i} disabled={phase==="feedback"||busy} onClick={()=>setSelected(i)}
                style={{textAlign:"left",padding:"10px 14px",borderRadius:9,fontSize:13,
                  cursor:phase==="feedback"?"default":"pointer",fontFamily:"inherit",
                  background:bg,border,color,fontWeight:fw,transition:"all .12s",lineHeight:1.4}}>
                {opt}
              </button>
            );
          })}
        </div>

        {/* Feedback box */}
        {phase==="feedback"&&feedback&&(
          <div style={{marginTop:12,padding:"10px 14px",borderRadius:9,
            background:feedback.is_correct?"#ebf9f4":"#fef2f2",
            border:`1px solid ${feedback.is_correct?"#12805c":"#e34850"}`}}>
            <div style={{fontSize:12.5,fontWeight:600,color:feedback.is_correct?"#12805c":"#e34850",marginBottom:feedback.explanation?3:0}}>
              {feedback.is_correct?"✓ Correct!":"✗ Incorrect"}
            </div>
            {feedback.explanation&&<div style={{fontSize:12,color:P.txt,lineHeight:1.5}}>{feedback.explanation}</div>}
          </div>
        )}

        {/* Actions */}
        <div style={{marginTop:14,display:"flex",gap:8,alignItems:"center"}}>
          {phase==="active"&&<Btn size="sm" disabled={selected===null||busy} onClick={doSubmit}>Submit answer</Btn>}
          {phase==="feedback"&&<>
            <Btn size="sm" disabled={busy} onClick={doNext}>Next <Ic as={ChevronRight} size={13} color="currentColor"/></Btn>
            <button onClick={()=>doFinish()} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"5px 12px",fontSize:12,color:P.muted,cursor:"pointer",fontFamily:"inherit"}}>Finish early</button>
          </>}
        </div>
      </div>
    </div>
  );
}

function computeEffectiveModules(modules,completedIds){
  let prevDone=true; // module 1 always unlocked by default
  return modules.map(m=>{
    let status;
    if(m.capstone){
      status=completedIds.includes(m.id)?"done":m.status;
    } else if(completedIds.includes(m.id)){
      status="done";
    } else if(prevDone){
      status="active";
    } else {
      status="locked";
    }
    prevDone=status==="done";
    return {...m,status};
  });
}

// ── Game-style learning path — a winding vertical trail of level stepping-stones ──
// Inspired by Duolingo / BYJU's: big round level nodes snaking down a curved road,
// completed = green with a check, current = pulsing "you are here", locked = grey.
// Click a node to open its topics. HTML nodes over one SVG road (no innerHTML).
// ── Remediation card — a targeted catch-up plan when a learner is struggling ──
// Only shows for real signed-in users who have weak areas (failed test-outs or
// low confidence). Sourced from /api/curriculum/remediation — the adaptive
// "if I'm doing badly, give me a path" companion to the Curriculum agent.
function RemediationCard({profile:p,track,modules=[],onOpenLesson=null}){
  const [plan,setPlan]=useState(null);
  useEffect(()=>{
    if(!p?.name||!p?.id){setPlan(null);return;}
    fetch(`${BACKEND}/api/curriculum/remediation?member_name=${encodeURIComponent(p.name)}&track=${track}`)
      .then(r=>r.json()).then(setPlan).catch(()=>setPlan(null));
  },[p?.name,p?.id,track]);
  if(!p?.id||!plan||plan.on_track||!(plan.plan||[]).length)return null;
  const go=tab=>window.dispatchEvent(new CustomEvent("nexus:navigate",{detail:{tab}}));
  const revisit=item=>{const m=modules.find(x=>x.id===item.module_id);if(m&&onOpenLesson)onOpenLesson(m);else go("track");};
  const ACT={revisit:{l:"Revisit lesson",fn:revisit},socratic:{l:"Socratic drill",fn:()=>go("assist")},retest:{l:"Re-take test-out",fn:()=>go("track")}};
  return(
    <div style={{background:P.amberBg,border:`1px solid ${P.amber}55`,borderRadius:14,padding:"16px 18px"}}>
      <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:4}}>
        <span style={{fontSize:18}}>🎯</span>
        <div style={{fontSize:14,fontWeight:600,color:P.txt}}>Your catch-up plan</div>
        <span style={{fontSize:11,fontWeight:600,color:P.amber,background:"#fff",borderRadius:99,padding:"1px 9px",border:`1px solid ${P.amber}55`}}>{plan.weak_count} to review</span>
      </div>
      <div style={{fontSize:12.5,color:P.muted,marginBottom:12}}>We spotted a few weak spots. Here's a focused path to get back on track — hardest first.</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {plan.plan.map((item,i)=>(
          <div key={i} style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:10,padding:"12px 14px"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:3}}>
              <span style={{fontSize:12,fontWeight:600,color:P.dim,width:20,textAlign:"center"}}>{i+1}</span>
              <span style={{fontSize:13.5,fontWeight:600,color:P.txt}}>{item.module_title||`Module ${item.module_id}`}</span>
              <span style={{fontSize:10.5,fontWeight:600,color:item.kind==="failed_testout"?P.red:P.amber,background:(item.kind==="failed_testout"?P.red:P.amber)+"18",borderRadius:99,padding:"1px 8px"}}>{item.kind==="failed_testout"?"Failed test-out":"Low confidence"}</span>
            </div>
            <div style={{fontSize:12,color:P.muted,marginBottom:9,paddingLeft:28}}>{item.reason}</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",paddingLeft:28}}>
              {(item.actions||[]).map(a=>ACT[a]&&(
                <button key={a} onClick={()=>ACT[a].fn(item)} style={{fontSize:12,fontWeight:600,color:"#fff",background:P.blue,border:"none",borderRadius:7,padding:"6px 12px",cursor:"pointer",fontFamily:"inherit"}}>{ACT[a].l}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LearningFlowMap({modules=[],profile=null,demo=false,onOpenLesson=null}){
  // Default the detail panel to the current (active) phase so the view isn't
  // empty — falls back to the first module if nothing is active yet.
  const [sel,setSel]=useState(()=>{const a=modules.findIndex(m=>m.status==="active");return a>=0?a:(modules.length?0:null);});
  const dark=getThemeMode()==="dark";
  const firstName=profile?.name?.split(" ")[0]||"You";
  const n=modules.length;
  // Horizontal winding trail: nodes march left→right, y oscillates. Spacing is
  // responsive to the measured container width so the trail fills the space
  // (centered when there are few phases, horizontally scrollable when many).
  const wrapRef=useRef(null);
  const [cw,setCw]=useState(1000);
  useEffect(()=>{const el=wrapRef.current;if(!el)return;const ro=new ResizeObserver(()=>setCw(el.clientWidth||1000));ro.observe(el);setCw(el.clientWidth||1000);return()=>ro.disconnect();},[]);
  const MX=40,D=84,AMP=84,TOPPAD=72,MIN_STEP=200,MAX_STEP=300;
  const stepFit=n>1?(cw-2*MX-D)/(n-1):0;
  const STEP_X=Math.min(MAX_STEP,Math.max(MIN_STEP,stepFit));
  const MIDY=TOPPAD+AMP+D/2;
  const TOTAL=MX*2+D+(Math.max(1,n)-1)*STEP_X;
  const HEIGHT=MIDY+AMP+D/2+58;
  const DONE="#5aa02a",DONE_D="#437a1e",CUR="#2f7fd6",CUR_D="#215d9e",TODO=dark?"#4a515c":"#c4cad2",TODO_D=dark?"#3a404a":"#aab1ba";
  const pt=i=>({x:MX+D/2+i*STEP_X,y:MIDY+AMP*Math.sin(i*0.9)});
  const icon=m=>{const s=((m.tag||"")+" "+(m.title||"")+" "+(m.theme||"")).toLowerCase();
    if(/capstone|certif/.test(s))return"🏆"; if(/foundation|architect|overview|intro/.test(s))return"🧭";
    if(/ingest|source|connector|collection|dataset/.test(s))return"📥"; if(/identit/.test(s))return"🧩";
    if(/profile|merge/.test(s))return"👤"; if(/segment|audience/.test(s))return"🎯";
    if(/destination|activat/.test(s))return"🚀"; if(/governance|privacy|consent/.test(s))return"🛡️";
    if(/monitor|quality/.test(s))return"📊"; if(/query|distiller/.test(s))return"🔎";
    if(/journey|message|email|campaign/.test(s))return"✉️"; if(/advanced|ai|intelligen/.test(s))return"🤖";
    return"📘";};
  const shortLbl=m=>{const t=(m.title||m.theme||"").split(/[,&:]/)[0].trim();return t.length>22?t.slice(0,21)+"…":t;};
  const smooth=pts=>{ if(pts.length<2)return""; let d=`M ${pts[0].x} ${pts[0].y}`;
    for(let i=1;i<pts.length;i++){const p0=pts[i-1],p1=pts[i],mx=(p0.x+p1.x)/2,my=(p0.y+p1.y)/2;d+=` Q ${p0.x} ${p0.y} ${mx} ${my}`;}
    d+=` L ${pts[n-1>=pts.length?pts.length-1:pts.length-1].x} ${pts[pts.length-1].y}`;return d;};
  const pts=modules.map((_,i)=>pt(i));
  const doneCount=modules.filter(m=>m.status==="done").length;
  const activeIdx=modules.findIndex(m=>m.status==="active");
  const progEnd=activeIdx>=0?activeIdx:doneCount-1;
  const roadAll=smooth(pts);
  const roadDone=progEnd>=1?smooth(pts.slice(0,progEnd+1)):"";
  const selM=sel!=null?modules[sel]:null;
  const col3=m=>m.status==="done"?[DONE,DONE_D]:m.status==="active"?[CUR,CUR_D]:[TODO,TODO_D];
  return(
    <div>
      <style>{`
        @keyframes lfmpop{0%{opacity:0;transform:scale(.3)}70%{transform:scale(1.12)}100%{opacity:1;transform:scale(1)}}
        @keyframes lfmring{0%{transform:scale(.9);opacity:.7}70%{transform:scale(1.5);opacity:0}100%{opacity:0}}
        @keyframes lfmbounce{0%,100%{transform:translate(-50%,0)}50%{transform:translate(-50%,-5px)}}
        @keyframes lfmdash{to{stroke-dashoffset:-26}}
        @keyframes lfmin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
        .lfm-lvl{position:absolute;width:${D}px;height:${D}px;border-radius:50%;display:flex;align-items:center;justify-content:center;
          font-size:30px;cursor:pointer;border:0;transition:transform .18s cubic-bezier(.2,1.5,.3,1);animation:lfmpop .5s cubic-bezier(.2,1.4,.3,1) both;z-index:2}
        .lfm-lvl:hover{transform:translateY(-3px) scale(1.06)}
        .lfm-lvl:active{transform:translateY(1px)}
        .lfm-ring{position:absolute;width:${D}px;height:${D}px;border-radius:50%;border:3px solid ${CUR};animation:lfmring 1.8s ease-out infinite;z-index:1;pointer-events:none}
        .lfm-lbl{position:absolute;text-align:center;font-size:11.5px;font-weight:500;color:${P.txt};width:132px;transform:translateX(-50%);z-index:2;line-height:1.3;pointer-events:none}
        .lfm-sub{font-size:10.5px;color:${P.muted};font-weight:400}
        .lfm-you{position:absolute;transform:translate(-50%,0);background:${CUR};border-radius:99px;padding:4px 12px 4px 4px;
          display:flex;align-items:center;gap:8px;white-space:nowrap;z-index:4;animation:lfmbounce 1.6s ease-in-out infinite;box-shadow:0 4px 12px ${CUR}66}
        .lfm-you:after{content:"";position:absolute;left:50%;bottom:-5px;transform:translateX(-50%);border:6px solid transparent;border-top-color:${CUR};border-bottom:0}
        .lfm-badge{position:absolute;right:-2px;bottom:-2px;width:24px;height:24px;border-radius:50%;background:#fff;
          display:flex;align-items:center;justify-content:center;font-size:13px;box-shadow:0 1px 3px rgba(0,0,0,.25)}
        .lfm-road{stroke-dasharray:2 12;stroke-linecap:round;animation:lfmdash 1s linear infinite}
        .lfm-tp{font-size:13.5px;color:${P.muted};padding:5px 0 5px 18px;position:relative;border-top:1px solid ${P.bfaint};animation:lfmin .3s ease both}
      `}</style>

      {/* header + progress */}
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8,flexWrap:"wrap"}}>
        <div style={{fontSize:17,fontWeight:600,color:P.txt}}>Your journey</div>
        {demo&&<span title="This is illustrative demo progress. Sign in with your Adobe account to see your real completions." style={{fontSize:9.5,fontWeight:700,letterSpacing:.4,color:P.amber,background:P.amberBg,border:`1px solid ${P.amber}40`,borderRadius:4,padding:"1px 6px",textTransform:"uppercase"}}>Sample data</span>}
        <div style={{flex:1,minWidth:120,height:9,background:P.bfaint,borderRadius:99,overflow:"hidden",maxWidth:280}}>
          <div style={{width:`${n?Math.round(doneCount/n*100):0}%`,height:"100%",background:`linear-gradient(90deg,${DONE},#7bc23e)`,borderRadius:99,transition:"width .7s cubic-bezier(.2,1,.3,1)"}}/>
        </div>
        <div style={{fontSize:12.5,color:P.muted,fontWeight:500}}>{doneCount} of {n} complete</div>
      </div>

      {/* the trail — horizontal, scrolls right when there are many phases */}
      <div ref={wrapRef} style={{width:"100%",overflowX:"auto",overflowY:"hidden",paddingBottom:6}}>
      <div style={{position:"relative",width:TOTAL,height:HEIGHT,margin:TOTAL<=cw?"0 auto":0}}>
        <svg viewBox={`0 0 ${TOTAL} ${HEIGHT}`} style={{position:"absolute",inset:0,width:"100%",height:"100%",overflow:"visible"}} xmlns="http://www.w3.org/2000/svg">
          <path d={roadAll} fill="none" stroke={dark?"#3a404a":"#e4e7ec"} strokeWidth="14" strokeLinecap="round"/>
          {roadDone&&<path d={roadDone} fill="none" stroke={DONE} strokeWidth="14" strokeLinecap="round" strokeOpacity="0.9"/>}
          {roadDone&&<path className="lfm-road" d={roadDone} fill="none" stroke="#fff" strokeWidth="3" strokeOpacity="0.7"/>}
        </svg>
        {modules.map((m,i)=>{
          const p=pt(i),[c,cd]=col3(m),isCur=m.status==="active",isDone=m.status==="done",locked=!isCur&&!isDone;
          const lblLeft=p.x, lblTop=p.y+D/2+8, side=Math.sin(i*0.9);
          return(
            <Fragment key={i}>
              {isCur&&<div className="lfm-ring" style={{left:p.x-D/2,top:p.y-D/2}}/>}
              {isCur&&<div className="lfm-you" style={{left:p.x,top:p.y-D/2-52}}>
                <UserAvatarCircle emoji={profile?.avatar_emoji} color={profile?.avatar_color||profile?.color} persona={profile?.persona} alt={firstName} size={30}/>
                <div style={{lineHeight:1.12}}>
                  <div style={{fontSize:9,fontWeight:600,color:"#ffffffcc",letterSpacing:.4}}>YOU ARE HERE</div>
                  <div style={{fontSize:12,fontWeight:600,color:"#fff"}}>{firstName}</div>
                </div>
              </div>}
              <button className="lfm-lvl" onClick={()=>setSel(sel===i?null:i)} title={m.title}
                style={{left:p.x-D/2,top:p.y-D/2,animationDelay:`${i*0.06}s`,
                  background:`radial-gradient(circle at 50% 32%, ${c}, ${cd})`,
                  boxShadow:`0 5px 0 ${cd}, 0 9px 16px rgba(0,0,0,.18)${sel===i?`, 0 0 0 3px ${P.txt}`:""}`,
                  opacity:locked?.82:1,filter:locked?"saturate(.7)":"none"}}>
                <span style={{filter:isDone?"none":"none",lineHeight:1}}>{isDone?"":icon(m)}</span>
                {isDone&&<span style={{position:"absolute",color:"#fff",fontSize:32,fontWeight:700,textShadow:"0 1px 2px rgba(0,0,0,.25)"}}>✓</span>}
                {locked&&<span className="lfm-badge">🔒</span>}
              </button>
              <div className="lfm-lbl" style={{left:lblLeft,top:lblTop}}>
                {shortLbl(m)}<br/><span className="lfm-sub">{m.week?("Week "+m.week):("Module "+m.id)}</span>
              </div>
            </Fragment>
          );
        })}
      </div>
      </div>

      {/* legend + hint */}
      <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap",marginTop:6,paddingTop:12,borderTop:`1px solid ${P.bfaint}`}}>
        {[["Completed",DONE],["Current",CUR],["Locked",TODO]].map(([l,c])=>(
          <span key={l} style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:12,color:P.muted}}>
            <span style={{width:11,height:11,borderRadius:99,background:c}}/>{l}
          </span>
        ))}
        <span style={{flex:1}}/>
        <span style={{fontSize:11.5,color:P.dim}}>Tap any stone to see its topics{n>4?" · scroll → for the full path":""}</span>
      </div>

      {/* detail card */}
      {selM&&<div style={{marginTop:14,background:P.surface,border:`1px solid ${P.border}`,borderRadius:14,padding:"16px 18px",animation:"lfmin .3s ease both"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:3}}>
          <div style={{fontSize:26}}>{selM.status==="done"?"✅":icon(selM)}</div>
          <div style={{fontSize:16,fontWeight:600,color:P.txt}}>{selM.title}</div>
          <span style={{fontSize:11,fontWeight:600,padding:"2px 10px",borderRadius:99,color:"#fff",background:col3(selM)[0]}}>{selM.status==="done"?"Completed":selM.status==="active"?"In progress":"Upcoming"}</span>
        </div>
        <div style={{fontSize:12.5,color:P.muted,marginBottom:10}}>{selM.week?("Week "+selM.week):("Module "+selM.id)}{selM.theme?" · "+selM.theme:""}{selM.topics?" · "+selM.topics.length+" topics":""}</div>
        {(selM.topics||[]).map((t,j)=>(<div key={j} className="lfm-tp" style={{animationDelay:`${j*0.03}s`}}>{t}</div>))}
        {onOpenLesson&&<button onClick={()=>onOpenLesson(selM)} style={{marginTop:14,background:col3(selM)[0],color:"#fff",border:"none",borderRadius:10,padding:"9px 18px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",boxShadow:`0 3px 0 ${col3(selM)[1]}`}}>{selM.status==="done"?"Review module →":selM.status==="active"?"Continue →":"Open module →"}</button>}
      </div>}
    </div>
  );
}

function LearningPathView({profile:p,groqKey,done,studyModule,setStudyModule,expandedModule,setExpandedModule,mobile,track="rtcdp",modules=MODULES,onTestOutPass=null,onConfUpdate=null,onOpenLesson=null}){
  const [sub,setSub]=useState("overview");
  const [testedOutIds,setTestedOutIds]=useState([]); // module ids passed via test-out (>=90%), persisted in DB
  const [testOutModule,setTestOutModule]=useState(null); // module currently being tested out of
  const [completedIds,setCompletedIds]=useState([]); // real per-user completed module ids (from DB)
  const [completing,setCompleting]=useState(false);
  const hasRealProgress=!!p.id; // only registered DB-backed users get dynamic progress; demo personas keep static behaviour

  const loadProgress=()=>{
    if(!p.name)return;
    fetch(`${BACKEND}/api/progress?member_name=${encodeURIComponent(p.name)}&track=${track}`)
      .then(r=>r.json()).then(d=>setCompletedIds(d?.completed||[]))
      .catch(()=>{});
  };
  useEffect(loadProgress,[p.name,track]);

  useEffect(()=>{
    if(!p.name)return;
    fetch(`${BACKEND}/api/test-out?member_name=${encodeURIComponent(p.name)}&track=${track}`)
      .then(r=>r.json()).then(d=>setTestedOutIds((d?.passed_modules||[]).map(m=>m.module_id)))
      .catch(()=>{});
  },[p.name,track]);

  // Effective modules + done count: real progress for registered users, static for demos
  const effectiveModules=hasRealProgress?computeEffectiveModules(modules,completedIds):modules;
  const effectiveDone=hasRealProgress?effectiveModules.filter(m=>m.status==="done").length:done;

  const markModuleComplete=async(moduleId,moduleTitle)=>{
    setCompleting(true);
    try{
      await fetch(`${BACKEND}/api/progress/complete`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({member_name:p.name,manager:p.manager||(p.email?"":"Michael Torres"),track,module_id:moduleId,module_title:moduleTitle})});
      setCompletedIds(prev=>prev.includes(moduleId)?prev:[...prev,moduleId]);
    }catch(e){console.warn("Mark complete failed",e);}
    setCompleting(false);
  };

  const activeModule=effectiveModules.find(m=>m.status==="active")||effectiveModules[effectiveDone]||effectiveModules[0];
  const openLesson=(module)=>module&&onOpenLesson?.(module);
  const nextModule=effectiveModules.find((m,i)=>i>effectiveModules.indexOf(activeModule)&&m.status!=="done");
  const trackContent=getLessonContentForTrack(track);
  const topics=trackContent[activeModule?.id]||[]; // fallback; DB fetch uses track
  const [agentMsgs,setAgentMsgs]=useState([{role:"assistant",content:`Hi ${p.displayName||p.name?.split(" ")[0]||"there"}! I'm your Curriculum Agent. I can help you understand what to study next, explain module objectives, suggest learning strategies, and answer questions about your learning path. What would you like to focus on?`}]);
  const [agentInput,setAgentInput]=useState("");
  const [agentBusy,setAgentBusy]=useState(false);
  const agentRef=useRef(null);
  useEffect(()=>{if(agentRef.current)agentRef.current.scrollTop=agentRef.current.scrollHeight;},[agentMsgs]);

  const sendAgent=async(overrideText)=>{
    const text=(typeof overrideText==="string"?overrideText:agentInput).trim();
    if(!text||agentBusy)return;
    const userText=text;   // used by the client-side AEP-question router in the fallback path
    const msg={role:"user",content:text};
    setAgentMsgs(prev=>[...prev,msg]);
    setAgentInput("");
    setAgentBusy(true);

    try{
      // ── Try backend curriculum guardrail first ─────────────────────────────
      let usedBackend=false;
      try{
        const r=await fetch(`${BACKEND}/api/curriculum/chat`,{
          method:"POST",credentials:"include",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            message:msg.content,
            user_id:p.id||p.email||p.name||"",
            track,
            current_module_id:String(activeModule?.id||""),
            learning_goal:p.role||"",
            confidence:p.conf||0.5,
            modules:(effectiveModules||[]).map(m=>m.title),
            done_modules:(effectiveModules||[]).filter(m=>m.status==="done").map(m=>m.title),
            conf_scores:{},
          }),
        });

        if(r.ok){
          const data=await r.json();
          const result=data?.result||{};

          if(result.kind==="redirect"){
            usedBackend=true;
            // Show the handoff notice
            const notice=result.message||`Routing to ${result.target==="socratic"?"Socratic":"Reasoning"} Agent…`;
            setAgentMsgs(prev=>[...prev,{role:"assistant",content:`🔀 ${notice}`,redirect:true}]);

            // Call the target agent
            const ep=result.target==="socratic"?"/api/agents/socratic":"/api/agents/reasoning";
            const payload=result.payload||{messages:[{role:"user",content:msg.content}]};
            const r2=await fetch(`${BACKEND}${ep}`,{
              method:"POST",credentials:"include",
              headers:{"Content-Type":"application/json"},
              body:JSON.stringify({...payload,track,profile:p}),
            });
            if(r2.ok){
              const d2=await r2.json();
              const reply=d2?.response||d2?.answer||(typeof d2?.result==="string"?d2.result:"")||"";
              const label=result.target==="socratic"?"🎓 Socratic Agent":"🧠 Reasoning Agent";
              if(reply) setAgentMsgs(prev=>[...prev,{role:"assistant",content:`**${label}**\n\n${reply}`}]);
            }
          } else if(result.kind==="answer"&&result.answer){
            usedBackend=true;
            setAgentMsgs(prev=>[...prev,{role:"assistant",content:result.answer}]);
          }
        }
      }catch(_backendErr){
        // backend unreachable — fall through to Groq direct
      }

      // ── Fallback: direct Groq call (always works when key is set) ──────────
      if(!usedBackend){
        // Detect AEP subject/technical questions client-side to route them properly
        const isAEPTechnical = (
          /\b(what is|how does|explain|difference between|what are|define|why does|how do|what happens|when would|how is|tell me about)\b/i.test(userText) &&
          /\b(aep|rtcdp|cdp|cja|ajo|xdm|schema|dataset|segment|audience|batch|streaming|edge|identity|profile|destination|ingestion|activation|namespace|merge policy|datastream|event forwarding|web sdk|mobile sdk|analytics|marketo|campaign|target|b2b|offer decisioning)\b/i.test(userText)
        ) || /\b(explain|tell me about|what is|how does)\b.{0,30}\b(aep|rtcdp|cja|ajo)\b/i.test(userText);

        if(isAEPTechnical){
          setAgentMsgs(prev=>[...prev,{role:"assistant",
            content:"🔀 That's a technical AEP question — routing you to the Reasoning Agent for a full explanation.",
            redirect:true}]);
          try{
            const rr=await fetch(`${BACKEND}/api/agents/reasoning`,{
              method:"POST",credentials:"include",
              headers:{"Content-Type":"application/json"},
              body:JSON.stringify({messages:[{role:"user",content:userText}],track,profile:p})
            });
            if(rr.ok){
              const rd=await rr.json();
              const reply=rd?.response||(typeof rd?.result==="string"?rd.result:"")||rd?.answer||"";
              if(reply) setAgentMsgs(prev=>[...prev,{role:"assistant",content:`🧠 **Reasoning Agent**\n\n${reply}`}]);
            }
          }catch(_){}
        } else {
          // Meta curriculum question — answer directly with Groq + actual module list
          const trackName=TRACK_LABELS[track]||"Real-Time CDP";
          const doneList=(effectiveModules||[]).filter(m=>m.status==="done").map(m=>m.title);
          const pendingList=(effectiveModules||[]).filter(m=>m.status!=="done"&&!m.capstone).map(m=>m.title);
          const doneCount=doneList.length;
          const sys=`You are the Curriculum Agent for Nexus, an AEP learning platform.
Learner: ${p.name} | Track: ${trackName} | Current module: ${activeModule?.title||"—"} | Confidence: ${Math.round((p.conf||0)*100)}%
Progress: ${doneCount}/9 modules complete

COMPLETED MODULES: ${doneList.length?doneList.join(", "):"none yet"}
REMAINING MODULES (in order): ${pendingList.length?pendingList.join(", "):"all done!"}

Answer questions about this specific learning path — what to study next, how to prepare, which modules have video, how long it takes, prerequisites.
ONLY refer to the modules listed above. Never invent module names. Keep your answer under 100 words.`;
          const text=await callAgent([...agentMsgs,msg].map(m=>({role:m.role,content:m.content})),
            sys,groqKey,{agentName:"Curriculum",logFn:null,maxTokens:200});
          setAgentMsgs(prev=>[...prev,{role:"assistant",content:text}]);
        }
      } else if(usedBackend){
        // Backend answered — but if it answered a clearly technical question directly,
        // override and also route to reasoning agent
        const isAEPTechnicalOverride = (
          /\b(what is|how does|explain|difference between)\b/i.test(userText) &&
          /\b(batch|streaming|edge|segment|profile|identity|xdm|rtcdp|ajo|cja)\b/i.test(userText)
        );
        if(isAEPTechnicalOverride){
          setAgentMsgs(prev=>[...prev,{role:"assistant",
            content:"🔀 That's a technical AEP question — routing you to the Reasoning Agent for a full explanation.",
            redirect:true}]);
          try{
            const rr=await fetch(`${BACKEND}/api/agents/reasoning`,{
              method:"POST",credentials:"include",
              headers:{"Content-Type":"application/json"},
              body:JSON.stringify({messages:[{role:"user",content:userText}],track,profile:p})
            });
            if(rr.ok){
              const rd=await rr.json();
              const reply=rd?.response||(typeof rd?.result==="string"?rd.result:"")||rd?.answer||"";
              if(reply) setAgentMsgs(prev=>[...prev,{role:"assistant",content:`🧠 **Reasoning Agent**\n\n${reply}`}]);
            }
          }catch(_){}
          // Remove the curriculum answer that was already added
          setAgentMsgs(prev=>prev.filter((_,i)=>i!==prev.length-1||prev[prev.length-1]?.redirect));
        }
      }
    }catch(e){
      setAgentMsgs(prev=>[...prev,{role:"assistant",content:"Connection issue — check your Groq key in Admin settings."}]);
    }
    setAgentBusy(false);
  };

  // Download reading materials as text
  const isDark=getThemeMode()==="dark";
  const ACCENT="#EB1000";
  // The "current"/active card uses violet in dark theme (matching the dark hero
  // palette) rather than a harsh red.
  const CURR=isDark?"#9B72FF":ACCENT;
  const CURRBG=isDark?"rgba(155,114,255,.16)":"#FFF1ED";
  const CURRBD=isDark?"rgba(155,114,255,.45)":`${ACCENT}30`;
  // "Done" state avoids green here: dark grey in light theme, white in dark.
  const DONE=isDark?"#FFFFFF":"#4B4B4B";
  const DONECHK=isDark?"#1B1B1B":"#FFFFFF";
  const TRACKBG=isDark?"rgba(255,255,255,.18)":"#E6E6E6";
  const HEADBG=isDark?"linear-gradient(120deg,#241640 0%,#34183f 55%,#3f1d34 100%)":"linear-gradient(120deg,#FFF1ED 0%,#FBD9D0 55%,#F3C3B8 100%)";
  const hINK=isDark?"#F1F2F5":"#1B2140";
  const hMUT=isDark?"rgba(255,255,255,.82)":"#5a5f6e";
  const hACC=isDark?"#fff":ACCENT;
  return(
    <div style={{height:"calc(100vh - 104px)",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      {/* Branded page header */}
      <div style={{background:HEADBG,padding:"20px clamp(16px,3vw,32px) 18px",flexShrink:0}}>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:1.4,textTransform:"uppercase",color:hACC,marginBottom:7}}>Your learning path</div>
        <div style={{display:"flex",alignItems:"flex-end",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
          <div>
            <h1 style={{margin:0,fontSize:mobile?24:30,fontWeight:700,letterSpacing:-.6,color:hINK}}>{activeModule?.title||"Learning Path"}</h1>
            <div style={{fontSize:13.5,color:hMUT,marginTop:5}}>{effectiveDone} of {effectiveModules.length} modules complete · {effectiveModules.length-effectiveDone} remaining</div>
          </div>
          <div style={{minWidth:200,flex:"0 1 260px"}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11,fontWeight:600,color:hINK,marginBottom:5}}><span>Track progress</span><span>{effectiveDone} of {effectiveModules.length}</span></div>
            <div style={{background:isDark?"rgba(255,255,255,.2)":"rgba(0,0,0,.12)",borderRadius:99,height:8}}>
              <div style={{background:isDark?"#fff":"#4B4B4B",borderRadius:99,height:"100%",width:`${(effectiveDone/Math.max(effectiveModules.length,1))*100}%`,transition:"width .4s"}}/>
            </div>
          </div>
        </div>
      </div>
      {/* Sub-tab bar */}
      <div style={{display:"flex",borderBottom:`1px solid ${P.border}`,padding:"0 clamp(12px,2vw,24px)",flexShrink:0,background:P.panel}}>
        {[{id:"overview",l:"Overview"},{id:"flow",l:"Flow map"},{id:"modules",l:"All Modules ("+modules.length+")"},{id:"agent",l:"Curriculum Agent"}].map(t=>(
          <button key={t.id} onClick={()=>setSub(t.id)}
            style={{padding:"10px 16px",background:"transparent",border:"none",borderBottom:sub===t.id?`2px solid ${ACCENT}`:"2px solid transparent",color:sub===t.id?hACC:P.muted,fontWeight:sub===t.id?600:400,fontSize:13,cursor:"pointer",fontFamily:"inherit",marginBottom:-1,whiteSpace:"nowrap"}}>
            {t.l}
          </button>
        ))}
      </div>

      {/* ── Flow map ── */}
      {sub==="flow"&&<div style={{flex:1,overflowY:"auto",padding:"clamp(14px,2vw,28px)"}}>
        <div style={{width:"100%"}}>
          <LearningFlowMap modules={effectiveModules} profile={p} demo={!hasRealProgress} onOpenLesson={onOpenLesson}/>
        </div>
      </div>}

      {/* ── Overview ── */}
      {sub==="overview"&&<div style={{flex:1,overflowY:"auto",padding:"clamp(14px,2vw,24px)"}}>
        <div style={{maxWidth:900,margin:"0 auto 16px"}}>
          <RemediationCard profile={p} track={track} modules={effectiveModules} onOpenLesson={onOpenLesson}/>
        </div>
        <div style={{maxWidth:900,margin:"0 auto",display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:16}}>

          {/* Active module card */}
          <div style={{background:CURRBG,border:`1px solid ${CURRBD}`,borderRadius:14,padding:"20px"}}>
            <div style={{fontSize:11,fontWeight:600,color:CURR,letterSpacing:.5,marginBottom:6}}>CURRENTLY STUDYING</div>
            <div style={{fontSize:16,fontWeight:500,color:P.txt,marginBottom:4}}>{activeModule?.title}</div>
            <div style={{fontSize:12.5,color:P.muted,marginBottom:14}}>Week {activeModule?.week} · {topics.length} topics · {activeModule?.tag}</div>
            {activeModule?.deliverable&&<div style={{fontSize:12.5,color:P.txt,lineHeight:1.6,marginBottom:14,background:P.panel,borderRadius:8,padding:"10px 12px"}}>
              <span style={{fontSize:10.5,fontWeight:600,color:P.muted,display:"block",marginBottom:3}}>DELIVERABLE</span>
              {activeModule.deliverable}
            </div>}
            <div style={{display:"flex",gap:8}}>
              <Btn size="sm" onClick={()=>openLesson(activeModule)}>
                Open lesson <Ic as={ChevronRight} size={15} color="#fff"/>
              </Btn>
              <Btn variant="secondary" size="sm" onClick={()=>setSub("modules")}>All modules</Btn>
            </div>
          </div>

          {/* Progress */}
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,padding:"20px"}}>
            <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.5,marginBottom:12}}>TRACK PROGRESS</div>
            <div style={{marginBottom:14}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:600,color:P.txt,marginBottom:6}}><span>Modules complete</span><span>{effectiveDone} of {effectiveModules.length}</span></div>
              <div style={{background:TRACKBG,borderRadius:99,height:8}}>
                <div style={{background:DONE,borderRadius:99,height:"100%",width:`${(effectiveDone/Math.max(effectiveModules.length,1))*100}%`,transition:"width .4s"}}/>
              </div>
              <div style={{fontSize:12.5,color:P.muted,marginTop:6}}>{effectiveModules.length-effectiveDone} remaining</div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {effectiveModules.map((m,i)=>(
                <div key={m.id} style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:16,height:16,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,fontWeight:500,
                    background:m.status==="done"?DONE:m.status==="active"?CURR:P.bfaint,
                    color:m.status==="locked"?P.dim:"#fff"}}>
                    {m.status==="done"?<Ic as={Checkmark} size={11} color={DONECHK}/>:m.status==="active"?<Ic as={Play} size={9} color="#fff"/>:i+1}
                  </div>
                  <span style={{fontSize:11.5,color:m.status==="locked"?P.dim:P.txt,fontWeight:m.status==="active"?600:400,flex:1,lineHeight:1.3}}>{m.title}</span>
                  {m.status==="active"&&<span style={{fontSize:10,color:CURR,fontWeight:600}}>Active</span>}
                  {m.status==="done"&&<Ic as={Checkmark} size={12} color={DONE}/>}
                </div>
              ))}
            </div>
          </div>

          {/* What to prepare */}
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,padding:"20px"}}>
            <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.5,marginBottom:12}}>PREPARE FOR THIS MODULE</div>
            {topics.slice(0,4).map((t,i)=>(
              <div key={i} style={{display:"flex",gap:10,marginBottom:10,padding:"8px 10px",background:P.surface,borderRadius:8}}>
                <div style={{width:20,height:20,borderRadius:"50%",background:DONE,color:DONECHK,fontSize:9,fontWeight:500,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:12.5,fontWeight:500,color:P.txt,lineHeight:1.4,marginBottom:2}}>{t.t}</div>
                  {t.vid&&<div style={{fontSize:10.5,color:P.red,display:"flex",alignItems:"center",gap:4}}><Ic as={Play} size={11} color={P.red}/> {t.dur}</div>}
                </div>
              </div>
            ))}
            {topics.length>4&&<div style={{fontSize:11.5,color:P.muted,marginTop:4}}>+{topics.length-4} more topics — open lesson for full list</div>}
          </div>

          {/* Quick actions */}
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,padding:"20px"}}>
            <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.5,marginBottom:12}}>QUICK ACTIONS</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {[
                {icon:FileText,label:"Read lesson docs",sub:"AdobeDocs content for current module",action:()=>openLesson(activeModule)},
                {icon:Layers,label:"Study cards",sub:"AI-generated flashcards + mindmap",action:()=>setStudyModule(activeModule?{title:activeModule.title,id:activeModule.id}:null)},
                {icon:Chat,label:"Ask Curriculum Agent",sub:"Get personalised study advice",action:()=>setSub("agent")},
              ].map((a,i)=>(
                <button key={i} onClick={a.action}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:P.surface,borderRadius:9,border:"none",cursor:"pointer",textAlign:"left",fontFamily:"inherit",width:"100%"}}>
                  <Ic as={a.icon} size={18} color={ACCENT}/>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:500,color:P.txt}}>{a.label}</div>
                    <div style={{fontSize:11.5,color:P.muted}}>{a.sub}</div>
                  </div>
                  <Ic as={ChevronRight} size={14} color={P.dim}/>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>}

      {/* ── All Modules ── */}
      {sub==="modules"&&<div style={{flex:1,overflowY:"auto",padding:"clamp(14px,2vw,24px)"}}>
        {studyModule&&<StudyMaterialsModal module={studyModule.title} moduleId={studyModule.id} track={track} groqKey={groqKey} onClose={()=>setStudyModule(null)}/>}
        <div style={{maxWidth:700,margin:"0 auto",display:"flex",flexDirection:"column",gap:8}}>
          {effectiveModules.map((m,i)=>{
            const peers=TEAM.filter(tm=>tm.module===m.title&&tm.name!==p.name);
            const isActive=m.status==="active";
            const isDone=m.status==="done";
            const testedOut=testedOutIds.includes(m.id);
            const isLocked=hasRealProgress
              ? (m.status==="locked"&&!testedOut)
              : (m.status==="locked"&&p.persona!=="demo"&&p.persona!=="exp"&&p.role!=="New Joiner — Demo Mode"&&!testedOut);
            const expanded=expandedModule===m.id;
            return(
              <div key={m.id} id={`module-${m.id}`} style={{background:isActive?CURRBG:P.panel,border:`1px solid ${isActive?CURRBD:isDone?(isDark?"rgba(255,255,255,.25)":"#CFCFCF"):testedOut?P.purple+"30":P.border}`,borderRadius:12,overflow:"hidden",opacity:isLocked?.55:1}}>
                <div style={{padding:"14px 16px",display:"flex",gap:12,alignItems:"center",cursor:!isLocked?"pointer":"default"}}
                  onClick={()=>!isLocked&&setExpandedModule(expanded?null:m.id)}>
                  <div style={{width:28,height:28,borderRadius:"50%",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:500,
                    background:isDone?DONE:isActive?CURR:testedOut?P.purple:P.bfaint,color:isLocked?P.dim:"#fff"}}>
                    {isDone||testedOut?<Ic as={Checkmark} size={14} color={isDone?DONECHK:"#fff"}/>:isActive?<Ic as={Play} size={11} color="#fff"/>:m.capstone?<Ic as={Ribbon} size={13} color="#fff"/>:i+1}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4,flexWrap:"wrap"}}>
                      <span style={{fontSize:13.5,fontWeight:isActive?600:500,color:P.txt}}>{m.title}</span>
                      {m.week&&<span style={{fontSize:10,color:P.muted,background:P.bfaint,borderRadius:4,padding:"1px 6px"}}>Week {m.week}</span>}
                      {testedOut&&<span style={{fontSize:10,color:P.purple,background:P.purpleBg,borderRadius:4,padding:"1px 6px",fontWeight:600}}>Tested out</span>}
                    </div>
                    <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                      <span style={{fontSize:10.5,color:P.dim,background:P.bfaint,borderRadius:4,padding:"1px 7px"}}>{m.tag}</span>
                      {m.theme&&<span style={{fontSize:10.5,color:P.purple,background:P.purpleBg,borderRadius:4,padding:"1px 7px"}}>{m.theme}</span>}
                      {peers.length>0&&<div style={{display:"flex",alignItems:"center",gap:4}}>
                        {peers.map(tm=><div key={tm.name} title={tm.name} style={{width:16,height:16,borderRadius:"50%",background:tm.color,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:8,fontWeight:500}}>{tm.name[0]}</div>)}
                        <span style={{fontSize:10.5,color:P.dim}}>{peers[0].name.split(" ")[0]}</span>
                      </div>}
                    </div>
                  </div>
                  {!isLocked&&<div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
                    <Btn size="sm" onClick={e=>{e.stopPropagation();setStudyModule({title:m.title,id:m.id});}}>Study cards</Btn>
                    <Btn variant="secondary" size="sm" onClick={e=>{e.stopPropagation();openLesson(m);}}>Read lesson <Ic as={ChevronRight} size={14} color={P.txt}/></Btn>
                    {/* Opt out of the module you're currently on, once your confidence has
                        reached 70% — distinct from the "skip ahead to a future module"
                        test-out below, which only appears on modules you haven't reached yet. */}
                    {isActive&&!testedOut&&(p.conf||0)>=0.70&&
                      <Btn size="sm" variant="ghost" onClick={e=>{e.stopPropagation();setTestOutModule(m);}}>Test out of this module</Btn>}
                    <Ic as={expanded?ChevronUp:ChevronDown} size={16} color={P.dim}/>
                  </div>}
                  {isLocked&&<Btn size="sm" variant="secondary" onClick={e=>{e.stopPropagation();setTestOutModule(m);}}>Test out (90% needed)</Btn>}
                </div>
                {expanded&&!isLocked&&<div style={{borderTop:`1px solid ${P.bfaint}`,padding:"12px 16px",background:P.bg}}>
                  {m.deliverable&&<div style={{marginBottom:8}}>
                    <div style={{fontSize:11,fontWeight:600,color:P.muted,letterSpacing:.4,marginBottom:3}}>Deliverable</div>
                    <div style={{fontSize:12.5,color:P.txt,lineHeight:1.6}}>{m.deliverable}</div>
                  </div>}
                  {m.checkpoint&&<div style={{marginBottom:8}}>
                    <div style={{fontSize:11,fontWeight:600,color:hACC,letterSpacing:.4,marginBottom:3}}>Checkpoint</div>
                    <div style={{fontSize:12.5,color:P.txt,lineHeight:1.6}}>{m.checkpoint}</div>
                  </div>}
                  {m.topics?.length>0&&<div>
                    <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.4,marginBottom:6}}>Topics</div>
                    <div style={{display:"flex",flexDirection:"column",gap:3}}>
                      {m.topics.map((t,ti)=>(
                        <div key={ti} style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                          <div style={{width:4,height:4,borderRadius:"50%",background:P.dim,marginTop:6,flexShrink:0}}/>
                          <span style={{fontSize:12,color:P.muted,lineHeight:1.5}}>{t}</span>
                        </div>
                      ))}
                    </div>
                  </div>}
                  {hasRealProgress&&!isDone&&isActive&&!m.capstone&&<div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${P.bfaint}`}}>
                    <button onClick={()=>markModuleComplete(m.id,m.title)} disabled={completing}
                      style={{background:DONE,color:DONECHK,border:isDark?"none":"none",borderRadius:8,padding:"8px 18px",fontSize:12.5,fontWeight:600,cursor:"pointer",fontFamily:"inherit",opacity:completing?.6:1,display:"inline-flex",alignItems:"center",gap:6}}>
                      {completing?"Saving…":<><Ic as={Checkmark} size={14} color={DONECHK}/> Mark module complete</>}
                    </button>
                    <div style={{fontSize:11,color:P.muted,marginTop:6}}>Confirms you've finished this module's deliverable and checkpoint, unlocks the next module, and earns +50 points.</div>
                  </div>}
                </div>}
              </div>
            );
          })}
        </div>
      </div>}

      {/* ── Curriculum Agent ── */}
      {sub==="agent"&&<div style={{flex:1,display:"flex",overflow:"hidden",maxWidth:900,margin:"0 auto",width:"100%",padding:"clamp(10px,2vw,20px)",gap:16}}>
        {/* Chat */}
        <div style={{flex:1,display:"flex",flexDirection:"column",background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,overflow:"hidden"}}>
          <div style={{padding:"14px 18px",borderBottom:`1px solid ${P.border}`,flexShrink:0}}>
            <div style={{fontSize:14,fontWeight:500,color:P.txt}}>Curriculum Agent</div>
            <div style={{fontSize:12,color:P.muted}}>Personalised learning guidance for {p.name?.split(" ")[0]||"you"}</div>
          </div>
          <div ref={agentRef} style={{flex:1,overflowY:"auto",padding:14,display:"flex",flexDirection:"column",gap:10}}>
            {agentMsgs.map((m,i)=>{
              const isRedirect=m.redirect===true;
              const isUser=m.role==="user";
              // Render **bold** markdown inline
              const renderText=(txt)=>txt.split(/(\*\*[^*]+\*\*)/g).map((s,j)=>
                s.startsWith("**")&&s.endsWith("**")
                  ?<strong key={j}>{s.slice(2,-2)}</strong>
                  :<span key={j}>{s}</span>
              );
              return(
                <div key={i} style={{display:"flex",justifyContent:isUser?"flex-end":"flex-start"}}>
                  {isRedirect?(
                    // Redirect notice — amber pill style
                    <div style={{maxWidth:"90%",padding:"8px 13px",borderRadius:10,
                      background:"#FFF7ED",border:"1px solid #FED7AA",color:"#92400E",
                      fontSize:12.5,lineHeight:1.5,fontStyle:"italic"}}>
                      {m.content}
                    </div>
                  ):(
                    <div style={{maxWidth:"82%",padding:"9px 13px",borderRadius:isUser?"12px 12px 3px 12px":"12px 12px 12px 3px",
                      background:isUser?ACCENT:P.surface,color:isUser?"#fff":P.txt,
                      fontSize:13.5,lineHeight:1.65,border:!isUser?`1px solid ${P.border}`:"none",
                      whiteSpace:"pre-wrap"}}>
                      {renderText(m.content)}
                    </div>
                  )}
                </div>
              );
            })}
            {agentBusy&&<div style={{background:P.surface,border:`1px solid ${P.border}`,borderRadius:"12px 12px 12px 3px",padding:"9px 13px",fontSize:13.5,color:P.muted,width:50}}>···</div>}
          </div>
          <div style={{padding:"10px 14px",borderTop:`1px solid ${P.border}`,display:"flex",gap:8,flexShrink:0}}>
            <input value={agentInput} onChange={e=>setAgentInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendAgent()}
              placeholder="Ask about your learning path…"
              style={{flex:1,border:`1px solid ${P.border}`,borderRadius:9,padding:"9px 13px",fontSize:13.5,outline:"none",background:P.bg,color:P.txt}}/>
            <Btn onClick={sendAgent} disabled={agentBusy}>Send</Btn>
          </div>
        </div>
        {/* Suggestions panel */}
        <div style={{width:220,flexShrink:0,display:"flex",flexDirection:"column",gap:10}}>
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,padding:"14px"}}>
            <div style={{fontSize:11,fontWeight:600,color:P.dim,marginBottom:10}}>SUGGESTED QUESTIONS</div>
            {(()=>{
              // Grounded in THIS learner's real track + current/next module so the
              // prompts are relevant and answerable, not generic placeholders.
              const trackName=TRACK_LABELS[track]||"your track";
              const cur=activeModule?.title?.split(":")[0]?.trim();
              const nextPending=(effectiveModules||[]).find(m=>m.status!=="done"&&!m.capstone&&m.title!==activeModule?.title);
              const nxt=nextPending?.title?.split(":")[0]?.trim();
              const qs=[
                cur?`What are the key objectives of "${cur}"?`:`What should I focus on next in ${trackName}?`,
                cur?`I'm stuck on "${cur}" — how should I approach it?`:`How do I get started with ${trackName}?`,
                nxt?`How do I prepare for "${nxt}"?`:`What comes after my current module?`,
                `How many modules until I can start the ${trackName} capstone?`,
                `Which of my remaining modules should I prioritise?`,
                `Am I on track to finish ${trackName} on time?`,
              ].filter(Boolean);
              return qs.map((q,i)=>(
                <button key={i} onClick={()=>sendAgent(q)} disabled={agentBusy}
                  style={{display:"block",width:"100%",textAlign:"left",padding:"7px 10px",background:P.surface,border:"none",borderRadius:7,cursor:agentBusy?"default":"pointer",fontSize:12,color:P.muted,marginBottom:6,fontFamily:"inherit",lineHeight:1.4,opacity:agentBusy?.6:1}}>
                  {q}
                </button>
              ));
            })()}
          </div>
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,padding:"14px"}}>
            <div style={{fontSize:11,fontWeight:600,color:P.dim,marginBottom:8}}>YOUR STATUS</div>
            <div style={{fontSize:12,color:P.txt,marginBottom:4}}>{effectiveDone}/{effectiveModules.length} modules complete</div>
            <div style={{fontSize:12,color:P.muted}}>Confidence: {Math.round((p.conf||0)*100)}%</div>
            <div style={{fontSize:12,color:P.muted}}>Current: {activeModule?.title?.split(":")[0]}</div>
          </div>
        </div>
      </div>}

      {testOutModule&&<TestOutModal module={testOutModule} track={track} profile={p} groqKey={groqKey}
        onClose={()=>setTestOutModule(null)}
        onPass={(moduleId)=>{setTestedOutIds(prev=>[...prev,moduleId]);setCompletedIds(prev=>prev.includes(moduleId)?prev:[...prev,moduleId]);if(onTestOutPass)onTestOutPass();}}/>}
    </div>
  );
}


function ValidateUnderstandingModal({scenario,topic,onClose,onPass}){
  const [phase,setPhase]=useState("input"); // input | scoring | result
  const [text,setText]=useState("");
  const [result,setResult]=useState(null);
  const [error,setError]=useState(null);

  const submit=async()=>{
    if(!text.trim())return;
    setPhase("scoring");setError(null);
    // The scenario object here is shaped for display (title/context/problem/
    // requirements/hints/skills). The validate endpoint expects the same
    // field names run_practice() itself returns (business_context/
    // problem_statement/constraints/expected_deliverable) — map back so the
    // RAG comparison actually has real content to grade against, not just a title.
    const scenarioForValidation={
      title:                scenario?.title||"",
      business_context:     scenario?.context||"",
      problem_statement:    scenario?.problem||"",
      constraints:          scenario?.requirements||[],
      expected_deliverable: scenario?.expectedDeliverable||"",
      aep_products_involved: scenario?.skills||[],
    };
    try{
      const r=await validateUnderstanding({scenario:scenarioForValidation,topic,learner_understanding:text.trim()});
      setResult(r);
      setPhase("result");
      if(r.verdict==="pass")onPass?.();
    }catch(e){
      console.warn("Validate understanding failed",e);
      setError("Could not score your answer — check the backend connection and try again.");
      setPhase("input");
    }
  };

  const tryAgain=()=>{setResult(null);setPhase("input");};

  return(
    <div className="nx-modal-overlay" onClick={phase==="scoring"?undefined:onClose}>
      <div className="nx-modal" onClick={e=>e.stopPropagation()} style={{maxWidth:560,background:P.panel,color:P.txt}}>
        <div style={{padding:"16px 20px",borderBottom:`1px solid ${P.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:14,fontWeight:500,color:P.txt}}>Validate my understanding</div>
            <div style={{fontSize:11.5,color:P.muted}}>Explain the scenario in your own words</div>
          </div>
          {phase!=="scoring"&&<button onClick={onClose} style={{background:"transparent",border:"none",fontSize:16,color:P.muted,cursor:"pointer"}}>✕</button>}
        </div>

        <div style={{padding:"20px",maxHeight:"65vh",overflowY:"auto"}}>
          {phase==="input"&&<>
            <div style={{fontSize:12.5,color:P.muted,marginBottom:10,lineHeight:1.6}}>
              What's the problem, what would you do, and why? Write it as if you were explaining it to a teammate.
            </div>
            <textarea value={text} onChange={e=>setText(e.target.value)} rows={7}
              placeholder="I think the issue is… I would check… because…"
              style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"10px 12px",fontSize:13,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit",resize:"vertical"}}/>
            {error&&<div style={{marginTop:10,fontSize:12.5,color:P.red}}>{error}</div>}
          </>}

          {phase==="scoring"&&<div style={{textAlign:"center",padding:30,color:P.muted,fontSize:13}}>Comparing your answer against the scenario…</div>}

          {phase==="result"&&result&&<div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
              <Ic as={result.verdict==="pass"?CheckmarkCircle:AlertTriangle} size={26} color={result.verdict==="pass"?P.grn:P.amber}/>
              <div>
                <div style={{fontSize:18,fontWeight:600,color:result.verdict==="pass"?P.grn:P.amber}}>{result.confidence}% confidence</div>
                <div style={{fontSize:12.5,color:P.muted}}>{result.verdict==="pass"?"Good job — your understanding looks correct.":"A few gaps to close before this is solid."}</div>
              </div>
            </div>

            {result.matchedPoints?.length>0&&<div style={{marginBottom:14}}>
              <Label style={{color:P.grn,marginBottom:6}}>What you got right</Label>
              {result.matchedPoints.map((m,i)=><div key={i} style={{fontSize:13,color:P.txt,lineHeight:1.6,marginBottom:4,display:"flex",gap:8}}><span style={{color:P.grn}}>✓</span><span>{m}</span></div>)}
            </div>}

            {result.missedPoints?.length>0&&<div style={{marginBottom:14}}>
              <Label style={{color:P.amber,marginBottom:6}}>Review this</Label>
              {result.missedPoints.map((m,i)=><div key={i} style={{fontSize:13,color:P.txt,lineHeight:1.6,marginBottom:4,display:"flex",gap:8}}><span style={{color:P.amber}}>·</span><span>{m}</span></div>)}
            </div>}

            {result.guidance&&<div style={{background:result.verdict==="pass"?P.grnBg:P.amberBg,border:`1px solid ${(result.verdict==="pass"?P.grn:P.amber)}20`,borderRadius:10,padding:"12px 14px",fontSize:13,color:P.txt,lineHeight:1.65}}>
              {result.guidance}
            </div>}
          </div>}
        </div>

        <div style={{padding:"14px 20px",borderTop:`1px solid ${P.border}`,display:"flex",gap:8,justifyContent:"flex-end"}}>
          {phase==="input"&&<button onClick={submit} disabled={!text.trim()}
            style={{background:P.blue,color:"#fff",border:"none",borderRadius:8,padding:"9px 20px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",opacity:!text.trim()?.5:1}}>
            Submit
          </button>}
          {phase==="result"&&result?.verdict==="review"&&<button onClick={tryAgain}
            style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 18px",fontSize:13,color:P.txt,cursor:"pointer",fontFamily:"inherit"}}>
            Try again
          </button>}
          {phase==="result"&&<button onClick={onClose}
            style={{background:result.verdict==="pass"?P.blue:"transparent",color:result.verdict==="pass"?"#fff":P.txt,border:result.verdict==="pass"?"none":`1px solid ${P.border}`,borderRadius:8,padding:"9px 20px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
            {result.verdict==="pass"?"Done":"Close"}
          </button>}
        </div>
      </div>
    </div>
  );
}

function PracticeScenarios({module,groqKey,profile,track=null}){
  const isDark=getThemeMode()==="dark";
  const ACCENT="#EB1000";
  const ACCTX=isDark?"#FF6A5C":ACCENT;
  const ACCBG=isDark?"rgba(235,16,0,.12)":"#FFF1ED";
  const [phase,setPhase]=useState("idle"); // idle | generating | ready
  const [topicInput,setTopicInput]=useState("");
  const [activeTopic,setActiveTopic]=useState("");
  const [scenario,setScenario]=useState(null);
  const [msgs,setMsgs]=useState([]);
  const [input,setInput]=useState("");
  const [busy,setBusy]=useState(false);
  const chatRef=useRef(null);

  // "I Understand" / "Validate My Understanding" state
  const [understood,setUnderstood]=useState(false);
  const [showValidate,setShowValidate]=useState(false);
  const [passToast,setPassToast]=useState(false);

  useEffect(()=>{if(chatRef.current)chatRef.current.scrollTop=chatRef.current.scrollHeight;},[msgs]);
  useEffect(()=>{
    if(!passToast)return;
    const t=setTimeout(()=>setPassToast(false),5000);
    return()=>clearTimeout(t);
  },[passToast]);

  const [fromCache,setFromCache]=useState(false);

  const activeTrack=track||getTrack(profile)||"rtcdp";
  // Practising outside the learner's home track = cross-skill context. Purely
  // used to nudge the scenario's framing on the backend — no eligibility
  // logic is reimplemented here; `track` is already gated upstream (a
  // cross-skill track is only ever passed in once the learner has unlocked
  // cross-skilling, e.g. after their capstone).
  const isCrossSkill=!!track&&track!==getTrack(profile);

  const generate=async(topicOverride)=>{
    const topic=(topicOverride??topicInput).trim();
    if(!topic)return;
    setPhase("generating");setUnderstood(false);
    const trackLabel=TRACK_LABELS[activeTrack]||"AEP";

    try{
      // Primary path — backend Practice Agent: RAG-grounded, dynamically
      // generated for whatever topic the learner typed. No predefined list.
      const{scenario:data}=await callPractice({
        learner_name:   profile?.name||"",
        track:          activeTrack,
        topic,
        is_cross_skill: isCrossSkill,
      });
      if(!data?.title)throw new Error("empty scenario from backend");
      // Normalise backend field names (business_context/problem_statement) to
      // the shape the rest of this component already renders.
      setScenario({
        title:        data.title,
        context:      data.business_context,
        problem:      data.problem_statement,
        requirements: data.constraints||[],
        hints:        data.hints||[],
        skills:       data.aep_products_involved||[],
        expectedDeliverable: data.expected_deliverable||"",
      });
      setFromCache(false);
    }catch(backendErr){
      console.warn("Practice agent backend call failed, falling back to client-side generation:",backendErr);
      // Fallback path — same client-side generation this component always
      // used, now templated on the learner's own topic instead of a fixed
      // module. Keeps the feature working even if the backend/DB is down.
      const cacheKey=`scenario:${activeTrack}:${topic}`;
      const sys=`You are a Curriculum Agent generating a practice scenario for an Adobe employee learning ${trackLabel}.
Create a realistic, hands-on scenario about "${topic}" that a ${trackLabel} consultant would actually face on a client project.
The scenario MUST be specific to ${trackLabel} and to the topic "${topic}" — do NOT make it generic AEP. Use real ${trackLabel} features, concepts, and workflows.
${isCrossSkill?`This is a CROSS-SKILL practice topic for the learner — frame it so it's clear how this skill applies in a real working context.\n`:""}Return ONLY valid JSON:
{"title":"scenario title","context":"2-3 sentence business context (no client names, use generic industry)","problem":"the specific ${trackLabel} technical challenge to solve, about ${topic}","requirements":["requirement 1","requirement 2","requirement 3"],"hints":["hint pointing toward solution","second hint"],"skills":["${trackLabel} skill tag 1","skill tag 2"]}`;
      try{
        const{result:data,fromCache:cached}=await getCachedOrGenerate(cacheKey,"PracticeScenarios",async()=>{
          const raw=await callAgent([{role:"user",content:`Track: ${trackLabel}\nTopic: ${topic}\nGenerate a realistic ${trackLabel}-specific practice scenario about this topic. Do NOT make it generic — use actual ${trackLabel} features and workflows.`}],
            sys,groqKey,{agentName:"PracticeGen",logFn:null,maxTokens:800});
          return JSON.parse(raw.replace(/```json|```/g,"").trim());
        });
        setScenario(data);setFromCache(cached);
      }catch{
        setScenario({
          title:"Segment Evaluation Inconsistency",
          context:"A retail brand running an APAC loyalty programme is seeing inconsistent segment membership — the same profile qualifies one day and drops out the next without any change in their behaviour.",
          problem:"Identify the root cause of inconsistent segment evaluation results and recommend the correct evaluation mode and merge policy configuration.",
          requirements:["Identify what evaluation mode is most likely causing the inconsistency","Explain how merge policy affects which profile fragment gets evaluated","Recommend a fix and describe how you would validate it"],
          hints:["Think about what changes between batch evaluation runs that could affect qualification","Consider how multiple identity namespaces might produce different profile fragments"],
          skills:["Segment Evaluation Logic","Merge Policies","Identity Resolution"],
        });
        setFromCache(false);
      }
    }
    setActiveTopic(topic);
    setMsgs([{role:"assistant",content:"Your practice scenario is ready. Read through it carefully and work through your response.\n\nAsk me anything — I'll give you hints and help you think through the problem, but the reasoning needs to come from you."}]);
    setPhase("ready");
  };

  const send=async()=>{
    if(!input.trim()||busy)return;
    const userMsg={role:"user",content:input.trim()};
    setMsgs(prev=>[...prev,userMsg]);
    setInput("");setBusy(true);
    const sys=`You are helping an AEP Analytics engineer work through a practice scenario.
Scenario: ${scenario?.title}
Problem: ${scenario?.problem}
Requirements: ${scenario?.requirements?.join("; ")}

Rules:
- Give hints, not direct answers
- Ask what they've tried
- Reference real AEP concepts (merge policies, evaluation modes, XDM, guardrails)
- Keep responses under 80 words
- Be encouraging but rigorous`;
    try{
      const text=await callAgent([...msgs,userMsg].map(m=>({role:m.role,content:m.content})),
        sys,groqKey,{agentName:"Practice",logFn:null,maxTokens:200});
      judgeGenericResponse(text, "Practice").catch(()=>{});
      setMsgs(prev=>[...prev,{role:"assistant",content:text}]);
    }catch{
      setMsgs(prev=>[...prev,{role:"assistant",content:"Connection issue — check your Groq key in Admin → Integrations."}]);
    }
    setBusy(false);
  };

  const markUnderstood=()=>{
    setUnderstood(true);
    fetch(`${BACKEND}/api/telemetry`,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({persona:profile?.persona||"nj",event_type:"practice_understood",module:activeTopic,
        detail:scenario?.title||""})}).catch(()=>{});
  };

  if(phase==="idle")return(
    <div style={{maxWidth:560,margin:"0 auto",padding:"28px 24px"}}>
      <Card style={{padding:"32px 28px"}}>
        <div style={{fontSize:11,fontWeight:700,color:ACCTX,letterSpacing:1.2,textTransform:"uppercase",marginBottom:12}}>Practice Scenarios</div>
        <div style={{fontSize:22,fontWeight:700,color:P.txt,letterSpacing:-.4,marginBottom:10}}>What do you want to practice?</div>
        <div style={{fontSize:13.5,color:P.muted,lineHeight:1.75,marginBottom:16}}>
          Type any topic you're working on — the agent will build a realistic, hands-on scenario around it, grounded in real AEP implementation patterns.
        </div>
        <textarea value={topicInput} onChange={e=>setTopicInput(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();generate();}}}
          rows={3}
          placeholder={`e.g. "I want to work on my understanding of streaming segmentation — can you generate a use case?"`}
          style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"10px 12px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit",resize:"vertical",marginBottom:20}}/>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:24}}>
          {[{l:"Generated for",v:"the exact topic you type — nothing predefined"},{l:"Format",v:"context + problem + requirements"},{l:"Support",v:"ask the agent for hints at any time"},{l:"Validation",v:"check your own understanding when you're done"}].map(r=>(
            <div key={r.l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:`1px solid ${P.bfaint}`}}>
              <span style={{fontSize:13,color:P.muted}}>{r.l}</span>
              <span style={{fontSize:13,fontWeight:500,color:P.txt}}>{r.v}</span>
            </div>
          ))}
        </div>
        <Btn full size="lg" onClick={()=>generate()} disabled={!topicInput.trim()}>Generate a Practice Scenario <Ic as={ChevronRight} size={15} color="currentColor"/></Btn>
      </Card>
    </div>
  );

  if(phase==="generating")return(
    <div style={{padding:40,textAlign:"center"}}>
      <div style={{fontSize:14.5,fontWeight:600,color:P.txt,marginBottom:6}}>Generating your scenario…</div>
      <div style={{fontSize:13,color:P.muted}}>Building a real-world use case for "{topicInput}".</div>
    </div>
  );

  return(
    <div style={{display:"flex",gap:0,height:"calc(100vh - 104px)",minHeight:0}}>
      {/* Left: scenario */}
      <div style={{flex:1,overflowY:"auto",padding:"24px 20px",borderRight:`1px solid ${P.border}`,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
          <div>
            <div style={{fontSize:16,fontWeight:500,color:P.txt,letterSpacing:-.2,marginBottom:2}}>{scenario?.title}</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:6}}>
              {(scenario?.skills||[]).map(s=><span key={s} style={{fontSize:11.5,fontWeight:600,color:ACCTX,background:ACCBG,borderRadius:5,padding:"2px 9px"}}>{s}</span>)}
              {fromCache&&<span style={{fontSize:11,color:P.dim}}>cached</span>}
            </div>
          </div>
          <button onClick={()=>{setTopicInput(activeTopic);setPhase("idle");}} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"6px 14px",fontSize:12,cursor:"pointer",color:P.muted,fontFamily:"inherit"}}>↻ New scenario</button>
        </div>

        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <Card style={{padding:"20px 22px"}}>
            <Label style={{marginBottom:8}}>Business context</Label>
            <div style={{fontSize:13.5,color:P.txt,lineHeight:1.75}}>{scenario?.context}</div>
          </Card>
          <Card style={{padding:"20px 22px",borderLeft:`3px solid ${ACCENT}`,borderRadius:"0 12px 12px 0"}}>
            <Label style={{marginBottom:8,color:ACCTX}}>The problem</Label>
            <div style={{fontSize:14,fontWeight:500,color:P.txt,lineHeight:1.7}}>{scenario?.problem}</div>
          </Card>
          <Card style={{padding:"20px 22px"}}>
            <Label style={{marginBottom:12}}>Your requirements</Label>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {(scenario?.requirements||[]).map((r,i)=>(
                <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                  <div style={{width:20,height:20,borderRadius:"50%",background:P.purpleBg,border:`1px solid ${P.purple}30`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:500,color:P.purple,flexShrink:0,marginTop:1}}>{i+1}</div>
                  <div style={{fontSize:13.5,color:P.txt,lineHeight:1.65}}>{r}</div>
                </div>
              ))}
            </div>
          </Card>
          {scenario?.expectedDeliverable&&<Card style={{padding:"20px 22px"}}>
            <Label style={{marginBottom:8}}>Expected deliverable</Label>
            <div style={{fontSize:13.5,color:P.txt,lineHeight:1.75}}>{scenario.expectedDeliverable}</div>
          </Card>}
          {scenario?.hints?.length>0&&<div style={{background:P.amberBg,border:`1px solid ${P.amber}20`,borderRadius:12,padding:"14px 18px"}}>
            <Label style={{color:P.amber,marginBottom:8}}>Hints</Label>
            {scenario.hints.map((h,i)=><div key={i} style={{fontSize:13,color:P.txt,lineHeight:1.65,marginBottom:i<scenario.hints.length-1?6:0}}>· {h}</div>)}
          </div>}

          {/* CTAs */}
          <div style={{display:"flex",gap:10,marginTop:4,flexWrap:"wrap"}}>
            <button onClick={markUnderstood} disabled={understood}
              style={{background:understood?P.grnBg:"transparent",border:`1px solid ${understood?P.grn:P.border}`,color:understood?P.grn:P.txt,borderRadius:999,padding:"9px 20px",fontSize:13.5,fontWeight:600,cursor:understood?"default":"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:7}}>
              {understood&&<Ic as={CheckmarkCircle} size={15} color={P.grn}/>}
              {understood?"Marked as understood":"I Understand"}
            </button>
            <Btn onClick={()=>setShowValidate(true)}>Validate My Understanding</Btn>
          </div>
        </div>
      </div>

      {/* Right: chat */}
      <div style={{width:320,flexShrink:0,display:"flex",flexDirection:"column",background:P.panel}}>
        <div style={{padding:"14px 16px",borderBottom:`1px solid ${P.border}`,flexShrink:0}}>
          <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:2}}>Ask the agent</div>
          <div style={{fontSize:11.5,color:P.muted}}>Hints and direction — not answers</div>
        </div>
        <div ref={chatRef} style={{flex:1,overflowY:"auto",padding:"16px",display:"flex",flexDirection:"column",gap:12}}>
          {msgs.map((m,i)=>(
            <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",gap:8,alignItems:"flex-start"}}>
              {m.role==="assistant"&&<div style={{width:24,height:24,borderRadius:"50%",background:ACCENT,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:10,fontWeight:500,flexShrink:0,marginTop:2}}>A</div>}
              <div style={{maxWidth:"85%",padding:"9px 13px",borderRadius:m.role==="user"?"12px 12px 3px 12px":"12px 12px 12px 3px",background:m.role==="user"?ACCENT:P.surface,color:m.role==="user"?"#fff":P.txt,fontSize:13,lineHeight:1.65,border:m.role==="assistant"?`1px solid ${P.border}`:"none",textAlign:"left"}}>{m.content}</div>
            </div>
          ))}
          {busy&&<div style={{display:"flex",gap:8}}><div style={{width:24,height:24,borderRadius:"50%",background:ACCENT,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:10,fontWeight:500}}>A</div><div style={{background:P.surface,border:`1px solid ${P.border}`,borderRadius:"12px 12px 12px 3px",padding:"9px 13px",fontSize:13,color:P.muted}}>···</div></div>}
        </div>
        <div style={{padding:"10px 12px",borderTop:`1px solid ${P.border}`,display:"flex",gap:8,flexShrink:0}}>
          <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&send()}
            placeholder="Ask about the scenario…"
            style={{flex:1,border:`1px solid ${P.border}`,borderRadius:9,padding:"8px 12px",fontSize:13,outline:"none",background:P.bg,color:P.txt}}/>
          <Btn onClick={send} disabled={busy} size="sm">Send</Btn>
        </div>
      </div>

      {showValidate&&<ValidateUnderstandingModal scenario={scenario} topic={activeTopic}
        onClose={()=>setShowValidate(false)}
        onPass={()=>setPassToast(true)}/>}

      {passToast&&<div style={{position:"fixed",bottom:24,right:24,zIndex:300,background:P.panel,border:`1px solid ${P.grn}40`,borderRadius:12,padding:"14px 18px",boxShadow:P.shadowHv,display:"flex",alignItems:"center",gap:10,maxWidth:320}}>
        <Ic as={CheckmarkCircle} size={20} color={P.grn}/>
        <div style={{fontSize:13,color:P.txt,fontWeight:500}}>Good job — your understanding looks correct.</div>
      </div>}
    </div>
  );
}


const CAPSTONE_STATUS_LABEL={
  idle:"Not generated",generating:"Generating…",generated:"In progress",
  submitting:"Submitting…",evaluating:"Running AI self-check…",
  ai_evaluated:"AI-evaluated · awaiting manager review",manager_approved:"Manager approved ✓",
  manager_rejected:"Changes requested — revise and resubmit",
};

function Capstone({profile,groqKey,githubToken,conf,allModulesDone=false,doneModules=0,totalModules=8,persist=true,track=null,onComplete=null}){
  const confOk=conf>=CAPSTONE_CONFIDENCE_GATE;
  const locked=!confOk||!allModulesDone;
  const module=profile?.module||"AEP Foundations";
  const weakSkillsArr=SKILLS.filter((_,i)=>["developing","none","gap"].includes(profile?.skills?.[i])).slice(0,3);
  const weakSkills=weakSkillsArr.length?weakSkillsArr:["AEP Segments","AJO"];

  const [status,setStatus]=useState("idle"); // idle|generating|generated|submitting|evaluating|ai_evaluated|manager_approved|manager_rejected
  const [submissionId,setSubmissionId]=useState(null);
  const [scenario,setScenario]=useState(null);
  const [dueAt,setDueAt]=useState(null); // 7-day capstone deadline (ISO string)
  const [responseText,setResponseText]=useState("");
  const [aiEval,setAiEval]=useState(null);
  const [managerNotes,setManagerNotes]=useState(null);

  // Hint chat — Socratic-mode HINT calls, scoped to this specific submission via
  // conversation_messages' existing (member_name, module, mode) key — module is
  // synthesised as `capstone:{submissionId}` so the thread survives regenerate-vs-
  // resubmit correctly (a reject→resubmit keeps the same submissionId, so the
  // hint thread carries over; a fresh "Generate" gets a fresh thread).
  const [hintMsgs,setHintMsgs]=useState([]);
  const [hintInput,setHintInput]=useState("");
  const [hintBusy,setHintBusy]=useState(false);
  const hintModule=submissionId?`capstone:${submissionId}`:null;
  const hintChatRef=useRef(null);

  useEffect(()=>{if(hintChatRef.current)hintChatRef.current.scrollTop=hintChatRef.current.scrollHeight;},[hintMsgs]);

  // Resume in-progress/completed capstone across reloads for real, registered learners.
  useEffect(()=>{
    if(!persist||!profile?.id)return;
    fetch(`${BACKEND}/api/capstone/${profile.id}`).then(r=>r.json()).then(d=>{
      const s=d?.submission;
      if(!s)return;
      setSubmissionId(s.id);
      setScenario(s.scenario||null);
      setResponseText(s.response_text||"");
      setAiEval(s.ai_evaluation||null);
      setManagerNotes(s.manager_notes||null);
      setDueAt(s.due_at||null);
      setStatus(s.status||"generated");
    }).catch(()=>{});
  },[profile?.id,persist]);

  // Load hint history once we know which submission we're scoped to.
  useEffect(()=>{
    if(!persist||!profile?.id||!hintModule)return;
    fetch(`${BACKEND}/api/conversations?member_name=${encodeURIComponent(profile.name)}&module=${encodeURIComponent(hintModule)}&mode=capstone_hint`)
      .then(r=>r.json())
      .then(d=>{if(d?.messages?.length)setHintMsgs(d.messages.map(m=>({role:m.role,content:m.content})));})
      .catch(()=>{});
  },[hintModule,persist,profile?.id]);

  const generate=async()=>{
    setStatus("generating");
    const activeTrack=track||getTrack(profile)||"rtcdp";
    // All module titles of the completed path — the capstone must cover them all.
    const moduleTitles=(getModulesForTrack(activeTrack)||[])
      .filter(m=>!m.capstone).map(m=>(m.title||"").split(":")[0].trim()).filter(Boolean);
    let parsed=null;
    try{
      // The backend Capstone Agent (LangGraph + RAG + Groq→Anthropic failover)
      // owns generation now: it grounds a track-specific, all-modules,
      // basic→expert capstone in the real path + a per-track blueprint.
      const r=await fetch(`${BACKEND}/api/agents/capstone`,{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({messages:[],track:activeTrack,
          profile:{name:profile?.name||"",role:profile?.role||"",team:profile?.team||""},
          extra:{team_context:profile?.team||"",all_module_titles:moduleTitles,done_module_titles:moduleTitles}})});
      const d=await r.json();
      if(!r.ok||!(Array.isArray(d.tasks)&&d.tasks.length))throw new Error(d.detail||"agent returned no tasks");
      parsed={
        // Rich, path-specific structure
        title:d.title,company_brief:d.company_brief,objective:d.objective,
        tasks:d.tasks,deck_requirements:d.deck_requirements||[],submission_checklist:d.submission_checklist||[],
        rubric:d.rubric||[],modules_covered:d.modules_covered||moduleTitles,
        estimated_effort_hours:d.estimated_effort_hours,vertical:d.vertical,company:d.company,track:activeTrack,
        // Back-compat fields the existing submit/evaluate/render still read
        client_context:d.company_brief,skills_tested:(d.modules_covered||moduleTitles).slice(0,5),
        deliverable:(d.submission_checklist||[]).join("; "),
        evaluation_criteria:(d.rubric||[]).map(x=>x.criterion),
      };
    }catch{
      // Offline fallback — a concrete blueprint-style capstone, still track-shaped.
      parsed={
        title:`${TRACK_LABELS[activeTrack]||activeTrack.toUpperCase()} Capstone`,
        client_context:`A client is rolling out ${TRACK_LABELS[activeTrack]||activeTrack}. Demonstrate end-to-end mastery across everything you learned in this path: ${moduleTitles.slice(0,6).join(", ")||"the full path"}.`,
        objective:`Demonstrate end-to-end mastery of ${TRACK_LABELS[activeTrack]||activeTrack}.`,
        skills_tested:moduleTitles.slice(0,5),
        tasks:[],
        deliverable:"Complete the hands-on build and present your design decisions to your manager.",
        submission_checklist:["Hands-on build with screenshots/config","Presentation deck","Reflection on trade-offs"],
        evaluation_criteria:["Uses real Adobe capabilities correctly","All tasks + slides delivered","Design rationale is justified","Guardrails & edge cases covered"],
      };
    }
    setScenario(parsed);
    setResponseText("");setAiEval(null);
    if(persist&&profile?.id){
      try{
        const r=await fetch(`${BACKEND}/api/capstone/generate`,{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({member_id:profile.id,scenario:parsed})});
        const d=await r.json();
        if(d?.id)setSubmissionId(d.id);
        if(d?.due_at)setDueAt(d.due_at);
      }catch{}
    }
    setStatus("generated");
  };

  const submitResponse=async()=>{
    if(!responseText.trim()||!scenario)return;
    setStatus("submitting");
    setManagerNotes(null); // cleared server-side too, in the same update that resets status
    if(persist&&submissionId){
      try{
        await fetch(`${BACKEND}/api/capstone/${submissionId}/submit`,{method:"PUT",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({response_text:responseText})});
      }catch{}
    }
    setStatus("evaluating");
    const sys=AGENT_CONFIGS.capstone.sys;
    let evaluation=null;
    try{
      const raw=await callAgent(
        [{role:"user",content:`evaluate capstone response: ${responseText}\n\nscenario: ${JSON.stringify(scenario)}\n\ncriteria: ${JSON.stringify(scenario.evaluation_criteria||[])}`}],
        sys,groqKey,{agentName:"Capstone",logFn:null,maxTokens:500});
      judgeGenericResponse(raw,"Capstone").catch(()=>{});
      evaluation=JSON.parse(raw.replace(/```json|```/g,"").trim());
    }catch{
      evaluation={pass:false,score:0,feedback:"We couldn't reach the AI evaluator just now. Your manager will still review your response directly.",strengths:[],gaps:[],recommendation:"Ask your manager to review your submission manually."};
    }
    setAiEval(evaluation);
    if(persist&&submissionId){
      try{
        await fetch(`${BACKEND}/api/capstone/${submissionId}/evaluate`,{method:"PUT",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({ai_evaluation:evaluation})});
      }catch{}
    }
    // Cross-skill (non-persist) capstones have no manager-approval gate — the AI
    // evaluation pass IS completion. Report it up so it's recorded per-track.
    if(!persist&&evaluation?.pass&&onComplete){
      onComplete(track||getTrack(profile),evaluation.score);
    }
    setStatus("ai_evaluated");
  };

  const sendHint=async()=>{
    if(!hintInput.trim()||hintBusy||!scenario)return;
    const userMsg={role:"user",content:hintInput.trim()};
    const next=[...hintMsgs,userMsg];
    setHintMsgs(next);setHintInput("");setHintBusy(true);
    if(persist&&profile?.id&&hintModule){
      fetch(`${BACKEND}/api/conversations/message`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({member_name:profile.name,manager:profile.manager||null,module:hintModule,mode:"capstone_hint",role:"user",content:userMsg.content})}).catch(()=>{});
    }
    try{
      // Dedicated Capstone Assistant — grounded in THIS learner's generated
      // capstone (tasks, deck, objective) on the backend, so guidance is
      // specific to what they must build. Falls back to the generic proxy.
      let raw="";
      try{
        const r=await fetch(`${BACKEND}/api/agents/capstone-assistant`,{method:"POST",credentials:"include",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({messages:next,track:track||getTrack(profile)||"rtcdp",
            profile:{name:profile?.name||""},extra:{scenario}})});
        const d=await r.json();
        if(!r.ok||!d.response)throw new Error(d.detail||"assistant unavailable");
        raw=d.response;
      }catch{
        const sys=AGENT_CONFIGS.capstone.sys+`\n\n--- This capstone (for grounding) ---\nobjective: ${scenario.objective||scenario.client_context||""}`;
        raw=await callAgent(next,sys,groqKey,{agentName:"CapstoneHint",logFn:null,maxTokens:200});
      }
      judgeGenericResponse(raw,"CapstoneHint").catch(()=>{});
      setHintMsgs(p=>[...p,{role:"assistant",content:raw}]);
      if(persist&&profile?.id&&hintModule){
        fetch(`${BACKEND}/api/conversations/message`,{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({member_name:profile.name,manager:profile.manager||null,module:hintModule,mode:"capstone_hint",role:"assistant",content:raw})}).catch(()=>{});
      }
    }catch(e){
      setHintMsgs(p=>[...p,{role:"assistant",content:"I'm having trouble connecting right now — try again in a moment."}]);
    }
    setHintBusy(false);
  };

  // Locked
  if(locked)return(
    <div style={{padding:"28px 24px",maxWidth:520,margin:"0 auto"}}>
      <Card style={{padding:"32px 28px",textAlign:"center"}}>
        <div style={{width:52,height:52,borderRadius:"50%",background:P.amberBg,border:`2px solid ${P.amber}`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}><Ic as={Lock} size={22} color={P.amber}/></div>
        <div style={{fontSize:17,fontWeight:500,color:P.txt,marginBottom:8}}>Capstone is locked</div>
        <div style={{fontSize:13.5,color:P.muted,lineHeight:1.7,marginBottom:16}}>Two conditions must both be met before the capstone unlocks.</div>
        <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:20}}>
          <div style={{background:allModulesDone?P.grnBg:P.surface,border:`1px solid ${allModulesDone?P.grn+"40":P.border}`,borderRadius:10,padding:"12px 16px"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
              <Ic as={allModulesDone?CheckmarkCircle:Clock} size={16} color={allModulesDone?P.grn:P.amber}/>
              <span style={{fontSize:13,fontWeight:600,color:allModulesDone?P.grn:P.txt}}>Coursework modules completed</span>
            </div>
            <Meter aria-label="Coursework modules completed" value={Math.min(100,(doneModules/Math.max(totalModules,1))*100)} valueLabel={`${doneModules} of ${totalModules}`} variant={allModulesDone?"positive":"notice"} size="M" styles={style({width:"full"})}/>
            {!allModulesDone&&<div style={{fontSize:11.5,color:P.muted,marginTop:5}}>{totalModules-doneModules} module{totalModules-doneModules===1?"":"s"} remaining — complete your learning path first.</div>}
          </div>
          <div style={{background:confOk?P.grnBg:P.surface,border:`1px solid ${confOk?P.grn+"40":P.border}`,borderRadius:10,padding:"12px 16px"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
              <Ic as={confOk?CheckmarkCircle:Clock} size={16} color={confOk?P.grn:P.amber}/>
              <span style={{fontSize:13,fontWeight:600,color:confOk?P.grn:P.txt}}>Confidence ≥ {Math.round(CAPSTONE_CONFIDENCE_GATE*100)}%</span>
            </div>
            <Meter aria-label="Confidence" value={Math.min(100,conf*100)} valueLabel={`${Math.round(conf*100)}% / ${Math.round(CAPSTONE_CONFIDENCE_GATE*100)}%`} variant={confOk?"positive":"notice"} size="M" styles={style({width:"full"})}/>
            {!confOk&&<div style={{fontSize:11.5,color:P.muted,marginTop:5}}>Use the AI Tutor (Socratic mode) — each session improves your score by ~0.05.</div>}
          </div>
        </div>
      </Card>
    </div>
  );

  // Idle — nothing generated yet
  if(status==="idle")return(
    <div style={{padding:"28px 24px",maxWidth:560,margin:"0 auto"}}>
      <Card style={{padding:"32px 28px"}}>
        <Label style={{color:P.grn,marginBottom:12}}>Confidence gate passed</Label>
        <div style={{fontSize:20,fontWeight:500,color:P.txt,letterSpacing:-.3,marginBottom:10}}>Ready to begin your capstone</div>
        <div style={{fontSize:13.5,color:P.muted,lineHeight:1.75,marginBottom:20}}>
          The Capstone Agent generates a hands-on capstone specific to the <strong>{TRACK_LABELS[track||getTrack(profile)]||"your"}</strong> path you just finished — with basic, intermediate and expert tasks that cover every module, plus a presentation deck. You have 7 days; a Capstone Assistant guides you throughout; your manager makes the final call.
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:24}}>
          {[{label:"Covers",value:"every module in your completed path"},
            {label:"Format",value:"tiered tasks (basic → expert) + deck"},
            {label:"Deadline",value:"7 days — manager can extend"},
            {label:"Guidance",value:"Capstone Assistant coaches you throughout"},
            {label:"Final review",value:"human-graded by your manager against a rubric"},
          ].map(r=>(
            <div key={r.label} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:`1px solid ${P.bfaint}`}}>
              <span style={{fontSize:13,color:P.muted}}>{r.label}</span>
              <span style={{fontSize:13,fontWeight:500,color:P.txt,textAlign:"right"}}>{r.value}</span>
            </div>
          ))}
        </div>
        <Btn full size="lg" onClick={generate}>Generate My Capstone <Ic as={ChevronRight} size={15} color="currentColor"/></Btn>
      </Card>
    </div>
  );

  // Generating
  if(status==="generating")return(
    <div style={{padding:40,textAlign:"center"}}>
      <div style={{fontSize:14.5,fontWeight:600,color:P.txt,marginBottom:6}}>Capstone Agent is generating your scenario…</div>
      <div style={{fontSize:13,color:P.muted}}>Grounded in AEP documentation · targeting {weakSkills.join(", ")}</div>
    </div>
  );

  if(!scenario)return null; // resumed with no scenario yet (shouldn't happen once status leaves "idle")

  const evalDone=(status==="ai_evaluated"||status==="manager_approved")&&aiEval;
  const canEdit=status==="generated"||status==="manager_rejected";
  const showHint=persist&&submissionId&&status!=="manager_approved";
  const statusColor=status==="manager_approved"?P.grn:status==="manager_rejected"?P.amber:P.blue;
  const statusBg=status==="manager_approved"?P.grnBg:status==="manager_rejected"?P.amberBg:P.blueGh;

  return(
    <div style={{maxWidth:760,margin:"0 auto",padding:"24px 20px 40px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:1.2,textTransform:"uppercase",color:getThemeMode()==="dark"?"#FF6A5C":"#EB1000",marginBottom:5}}>Capstone</div>
          <div style={{fontSize:16,fontWeight:700,color:P.txt,letterSpacing:-.2}}>Capstone Assessment</div>
        </div>
        <span style={{fontSize:11,fontWeight:700,color:statusColor,background:statusBg,borderRadius:5,padding:"3px 10px"}}>{CAPSTONE_STATUS_LABEL[status]}</span>
      </div>

      {status==="manager_rejected"&&managerNotes&&(
        <div style={{background:P.amberBg,border:`1px solid ${P.amber}30`,borderRadius:10,padding:"12px 16px",marginBottom:16,display:"flex",gap:10,alignItems:"flex-start"}}>
          <Ic as={AlertTriangle} size={16} color={P.amber} style={{marginTop:2}}/>
          <div>
            <Label style={{color:P.amber,marginBottom:4}}>Your manager requested changes</Label>
            <div style={{fontSize:13,color:P.txt,lineHeight:1.6}}>{managerNotes}</div>
          </div>
        </div>
      )}

      {/* 7-day deadline banner */}
      {dueAt&&(()=>{
        const due=new Date(dueAt);const now=new Date();
        const daysLeft=Math.ceil((due-now)/(1000*60*60*24));
        const overdue=daysLeft<0;const urgent=daysLeft<=2&&!overdue;
        const c=overdue?P.red:urgent?P.amber:P.blue;const bg=overdue?P.redBg:urgent?P.amberBg:P.blueGh;
        return(
          <div style={{display:"flex",alignItems:"center",gap:10,background:bg,border:`1px solid ${c}30`,borderRadius:10,padding:"10px 14px",marginBottom:14}}>
            <Ic as={Clock} size={15} color={c}/>
            <span style={{fontSize:12.5,fontWeight:600,color:c}}>
              {overdue?`Overdue by ${Math.abs(daysLeft)} day${Math.abs(daysLeft)===1?"":"s"}`:daysLeft===0?"Due today":`${daysLeft} day${daysLeft===1?"":"s"} left`}
            </span>
            <span style={{fontSize:11.5,color:P.muted,marginLeft:"auto"}}>Deadline {due.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})} · manager can extend</span>
          </div>
        );
      })()}

      <Card style={{padding:"22px 24px",marginBottom:16}}>
        <div style={{fontSize:17,fontWeight:700,color:P.txt,marginBottom:6}}>{scenario.title}</div>
        {(scenario.company||scenario.vertical)&&<div style={{fontSize:11.5,color:P.dim,marginBottom:10}}>{[scenario.company,scenario.vertical].filter(Boolean).join(" · ")}{scenario.estimated_effort_hours?` · ~${scenario.estimated_effort_hours}h`:""}</div>}
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
          {(scenario.skills_tested||[]).map(s=>(
            <span key={s} style={{fontSize:11,fontWeight:600,color:P.purple,background:P.purpleBg,borderRadius:5,padding:"2px 9px"}}>{s}</span>
          ))}
        </div>
        <div style={{fontSize:13.5,color:P.txt,lineHeight:1.8,marginBottom:14,whiteSpace:"pre-line"}}>{scenario.company_brief||scenario.client_context}</div>
        {scenario.objective&&<div style={{background:P.surface,borderRadius:10,padding:"11px 15px",marginBottom:16}}>
          <Label style={{marginBottom:4}}>Objective</Label>
          <div style={{fontSize:13.5,color:P.txt,lineHeight:1.7}}>{scenario.objective}</div>
        </div>}

        {/* Tiered tasks (basic → intermediate → expert) */}
        {Array.isArray(scenario.tasks)&&scenario.tasks.length>0&&<div style={{marginBottom:16}}>
          <Label style={{marginBottom:8}}>Tasks</Label>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {scenario.tasks.map((t,i)=>{
              const lc={basic:P.grn,intermediate:P.blue,expert:P.purple}[(t.level||"").toLowerCase()]||P.muted;
              return(
                <div key={i} style={{border:`1px solid ${P.border}`,borderLeft:`3px solid ${lc}`,borderRadius:9,padding:"12px 14px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:5,flexWrap:"wrap"}}>
                    <span style={{fontSize:10,fontWeight:700,letterSpacing:.4,textTransform:"uppercase",color:lc,background:lc+"18",borderRadius:4,padding:"2px 8px"}}>{t.level||"task"}</span>
                    <span style={{fontSize:13.5,fontWeight:600,color:P.txt}}>{t.title}</span>
                  </div>
                  <div style={{fontSize:12.5,color:P.muted,lineHeight:1.65,marginBottom:t.deliverable?6:0}}>{t.description}</div>
                  {t.deliverable&&<div style={{fontSize:12,color:P.txt}}><strong style={{color:P.dim,fontWeight:600}}>Deliver:</strong> {t.deliverable}</div>}
                  {(t.aep_products||[]).length>0&&<div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:7}}>
                    {t.aep_products.map(p=><span key={p} style={{fontSize:10,color:P.dim,background:P.surface,border:`1px solid ${P.border}`,borderRadius:4,padding:"1px 7px"}}>{p}</span>)}
                  </div>}
                </div>
              );
            })}
          </div>
        </div>}

        {/* Presentation / deck requirements */}
        {Array.isArray(scenario.deck_requirements)&&scenario.deck_requirements.length>0&&<div style={{marginBottom:16}}>
          <Label style={{marginBottom:8}}>Presentation deck — required slides</Label>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {scenario.deck_requirements.map((s,i)=>(
              <div key={i} style={{fontSize:12.5,color:P.txt,display:"flex",gap:8}}>
                <span style={{color:P.purple,fontWeight:700,flexShrink:0}}>{i+1}.</span>
                <span>{s.slide||s}{Array.isArray(s.must_cover)&&s.must_cover.length>0&&<span style={{color:P.dim}}> — {s.must_cover.join(", ")}</span>}</span>
              </div>
            ))}
          </div>
        </div>}

        {/* Submission checklist */}
        {Array.isArray(scenario.submission_checklist)&&scenario.submission_checklist.length>0&&<div style={{background:P.blueGh,border:`1px solid ${P.blue}25`,borderRadius:10,padding:"12px 16px",marginBottom:14}}>
          <Label style={{color:P.blue,marginBottom:6}}>Submission checklist</Label>
          {scenario.submission_checklist.map((c,i)=>(
            <div key={i} style={{fontSize:12.5,color:P.txt,lineHeight:1.7,display:"flex",gap:7}}><Ic as={Checkmark} size={12} color={P.blue} style={{marginTop:3,flexShrink:0}}/>{c}</div>
          ))}
        </div>}

        {/* Human-eval rubric */}
        <Label style={{marginBottom:6}}>{scenario.rubric?.length?"How this is graded (by your manager)":"Evaluation criteria"}</Label>
        <div style={{display:"flex",flexDirection:"column",gap:5}}>
          {scenario.rubric?.length
            ? scenario.rubric.map((r,i)=>(
                <div key={i} style={{display:"flex",gap:8,fontSize:13,color:P.muted,alignItems:"baseline"}}>
                  {r.weight_pct!=null&&<span style={{fontSize:11,fontWeight:700,color:P.purple,minWidth:34}}>{r.weight_pct}%</span>}
                  <span>{r.criterion}</span>
                </div>
              ))
            : (scenario.evaluation_criteria||[]).map((c,i)=>(
                <div key={i} style={{display:"flex",gap:8,fontSize:13,color:P.muted}}><span style={{color:P.dim}}>·</span>{c}</div>
              ))}
        </div>
      </Card>

      <Card style={{padding:"20px 22px",marginBottom:16}}>
        <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:8}}>Your response</div>
        <textarea value={responseText} onChange={e=>setResponseText(e.target.value)} rows={8} disabled={!canEdit}
          placeholder="Write your recommendation here — reference specific AEP concepts and justify your decision..."
          style={{width:"100%",boxSizing:"border-box",border:`1px solid ${P.border}`,borderRadius:9,padding:"12px 14px",fontSize:13.5,lineHeight:1.7,outline:"none",background:canEdit?P.bg:P.surface,color:P.txt,resize:"vertical",fontFamily:"inherit",marginBottom:12}}/>
        {canEdit&&<Btn onClick={submitResponse} disabled={!responseText.trim()}>{status==="manager_rejected"?"Resubmit for AI self-check":"Submit for AI self-check"} <Ic as={ChevronRight} size={14} color="currentColor"/></Btn>}
        {(status==="submitting"||status==="evaluating")&&<div style={{fontSize:13,color:P.muted,marginTop:10}}>{status==="submitting"?"Saving your response…":"Running your AI self-check…"}</div>}
      </Card>

      {showHint&&(
        <Card style={{padding:0,marginBottom:16,overflow:"hidden"}}>
          <div style={{padding:"12px 16px",borderBottom:`1px solid ${P.border}`}}>
            <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:2}}>Capstone Assistant</div>
            <div style={{fontSize:11.5,color:P.muted}}>Your AI guide for this capstone — clarifies tasks and points you to the right Adobe capabilities, but won't do the work for you.</div>
          </div>
          <div ref={hintChatRef} style={{maxHeight:260,overflowY:"auto",padding:"14px 16px",display:"flex",flexDirection:"column",gap:10}}>
            {hintMsgs.length===0&&<div style={{fontSize:12.5,color:P.dim}}>No questions yet — ask about anything you're unsure how to approach.</div>}
            {hintMsgs.map((m,i)=>(
              <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                <div style={{maxWidth:"85%",padding:"8px 12px",borderRadius:m.role==="user"?"11px 11px 3px 11px":"11px 11px 11px 3px",background:m.role==="user"?P.blue:P.surface,color:m.role==="user"?"#fff":P.txt,fontSize:12.5,lineHeight:1.6,border:m.role==="assistant"?`1px solid ${P.border}`:"none"}}>{m.content}</div>
              </div>
            ))}
            {hintBusy&&<div style={{fontSize:12,color:P.muted}}>···</div>}
          </div>
          <div style={{padding:"10px 12px",borderTop:`1px solid ${P.border}`,display:"flex",gap:8}}>
            <input value={hintInput} onChange={e=>setHintInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendHint()}
              placeholder="What are you stuck on?"
              style={{flex:1,border:`1px solid ${P.border}`,borderRadius:9,padding:"8px 12px",fontSize:13,outline:"none",background:P.bg,color:P.txt}}/>
            <Btn onClick={sendHint} disabled={hintBusy||!hintInput.trim()} size="sm">Ask</Btn>
          </div>
        </Card>
      )}

      {evalDone&&(
        <Card style={{padding:"20px 22px"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
            <div style={{fontSize:13.5,fontWeight:600,color:P.txt}}>AI self-check</div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:20,fontWeight:700,color:aiEval.score>=70?P.grn:aiEval.score>=40?P.amber:P.red,letterSpacing:-.5}}>{aiEval.score}/100</span>
              <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:11,fontWeight:700,color:aiEval.pass?P.grn:P.amber,background:aiEval.pass?P.grnBg:P.amberBg,borderRadius:5,padding:"2px 9px"}}>
                <Ic as={aiEval.pass?CheckmarkCircle:AlertTriangle} size={12} color={aiEval.pass?P.grn:P.amber}/>{aiEval.pass?"Meets the bar":"Needs work"}
              </span>
            </div>
          </div>
          <div style={{fontSize:13.5,color:P.txt,lineHeight:1.75,marginBottom:14}}>{aiEval.feedback}</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
            <div>
              <Label style={{color:P.grn,marginBottom:6}}>Strengths</Label>
              {(aiEval.strengths||[]).length?(aiEval.strengths||[]).map((s,i)=><div key={i} style={{fontSize:12.5,color:P.muted,marginBottom:4,display:"flex",gap:6}}><Ic as={Checkmark} size={12} color={P.grn} style={{marginTop:2}}/>{s}</div>):<div style={{fontSize:12.5,color:P.dim}}>—</div>}
            </div>
            <div>
              <Label style={{color:P.amber,marginBottom:6}}>Gaps</Label>
              {(aiEval.gaps||[]).length?(aiEval.gaps||[]).map((g,i)=><div key={i} style={{fontSize:12.5,color:P.muted,marginBottom:4}}>· {g}</div>):<div style={{fontSize:12.5,color:P.dim}}>—</div>}
            </div>
          </div>
          <div style={{fontSize:12.5,color:P.txt,marginBottom:14}}><strong>Recommendation:</strong> {aiEval.recommendation}</div>
          <div style={{display:"flex",gap:8,alignItems:"flex-start",background:status==="manager_approved"?P.grnBg:P.amberBg,border:`1px solid ${(status==="manager_approved"?P.grn:P.amber)}30`,borderRadius:9,padding:"10px 14px"}}>
            <Ic as={status==="manager_approved"?CheckmarkCircle:Clock} size={14} color={status==="manager_approved"?P.grn:P.amber} style={{marginTop:1}}/>
            <span style={{fontSize:12,color:status==="manager_approved"?P.grn:P.amber,fontWeight:600}}>
              {status==="manager_approved"?"Your manager has reviewed this and marked your capstone complete.":"This is a self-check only — it does not complete your capstone. Your manager still needs to review your response and mark it complete."}
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}



// ── Status Legend · shows live vs simulated features ─────────────────────────
function StatusLegend({githubToken,groqKey}){
  const [lgStatus,setLgStatus]=useState(null); // LangGraph agent status from backend
  useEffect(()=>{
    fetch(`${BACKEND}/api/agents/status`)
      .then(r=>r.json()).then(d=>setLgStatus(d))
      .catch(()=>setLgStatus({langgraph_available:false,agents_ready:0,graphs_compiled:[]}));
  },[]);

  const items=[
    {label:"Socratic Agent",live:true},{label:"Reasoning Agent",live:true},
    {label:"Evaluation Agent",live:true},{label:"Cross-Skilling Agent",live:true},
    {label:"Study Aid Agent",live:true},{label:"Team Intelligence Agent",live:true},
    {label:"CAT / IRT / BKT",live:true},
    {label:"AdobeDocs RAG",live:!!githubToken,note:githubToken?"github.com/AdobeDocs":"local fallback"},
    {label:"Adobe IMS / SSO",live:false,note:"simulated"},
  ];
  const [open,setOpen]=useState(false);
  const liveCount=items.filter(i=>i.live).length;
  return(
    <div style={{position:"fixed",bottom:0,left:0,right:0,zIndex:999,fontFamily:"system-ui,-apple-system,sans-serif"}}>
      <div onClick={()=>setOpen(o=>!o)} style={{background:"#111118",padding:"5px 20px",display:"flex",alignItems:"center",gap:12,cursor:"pointer",borderTop:"1px solid #1E1E28"}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div style={{width:6,height:6,borderRadius:"50%",background:"#3DDC97"}}/>
          <span style={{fontSize:10.5,color:"#3DDC97",fontWeight:600}}>{liveCount} live</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div style={{width:6,height:6,borderRadius:"50%",background:"#3E4258"}}/>
          <span style={{fontSize:10.5,color:"#5A5E78"}}>{items.length-liveCount} simulated</span>
        </div>
        {lgStatus&&<div style={{display:"flex",alignItems:"center",gap:5}} title={lgStatus.engine||""}>
          <div style={{width:6,height:6,borderRadius:"50%",background:lgStatus.agents_ready>0?"#A3E635":"#E34850"}}/>
          <span style={{fontSize:10.5,color:lgStatus.agents_ready>0?"#A3E635":"#E34850",fontWeight:600}}>
            Agents {lgStatus.agents_ready>0?`${lgStatus.agents_ready}/8`:"off"}
          </span>
        </div>}
        <div style={{flex:1}}/>
        <span style={{fontSize:10,color:"#3E4258"}}>{open?"collapse":"system status"}</span>
      </div>
      {open&&<div style={{background:"#111118",borderTop:"1px solid #1E1E28",padding:"12px 20px"}}>
        {/* LangGraph status banner */}
        {lgStatus&&<div style={{marginBottom:10,padding:"8px 12px",background:"#0D1B14",border:`1px solid ${lgStatus.langgraph_available?"#1A4D2E":"#2E1A1A"}`,borderRadius:7,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:lgStatus.langgraph_available?"#3DDC97":"#E34850"}}/>
            <span style={{fontSize:11,fontWeight:500,color:lgStatus.langgraph_available?"#3DDC97":"#E34850",letterSpacing:.3}}>LangGraph {lgStatus.langgraph_available?"active":"not installed"}</span>
          </div>
          <span style={{fontSize:10.5,color:"#3DDC97",fontWeight:600}}>{lgStatus.agents_ready}/8 graphs compiled</span>
          {lgStatus.engine&&<><span style={{fontSize:10,color:"#5A5E78"}}>·</span><span style={{fontSize:10,color:"#3E4258"}}>{lgStatus.engine}</span></>}
        </div>}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:"8px 24px"}}>
          {items.map(item=>(
            <div key={item.label} style={{display:"flex",alignItems:"center",gap:7}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:item.live?"#3DDC97":"#3E4258",flexShrink:0}}/>
              <span style={{fontSize:11,color:item.live?"#C8CAD8":"#4A4E62",fontWeight:item.live?500:400}}>{item.label}</span>
              {item.note&&<span style={{fontSize:10,color:"#2E3048"}}>· {item.note}</span>}
            </div>
          ))}
        </div>
      </div>}
    </div>
  );
}

// ── LOGIN ────────────────────────────────────────────────────────────────────
// Email → persona routing (simulates Adobe IMS lookup)
const EMAIL_MAP={
  "alex.carter@adobe.com":"nj","alex@adobe.com":"nj",
  "sam.chen@adobe.com":"nj2","sam@adobe.com":"nj2",
  "priya.sharma@adobe.com":"nj3","priya@adobe.com":"nj3",
  "jennifer.park@adobe.com":"exp","jennifer@adobe.com":"exp",
  "raj.mehta@adobe.com":"exp2","raj@adobe.com":"exp2",
  "michael.torres@adobe.com":"mgr","michael@adobe.com":"mgr",
  "emma.wilson@adobe.com":"admin","emma@adobe.com":"admin",
  "demo@adobe.com":"demo","demo@nexus.com":"demo",
};

// ── Approvals Tab (MGR) — loads from DB, syncs with App state ────────────────
function ApprovalsTab({pendingApprovals,setPendingApprovals,profile}){
  const [loaded,setLoaded]=useState(false);
  useEffect(()=>{
    fetch(`${BACKEND}/api/onboarding/pending?manager=${encodeURIComponent(profile?.name||"")}`)
      .then(r=>r.json())
      .then(data=>{
        if(data.requests?.length){
          setPendingApprovals(prev=>{
            const emails=new Set(prev.map(r=>r.email));
            const fromDB=data.requests.filter(r=>!emails.has(r.email)).map(r=>({
              name:r.name,preferredName:r.preferred_name,email:r.email,
              joiningDate:(r.joining_date||"").split("T")[0],
              team:r.team,manager:r.manager,id:r.id
            }));
            return [...prev,...fromDB];
          });
        }
        setLoaded(true);
      })
      .catch(()=>setLoaded(true));
  },[]);
  const doAction=async(req,i,action)=>{
    if(req.id){
      try{await fetch(`${BACKEND}/api/onboarding/${req.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,manager_name:profile?.name})});}
      catch(e){console.warn("DB action failed",e);}
    }
    setPendingApprovals(p=>p.filter((_,j)=>j!==i));
  };
  return(
    <div style={{maxWidth:720,margin:"0 auto",padding:"28px 24px"}}>
      <div style={{marginBottom:20}}>
        <div style={{fontSize:16,fontWeight:500,color:P.txt,letterSpacing:-.2,marginBottom:4}}>Onboarding Approvals</div>
        <div style={{fontSize:13,color:P.muted}}>Requests are saved to the database — they persist across sessions.</div>
      </div>
      {!loaded&&<div style={{fontSize:13,color:P.muted}}>Loading from database…</div>}
      {loaded&&pendingApprovals.length===0&&<div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,padding:"32px",textAlign:"center"}}>
        <div style={{fontSize:28,marginBottom:10}}>✓</div>
        <div style={{fontSize:15,fontWeight:600,color:P.txt,marginBottom:4}}>All caught up</div>
        <div style={{fontSize:13,color:P.muted}}>No pending approval requests.</div>
      </div>}
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {pendingApprovals.map((req,i)=>(
          <div key={req.email||i} style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,padding:"20px 22px",boxShadow:P.shadow}}>
            <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:14}}>
              <div style={{width:42,height:42,borderRadius:"50%",background:P.blue,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:500,fontSize:16,flexShrink:0}}>{req.name[0]}</div>
              <div style={{flex:1}}>
                <div style={{fontSize:15,fontWeight:600,color:P.txt}}>{req.name}</div>
                <div style={{fontSize:12.5,color:P.muted}}>{req.email}</div>
              </div>
              <span style={{fontSize:11,fontWeight:600,color:P.amber,background:P.amberBg,borderRadius:6,padding:"3px 10px"}}>Pending</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:16}}>
              {[{l:"Team",v:req.team},{l:"Manager",v:req.manager},{l:"Joining",v:req.joiningDate||req.joining_date},{l:"Email",v:req.email}].map(r=>(
                <div key={r.l} style={{background:P.surface,borderRadius:8,padding:"8px 12px"}}>
                  <div style={{fontSize:10.5,color:P.dim,marginBottom:2}}>{r.l}</div>
                  <div style={{fontSize:13,fontWeight:500,color:P.txt}}>{r.v||"—"}</div>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:8}}>
              <Btn size="sm" onClick={()=>doAction(req,i,"approve")} style={{flex:1}}>✓ Approve — add to {req.team}</Btn>
              <Btn variant="secondary" size="sm" onClick={()=>doAction(req,i,"decline")} style={{flex:1}}>Decline</Btn>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PendingApprovalScreen({info,onBack}){
  return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:P.bg,fontFamily:"'adobe-clean','Source Sans 3',system-ui,sans-serif",padding:24}}>
      <GlobalStyles/>
      <div style={{maxWidth:480,width:"100%"}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{width:56,height:56,borderRadius:"50%",background:P.amberBg,border:`2px solid ${P.amber}`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px",fontSize:24}}>⏳</div>
          <div style={{fontSize:20,fontWeight:500,color:P.txt,marginBottom:6}}>Waiting for approval</div>
          <div style={{fontSize:13.5,color:P.muted,lineHeight:1.7}}>Your onboarding request has been sent to <strong style={{color:P.txt}}>{info.manager}</strong>. You'll get access once they approve you — this usually takes a few hours.</div>
        </div>
        <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,padding:"18px 20px",marginBottom:20}}>
          <div style={{fontSize:12,fontWeight:600,color:P.dim,letterSpacing:.4,marginBottom:12}}>Your submission</div>
          {[{l:"Name",v:info.name},{l:"Preferred name",v:info.preferredName},{l:"Email",v:info.email},{l:"Joining date",v:info.joiningDate},{l:"Team",v:info.team},{l:"Manager",v:info.manager}].map(r=>(
            <div key={r.l} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${P.bfaint}`}}>
              <span style={{fontSize:12.5,color:P.muted}}>{r.l}</span>
              <span style={{fontSize:12.5,fontWeight:500,color:P.txt}}>{r.v}</span>
            </div>
          ))}
        </div>
        <div style={{background:P.blueGh,border:`1px solid ${P.blue}20`,borderRadius:10,padding:"12px 16px",marginBottom:20,fontSize:13,color:P.muted,lineHeight:1.65}}>
          While you wait, ask your manager to check the <strong>Approvals</strong> tab in their Nexus dashboard.
        </div>
        <button onClick={onBack} style={{width:"100%",background:"transparent",border:`1px solid ${P.border}`,borderRadius:9,padding:"11px 0",fontSize:13.5,fontWeight:500,cursor:"pointer",color:P.muted,fontFamily:"inherit"}}>Back to Sign In</button>
      </div>
    </div>
  );
}

// Shown once right after a fresh IMS sign-in for directory-sourced employees
// (already auto-approved — no manager gate). Lets them review their HR data and
// optionally change their preferred name before entering the dashboard.
function ProfileConfirmScreen({persona,profile,onContinue}){
  const [preferredName,setPreferredName]=useState(profile?.preferred_name||profile?.name?.split(" ")[0]||"");
  const [saving,setSaving]=useState(false);
  const TENURE_LABEL={nj:"New Joiner",nj2:"New Joiner",exp:"Experienced"}[persona]||"";

  const handleContinue=async()=>{
    setSaving(true);
    const changed=preferredName.trim()&&preferredName.trim()!==(profile?.preferred_name||"");
    if(changed){
      try{
        await fetch(`${BACKEND}/api/profile/update`,{method:"PUT",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({email:profile.email,persona:"learner",preferred_name:preferredName.trim()})});
      }catch{}
    }
    onContinue({...profile,preferred_name:changed?preferredName.trim():profile.preferred_name});
  };

  const ROW=(l,v)=>(
    <div style={{display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:`1px solid ${P.bfaint}`}}>
      <span style={{fontSize:12.5,color:P.muted}}>{l}</span>
      <span style={{fontSize:12.5,fontWeight:500,color:P.txt}}>{v||"—"}</span>
    </div>
  );

  return(
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:P.bg,fontFamily:"'adobe-clean','Source Sans 3',system-ui,sans-serif",padding:24}}>
      <GlobalStyles/>
      <div style={{maxWidth:480,width:"100%"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <div style={{width:56,height:56,borderRadius:"50%",background:P.grnBg,border:`2px solid ${P.grn}`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px",fontSize:24}}>✓</div>
          <div style={{fontSize:20,fontWeight:500,color:P.txt,marginBottom:6}}>Welcome, {profile?.name}</div>
          <div style={{fontSize:13.5,color:P.muted,lineHeight:1.7}}>Here's what we have on file for you ({TENURE_LABEL}). Review the details and continue to your dashboard.</div>
        </div>
        <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,padding:"18px 20px",marginBottom:20}}>
          <div style={{fontSize:12,fontWeight:600,color:P.dim,letterSpacing:.4,marginBottom:8}}>Your profile</div>
          {ROW("Name",profile?.name)}
          {ROW("Email",profile?.email)}
          {ROW("Role",profile?.role)}
          {ROW("Team",profile?.team)}
          {ROW("Manager",profile?.manager)}
          {ROW("Joining date",profile?.joining_date)}
          <div style={{marginTop:14}}>
            <label style={{fontSize:12.5,fontWeight:600,color:P.txt,display:"block",marginBottom:5}}>Preferred name</label>
            <input value={preferredName} onChange={e=>setPreferredName(e.target.value)} placeholder="e.g. Priya"
              style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box"}}/>
          </div>
        </div>
        <button onClick={handleContinue} disabled={saving}
          style={{width:"100%",background:P.blue,color:"#fff",border:"none",borderRadius:9,padding:"11px 0",fontSize:13.5,fontWeight:600,cursor:saving?"default":"pointer",fontFamily:"inherit",opacity:saving?.6:1}}>
          {saving?"Saving…":<>Continue to Dashboard <Ic as={ChevronRight} size={14} color="currentColor"/></>}
        </button>
      </div>
    </div>
  );
}

function OnboardingForm({email,onSubmit,onPendingApproval,prefill,inDirectory}){
  const pf=prefill||{};
  // Directory-sourced (locked) fields come from the uploaded HR roster; when the
  // user isn't in the directory we fall back to a fully editable manual form.
  const locked=!!inDirectory;
  const [form,setForm]=useState({
    name:pf.name||"",
    preferredName:(pf.name?String(pf.name).split(" ")[0]:"")||"",
    joiningDate:pf.joining_date||"",
    role:pf.role||"AEP Analyst",
    team:pf.team||"RTCDP",
    manager:pf.manager||"",
  });
  const [step,setStep]=useState(1); // 1=form, 2=confirm
  const [submitting,setSubmitting]=useState(false);
  const [submitError,setSubmitError]=useState("");
  const [managerOptions,setManagerOptions]=useState(["Michael Torres","Dhanesh Kumar","Lavanya Reddy"]);
  useEffect(()=>{
    if(locked)return; // manual form only needs the manager dropdown
    fetch(`${BACKEND}/api/manager/list`).then(r=>r.json()).then(d=>{
      if(d?.managers?.length)setManagerOptions(prev=>[...new Set([...d.managers,...prev])]);
    }).catch(()=>{});
  },[locked]);
  const set=k=>e=>setForm(f=>({...f,[k]:e.target.value}));
  // No password anymore — Adobe IMS is the only credential. Manager may be blank
  // for manual users (they pick one); for directory users it's pre-filled.
  const valid=form.name&&form.preferredName&&form.joiningDate&&form.manager;

  const handleSubmit=async()=>{
    setSubmitting(true);setSubmitError("");
    try{
      const res=await fetch(`${BACKEND}/api/onboarding`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({name:form.name,preferred_name:form.preferredName,email,
          joining_date:form.joiningDate||null,role:form.role,
          team:form.team,manager:form.manager})
      });
      if(!res.ok){
        const err=await res.json().catch(()=>({}));
        setSubmitError(err.detail||`Server error ${res.status} — check the backend is running.`);
        setSubmitting(false);return;
      }
      setSubmitting(false);
      if(onPendingApproval) onPendingApproval({...form,email});
    }catch(e){
      setSubmitError("Could not reach the server — check the backend is running.");
      setSubmitting(false);
    }
  };

  const RO=(label,value)=>(   // read-only field (directory-sourced)
    <div style={{marginBottom:14}}>
      <label style={{fontSize:12.5,fontWeight:600,color:P.txt,display:"block",marginBottom:5}}>{label}</label>
      <div style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13.5,color:P.txt,background:P.surface,boxSizing:"border-box"}}>{value||"—"}</div>
    </div>
  );

  if(step===2)return(
    <div>
      <div style={{fontSize:16,fontWeight:500,color:P.txt,marginBottom:4}}>Confirm your details</div>
      <div style={{fontSize:13,color:P.muted,marginBottom:16}}>This will be sent to {form.manager||"your manager"} for approval.</div>
      <div style={{background:P.surface,border:`1px solid ${P.border}`,borderRadius:10,padding:"12px 16px",marginBottom:16}}>
        {[{l:"Name",v:form.name},{l:"Preferred name",v:form.preferredName},{l:"Email",v:email},{l:"Role",v:form.role},{l:"Joining date",v:form.joiningDate},{l:"Team",v:form.team},{l:"Manager",v:form.manager}].map(r=>(
          <div key={r.l} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:`1px solid ${P.bfaint}`}}>
            <span style={{fontSize:12.5,color:P.muted}}>{r.l}</span>
            <span style={{fontSize:12.5,fontWeight:500,color:P.txt}}>{r.v}</span>
          </div>
        ))}
      </div>
      {submitError&&<div style={{background:P.redBg,border:`1px solid ${P.red}30`,borderRadius:8,padding:"9px 12px",fontSize:13,color:P.red,marginBottom:12}}>{submitError}</div>}
      <div style={{display:"flex",gap:8}}>
        <button onClick={()=>{setStep(1);setSubmitError("");}} style={{flex:1,background:"transparent",border:`1px solid ${P.border}`,borderRadius:9,padding:"10px 0",fontSize:13,cursor:"pointer",color:P.muted,fontFamily:"inherit"}}>Edit</button>
        <button onClick={handleSubmit} disabled={submitting} style={{flex:2,background:P.blue,color:"#fff",border:"none",borderRadius:9,padding:"10px 0",fontSize:13.5,fontWeight:600,cursor:"pointer",fontFamily:"inherit",opacity:submitting?.6:1}}>
          {submitting?"Submitting...":<>Send for approval <Ic as={ChevronRight} size={14} color="currentColor"/></>}
        </button>
      </div>
    </div>
  );

  return(
    <div>
      <div style={{fontSize:16,fontWeight:500,color:P.txt,marginBottom:4}}>{locked?"Confirm your profile":"Create your Nexus account"}</div>
      <div style={{fontSize:13,color:P.muted,marginBottom:20}}>
        {locked
          ?"Set your preferred name and submit — your manager will approve access."
          :"Fill in your details and your manager will approve your access."}
      </div>

      {/* Full name — locked if from directory */}
      {locked?RO("Full name",form.name):(
        <div style={{marginBottom:14}}>
          <label style={{fontSize:12.5,fontWeight:600,color:P.txt,display:"block",marginBottom:5}}>Full name</label>
          <input placeholder="e.g. Priya Sharma" value={form.name} onChange={set("name")}
            style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box"}}/>
        </div>
      )}

      {/* Preferred name — always editable */}
      <div style={{marginBottom:14}}>
        <label style={{fontSize:12.5,fontWeight:600,color:P.txt,display:"block",marginBottom:5}}>Preferred name</label>
        <input placeholder="e.g. Priya" value={form.preferredName} onChange={set("preferredName")}
          style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box"}}/>
      </div>

      {/* Joining date */}
      {locked?RO("Joining date",form.joiningDate):(
        <div style={{marginBottom:14}}>
          <label style={{fontSize:12.5,fontWeight:600,color:P.txt,display:"block",marginBottom:5}}>Joining date</label>
          <input type="date" value={form.joiningDate} onChange={set("joiningDate")}
            style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box"}}/>
        </div>
      )}

      {/* Role */}
      {locked?RO("Role",form.role):(
        <div style={{marginBottom:14}}>
          <label style={{fontSize:12.5,fontWeight:600,color:P.txt,display:"block",marginBottom:5}}>Role</label>
          <select value={form.role} onChange={set("role")} style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none"}}>
            {["AEP Analyst","Analytics Analyst","AEP Developer","AEP Admin","Campaign Manager","Other"].map(r=><option key={r}>{r}</option>)}
          </select>
        </div>
      )}

      {/* Team */}
      {locked?RO("Team",form.team):(
        <div style={{marginBottom:14}}>
          <label style={{fontSize:12.5,fontWeight:600,color:P.txt,display:"block",marginBottom:5}}>Team</label>
          <select value={form.team} onChange={set("team")} style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none"}}>
            {["RTCDP","AEP-DE","DA","DE","Analytics"].map(t=><option key={t}>{t}</option>)}
          </select>
        </div>
      )}

      {/* Manager */}
      {locked?RO("Manager",form.manager):(
        <div style={{marginBottom:14}}>
          <label style={{fontSize:12.5,fontWeight:600,color:P.txt,display:"block",marginBottom:5}}>Manager</label>
          <select value={form.manager} onChange={set("manager")} style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none"}}>
            <option value="">Select your manager…</option>
            {managerOptions.map(m=><option key={m}>{m}</option>)}
          </select>
        </div>
      )}

      <button onClick={()=>valid&&setStep(2)} disabled={!valid}
        style={{width:"100%",marginTop:6,background:valid?P.blue:"#aaa",color:"#fff",border:"none",borderRadius:9,padding:"11px 0",fontSize:13.5,fontWeight:600,cursor:valid?"pointer":"not-allowed",fontFamily:"inherit"}}>
        Review & Submit →
      </button>
    </div>
  );
}

// ── Login glass-card form helpers (light text + inputs on the dark card) ─────
const LOGIN_BACK={background:"none",border:"none",color:"rgba(255,255,255,.85)",fontSize:13,fontWeight:500,cursor:"pointer",padding:0,marginBottom:16,fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:2};
const LOGIN_LINK={background:"none",border:"none",color:"#7CB8FF",fontWeight:600,cursor:"pointer",padding:0,fontFamily:"inherit",fontSize:12.5};
function GlassField({label,optional,invalid,...p}){
  return(<div style={{marginBottom:14}}>
    <label style={{display:"block",fontSize:13,fontWeight:500,color:"#fff",marginBottom:6}}>{label}{optional&&<span style={{color:"rgba(255,255,255,.55)",fontWeight:400}}> (optional)</span>}</label>
    <input {...p} style={{width:"100%",height:46,borderRadius:10,border:`1px solid ${invalid?"#FF8A80":"rgba(255,255,255,.4)"}`,background:"rgba(255,255,255,.92)",padding:"0 14px",fontSize:14,color:"#222",outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
  </div>);
}
function GlassSubmit({children,disabled}){
  return(<button type="submit" disabled={disabled} style={{width:"100%",height:48,borderRadius:999,background:"#1473E6",color:"#fff",border:"none",fontSize:15,fontWeight:600,cursor:disabled?"default":"pointer",opacity:disabled?.7:1,fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center",lineHeight:1,marginTop:2}}>{children}</button>);
}
const LOGIN_ERR={background:"rgba(255,90,80,.16)",border:"1px solid rgba(255,120,110,.5)",borderRadius:8,padding:"9px 12px",fontSize:13,color:"#FFB4AB",marginBottom:12};

const LOGIN_BGS=["/images/login-bg.jpg","/images/login-bg-2.jpg"];
function Login({onLogin,onPendingApproval,onManagerPending,imsInit}){
  // Pick a background at random on each visit so the landing screen varies per login.
  const [bgImg]=useState(()=>LOGIN_BGS[Math.floor(Math.random()*LOGIN_BGS.length)]);
  const [email,setEmail]=useState(imsInit?.email||"");
  const [emailError,setEmailError]=useState("");
  const [showOnboarding,setShowOnboarding]=useState(!!imsInit?.openOnboarding);
  // Adobe IMS is the primary sign-in; the email/account/demo paths are fallbacks.
  const [imsAvail,setImsAvail]=useState(false);
  const [imsMsg,setImsMsg]=useState(imsInit?.message||"");
  useEffect(()=>{ imsConfigured().then(setImsAvail); },[]);
  // imsInit arrives asynchronously (after the mount effect's IMS round-trip
  // completes), which is AFTER Login's first render — so the useState() calls
  // above capture a stale null. Re-sync whenever imsInit actually changes so the
  // onboarding form / pending message / email prefill actually show up.
  useEffect(()=>{
    if(!imsInit)return;
    if(imsInit.email)setEmail(imsInit.email);
    if(imsInit.openOnboarding)setShowOnboarding(true);
    if(imsInit.message)setImsMsg(imsInit.message);
  },[imsInit]);
  const [loginMode,setLoginMode]=useState("main"); // main | account | manager
  const [acctEmail,setAcctEmail]=useState("");
  const [acctPwd,setAcctPwd]=useState("");
  const [acctError,setAcctError]=useState("");
  const [acctLoading,setAcctLoading]=useState(false);
  const [mgrView,setMgrView]=useState("signin"); // signin | register
  const [mgrName,setMgrName]=useState("");
  const [mgrEmail,setMgrEmail]=useState("");
  const [mgrPwd,setMgrPwd]=useState("");
  const [mgrPwd2,setMgrPwd2]=useState("");
  const [mgrTeam,setMgrTeam]=useState("");
  const [mgrError,setMgrError]=useState("");
  const [mgrLoading,setMgrLoading]=useState(false);

  const demos=[
    {p:"nj",   name:"Alex Carter",   sub:"New Joiner · Week 3 · At risk",         i:"A",c:"#2357E8"},
    {p:"nj2",  name:"Sam Chen",      sub:"New Joiner · Week 1 · Just started",    i:"S",c:"#0891B2"},
    {p:"nj3",  name:"Priya Sharma",  sub:"New Joiner · Capstone just unlocked",   i:"P",c:"#C2410C"},
    {p:"demo", name:"Demo User",     sub:"Experienced · Year 1 · RTCDP team",       i:"D",c:"#6030D0"},
    {p:"exp",  name:"Jennifer Park", sub:"Analytics Engineer · 3 years",           i:"J",c:"#097348"},
    {p:"exp2", name:"Raj Mehta",     sub:"Experienced · Capstone just unlocked",  i:"R",c:"#0F766E"},
    {p:"mgr",  name:"Michael Torres",sub:"People Manager · 5 years",              i:"M",c:"#B86B00"},
    {p:"admin",name:"Emma Wilson",   sub:"Platform Administrator",                 i:"E",c:"#6030D0"},
  ];

  const handleEmailLogin=()=>{
    const key=email.trim().toLowerCase();
    const persona=EMAIL_MAP[key];
    if(persona){ onLogin(persona); }
    else if(key.endsWith("@adobe.com")){ setShowOnboarding(true); }
    else{ setEmailError("Please use your Adobe email address (@adobe.com)"); }
  };

  const handleAccountLogin=async()=>{
    if(!acctEmail.trim()||!acctPwd.trim()){setAcctError("Email and password are required.");return;}
    setAcctLoading(true);setAcctError("");
    try{
      const res=await fetch(`${BACKEND}/api/auth/login`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email:acctEmail.trim().toLowerCase(),password:acctPwd})
      });
      const data=await res.json();
      if(!res.ok){
        setAcctError(data.detail||"Login failed.");
      } else if(data.ok===false){
        if(data.status==="pending"){
          // Route to pending screen with their info
          onPendingApproval({name:data.name,email:acctEmail.trim(),status:"pending"});
        } else {
          setAcctError(data.message||"Login failed.");
        }
      } else if(data.ok===true&&data.profile){
        // Build profile object from DB data and route to NJDash
        const pr=data.profile;
        const initials=(pr.preferred_name||pr.name||"U")[0].toUpperCase();
        const builtProfile={
          ...PROFILES[pr.persona==="exp"?'exp':'nj'],
          id:pr.id,
          name:pr.name,
          preferred_name:pr.preferred_name,
          email:pr.email,
          team:pr.team,
          manager:pr.manager,
          joining_date:pr.joining_date,
          capstone_started_at:pr.capstone_started_at||null,
          username:pr.username||null,
          avatar_emoji:pr.avatar_emoji||null,
          avatar_color:pr.avatar_color||null,
          tenure:pr.tenure||"Week 1",
          initial:initials,
          role:pr.persona==="exp"?"Experienced Employee":"New Joiner",
          persona:pr.persona||"nj",
          conf:0.0,bw:85,
          story:`${pr.preferred_name||pr.name} on the ${pr.team} team, joined ${pr.joining_date}.`,
        };
        onLogin(pr.persona||"nj",builtProfile);
      }
    }catch(e){
      setAcctError("Could not reach server. Check backend is running.");
    }
    setAcctLoading(false);
  };

  const handleManagerLogin=async()=>{
    if(!mgrEmail.trim()||!mgrPwd.trim()){setMgrError("Email and password are required.");return;}
    setMgrLoading(true);setMgrError("");
    try{
      const res=await fetch(`${BACKEND}/api/manager/login`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({email:mgrEmail.trim().toLowerCase(),password:mgrPwd})
      });
      const data=await res.json();
      if(!res.ok){ setMgrError(data.detail||"Sign in failed."); }
      else if(data.ok===false){
        if(data.status==="pending"){
          onManagerPending({name:data.name,email:mgrEmail.trim(),team:mgrTeam||"—",manager:"the platform administrator",preferredName:data.name,joiningDate:"—"});
        } else {
          setMgrError(data.message||"Sign in failed.");
        }
      }
      else if(data.ok&&data.profile){ onLogin("mgr",data.profile); }
    }catch(e){ setMgrError("Could not reach server. Check backend is running."); }
    setMgrLoading(false);
  };

  const handleManagerRegister=async()=>{
    if(!mgrName.trim()||!mgrEmail.trim()||!mgrPwd.trim()){setMgrError("Name, email, and password are required.");return;}
    if(!mgrEmail.trim().toLowerCase().endsWith("@adobe.com")){setMgrError("Please use your Adobe email address (@adobe.com).");return;}
    if(mgrPwd.length<6){setMgrError("Password must be at least 6 characters.");return;}
    if(mgrPwd!==mgrPwd2){setMgrError("Passwords do not match.");return;}
    setMgrLoading(true);setMgrError("");
    try{
      const res=await fetch(`${BACKEND}/api/manager/register`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({name:mgrName.trim(),email:mgrEmail.trim().toLowerCase(),password:mgrPwd,team:mgrTeam.trim()})
      });
      const data=await res.json();
      if(!res.ok){ setMgrError(data.detail||"Registration failed."); setMgrLoading(false); return; }
      // Registration always starts pending — an admin must approve before this account can sign in
      onManagerPending({name:mgrName.trim(),email:mgrEmail.trim(),team:mgrTeam.trim()||"—",manager:"the platform administrator",preferredName:mgrName.trim(),joiningDate:"—"});
    }catch(e){ setMgrError("Could not reach server. Check backend is running."); }
    setMgrLoading(false);
  };

  return(<div style={{minHeight:"100vh",position:"relative",overflow:"hidden",display:"flex",alignItems:"center",fontFamily:"'adobe-clean','Source Sans 3',system-ui,sans-serif",
    background:"radial-gradient(55% 75% at 12% 42%,rgba(120,50,190,.85),transparent 60%),radial-gradient(50% 65% at 88% 14%,rgba(240,112,60,.9),transparent 55%),radial-gradient(75% 85% at 72% 92%,rgba(190,58,150,.8),transparent 60%),linear-gradient(135deg,#241640,#4a2072 45%,#7a2e5e 100%)"}}>
    <GlobalStyles/>
    {/* Full-bleed background image (falls back to the gradient above if absent) */}
    <img src={bgImg} alt="" onError={e=>{e.currentTarget.style.display="none";}} style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",zIndex:0}}/>
    <div style={{position:"absolute",inset:0,zIndex:1,background:"linear-gradient(90deg,rgba(15,6,26,.62) 0%,rgba(15,6,26,.32) 45%,rgba(15,6,26,.10) 100%)"}}/>

    <div style={{position:"relative",zIndex:2,display:"flex",alignItems:"center",width:"100%",flexWrap:"wrap",gap:24,padding:"32px 0"}}>
      {/* Left branding */}
      <div style={{flex:"1 1 360px",padding:"0 clamp(28px,6vw,72px)",color:"#fff",minWidth:270}}>
        <div style={{display:"flex",alignItems:"center",gap:13,marginBottom:14}}>
          <svg width="40" height="36" viewBox="0 0 29 26" fill="none" aria-label="Adobe"><path d="M10.0158 20.23H13.9542L16.4333 25.1033H20.0317L14.1667 9.7325L10.0158 20.23ZM0 0V25.5L10.5117 0H0ZM17.68 0L28.3333 25.2308V0H17.68Z" fill="#fff"/></svg>
          <span style={{fontSize:30,fontWeight:600,letterSpacing:-.5}}>Nexus</span>
        </div>
        <div style={{fontSize:12.5,fontWeight:500,letterSpacing:1.4,textTransform:"uppercase",color:"rgba(255,255,255,.82)",marginBottom:14}}>Adobe Internal</div>
        <h1 style={{margin:"0 0 14px",fontSize:"clamp(28px,4vw,40px)",fontWeight:600,lineHeight:1.1,letterSpacing:-.6,maxWidth:460}}>Learning that knows who you are.</h1>
        <p style={{margin:0,fontSize:15,lineHeight:1.6,color:"rgba(255,255,255,.85)",maxWidth:420}}>Nexus adapts to your role, team, and pace — surfacing the right content at the right moment, guided by AI.</p>
      </div>

      {/* Glass sign-in card */}
      <div style={{flex:"0 0 auto",width:"min(400px,92vw)",marginLeft:"auto",marginRight:"clamp(16px,4vw,56px)",borderRadius:16,padding:"clamp(20px,2.2vw,26px)",
        background:"rgba(255,255,255,.16)",backdropFilter:"blur(22px)",WebkitBackdropFilter:"blur(22px)",border:"1px solid rgba(255,255,255,.3)",boxShadow:"0 24px 60px rgba(20,8,40,.42)",maxHeight:"92vh",overflowY:"auto"}}>
      {showOnboarding
        ?<OnboardingForm email={email} onSubmit={onLogin} onPendingApproval={onPendingApproval} prefill={imsInit?.prefill} inDirectory={imsInit?.inDirectory}/>
        :loginMode==="manager"
        ?<>
          <button onClick={()=>{setLoginMode("main");setMgrError("");}} style={LOGIN_BACK}><ChevronLeft UNSAFE_style={{width:16,height:16,"--iconPrimary":"rgba(255,255,255,.9)"}}/>Back</button>
          <h2 style={{margin:"0 0 4px",fontSize:24,fontWeight:600,color:"#fff",letterSpacing:-.4}}>{mgrView==="signin"?"Manager sign in":"Register as a manager"}</h2>
          <p style={{margin:"0 0 20px",fontSize:13.5,color:"rgba(255,255,255,.8)",lineHeight:1.5}}>{mgrView==="signin"?"See your team's real learning progress, approvals, and weekly trackers.":"An admin reviews every manager registration before access is granted."}</p>
          <form onSubmit={e=>{e.preventDefault();mgrView==="signin"?handleManagerLogin():handleManagerRegister();}}>
            {mgrView==="register"&&<GlassField label="Full name" value={mgrName} onChange={e=>{setMgrName(e.target.value);setMgrError("");}} placeholder="e.g. Priya Sharma"/>}
            <GlassField label="Email" type="email" value={mgrEmail} onChange={e=>{setMgrEmail(e.target.value);setMgrError("");}} placeholder="yourname@adobe.com" invalid={!!mgrError}/>
            {mgrView==="register"&&<GlassField label="Team you manage" optional value={mgrTeam} onChange={e=>setMgrTeam(e.target.value)} placeholder="e.g. RTCDP"/>}
            <GlassField label="Password" type="password" value={mgrPwd} onChange={e=>{setMgrPwd(e.target.value);setMgrError("");}} placeholder={mgrView==="register"?"Minimum 6 characters":"Your password"} invalid={!!mgrError}/>
            {mgrView==="register"&&<GlassField label="Confirm password" type="password" value={mgrPwd2} onChange={e=>{setMgrPwd2(e.target.value);setMgrError("");}} placeholder="Repeat password" invalid={!!mgrError}/>}
            {mgrError&&<div style={LOGIN_ERR}>{mgrError}</div>}
            <GlassSubmit disabled={mgrLoading}>{mgrLoading?"Please wait…":mgrView==="signin"?"Sign in":"Create manager account"}</GlassSubmit>
          </form>
          <div style={{textAlign:"center",fontSize:12.5,color:"rgba(255,255,255,.8)",marginTop:14}}>
            {mgrView==="signin"?"New manager?":"Already registered?"}{" "}
            <button onClick={()=>{setMgrView(mgrView==="signin"?"register":"signin");setMgrError("");}} style={LOGIN_LINK}>{mgrView==="signin"?"Register here":"Sign in instead"}</button>
          </div>
        </>
        :loginMode==="account"
        ?<>
          <button onClick={()=>setLoginMode("main")} style={LOGIN_BACK}><ChevronLeft UNSAFE_style={{width:16,height:16,"--iconPrimary":"rgba(255,255,255,.9)"}}/>Back</button>
          <h2 style={{margin:"0 0 4px",fontSize:24,fontWeight:600,color:"#fff",letterSpacing:-.4}}>Sign in with your account</h2>
          <p style={{margin:"0 0 22px",fontSize:13.5,color:"rgba(255,255,255,.8)",lineHeight:1.5}}>Use the email and password you registered with.</p>
          <form onSubmit={e=>{e.preventDefault();handleAccountLogin();}}>
            <GlassField label="Email" type="email" value={acctEmail} onChange={e=>{setAcctEmail(e.target.value);setAcctError("");}} placeholder="yourname@adobe.com" invalid={!!acctError}/>
            <GlassField label="Password" type="password" value={acctPwd} onChange={e=>{setAcctPwd(e.target.value);setAcctError("");}} placeholder="Your password" invalid={!!acctError}/>
            {acctError&&<div style={LOGIN_ERR}>{acctError}</div>}
            <GlassSubmit disabled={acctLoading}>{acctLoading?"Signing in…":"Sign in"}</GlassSubmit>
          </form>
          <div style={{textAlign:"center",fontSize:12.5,color:"rgba(255,255,255,.8)",marginTop:14}}>Not registered yet? <button onClick={()=>setLoginMode("main")} style={LOGIN_LINK}>Create account</button></div>
        </>
        :loginMode==="demos"
        ?<>
          <button onClick={()=>setLoginMode("main")} style={LOGIN_BACK}><ChevronLeft UNSAFE_style={{width:16,height:16,"--iconPrimary":"rgba(255,255,255,.9)"}}/>Back</button>
          <h2 style={{margin:"0 0 4px",fontSize:24,fontWeight:600,color:"#fff",letterSpacing:-.4}}>Browse demo accounts</h2>
          <p style={{margin:"0 0 18px",fontSize:13.5,color:"rgba(255,255,255,.8)",lineHeight:1.5}}>Explore Nexus instantly as any role — no sign-in required.</p>
          <div style={{display:"flex",flexDirection:"column",gap:9}}>
            {demos.map(u=>(
              <button key={u.p} onClick={()=>onLogin(u.p)}
                style={{display:"flex",alignItems:"center",gap:11,width:"100%",padding:"11px 13px",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.18)",borderRadius:12,cursor:"pointer",textAlign:"left",fontFamily:"inherit",transition:"background .15s,border-color .15s"}}
                onMouseEnter={e=>{e.currentTarget.style.background="rgba(255,255,255,.17)";e.currentTarget.style.borderColor="rgba(255,255,255,.4)";}}
                onMouseLeave={e=>{e.currentTarget.style.background="rgba(255,255,255,.1)";e.currentTarget.style.borderColor="rgba(255,255,255,.18)";}}>
                <Avatar src={avatarSrc(u.p)} alt={u.name} size={32}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:"#fff"}}>{u.name}</div>
                  <div style={{fontSize:11.5,color:"rgba(255,255,255,.62)"}}>{u.sub}</div>
                </div>
                <div style={{fontSize:10,fontWeight:600,color:"#fff",background:"rgba(255,255,255,.15)",border:"1px solid rgba(255,255,255,.28)",borderRadius:5,padding:"2px 7px",flexShrink:0,letterSpacing:.3,textTransform:"uppercase"}}>{u.p}</div>
              </button>
            ))}
          </div>
        </>
        :(()=>{
          const sBase={height:44,borderRadius:999,display:"flex",alignItems:"center",justifyContent:"center",gap:10,fontSize:13.5,fontWeight:500,cursor:"pointer",width:"100%",fontFamily:"inherit",border:"none"};
          return(<>
            <h2 style={{margin:"0 0 5px",fontSize:25,fontWeight:600,color:"#fff",letterSpacing:-.4}}>Sign in</h2>
            <div style={{fontSize:13.5,color:"rgba(255,255,255,.9)",marginBottom:18}}>New user? <button onClick={()=>document.querySelector("#nx-login-email input")?.focus()} style={{background:"none",border:"none",color:"#7CB8FF",fontWeight:600,cursor:"pointer",padding:0,fontFamily:"inherit",fontSize:13.5}}>Create an account</button></div>
            {imsMsg&&<div style={LOGIN_ERR}>{imsMsg}</div>}
            {/* Primary path — Adobe IMS single sign-on */}
            <button onClick={()=>loginWithIMS()} title={imsAvail?"Sign in with your Adobe account":"Adobe IMS is not configured on the server — use a fallback option below"}
              style={{...sBase,height:48,background:"#FA0F00",color:"#fff",fontWeight:600,fontSize:14.5,marginBottom:12,boxShadow:"0 6px 16px rgba(250,15,0,.35)"}}>
              <AdobeMark size={18}/> Sign in with Adobe
            </button>
            <div style={{display:"flex",alignItems:"center",gap:14,color:"rgba(255,255,255,.78)",fontSize:12.5,fontWeight:500,margin:"4px 0 14px"}}>
              <div style={{flex:1,height:1,background:"rgba(255,255,255,.28)"}}/>Or use a fallback option<div style={{flex:1,height:1,background:"rgba(255,255,255,.28)"}}/>
            </div>
            <div id="nx-login-email">
              <form onSubmit={e=>{e.preventDefault();handleEmailLogin();}}>
                <label style={{display:"block",fontSize:13,fontWeight:500,color:"#fff",marginBottom:7}}>Email</label>
                <input type="email" value={email} onChange={e=>{setEmail(e.target.value);setEmailError("");}} placeholder="yourname@adobe.com"
                  style={{width:"100%",height:44,borderRadius:10,border:`1px solid ${emailError?"#FF8A80":"rgba(255,255,255,.4)"}`,background:"rgba(255,255,255,.92)",padding:"0 14px",fontSize:14,color:"#222",outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
                {emailError&&<div style={{fontSize:12,color:"#FFB4AB",marginTop:6}}>{emailError}</div>}
                <div style={{display:"flex",justifyContent:"flex-end",marginTop:14}}>
                  <button type="submit" style={{background:"#1473E6",color:"#fff",border:"none",borderRadius:999,padding:"10px 26px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 6px 16px rgba(20,115,230,.4)"}}>Continue</button>
                </div>
              </form>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:14,color:"rgba(255,255,255,.78)",fontSize:13,fontWeight:500,margin:"16px 0"}}>
              <div style={{flex:1,height:1,background:"rgba(255,255,255,.28)"}}/>Or<div style={{flex:1,height:1,background:"rgba(255,255,255,.28)"}}/>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:9}}>
              <button onClick={()=>setLoginMode("account")} style={{...sBase,background:"#fff",color:"#1f1f1f",border:"1px solid rgba(0,0,0,.12)"}}><Key UNSAFE_style={{"--iconPrimary":"#1f1f1f"}}/> Sign in with your account</button>
              <button onClick={()=>setLoginMode("manager")} style={{...sBase,background:"#1473E6",color:"#fff"}}><UserGroup UNSAFE_style={{"--iconPrimary":"#fff"}}/> I'm a manager</button>
              <button onClick={()=>setLoginMode("demos")} style={{...sBase,background:"#1f1f1f",color:"#fff"}}><Preview UNSAFE_style={{"--iconPrimary":"#fff"}}/> Browse demo accounts</button>
            </div>
          </>);
        })()}
      </div>
    </div>
  </div>);
}



// ── NJ DASHBOARD ─────────────────────────────────────────────────────────────

// ── Adobe corporate logo mark (official vector) ──────────────────────────────
function AdobeMark({size=26}){
  return(
    <svg width={size} height={Math.round(size*26/29)} viewBox="0 0 29 26" fill="none" role="img" aria-label="Adobe" style={{display:"block",flexShrink:0}}>
      <path d="M10.0158 20.23H13.9542L16.4333 25.1033H20.0317L14.1667 9.7325L10.0158 20.23ZM0 0V25.5L10.5117 0H0ZM17.68 0L28.3333 25.2308V0H17.68Z" fill="#EA3829"/>
    </svg>
  );
}

// ── Vibrant gradient card with hover-lift, press feedback, keyboard + click ──
function GradientCard({grad,tag,title,foot,footIcon="→",progress,onClick,minH=126}){
  const [hov,setHov]=useState(false),[press,setPress]=useState(false);
  // No text-arrow glyphs — render a chevron (or lock) icon instead.
  const fic=footIcon==="→"?<Ic as={ChevronRight} size={13} color="#222"/>:footIcon==="🔒"?<Ic as={Lock} size={12} color="#222"/>:footIcon;
  return(
    <div role="button" tabIndex={0} aria-label={title}
      onClick={onClick}
      onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onClick&&onClick();}}}
      onMouseEnter={()=>setHov(true)} onMouseLeave={()=>{setHov(false);setPress(false);}}
      onMouseDown={()=>setPress(true)} onMouseUp={()=>setPress(false)}
      className="nx-gcard"
      style={{position:"relative",borderRadius:14,padding:14,minHeight:minH,color:"#fff",overflow:"hidden",
        background:grad,cursor:"pointer",display:"flex",flexDirection:"column",
        boxShadow:hov?"0 12px 26px rgba(0,0,0,.22)":"0 5px 15px rgba(0,0,0,.12)",
        transform:press?"scale(.985)":hov?"translateY(-4px)":"none",
        transition:"transform .16s ease, box-shadow .2s ease"}}>
      <div style={{position:"absolute",inset:0,background:"radial-gradient(115% 85% at 88% 0%,rgba(255,255,255,.24),transparent 55%)",pointerEvents:"none"}}/>
      <span style={{alignSelf:"flex-start",fontSize:9,fontWeight:600,letterSpacing:.5,textTransform:"uppercase",background:"rgba(255,255,255,.22)",padding:"3px 8px",borderRadius:999,marginBottom:"auto",position:"relative",zIndex:1}}>{tag}</span>
      <div style={{fontSize:13.5,fontWeight:500,letterSpacing:-.1,lineHeight:1.25,margin:"11px 0 9px",position:"relative",zIndex:1}}>{title}</div>
      {progress!=null&&<div style={{height:4,borderRadius:999,background:"rgba(255,255,255,.32)",overflow:"hidden",marginBottom:8,position:"relative",zIndex:1}}><div style={{height:"100%",width:`${progress}%`,background:"#fff",borderRadius:999}}/></div>}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:11,fontWeight:600,opacity:.96,position:"relative",zIndex:1}}>
        <span>{foot}</span>
        <span style={{width:23,height:23,borderRadius:"50%",background:"rgba(255,255,255,.92)",color:"#222",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:600,fontSize:12,transform:hov?"translateX(2px)":"none",transition:"transform .15s"}}>{fic}</span>
      </div>
    </div>
  );
}

// ── Metric tile (adaptive panel) with a colored progress bar ─────────────────
function MetricCard({label,note,value,unit,pct,grad,valColor}){
  return(
    <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:13,padding:"13px 15px"}}>
      <div style={{fontSize:10,fontWeight:500,letterSpacing:.4,color:P.dim,textTransform:"uppercase",marginBottom:7,display:"flex",justifyContent:"space-between"}}><span>{label}</span>{note&&<span>{note}</span>}</div>
      <div style={{fontSize:21,fontWeight:600,letterSpacing:-.4,color:valColor||P.txt}}>{value}<span style={{fontSize:12,color:P.dim,fontWeight:600}}>{unit}</span></div>
      <div style={{height:5,borderRadius:999,background:P.bfaint,overflow:"hidden",marginTop:8}}><div style={{height:"100%",width:`${pct}%`,background:grad,borderRadius:999}}/></div>
    </div>
  );
}


// ── WeeklyUtilCard — real hrs/week committed across assigned projects vs. a
// 40h week, shown on the homepage. Fetches live data every time, never a
// static/sample number.
function WeeklyUtilCard({profile}){
  const [total,setTotal]=useState(null);
  useEffect(()=>{
    const q=profile.email?`email=${encodeURIComponent(profile.email)}`:`member_name=${encodeURIComponent(profile.name||"")}`;
    fetch(`${BACKEND}/api/projects/my-client?${q}`,{credentials:"include"})
      .then(r=>r.json())
      .then(d=>setTotal((d.projects||[]).reduce((s,pr)=>s+(parseFloat(pr.hrs_per_week)||0),0)))
      .catch(()=>setTotal(0));
  },[profile.email,profile.name]);

  const base=40;
  const used=total??0;
  const left=Math.max(0,base-used);
  const pct=Math.min(100,Math.round((used/base)*100));
  const barColor=pct>100?P.red:pct>85?P.amber:P.grn;

  return(
    <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,padding:"16px 18px",
      display:"flex",flexDirection:"column",gap:10,minWidth:200}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:.5,textTransform:"uppercase",color:P.dim}}>This week</div>
      {total===null ? (
        <div style={{fontSize:12.5,color:P.muted}}>Loading…</div>
      ) : (
        <>
          <div style={{display:"flex",alignItems:"baseline",gap:6}}>
            <span style={{fontSize:26,fontWeight:600,color:P.txt,letterSpacing:-.5}}>{left}h</span>
            <span style={{fontSize:12.5,color:P.muted}}>left of {base}h</span>
          </div>
          <div style={{height:6,borderRadius:999,background:P.bfaint,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${pct}%`,background:barColor,borderRadius:999,transition:"width .3s"}}/>
          </div>
          <div style={{fontSize:11.5,color:P.muted}}>{used}h committed across your projects{pct>100?" — over 40h":""}</div>
        </>
      )}
    </div>
  );
}

// ── CohortCard — real peer-progress ranking (modules completed, from
// user_module_progress), shown on the home page. Only shown for real
// registered accounts with actual peers in the same grouping — no fictional
// names, hidden entirely rather than showing a lonely/fake list.
// `endpoint` decides the grouping: New Joiners group by track
// (/api/cohort/ranking), experienced staff group by team + tenure band
// (/api/cohort/exp-ranking). `subtitle` renders the grouping label from the
// response.
function CohortCard({profile,endpoint,subtitle}){
  const [data,setData]=useState(undefined); // undefined=loading, null=no data, {}=loaded

  useEffect(()=>{
    if(!profile.email){ setData(null); return; }
    fetch(`${BACKEND}${endpoint}?email=${encodeURIComponent(profile.email)}`,{credentials:"include"})
      .then(r=>r.json()).then(setData).catch(()=>setData(null));
  },[profile.email,endpoint]);

  if(data===null || (data && (data.cohort||[]).length<=1)) return null; // nothing meaningful to compare
  if(data===undefined) return(
    <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,padding:"16px 18px",minWidth:220}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:.5,textTransform:"uppercase",color:P.dim,marginBottom:8}}>Your cohort</div>
      <div style={{fontSize:12.5,color:P.muted}}>Loading…</div>
    </div>
  );

  const board=data.cohort||[];
  const top=board.slice(0,4);
  const you=board.find(c=>c.is_you);
  const youShown=top.some(c=>c.is_you);

  return(
    <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:14,padding:"16px 18px",minWidth:220}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:.5,textTransform:"uppercase",color:P.dim,marginBottom:10}}>
        Your cohort <span style={{fontWeight:400,textTransform:"none",color:P.dim}}>· {subtitle(data)}</span>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:7}}>
        {top.map(c=>(
          <div key={c.rank} style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:11,fontWeight:700,color:c.is_you?P.blue:P.dim,width:14,flexShrink:0}}>{c.rank}</span>
            <span style={{fontSize:12.5,fontWeight:c.is_you?600:400,color:c.is_you?P.blue:P.txt,flex:1,
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.is_you?"You":c.name}</span>
            <span style={{fontSize:11.5,color:P.muted,flexShrink:0}}>{c.modules_done} modules</span>
          </div>
        ))}
        {!youShown&&you&&(
          <div style={{display:"flex",alignItems:"center",gap:8,borderTop:`1px solid ${P.bfaint}`,paddingTop:7,marginTop:1}}>
            <span style={{fontSize:11,fontWeight:700,color:P.blue,width:14,flexShrink:0}}>{you.rank}</span>
            <span style={{fontSize:12.5,fontWeight:600,color:P.blue,flex:1}}>You</span>
            <span style={{fontSize:11.5,color:P.muted,flexShrink:0}}>{you.modules_done} modules</span>
          </div>
        )}
      </div>
    </div>
  );
}

function NJDash({onLogout,groqKey,onLog,onJudge,profile,githubToken,onToggleTheme}){
  const [tab,setTab]=useState("overview");
  useEffect(()=>{const h=e=>{const tb=e.detail?.tab;if(tb)setTab(tb);};window.addEventListener("nexus:navigate",h);return()=>window.removeEventListener("nexus:navigate",h);},[]);
  const [studyModule,setStudyModule]=useState(null);
  const [expandedModule,setExpandedModule]=useState(null);
  const [lessonModule,setLessonModule]=useState(null);
  // Avatar/username changes from Profile settings apply here immediately
  // (header, sidebar, everywhere `p` is used) — no page refresh needed.
  const [avatarOverride,setAvatarOverride]=useState(null);
  const p={...(profile||PROFILES.nj), ...(avatarOverride||{})};

  // Determine track from team
  const track=getTrack(p);
  const modules=track==="analytics"?ANALYTICS_MODULES:MODULES;
  const done=modules.filter(m=>m.status==="done").length;

  const [pointsRefresh,setPointsRefresh]=useState(0); // increments to refresh MyPointsWidget
  // Live confidence — starts from profile, updates as learner interacts
  const [liveConf,setLiveConf]=useState(p.conf!=null?p.conf:.76);

  // Bandwidth — live updatable, persisted to DB
  const [liveBW,setLiveBW]=useState(p.bw||85);
  const [bwSaving,setBwSaving]=useState(false);
  const [bwSaved,setBwSaved]=useState(false);

  // Load latest BW from DB on mount
  useEffect(()=>{
    fetch(`${BACKEND}/api/bw/latest?persona=nj`)
      .then(r=>r.json())
      .then(d=>{if(d?.bw!=null)setLiveBW(d.bw);})
      .catch(()=>{});
  },[]);

  const saveBW=async()=>{
    setBwSaving(true);setBwSaved(false);
    try{
      await fetch(`${BACKEND}/api/bw`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({persona:"nj",bw:liveBW})});
      setBwSaved(true);
      setTimeout(()=>setBwSaved(false),3000);
    }catch{}
    setBwSaving(false);
  };

  // Persist confidence to DB and update local state
  const updateConf=async(newConf)=>{
    const clamped=Math.round(Math.max(0,Math.min(1,newConf))*100)/100;
    setLiveConf(clamped);
    fetch(`${BACKEND}/api/telemetry`,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({persona:"nj",event_type:"conf_update",module:p.module,
        detail:`conf=${clamped}`})}).catch(()=>{});
  };

  // NBA — Curriculum Agent generates next best action
  const [nba,setNba]=useState(null);
  const [nbaLoading,setNbaLoading]=useState(false);
  const generateNBA=async()=>{
    setNbaLoading(true);
    const weakSkills=SKILLS.filter((_,i)=>p.skills?.[i]==="developing"||p.skills?.[i]==="none").join(", ");
    const sys=`You are the Curriculum Agent for Nexus. Generate a single Next Best Action recommendation for a learner.
Return ONLY valid JSON: {"action":"short action title","reason":"1 sentence why","type":"socratic"|"quiz"|"study"|"rest","urgency":"high"|"medium"|"low"}`;
    try{
      const raw=await callAgent([{role:"user",content:`Learner: ${p.name}, module: ${p.module}, confidence: ${Math.round(liveConf*100)}%, weak skills: ${weakSkills}, bandwidth: ${p.bw}%`}],
        sys,groqKey,{agentName:"NBA",logFn:null,maxTokens:150});
      setNba(JSON.parse(raw.replace(/```json|```/g,"").trim()));
    }catch{
      setNba({action:"Run a Socratic session on Segment Evaluation Logic",reason:"Your confidence is below the gate and you have 4 failed attempts — guided reasoning is the fastest path forward.",type:"socratic",urgency:"high"});
    }
    setNbaLoading(false);
  };

  // Load NBA on mount
  useEffect(()=>{if(groqKey)generateNBA();},[groqKey]);

  const nonCapstoneModules=modules.filter(m=>!m.capstone);
  const totalNonCap=nonCapstoneModules.length;  // e.g. 8 for RTCDP track
  // demoForceCapstoneUnlocked: per-learner module completion isn't tracked
  // separately in this demo dataset — every NJ persona reads progress off the
  // same static MODULES array. This flag lets a specific demo profile (e.g.
  // "just cleared the gate") show as fully done without altering that shared
  // array (which would change every other persona's progress too).
  const effectiveDoneForGate=p.demoForceCapstoneUnlocked?nonCapstoneModules.length:done;
  const allModulesDone=effectiveDoneForGate>=totalNonCap;
  const isAboveGate=liveConf>=.75&&allModulesDone; // BOTH required
  const confPct=Math.round(liveConf*100);
  const isWeek1=p.tenure==="Week 1";

  // Start the capstone clock once, the moment the gate is first crossed (real DB users only)
  useEffect(()=>{
    if(isAboveGate&&p.id){
      fetch(`${BACKEND}/api/onboarding/${p.id}/capstone-start`,{method:"PUT"}).catch(()=>{});
    }
  },[isAboveGate,p.id]);

  // Program duration window: 4-8 weeks from joining date
  const daysSinceJoining=p.joining_date?Math.floor((new Date()-new Date(p.joining_date))/86400000):null;
  const weeksSinceJoining=daysSinceJoining!=null?Math.floor(daysSinceJoining/7)+1:null;
  const programStatus=weeksSinceJoining==null?null:weeksSinceJoining<=4?"on-track":weeksSinceJoining<=8?"normal":"overdue";

  const tabs=[
    {id:"overview",label:"Home",              icon:Home},
    {id:"track",   label:"Learning Path",     icon:Education},
    {id:"assist",  label:"AI Tutor",          icon:Chat},
    {id:"capstone",   label:"Capstone",          icon:Ribbon,badge:isAboveGate?"ready":null},
    {id:"shadow",     label:"Practice Scenarios",icon:Target},
    {id:"tracker",    label:"Weekly Tracker",    icon:Calendar},
    {id:"projects",   label:"My Projects",       icon:Briefcase},
    {id:"relnotes",   label:"Release Notes",      icon:FileText},
    {id:"community",  label:"Community",         icon:CommunityIcon},
    {id:"profile",    label:"Profile",           icon:User},
  ];
  const {mobile}=useViewport();

  return(<div style={{display:"flex",flexDirection:"column",height:"100vh",fontFamily:"'adobe-clean','Source Sans 3',system-ui,sans-serif",background:P.bg}}>
    <GlobalStyles/>
    <Nav initial={p.initial} name={p.username||p.name} sub={`${p.role} · ${p.tenure}`} color={p.avatar_color||p.color} avatarEmoji={p.avatar_emoji} persona={p.persona||"nj"} onLogout={onLogout} progress={liveConf*100} onToggleTheme={onToggleTheme} onGoToProfile={()=>setTab("profile")}/>
    {mobile?<Tabs items={tabs} active={tab} onChange={setTab}/>:<SideNav items={tabs} active={tab} onChange={setTab}/>}
    <div className="nx-main-content" style={{flex:1,overflowY:"auto",paddingLeft:mobile?0:SIDENAV_WIDTH}}>

      {/* ── Home: Hero + Agents + Other Features only ── */}
      {tab==="overview"&&(()=>{
        const firstName=(p.name||"there").split(" ")[0];
        const inProgress=modules.filter(m=>!m.capstone&&m.status!=="done").slice(0,4);
        const openModule=m=>{setExpandedModule(m.id);setTab("track");};
        const isDark=getThemeMode()==="dark";
        const PINK="#EB1000";
        const INK=isDark?"#F1F2F5":"#1B2140";
        const MUT=isDark?"#9DA1AE":"#6B7280";
        const PAGE=isDark?"#0F1117":"#fff";
        const CARDBG=isDark?"#171A22":"#fff";
        const CARDBD=isDark?"#282C38":"#ececec";
        const HERO=isDark?"linear-gradient(160deg,#241640 0%,#34183f 55%,#3f1d34 100%)":"linear-gradient(160deg,#FFF1EE 0%,#FCE7E1 55%,#F7DAD2 100%)";
        const ACCENTTX=isDark?"#fff":PINK;
        const BANNER=isDark?HERO:"linear-gradient(125deg,#FFF1ED 0%,#FBD9D0 42%,#F3C3B8 72%,#EFB7AC 100%)";
        const bINK=isDark?"#F1F2F5":"#1B2140";
        const bMUT=isDark?"rgba(255,255,255,.82)":"#5a5f6e";
        const LOGOS=["/images/ic/logo-straight.png","/images/ic/logo-right.png","/images/ic/logo-left.png"];
        const wrap={maxWidth:1080,margin:"0 auto",padding:"0 32px"};
        const totalN=modules.filter(m=>!m.capstone).length;
        // AI-agent-backed features vs plain platform features — two distinct
        // sections so it's clear which tiles are a real agent session.
        const agentCards=[
          {id:"track",cat:"Curriculum agent",label:"Learning Path",meta:`${done}/${totalN} modules done`,desc:"Continue your onboarding modules step by step.",color:P.blue},
          {id:"assist",cat:"AI Tutor",label:"AI Tutor",meta:"Guide me · Explain fully",desc:"Ask anything about AEP — choose hints to reason it out, or a full explanation.",color:P.purple},
          {id:"shadow",cat:"Practice agent",label:"Practice Scenarios",meta:"Realistic AEP situations",desc:"Apply your skills in a safe, guided environment.",color:P.amber},
          {id:"capstone",cat:"Capstone agent",label:"Capstone",meta:isAboveGate?"Unlocked":`${confPct}% confidence`,desc:"Prove readiness with a scenario-based final project.",color:P.blue},
        ];
        const otherCards=[
          {id:"tracker",cat:"Delivery",label:"Weekly Tracker",meta:"Log your hours",desc:"Track your weekly bandwidth and commitments.",color:P.amber},
          {id:"projects",cat:"Delivery",label:"My Projects",meta:`${(p.projects||[]).length} active`,desc:"Review your project assignments.",color:P.grn},
          {id:"relnotes",cat:"Platform",label:"Release Notes",meta:"What's new",desc:"See the latest Nexus + AEP platform updates.",color:P.grn},
          {id:"profile",cat:"Profile",label:"My Profile",meta:"Skills & certification",desc:"View your profile, skills, and certification status.",color:P.purple},
        ];
        return(
        <div style={{background:PAGE,color:INK,minHeight:"100%",padding:"28px 24px"}}>
        <div style={{maxWidth:1080,margin:"0 auto"}}>
          {/* HERO */}
          <div style={{position:"relative",minHeight:mobile?280:320,borderRadius:20,overflow:"hidden",marginBottom:16,background:HERO,boxShadow:isDark?"0 22px 52px rgba(0,0,0,.38)":"0 24px 60px rgba(30,20,60,.24)"}}>
            <div style={{position:"relative",zIndex:1,maxWidth:560,padding:mobile?"28px 24px":"42px 44px"}}>
              <div style={{fontSize:11.5,fontWeight:700,letterSpacing:1.4,textTransform:"uppercase",color:ACCENTTX,marginBottom:10}}>New joiner</div>
              <div style={{fontSize:mobile?30:38,lineHeight:1.1,fontWeight:700,color:INK,letterSpacing:-.8,marginBottom:14}}>Welcome, {firstName}.</div>
              <div style={{fontSize:15,color:MUT,lineHeight:1.6,marginBottom:24}}>Build real Adobe Experience Platform skills — {done}/{totalN} modules complete, {confPct}% confidence.</div>
              <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                <button className={isDark?"nx-btn nx-whitebtn":"nx-btn nx-redbtn"} onClick={()=>inProgress[0]?openModule(inProgress[0]):setTab("track")}
                  style={{background:"transparent",color:ACCENTTX,border:`2.5px solid ${ACCENTTX}`,borderRadius:999,padding:"11px 24px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
                  {inProgress[0]?"Continue learning":"Go to learning path"}
                </button>
                <button onClick={()=>setTab("assist")} style={{background:"rgba(255,255,255,.88)",border:"none",borderRadius:999,padding:"11px 22px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",color:"#1B2140",display:"inline-flex",alignItems:"center",gap:8,boxShadow:"0 8px 20px rgba(0,0,0,.12)"}}>
                  <Ic as={Chat} size={15} color={PINK}/> Ask the AI Tutor
                </button>
              </div>
            </div>
          </div>

          {/* Quick stats — real data, sits beside the hero as compact side cards */}
          <div style={{display:"flex",gap:12,flexWrap:"wrap",margin:"16px 0"}}>
            <WeeklyUtilCard profile={p}/>
            <CohortCard profile={p} endpoint="/api/cohort/ranking" subtitle={d=>(d.track||"").toUpperCase()}/>
          </div>

          {/* Your AI agents */}
          <div style={{fontSize:11,fontWeight:700,letterSpacing:.6,textTransform:"uppercase",color:MUT,marginTop:4}}>Your AI agents</div>
          <div style={{display:"grid",gridTemplateColumns:mobile?"1fr":"repeat(2,1fr)",gap:12,alignItems:"stretch",marginTop:8,marginBottom:8}}>
            {agentCards.map((c,i)=>(
              <div key={c.id} role="button" tabIndex={0} onClick={()=>setTab(c.id)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setTab(c.id);}}} className="nx-gcard"
                style={{background:CARDBG,border:`1px solid ${CARDBD}`,borderRadius:12,overflow:"hidden",cursor:"pointer",boxShadow:isDark?"0 4px 14px rgba(0,0,0,.3)":"0 4px 14px rgba(0,0,0,.05)",display:"flex",flexDirection:"column",position:"relative",minHeight:mobile?250:270}}>
                <div style={{height:mobile?90:112,backgroundColor:c.color,overflow:"hidden",position:"relative"}}>
                  <div style={{position:"absolute",inset:0,display:"grid",gridTemplateColumns:"repeat(auto-fill,40px)",gridAutoRows:"40px",justifyContent:"center",alignContent:"center",gap:5,opacity:.5,transform:"rotate(-2deg) scale(1.15)"}}>
                    {Array.from({length:14}).map((_,k)=>(<img key={k} src={LOGOS[(k+i)%3]} alt="" style={{width:22,height:22,display:"block"}}/>))}
                  </div>
                </div>
                <span style={{position:"absolute",top:mobile?74:96,left:14,background:"rgba(255,255,255,.96)",color:c.color,fontSize:9.5,fontWeight:700,letterSpacing:.5,textTransform:"uppercase",padding:"4px 9px",borderRadius:6,boxShadow:"0 2px 6px rgba(0,0,0,.18)",zIndex:2}}>{c.cat}</span>
                <div style={{padding:"18px 15px 14px",flex:1,display:"flex",flexDirection:"column"}}>
                  <div style={{fontSize:14.5,fontWeight:700,marginBottom:4,color:INK}}>{c.label}</div>
                  <div style={{fontSize:11,fontWeight:700,color:c.color,marginBottom:5,textTransform:"uppercase",letterSpacing:.2}}>{c.meta}</div>
                  <p style={{fontSize:12.5,color:MUT,lineHeight:1.5,margin:"0 0 12px",flex:1}}>{c.desc}</p>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end"}}>
                    <span style={{display:"inline-flex",alignItems:"center",gap:3,fontSize:12.5,fontWeight:600,color:ACCENTTX}}>Open agent<ChevronRight UNSAFE_style={{width:15,height:15,"--iconPrimary":ACCENTTX}}/></span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Other features */}
          <div style={{fontSize:11,fontWeight:700,letterSpacing:.6,textTransform:"uppercase",color:MUT,marginTop:8}}>Other features</div>
          <div style={{display:"grid",gridTemplateColumns:mobile?"1fr":"repeat(2,1fr)",gap:12,alignItems:"stretch",marginTop:8}}>
            {otherCards.map((c,i)=>(
              <div key={c.id} role="button" tabIndex={0} onClick={()=>setTab(c.id)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setTab(c.id);}}} className="nx-gcard"
                style={{background:CARDBG,border:`1px solid ${CARDBD}`,borderRadius:12,overflow:"hidden",cursor:"pointer",boxShadow:isDark?"0 4px 14px rgba(0,0,0,.3)":"0 4px 14px rgba(0,0,0,.05)",display:"flex",flexDirection:"column",position:"relative",minHeight:mobile?250:270}}>
                <div style={{height:mobile?90:112,backgroundColor:c.color,overflow:"hidden",position:"relative"}}>
                  <div style={{position:"absolute",inset:0,display:"grid",gridTemplateColumns:"repeat(auto-fill,40px)",gridAutoRows:"40px",justifyContent:"center",alignContent:"center",gap:5,opacity:.5,transform:"rotate(-2deg) scale(1.15)"}}>
                    {Array.from({length:14}).map((_,k)=>(<img key={k} src={LOGOS[(k+i+agentCards.length)%3]} alt="" style={{width:22,height:22,display:"block"}}/>))}
                  </div>
                </div>
                <span style={{position:"absolute",top:mobile?74:96,left:14,background:"rgba(255,255,255,.96)",color:c.color,fontSize:9.5,fontWeight:700,letterSpacing:.5,textTransform:"uppercase",padding:"4px 9px",borderRadius:6,boxShadow:"0 2px 6px rgba(0,0,0,.18)",zIndex:2}}>{c.cat}</span>
                <div style={{padding:"18px 15px 14px",flex:1,display:"flex",flexDirection:"column"}}>
                  <div style={{fontSize:14.5,fontWeight:700,marginBottom:4,color:INK}}>{c.label}</div>
                  <div style={{fontSize:11,fontWeight:700,color:c.color,marginBottom:5,textTransform:"uppercase",letterSpacing:.2}}>{c.meta}</div>
                  <p style={{fontSize:12.5,color:MUT,lineHeight:1.5,margin:"0 0 12px",flex:1}}>{c.desc}</p>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end"}}>
                    <span style={{display:"inline-flex",alignItems:"center",gap:3,fontSize:12.5,fontWeight:600,color:ACCENTTX}}>Start<ChevronRight UNSAFE_style={{width:15,height:15,"--iconPrimary":ACCENTTX}}/></span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

          {/* FOOTER */}
          <footer style={{background:BANNER,color:bMUT,padding:"40px 0 26px"}}>
            <div style={{...wrap,display:"grid",gridTemplateColumns:mobile?"1fr 1fr":"1.4fr 1fr 1fr 1fr",gap:26}}>
              <div>
                <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:12}}>
                  <svg width="22" height="20" viewBox="0 0 29 26" fill="none"><path d="M10.0158 20.23H13.9542L16.4333 25.1033H20.0317L14.1667 9.7325L10.0158 20.23ZM0 0V25.5L10.5117 0H0ZM17.68 0L28.3333 25.2308V0H17.68Z" fill="#EA3829"/></svg>
                  <span style={{fontSize:16,fontWeight:700,color:bINK}}>Nexus</span>
                </div>
                <p style={{fontSize:13,lineHeight:1.6,maxWidth:240,margin:0}}>Adobe internal learning — from onboarding to platform expert.</p>
              </div>
              {[
                {h:"Learn",l:[{t:"Learning Path",tab:"track"},{t:"Practice",tab:"shadow"},{t:"Capstone",tab:"capstone"}]},
                {h:"Support",l:[{t:"Knowledge Base",tab:"kb"},{t:"AI Tutor",tab:"assist"},{t:"Community",tab:"community"}]},
                {h:"Adobe",l:[{t:"Experience League",href:"https://experienceleague.adobe.com"},{t:"Trust Center",href:"https://www.adobe.com/trust.html"},{t:"Privacy",href:"https://www.adobe.com/privacy/policy.html"},{t:"Terms",href:"https://www.adobe.com/legal/terms.html"}]},
              ].map(col=>(
                <div key={col.h}>
                  <div style={{fontSize:12.5,fontWeight:700,color:bINK,marginBottom:11}}>{col.h}</div>
                  {col.l.map(x=>(x.href
                    ?<a key={x.t} href={x.href} target="_blank" rel="noreferrer" style={{display:"block",fontSize:13,marginBottom:8,color:bMUT,textDecoration:"none",cursor:"pointer"}}>{x.t}</a>
                    :<button key={x.t} onClick={()=>setTab(x.tab)} style={{display:"block",fontSize:13,marginBottom:8,color:bMUT,background:"none",border:"none",padding:0,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>{x.t}</button>
                  ))}
                </div>
              ))}
            </div>
            <div style={{...wrap,borderTop:`1px solid ${isDark?"rgba(255,255,255,.14)":"rgba(0,0,0,.1)"}`,marginTop:26,paddingTop:16,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12,fontSize:12}}>
              <span>© 2026 Adobe. All rights reserved.</span>
              <div style={{display:"flex",gap:14}}>
                {[
                  {n:"Facebook",href:"https://www.facebook.com/Adobe/",p:"M13 22v-8h3l.5-3.5H13V8.3c0-1 .3-1.7 1.8-1.7H17V3.5C16.6 3.4 15.4 3.3 14 3.3c-2.7 0-4.5 1.6-4.5 4.6v2.6H6.5V14h3v8z"},
                  {n:"X",href:"https://x.com/Adobe",p:"M17.5 3h3l-6.55 7.5L21.7 21h-6l-4.7-6.1L5.6 21h-3l7-8L2.3 3h6.15l4.25 5.6zM16.4 19.2h1.65L7.7 4.7H5.9z"},
                  {n:"LinkedIn",href:"https://www.linkedin.com/company/adobe",p:"M4.98 3.5A2.5 2.5 0 1 1 5 8.5a2.5 2.5 0 0 1-.02-5zM3 9h4v12H3zm7 0h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V21h-4v-5.35c0-1.28-.02-2.92-1.78-2.92-1.78 0-2.05 1.4-2.05 2.83V21h-4z"},
                  {n:"Instagram",href:"https://www.instagram.com/adobe/",p:"M12 2c2.72 0 3.06.01 4.12.06 1.07.05 1.8.22 2.43.47.66.25 1.22.6 1.77 1.16.56.55.9 1.11 1.16 1.77.25.63.42 1.36.47 2.43C21.99 8.94 22 9.28 22 12s-.01 3.06-.06 4.12c-.05 1.07-.22 1.8-.47 2.43a4.9 4.9 0 0 1-1.16 1.77c-.55.56-1.11.9-1.77 1.16-.63.25-1.36.42-2.43.47-1.06.05-1.4.06-4.12.06s-3.06-.01-4.12-.06c-1.07-.05-1.8-.22-2.43-.47a4.9 4.9 0 0 1-1.77-1.16 4.9 4.9 0 0 1-1.16-1.77c-.25-.63-.42-1.36-.47-2.43C2.01 15.06 2 14.72 2 12s.01-3.06.06-4.12c.05-1.07.22-1.8.47-2.43.25-.66.6-1.22 1.16-1.77.55-.56 1.11-.9 1.77-1.16.63-.25 1.36-.42 2.43-.47C8.94 2.01 9.28 2 12 2zm0 1.8c-2.67 0-2.99.01-4.04.06-.98.04-1.5.2-1.86.34-.47.18-.8.4-1.15.75-.35.35-.57.68-.75 1.15-.14.36-.3.88-.34 1.86-.05 1.05-.06 1.37-.06 4.04s.01 2.99.06 4.04c.04.98.2 1.5.34 1.86.18.47.4.8.75 1.15.35.35.68.57 1.15.75.36.14.88.3 1.86.34 1.05.05 1.37.06 4.04.06s2.99-.01 4.04-.06c.98-.04 1.5-.2 1.86-.34.47-.18.8-.4 1.15-.75.35-.35.57-.68.75-1.15.14-.36.3-.88.34-1.86.05-1.05.06-1.37.06-4.04s-.01-2.99-.06-4.04c-.04-.98-.2-1.5-.34-1.86a3.1 3.1 0 0 0-.75-1.15 3.1 3.1 0 0 0-1.15-.75c-.36-.14-.88-.3-1.86-.34-1.05-.05-1.37-.06-4.04-.06zm0 3.06a5.14 5.14 0 1 1 0 10.28 5.14 5.14 0 0 1 0-10.28zm0 1.8a3.34 3.34 0 1 0 0 6.68 3.34 3.34 0 0 0 0-6.68zm5.34-3.2a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4z"},
                ].map(s=>(<a key={s.n} href={s.href} target="_blank" rel="noreferrer" aria-label={s.n} style={{opacity:.85,display:"inline-flex"}}><svg width="18" height="18" viewBox="0 0 24 24" fill={bINK}><path d={s.p}/></svg></a>))}
              </div>
            </div>
          </footer>
        </div>
        );
      })()}

      {/* ── Learning Path ── */}
      {tab==="track"&&<LearningPathView profile={p} groqKey={groqKey} done={done} studyModule={studyModule} setStudyModule={setStudyModule} expandedModule={expandedModule} setExpandedModule={setExpandedModule} mobile={mobile} track={track} modules={modules} onTestOutPass={()=>setPointsRefresh(k=>k+1)} onConfUpdate={updateConf} onOpenLesson={setLessonModule}/>}
      {tab==="assist"&&<div style={{height:"calc(100vh - 104px)",display:"flex",flexDirection:"column"}}><LearningAssistant groqKey={groqKey} onLog={onLog} onJudge={onJudge} profile={{...p,conf:liveConf}} githubToken={githubToken} onConfUpdate={updateConf} dashboard="new_joiner"/></div>}
      {tab==="capstone"&&<div style={{height:"calc(100vh - 104px)",overflowY:"auto"}}><Capstone profile={{...p,conf:liveConf}} groqKey={groqKey} githubToken={githubToken} conf={liveConf} allModulesDone={allModulesDone} doneModules={effectiveDoneForGate} totalModules={totalNonCap}/></div>}
      {tab==="shadow"&&<PracticeScenarios module={p.module} groqKey={groqKey} profile={p}/>}
      {tab==="tracker"&&<MyWeeklyTracker profile={p}/>}
      {tab==="projects"&&<MyProjectsView profile={p}/>}
      {tab==="kb"&&<div style={{height:"calc(100vh - 54px)",overflowY:"auto"}}><KnowledgeBase groqKey={groqKey} track={track} /></div>}
      {tab==="relnotes"&&<div style={{height:"calc(100vh - 104px)",overflowY:"auto"}}><ReleaseNotes/></div>}
      {tab==="community"&&<div style={{height:"calc(100vh - 104px)",overflowY:"auto"}}><NJCommunity profile={p}/></div>}
      {lessonModule&&<ModuleLesson module={lessonModule} groqKey={groqKey} track={track} userId={p?.id||p?.email||""} onClose={()=>setLessonModule(null)}/>}
      {tab==="profile"&&<div style={{maxWidth:640,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:16}}>
        <ProfileCard name={p.name} role={p.role} tenure={`${p.track_label||p.team} · ${p.tenure}`} initial={p.initial} color={p.color} skills={p.skills} skillLabels={SKILLS} bw={liveBW} cert={p.cert.name} certStatus={p.cert.status} certExp={p.cert.exp} badges={p.badges} memberProjects={{[p.name]:p.projects||[]}} projectIssues={{}} persona={p.persona||"nj"} email={p.email} userId={p.id} username={p.username} avatarEmoji={p.avatar_emoji} avatarColor={p.avatar_color} accountType="learner" onAvatarSaved={setAvatarOverride}/>
        {/* BW live update */}
        <Card style={{padding:"20px 24px"}}>
          <div style={{fontSize:14,fontWeight:600,color:P.txt,marginBottom:4}}>Update Bandwidth</div>
          <div style={{fontSize:12.5,color:P.muted,marginBottom:16}}>Set your available bandwidth for learning this week. This affects your learning pace, mentor matching, and at-risk detection.</div>
          <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:12}}>
            <input type="range" min={0} max={100} step={5} value={liveBW}
              onChange={e=>setLiveBW(Number(e.target.value))}
              style={{flex:1,accentColor:"#EB1000",cursor:"pointer"}}/>
            <span style={{fontSize:18,fontWeight:500,color:liveBW<50?P.red:liveBW<75?P.amber:P.grn,minWidth:48,textAlign:"right"}}>{liveBW}%</span>
          </div>
          <div style={{display:"flex",gap:8,marginBottom:16}}>
            {[25,50,75,100].map(v=>{const acc=getThemeMode()==="dark"?"#FF6A5C":"#EB1000";const accbg=getThemeMode()==="dark"?"rgba(235,16,0,.12)":"#FFF1ED";return(
              <button key={v} onClick={()=>setLiveBW(v)}
                style={{flex:1,padding:"6px 0",fontSize:12,fontWeight:liveBW===v?600:400,color:liveBW===v?acc:P.muted,background:liveBW===v?accbg:"transparent",border:`1px solid ${liveBW===v?"#EB1000":P.border}`,borderRadius:7,cursor:"pointer"}}>
                {v}%
              </button>
            );})}
          </div>
          <div style={{fontSize:11.5,color:P.muted,marginBottom:12}}>
            {liveBW<40?"Very limited — consider pausing non-critical modules":liveBW<65?"Moderate — paced learning recommended":liveBW<85?"Good — full track available":"Full — all modules and Capstone unlocked"}
          </div>
          <Btn full onClick={saveBW} disabled={bwSaving} size="md">{bwSaving?"Saving…":"Save Bandwidth"}</Btn>
          {bwSaved&&<div style={{fontSize:12,color:P.grn,marginTop:8,textAlign:"center"}}>Saved to database · Curriculum Agent updated</div>}
        </Card>
      </div>}
    </div>
  </div>);
}

// ── EXP DASHBOARD ─────────────────────────────────────────────────────────────

// ── Track Selection Dashboard (post-capstone EXP experience) ──────────────────
// Cross-skill track catalogue. Every entry here has real, verified curriculum
// content seeded in the DB (curriculum_topics) — so all are available:true and
// their Study Cards / Practice Scenarios / Capstone all resolve to real lessons.
// Mirrors the 10 content tracks in learning_tracks (aep is folded into rtcdp).
const CROSS_SKILL_TRACKS=[
  {id:"rtcdp",   label:"Real-Time CDP",           desc:"Profiles, Segmentation, Destinations, Activation",       icon:Target,            available:true, skills:["RT-CDP","AEP Segments"]},
  {id:"da",      label:"AEP - Data Architect",    desc:"Schemas, XDM, identity, profile & audience design",      icon:Building,          available:true, skills:["AEP Segments","Data Ingestion"]},
  {id:"de",      label:"AEP - Data Engineer",     desc:"Batch & streaming ingestion, sources, datasets",         icon:Data,              available:true, skills:["Data Ingestion","RT-CDP"]},
  {id:"ajo",     label:"Adobe Journey Optimizer", desc:"Real-time journeys, email, push, SMS, AI decisioning",   icon:RocketQuickActions,available:true, skills:["AJO"]},
  {id:"cja",     label:"Customer Journey Analytics",desc:"Cross-channel analytics built on AEP, advanced CJA",   icon:ChartBarVert,      available:true, skills:["Analytics/CJA"]},
  {id:"analytics",label:"Adobe Analytics",        desc:"Classic Analytics - eVars, props, Analysis Workspace",   icon:ChartTrend,        available:true, skills:["Analytics/CJA"]},
  {id:"target",  label:"Adobe Target",            desc:"A/B testing, personalization, recommendations",          icon:Target,            available:true, skills:["RT-CDP"]},
  {id:"marketo", label:"Marketo Engage",          desc:"Marketing automation, lead management, campaigns",        icon:Chat,              available:true, skills:["Marketo"]},
  {id:"campaign",label:"Adobe Campaign Classic",  desc:"Cross-channel campaigns, workflows, deliveries",          icon:Education,         available:true, skills:["Marketo"]},
  {id:"es",      label:"Engineering Services",    desc:"App Builder, I/O Runtime, Destination SDK, CI/CD",       icon:Code,              available:true, skills:["Data Ingestion"]},
];

// ── Reusable site footer (Nexus / Learn / Support / Adobe + socials) ──────────
function SiteFooter({setTab,mobile,cols}){
  const isDark=getThemeMode()==="dark";
  const BANNER=isDark?"linear-gradient(120deg,#241640 0%,#34183f 55%,#3f1d34 100%)":"linear-gradient(125deg,#FFF1ED 0%,#FBD9D0 42%,#F3C3B8 72%,#EFB7AC 100%)";
  const bINK=isDark?"#F1F2F5":"#1B2140";
  const bMUT=isDark?"rgba(255,255,255,.82)":"#5a5f6e";
  const wrap={maxWidth:1080,margin:"0 auto",padding:"0 32px"};
  const columns=cols||[
    {h:"Learn",l:[{t:"Learning Path",tab:"track"},{t:"Practice",tab:"shadow"},{t:"Capstone",tab:"capstone"}]},
    {h:"Support",l:[{t:"Knowledge Base",tab:"kb"},{t:"AI Tutor",tab:"assist"},{t:"Community",tab:"community"}]},
    {h:"Adobe",l:[{t:"Experience League",href:"https://experienceleague.adobe.com"},{t:"Trust Center",href:"https://www.adobe.com/trust.html"},{t:"Privacy",href:"https://www.adobe.com/privacy/policy.html"},{t:"Terms",href:"https://www.adobe.com/legal/terms.html"}]},
  ];
  return(
    <footer style={{background:BANNER,color:bMUT,padding:"40px 0 26px",borderRadius:16,marginTop:16,overflow:"hidden"}}>
      <div style={{...wrap,display:"grid",gridTemplateColumns:mobile?"1fr 1fr":"1.4fr 1fr 1fr 1fr",gap:26}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:12}}>
            <svg width="22" height="20" viewBox="0 0 29 26" fill="none"><path d="M10.0158 20.23H13.9542L16.4333 25.1033H20.0317L14.1667 9.7325L10.0158 20.23ZM0 0V25.5L10.5117 0H0ZM17.68 0L28.3333 25.2308V0H17.68Z" fill="#EA3829"/></svg>
            <span style={{fontSize:16,fontWeight:700,color:bINK}}>Nexus</span>
          </div>
          <p style={{fontSize:13,lineHeight:1.6,maxWidth:240,margin:0}}>Adobe internal learning — from onboarding to platform expert.</p>
        </div>
        {columns.map(col=>(
          <div key={col.h}>
            <div style={{fontSize:12.5,fontWeight:700,color:bINK,marginBottom:11}}>{col.h}</div>
            {col.l.map(x=>(x.href
              ?<a key={x.t} href={x.href} target="_blank" rel="noreferrer" style={{display:"block",fontSize:13,marginBottom:8,color:bMUT,textDecoration:"none",cursor:"pointer"}}>{x.t}</a>
              :<button key={x.t} onClick={()=>setTab(x.tab)} style={{display:"block",fontSize:13,marginBottom:8,color:bMUT,background:"none",border:"none",padding:0,cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>{x.t}</button>
            ))}
          </div>
        ))}
      </div>
      <div style={{...wrap,borderTop:`1px solid ${isDark?"rgba(255,255,255,.14)":"rgba(0,0,0,.1)"}`,marginTop:26,paddingTop:16,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12,fontSize:12}}>
        <span>© 2026 Adobe. All rights reserved.</span>
        <div style={{display:"flex",gap:14}}>
          {[
            {n:"Facebook",href:"https://www.facebook.com/Adobe/",p:"M13 22v-8h3l.5-3.5H13V8.3c0-1 .3-1.7 1.8-1.7H17V3.5C16.6 3.4 15.4 3.3 14 3.3c-2.7 0-4.5 1.6-4.5 4.6v2.6H6.5V14h3v8z"},
            {n:"X",href:"https://x.com/Adobe",p:"M17.5 3h3l-6.55 7.5L21.7 21h-6l-4.7-6.1L5.6 21h-3l7-8L2.3 3h6.15l4.25 5.6zM16.4 19.2h1.65L7.7 4.7H5.9z"},
            {n:"LinkedIn",href:"https://www.linkedin.com/company/adobe",p:"M4.98 3.5A2.5 2.5 0 1 1 5 8.5a2.5 2.5 0 0 1-.02-5zM3 9h4v12H3zm7 0h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V21h-4v-5.35c0-1.28-.02-2.92-1.78-2.92-1.78 0-2.05 1.4-2.05 2.83V21h-4z"},
            {n:"Instagram",href:"https://www.instagram.com/adobe/",p:"M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H7zm5 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm4.75-3.75a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5z"},
          ].map(s=>(<a key={s.n} href={s.href} target="_blank" rel="noreferrer" aria-label={s.n} style={{opacity:.85,display:"inline-flex"}}><svg width="18" height="18" viewBox="0 0 24 24" fill={bINK}><path d={s.p}/></svg></a>))}
        </div>
      </div>
    </footer>
  );
}

function EXPDash({onLogout,groqKey,onLog,onJudge,githubToken,profile,memberProjects,setMemberProjects,projectIssues,setProjectIssues,onToggleTheme}){
  // Avatar/username changes from Profile settings apply here immediately
  // (header, sidebar, everywhere `p` is used) — no page refresh needed.
  const [avatarOverride,setAvatarOverride]=useState(null);
  const p={...(profile||PROFILES.exp), ...(avatarOverride||{})};
  // Skills come from profile by default; per-skill quiz can override individual skills
  const [skillOverrides,setSkillOverrides]=useState({});
  useEffect(()=>{
    if(!p.id||!p.name)return;
    fetch(`${BACKEND}/api/skills/me?member_name=${encodeURIComponent(p.name)}`)
      .then(r=>r.json()).then(d=>{if(d?.skills)setSkillOverrides(prev=>({...d.skills,...prev}));})
      .catch(()=>{});
  },[p.id,p.name]);
  const [activeSkillQuiz,setActiveSkillQuiz]=useState(null); // skill being assessed
  const [quizzing,setQuizzing]=useState(false); // loading state for quiz gen
  const [quizData,setQuizData]=useState(null);  // {skill, questions, answers}
  const [tab,setTab]=useState("home");
  useEffect(()=>{const h=e=>{const tb=e.detail?.tab;if(tb)setTab(tb);};window.addEventListener("nexus:navigate",h);return()=>window.removeEventListener("nexus:navigate",h);},[]);
  const [expandedModule,setExpandedModule]=useState(null);
  const [studyModule,setStudyModule]=useState(null);
  const [lessonModule,setLessonModule]=useState(null);
  const [chosenCrossTrack,setChosenCrossTrack]=useState(null); // currently viewed track
  const [showTrackPicker,setShowTrackPicker]=useState(false);
  const [enrolledTracks,setEnrolledTracks]=useState([]); // all active cross-skill tracks
  const [trackProgress,setTrackProgress]=useState({}); // track → modules_done
  const [capstonesDone,setCapstonesDone]=useState([]); // per-track capstones completed
  const primaryTrack=getTrack(p);
  // Everyone on the experienced dashboard has already cleared the PRIMARY
  // onboarding capstone — either they completed it (capstone_completed) or they
  // are 6+ months tenured (classify_persona promotes them to 'exp'). Treat the
  // primary capstone as done for the cross-skilling flow either way, and tell them.
  const primaryDone=!!p.capstone_completed||p.persona==="exp"||/6\+|Year/.test(String(p.tenure||""));
  // Load which additional track capstones this learner has completed.
  useEffect(()=>{
    if(!p.id||!p.name)return;
    fetch(`${BACKEND}/api/tracks/capstone?member=${encodeURIComponent(p.name)}`)
      .then(r=>r.json()).then(d=>{if(Array.isArray(d?.completed_tracks))setCapstonesDone(d.completed_tracks);})
      .catch(()=>{});
  },[p.id,p.name]);
  const recordTrackCapstone=(tr,score)=>{
    setCapstonesDone(prev=>prev.includes(tr)?prev:[...prev,tr]);
    if(p.id)fetch(`${BACKEND}/api/tracks/capstone/complete`,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({member:p.name,track:tr,score:score??null})}).catch(()=>{});
  };

  const [modulesDoneCount,setModulesDoneCount]=useState(0);
  useEffect(()=>{
    if(!p.id||!p.name)return;
    fetch(`${BACKEND}/api/progress?member_name=${encodeURIComponent(p.name)}&track=${getTrack(p)}`)
      .then(r=>r.json()).then(d=>setModulesDoneCount((d?.completed||[]).length)).catch(()=>{});
  },[p.id,p.name]);
  const [pointsRefresh,setPointsRefresh]=useState(0);
  const [liveConf,setLiveConf]=useState(p.conf!=null?p.conf:.76);
  const updateConf=(delta)=>setLiveConf(c=>Math.max(0,Math.min(1,c+delta)));
  const [msgs,setMsgs]=useState([{role:"assistant",content:`Hi ${p.name?.split(" ")[0]||"there"}! I'm your cross-skilling advisor. I can recommend the best next track for your role and tenure, or explore any skill you're curious about. Where would you like to grow?`}]);
  const [input,setInput]=useState(""),[busy,setBusy]=useState(false);
  const ref=useRef(null);
  useEffect(()=>{if(ref.current)ref.current.scrollTop=ref.current.scrollHeight;},[msgs]);

  // Merge profile skills with any quiz-updated overrides
  // For REAL registered users, skills come ONLY from their own assessments /
  // self-reports (skillOverrides, loaded from /api/skills/me). We deliberately do
  // NOT fall back to p.skills[i] here — that array is the hardcoded demo-persona
  // value (PROFILES.exp) which would otherwise leak in as fake levels. Demo
  // personas (no p.id) keep their illustrative p.skills.
  const selfSkills=SKILLS.map((sk,i)=>skillOverrides[sk]||(p.id?"none":(p.skills?.[i]||"none")));
  // Self-report a skill level without the CAT quiz (persisted like an assessment,
  // theta:null so it's clearly a self-report, not an adaptive-test result).
  const saveSkillLevel=(skill,level)=>{
    setSkillOverrides(prev=>({...prev,[skill]:level}));
    if(p.id){
      fetch(`${BACKEND}/api/skills/assess`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({member_name:p.name,manager:p.manager||null,skill,level,theta:null})}).catch(()=>{});
    }
  };

  // Load enrolled tracks and per-track progress from DB
  useEffect(()=>{
    if(!p.id||!p.name)return;
    const mgr=p.manager||(p.email?"":"Michael Torres");
    fetch(`${BACKEND}/api/tracks/enrolled?member=${encodeURIComponent(p.name)}${p.id?`&member_id=${p.id}`:""}${p.email?`&email=${encodeURIComponent(p.email)}`:""}`)
      .then(r=>r.json()).then(d=>{
        if(d?.enrolled_tracks?.length>0)setEnrolledTracks(d.enrolled_tracks);
        else setEnrolledTracks([primaryTrack]);
      }).catch(()=>setEnrolledTracks([primaryTrack]));
    if(mgr)fetch(`${BACKEND}/api/tracks/progress?member=${encodeURIComponent(p.name)}&manager=${encodeURIComponent(mgr)}`)
      .then(r=>r.json()).then(d=>{ if(d?.progress)setTrackProgress(d.progress); })
      .catch(()=>{});
  },[p.name,p.manager,p.email,p.id]);

  const enrollInTrack=async(trackId)=>{
    // Demo personas (no real onboarding id) still get the local UI update —
    // only the backend persistence call is skipped for them. Previously this
    // whole function no-op'd (including the local state update) for any demo
    // login without a real id, silently breaking "Add track" for every demo
    // account.
    if(p.id){
      await fetch(`${BACKEND}/api/tracks/enroll`,{method:"POST",
        headers:{"Content-Type":"application/json"},
        // member_id/email are the reliable lookup keys — the session's display
        // name can drift from the directory record's name, silently 404ing a
        // name-only lookup.
        body:JSON.stringify({member:p.name,track:trackId,member_id:p.id,email:p.email||""})}).catch(()=>{});
    }
    setEnrolledTracks(prev=>prev.includes(trackId)?prev:[...prev,trackId]);
  };

  const removeTrack=async(trackId)=>{
    // The primary enablement track is the learner's core path — it can't be
    // dropped from the UI; only self-added cross-skill tracks can.
    if(trackId===primaryTrack)return;
    if(!window.confirm(`Remove ${TRACK_LABELS[trackId]||trackId.toUpperCase()} from your learning path? Your progress on it is kept if you re-add it later.`))return;
    if(p.id){
      await fetch(`${BACKEND}/api/tracks/unenroll`,{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({member:p.name,track:trackId,member_id:p.id,email:p.email||""})}).catch(()=>{});
    }
    setEnrolledTracks(prev=>prev.filter(t=>t!==trackId));
    // If we were viewing the track we just removed, fall back to the primary.
    setChosenCrossTrack(prev=>prev&&prev.id===trackId?null:prev);
  };

  // Shown on Study Cards / Practice for an experienced learner who has finished
  // their enablement and hasn't yet activated a new cross-skill track. These
  // learning tools only make sense against an ACTIVE path, so we route the
  // learner into the cross-skilling flow (AI Advisor → Curriculum Agent) or the
  // track picker rather than silently operating on their already-completed path.
  const CrossSkillGate=({feature})=>(
    <div style={{maxWidth:540,margin:"0 auto",padding:"44px 24px"}}>
      <Card style={{padding:"30px 28px",textAlign:"center"}}>
        <div style={{marginBottom:14,display:"flex",justifyContent:"center"}}><Ic as={RocketQuickActions} size={34} color={P.blue}/></div>
        <div style={{fontSize:17,fontWeight:600,color:P.txt,marginBottom:8}}>Pick a skill to activate {feature}</div>
        <div style={{fontSize:13,color:P.muted,lineHeight:1.75,marginBottom:22}}>
          You've completed your enablement, so you don't have an active learning path right now. Choose a new skill to cross-skill into — the <strong>AI Advisor</strong> recommends one, and the <strong>Curriculum Agent</strong> builds the track. {feature} and every other learning tool then activate for that track.
        </div>
        <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
          <Btn onClick={()=>setTab("agent")}>Ask the AI Advisor</Btn>
          <Btn variant="secondary" onClick={()=>setTab("track")}>Browse tracks</Btn>
        </div>
        <div style={{fontSize:11.5,color:P.dim,marginTop:18,lineHeight:1.6}}>
          Want a certification on a skill you already have? Activate that track from <strong>Learning Path</strong> and proceed with the refresher.
        </div>
      </Card>
    </div>
  );


  const sendExp=async(overrideText=null)=>{
    const typed=(typeof overrideText==="string"?overrideText:input);
    if(!typed.trim()||busy)return;
    const nm={role:"user",content:typed.trim()},next=[...msgs,nm];
    setMsgs(next);setInput("");setBusy(true);
    // Real profile/track/extra — the backend's run_crossskill_chat (tool-calling)
    // needs these to compute the SAME ranked-track/role-journey grounding as the
    // recommendation card. Previously this call sent only agentName/logFn, so a
    // chat turn had ZERO learner context server-side regardless of what the
    // frontend prompt said.
    try{const r=await callAgent(next.map(m=>({role:m.role,content:m.content})),"",groqKey,{
      agentName:"CrossSkilling",logFn:onLog,
      profile:{name:p.name,role:p.role,bw:p.bw,team:p.team,active_track:getTrack(p),track:getTrack(p)},
      track:getTrack(p),
      extra:{manager_name:p.manager||"",completed_tracks:[...(primaryDone?[primaryTrack]:[]),...capstonesDone],enrolled_tracks:enrolledTracks},
    });judgeGenericResponse(r, "CrossSkilling").catch(()=>{});setMsgs(prev=>[...prev,{role:"assistant",content:r}]);}
    catch(e){setMsgs(prev=>[...prev,{role:"assistant",content:`Error: ${e.message}`}]);}
    setBusy(false);
  };

  // ── AI Advisor = the real Cross-Skilling Agent (backend, run_crossskill) ────
  // Previously "AI Advisor" was just a client-side chat prompt that never called
  // this agent or acted on its recommendation. Now: fetch one structured
  // recommendation from the backend agent, show it, and on explicit confirm
  // ("yes, start this track") actually enroll the learner in that track —
  // handing off to the same enrollment path (enrollInTrack) the curriculum
  // agent's track picker already uses.
  const [advisorRec,setAdvisorRec]=useState(null);
  const [advisorLoading,setAdvisorLoading]=useState(false);
  const [advisorError,setAdvisorError]=useState(null);
  const [advisorConfirmed,setAdvisorConfirmed]=useState(false);
  // Tracks already shown this session — sent back as exclude_tracks so "Show me
  // something else" advances to the next-best track instead of re-serving the
  // same deterministic top pick every time.
  const [advisorSeenTracks,setAdvisorSeenTracks]=useState([]);

  const loadAdvisorRecommendation=async(excludeTracks=advisorSeenTracks)=>{
    setAdvisorLoading(true);setAdvisorError(null);setAdvisorConfirmed(false);
    try{
      const r=await fetch(`${BACKEND}/api/agents/advisor`,{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          // `track` grounds the skill-map journey when the learner isn't in the HR
          // directory and their job title doesn't match a journey row — the backend
          // maps the active track (da/de/rtcdp/es/aa-sdk) to the role journey.
          track: getTrack(p),
          messages:[],
          profile:{name:p.name,role:p.role,bw:p.bw,team:p.team,active_track:getTrack(p),track:getTrack(p)},
          extra:{
            manager_name:     p.manager||"",
            completed_tracks: [...(primaryDone?[primaryTrack]:[]),...capstonesDone],
            enrolled_tracks:  enrolledTracks,
            skills:           Object.fromEntries(SKILLS.map((sk,i)=>[sk,selfSkills[i]])),
            exclude_tracks:   excludeTracks,
          },
        })});
      const d=await r.json();
      if(!r.ok||!d.result)throw new Error(d.detail||"No recommendation available");
      setAdvisorRec(d.result);
      if(d.result.recommended_track)setAdvisorSeenTracks(prev=>[...new Set([...prev,d.result.recommended_track])]);
    }catch(e){setAdvisorError(e.message||"Could not reach the Cross-Skilling Agent.");}
    setAdvisorLoading(false);
  };

  useEffect(()=>{if(tab==="agent"&&!advisorRec&&!advisorLoading)loadAdvisorRecommendation();},[tab]);

  const confirmAdvisorTrack=async()=>{
    const trackId=advisorRec?.recommended_track;
    if(!trackId)return;
    await enrollInTrack(trackId);                 // keep local state + /api/tracks/enroll in sync
    // Start the learning track: one call enrols the member server-side and builds
    // the ordered curriculum path for this track.
    try{
      await fetch(`${BACKEND}/api/cross-skilling/confirm`,{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({member:p.name,track:trackId,member_id:p.id,email:p.email||""})});
    }catch{}
    setChosenCrossTrack({id:trackId,label:TRACK_LABELS[trackId]||trackId.toUpperCase()});
    setAdvisorConfirmed(true);
  };

  // CAT Quiz state
  const [catState,setCatState]=useState(null);
  // catState: {skill, items, responses, thetas, currentItem, done, finalTheta}
  // BKT mastery state per skill
  const [bktMastery,setBktMastery]=useState(()=>Object.fromEntries(SKILLS.map(s=>[s,BKT_PARAMS.pL0])));

  // Launch CAT for a specific skill
  const startCATQuiz=(skill)=>{
    const skillItems=ITEM_BANK.filter(i=>i.skill===skill);
    const firstItem=CAT.selectNext(0,[],skillItems);
    setCatState({skill,items:skillItems,responses:[],usedIds:[firstItem?.id],thetas:[0],currentItem:firstItem,done:false,finalTheta:null});
    setActiveSkillQuiz(skill);
  };

  // Handle CAT answer
  const answerCAT=(selectedOption)=>{
    if(!catState||catState.done)return;
    const{currentItem,responses,items,usedIds,thetas}=catState;
    const correct=selectedOption===currentItem.correct?1:0;
    const newResponses=[...responses,correct];
    const answeredItems=items.filter(it=>usedIds.includes(it.id));
    const newTheta=IRT.estimateTheta(newResponses,answeredItems);
    const newThetas=[...thetas,newTheta];
    // Update BKT mastery for this skill
    const newPL=BKT.update(bktMastery[catState.skill],correct);
    setBktMastery(prev=>({...prev,[catState.skill]:newPL}));
    // Check stopping rule
    const shouldStop=CAT.shouldStop(newResponses,answeredItems,newTheta);
    if(shouldStop){
      const finalLevel=IRT.thetaToLevel(newTheta);
      setSkillOverrides(prev=>({...prev,[catState.skill]:finalLevel}));
      setCatState(prev=>({...prev,responses:newResponses,thetas:newThetas,done:true,finalTheta:newTheta,finalLevel,finalPL:newPL}));
      // Persist confidence score to DB
      fetch(`${BACKEND}/api/telemetry`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({persona:"exp",event_type:"cat_complete",module:catState.skill,
          detail:`θ=${newTheta.toFixed(2)} → ${finalLevel} · ${newResponses.length} items`})}).catch(()=>{});
      // Persist the actual skill level for real (DB-backed) users so it survives refresh and shows on the Manager's Skill Matrix
      if(p.id){
        fetch(`${BACKEND}/api/skills/assess`,{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({member_name:p.name,manager:p.manager||(p.email?"":"Michael Torres"),skill:catState.skill,level:finalLevel,theta:newTheta})}).catch(()=>{});
      }
    } else {
      const remaining=items.filter(it=>!usedIds.includes(it.id));
      const nextItem=CAT.selectNext(newTheta,[...usedIds],remaining);
      if(!nextItem){
        const finalLevel=IRT.thetaToLevel(newTheta);
        setSkillOverrides(prev=>({...prev,[catState.skill]:finalLevel}));
        setCatState(prev=>({...prev,responses:newResponses,thetas:newThetas,done:true,finalTheta:newTheta,finalLevel,finalPL:newPL}));
        fetch(`${BACKEND}/api/telemetry`,{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({persona:"exp",event_type:"cat_complete",module:catState.skill,
            detail:`θ=${newTheta.toFixed(2)} → ${finalLevel} · ${newResponses.length} items (bank exhausted)`})}).catch(()=>{});
        if(p.id) fetch(`${BACKEND}/api/skills/assess`,{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({member_name:p.name,manager:p.manager||(p.email?"":"Michael Torres"),skill:catState.skill,level:finalLevel,theta:newTheta})}).catch(()=>{});
      } else {
        setCatState(prev=>({...prev,responses:newResponses,thetas:newThetas,currentItem:nextItem,usedIds:[...usedIds,nextItem.id]}));
      }
    }
  };

  // CAT Quiz overlay
  if(activeSkillQuiz&&catState) return(
    <div style={{display:"flex",flexDirection:"column",height:"100vh",fontFamily:"system-ui,-apple-system,sans-serif",background:P.bg}}>
      <Nav initial={p.initial} name={p.username||p.name} sub={`${p.role} · ${p.team}`} color={p.avatar_color||p.color} avatarEmoji={p.avatar_emoji} persona={p.persona||"exp"} onLogout={onLogout} onToggleTheme={onToggleTheme} onGoToProfile={()=>setTab("profile")}/>
      <div style={{flex:1,overflowY:"auto",padding:20}}>
        <button onClick={()=>{setActiveSkillQuiz(null);setCatState(null);}} style={{display:"flex",alignItems:"center",gap:6,background:"transparent",border:`1px solid ${P.border}`,borderRadius:7,padding:"6px 12px",fontSize:12.5,cursor:"pointer",color:P.txt,marginBottom:16}}><Ic as={ChevronLeft} size={14} color="currentColor"/> Back</button>

        {/* CAT Header */}
        <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:10,padding:18,marginBottom:16,boxShadow:"0 1px 4px rgba(0,0,0,.06)"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div>
              <div style={{fontSize:14,fontWeight:500,color:P.txt,marginBottom:2}}>Adaptive Assessment · {catState.skill}</div>
              <div style={{fontSize:11.5,color:P.muted}}>Computerised Adaptive Testing · questions adjust to your ability in real-time</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:11,color:P.muted,marginBottom:2}}>Question {catState.responses.length+1}{!catState.done?" of ~"+Math.min(8,catState.items.length):""}</div>
              <div style={{fontSize:11,color:P.dim}}>SE: {catState.thetas.length>1?IRT.standardError(catState.thetas[catState.thetas.length-1],ITEM_BANK.filter(i=>catState.usedIds?.includes(i.id))).toFixed(2):"—"}</div>
            </div>
          </div>
          {/* Real-time theta meter */}
          <div style={{marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{fontSize:11,fontWeight:600,color:P.muted}}>Ability Estimate (θ)</span>
              <span style={{fontSize:12,fontWeight:500,color:P.blue}}>{catState.thetas.length>1?`θ = ${catState.thetas[catState.thetas.length-1].toFixed(2)}` : "Calibrating…"}</span>
            </div>
            <div style={{height:8,background:P.bfaint,borderRadius:4,overflow:"hidden",position:"relative"}}>
              {/* Scale markers */}
              {[-3,-1.5,0,1.5,3].map(v=>(
                <div key={v} style={{position:"absolute",left:`${(v+3)/6*100}%`,top:0,bottom:0,width:1,background:P.border,opacity:.5}}/>
              ))}
              <div style={{height:"100%",background:`linear-gradient(90deg,${P.red},${P.amber},${P.grn})`,borderRadius:4,width:`${((catState.thetas[catState.thetas.length-1]+3)/6)*100}%`,transition:"width .5s ease"}}/>
              {/* Theta cursor */}
              <div style={{position:"absolute",top:-2,height:12,width:3,background:P.txt,borderRadius:1,left:`${((catState.thetas[catState.thetas.length-1]+3)/6)*100}%`,transform:"translateX(-50%)",transition:"left .5s ease"}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginTop:3}}>
              {["None","Developing","Proficient","Expert"].map((l,i)=><span key={l} style={{fontSize:9.5,color:P.dim}}>{l}</span>)}
            </div>
          </div>
          {/* BKT Mastery */}
          {catState.responses.length>0&&<div style={{display:"flex",alignItems:"center",gap:8,marginTop:8,padding:"6px 10px",background:P.bg,borderRadius:6}}>
            <span style={{fontSize:11,color:P.muted}}>BKT Mastery P(L):</span>
            <span style={{fontSize:12,fontWeight:500,color:P.grn}}>{Math.round(bktMastery[catState.skill]*100)}%</span>
            <div style={{flex:1,height:4,background:P.bfaint,borderRadius:2,overflow:"hidden"}}>
              <div style={{height:"100%",background:P.grn,width:`${bktMastery[catState.skill]*100}%`,transition:"width .4s"}}/>
            </div>
            <span style={{fontSize:10.5,fontWeight:500,color:bktMastery[catState.skill]>0.85?P.grn:bktMastery[catState.skill]>0.65?P.amber:P.red}}>{BKT.masteryToLevel(bktMastery[catState.skill])}</span>
          </div>}
        </div>

        {/* Question / Result */}
        {!catState.done&&catState.currentItem&&(
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:10,padding:20,boxShadow:"0 1px 4px rgba(0,0,0,.06)"}}>
            <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
              {/* Difficulty indicator */}
              <div style={{display:"flex",gap:3}}>
                {[1,2,3].map(i=><div key={i} style={{width:8,height:8,borderRadius:"50%",background:i<=Math.round((catState.currentItem.b+2)/4*3+1)?P.amber:P.bfaint}}/>)}
              </div>
              <span style={{fontSize:10.5,color:P.muted}}>b={catState.currentItem.b.toFixed(1)} · a={catState.currentItem.a.toFixed(1)}</span>
            </div>
            <div style={{fontSize:14,fontWeight:600,color:P.txt,marginBottom:16,lineHeight:1.6}}>{catState.currentItem.question}</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {catState.currentItem.options.map((opt,oi)=>(
                <button key={oi} onClick={()=>answerCAT(oi)} style={{padding:"11px 16px",border:`1.5px solid ${P.border}`,borderRadius:8,background:"transparent",color:P.txt,fontSize:13.5,cursor:"pointer",textAlign:"left",fontWeight:400,transition:"border-color .15s"}}>
                  <span style={{fontWeight:500,marginRight:10,color:P.muted}}>{["A","B","C","D"][oi]}.</span>{opt}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* CAT Complete */}
        {catState.done&&(
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:10,padding:24,textAlign:"center"}}>
            <div style={{marginBottom:12,display:"flex",justifyContent:"center"}}>
              <Ic
                as={catState.finalLevel==="expert"?Ribbon:catState.finalLevel==="proficient"?CheckmarkCircle:catState.finalLevel==="developing"?ChartTrend:FileText}
                size={28}
                color={catState.finalLevel==="expert"?P.amber:catState.finalLevel==="proficient"?P.grn:catState.finalLevel==="developing"?P.blue:P.muted}
              />
            </div>
            <div style={{fontSize:16,fontWeight:500,color:P.txt,marginBottom:6}}>Assessment Complete</div>
            <div style={{display:"flex",justifyContent:"center",gap:24,marginBottom:20}}>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:24,fontWeight:600,color:P.blue}}>θ = {catState.finalTheta.toFixed(2)}</div>
                <div style={{fontSize:11,color:P.muted}}>IRT ability estimate</div>
              </div>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:24,fontWeight:600,color:P.grn}}>{Math.round(catState.finalPL*100)}%</div>
                <div style={{fontSize:11,color:P.muted}}>BKT mastery P(L)</div>
              </div>
              <div style={{textAlign:"center"}}>
                <div style={{fontSize:24,fontWeight:600,color:P.amber}}>{catState.responses.length}</div>
                <div style={{fontSize:11,color:P.muted}}>questions used</div>
              </div>
            </div>
            <div style={{display:"inline-flex",alignItems:"center",gap:8,background:catState.finalLevel==="expert"?P.grnBg:catState.finalLevel==="proficient"?P.blueGh:P.amberBg,border:`1px solid ${catState.finalLevel==="expert"?P.grn:catState.finalLevel==="proficient"?P.blue:P.amber}`,borderRadius:8,padding:"8px 20px",marginBottom:20}}>
              <span style={{fontSize:15,fontWeight:500,color:catState.finalLevel==="expert"?P.grn:catState.finalLevel==="proficient"?P.blue:P.amber}}>
                {catState.skill}: {catState.finalLevel}
              </span>
            </div>
            <div style={{fontSize:12.5,color:P.muted,marginBottom:16}}>
              Ability estimate θ={catState.finalTheta.toFixed(2)} → {catState.finalLevel} · BKT mastery updated · SE={IRT.standardError(catState.finalTheta,ITEM_BANK.filter(i=>catState.usedIds.includes(i.id))).toFixed(2)}
            </div>
            <button onClick={()=>{setActiveSkillQuiz(null);setCatState(null);}} style={{background:`linear-gradient(135deg,${P.grn},#1a7a55)`,color:"#fff",border:"none",borderRadius:7,padding:"10px 24px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Back to Upskilling</button>
          </div>
        )}
      </div>
    </div>
  );

  const tabs=[{id:"home",label:"Home",icon:Home},{id:"track",label:"Learning Path",icon:Education},{id:"assist",label:"AI Tutor",icon:Chat},{id:"capstone",label:"Capstone",icon:Ribbon},{id:"shadow",label:"Practice Scenarios",icon:Target},{id:"relnotes",label:"Release Notes",icon:FileText},{id:"projects",label:"Projects",icon:Briefcase},{id:"tracker",label:"Weekly Tracker",icon:Calendar},{id:"community",label:"Community",icon:CommunityIcon},{id:"agent",label:"AI Advisor",icon:Chat},{id:"profile",label:"Profile",icon:User}];
  const {mobile}=useViewport();
  // Real data only — the learner's own assessed level, not a fabricated
  // "market demand"/"team average" comparison (removed; there was no real
  // data source behind those, just hardcoded constants baked into the bundle).
  const criticalGaps=SKILLS.filter((_,i)=>selfSkills[i]==="none"||selfSkills[i]==="developing");
  // Hero subtitle is derived LIVE from the signed-in learner's real profile
  // (tenure, active track, capstone status, self-assessed skill gaps) rather
  // than a hardcoded demo `story` string — so it's always true to the actual
  // user. Falls back gracefully when a field is missing.
  const heroStory=[
    p.tenure,
    `${TRACK_LABELS[getTrack(p)]||getTrack(p).toUpperCase()} track`,
    p.capstone_completed?"capstone complete":"capstone in progress",
    criticalGaps.length?`${criticalGaps.length} skill gap${criticalGaps.length!==1?"s":""} to close`:"skills on track",
  ].filter(Boolean).join(" · ");
  return(<div style={{display:"flex",flexDirection:"column",height:"100vh",fontFamily:"'adobe-clean','Source Sans 3',system-ui,sans-serif",background:P.bg}}>
    <GlobalStyles/>
    <Nav initial={p.initial} name={p.username||p.name} sub={`${p.role} · ${p.tenure}`} color={p.avatar_color||p.color} avatarEmoji={p.avatar_emoji} persona={p.persona||"exp"} onLogout={onLogout} onToggleTheme={onToggleTheme} onGoToProfile={()=>setTab("profile")}/>
    {mobile?<Tabs items={tabs} active={tab} onChange={setTab}/>:<SideNav items={tabs} active={tab} onChange={setTab}/>}
    <div className="nx-main-content" style={{flex:1,overflowY:"auto",paddingLeft:mobile?0:SIDENAV_WIDTH}}>

      {/* EXP Learning Path */}
      {tab==="track"&&(()=>{
        const expTrack=chosenCrossTrack?.id||getTrack(p);
        const expModules=getModulesForTrack(expTrack);
        const expDone=expModules.filter(m=>m.status==="done").length;
        // If primary capstone done + no cross-skill chosen → show completion + picker
        if(primaryDone&&!chosenCrossTrack)return(
          <div style={{maxWidth:680,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:16}}>
            <Card style={{padding:"22px 24px",background:`linear-gradient(135deg,${P.grnBg},${P.blueGh})`,border:`1px solid ${P.grn}25`}}>
              <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
                <Ic as={CheckmarkCircle} size={24} color={P.grn}/>
                <div>
                  <div style={{fontSize:16,fontWeight:500,color:P.txt}}>Primary track complete — your capstone is done</div>
                  <div style={{fontSize:12.5,color:P.muted}}>{p.capstone_completed?"You've finished all modules and your capstone is approved.":"You're 6+ months into your primary track, so your onboarding capstone is complete. Choose a new track to cross-skill into."}</div>
                </div>
              </div>
            </Card>
            <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:4}}>Choose a skill to develop next</div>
            <div style={{fontSize:12.5,color:P.muted,marginBottom:12}}>Pick a cross-skill track to continue your growth. You can switch anytime.</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              {CROSS_SKILL_TRACKS.filter(t=>!enrolledTracks.includes(t.id)).map(t=>({
                ...t,
                demand:["ajo","de","rtcdp"].includes(t.id)?"Critical":["analytics","campaign","marketo"].includes(t.id)?"Stable":"High",
                dc:["ajo","de","rtcdp"].includes(t.id)?P.red:["analytics","campaign","marketo"].includes(t.id)?P.grn:P.amber
              })).map(tr=>(
                <div key={tr.id} onClick={()=>{
                  setChosenCrossTrack(tr);
                  enrollInTrack(tr.id);
                }}
                  style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,padding:"16px",cursor:"pointer",transition:"border-color .15s"}}
                  onMouseEnter={e=>e.currentTarget.style.borderColor=P.blue}
                  onMouseLeave={e=>e.currentTarget.style.borderColor=P.border}>
                  <div style={{marginBottom:8}}><Ic as={tr.icon} size={22} color={tr.dc}/></div>
                  <div style={{fontSize:13.5,fontWeight:500,color:P.txt,marginBottom:4}}>{tr.label}</div>
                  <div style={{fontSize:12,color:P.muted,marginBottom:10,lineHeight:1.5}}>{tr.desc}</div>
                  <span style={{fontSize:10.5,fontWeight:500,color:tr.dc,background:tr.dc+"15",borderRadius:5,padding:"2px 8px"}}>{tr.demand} demand</span>
                </div>
              ))}
            </div>
          </div>
        );
        return(<div style={{height:"100%",display:"flex",flexDirection:"column"}}>
          {/* Multi-track switcher bar */}
          <div style={{padding:"8px 16px",borderBottom:`1px solid ${P.border}`,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",background:P.surface}}>
            <span style={{fontSize:10.5,fontWeight:600,color:P.dim,marginRight:4}}>TRACKS:</span>
            {[{id:primaryTrack,label:TRACK_LABELS[primaryTrack]||primaryTrack.toUpperCase(),primary:true},
              ...enrolledTracks.filter(t=>t!==primaryTrack).map(t=>({id:t,label:TRACK_LABELS[t]||t.toUpperCase(),primary:false}))
            ].map(tr=>{
              const active=(chosenCrossTrack?.id||primaryTrack)===tr.id;
              const done=trackProgress[tr.id]||0;
              return(
                <span key={tr.id} style={{display:"inline-flex",alignItems:"center",flexShrink:0,position:"relative"}}>
                  <button onClick={()=>{setShowTrackPicker(false);tr.primary?setChosenCrossTrack(null):setChosenCrossTrack({id:tr.id,label:tr.label});}}
                    style={{display:"flex",alignItems:"center",gap:6,padding:"5px 12px",paddingRight:tr.primary?12:24,borderRadius:20,fontSize:12,fontWeight:active?700:400,
                      background:active?P.blue:"transparent",color:active?"#fff":P.muted,
                      border:`1px solid ${active?P.blue:P.border}`,cursor:"pointer",fontFamily:"inherit"}}>
                    {tr.label}
                    {tr.primary&&<span style={{fontSize:9.5,opacity:.7}}>Primary</span>}
                    {((tr.primary&&primaryDone)||capstonesDone.includes(tr.id))
                      ?<span title="Capstone complete" style={{fontSize:9.5,background:active?"rgba(255,255,255,.25)":P.grnBg,borderRadius:8,padding:"1px 5px",color:active?"#fff":P.grn}}>✓ capstone</span>
                      :done>0&&<span style={{fontSize:9.5,background:active?"rgba(255,255,255,.25)":P.blueGh,borderRadius:8,padding:"1px 5px",color:active?"#fff":P.blue}}>{done}/{getModulesForTrack(tr.id).length}</span>}
                  </button>
                  {!tr.primary&&<span role="button" title={`Remove ${tr.label}`} onClick={e=>{e.stopPropagation();removeTrack(tr.id);}}
                    style={{position:"absolute",right:7,top:"50%",transform:"translateY(-50%)",fontSize:13,lineHeight:1,cursor:"pointer",color:active?"rgba(255,255,255,.85)":P.dim,fontWeight:600}}>×</span>}
                </span>
              );
            })}
            {/* Add track button */}
            <button onClick={()=>setShowTrackPicker(true)}
              style={{fontSize:11.5,color:P.blue,background:P.blueGh,border:`1px solid ${P.blue}30`,borderRadius:20,padding:"4px 12px",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>+ Add track</button>
          </div>
          {showTrackPicker&&(
            <div style={{position:"absolute",inset:0,zIndex:10,background:P.bg+"ee",display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"48px 24px",overflowY:"auto"}}>
              <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:16,padding:"24px",maxWidth:640,width:"100%"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                  <div style={{fontSize:16,fontWeight:500,color:P.txt}}>Choose a track to add</div>
                  <button onClick={()=>setShowTrackPicker(false)} style={{background:"transparent",border:"none",fontSize:18,color:P.muted,cursor:"pointer"}}>✕</button>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  {CROSS_SKILL_TRACKS.filter(t=>!enrolledTracks.includes(t.id)).map(t=>(
                    <div key={t.id} style={{border:`1px solid ${t.available?P.border:P.bfaint}`,borderRadius:10,padding:"14px",opacity:t.available?1:.55,cursor:t.available?"pointer":"not-allowed"}}
                      onClick={()=>{
                        if(!t.available)return;
                        setChosenCrossTrack({id:t.id,label:t.label});
                        enrollInTrack(t.id);
                        setShowTrackPicker(false);
                      }}>
                      <div style={{marginBottom:6}}><Ic as={t.icon} size={22} color={t.available?P.blue:P.dim}/></div>
                      <div style={{fontSize:13.5,fontWeight:500,color:P.txt,marginBottom:4}}>{t.label}</div>
                      <div style={{fontSize:12,color:P.muted,lineHeight:1.5,marginBottom:10}}>{t.desc}</div>
                      {t.available
                        ?<div style={{fontSize:11.5,fontWeight:600,color:P.blue,display:"inline-flex",alignItems:"center",gap:4}}>Start this track <Ic as={ChevronRight} size={13} color="currentColor"/></div>
                        :<div style={{fontSize:11,color:P.dim}}>Coming soon</div>}
                    </div>
                  ))}
                  {CROSS_SKILL_TRACKS.filter(t=>!enrolledTracks.includes(t.id)).length===0&&(
                    <div style={{gridColumn:"1/-1",textAlign:"center",color:P.muted,padding:20,fontSize:13}}>You're enrolled in all available tracks.</div>
                  )}
                </div>
              </div>
            </div>
          )}
          <div style={{flex:1,overflow:"hidden",position:"relative"}}>
            <LearningPathView profile={p} groqKey={groqKey} done={expDone}
              studyModule={studyModule} setStudyModule={setStudyModule} expandedModule={expandedModule} setExpandedModule={setExpandedModule}
              mobile={mobile} track={expTrack} modules={expModules} onTestOutPass={()=>setPointsRefresh(k=>k+1)} onOpenLesson={setLessonModule}/>
            {lessonModule&&<ModuleLesson module={lessonModule} groqKey={groqKey} track={expTrack} userId={p?.id||p?.email||""} onClose={()=>setLessonModule(null)}/>}
          </div>
        </div>);
      })()}

      {/* AI Tutor — Socratic agent, available for upskilling and cross-skilling alike */}
      {tab==="assist"&&<div style={{height:"calc(100vh - 54px)",display:"flex",flexDirection:"column"}}>
        <LearningAssistant groqKey={groqKey} onLog={onLog} onJudge={onJudge} profile={{...p,conf:liveConf}} githubToken={githubToken} onConfUpdate={updateConf} dashboard="experience"/>
      </div>}

      {/* Capstone — for whichever track (main or cross-skill) is currently active */}
      {tab==="capstone"&&<div style={{height:"calc(100vh - 54px)",overflowY:"auto"}}>
        {chosenCrossTrack
          ?(()=>{
              const expTrackC=chosenCrossTrack.id;
              const expModsC=getModulesForTrack(expTrackC);
              const doneC=expModsC.filter(m=>m.status==="done").length;
              const totalC=expModsC.filter(m=>!m.capstone).length;
              const allDoneC=doneC>=totalC;
              const confOkC=liveConf>=CAPSTONE_CONFIDENCE_GATE;
              const thisCapDone=capstonesDone.includes(expTrackC);
              return(
                <div style={{maxWidth:580,margin:"0 auto",padding:"28px 24px"}}>
                  <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",marginBottom:8}}>
                    {chosenCrossTrack.label} · Track Capstone {thisCapDone&&<span style={{color:P.grn}}>· complete ✓</span>}
                  </div>
                  {thisCapDone&&(
                    <Card style={{padding:"18px 20px",marginBottom:16,borderLeft:`3px solid ${P.grn}`}}>
                      <div style={{fontSize:14,fontWeight:600,color:P.grn,marginBottom:4}}>You've completed the {chosenCrossTrack.label} capstone ✓</div>
                      <div style={{fontSize:12.5,color:P.muted}}>This track's capstone is recorded. Pick another track from Learning Path to keep cross-skilling.</div>
                    </Card>
                  )}
                  {!allDoneC&&(
                    <Card style={{padding:"22px 24px",marginBottom:16}}>
                      <div style={{fontSize:16,fontWeight:500,color:P.txt,marginBottom:8}}>Complete your learning track first</div>
                      <div style={{fontSize:13,color:P.muted,marginBottom:14}}>{doneC}/{totalC} modules complete — finish all modules to unlock the capstone.</div>
                      <div style={{height:6,background:P.bfaint,borderRadius:99,overflow:"hidden"}}>
                        <div style={{height:"100%",width:`${Math.round((doneC/Math.max(totalC,1))*100)}%`,background:P.blue,borderRadius:99}}/>
                      </div>
                      <div style={{marginTop:10,fontSize:12.5,color:P.muted}}>Go to Learning Path → complete remaining modules, then return here.</div>
                    </Card>
                  )}
                  {allDoneC&&!thisCapDone&&(
                    <Capstone profile={{...p,conf:liveConf,module:`${chosenCrossTrack.label} specialisation`}}
                      groqKey={groqKey} githubToken={githubToken} conf={liveConf} track={expTrackC}
                      allModulesDone={true} doneModules={doneC} totalModules={totalC}
                      persist={false} onComplete={recordTrackCapstone}/>
                  )}
                </div>
              );
            })()
          :(primaryDone
          ?<div style={{maxWidth:560,margin:"0 auto",padding:"28px 24px"}}>
              <Card style={{padding:"28px",textAlign:"center"}}>
                <div style={{marginBottom:12,display:"flex",justifyContent:"center"}}><Ic as={Ribbon} size={40} color={P.grn}/></div>
                <div style={{fontSize:20,fontWeight:600,color:P.grn,marginBottom:6}}>Your primary capstone is done</div>
                <div style={{fontSize:13.5,color:P.muted,lineHeight:1.7,marginBottom:20}}>
                  {p.capstone_completed
                    ?"You completed your onboarding capstone and your manager approved your work."
                    :"With 6+ months in your primary track, your onboarding capstone is considered complete. You're ready to cross-skill into a new track."}
                  {p.capstone_completed_at&&<span> Completed {new Date(p.capstone_completed_at).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})}.</span>}
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:10,textAlign:"left",marginBottom:24}}>
                  {["Practical AEP tasks across your full learning track","Reviewed by your manager","Confidence score validated ≥ 75","Unlocked cross-skill and upskill tracks"].map((item,i)=>(
                    <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                      <span style={{color:P.grn,fontWeight:500,fontSize:14,marginTop:1}}>✓</span>
                      <span style={{fontSize:13,color:P.txt}}>{item}</span>
                    </div>
                  ))}
                </div>
                <div style={{background:P.blueGh,border:`1px solid ${P.blue}25`,borderRadius:10,padding:"14px 16px",textAlign:"left",marginBottom:16}}>
                  <div style={{fontSize:12,fontWeight:600,color:P.blue,marginBottom:4}}>What's next?</div>
                  <div style={{fontSize:12.5,color:P.muted}}>Start a new learning track. Ask the <strong>AI Advisor</strong> which track fits your role and team next, or pick one yourself — the Curriculum Agent builds the path either way.</div>
                </div>
                <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
                  <Btn variant="primary" size="sm" onClick={()=>setTab("agent")}>Ask AI Advisor <Ic as={ChevronRight} size={14} color="currentColor"/></Btn>
                  <Btn variant="ghost" size="sm" onClick={()=>{setTab("track");setShowTrackPicker(true);}}>Pick a track</Btn>
                </div>
              </Card>
            </div>
          :(()=>{
              // Primary-track gate — previously never computed here at all (this
              // call site passed no allModulesDone/doneModules/totalModules, so
              // Capstone's own defaults left it permanently locked regardless of
              // the learner's real progress). Mirrors the cross-track branch above.
              const expModsP=getModulesForTrack(primaryTrack);
              const doneP=p.demoForceCapstoneUnlocked?expModsP.filter(m=>!m.capstone).length:expModsP.filter(m=>m.status==="done").length;
              const totalP=expModsP.filter(m=>!m.capstone).length;
              const allDoneP=doneP>=totalP;
              return <Capstone profile={{...p,conf:liveConf}} groqKey={groqKey} githubToken={githubToken} conf={liveConf}
                allModulesDone={allDoneP} doneModules={doneP} totalModules={totalP}/>;
            })())}
      </div>}

      {/* Practice Scenarios */}
      {tab==="shadow"&&(()=>{
        if(primaryDone&&!chosenCrossTrack)return <CrossSkillGate feature="Practice Scenarios"/>;
        const expTrack=chosenCrossTrack?.id||getTrack(p);
        const expModules=getModulesForTrack(expTrack);
        const activeModTitle=expModules.find(m=>m.status==="active")?.title||expModules[0].title;
        return <PracticeScenarios module={activeModTitle} groqKey={groqKey} profile={p} track={expTrack}/>;
      })()}

      {/* EXP Home */}
      {tab==="home"&&(()=>{
        const bw=calcBW(p.name,memberProjects,projectIssues);
        const isDark=getThemeMode()==="dark";
        const INK=isDark?"#F1F2F5":"#1B2140";
        const MUT=isDark?"#9DA1AE":"#6B7280";
        const PAGE=isDark?"#0F1117":"#fff";
        const CARDBG=isDark?"#171A22":"#fff";
        const CARDBD=isDark?"#282C38":"#ececec";
        const ACCENTTX=isDark?"#fff":P.red;
        const IMGS=["/images/st1.jpg","/images/st2.jpg","/images/st3.jpg","/images/st4.jpg","/images/st5.jpg","/images/st6.jpg","/images/st7.jpg","/images/st8.jpg"];
        const LOGOS=["/images/ic/logo-straight.png","/images/ic/logo-right.png","/images/ic/logo-left.png"];
        // Every agent + core feature gets a tile here, each showing this learner's
        // REAL session state (not a static description) — so Home is a genuine
        // one-tap dashboard, not just a features list.
        const primaryModCount=getModulesForTrack(primaryTrack).filter(m=>!m.capstone).length;
        const primaryModDone=trackProgress[primaryTrack]||0;
        // AI-agent-backed features vs plain platform features — kept as two
        // distinct sections (not one merged grid) so it's clear which tiles are
        // an actual agent session vs a static feature.
        const agentCards=[
          {id:"track",cat:"Curriculum agent",label:"Learning Path",meta:`${primaryModDone}/${primaryModCount} modules done`,desc:"Continue your enablement or a cross-skill track you've started.",color:P.blue},
          {id:"assist",cat:"AI Tutor",label:"AI Tutor",meta:"Guide me · Explain fully",desc:"Ask anything about AEP — choose hints to reason it out, or a full explanation.",color:P.purple},
          {id:"agent",cat:"Cross-Skilling agent",label:"AI Advisor",meta:"Skill-map grounded",desc:"Ask about upskilling paths based on your role's skill map.",color:P.red},
          {id:"shadow",cat:"Practice agent",label:"Practice Scenarios",meta:"Realistic AEP situations",desc:"Apply your skills in a safe, guided environment.",color:P.amber},
          {id:"capstone",cat:"Capstone agent",label:"Capstone",meta:primaryDone?(liveConf>=CAPSTONE_CONFIDENCE_GATE?"Unlocked":"Locked"):`${Math.round((liveConf||0)*100)}% confidence`,desc:"Prove readiness with a scenario-based final project.",color:P.blue},
        ];
        const otherCards=[
          {id:"profile",cat:"Skill growth",label:"My Skills",meta:`${criticalGaps.length} gaps to close`,desc:"Set your skill levels to ground AI Advisor recommendations.",color:P.purple},
          {id:"projects",cat:"Delivery",label:"Projects",meta:`${(memberProjects[p.name]||[]).length} active · ${bw.used}h committed`,desc:"Review issues, sprint status, and visibility controls.",color:P.grn},
          {id:"tracker",cat:"Delivery",label:"Weekly Tracker",meta:`${bw.avail}h free of ${bw.total}h`,desc:"Log hours and track your weekly bandwidth.",color:P.amber},
          {id:"relnotes",cat:"Platform",label:"Release Notes",meta:"What's new",desc:"See the latest Nexus + AEP platform updates.",color:P.grn},
        ];
        return(
        <div style={{background:PAGE,color:INK,minHeight:"100%",padding:"28px 24px"}}>
        <div style={{maxWidth:1080,margin:"0 auto"}}>
          {/* Hero — full width across the page */}
          <div style={{position:"relative",minHeight:mobile?300:360,borderRadius:20,overflow:"hidden",marginBottom:16,backgroundImage:"url(/images/home2.jpg)",backgroundSize:"cover",backgroundPosition:"center",boxShadow:isDark?"0 22px 52px rgba(0,0,0,.38)":"0 24px 60px rgba(30,20,60,.24)"}}>
                <div style={{position:"absolute",inset:0,background:isDark?"linear-gradient(90deg,rgba(15,17,23,.88),rgba(15,17,23,.45),rgba(15,17,23,.2))":"linear-gradient(90deg,rgba(255,245,242,.94),rgba(255,245,242,.68),rgba(255,245,242,.18))"}}/>
                <div style={{position:"relative",zIndex:1,maxWidth:520,padding:mobile?"28px 24px":"42px 44px"}}>
                  <div style={{fontSize:11.5,fontWeight:700,letterSpacing:1.4,textTransform:"uppercase",color:ACCENTTX,marginBottom:10}}>Experienced learning</div>
                  <div style={{fontSize:mobile?32:42,lineHeight:1.08,fontWeight:700,color:INK,letterSpacing:-.9,marginBottom:14}}>Welcome back, {p.name.split(" ")[0]}.</div>
                  <div style={{fontSize:15.5,color:MUT,lineHeight:1.65,marginBottom:24}}>{heroStory}</div>
                  <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                    <button className={isDark?"nx-btn nx-whitebtn":"nx-btn nx-redbtn"} onClick={()=>setTab("track")}
                      style={{background:"transparent",color:ACCENTTX,border:`2.5px solid ${ACCENTTX}`,borderRadius:999,padding:"11px 24px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:6}}>
                      Learning Path <Ic as={ChevronRight} size={15} color="currentColor"/>
                    </button>
                    <button onClick={()=>setTab("agent")} style={{background:"rgba(255,255,255,.88)",border:"none",borderRadius:999,padding:"11px 22px",fontSize:14,fontWeight:600,cursor:"pointer",fontFamily:"inherit",color:"#1B2140",display:"inline-flex",alignItems:"center",gap:8,boxShadow:"0 8px 20px rgba(0,0,0,.12)"}}>
                      <Ic as={Chat} size={15} color={P.red}/> Ask AI Advisor
                    </button>
                  </div>
                </div>
              </div>

          {/* Quick stats — real data, sits beside the hero as compact side cards */}
          <div style={{display:"flex",gap:12,flexWrap:"wrap",margin:"16px 0"}}>
            <WeeklyUtilCard profile={p}/>
            <CohortCard profile={p} endpoint="/api/cohort/exp-ranking" subtitle={d=>`${d.team||""} · ${d.tenure_band||""}`}/>
          </div>

          {/* Your AI agents — real, live agent sessions (not static feature copy).
              Home is intentionally scoped to Hero + Agents + Other Features only;
              the cross-skill/upskill track picker lives in the Learning Path tab
              (see showTrackPicker above), not duplicated here. */}
          <div style={{fontSize:11,fontWeight:700,letterSpacing:.6,textTransform:"uppercase",color:P.dim,marginTop:4}}>Your AI agents</div>
              <div style={{display:"grid",gridTemplateColumns:mobile?"1fr":"repeat(2,1fr)",gap:12,alignItems:"stretch"}}>
                {agentCards.map((c,i)=>(
                  <div key={c.id} role="button" tabIndex={0} onClick={()=>setTab(c.id)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setTab(c.id);}}} className="nx-gcard"
                    style={{background:CARDBG,border:`1px solid ${CARDBD}`,borderRadius:12,overflow:"hidden",cursor:"pointer",boxShadow:isDark?"0 4px 14px rgba(0,0,0,.3)":"0 4px 14px rgba(0,0,0,.05)",display:"flex",flexDirection:"column",position:"relative",minHeight:mobile?250:270}}>
                    <div style={{height:mobile?90:112,backgroundColor:c.color,overflow:"hidden",position:"relative"}}>
                      <div style={{position:"absolute",inset:0,display:"grid",gridTemplateColumns:"repeat(auto-fill,40px)",gridAutoRows:"40px",justifyContent:"center",alignContent:"center",gap:5,opacity:.5,transform:"rotate(-2deg) scale(1.15)"}}>
                        {Array.from({length:14}).map((_,k)=>(<img key={k} src={LOGOS[(k+i)%3]} alt="" style={{width:22,height:22,display:"block"}}/>))}
                      </div>
                    </div>
                    <span style={{position:"absolute",top:mobile?74:96,left:14,background:"rgba(255,255,255,.96)",color:c.color,fontSize:9.5,fontWeight:700,letterSpacing:.5,textTransform:"uppercase",padding:"4px 9px",borderRadius:6,boxShadow:"0 2px 6px rgba(0,0,0,.18)",zIndex:2}}>{c.cat}</span>
                    <div style={{padding:"18px 15px 14px",flex:1,display:"flex",flexDirection:"column"}}>
                      <div style={{fontSize:14.5,fontWeight:700,marginBottom:4,color:INK}}>{c.label}</div>
                      <div style={{fontSize:11,fontWeight:700,color:c.color,marginBottom:5,textTransform:"uppercase",letterSpacing:.2}}>{c.meta}</div>
                      <p style={{fontSize:12.5,color:MUT,lineHeight:1.5,margin:"0 0 12px",flex:1}}>{c.desc}</p>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end"}}>
                        <span style={{display:"inline-flex",alignItems:"center",gap:3,fontSize:12.5,fontWeight:600,color:ACCENTTX}}>Open agent<ChevronRight UNSAFE_style={{width:15,height:15,"--iconPrimary":ACCENTTX}}/></span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Other features — platform tools, no agent session behind them */}
              <div style={{fontSize:11,fontWeight:700,letterSpacing:.6,textTransform:"uppercase",color:P.dim,marginTop:8}}>Other features</div>
              <div style={{display:"grid",gridTemplateColumns:mobile?"1fr":"repeat(2,1fr)",gap:12,alignItems:"stretch"}}>
                {otherCards.map((c,i)=>(
                  <div key={c.id} role="button" tabIndex={0} onClick={()=>setTab(c.id)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setTab(c.id);}}} className="nx-gcard"
                    style={{background:CARDBG,border:`1px solid ${CARDBD}`,borderRadius:12,overflow:"hidden",cursor:"pointer",boxShadow:isDark?"0 4px 14px rgba(0,0,0,.3)":"0 4px 14px rgba(0,0,0,.05)",display:"flex",flexDirection:"column",position:"relative",minHeight:mobile?250:270}}>
                    <div style={{height:mobile?90:112,backgroundColor:c.color,overflow:"hidden",position:"relative"}}>
                      <div style={{position:"absolute",inset:0,display:"grid",gridTemplateColumns:"repeat(auto-fill,40px)",gridAutoRows:"40px",justifyContent:"center",alignContent:"center",gap:5,opacity:.5,transform:"rotate(-2deg) scale(1.15)"}}>
                        {Array.from({length:14}).map((_,k)=>(<img key={k} src={LOGOS[(k+i+agentCards.length)%3]} alt="" style={{width:22,height:22,display:"block"}}/>))}
                      </div>
                    </div>
                    <span style={{position:"absolute",top:mobile?74:96,left:14,background:"rgba(255,255,255,.96)",color:c.color,fontSize:9.5,fontWeight:700,letterSpacing:.5,textTransform:"uppercase",padding:"4px 9px",borderRadius:6,boxShadow:"0 2px 6px rgba(0,0,0,.18)",zIndex:2}}>{c.cat}</span>
                    <div style={{padding:"18px 15px 14px",flex:1,display:"flex",flexDirection:"column"}}>
                      <div style={{fontSize:14.5,fontWeight:700,marginBottom:4,color:INK}}>{c.label}</div>
                      <div style={{fontSize:11,fontWeight:700,color:c.color,marginBottom:5,textTransform:"uppercase",letterSpacing:.2}}>{c.meta}</div>
                      <p style={{fontSize:12.5,color:MUT,lineHeight:1.5,margin:"0 0 12px",flex:1}}>{c.desc}</p>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end"}}>
                        <span style={{display:"inline-flex",alignItems:"center",gap:3,fontSize:12.5,fontWeight:600,color:ACCENTTX}}>Start<ChevronRight UNSAFE_style={{width:15,height:15,"--iconPrimary":ACCENTTX}}/></span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
          <SiteFooter setTab={setTab} mobile={mobile} cols={[
            {h:"Learn",l:[{t:"Learning Path",tab:"track"},{t:"My Skills",tab:"profile"},{t:"Practice",tab:"shadow"},{t:"Projects",tab:"projects"}]},
            {h:"Support",l:[{t:"Knowledge Base",tab:"kb"},{t:"AI Advisor",tab:"agent"},{t:"Community",tab:"community"}]},
            {h:"Adobe",l:[{t:"Experience League",href:"https://experienceleague.adobe.com"},{t:"Trust Center",href:"https://www.adobe.com/trust.html"},{t:"Privacy",href:"https://www.adobe.com/privacy/policy.html"},{t:"Terms",href:"https://www.adobe.com/legal/terms.html"}]},
          ]}/>
        </div>
        </div>
        );
      })()}

      {tab==="upskilling"&&<div style={{maxWidth:720,margin:"0 auto",padding:mobile?"16px 12px":"28px 24px"}}>
        {/* Self-report editor — lets a learner set their own level per skill
            without taking the CAT quiz. Persists to /api/skills/assess (theta:null).
            The CAT "Take Assessment" flow below remains the rigorous option. */}
        <Card style={{padding:"16px 20px",marginBottom:20}}>
          <Label style={{marginBottom:4}}>Your skills</Label>
          <div style={{fontSize:12,color:P.muted,marginBottom:12}}>Set your own level, or take a rigorous adaptive assessment below. Your manager sees these on the team skill matrix.</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {SKILLS.map((sk,i)=>{
              const lvl=selfSkills[i];
              const assessed=skillOverrides[sk]!=null;
              return(
                <div key={sk} style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                  <span style={{fontSize:13,fontWeight:600,color:P.txt,flex:"1 1 140px",minWidth:120}}>{sk}</span>
                  <LBadge s={lvl}/>
                  <select value={lvl} onChange={e=>saveSkillLevel(sk,e.target.value)}
                    style={{fontSize:12.5,padding:"5px 8px",borderRadius:7,border:`1px solid ${P.border}`,background:P.panel,color:P.txt,cursor:"pointer"}}>
                    <option value="none">None</option>
                    <option value="developing">Developing</option>
                    <option value="proficient">Proficient</option>
                    <option value="expert">Expert</option>
                  </select>
                  {assessed&&<span style={{fontSize:10.5,fontWeight:600,color:P.grn,background:P.grnBg,borderRadius:5,padding:"1px 8px"}}>Saved</span>}
                </div>
              );
            })}
          </div>
        </Card>
        {/* Strengths summary */}
        {SKILLS.filter((_,i)=>selfSkills[i]==="expert"||selfSkills[i]==="proficient").length>0&&(
          <Card style={{padding:"16px 20px",marginBottom:20}}>
            <Label style={{marginBottom:8}}>Your strengths</Label>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {SKILLS.filter((_,i)=>selfSkills[i]==="expert"||selfSkills[i]==="proficient").map(sk=>(
                <span key={sk} style={{fontSize:13,fontWeight:500,color:P.txt,background:P.grnBg,border:`1px solid ${P.grn}20`,borderRadius:8,padding:"4px 12px"}}>{sk}</span>
              ))}
            </div>
          </Card>
        )}
        {/* Section header */}
        <div style={{marginBottom:16}}>
          <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>Skill Gaps</div>
          <div style={{fontSize:13,color:P.muted}}>Skills where your own assessed level hasn't reached proficiency yet</div>
        </div>
        {/* Gap cards — driven entirely by the learner's own real skill levels
            (profile.skills + quiz-derived skillOverrides). Previously compared
            against MARKET/TEAM_AVG, two hardcoded constants with no real data
            behind them — removed rather than left as fake benchmarks. */}
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
        {SKILLS.map((sk,i)=>{
          const you=selfSkills[i];
          const isGap=you==="none"||you==="developing";
          const assessed=!!skillOverrides[sk];
          if(!isGap)return null;
          const isCrit=you==="none";
          return(
            <Card key={sk} style={{padding:"20px 24px"}}>
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:16,gap:12}}>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                    <span style={{fontSize:15,fontWeight:600,color:P.txt}}>{sk}</span>
                    {isCrit&&<span style={{fontSize:10.5,fontWeight:600,color:P.red,background:P.redBg,borderRadius:5,padding:"1px 8px"}}>Not started</span>}
                    {assessed&&<span style={{fontSize:10.5,fontWeight:600,color:P.grn,background:P.grnBg,borderRadius:5,padding:"1px 8px"}}>Assessed</span>}
                  </div>
                  <div style={{fontSize:12.5,color:P.muted}}>Your current level: {you}</div>
                </div>
                <LBadge s={you}/>
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <Btn variant="success" size="sm" onClick={()=>startCATQuiz(sk)}>{assessed?"Re-assess":"Take Assessment"}</Btn>
                <Btn variant="primary" size="sm" onClick={()=>{
                  const moduleId=SKILL_MODULE_MAP[sk]||1;
                  setExpandedModule(moduleId);
                  setTab("track");
                  setTimeout(()=>document.getElementById(`module-${moduleId}`)?.scrollIntoView({behavior:"smooth",block:"center"}),300);
                }}>Go to Learning Path <Ic as={ChevronRight} size={14} color="currentColor"/></Btn>
                <Btn variant="ghost" size="sm" onClick={()=>setTab("agent")}>Ask AI Advisor</Btn>
              </div>
            </Card>
          );
        })}
        {criticalGaps.length===0&&<div style={{fontSize:13,color:P.muted,textAlign:"center",padding:"20px 0"}}>No gaps — every tracked skill is at proficient or expert level.</div>}
        </div>
      </div>}
      {tab==="kb"&&<div style={{height:"calc(100vh - 54px)",overflowY:"auto"}}><KnowledgeBase groqKey={groqKey} track={chosenCrossTrack?.id||getTrack(p)} /></div>}
      {tab==="relnotes"&&<div style={{height:"calc(100vh - 54px)",overflowY:"auto"}}><ReleaseNotes/></div>}
      {tab==="community"&&<Community profile={p}/>}
      {tab==="projects"&&<MyProjectsView profile={p}/>}
      {tab==="tracker"&&<MyWeeklyTracker profile={p}/>}
      {tab==="agent"&&<div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 104px)"}}>
        {/* Header */}
        <div style={{padding:"10px 20px",background:P.panel,borderBottom:`1px solid ${P.border}`,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div style={{fontSize:13.5,fontWeight:600,color:P.txt}}>AI Advisor</div>
            <div style={{fontSize:11.5,color:P.muted}}>Cross-Skilling Agent · recommends learning paths based on your skill gaps</div>
          </div>
        </div>
        {/* Chat column + right-rail suggestions (Curriculum-Agent layout) */}
        <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>
        <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0}}>
        {/* Messages */}
        <div ref={ref} style={{flex:1,overflowY:"auto",padding:"20px 24px",display:"flex",flexDirection:"column",gap:14,maxWidth:760,width:"100%",margin:"0 auto",boxSizing:"border-box"}}>
          {/* Structured recommendation from the real Cross-Skilling Agent */}
          {advisorLoading&&<Card style={{padding:"18px 20px"}}>
            <div style={{fontSize:13,color:P.muted}}>Analysing your skill gaps and team demand…</div>
          </Card>}
          {advisorError&&!advisorLoading&&<Card style={{padding:"18px 20px"}}>
            <div style={{fontSize:13,color:P.red,marginBottom:10}}>{advisorError}</div>
            <Btn size="sm" onClick={loadAdvisorRecommendation}>Try again</Btn>
          </Card>}
          {advisorRec&&!advisorLoading&&(
            <Card style={{padding:"20px 22px"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                <span style={{fontSize:11,fontWeight:700,color:P.purple,background:P.purpleBg,borderRadius:5,padding:"2px 9px"}}>{advisorRec.recommendation_type==="certify_now"?"Certify now":advisorRec.recommendation_type==="skill_bridge"?"Skill bridge":"Next track"}</span>
                {advisorRec.demand_signal&&<span style={{fontSize:11,fontWeight:600,color:P.amber,background:P.amberBg,borderRadius:5,padding:"2px 9px"}}>{advisorRec.demand_signal} demand</span>}
              </div>
              <div style={{fontSize:16,fontWeight:600,color:P.txt,marginBottom:8}}>{advisorRec.title}</div>
              <div style={{fontSize:13.5,color:P.txt,lineHeight:1.7,marginBottom:12}}>{advisorRec.why_this_skill}</div>
              {advisorRec.what_youll_learn?.length>0&&<div style={{marginBottom:12}}>
                <Label style={{marginBottom:6}}>What you'll learn</Label>
                <div style={{display:"flex",flexDirection:"column",gap:5}}>
                  {advisorRec.what_youll_learn.map((w,i)=><div key={i} style={{fontSize:13,color:P.muted,display:"flex",gap:7}}><span style={{color:P.dim}}>·</span>{w}</div>)}
                </div>
              </div>}
              <div style={{display:"flex",gap:14,flexWrap:"wrap",marginBottom:14,fontSize:12.5,color:P.muted}}>
                {advisorRec.estimated_weeks&&<span>~{advisorRec.estimated_weeks} weeks</span>}
                {advisorRec.team_impact&&<span>{advisorRec.team_impact}</span>}
              </div>
              {advisorRec.first_step&&<div style={{background:P.blueGh,border:`1px solid ${P.blue}25`,borderRadius:9,padding:"10px 14px",fontSize:12.5,color:P.txt,marginBottom:14}}>
                <strong>First step:</strong> {advisorRec.first_step}
              </div>}
              {advisorRec.recommended_track&&!advisorConfirmed&&<div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                <Btn onClick={confirmAdvisorTrack} style={{background:P.purple,color:"#fff",border:"none"}}>Yes, I want to cross-skill on this</Btn>
                <Btn variant="secondary" onClick={()=>{setAdvisorRec(null);loadAdvisorRecommendation();}}>Show me something else</Btn>
              </div>}
              {advisorConfirmed&&<div style={{display:"flex",alignItems:"center",gap:8,color:P.grn,fontSize:13,fontWeight:600}}>
                <Ic as={CheckmarkCircle} size={16} color={P.grn}/> Added — {TRACK_LABELS[advisorRec.recommended_track]||advisorRec.recommended_track} is now in your Learning Path.
              </div>}
            </Card>
          )}
          {msgs.map((m,i)=>(
            <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",gap:10,alignItems:"flex-end"}}>
              {m.role==="assistant"&&<div style={{width:28,height:28,borderRadius:"50%",background:P.purple,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",flexShrink:0,padding:4}}><Sparkles UNSAFE_style={{width:18,height:18}}/></div>}
              <div style={{maxWidth:"72%",padding:"11px 15px",borderRadius:m.role==="user"?"12px 12px 3px 12px":"12px 12px 12px 3px",background:m.role==="user"?P.blue:P.panel,color:m.role==="user"?"#fff":P.txt,border:m.role==="assistant"?`1px solid ${P.border}`:"none",fontSize:13.5,lineHeight:1.65}}>{m.content}</div>
            </div>
          ))}
          {busy&&<div style={{display:"flex",gap:10,alignItems:"flex-end"}}>
            <div style={{width:28,height:28,borderRadius:"50%",background:P.purple,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",padding:4}}><Sparkles UNSAFE_style={{width:18,height:18}}/></div>
            <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:"12px 12px 12px 3px",padding:"11px 15px",fontSize:13.5,color:P.muted}}>···</div>
          </div>}
        </div>
        {/* Input */}
        <div style={{borderTop:`1px solid ${P.border}`,padding:"12px 24px",display:"flex",gap:10,flexShrink:0,background:P.panel}}>
          <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!busy&&sendExp()}
            placeholder="Ask about upskilling, skill gaps, or learning paths…"
            style={{flex:1,border:`1px solid ${P.border}`,borderRadius:9,padding:"10px 14px",fontSize:13.5,outline:"none",background:P.bg,color:P.txt}}/>
          <Btn onClick={sendExp} disabled={busy} size="md" style={{background:P.purple,color:"#fff",border:"none"}}>Send</Btn>
        </div>
        </div>{/* /chat column */}
        {/* Suggested questions — right rail, matching the Curriculum Agent */}
        <div style={{width:230,flexShrink:0,borderLeft:`1px solid ${P.border}`,overflowY:"auto",padding:"14px",background:P.panel}}>
          <div style={{fontSize:11,fontWeight:600,color:P.dim,marginBottom:10}}>SUGGESTED QUESTIONS</div>
          {["What track should I cross-skill into next?",
            "Which of my skill gaps is most critical for my role?",
            "How long would it take to reach Intermediate in my top gap?",
            "What's the fastest certification I could earn next?",
            "How does my recommended track help the team?"].map((q,i)=>(
            <button key={i} onClick={()=>sendExp(q)} disabled={busy}
              style={{display:"block",width:"100%",textAlign:"left",padding:"8px 10px",background:P.surface,border:"none",borderRadius:7,cursor:busy?"default":"pointer",fontSize:12,color:P.muted,marginBottom:6,fontFamily:"inherit",lineHeight:1.4,opacity:busy?.6:1}}>
              {q}
            </button>
          ))}
        </div>
        </div>{/* /row */}
      </div>}
      {tab==="profile"&&<div style={{maxWidth:640,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:16}}>
        <ProfileCard name={p.name} role={p.role} tenure={`${p.track_label||p.team} · ${p.tenure}`} initial={p.initial} color={p.color} skills={selfSkills} skillLabels={SKILLS} bw={p.bw} cert={p.cert.name} certStatus={p.cert.status} certExp={p.cert.exp} badges={p.badges} memberProjects={memberProjects} projectIssues={projectIssues} persona="exp" email={p.email} userId={p.id} username={p.username} avatarEmoji={p.avatar_emoji} avatarColor={p.avatar_color} accountType="learner" onAvatarSaved={setAvatarOverride}/>
        {/* Skills self-assessment — replaces the standalone Skill Development tab.
            Feeds cross-skilling recommendations + the home skill-gap count. */}
        <Card style={{padding:"18px 20px"}}>
          <div style={{fontSize:14,fontWeight:600,color:P.txt,marginBottom:3}}>Your Skills</div>
          <div style={{fontSize:12,color:P.muted,marginBottom:14,lineHeight:1.6}}>Set your level for each area. This grounds your AI Advisor cross-skilling recommendations and the skill gaps shown on your home page.</div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {SKILLS.map((sk,i)=>(
              <div key={sk} style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <span style={{fontSize:12.5,color:P.txt,minWidth:120,fontWeight:500}}>{sk}</span>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {["none","developing","proficient","expert"].map(lvl=>{
                    const active=selfSkills[i]===lvl;
                    return(
                      <button key={lvl} onClick={()=>saveSkillLevel(sk,lvl)}
                        style={{padding:"4px 12px",borderRadius:999,fontSize:11.5,fontWeight:active?700:500,cursor:"pointer",fontFamily:"inherit",
                          border:`1.5px solid ${active?P.blue:P.border}`,background:active?P.blue:"transparent",color:active?"#fff":P.muted,textTransform:"capitalize"}}>
                        {lvl}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>}
    </div>
  </div>);
}

// ── MGR — Member Detail ───────────────────────────────────────────────────────
function MemberDetail({member,onBack,memberProjects}){
  const cert=MEMBER_CERTS[member.name];
  const projects=ALL_PROJECTS.filter(p=>(memberProjects[member.name]||[]).includes(p.code));
  return(<div style={{padding:20,maxWidth:680,margin:"0 auto"}}>
    <button onClick={onBack} style={{display:"flex",alignItems:"center",gap:6,background:"transparent",border:`1px solid ${P.border}`,borderRadius:7,padding:"6px 12px",fontSize:12.5,cursor:"pointer",color:P.txt,marginBottom:16}}><Ic as={ChevronLeft} size={14} color="currentColor"/> Back to Team</button>
    {/* Header */}
    <Card style={{padding:20,marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",gap:16}}>
        <div style={{width:52,height:52,borderRadius:"50%",background:`linear-gradient(135deg,${member.color},${member.color}bb)`,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:500,fontSize:20,boxShadow:`0 3px 10px ${member.color}40`}}>{member.name[0]}</div>
        <div style={{flex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
            <span style={{fontSize:17,fontWeight:500,color:P.txt}}>{member.name}</span>
            {member.risk&&<span style={{background:P.redBg,color:P.red,border:`1px solid ${P.red}`,borderRadius:4,fontSize:10,padding:"1px 8px",fontWeight:500}}>HIGH RISK</span>}
          </div>
          <div style={{fontSize:12.5,color:P.muted}}>{member.role} · {member.persona==="nj"?"New Joiner":"Experienced"}</div>
        </div>
        <div style={{background:P.bg,border:`1px solid ${P.border}`,borderRadius:9,padding:"9px 14px",textAlign:"center"}}>
          <div style={{fontSize:20,fontWeight:600,color:member.bw<70?P.red:member.bw<80?P.amber:P.grn}}>{member.bw}%</div>
          <div style={{fontSize:10,color:P.muted}}>Bandwidth (B.N.)</div>
        </div>
      </div>
    </Card>
    {/* Learning progress */}
    <Card style={{padding:18,marginBottom:14}}>
      <div style={{fontSize:12.5,fontWeight:500,color:P.txt,marginBottom:14}}>Learning Progress</div>
      <div style={{display:"flex",gap:14,alignItems:"flex-start"}}>
        <div style={{flex:1}}>
          <div style={{fontSize:11,color:P.muted,marginBottom:4}}>Current focus</div>
          <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:10}}>{member.module}</div>
          {member.risk&&<div style={{background:P.redBg,borderLeft:`3px solid ${P.red}`,borderRadius:"0 7px 7px 0",padding:"8px 12px",fontSize:12,color:P.txt}}><strong style={{color:P.red}}>At risk:</strong> 6-day plateau · 4 attempts · Intervention recommended</div>}
        </div>
        <div style={{textAlign:"center",flexShrink:0}}>
          <Arc val={member.conf} gate={.75} size={110}/>
        </div>
      </div>
    </Card>
    {/* Skills */}
    <Card style={{padding:18,marginBottom:14}}>
      <div style={{fontSize:12.5,fontWeight:500,color:P.txt,marginBottom:12}}>Skills</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
        {SKILLS.map((sk,i)=>{const s=member.skills[i];const c=SC(s);return<div key={sk} style={{background:c.bg,border:`1px solid ${c.bd}`,borderRadius:8,padding:"8px 12px",display:"flex",flexDirection:"column",alignItems:"center",gap:3,minWidth:90}}><span style={{fontSize:10,fontWeight:500,color:c.fg,textTransform:"capitalize"}}>{s==="gap"?"⚠ Gap":s}</span><span style={{fontSize:11,fontWeight:600,color:P.txt,textAlign:"center",lineHeight:1.3}}>{sk}</span></div>;})}
      </div>
    </Card>
    {/* Cert */}
    {cert&&<Card style={{padding:18,marginBottom:14}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
        <div style={{fontSize:12.5,fontWeight:500,color:P.txt}}>Certification</div>
        <span title="This drill-down uses a small hardcoded demo dataset (MEMBER_CERTS), not the real certifications table — it will not match this member's actual cert record." style={{fontSize:9.5,fontWeight:700,letterSpacing:.4,color:P.amber,background:P.amberBg,border:`1px solid ${P.amber}40`,borderRadius:4,padding:"1px 6px",textTransform:"uppercase"}}>Sample data</span>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 13px",background:cert.status==="Active"?P.grnBg:cert.status==="In Progress"?P.blueGh:P.amberBg,border:`1px solid ${cert.status==="Active"?P.grn+"40":cert.status==="In Progress"?P.blue+"40":P.amber+"40"}`,borderRadius:8}}>
        <span style={{fontSize:16}}>🎖</span><div style={{flex:1}}><div style={{fontSize:13,fontWeight:600,color:P.txt}}>{cert.cert}</div><div style={{fontSize:11,color:P.muted}}>Expires {cert.exp}{cert.days?` · ${cert.days}d remaining`:""}</div></div>
        <span style={{fontSize:11,fontWeight:500,color:cert.status==="Active"?P.grn:cert.status==="In Progress"?P.blue:P.amber}}>{cert.status}</span>
      </div>
    </Card>}
    {/* Projects */}
    <Card style={{padding:18}}>
      <div style={{fontSize:12.5,fontWeight:500,color:P.txt,marginBottom:12}}>Projects</div>
      {projects.length===0&&<div style={{fontSize:12.5,color:P.muted}}>No active projects.</div>}
      {projects.map(p=>(
        <div key={p.code} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:P.bg,border:`1px solid ${P.border}`,borderRadius:8,marginBottom:8}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:p.color,flexShrink:0}}/>
          <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600,color:P.txt}}>{p.title}</div><div style={{fontSize:11,color:P.muted}}>{p.code} · {p.sprint}</div></div>
          <span style={{fontSize:10.5,fontWeight:500,padding:"1px 8px",borderRadius:4,background:p.status==="Blocked"?P.redBg:p.status==="Planning"?P.amberBg:P.grnBg,color:p.status==="Blocked"?P.red:p.status==="Planning"?P.amber:P.grn}}>{p.status}</span>
        </div>
      ))}
    </Card>
  </div>);
}

// ── MGR DASHBOARD ─────────────────────────────────────────────────────────────
// ── Weekly Tracker: Add/Edit Allocation Modal ──────────────────────────────────
// lockedMember: when set, member name is fixed (individual's own entry).
// When null, member name is a free text field (manager override / correction).
// Stable, top-level field wrapper — must NOT be defined inside a component body,
// or React remounts the input (and loses focus/cursor) on every keystroke.
function FormField({label,children}){
  return <div><label style={{fontSize:11,fontWeight:600,color:P.muted,display:"block",marginBottom:4}}>{label}</label>{children}</div>;
}

function AllocationModal({initial,lockedMember,onSave,onClose}){
  const [f,setF]=useState(initial?{...initial}:{
    member_name:lockedMember||"",project_id:"",project_name:"",project_type:"",industry:TRACKER_INDUSTRIES[0],
    phase:TRACKER_PHASES[0],stage:TRACKER_STAGES[0],start_date:"",end_date:"",hrs_per_week:0,
    use_cases:"",solutions_used:"",product_features:"",data_sources:"",destinations:"",num_audiences:0,
    region:TRACKER_REGIONS[0],ticket_ids:"",health_status:TRACKER_HEALTH[0],renewal:TRACKER_RENEWAL[2],
    comments:"",project_notes:"",
  });
  const set=k=>e=>setF(p=>({...p,[k]:e.target.value}));
  const inputStyle={width:"100%",border:`1px solid ${P.border}`,borderRadius:7,padding:"7px 10px",fontSize:12.5,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit"};
  const Field=FormField;

  return(
    <div className="nx-modal-overlay" onClick={onClose}>
      <div className="nx-modal" onClick={e=>e.stopPropagation()} style={{maxWidth:680,background:P.panel,color:P.txt}}>
        <div style={{padding:"18px 22px",borderBottom:`1px solid ${P.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{fontSize:15,fontWeight:500,color:P.txt}}>{initial?"Edit project":"Add a project"}</div>
          <button onClick={onClose} style={{background:"transparent",border:"none",fontSize:18,color:P.muted,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{padding:"20px 22px",maxHeight:"70vh",overflowY:"auto",display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <Field label="Member">
            {lockedMember
              ?<input value={lockedMember} disabled style={{...inputStyle,opacity:.7,cursor:"not-allowed"}}/>
              :<input value={f.member_name} onChange={set("member_name")} style={inputStyle}/>}
          </Field>
          <Field label="Project ID"><input value={f.project_id} onChange={set("project_id")} placeholder="e.g. DR12345" style={inputStyle}/></Field>
          <Field label="Project Name"><input value={f.project_name} onChange={set("project_name")} style={inputStyle}/></Field>
          <Field label="Project Type"><input value={f.project_type} onChange={set("project_type")} placeholder="e.g. R&O, Retail, B2B" style={inputStyle}/></Field>
          <Field label="Industry / Vertical">
            <select value={f.industry} onChange={set("industry")} style={inputStyle}>{TRACKER_INDUSTRIES.map(i=><option key={i}>{i}</option>)}</select>
          </Field>
          <Field label="Phase">
            <select value={f.phase} onChange={set("phase")} style={inputStyle}>{TRACKER_PHASES.map(i=><option key={i}>{i}</option>)}</select>
          </Field>
          <Field label="Stage">
            <select value={f.stage} onChange={set("stage")} style={inputStyle}>{TRACKER_STAGES.map(i=><option key={i}>{i}</option>)}</select>
          </Field>
          <Field label="Region">
            <select value={f.region} onChange={set("region")} style={inputStyle}>{TRACKER_REGIONS.map(i=><option key={i}>{i}</option>)}</select>
          </Field>
          <Field label="Start Date"><input type="date" value={f.start_date||""} onChange={set("start_date")} style={inputStyle}/></Field>
          <Field label="End Date"><input type="date" value={f.end_date||""} onChange={set("end_date")} style={inputStyle}/></Field>
          <Field label="Hrs / Week Allocated"><input type="number" value={f.hrs_per_week} onChange={set("hrs_per_week")} style={inputStyle}/></Field>
          <Field label="# Audiences"><input type="number" value={f.num_audiences} onChange={set("num_audiences")} style={inputStyle}/></Field>
          <Field label="Solutions Used"><input value={f.solutions_used} onChange={set("solutions_used")} placeholder="AEP, RTCDP, AJO, CJA..." style={inputStyle}/></Field>
          <Field label="Product Features"><input value={f.product_features} onChange={set("product_features")} placeholder="Agents, FAC, XLG Labs..." style={inputStyle}/></Field>
          <Field label="Data Sources"><input value={f.data_sources} onChange={set("data_sources")} style={inputStyle}/></Field>
          <Field label="Destinations"><input value={f.destinations} onChange={set("destinations")} style={inputStyle}/></Field>
          <Field label="Health / Status">
            <select value={f.health_status} onChange={set("health_status")} style={inputStyle}>{TRACKER_HEALTH.map(i=><option key={i}>{i}</option>)}</select>
          </Field>
          <Field label="Renewal?">
            <select value={f.renewal} onChange={set("renewal")} style={inputStyle}>{TRACKER_RENEWAL.map(i=><option key={i}>{i}</option>)}</select>
          </Field>
          <Field label="Product Issues (Ticket IDs)"><input value={f.ticket_ids} onChange={set("ticket_ids")} style={inputStyle}/></Field>
          <div/>
          <div style={{gridColumn:"1 / -1"}}><Field label="Use Cases"><textarea value={f.use_cases} onChange={set("use_cases")} rows={3} style={{...inputStyle,resize:"vertical",fontFamily:"inherit"}}/></Field></div>
          <div style={{gridColumn:"1 / -1"}}><Field label="High-level Project Notes"><textarea value={f.project_notes} onChange={set("project_notes")} rows={2} style={{...inputStyle,resize:"vertical",fontFamily:"inherit"}}/></Field></div>
        </div>
        <div style={{padding:"14px 22px",borderTop:`1px solid ${P.border}`,display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button onClick={onClose} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 18px",fontSize:13,color:P.muted,cursor:"pointer",fontFamily:"inherit"}}>Cancel</button>
          <button onClick={()=>onSave(f)} style={{background:P.blue,color:"#fff",border:"none",borderRadius:8,padding:"9px 20px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{initial?"Save changes":"Add project"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Weekly update history + "post this week's update" for one project ────────
function WeeklyUpdatesPanel({allocId,memberName,onClose}){
  const [updates,setUpdates]=useState([]);
  const [loading,setLoading]=useState(true);
  const [loadErr,setLoadErr]=useState(false);
  const [comment,setComment]=useState("");
  const [health,setHealth]=useState("");
  const [posting,setPosting]=useState(false);
  const [postErr,setPostErr]=useState(false);

  const load=()=>{
    setLoadErr(false);
    fetch(`${BACKEND}/api/allocations/${allocId}/updates`).then(r=>r.json()).then(d=>{setUpdates(d?.updates||[]);setLoading(false);})
      .catch(()=>{setLoading(false);setLoadErr(true);});
  };
  useEffect(()=>{load();},[allocId]);

  const post=async()=>{
    if(!comment.trim())return;
    setPosting(true);setPostErr(false);
    try{
      const res=await fetch(`${BACKEND}/api/allocations/${allocId}/updates`,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({member_name:memberName,comment:comment.trim(),health_status:health||null})});
      if(!res.ok)throw new Error(String(res.status));
      setComment("");setHealth("");
      load();
    }catch(e){console.warn("Post update failed",e);setPostErr(true);}
    setPosting(false);
  };

  return(
    <div className="nx-modal-overlay" onClick={onClose}>
      <div className="nx-modal" onClick={e=>e.stopPropagation()} style={{maxWidth:480,background:P.panel,color:P.txt}}>
        <div style={{padding:"16px 20px",borderBottom:`1px solid ${P.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{fontSize:14,fontWeight:500,color:P.txt}}>Weekly updates</div>
          <button onClick={onClose} style={{background:"transparent",border:"none",fontSize:16,color:P.muted,cursor:"pointer"}}>✕</button>
        </div>
        <div style={{padding:"16px 20px",borderBottom:`1px solid ${P.border}`}}>
          <textarea value={comment} onChange={e=>setComment(e.target.value)} rows={3} placeholder="What happened this week? Blockers, progress, notes…"
            style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit",resize:"vertical",marginBottom:8}}/>
          <div style={{display:"flex",gap:8}}>
            <select value={health} onChange={e=>setHealth(e.target.value)} style={{flex:1,border:`1px solid ${P.border}`,borderRadius:7,padding:"7px 10px",fontSize:12.5,color:P.txt,background:P.bg,outline:"none"}}>
              <option value="">Health status (optional)</option>
              {TRACKER_HEALTH.map(h=><option key={h} value={h}>{h}</option>)}
            </select>
            <button onClick={post} disabled={posting||!comment.trim()}
              style={{background:P.blue,color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12.5,fontWeight:600,cursor:"pointer",fontFamily:"inherit",opacity:posting||!comment.trim()?.6:1,whiteSpace:"nowrap"}}>
              {posting?"Posting…":"+ Post update"}
            </button>
          </div>
          {postErr&&<div style={{marginTop:8,fontSize:12,color:P.red}}>Couldn't post your update — the server may be unreachable. Please try again.</div>}
        </div>
        {/* Update history — shown first */}
        <div style={{maxHeight:280,overflowY:"auto"}}>
          <div style={{padding:"10px 20px 6px",fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",borderBottom:`1px solid ${P.bfaint}`}}>Update history</div>
          {loading&&<div style={{padding:20,textAlign:"center",color:P.muted,fontSize:12.5}}>Loading…</div>}
          {!loading&&loadErr&&<div style={{padding:"16px 20px",textAlign:"center",color:P.red,fontSize:12.5}}>Couldn't load update history — the server may be unreachable.</div>}
          {!loading&&!loadErr&&updates.length===0&&<div style={{padding:"16px 20px",textAlign:"center",color:P.muted,fontSize:12.5}}>No updates yet — post your first one below.</div>}
          {updates.map(u=>(
            <div key={u.id} style={{padding:"10px 20px",borderBottom:`1px solid ${P.bfaint}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                <div style={{fontSize:12.5,color:P.txt,flex:1,lineHeight:1.55}}>{u.comment}</div>
                {u.health_status&&<span style={{fontSize:10,fontWeight:600,color:P.amber,background:P.amberBg,borderRadius:4,padding:"1px 7px",flexShrink:0}}>{u.health_status}</span>}
              </div>
              <div style={{fontSize:10.5,color:P.dim,marginTop:3}}>{new Date(u.created_at).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Individual Weekly Tracker — used by NJDash and EXPDash ───────────────────
// ── NJ Module Progress Bar — overview card ──────────────────────────────────
function NJProgressBar({done,total,conf,confTarget=0.75}){
  const pct=Math.round((done/Math.max(total,1))*100);
  const confPct=Math.round(conf*100);
  const confTargetPct=Math.round(confTarget*100);
  const confOk=conf>=confTarget;
  return(
    <Card style={{padding:"14px 16px"}}>
      <div style={{fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.6,textTransform:"uppercase",marginBottom:12}}>Track progress</div>
      {/* Modules */}
      <div style={{marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:5}}>
          <span style={{fontSize:12.5,color:P.txt,fontWeight:500}}>Modules complete</span>
          <span style={{fontSize:12,fontWeight:500,color:done>=total?P.grn:P.txt}}>{done} / {total}</span>
        </div>
        <div style={{height:7,background:P.bfaint,borderRadius:99,overflow:"hidden"}}>
          <div style={{height:"100%",width:`${pct}%`,borderRadius:99,transition:"width .5s",
            background:done>=total?P.grn:`linear-gradient(90deg,${P.blue},${P.blueDk})`}}/>
        </div>
        <div style={{fontSize:11,color:P.muted,marginTop:4}}>{pct}% complete{done<total?` · ${total-done} remaining`:" · All done ✓"}</div>
      </div>
      {/* Confidence */}
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:5}}>
          <span style={{fontSize:12.5,color:P.txt,fontWeight:500}}>Overall confidence</span>
          <span style={{fontSize:12,fontWeight:500,color:confOk?P.grn:P.amber}}>{confPct} <span style={{fontSize:10.5,fontWeight:400,color:P.muted}}>/ {confTargetPct} needed</span></span>
        </div>
        <div style={{position:"relative",height:7,background:P.bfaint,borderRadius:99,overflow:"visible"}}>
          <div style={{height:"100%",width:`${confPct}%`,borderRadius:99,transition:"width .5s",
            background:confOk?P.grn:P.amber,position:"relative",zIndex:1}}/>
          {/* Gate marker */}
          <div style={{position:"absolute",top:-3,left:`${confTargetPct}%`,width:2,height:13,background:P.red,borderRadius:2,zIndex:2,transform:"translateX(-50%)"}}/>
        </div>
        <div style={{fontSize:11,color:P.muted,marginTop:4}}>{confOk?"Gate passed ✓":`${confTargetPct-confPct} points to capstone gate`}</div>
      </div>
    </Card>
  );
}

// ── NJ Tracker Summary — shows logged projects inline in overview ──────────
function NJTrackerSummary({profile:p,onGoToTracker}){
  const manager=p.manager||(p.email?"":"Michael Torres");
  const [allocs,setAllocs]=useState([]);
  const [loaded,setLoaded]=useState(false);
  const [err,setErr]=useState(false);
  useEffect(()=>{
    if(!p.name||!manager)return;
    setErr(false);
    fetch(`${BACKEND}/api/allocations?manager=${encodeURIComponent(manager)}&member=${encodeURIComponent(p.name)}`)
      .then(r=>r.json()).then(d=>{setAllocs(d?.allocations||[]);setLoaded(true);})
      .catch(()=>{setLoaded(true);setErr(true);});
  },[p.name,manager]);
  if(!loaded)return null;
  if(err)return(
    <Card style={{padding:"14px 16px"}}>
      <div style={{fontSize:12,color:P.red}}>Couldn't load your projects — the server may be unreachable.</div>
    </Card>
  );
  if(allocs.length===0)return null;
  return(
    <Card style={{padding:"14px 16px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.6,textTransform:"uppercase"}}>My projects</div>
        <button onClick={onGoToTracker} style={{background:"transparent",border:"none",fontSize:11,color:P.blue,cursor:"pointer",padding:0,fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:3}}>Open tracker <Ic as={ChevronRight} size={12} color="currentColor"/></button>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:7}}>
        {allocs.slice(0,3).map(a=>(
          <div key={a.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:P.surface,borderRadius:8}}>
            <span style={{fontSize:13,flexShrink:0}}>📁</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:12.5,fontWeight:600,color:P.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.project_name}</div>
              <div style={{fontSize:11,color:P.muted}}>{a.phase} · {a.hrs_per_week}h/wk</div>
            </div>
            <span style={{fontSize:10,fontWeight:600,color:HEALTH_COLOR[a.health_status]||P.muted,flexShrink:0}}>{a.health_status}</span>
          </div>
        ))}
        {allocs.length>3&&<div style={{fontSize:11,color:P.muted,textAlign:"center"}}>+{allocs.length-3} more in tracker</div>}
      </div>
    </Card>
  );
}

// ── Team Leaderboard — points ranked by reporting manager ────────────────
function TeamLeaderboardWidget({profile:p}){
  const [board,setBoard]=useState([]);
  const [err,setErr]=useState(false);
  const manager=p.manager||(p.email?"":"Michael Torres");
  useEffect(()=>{
    if(!p.name||!manager)return;
    const fetchBoard=()=>fetch(`${BACKEND}/api/points/team?manager=${encodeURIComponent(manager)}`)
      .then(r=>r.json()).then(d=>{setBoard(d?.leaderboard||[]);setErr(false);}).catch(()=>setErr(true));
    fetchBoard();
    const iv=setInterval(fetchBoard,60000);
    return()=>clearInterval(iv);
  },[p.name,manager]);
  if(!p.id)return null;
  if(err&&board.length===0)return(
    <Card style={{padding:"16px 18px"}}>
      <div style={{fontSize:12,color:P.red}}>Couldn't load the team leaderboard — the server may be unreachable.</div>
    </Card>
  );
  if(board.length===0)return null;
  const medals=["🥇","🥈","🥉"];
  return(
    <Card style={{padding:"16px 18px"}}>
      <div style={{fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.6,textTransform:"uppercase",marginBottom:10}}>Team leaderboard</div>
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        {board.slice(0,5).map((m,i)=>{
          const isMe=m.name===p.name;
          return(
            <div key={m.name} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 8px",borderRadius:8,background:isMe?P.blueGh:"transparent",border:isMe?`1px solid ${P.blue}25`:"1px solid transparent"}}>
              <span style={{fontSize:15,width:22,textAlign:"center",flexShrink:0}}>{medals[i]||String(i+1)}</span>
              <span style={{flex:1,fontSize:12.5,fontWeight:isMe?700:400,color:isMe?P.blue:P.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.name}{isMe?" (you)":""}</span>
              <span style={{fontSize:12,fontWeight:500,color:P.amber,flexShrink:0}}>{m.total} pts</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── UtilizationSummaryCard — compact card for home / overview pages ─────────
// ── APAC 2026 public holidays (India + Singapore) ───────────────────────────
const APAC_HOLIDAYS_2026=new Set([
  "2026-01-01","2026-01-26","2026-01-29","2026-01-30",
  "2026-03-25","2026-04-03","2026-04-14","2026-05-01","2026-05-12",
  "2026-06-07","2026-08-09","2026-08-15","2026-09-16",
  "2026-10-02","2026-10-20","2026-10-28","2026-11-05","2026-11-14",
  "2026-12-25",
]);

const getThisMonday=()=>{
  const d=new Date();d.setHours(0,0,0,0);
  d.setDate(d.getDate()-d.getDay()+(d.getDay()===0?-6:1));
  return d.toISOString().slice(0,10);
};

function getWeeklyAvailableHours(weekMonday){
  let working=0;
  const d=new Date(weekMonday+"T12:00:00");
  for(let i=0;i<5;i++){
    const day=new Date(d);day.setDate(d.getDate()+i);
    if(!APAC_HOLIDAYS_2026.has(day.toISOString().slice(0,10)))working++;
  }
  return working*8;
}

function getQuarterAvailableHours(qtr,yr){
  const QSTART=[[1,1],[4,1],[7,1],[10,1]];
  const QEND=  [[3,31],[6,30],[9,30],[12,31]];
  const s=QSTART[qtr-1]; const e=QEND[qtr-1];
  let start=new Date(yr,s[0]-1,s[1]);
  const dow=start.getDay();
  if(dow>1)start.setDate(start.getDate()+(8-dow));
  else if(dow===0)start.setDate(start.getDate()+1);
  const end=new Date(yr,e[0]-1,e[1]);
  let total=0;
  while(start<=end){total+=getWeeklyAvailableHours(start.toISOString().slice(0,10));start.setDate(start.getDate()+7);}
  return total;
}

// ── WeekCalendar — shows Mon–Fri of the week with holidays highlighted ────────
function WeekCalendar({weekOf}){  
  const wk=weekOf||getThisMonday();
  const start=new Date(wk+"T12:00:00");
  const DAY_NAMES=["Mon","Tue","Wed","Thu","Fri"];
  const days=DAY_NAMES.map((name,i)=>{
    const d=new Date(start);d.setDate(start.getDate()+i);
    const iso=d.toISOString().slice(0,10);
    return{name,date:d.getDate(),iso,isHol:APAC_HOLIDAYS_2026.has(iso)};
  });
  const billable=days.filter(d=>!d.isHol).length*8;
  const holCount=days.filter(d=>d.isHol).length;
  return(
    <div>
      <div style={{display:"flex",gap:4,marginBottom:5}}>
        {days.map(d=>(
          <div key={d.iso} style={{flex:1,textAlign:"center",padding:"6px 2px",borderRadius:7,
            background:d.isHol?P.amberBg:P.surface,border:`1px solid ${d.isHol?P.amber:P.border}`}}>
            <div style={{fontSize:9,fontWeight:600,color:d.isHol?P.amber:P.dim}}>{d.name}</div>
            <div style={{fontSize:13,fontWeight:500,color:d.isHol?P.amber:P.txt,lineHeight:1.3}}>{d.date}</div>
            <div style={{fontSize:8.5,color:d.isHol?P.amber:P.grn}}>{d.isHol?"🏖":"8h"}</div>
          </div>
        ))}
      </div>
      <div style={{fontSize:10.5,color:P.muted}}>
        <strong style={{color:P.txt}}>{billable}h</strong> available this week
        {holCount>0&&<span style={{color:P.amber}}> · {holCount} holiday{holCount>1?"s":""}</span>}
      </div>
    </div>
  );
}

function UtilizationSummaryCard({profile:p}){
  const manager=p.manager||(p.email?"":"Michael Torres");
  const qtr=Math.ceil((new Date().getMonth()+1)/3);
  const yr=new Date().getFullYear();
  const qLabels=["Jan–Mar","Apr–Jun","Jul–Sep","Oct–Dec"];
  const quarterLabel=`Q${qtr} ${yr} · ${qLabels[qtr-1]}`;

  const [billed,setBilled]=useState(null);   // fetched from /api/billing/summary
  const [billedErr,setBilledErr]=useState(false);
  const [cfTarget]=useState(75);             // could be user-configurable later
  const [showCal,setShowCal]=useState(false);

  // System-calculated available hours for the whole quarter
  const availableHours=getQuarterAvailableHours(qtr,yr);

  useEffect(()=>{
    if(!p.name||!p.id||!manager)return;
    setBilledErr(false);
    fetch(`${BACKEND}/api/billing/summary?manager=${encodeURIComponent(manager)}&member=${encodeURIComponent(p.name)}&year=${yr}&quarter=${qtr}`)
      .then(r=>r.json()).then(d=>setBilled(d))
      .catch(()=>setBilledErr(true));
  },[p.name,manager,yr,qtr]);

  const totalBilled=billed?.total_billed||0;
  const cfUtil=availableHours>0?Math.round((totalBilled/availableHours)*100):0;
  const cfAchieved=Math.round((cfUtil/cfTarget)*100);
  const utilColor=cfUtil>=cfTarget?P.grn:cfUtil>=cfTarget*0.85?P.amber:P.red;
  const achColor=cfAchieved>=100?P.grn:cfAchieved>=85?P.amber:P.red;

  // Demo users — static example
  if(!p.id){
    return(
      <Card style={{padding:"16px 18px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
          <div>
            <div style={{fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase"}}>CF Utilization</div>
            <div style={{fontSize:10.5,color:P.muted,marginTop:1}}>{quarterLabel}</div>
          </div>
          <span style={{fontSize:10,color:P.dim,fontStyle:"italic"}}>Example</span>
        </div>
        <UtilFiveColumns cfTotal={130} avail={availableHours} cfUtil={Math.round((130/availableHours)*100)} cfTarget={75} cfAchieved={Math.round((130/availableHours*100)/75*100)}/>
        <div style={{fontSize:10,color:P.dim,marginTop:8}}>System-calculated: {availableHours}h available this quarter · 8h/day, excl. weekends &amp; holidays</div>
      </Card>
    );
  }

  return(
    <Card style={{padding:"16px 18px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
        <div>
          <div style={{fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase"}}>CF Utilization</div>
          <div style={{fontSize:10.5,color:P.muted,marginTop:1}}>{quarterLabel}</div>
        </div>
        <button onClick={()=>setShowCal(c=>!c)}
          style={{fontSize:10.5,color:P.blue,background:"transparent",border:`1px solid ${P.blue}25`,borderRadius:6,padding:"2px 8px",cursor:"pointer",fontFamily:"inherit"}}>
          📅 {showCal?"Hide":"Calendar"}
        </button>
      </div>

      {showCal&&<div style={{marginBottom:12}}><WeekCalendar weekOf={getThisMonday()}/></div>}

      <UtilFiveColumns cfTotal={totalBilled} avail={availableHours} cfUtil={cfUtil} cfTarget={cfTarget} cfAchieved={cfAchieved}/>

      <div style={{fontSize:10,color:P.dim,margin:"8px 0 0"}}>
        {availableHours}h available this quarter · 8h/day excl. weekends &amp; APAC holidays
        {billed?.weeks_logged>0?` · ${billed.weeks_logged}wk logged`:""}
      </div>
      {billedErr&&<div style={{fontSize:11,color:P.red,marginTop:4}}>Couldn't load billing data — the server may be unreachable.</div>}

      {/* Per-project breakdown */}
      {billed?.breakdown?.length>0&&(
        <div style={{marginTop:10,borderTop:`1px solid ${P.bfaint}`,paddingTop:8}}>
          <div style={{fontSize:10,fontWeight:600,color:P.dim,textTransform:"uppercase",letterSpacing:.4,marginBottom:6}}>By project</div>
          {billed.breakdown.map((b,i)=>(
            <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"3px 0",borderBottom:i<billed.breakdown.length-1?`1px solid ${P.bfaint}`:"none"}}>
              <span style={{color:P.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{b.project}</span>
              <span style={{color:P.muted,flexShrink:0,marginLeft:8}}>{b.hours}h</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}


function UtilFiveColumns({cfTotal,avail,cfUtil,cfTarget,cfAchieved}){
  const utilColor=cfUtil>=cfTarget?P.grn:cfUtil>=cfTarget*0.85?P.amber:P.red;
  const achColor=cfAchieved>=100?P.grn:cfAchieved>=85?P.amber:P.red;
  const rows=[
    {l:"CF Utilization",   v:`${cfUtil}%`,     c:utilColor,  bold:true},
    {l:"Target Achieved",  v:`${cfAchieved}%`, c:achColor,   bold:true,
     sub:cfAchieved>=100?"✓ On target":"Below target",sc:achColor},
    {l:"CF Hours Total",   v:`${Number(cfTotal).toFixed(1)}h`, c:P.txt},
    {l:"Available Hours",  v:`${Number(avail).toFixed(1)}h`,   c:P.txt},
    {l:"CF Target",        v:`${cfTarget}%`,   c:P.muted},
  ];
  return(
    <div>
      {rows.map((r,i)=>(
        <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",
          padding:"6px 0",borderBottom:i<rows.length-1?`1px solid ${P.bfaint}`:"none"}}>
          <span style={{fontSize:11.5,color:P.muted,flexShrink:0}}>{r.l}</span>
          <div style={{textAlign:"right",marginLeft:8}}>
            <span style={{fontSize:r.bold?17:13,fontWeight:r.bold?800:600,color:r.c,letterSpacing:r.bold?-.5:0}}>{r.v}</span>
            {r.sub&&<div style={{fontSize:9.5,color:r.sc,lineHeight:1}}>{r.sub}</div>}
          </div>
        </div>
      ))}
      <div style={{height:5,background:P.bfaint,borderRadius:99,overflow:"visible",position:"relative",marginTop:10}}>
        <div style={{height:"100%",width:`${Math.min(cfUtil,100)}%`,background:utilColor,borderRadius:99,transition:"width .4s"}}/>
        <div style={{position:"absolute",top:-3,left:`${Math.min(cfTarget,100)}%`,width:2,height:11,background:P.red,borderRadius:2,transform:"translateX(-50%)"}}/>
      </div>
    </div>
  );
}
function UtilizationWidget({profile:p}){
  const manager=p.manager||(p.email?"":"Michael Torres");
  // Get Monday of current week
  const thisMonday=()=>{
    const d=new Date();d.setHours(0,0,0,0);
    d.setDate(d.getDate()-d.getDay()+(d.getDay()===0?-6:1));
    return d.toISOString().slice(0,10);
  };
  const [weekOf,setWeekOf]=useState(thisMonday());
  const [entry,setEntry]=useState({billable_hours:0,non_billable_cf_hours:0,ramp_credit:0,
    working_hours:40,holiday_hours:0,loa_hours:0,cf_target:75});
  const [saved,setSaved]=useState(false);
  const [saving,setSaving]=useState(false);
  const [loading,setLoading]=useState(true);

  // Load existing entry for this week
  useEffect(()=>{
    if(!p.name||!p.id||!manager)return setLoading(false);
    fetch(`${BACKEND}/api/utilization?manager=${encodeURIComponent(manager)}&member=${encodeURIComponent(p.name)}&week_of=${weekOf}`)
      .then(r=>r.json()).then(d=>{
        if(d?.entry)setEntry(e=>({...e,...d.entry}));
        setLoading(false);
      }).catch(()=>setLoading(false));
  },[p.name,manager,weekOf]);

  const n=(k)=>Number(entry[k]||0);
  const availableHours=Math.max(n("working_hours")-n("holiday_hours")-n("loa_hours"),0.01);
  const cfTotal=n("billable_hours")+n("non_billable_cf_hours")+n("ramp_credit");
  const cfUtil=Math.round((cfTotal/availableHours)*100);
  const cfTarget=n("cf_target")||75;
  const cfAchieved=Math.round((cfUtil/cfTarget)*100);
  const utilColor=cfUtil>=cfTarget?P.grn:cfUtil>=cfTarget*0.85?P.amber:P.red;
  const achievedColor=cfAchieved>=100?P.grn:cfAchieved>=85?P.amber:P.red;

  const set=(k)=>(e)=>setEntry(prev=>({...prev,[k]:Math.max(0,Number(e.target.value)||0)}));

  const save=async()=>{
    setSaving(true);
    try{
      const res=await fetch(`${BACKEND}/api/utilization`,{method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({...entry,member_name:p.name,manager,week_of:weekOf})});
      if(res.ok){setSaved(true);setTimeout(()=>setSaved(false),3000);}
    }catch(e){}
    setSaving(false);
  };

  const InputRow=({label,k,hint=""})=>(
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0",borderBottom:`1px solid ${P.bfaint}`}}>
      <div>
        <span style={{fontSize:13,color:P.txt}}>{label}</span>
        {hint&&<div style={{fontSize:11,color:P.muted}}>{hint}</div>}
      </div>
      <input type="number" min="0" step="0.5" value={entry[k]} onChange={set(k)}
        style={{width:72,border:`1px solid ${P.border}`,borderRadius:7,padding:"5px 8px",
          fontSize:13,color:P.txt,background:P.bg,textAlign:"right",outline:"none",fontFamily:"inherit"}}/>
    </div>
  );

  if(!p.id)return null;

  return(
    <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden",marginBottom:16}}>
      {/* Header */}
      <div style={{padding:"14px 18px",borderBottom:`1px solid ${P.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:14,fontWeight:500,color:P.txt}}>Customer-Facing Utilization</div>
          <div style={{fontSize:11.5,color:P.muted}}>Week of {new Date(weekOf+"T12:00:00").toLocaleDateString("en-GB",{day:"2-digit",month:"short"})}</div>
        </div>
        <input type="week" value={weekOf.slice(0,4)+"-W"+String(Math.ceil((new Date(weekOf).getDate()-new Date(weekOf).getDay()+4)/7)+1).padStart(2,"0")}
          onChange={e=>{ const [y,w]=e.target.value.split("-W"); const d=new Date(y,0,1+((w-1)*7)); d.setDate(d.getDate()-(d.getDay()||7)+1); setWeekOf(d.toISOString().slice(0,10)); }}
          style={{border:`1px solid ${P.border}`,borderRadius:7,padding:"5px 8px",fontSize:12,color:P.txt,background:P.bg,outline:"none",fontFamily:"inherit"}}/>
      </div>

      {/* Metric cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:0,borderBottom:`1px solid ${P.border}`}}>
        {[
          {label:"CF Utilization",value:`${cfUtil}%`,sub:`Target: ${cfTarget}%`,c:utilColor},
          {label:"Target Achieved",value:`${cfAchieved}%`,sub:cfAchieved>=100?"✓ On target":"Below target",c:achievedColor},
          {label:"CF Hours Total",value:`${cfTotal.toFixed(1)}h`,sub:`Billable + Non-Bill CF + Ramp`,c:P.blue},
          {label:"Available Hours",value:`${availableHours.toFixed(1)}h`,sub:`Working − Holiday − LOA`,c:P.txt},
        ].map((m,i)=>(
          <div key={i} style={{padding:"12px 16px",borderRight:i<3?`1px solid ${P.border}`:"none"}}>
            <div style={{fontSize:10.5,color:P.muted,marginBottom:4,textTransform:"uppercase",letterSpacing:.4}}>{m.label}</div>
            <div style={{fontSize:20,fontWeight:600,color:m.c,letterSpacing:-.5,marginBottom:2}}>{m.value}</div>
            <div style={{fontSize:10.5,color:P.dim}}>{m.sub}</div>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div style={{padding:"10px 18px",borderBottom:`1px solid ${P.border}`}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
          <span style={{fontSize:11.5,color:P.muted}}>CF Utilization progress to target</span>
          <span style={{fontSize:11.5,fontWeight:600,color:utilColor}}>{cfUtil}% / {cfTarget}%</span>
        </div>
        <div style={{height:7,background:P.bfaint,borderRadius:99,overflow:"visible",position:"relative"}}>
          <div style={{height:"100%",width:`${Math.min(cfUtil,100)}%`,background:utilColor,borderRadius:99,transition:"width .4s"}}/>
          {/* Target marker */}
          <div style={{position:"absolute",top:-4,left:`${Math.min(cfTarget,100)}%`,width:2,height:15,background:P.red,borderRadius:2,transform:"translateX(-50%)"}}/>
        </div>
      </div>

      {/* Input fields */}
      <div style={{padding:"4px 18px 14px"}}>
        <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.4,textTransform:"uppercase",padding:"10px 0 4px"}}>Hours breakdown</div>
        <InputRow label="Billable hours" k="billable_hours" hint="Hours billed directly to client"/>
        <InputRow label="Non-billable customer-facing" k="non_billable_cf_hours" hint="Pre-sales, support, enablement"/>
        <InputRow label="Ramp credit" k="ramp_credit" hint="Credit for onboarding period"/>
        <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.4,textTransform:"uppercase",padding:"10px 0 4px"}}>Available hours</div>
        <InputRow label="Working hours" k="working_hours" hint="Standard: 40"/>
        <InputRow label="Holiday / PTO hours" k="holiday_hours" hint=""/>
        <InputRow label="LOA hours" k="loa_hours" hint="Leave of absence"/>
        <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.4,textTransform:"uppercase",padding:"10px 0 4px"}}>Target</div>
        <InputRow label="CF target (%)" k="cf_target" hint="e.g. 70, 75, 80"/>
        <div style={{display:"flex",gap:8,marginTop:14,alignItems:"center"}}>
          <Btn onClick={save} disabled={saving}>{saving?"Saving…":<>Save this week <Ic as={ChevronRight} size={14} color="currentColor"/></>}</Btn>
          {saved&&<span style={{fontSize:12,color:P.grn,fontWeight:600}}>✓ Saved</span>}
        </div>
      </div>
    </div>
  );
}

// ── ProjectBillingForm — inline "hours billed + comment" on each project card ──
function ProjectBillingForm({allocation:a,memberName,manager}){
  const wk=getThisMonday();
  const [hours,setHours]=useState("");
  const [comment,setComment]=useState("");
  const [health,setHealth]=useState(a.health_status||"On track");
  const [saving,setSaving]=useState(false);
  const [saved,setSaved]=useState(false);

  const avail=getWeeklyAvailableHours(wk);

  const save=async()=>{
    setSaving(true);
    try{
      await fetch(`${BACKEND}/api/allocations/${a.id}/updates`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({member_name:memberName,comment:comment||`Logged ${hours}h billed`,
          health_status:health,billable_hours:Number(hours)||0,week_of:wk})});
      setSaved(true);setComment("");setHours("");
      setTimeout(()=>setSaved(false),3000);
    }catch{}
    setSaving(false);
  };

  return(
    <div style={{marginTop:10,padding:"12px 14px",background:P.surface,borderRadius:9,border:`1px solid ${P.border}`}}>
      <div style={{fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.4,textTransform:"uppercase",marginBottom:10}}>This week's log · {wk}</div>
      <div style={{display:"flex",gap:10,alignItems:"flex-end",flexWrap:"wrap"}}>
        {/* Hours */}
        <div style={{minWidth:110}}>
          <div style={{fontSize:11,color:P.muted,marginBottom:4}}>Hours billed <span style={{color:P.dim}}>/ {avail}h avail</span></div>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <input type="number" min="0" max={avail} step="0.5" value={hours}
              onChange={e=>setHours(e.target.value)} placeholder="0"
              style={{width:60,border:`1px solid ${P.border}`,borderRadius:7,padding:"6px 8px",fontSize:13,
                fontWeight:600,color:P.txt,background:P.bg,outline:"none",textAlign:"right",fontFamily:"inherit"}}/>
            <span style={{fontSize:11.5,color:P.muted}}>h</span>
          </div>
        </div>
        {/* Health */}
        <div style={{minWidth:120}}>
          <div style={{fontSize:11,color:P.muted,marginBottom:4}}>Status</div>
          <select value={health} onChange={e=>setHealth(e.target.value)}
            style={{border:`1px solid ${P.border}`,borderRadius:7,padding:"6px 8px",fontSize:12.5,
              color:P.txt,background:P.bg,outline:"none",fontFamily:"inherit"}}>
            {["On track","At risk","Blocked","On hold","Completed"].map(s=><option key={s}>{s}</option>)}
          </select>
        </div>
        {/* Comment */}
        <div style={{flex:1,minWidth:140}}>
          <div style={{fontSize:11,color:P.muted,marginBottom:4}}>Note (optional)</div>
          <input value={comment} onChange={e=>setComment(e.target.value)}
            placeholder="What did you work on?"
            onKeyDown={e=>e.key==="Enter"&&save()}
            style={{width:"100%",border:`1px solid ${P.border}`,borderRadius:7,padding:"6px 8px",
              fontSize:12.5,color:P.txt,background:P.bg,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}/>
        </div>
        {/* Save */}
        <div style={{flexShrink:0}}>
          {saved
            ?<span style={{fontSize:12,color:P.grn,fontWeight:600}}>✓ Saved</span>
            :<button onClick={save} disabled={saving||(!hours&&!comment)}
                style={{background:(!hours&&!comment)||saving?P.surface:P.blue,
                  color:(!hours&&!comment)||saving?P.dim:"#fff",
                  border:`1px solid ${(!hours&&!comment)||saving?P.border:P.blue}`,
                  borderRadius:7,padding:"7px 14px",fontSize:12.5,fontWeight:600,
                  cursor:(!hours&&!comment)||saving?"not-allowed":"pointer",fontFamily:"inherit"}}>
                {saving?"Saving…":<>Log <Ic as={ChevronRight} size={13} color="currentColor"/></>}
              </button>}
        </div>
      </div>
      {Number(hours)>0&&Number(hours)<=avail&&(
        <div style={{fontSize:10.5,color:P.grn,marginTop:6}}>Will log {hours}h · {Math.round((Number(hours)/avail)*100)}% of this week's available hours</div>
      )}
    </div>
  );
}

function MyWeeklyTracker({profile:p}){
  const q=p.email?`email=${encodeURIComponent(p.email)}`:`member_name=${encodeURIComponent(p.name||"")}`;

  // ── Projects (client work) — real assigned projects, same source as the
  // Projects tab and what the manager sees in Team Weekly Tracker. This used
  // to read a separate, self-logged project_allocations table which could
  // disagree with the real data; now there's one source of truth.
  const [myProjects,setMyProjects]=useState([]);
  const [projLoading,setProjLoading]=useState(true);
  const [editingProj,setEditingProj]=useState(null); // project being edited
  const [projForm,setProjForm]=useState({});
  const [savingProj,setSavingProj]=useState(false);

  // Weekly notes — append-only history (mirrors the Initiatives pattern below):
  // every post is a new timestamped row, never an overwrite of the last one.
  const [projUpdates,setProjUpdates]=useState({});      // projectId → [{...}]
  const [expandedProjNotes,setExpandedProjNotes]=useState({}); // projectId → bool
  const [newProjNoteText,setNewProjNoteText]=useState({});     // projectId → draft
  const [postingProjNote,setPostingProjNote]=useState(null);

  // ── Initiatives ─────────────────────────────────────────────────────────────
  const [initiatives,setInitiatives]=useState([]);
  const [initUpdates,setInitUpdates]=useState({});  // initiativeId → [{text,date}]
  const [expandedInit,setExpandedInit]=useState({});
  const [newInitText,setNewInitText]=useState({});  // initiativeId → draft
  const [newInitName,setNewInitName]=useState("");
  const [savingInit,setSavingInit]=useState(false);

  // ── Milestones ──────────────────────────────────────────────────────────────
  const [milestones,setMilestones]=useState([]);
  const [newMile,setNewMile]=useState({note:"",milestone_date:"",project_name:""});
  const [showAddMile,setShowAddMile]=useState(false);

  const loadAll=()=>{
    setProjLoading(true);
    fetch(`${BACKEND}/api/projects/my-client?${q}`,{credentials:"include"})
      .then(r=>r.json()).then(d=>{setMyProjects(d.projects||[]);setProjLoading(false);})
      .catch(()=>setProjLoading(false));
    fetch(`${BACKEND}/api/initiatives/my?${q}`,{credentials:"include"})
      .then(r=>r.json()).then(d=>setInitiatives(d?.initiatives||[])).catch(()=>{});
    fetch(`${BACKEND}/api/milestones/my?${q}`,{credentials:"include"})
      .then(r=>r.json()).then(d=>setMilestones(d?.milestones||[])).catch(()=>{});
  };
  useEffect(()=>{loadAll();},[]);

  const openEditProj=(proj)=>{
    setProjForm({
      hrs_per_week: proj.hrs_per_week||0,
      role_on_project: proj.role_on_project||"",
      health_status: proj.health_status||"",
      status: proj.status||"In Progress",
    });
    setEditingProj(proj);
  };
  const saveProj=async()=>{
    if(!editingProj)return;
    setSavingProj(true);
    try{
      await fetch(`${BACKEND}/api/projects/${editingProj.id}/my-update`,{
        method:"PUT",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({...projForm, email:p.email||p.name, member_name:p.name||""})
      });
      setEditingProj(null); loadAll();
    } finally { setSavingProj(false); }
  };
  const totalHrs=myProjects.reduce((s,proj)=>s+(parseFloat(proj.hrs_per_week)||0),0);
  const utilPct=Math.round((totalHrs/40)*100);
  const projStatusColor=s=>s==="In Progress"?P.blue:s==="Blocked"?P.red:s==="Completed"?P.grn:P.amber;
  const projStatusBg=s=>s==="In Progress"?P.blueGh:s==="Blocked"?P.redLt:s==="Completed"?P.grnBg:P.amberBg;

  const toggleProjNotes=async(proj)=>{
    const open=!expandedProjNotes[proj.id];
    setExpandedProjNotes(e=>({...e,[proj.id]:open}));
    if(open&&!projUpdates[proj.id]){
      const d=await fetch(`${BACKEND}/api/projects/${proj.id}/updates`,{credentials:"include"}).then(r=>r.json()).catch(()=>({updates:[]}));
      setProjUpdates(u=>({...u,[proj.id]:d.updates||[]}));
    }
  };
  const postProjNote=async(proj)=>{
    const text=(newProjNoteText[proj.id]||"").trim();
    if(!text)return;
    setPostingProjNote(proj.id);
    try{
      const res=await fetch(`${BACKEND}/api/projects/${proj.id}/updates`,{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({member_email:p.email||"", member_name:p.name||"", update_text:text})});
      const d=await res.json();
      setMyProjects(ps=>ps.map(x=>x.id===proj.id?{...x,weekly_comments:text}:x));
      setProjUpdates(u=>({...u,[proj.id]:[{id:d.id,member_name:p.name,update_text:text,created_at:d.created_at},...(u[proj.id]||[])]}));
      setNewProjNoteText(t=>({...t,[proj.id]:""}));
    } finally { setPostingProjNote(null); }
  };

  const loadInitUpdates=async(id)=>{
    const d=await fetch(`${BACKEND}/api/initiatives/${id}/updates`,{credentials:"include"}).then(r=>r.json()).catch(()=>({updates:[]}));
    setInitUpdates(u=>({...u,[id]:d.updates||[]}));
  };

  const submitInitUpdate=async(initId)=>{
    const text=(newInitText[initId]||"").trim();
    if(!text)return;
    setSavingInit(true);
    await fetch(`${BACKEND}/api/initiatives/${initId}/updates`,{method:"POST",credentials:"include",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({update_text:text})});
    setNewInitText(t=>({...t,[initId]:""}));
    loadInitUpdates(initId);
    loadAll();
    setSavingInit(false);
  };

  const addInitiative=async()=>{
    if(!newInitName.trim())return;
    await fetch(`${BACKEND}/api/initiatives/add`,{method:"POST",credentials:"include",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({member_name:p.name,member_email:p.email||"",initiative:newInitName.trim()})});
    setNewInitName("");loadAll();
  };

  const addMilestone=async()=>{
    if(!newMile.note.trim())return;
    await fetch(`${BACKEND}/api/milestones/add`,{method:"POST",credentials:"include",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({...newMile,member_name:p.name,member_email:p.email||""})});
    setNewMile({note:"",milestone_date:"",project_name:""});
    setShowAddMile(false);loadAll();
  };

  const inputSt={width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"7px 11px",
    fontSize:12.5,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit"};

  return(
    <div style={{maxWidth:860,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:32}}>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div>
        <div style={{fontSize:11,fontWeight:700,color:P.red,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Weekly Tracker</div>
        <div style={{fontSize:22,fontWeight:600,color:P.txt,marginBottom:4}}>My Weekly Tracker</div>
        <div style={{fontSize:13,color:P.muted}}>Log your projects and update your utilisation — your manager sees this automatically.</div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 1 — CLIENT PROJECTS
          ══════════════════════════════════════════════════════════════════════ */}
      <div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
          <div style={{fontSize:15,fontWeight:700,color:P.txt}}>
            Projects
            <span style={{fontSize:12,fontWeight:400,color:P.muted,marginLeft:8}}>Assigned by your manager</span>
          </div>
          <div style={{fontSize:12,color:totalHrs>40?P.red:P.muted}}>
            <b style={{color:totalHrs>40?P.red:P.txt}}>{totalHrs}</b>/40 hrs · <b style={{color:utilPct>100?P.red:utilPct>80?P.amber:P.grn}}>{utilPct}%</b> utilised
          </div>
        </div>

        {projLoading&&<div style={{fontSize:12.5,color:P.muted,textAlign:"center",padding:20}}>Loading…</div>}

        {!projLoading&&myProjects.length===0&&(
          <div style={{background:P.surface,border:`1px solid ${P.border}`,borderRadius:10,
            padding:"18px 20px",fontSize:12.5,color:P.muted,textAlign:"center"}}>
            No projects assigned yet. Your manager assigns projects via the Project Board / tracker import — they'll appear here once added.
          </div>
        )}

        {myProjects.map(proj=>(
          <div key={proj.id} style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:10,
            marginBottom:10,overflow:"hidden"}}>
            {editingProj?.id===proj.id?(
              <div style={{padding:"14px 18px"}}>
                <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:12}}>Update: {proj.title}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                  <div>
                    <div style={{fontSize:11.5,fontWeight:600,color:P.muted,marginBottom:4}}>My hrs/week</div>
                    <input type="number" min="0" max="40" style={inputSt} value={projForm.hrs_per_week}
                      onChange={e=>setProjForm(f=>({...f,hrs_per_week:e.target.value}))}/>
                  </div>
                  <div>
                    <div style={{fontSize:11.5,fontWeight:600,color:P.muted,marginBottom:4}}>My role</div>
                    <input style={inputSt} value={projForm.role_on_project}
                      onChange={e=>setProjForm(f=>({...f,role_on_project:e.target.value}))}/>
                  </div>
                  <div>
                    <div style={{fontSize:11.5,fontWeight:600,color:P.muted,marginBottom:4}}>Status</div>
                    <select style={inputSt} value={projForm.status} onChange={e=>setProjForm(f=>({...f,status:e.target.value}))}>
                      {["Planning","In Progress","Blocked","Completed"].map(s=><option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{fontSize:11.5,fontWeight:600,color:P.muted,marginBottom:4}}>Health</div>
                    <input style={inputSt} value={projForm.health_status}
                      onChange={e=>setProjForm(f=>({...f,health_status:e.target.value}))} placeholder="On track, At risk…"/>
                  </div>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={saveProj} disabled={savingProj}
                    style={{background:P.blue,color:"#fff",border:"none",borderRadius:8,padding:"7px 14px",
                      fontSize:12.5,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>{savingProj?"Saving…":"Save"}</button>
                  <button onClick={()=>setEditingProj(null)}
                    style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"7px 14px",
                      fontSize:12.5,cursor:"pointer",color:P.txt,fontFamily:"inherit"}}>Cancel</button>
                </div>
              </div>
            ):(
              <div style={{padding:"13px 18px"}}>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:14,fontWeight:600,color:P.txt}}>{proj.title}</div>
                    <div style={{fontSize:11.5,color:P.muted,marginTop:2}}>
                      {proj.project_type&&<span>{proj.project_type} · </span>}
                      {proj.industry&&<span>{proj.industry} · </span>}
                      <span style={{fontWeight:600,color:proj.hrs_per_week>0?P.txt:P.dim}}>{proj.hrs_per_week||0}h/wk</span>
                      {proj.stage&&<span> · {proj.stage}</span>}
                      {proj.end_date&&<span> · Ends {proj.end_date}</span>}
                    </div>
                  </div>
                  <span style={{fontSize:11.5,fontWeight:600,padding:"2px 9px",borderRadius:4,
                    background:projStatusBg(proj.health_status||proj.status),color:projStatusColor(proj.health_status||proj.status)}}>
                    {proj.health_status||proj.status||"Active"}
                  </span>
                  <button onClick={()=>openEditProj(proj)}
                    style={{fontSize:11.5,color:P.blue,background:P.blueGh,border:`1px solid ${P.blue}20`,
                      borderRadius:6,padding:"3px 10px",cursor:"pointer",fontFamily:"inherit"}}>Update</button>
                </div>

                {/* Weekly note — append-only: latest note shown, with a
                    toggle to post a new one and see the full timestamped history. */}
                {proj.weekly_comments&&<div style={{fontSize:12,color:P.txt,marginTop:8,padding:"6px 10px",
                  background:P.blueGh,borderRadius:6}}>{proj.weekly_comments}</div>}
                <button onClick={()=>toggleProjNotes(proj)}
                  style={{fontSize:11,color:P.blue,background:"none",border:"none",cursor:"pointer",
                    padding:0,marginTop:6,fontFamily:"inherit"}}>
                  {expandedProjNotes[proj.id]?"▲ Hide history":"▼ Post a weekly update / view history"}
                </button>
                {expandedProjNotes[proj.id]&&(
                  <div style={{marginTop:8,padding:"10px 12px",background:P.surface,borderRadius:8}}>
                    <div style={{display:"flex",gap:8}}>
                      <textarea rows={2} value={newProjNoteText[proj.id]||""}
                        onChange={e=>setNewProjNoteText(t=>({...t,[proj.id]:e.target.value}))}
                        placeholder="What's the update this week?"
                        style={{...inputSt,flex:1,minHeight:0,resize:"none"}}/>
                      <button onClick={()=>postProjNote(proj)} disabled={postingProjNote===proj.id||!(newProjNoteText[proj.id]||"").trim()}
                        style={{background:P.blue,color:"#fff",border:"none",borderRadius:8,padding:"0 14px",
                          fontSize:12,cursor:"pointer",fontFamily:"inherit",flexShrink:0,
                          opacity:!(newProjNoteText[proj.id]||"").trim()?0.5:1}}>
                        {postingProjNote===proj.id?"Posting…":"Post"}
                      </button>
                    </div>
                    <div style={{marginTop:10}}>
                      {(projUpdates[proj.id]||[]).length===0&&<div style={{fontSize:12,color:P.muted}}>No history yet.</div>}
                      {(projUpdates[proj.id]||[]).map(u=>(
                        <div key={u.id} style={{display:"flex",gap:12,padding:"6px 0",borderBottom:`1px solid ${P.bfaint}`}}>
                          <span style={{fontSize:10.5,color:P.dim,flexShrink:0,width:120}}>{u.created_at?.replace("T"," ").slice(0,16)}</span>
                          <span style={{fontSize:12.5,color:P.txt}}>{u.update_text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 2 — INITIATIVES
          ══════════════════════════════════════════════════════════════════════ */}
      <div>
        <div style={{fontSize:15,fontWeight:700,color:P.purple,marginBottom:14}}>
          Initiatives
          <span style={{fontSize:12,fontWeight:400,color:P.muted,marginLeft:8}}>Team-level tracking</span>
        </div>

        {initiatives.length===0&&(
          <div style={{fontSize:12.5,color:P.muted,padding:"12px 16px",background:P.surface,
            borderRadius:8,marginBottom:10}}>
            No initiatives yet. Import your tracker or add one below.
          </div>
        )}

        {initiatives.map(init=>(
          <div key={init.id} style={{background:P.panel,border:`1px solid ${P.purple}20`,
            borderRadius:10,marginBottom:10,overflow:"hidden"}}>
            <div style={{display:"flex",alignItems:"flex-start",gap:12,padding:"13px 18px",
              borderBottom:expandedInit[init.id]?`1px solid ${P.border}`:"none"}}>
              <div style={{flex:1}}>
                <div style={{fontSize:14,fontWeight:600,color:P.txt,marginBottom:3}}>{init.initiative}</div>
                {init.latest_update&&(
                  <div style={{fontSize:12,color:P.muted,lineHeight:1.5}}>
                    <span style={{fontSize:10.5,color:P.dim,marginRight:6}}>Last update · {init.updated_at?.slice(0,10)||""}</span>
                    {init.latest_update}
                  </div>
                )}
              </div>
              <button onClick={async()=>{
                const open=!expandedInit[init.id];
                setExpandedInit(e=>({...e,[init.id]:open}));
                if(open&&!initUpdates[init.id]) await loadInitUpdates(init.id);
              }} style={{fontSize:11.5,color:P.purple,background:P.purple+"10",border:`1px solid ${P.purple}20`,
                borderRadius:6,padding:"3px 10px",cursor:"pointer",flexShrink:0,fontFamily:"inherit"}}>
                {expandedInit[init.id]?"▲ Close":"▼ History / Add update"}
              </button>
            </div>

            {expandedInit[init.id]&&(
              <div style={{padding:"14px 18px"}}>
                {/* Past updates */}
                {(initUpdates[init.id]||[]).map((u,i)=>(
                  <div key={i} style={{display:"flex",gap:12,padding:"8px 0",
                    borderBottom:`1px solid ${P.bfaint}`}}>
                    <span style={{fontSize:11,color:P.dim,flexShrink:0,width:120}}>{u.created_at}</span>
                    <span style={{fontSize:12.5,color:P.txt}}>{u.update_text}</span>
                  </div>
                ))}
                {(initUpdates[init.id]||[]).length===0&&(
                  <div style={{fontSize:12,color:P.muted,marginBottom:10}}>No updates logged yet.</div>
                )}
                {/* Add update */}
                <div style={{display:"flex",gap:8,marginTop:10}}>
                  <textarea value={newInitText[init.id]||""} rows={2}
                    onChange={e=>setNewInitText(t=>({...t,[init.id]:e.target.value}))}
                    placeholder="Add your update for this week…"
                    style={{...inputSt,flex:1,resize:"none"}}/>
                  <button onClick={()=>submitInitUpdate(init.id)} disabled={savingInit}
                    style={{background:P.purple,color:"#fff",border:"none",borderRadius:8,
                      padding:"0 16px",fontSize:12,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>
                    {savingInit?"…":"Add"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Add new initiative */}
        <div style={{display:"flex",gap:8,marginTop:8}}>
          <input value={newInitName} onChange={e=>setNewInitName(e.target.value)}
            placeholder="Add a new initiative…"
            style={{...inputSt,flex:1}}
            onKeyDown={e=>{if(e.key==="Enter")addInitiative();}}/>
          <button onClick={addInitiative}
            style={{background:P.purple,color:"#fff",border:"none",borderRadius:8,
              padding:"0 16px",fontSize:13,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>Add</button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 3 — NOTES & KEY MILESTONES
          ══════════════════════════════════════════════════════════════════════ */}
      <div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
          <div style={{fontSize:15,fontWeight:700,color:P.amber}}>
            Notes & Key Milestones
            <span style={{fontSize:12,fontWeight:400,color:P.muted,marginLeft:8}}>Important dates, blockers, go-lives</span>
          </div>
          <button onClick={()=>setShowAddMile(s=>!s)}
            style={{fontSize:12,color:P.amber,background:P.amberBg,border:`1px solid ${P.amber}30`,
              borderRadius:7,padding:"4px 12px",cursor:"pointer",fontFamily:"inherit"}}>
            + Add note
          </button>
        </div>

        {showAddMile&&(
          <div style={{background:P.panel,border:`1px solid ${P.amber}30`,borderRadius:10,
            padding:"16px 18px",marginBottom:14}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:10}}>
              <div>
                <div style={{fontSize:11.5,fontWeight:600,color:P.muted,marginBottom:4}}>Date</div>
                <input type="date" style={inputSt} value={newMile.milestone_date}
                  onChange={e=>setNewMile(m=>({...m,milestone_date:e.target.value}))}/>
              </div>
              <div>
                <div style={{fontSize:11.5,fontWeight:600,color:P.muted,marginBottom:4}}>Project (optional)</div>
                <input style={inputSt} value={newMile.project_name} placeholder="e.g. Adobe on Adobe"
                  onChange={e=>setNewMile(m=>({...m,project_name:e.target.value}))}/>
              </div>
              <div style={{gridColumn:"1/-1"}}>
                <div style={{fontSize:11.5,fontWeight:600,color:P.muted,marginBottom:4}}>Note / Milestone *</div>
                <input style={inputSt} value={newMile.note} placeholder="e.g. FFW Go-live, Phase 2 kick-off…"
                  onChange={e=>setNewMile(m=>({...m,note:e.target.value}))}/>
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={addMilestone} disabled={!newMile.note.trim()}
                style={{background:P.amber,color:"#fff",border:"none",borderRadius:8,
                  padding:"7px 16px",fontSize:12.5,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>Save</button>
              <button onClick={()=>setShowAddMile(false)}
                style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,
                  padding:"7px 14px",fontSize:12.5,cursor:"pointer",color:P.txt,fontFamily:"inherit"}}>Cancel</button>
            </div>
          </div>
        )}

        {milestones.length===0&&!showAddMile&&(
          <div style={{fontSize:12.5,color:P.muted,padding:"12px 16px",background:P.surface,borderRadius:8}}>
            No milestones yet. Click "+ Add note" to log a go-live, blocker, or key date.
          </div>
        )}

        {milestones.map((m,i)=>(
          <div key={i} style={{display:"flex",gap:14,padding:"11px 16px",
            background:i%2===0?P.panel:P.surface,
            border:`1px solid ${P.border}`,borderRadius:8,marginBottom:6}}>
            <div style={{fontSize:11.5,color:P.amber,fontWeight:600,flexShrink:0,width:90,marginTop:1}}>
              {m.milestone_date||"—"}
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:500,color:P.txt}}>{m.note}</div>
              {m.project_name&&<div style={{fontSize:11.5,color:P.muted,marginTop:2}}>{m.project_name}</div>}
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}

// ── TeamUtilizationSection — manager home overview of team CF util ──────────
function TeamUtilizationSection({manager,onGoToTracker}){
  const [members,setMembers]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    const qn=Math.ceil((new Date().getMonth()+1)/3), yn=new Date().getFullYear();
    fetch(`${BACKEND}/api/utilization/team?manager=${encodeURIComponent(manager)}&year=${yn}&quarter=${qn}`)
      .then(r=>r.json()).then(d=>{setMembers(d?.members||[]);setLoading(false);})
      .catch(()=>setLoading(false));
  },[manager]);

  if(loading)return null;

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:12,fontWeight:600,color:P.dim,letterSpacing:.3,textTransform:"uppercase"}}>
        Team CF Utilization — Q{Math.ceil((new Date().getMonth()+1)/3)} {new Date().getFullYear()}
      </div>
        <button onClick={onGoToTracker} style={{background:"transparent",border:"none",fontSize:11,color:P.blue,cursor:"pointer",padding:0,fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:3}}>Full tracker <Ic as={ChevronRight} size={12} color="currentColor"/></button>
      </div>

      {members.length===0
        ?<div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,padding:"16px 20px",fontSize:13,color:P.muted}}>
            No team members have logged their utilization yet. Ask them to update via Weekly Tracker → Utilization.
          </div>
        :<div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden"}}>
            {/* Header */}
            <div style={{display:"grid",gridTemplateColumns:"1.6fr .8fr .8fr .9fr .9fr",gap:0,padding:"9px 18px",background:P.surface,fontSize:10.5,fontWeight:500,color:P.dim,letterSpacing:.4,textTransform:"uppercase",borderBottom:`1px solid ${P.border}`}}>
              <span>Member</span>
              <span style={{textAlign:"right"}}>CF Hours</span>
              <span style={{textAlign:"right"}}>Avail Hrs</span>
              <span style={{textAlign:"right"}}>CF Util%</span>
              <span style={{textAlign:"right"}}>Target Met</span>
            </div>
            {members.map((m,i)=>{
              const utilColor=m.cf_utilization>=m.cf_target?P.grn:m.cf_utilization>=m.cf_target*0.85?P.amber:P.red;
              const achColor=m.cf_target_achieved>=100?P.grn:m.cf_target_achieved>=85?P.amber:P.red;
              return(
                <div key={m.member_name} style={{display:"grid",gridTemplateColumns:"1.6fr .8fr .8fr .9fr .9fr",gap:0,padding:"11px 18px",borderBottom:i<members.length-1?`1px solid ${P.bfaint}`:"none",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,color:P.txt}}>{m.member_name}</div>
                    <div style={{fontSize:11,color:P.muted}}>{m.weeks_logged||0} wk{(m.weeks_logged||0)===1?"":"s"} logged</div>
                  </div>
                  <div style={{textAlign:"right",fontSize:13,color:P.txt}}>{m.cf_hours_total}h</div>
                  <div style={{textAlign:"right",fontSize:13,color:P.txt}}>{m.available_hours}h</div>
                  <div style={{textAlign:"right"}}>
                    <span style={{fontSize:14,fontWeight:500,color:utilColor}}>{m.cf_utilization}%</span>
                    <div style={{fontSize:10,color:P.dim}}>target {m.cf_target}%</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <span style={{fontSize:13,fontWeight:500,color:achColor}}>{m.cf_target_achieved}%</span>
                    <div style={{height:4,background:P.bfaint,borderRadius:99,marginTop:4,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${Math.min(m.cf_target_achieved,100)}%`,background:achColor,borderRadius:99}}/>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>}
    </div>
  );
}

// ── MyProjectsView — Individual member sees their assigned projects (read-only
// — updating hrs/role/status/weekly notes happens in Weekly Tracker, so
// there's exactly one place to log a weekly update, not two that could drift) ─
function MyProjectsView({profile}){
  const [projects,setProjects]=useState([]);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    const q=profile.email?`email=${encodeURIComponent(profile.email)}`:`member_name=${encodeURIComponent(profile.name||"")}`;
    fetch(`${BACKEND}/api/projects/my-client?${q}`,{credentials:"include"})
      .then(r=>r.json()).then(d=>{ setProjects(d.projects||[]); setLoading(false); })
      .catch(()=>setLoading(false));
  },[profile.email,profile.name]);

  const statusColor=s=>s==="In Progress"?P.blue:s==="Blocked"?P.red:s==="Completed"?P.grn:P.amber;
  const statusBg=s=>s==="In Progress"?P.blueGh:s==="Blocked"?P.redLt:s==="Completed"?P.grnBg:P.amberBg;

  return(
    <div style={{maxWidth:860,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:16}}>
      <div>
        <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>My Projects</div>
        <div style={{fontSize:13,color:P.muted}}>
          {loading?"Loading…":`${projects.length} project${projects.length!==1?"s":""} you are assigned to — update hrs, status, and weekly notes from Weekly Tracker.`}
        </div>
      </div>

      {!loading&&projects.length===0&&(
        <Card style={{padding:"40px 24px",textAlign:"center"}}>
          <div style={{fontSize:22,marginBottom:10}}>📋</div>
          <div style={{fontSize:14,fontWeight:500,color:P.txt,marginBottom:6}}>No projects assigned yet</div>
          <div style={{fontSize:13,color:P.muted}}>Your manager will assign you to projects via the Project Board. They'll appear here once added.</div>
        </Card>
      )}

      {projects.map(proj=>(
        <Card key={proj.id} style={{overflow:"hidden"}}>
          <div style={{padding:"16px 20px"}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,marginBottom:10}}>
              <div>
                {proj.sector&&<div style={{fontSize:10,fontWeight:700,color:P.blue,letterSpacing:.6,textTransform:"uppercase",marginBottom:3}}>{proj.sector}</div>}
                <div style={{fontSize:15,fontWeight:600,color:P.txt,marginBottom:4}}>{proj.title}</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                  <span style={{fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:4,
                    background:statusBg(proj.status),color:statusColor(proj.status)}}>{proj.status}</span>
                  {proj.tag&&<span style={{fontSize:11,color:P.muted}}>{proj.tag}</span>}
                  {proj.industry&&<span style={{fontSize:11,color:P.muted}}>{proj.industry}</span>}
                  {proj.phase&&<span style={{fontSize:11,color:P.muted}}>{proj.phase}</span>}
                </div>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:proj.weekly_comments?10:0}}>
              {[
                ["My hrs/week",proj.hrs_per_week?`${proj.hrs_per_week}h`:"—"],
                ["My role",proj.role_on_project||"—"],
                ["Health",proj.health_status||proj.status||"—"],
                proj.start_date&&["Start",proj.start_date],
                proj.end_date&&["End",proj.end_date],
                proj.solutions_used&&["Solutions",proj.solutions_used],
              ].filter(Boolean).map(([l,v])=>(
                <div key={l} style={{background:P.surface,borderRadius:8,padding:"8px 12px"}}>
                  <div style={{fontSize:10,fontWeight:600,color:P.dim,letterSpacing:.4,marginBottom:2}}>{l}</div>
                  <div style={{fontSize:12.5,color:P.txt,fontWeight:500}}>{v}</div>
                </div>
              ))}
            </div>
            {proj.weekly_comments&&(
              <div style={{background:P.amberBg,border:`1px solid ${P.amber}20`,borderRadius:8,padding:"8px 12px",fontSize:12.5,color:P.txt}}>
                <span style={{fontWeight:600,color:P.amber}}>Weekly note: </span>{proj.weekly_comments}
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── MgrTeamTrackerView ────────────────────────────────────────────────────────
// ── MgrTeamTrackerView — flat, spreadsheet-style project tracker table ────────
// One row per (project, member) pair, mirroring the imported tracker Excel
// exactly. Member→manager mapping comes straight from the import (each row
// is already stamped with manager_email + linked to its member).
const TRACKER_COLUMNS = [
  {key:"member_name",      label:"Member",        width:130},
  {key:"project_code",     label:"Project ID",    width:100},
  {key:"title",            label:"Project Name",  width:170},
  {key:"project_type",     label:"Type",          width:110},
  {key:"industry",         label:"Industry",      width:120},
  {key:"phase",            label:"Phase",         width:100},
  {key:"stage",            label:"Stage",         width:100},
  {key:"start_date",       label:"Start",         width:95},
  {key:"end_date",         label:"End",           width:95},
  {key:"days_remaining",   label:"Days Left",     width:80},
  {key:"hrs_per_week",     label:"Hrs/Wk",        width:70},
  {key:"use_cases",        label:"Use Cases",     width:150},
  {key:"solutions_used",   label:"Solutions",     width:140},
  {key:"product_features", label:"Features",      width:140},
  {key:"data_sources",     label:"Data Sources",  width:130},
  {key:"destinations",     label:"Destinations",  width:130},
  {key:"num_audiences",    label:"Audiences",     width:80},
  {key:"region",           label:"Region",        width:80},
  {key:"ticket_ids",       label:"Ticket ID",     width:100},
  {key:"health_status",    label:"Health",        width:100},
  {key:"renewal",          label:"Renewal",       width:80},
  {key:"weekly_comments",  label:"Comments",      width:220, editable:true},
  {key:"high_level_notes", label:"High-Level Notes", width:220},
];

function MgrTeamTrackerView({profile}){
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  // Weekly notes are append-only: expandedRow shows a "post new update" box
  // plus the full timestamped history for that project, instead of editing
  // a single overwritable field.
  const [expandedRow, setExpandedRow] = useState(null); // member_link_id
  const [history, setHistory] = useState({}); // project_id → updates[]
  const [historyLoading, setHistoryLoading] = useState(null);
  const [newUpdateDraft, setNewUpdateDraft] = useState("");
  const [posting, setPosting] = useState(null);

  const load = () => {
    const qs = profile.email
      ? `manager_email=${encodeURIComponent(profile.email)}&manager_name=${encodeURIComponent(profile.name||"")}`
      : `manager_name=${encodeURIComponent(profile.name||"")}`;
    fetch(`${BACKEND}/api/projects/tracker-table?${qs}`,{credentials:"include"})
      .then(r=>r.json()).then(d=>{ setRows(d.rows||[]); setLoading(false); })
      .catch(()=>setLoading(false));
  };
  useEffect(load, [profile.email, profile.name]);

  const statusColor = s => s==="Blocked"||s==="At risk"?P.red:s==="Completed"?P.grn:P.blue;
  const statusBg    = s => s==="Blocked"||s==="At risk"?P.redLt:s==="Completed"?P.grnBg:P.blueGh;

  const toggleExpand = async(row) => {
    if(expandedRow===row.member_link_id){ setExpandedRow(null); return; }
    setExpandedRow(row.member_link_id); setNewUpdateDraft("");
    if(!history[row.id]){
      setHistoryLoading(row.member_link_id);
      const d = await fetch(`${BACKEND}/api/projects/${row.id}/updates`,{credentials:"include"}).then(r=>r.json()).catch(()=>({updates:[]}));
      setHistory(h=>({...h,[row.id]:d.updates||[]}));
      setHistoryLoading(null);
    }
  };
  const postUpdate = async(row) => {
    const text = newUpdateDraft.trim();
    if(!text) return;
    setPosting(row.member_link_id);
    try{
      const res = await fetch(`${BACKEND}/api/projects/${row.id}/updates`,{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({member_email:row.member_email||"", member_name:row.member_name||"", update_text:text})});
      const d = await res.json();
      setRows(rs=>rs.map(r=>r.member_link_id===row.member_link_id?{...r,weekly_comments:text}:r));
      setHistory(h=>({...h,[row.id]:[{id:d.id,member_name:row.member_name,update_text:text,created_at:d.created_at},...(h[row.id]||[])]}));
      setNewUpdateDraft("");
    } finally { setPosting(null); }
  };

  const cellSt = {padding:"7px 10px",fontSize:12,color:P.txt,borderBottom:`1px solid ${P.bfaint}`,
    whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",verticalAlign:"top"};

  return(
    <div style={{padding:"28px 24px",display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>Team Weekly Tracker</div>
          <div style={{fontSize:13,color:P.muted}}>
            {loading?"Loading…":`${rows.length} project row${rows.length!==1?"s":""} across your team, from the imported tracker.`}
          </div>
        </div>
      </div>

      {!loading&&rows.length===0&&(
        <Card style={{padding:"36px 24px",textAlign:"center"}}>
          <div style={{fontSize:13,color:P.muted}}>No projects imported yet. Import your team's project tracker via Admin → Project Tracker Import.</div>
        </Card>
      )}

      {rows.length>0&&(
        <div style={{overflowX:"auto",border:`1px solid ${P.border}`,borderRadius:10}}>
          <table style={{borderCollapse:"collapse",width:"100%",minWidth:2200}}>
            <thead>
              <tr style={{background:P.surface}}>
                {TRACKER_COLUMNS.map(c=>(
                  <th key={c.key} style={{position:"sticky",top:0,background:P.surface,textAlign:"left",
                    padding:"9px 10px",fontSize:11,fontWeight:700,color:P.muted,textTransform:"uppercase",
                    letterSpacing:0.3,borderBottom:`1px solid ${P.border}`,minWidth:c.width}}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row=>(
                <tr key={row.member_link_id}>
                  {TRACKER_COLUMNS.map(c=>{
                    if(c.key==="health_status") return(
                      <td key={c.key} style={cellSt}>
                        {row.health_status&&<span style={{fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:4,
                          background:statusBg(row.health_status),color:statusColor(row.health_status)}}>{row.health_status}</span>}
                      </td>
                    );
                    if(c.editable) return(
                      <td key={c.key} style={{...cellSt,whiteSpace:"normal",minWidth:c.width}}>
                        <div style={{cursor:"pointer",color:row.weekly_comments?P.txt:P.dim}} onClick={()=>toggleExpand(row)}>
                          {row.weekly_comments||"Click to add an update…"}
                        </div>
                        <button onClick={()=>toggleExpand(row)}
                          style={{fontSize:10.5,color:P.blue,background:"none",border:"none",cursor:"pointer",
                            padding:0,marginTop:2,fontFamily:"inherit"}}>
                          {expandedRow===row.member_link_id?"▲ Hide history":"▼ Post update / view history"}
                        </button>
                        {expandedRow===row.member_link_id&&(
                          <div style={{marginTop:6,padding:8,background:"#fff",border:`1px solid ${P.border}`,
                            borderRadius:8,minWidth:240}} onClick={e=>e.stopPropagation()}>
                            <textarea autoFocus rows={2} value={newUpdateDraft}
                              onChange={e=>setNewUpdateDraft(e.target.value)}
                              placeholder="Post a new update…"
                              style={{width:"100%",fontSize:12,padding:"4px 6px",borderRadius:6,
                                border:`1px solid ${P.border}`,fontFamily:"inherit",resize:"vertical",boxSizing:"border-box"}}/>
                            <button onClick={()=>postUpdate(row)} disabled={posting===row.member_link_id||!newUpdateDraft.trim()}
                              style={{marginTop:4,fontSize:11.5,padding:"4px 10px",borderRadius:6,border:"none",
                                background:P.blue,color:"#fff",cursor:"pointer",fontFamily:"inherit",
                                opacity:!newUpdateDraft.trim()?0.5:1}}>
                              {posting===row.member_link_id?"Posting…":"Post update"}
                            </button>
                            <div style={{marginTop:8,borderTop:`1px solid ${P.bfaint}`,paddingTop:6,maxHeight:160,overflowY:"auto"}}>
                              {historyLoading===row.member_link_id&&<div style={{fontSize:11,color:P.muted}}>Loading…</div>}
                              {(history[row.id]||[]).length===0&&historyLoading!==row.member_link_id&&
                                <div style={{fontSize:11,color:P.muted}}>No history yet.</div>}
                              {(history[row.id]||[]).map(u=>(
                                <div key={u.id} style={{fontSize:11,color:P.txt,marginBottom:6}}>
                                  <div style={{color:P.dim,fontSize:10}}>{u.created_at?.replace("T"," ").slice(0,16)}</div>
                                  {u.update_text}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </td>
                    );
                    let val = row[c.key];
                    if(c.key==="num_audiences"&&!val) val = "";
                    return <td key={c.key} style={cellSt} title={val||""}>{val!=null&&val!==""?val:"—"}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── LiveProjectBoard — Manager live project management ────────────────────────
const PROJECT_STATUSES = ["Planning","In Progress","Blocked","Completed"];
const PROJECT_COLORS   = ["#1473E6","#12805C","#CB5D00","#E34850","#6B3FA0","#686868"];
const PRIORITY_ORDER   = {High:0, Medium:1, Low:2};

function LiveProjectBoard({managerEmail, managerName}){
  const [projects,setProjects]   = useState([]);
  const [teamDir,setTeamDir]     = useState([]);  // directory members for assignment
  const [loading,setLoading]     = useState(true);
  const [activeId,setActiveId]   = useState(null);
  const [showForm,setShowForm]   = useState(false);
  const [editProj,setEditProj]   = useState(null);  // project being edited
  const [issueInput,setIssueInput] = useState({});   // projectId → draft issue title
  const [saving,setSaving]       = useState(false);

  const qs = managerEmail
    ? `manager_email=${encodeURIComponent(managerEmail)}&manager_name=${encodeURIComponent(managerName||"")}`
    : `manager_name=${encodeURIComponent(managerName||"")}`;

  const reload = () => {
    fetch(`${BACKEND}/api/projects?${qs}`,{credentials:"include"})
      .then(r=>r.json()).then(d=>{ setProjects(d.projects||[]); setLoading(false); })
      .catch(()=>setLoading(false));
  };

  useEffect(()=>{
    reload();
    // Load directory for member assignment
    fetch(`${BACKEND}/api/directory/my-team?${qs}`,{credentials:"include"})
      .then(r=>r.json()).then(d=>setTeamDir(d.members||[])).catch(()=>{});
  },[managerEmail,managerName]);

  const active = projects.find(p=>p.id===activeId)||null;

  // ── Status colour helpers ──────────────────────────────────────────────────
  const statusColor = s => s==="In Progress"?P.blue:s==="Blocked"?P.red:s==="Completed"?P.grn:P.amber;
  const statusBg    = s => s==="In Progress"?P.blueGh:s==="Blocked"?P.redLt:s==="Completed"?P.grnBg:P.amberBg;
  const prioColor   = p => p==="High"?P.red:p==="Medium"?P.amber:P.muted;
  const issueStatusColor = s => s==="Done"?P.grn:s==="In Progress"?P.blue:P.muted;

  // ── Create / update project ────────────────────────────────────────────────
  const EMPTY_FORM = {title:"",sector:"",tag:"",sprint:"",status:"Planning",description:"",color:"#1473E6"};
  const [form,setForm] = useState(EMPTY_FORM);

  const openCreate = () => { setForm(EMPTY_FORM); setEditProj(null); setShowForm(true); };
  const openEdit   = (p) => {
    setForm({title:p.title,sector:p.sector||"",tag:p.tag||"",sprint:p.sprint||"",
             status:p.status,description:p.description||"",color:p.color||"#1473E6"});
    setEditProj(p); setShowForm(true);
  };

  const saveProject = async() => {
    if(!form.title.trim()) return;
    setSaving(true);
    try {
      if(editProj){
        await fetch(`${BACKEND}/api/projects/${editProj.id}`,{method:"PUT",credentials:"include",
          headers:{"Content-Type":"application/json"},body:JSON.stringify(form)});
      } else {
        await fetch(`${BACKEND}/api/projects`,{method:"POST",credentials:"include",
          headers:{"Content-Type":"application/json"},
          body:JSON.stringify({...form, manager_email:managerEmail||managerName})});
      }
      setShowForm(false); reload();
    } finally { setSaving(false); }
  };

  const deleteProject = async(id) => {
    if(!window.confirm("Delete this project and all its issues?")) return;
    await fetch(`${BACKEND}/api/projects/${id}`,{method:"DELETE",credentials:"include"});
    if(activeId===id) setActiveId(null);
    reload();
  };

  // ── Member assignment ──────────────────────────────────────────────────────
  const addMember = async(proj, member) => {
    await fetch(`${BACKEND}/api/projects/${proj.id}/members`,{method:"POST",credentials:"include",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({member_email:member.email, member_name:member.full_name||member.email})});
    reload();
  };

  const removeMember = async(projId, email) => {
    await fetch(`${BACKEND}/api/projects/${projId}/members/${encodeURIComponent(email)}`,
      {method:"DELETE",credentials:"include"});
    reload();
  };

  // ── Issues ─────────────────────────────────────────────────────────────────
  const addIssue = async(projId) => {
    const title = (issueInput[projId]||"").trim();
    if(!title) return;
    await fetch(`${BACKEND}/api/projects/${projId}/issues`,{method:"POST",credentials:"include",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({title,priority:"Medium",status:"Open",visibility:"Everyone"})});
    setIssueInput(p=>({...p,[projId]:""}));
    reload();
  };

  const cycleIssueStatus = async(projId, issue) => {
    const order=["Open","In Progress","Done"];
    const next=order[(order.indexOf(issue.status)+1)%order.length];
    await fetch(`${BACKEND}/api/projects/${projId}/issues/${issue.id}`,{method:"PUT",credentials:"include",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({status:next})});
    reload();
  };

  const deleteIssue = async(projId, issueId) => {
    await fetch(`${BACKEND}/api/projects/${projId}/issues/${issueId}`,{method:"DELETE",credentials:"include"});
    reload();
  };

  const cycleIssuePriority = async(projId, issue) => {
    const order=["High","Medium","Low"];
    const next=order[(order.indexOf(issue.priority)+1)%order.length];
    await fetch(`${BACKEND}/api/projects/${projId}/issues/${issue.id}`,{method:"PUT",credentials:"include",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({priority:next})});
    reload();
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const inputSt = {width:"100%",border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 12px",
    fontSize:13,color:P.txt,background:P.bg,outline:"none",boxSizing:"border-box",fontFamily:"inherit"};
  const labelSt = {fontSize:12,fontWeight:600,color:P.muted,display:"block",marginBottom:4};

  return(
    <div style={{maxWidth:1000,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:20}}>

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>Project Board</div>
          <div style={{fontSize:13,color:P.muted}}>
            {loading?"Loading…":`${projects.length} project${projects.length!==1?"s":""} · live from DB`}
          </div>
        </div>
        <Btn size="sm" onClick={openCreate}>+ New Project</Btn>
      </div>

      {/* Create / Edit modal */}
      {showForm&&(
        <Card style={{padding:"22px 24px",border:`2px solid ${P.blue}40`}}>
          <div style={{fontSize:15,fontWeight:600,color:P.txt,marginBottom:18}}>
            {editProj?"Edit Project":"New Project"}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginBottom:14}}>
            <div style={{gridColumn:"1/-1"}}>
              <label style={labelSt}>Project title *</label>
              <input style={inputSt} value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))} placeholder="e.g. Real-Time Personalisation Engine"/>
            </div>
            <div>
              <label style={labelSt}>Sector</label>
              <input style={inputSt} value={form.sector} onChange={e=>setForm(f=>({...f,sector:e.target.value}))} placeholder="e.g. Consumer, Banking"/>
            </div>
            <div>
              <label style={labelSt}>Tag / Product</label>
              <input style={inputSt} value={form.tag} onChange={e=>setForm(f=>({...f,tag:e.target.value}))} placeholder="e.g. AEP Segments, AJO"/>
            </div>
            <div>
              <label style={labelSt}>Sprint</label>
              <input style={inputSt} value={form.sprint} onChange={e=>setForm(f=>({...f,sprint:e.target.value}))} placeholder="e.g. Sprint 3"/>
            </div>
            <div>
              <label style={labelSt}>Status</label>
              <select style={inputSt} value={form.status} onChange={e=>setForm(f=>({...f,status:e.target.value}))}>
                {PROJECT_STATUSES.map(s=><option key={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={labelSt}>Colour</label>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:4}}>
                {PROJECT_COLORS.map(c=>(
                  <div key={c} onClick={()=>setForm(f=>({...f,color:c}))}
                    style={{width:24,height:24,borderRadius:"50%",background:c,cursor:"pointer",
                      border:form.color===c?`3px solid ${P.txt}`:"3px solid transparent",boxSizing:"border-box"}}/>
                ))}
              </div>
            </div>
            <div style={{gridColumn:"1/-1"}}>
              <label style={labelSt}>Description</label>
              <textarea style={{...inputSt,minHeight:60,resize:"vertical"}} value={form.description}
                onChange={e=>setForm(f=>({...f,description:e.target.value}))} placeholder="Optional notes"/>
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn size="sm" onClick={saveProject} disabled={saving||!form.title.trim()}>
              {saving?"Saving…":editProj?"Save changes":"Create project"}
            </Btn>
            <Btn variant="secondary" size="sm" onClick={()=>setShowForm(false)}>Cancel</Btn>
          </div>
        </Card>
      )}

      {/* Empty state */}
      {!loading&&projects.length===0&&!showForm&&(
        <Card style={{padding:"48px 24px",textAlign:"center"}}>
          <div style={{fontSize:28,marginBottom:12}}>📋</div>
          <div style={{fontSize:15,fontWeight:500,color:P.txt,marginBottom:8}}>No projects yet</div>
          <div style={{fontSize:13,color:P.muted,marginBottom:20}}>Create your first project to start assigning team members and tracking issues.</div>
          <Btn size="sm" onClick={openCreate}>+ Create first project</Btn>
        </Card>
      )}

      {/* Project cards grid */}
      {projects.length>0&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
          {projects.map(proj=>(
            <div key={proj.id}
              style={{background:P.panel,border:`1px solid ${activeId===proj.id?proj.color:P.border}`,
                borderRadius:12,padding:"16px 18px",cursor:"pointer",
                borderTop:`3px solid ${proj.color||P.blue}`,
                boxShadow:activeId===proj.id?`0 0 0 2px ${proj.color}30`:"none",
                transition:"all .15s"}}
              onClick={()=>setActiveId(activeId===proj.id?null:proj.id)}>
              <div style={{fontSize:10,fontWeight:700,color:proj.color||P.blue,letterSpacing:.6,textTransform:"uppercase",marginBottom:6}}>
                {proj.sector||"General"}
              </div>
              <div style={{fontSize:14,fontWeight:600,color:P.txt,marginBottom:8,lineHeight:1.3}}>{proj.title}</div>
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <span style={{fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:4,
                  background:statusBg(proj.status),color:statusColor(proj.status)}}>
                  {proj.status}
                </span>
                {proj.tag&&<span style={{fontSize:11,color:P.muted}}>{proj.tag}</span>}
              </div>
              <div style={{display:"flex",gap:12,marginTop:10,fontSize:11,color:P.muted}}>
                <span>👥 {proj.members?.length||0} members</span>
                <span>🔖 {proj.issues?.length||0} issues</span>
                {proj.sprint&&<span>{proj.sprint}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Project detail panel */}
      {active&&(
        <Card style={{padding:0,overflow:"hidden",border:`1px solid ${active.color||P.blue}30`}}>
          {/* Detail header */}
          <div style={{padding:"18px 22px",borderBottom:`1px solid ${P.border}`,
            background:`linear-gradient(135deg,${active.color||P.blue}08,transparent)`}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div>
                <div style={{fontSize:10,fontWeight:700,color:active.color||P.blue,letterSpacing:.6,textTransform:"uppercase",marginBottom:4}}>
                  {active.sector||"General"} {active.sprint&&`· ${active.sprint}`}
                </div>
                <div style={{fontSize:17,fontWeight:600,color:P.txt,marginBottom:6}}>{active.title}</div>
                {active.description&&<div style={{fontSize:12.5,color:P.muted,lineHeight:1.5}}>{active.description}</div>}
              </div>
              <div style={{display:"flex",gap:8,flexShrink:0}}>
                <select value={active.status}
                  onChange={async e=>{
                    await fetch(`${BACKEND}/api/projects/${active.id}`,{method:"PUT",credentials:"include",
                      headers:{"Content-Type":"application/json"},body:JSON.stringify({status:e.target.value})});
                    reload();
                  }}
                  style={{fontSize:12,fontWeight:600,padding:"4px 8px",borderRadius:6,cursor:"pointer",
                    background:statusBg(active.status),color:statusColor(active.status),
                    border:`1px solid ${statusColor(active.status)}40`,fontFamily:"inherit"}}>
                  {PROJECT_STATUSES.map(s=><option key={s}>{s}</option>)}
                </select>
                <Btn variant="secondary" size="sm" onClick={()=>openEdit(active)}>
                  <Ic as={Edit} size={13} color="currentColor"/> Edit
                </Btn>
                <Btn variant="secondary" size="sm" onClick={()=>deleteProject(active.id)}>
                  <Ic as={Close} size={13} color={P.red}/> Delete
                </Btn>
              </div>
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:0}}>

            {/* Left — Team members */}
            <div style={{padding:"18px 22px",borderRight:`1px solid ${P.border}`}}>
              <div style={{fontSize:12,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",marginBottom:12}}>
                Team on {active.title.split(" ").slice(0,3).join(" ")}
              </div>

              {/* Assigned members */}
              <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:14}}>
                {active.members?.length===0&&<div style={{fontSize:12,color:P.muted,fontStyle:"italic"}}>No members assigned yet.</div>}
                {active.members?.map(m=>(
                  <div key={m.member_email} style={{display:"flex",alignItems:"center",gap:6,
                    background:P.surface,border:`1px solid ${P.border}`,borderRadius:20,
                    padding:"4px 10px 4px 6px"}}>
                    <div style={{width:22,height:22,borderRadius:"50%",background:active.color||P.blue,
                      display:"flex",alignItems:"center",justifyContent:"center",
                      color:"#fff",fontSize:10,fontWeight:600}}>
                      {(m.member_name||m.member_email)[0].toUpperCase()}
                    </div>
                    <span style={{fontSize:12,color:P.txt}}>{(m.member_name||m.member_email).split(" ")[0]}</span>
                    <button onClick={()=>removeMember(active.id,m.member_email)}
                      style={{background:"transparent",border:"none",cursor:"pointer",color:P.muted,
                        fontSize:14,lineHeight:1,padding:0,marginLeft:2}}>×</button>
                  </div>
                ))}
              </div>

              {/* Add member dropdown */}
              <div style={{fontSize:11,fontWeight:600,color:P.dim,marginBottom:6}}>Add team member</div>
              <select defaultValue=""
                onChange={async e=>{
                  const email=e.target.value;
                  if(!email) return;
                  const m=teamDir.find(d=>d.email===email);
                  if(m) await addMember(active,m);
                  e.target.value="";
                }}
                style={{...inputSt,fontSize:12}}>
                <option value="">— select from your team —</option>
                {teamDir
                  .filter(d=>!active.members?.find(m=>m.member_email===d.email))
                  .map(d=>(
                    <option key={d.email} value={d.email}>
                      {d.full_name||d.email} {d.role?`(${d.role})`:""}
                    </option>
                  ))}
              </select>
            </div>

            {/* Right — Issues */}
            <div style={{padding:"18px 22px"}}>
              <div style={{fontSize:12,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",marginBottom:12}}>
                Issues · {active.issues?.filter(i=>i.status!=="Done").length||0} open
              </div>

              {/* Issue list */}
              <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14,maxHeight:240,overflowY:"auto"}}>
                {active.issues?.length===0&&<div style={{fontSize:12,color:P.muted,fontStyle:"italic"}}>No issues logged yet.</div>}
                {active.issues?.sort((a,b)=>(PRIORITY_ORDER[a.priority]||1)-(PRIORITY_ORDER[b.priority]||1)).map(issue=>(
                  <div key={issue.id} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"8px 10px",
                    background:P.surface,borderRadius:8,border:`1px solid ${P.bfaint}`}}>
                    <button onClick={()=>cycleIssuePriority(active.id,issue)}
                      title="Click to cycle priority"
                      style={{fontSize:10,fontWeight:700,padding:"2px 6px",borderRadius:4,
                        background:prioColor(issue.priority)+"18",color:prioColor(issue.priority),
                        border:`1px solid ${prioColor(issue.priority)}30`,cursor:"pointer",flexShrink:0,fontFamily:"inherit"}}>
                      {issue.priority}
                    </button>
                    <span style={{flex:1,fontSize:12.5,color:issue.status==="Done"?P.muted:P.txt,
                      textDecoration:issue.status==="Done"?"line-through":"none",lineHeight:1.4}}>
                      {issue.title}
                    </span>
                    <button onClick={()=>cycleIssueStatus(active.id,issue)}
                      style={{fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:4,cursor:"pointer",
                        background:issueStatusColor(issue.status)+"18",color:issueStatusColor(issue.status),
                        border:`1px solid ${issueStatusColor(issue.status)}30`,flexShrink:0,fontFamily:"inherit"}}>
                      {issue.status}
                    </button>
                    <button onClick={()=>deleteIssue(active.id,issue.id)}
                      style={{background:"transparent",border:"none",cursor:"pointer",color:P.muted,
                        fontSize:15,lineHeight:1,padding:"0 2px",flexShrink:0}}>×</button>
                  </div>
                ))}
              </div>

              {/* Add issue */}
              <div style={{display:"flex",gap:8}}>
                <input value={issueInput[active.id]||""} placeholder="Add an issue…"
                  onChange={e=>setIssueInput(p=>({...p,[active.id]:e.target.value}))}
                  onKeyDown={e=>{if(e.key==="Enter")addIssue(active.id);}}
                  style={{...inputSt,flex:1,fontSize:12}}/>
                <button onClick={()=>addIssue(active.id)}
                  style={{background:P.blue,color:"#fff",border:"none",borderRadius:8,
                    padding:"0 14px",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
                  Add
                </button>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── TeamMembersTab — Manager full team roster with details ────────────────────
function TeamMembersTab({managerName, managerEmail, setTab}){
  const [members,setMembers]=useState([]);
  const [certs,setCerts]=useState({});      // email → [cert,...]
  const [progress,setProgress]=useState({}); // member_name → {modules_done,confidence}
  const [loading,setLoading]=useState(true);
  const [expanded,setExpanded]=useState({});
  const [search,setSearch]=useState("");

  useEffect(()=>{
    // Build query — prefer email for precision, fall back to name
    const qs = managerEmail
      ? `manager_email=${encodeURIComponent(managerEmail)}`
      : `manager_name=${encodeURIComponent(managerName||"")}`;
    Promise.all([
      fetch(`${BACKEND}/api/directory/my-team?${qs}`,{credentials:"include"}).then(r=>r.json()).catch(()=>({members:[]})),
      fetch(`${BACKEND}/api/team/live-summary?manager=${encodeURIComponent(managerName||"")}`,{credentials:"include"}).then(r=>r.json()).catch(()=>({members:[]})),
    ]).then(([dirData, summaryData])=>{
      // directory already includes certs nested per member
      setMembers(dirData?.members||[]);
      const pm={};
      (summaryData?.members||[]).forEach(m=>{ pm[m.name]=m; });
      setProgress(pm);
      setLoading(false);
    });
  },[managerName,managerEmail]);

  const filtered=members.filter(m=>{
    if(!search)return true;
    const q=search.toLowerCase();
    return (m.full_name||"").toLowerCase().includes(q)
      ||(m.email||"").toLowerCase().includes(q)
      ||(m.role||"").toLowerCase().includes(q)
      ||(m.team||"").toLowerCase().includes(q)
      ||(m.primary_skill||"").toLowerCase().includes(q)
      ||(m.location||"").toLowerCase().includes(q);
  });

  const statusColor=s=>s==="Active"?P.grn:s==="Renew Soon"?P.amber:s==="Expired"?P.red:P.blue;
  const statusBg=s=>s==="Active"?P.grnBg:s==="Renew Soon"?P.amberBg:s==="Expired"?P.redLt:P.blueGh;
  const appStatusLabel=s=>s==="approved"?"Active":s==="pending"?"Pending":s?"—":"Not registered";
  const appStatusColor=s=>s==="approved"?P.grn:P.amber;

  return(
    <div style={{maxWidth:920,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:20}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>Team Members</div>
          <div style={{fontSize:13,color:P.muted}}>{loading?"Loading…":`${members.length} registered members`}</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search name, email, role…"
            style={{border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 12px",fontSize:13,color:P.txt,background:P.bg,outline:"none",width:220}}/>
          <Button variant="accent" size="S" onPress={()=>setTab("approvals")}>
            <Ic as={CheckmarkCircle} size={14} color="currentColor"/> Approvals
          </Button>
        </div>
      </div>

      {loading&&<div style={{textAlign:"center",padding:60,fontSize:13,color:P.muted}}>Loading team data…</div>}

      {!loading&&filtered.length===0&&(
        <Card style={{padding:"40px 24px",textAlign:"center"}}>
          <div style={{fontSize:22,marginBottom:12}}>👥</div>
          <div style={{fontSize:14,fontWeight:500,color:P.txt,marginBottom:6}}>
            {members.length===0?"No team members found in directory":"No members match your search"}
          </div>
          <div style={{fontSize:13,color:P.muted}}>
            {members.length===0?"Upload the HR roster via Admin → User Provisioning. Members are pulled from there, not registration.":"Try a different search term."}
          </div>
        </Card>
      )}

      {filtered.map(member=>{
        const isOpen=expanded[member.app_id||member.email];
        const memberCerts=member.certs||[];
        const prog=progress[member.full_name]||{};
        const worstCert=memberCerts.find(c=>c.status==="Expired")?"Expired":memberCerts.find(c=>c.status==="Renew Soon")?"Renew Soon":memberCerts.length>0?"Active":null;
        const confScore=prog.avg_confidence||0;
        const modulesDone=prog.modules_done||0;
        const initials=(member.full_name||member.email||"?").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();

        return(
          <Card key={member.id||member.email} style={{overflow:"hidden"}}>
            {/* Member header row */}
            <div style={{display:"flex",alignItems:"center",gap:14,padding:"16px 20px",cursor:"pointer",
              borderBottom:isOpen?`1px solid ${P.border}`:"none"}}
              onClick={()=>setExpanded(e=>({...e,[member.app_id||member.email]:!e[member.app_id||member.email]}))}>

              {/* Avatar */}
              <div style={{width:44,height:44,borderRadius:"50%",background:P.blue,
                display:"flex",alignItems:"center",justifyContent:"center",
                color:"#fff",fontWeight:600,fontSize:15,flexShrink:0}}>
                {initials}
              </div>

              {/* Name + meta */}
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:3}}>
                  <span style={{fontSize:14,fontWeight:500,color:P.txt}}>{member.full_name}</span>
                  {member.app_status&&<span style={{fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:4,
                    background:appStatusColor(member.app_status)+"18",color:appStatusColor(member.app_status)}}>
                    {appStatusLabel(member.app_status)}
                  </span>}
                  {!member.app_status&&<span style={{fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:4,background:P.surface,color:P.muted}}>Not registered</span>}
                </div>
                <div style={{fontSize:12,color:P.muted}}>{member.email}{member.role&&` · ${member.role}`}{member.team&&` · ${member.team}`}{member.location&&` · ${member.location}`}</div>
              </div>

              {/* Quick stats */}
              <div style={{display:"flex",gap:16,alignItems:"center",flexShrink:0}}>
                {modulesDone>0&&<div style={{textAlign:"center"}}>
                  <div style={{fontSize:15,fontWeight:600,color:P.txt}}>{modulesDone}</div>
                  <div style={{fontSize:10,color:P.muted}}>modules</div>
                </div>}
                {confScore>0&&<div style={{textAlign:"center"}}>
                  <div style={{fontSize:15,fontWeight:600,color:confScore>=0.75?P.grn:confScore>=0.5?P.amber:P.red}}>
                    {Math.round(confScore*100)}%
                  </div>
                  <div style={{fontSize:10,color:P.muted}}>confidence</div>
                </div>}
                {worstCert&&<span style={{fontSize:11,fontWeight:600,padding:"3px 9px",borderRadius:6,
                  color:statusColor(worstCert),background:statusBg(worstCert),border:`1px solid ${statusColor(worstCert)}30`}}>
                  {worstCert}
                </span>}
              </div>

              <span style={{fontSize:18,color:P.muted,flexShrink:0}}>{isOpen?"▾":"▸"}</span>
            </div>

            {/* Expanded detail */}
            {isOpen&&(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:0}}>

                {/* Left — Profile info */}
                <div style={{padding:"16px 20px",borderRight:`1px solid ${P.bfaint}`}}>
                  <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",marginBottom:12}}>Profile</div>
                  {[
                    ["Name",          member.full_name],
                    ["Email",         member.email],
                    ["Role",          member.role],
                    ["Team",          member.team],
                    ["Location",      member.location],
                    ["Primary skill", member.primary_skill],
                    ["Joining date",  member.doj],
                    ["Track",         member.active_track?.toUpperCase()],
                    ["Preferred name",member.preferred_name],
                  ].filter(([,v])=>v).map(([l,v])=>(
                    <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",
                      borderBottom:`1px solid ${P.bfaint}`}}>
                      <span style={{fontSize:12,color:P.muted}}>{l}</span>
                      <span style={{fontSize:12,fontWeight:500,color:P.txt}}>{v}</span>
                    </div>
                  ))}
                  {member.capstone_completed&&member.app_status==="approved"&&(
                    <div style={{marginTop:10,display:"inline-flex",alignItems:"center",gap:6,
                      background:P.grnBg,border:`1px solid ${P.grn}30`,borderRadius:6,padding:"4px 10px"}}>
                      <Ic as={CheckmarkCircle} size={13} color={P.grn}/>
                      <span style={{fontSize:12,fontWeight:600,color:P.grn}}>Capstone completed</span>
                    </div>
                  )}
                </div>

                {/* Right — Certifications */}
                <div style={{padding:"16px 20px"}}>
                  <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.5,textTransform:"uppercase",marginBottom:12}}>
                    Certifications {memberCerts.length>0&&<span style={{fontWeight:400,color:P.muted}}>({memberCerts.length})</span>}
                  </div>
                  {memberCerts.length===0&&(
                    <div style={{fontSize:12,color:P.muted,fontStyle:"italic"}}>No certifications on record.</div>
                  )}
                  {memberCerts.map((c,i)=>(
                    <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",
                      borderRadius:8,marginBottom:6,background:statusBg(c.status),border:`1px solid ${statusColor(c.status)}25`}}>
                      <span style={{fontSize:16}}>🎖</span>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:12.5,fontWeight:500,color:P.txt,marginBottom:1}}>{c.cert_name}</div>
                        <div style={{fontSize:11,color:P.muted}}>
                          {c.cert_type&&<span>{c.cert_type} · </span>}
                          {c.expiry_date?`Expires ${c.expiry_date}`:"No expiry"}
                          {c.days_remaining!=null&&<span style={{fontWeight:600,color:c.days_remaining<90?P.amber:P.muted}}> · {c.days_remaining}d</span>}
                        </div>
                      </div>
                      <span style={{fontSize:11,fontWeight:600,color:statusColor(c.status),
                        padding:"2px 8px",borderRadius:4,background:statusBg(c.status)}}>{c.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function MGRDash({onLogout,groqKey,onLog,profile:profileProp,memberProjects,setMemberProjects,projectIssues,setProjectIssues,onToggleTheme,pendingApprovals=[],setPendingApprovals}){
  const [tab,setTab]=useState("team");
  useEffect(()=>{const h=e=>{const tb=e.detail?.tab;if(tb)setTab(tb);};window.addEventListener("nexus:navigate",h);return()=>window.removeEventListener("nexus:navigate",h);},[]);
  const [selected,setSelected]=useState(null);
  const [playbook,setPlaybook]=useState(false);
  const [activeProj,setActiveProj]=useState(ALL_PROJECTS[0].code);
  const [showAddMember,setShowAddMember]=useState(false);
  const [dbMembers,setDbMembers]=useState([]);
  const [capstoneLoading,setCapstoneLoading]=useState(null); // id being actioned
  const [expandedCapstone,setExpandedCapstone]=useState(null); // member id currently expanded for review
  const [capstoneSubs,setCapstoneSubs]=useState({}); // member id -> submission
  const [capstoneSubLoading,setCapstoneSubLoading]=useState(null);
  const [reviewNotes,setReviewNotes]=useState({}); // member id -> draft note text
  const [rejectLoading,setRejectLoading]=useState(null);
  const [historyExpandedOverride,setHistoryExpandedOverride]=useState({}); // member id -> explicit user toggle, overrides the status-based default
  // Team Weekly Tracker (read-aggregation) state
  const [teamAllocations,setTeamAllocations]=useState([]);
  const [teamFeed,setTeamFeed]=useState([]);
  const [trackerLoading,setTrackerLoading]=useState(false);
  const [expandedMember,setExpandedMember]=useState(null);
  const [editingAlloc,setEditingAlloc]=useState(null);
  const [viewingMemberUpdates,setViewingMemberUpdates]=useState(null); // allocation id, for "View weekly updates"
  const [reminderSending,setReminderSending]=useState(false);
  const [reminderResult,setReminderResult]=useState(null);
  const [teamUtilization,setTeamUtilization]=useState({});
  const {mobile}=useViewport();
  // Real, registered managers (have profileProp.id) get their own name/email/team
  // threaded through every live-data API call. The demo "Michael Torres" button
  // Use real profile if we have an email (IMS login), fall back to demo Michael Torres only if no email.
  const baseProfile=profileProp?.email?{
    ...PROFILES.mgr,...profileProp,
    role:"People Manager",
    team:profileProp.team||PROFILES.mgr.team,
    initial:(profileProp.name||"M")[0].toUpperCase(),
  }:PROFILES.mgr;

  // Manager alias — server-configured only (backend .env: MGR_ALIAS_MAP is a
  // JSON map of {tester_id: {email, name}}), never a UI control. There is no
  // input box anywhere for this: a free-text "view as any manager" field
  // would let anyone snoop on another manager's real team data, so it's
  // deliberately not exposed at the UI level. The lookup key is whichever
  // identity this session actually has — the tester's own real email if
  // logged in, or the literal id "mgr" for the anonymous demo login — so
  // different real people (or the shared demo login) can each be mapped to
  // a different real manager to preview, all from one .env-configured map.
  const [mgrAlias,setMgrAlias]=useState(null);
  useEffect(()=>{
    const testerId = profileProp?.email || "mgr";
    fetch(`${BACKEND}/api/config/manager-alias?as_email=${encodeURIComponent(testerId)}`).then(r=>r.json()).then(d=>{
      setMgrAlias(d?.email ? d : null);
    }).catch(()=>{});
  },[profileProp?.email]);
  // Avatar/username changes from Profile settings apply immediately (header,
  // sidebar, everywhere `profile` is used) — no page refresh needed.
  const [avatarOverride,setAvatarOverride]=useState(null);
  const profile = {
    ...(mgrAlias?.email
      ? {...baseProfile, email:mgrAlias.email, name:mgrAlias.name||mgrAlias.email, team:mgrAlias.team||baseProfile.team}
      : baseProfile),
    ...(avatarOverride||{}),
  };

  const sendWeeklyReminders=async()=>{
    setReminderSending(true);setReminderResult(null);
    try{
      const res=await fetch(`${BACKEND}/api/notify/weekly-reminder?manager=${encodeURIComponent(profile.name)}`,{method:"POST"});
      const d=await res.json();
      if(!d.ok)setReminderResult({ok:false,message:d.error||"Could not send reminders."});
      else setReminderResult({ok:true,message:`Sent ${d.sent} of ${d.total} reminder email${d.total===1?"":"s"}.`});
    }catch(e){setReminderResult({ok:false,message:"Could not reach the server."});}
    setReminderSending(false);
  };
  const checkCapstoneDeadlines=async()=>{
    setReminderSending(true);setReminderResult(null);
    try{
      const res=await fetch(`${BACKEND}/api/notify/capstone-check?manager=${encodeURIComponent(profile.name)}`,{method:"POST"});
      const d=await res.json();
      if(!d.ok)setReminderResult({ok:false,message:d.error||"Could not check deadlines."});
      else setReminderResult({ok:true,message:d.overdue===0?"No overdue capstones — everyone is within the 7-day window.":`${d.sent} of ${d.overdue} overdue learner${d.overdue===1?"":"s"} notified.`});
    }catch(e){setReminderResult({ok:false,message:"Could not reach the server."});}
    setReminderSending(false);
  };
  const kpis=[
    {v:"4",l:"Team members",s:"AEP Analytics APAC",detail:"Jennifer · Alex · Rachel · Kate"},
    {v:"1",l:"At risk",s:"Alex Carter · Module 4",detail:"6-day plateau · 4 failed attempts · intervention needed"},
    {v:"1",l:"Cert expiring",s:"Rachel Kim · 60 days",detail:"Analytics Pro · auto-reminder sent at 30d"},
    {v:"~34 days",l:"Avg time to autonomy",s:"18% ahead of baseline",detail:"vs 41-day historical average"},
  ];
  const tabs=[{id:"team",label:"Team Overview",icon:PeopleGroup},{id:"members",label:"Team Members",icon:Group},{id:"certs",label:"Certifications",icon:Ribbon},{id:"projects",label:"Project Board",icon:Briefcase},{id:"tracker",label:"Team Weekly Tracker",icon:Calendar},{id:"intel",label:"Team Intel",icon:Lightbulb},{id:"community",label:"Community",icon:CommunityIcon},{id:"approvals",label:"Approvals",icon:CheckmarkCircle,badge:pendingApprovals.length>0?`${pendingApprovals.length}`:null},{id:"profile",label:"Profile",icon:User}];

  const addMemberToProject=(memberName,code)=>{
    setMemberProjects(prev=>({...prev,[memberName]:[...(prev[memberName]||[]),code]}));
    setShowAddMember(false);
  };
  const removeMemberFromProject=(memberName,code)=>{
    setMemberProjects(prev=>({...prev,[memberName]:(prev[memberName]||[]).filter(c=>c!==code)}));
  };
  const cycleIssueStatus=(code,id)=>{
    const order=["Open","In Progress","Done"];
    setProjectIssues(prev=>({...prev,[code]:(prev[code]||[]).map(i=>i.id===id?{...i,status:order[(order.indexOf(i.status)+1)%order.length]}:i)}));
  };

  // Load team from employee_directory (source of truth — same as Team Members tab)
  // Deps include profile.email/name (not []): the manager-alias lookup above
  // resolves asynchronously and can change `profile` after first mount — every
  // live-data fetch on this dashboard must re-run when that happens, or it
  // silently keeps querying the pre-alias identity forever. dbMembersReqRef
  // additionally guards against the FIRST (pre-alias) request's response
  // arriving out of order, after the second (post-alias) one already landed —
  // without it, a slow "your own empty team" response could silently
  // overwrite the correct aliased team data.
  const dbMembersReqRef=useRef(0);
  useEffect(()=>{
    const reqId=++dbMembersReqRef.current;
    const qs=profile.email
      ?`manager_email=${encodeURIComponent(profile.email)}&manager_name=${encodeURIComponent(profile.name||"")}`
      :`manager_name=${encodeURIComponent(profile.name||"")}`;
    fetch(`${BACKEND}/api/directory/my-team?${qs}`,{credentials:"include"})
      .then(r=>r.json())
      .then(d=>{if(reqId===dbMembersReqRef.current&&d?.members)setDbMembers(d.members);})
      .catch(()=>{});
  },[profile.email,profile.name]);

  // Live aggregate numbers (real modules done, points, at-risk) — replaces static demo KPIs where available
  const [liveSummary,setLiveSummary]=useState(null);
  const [leaderboard,setLeaderboard]=useState([]);
  const [teamSkills,setTeamSkills]=useState([]); // real persisted CAT quiz results, team-wide
  const [teamProjects,setTeamProjects]=useState([]); // real imported project rows, team-wide (Team Intel context)
  const liveDataReqRef=useRef(0);
  useEffect(()=>{
    const reqId=++liveDataReqRef.current;
    const stillCurrent=()=>reqId===liveDataReqRef.current;
    fetch(`${BACKEND}/api/team/live-summary?manager=${encodeURIComponent(profile.name)}`)
      .then(r=>r.json()).then(d=>{if(stillCurrent())setLiveSummary(d);}).catch(()=>{});
    fetch(`${BACKEND}/api/points/team?manager=${encodeURIComponent(profile.name)}`)
      .then(r=>r.json()).then(d=>{if(stillCurrent())setLeaderboard(d?.leaderboard||[]);}).catch(()=>{});
    fetch(`${BACKEND}/api/skills/team?manager=${encodeURIComponent(profile.name)}`)
      .then(r=>r.json()).then(d=>{if(stillCurrent())setTeamSkills(d?.assessments||[]);}).catch(()=>{});
    const pqs=profile.email
      ?`manager_email=${encodeURIComponent(profile.email)}&manager_name=${encodeURIComponent(profile.name||"")}`
      :`manager_name=${encodeURIComponent(profile.name||"")}`;
    fetch(`${BACKEND}/api/projects/tracker-table?${pqs}`,{credentials:"include"})
      .then(r=>r.json()).then(d=>{if(stillCurrent())setTeamProjects(d?.rows||[]);}).catch(()=>{});
  },[profile.email,profile.name]);

  const refreshCapstoneSub=async(memberId)=>{
    try{
      const res=await fetch(`${BACKEND}/api/capstone/${memberId}`);
      const data=await res.json();
      setCapstoneSubs(prev=>({...prev,[memberId]:data?.submission||null}));
    }catch(e){}
  };

  const markCapstone=async(memberId,notes)=>{
    setCapstoneLoading(memberId);
    try{
      const res=await fetch(`${BACKEND}/api/onboarding/${memberId}/capstone`,{
        method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({actioned_by:profile.name,notes:notes?.trim()||null})
      });
      const data=await res.json();
      if(data.ok){
        setDbMembers(prev=>prev.map(m=>m.id===memberId?{...m,capstone_completed:true,capstone_completed_at:new Date().toISOString()}:m));
        if(capstoneSubs[memberId])await refreshCapstoneSub(memberId);
        setReviewNotes(prev=>({...prev,[memberId]:""}));
      }
    }catch(e){console.warn("Capstone mark failed",e);}
    setCapstoneLoading(null);
  };

  const toggleCapstoneReview=async(memberId)=>{
    if(expandedCapstone===memberId){setExpandedCapstone(null);return;}
    setExpandedCapstone(memberId);
    if(capstoneSubs[memberId])return; // already fetched
    setCapstoneSubLoading(memberId);
    try{
      const res=await fetch(`${BACKEND}/api/capstone/${memberId}`);
      const data=await res.json();
      setCapstoneSubs(prev=>({...prev,[memberId]:data?.submission||null}));
    }catch(e){console.warn("Capstone submission fetch failed",e);}
    setCapstoneSubLoading(null);
  };

  const rejectCapstone=async(memberId)=>{
    const note=(reviewNotes[memberId]||"").trim();
    const sub=capstoneSubs[memberId];
    if(!note||!sub?.id)return;
    setRejectLoading(memberId);
    try{
      const res=await fetch(`${BACKEND}/api/capstone/${sub.id}/reject`,{
        method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({manager_notes:note,actioned_by:profile.name})
      });
      const data=await res.json();
      if(data.ok){
        await refreshCapstoneSub(memberId);
        setReviewNotes(prev=>({...prev,[memberId]:""}));
      }
    }catch(e){console.warn("Capstone reject failed",e);}
    setRejectLoading(null);
  };

  // ── Team Weekly Tracker (read aggregation, derived dynamically) ────────────
  const loadTeamTracker=()=>{
    setTrackerLoading(true);
    Promise.all([
      fetch(`${BACKEND}/api/allocations?manager=${encodeURIComponent(profile.name)}`).then(r=>r.json()).catch(()=>({allocations:[]})),
      fetch(`${BACKEND}/api/allocations/team-feed?manager=${encodeURIComponent(profile.name)}`).then(r=>r.json()).catch(()=>({feed:[]})),
      fetch(`${BACKEND}/api/utilization/team?manager=${encodeURIComponent(profile.name)}`).then(r=>r.json()).catch(()=>({members:[]})),
    ]).then(([allocData,feedData,utilData])=>{
      setTeamAllocations(allocData?.allocations||[]);
      setTeamFeed(feedData?.feed||[]);
      const utilMap={};
      (utilData?.members||[]).forEach(m=>{utilMap[m.member_name]=m;});
      setTeamUtilization(utilMap);
      setTrackerLoading(false);
    });
  };
  useEffect(()=>{ if(tab==="tracker") loadTeamTracker(); },[tab]);

  const saveAllocationOverride=async(payload,id)=>{
    const clean={...payload,manager:profile.name,
      start_date:payload.start_date||null,end_date:payload.end_date||null};
    try{
      const res=await fetch(`${BACKEND}/api/allocations/${id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(clean)});
      if(!res.ok)console.warn("Override save failed",res.status);
      else loadTeamTracker();
    }catch(e){console.warn("Save failed",e);}
    setEditingAlloc(null);
  };
  // Members are derived dynamically — whoever has logged at least one allocation
  const teamMemberNames=[...new Set(teamAllocations.map(a=>a.member_name))];
  const teamMemberStats=teamMemberNames.map(name=>{
    const myAllocs=teamAllocations.filter(a=>a.member_name===name);
    const hrsAllocated=myAllocs.reduce((s,a)=>s+Number(a.hrs_per_week||0),0);
    const capacity=40; // standard weekly capacity assumption
    const hrsAvailable=capacity-hrsAllocated;
    const pctUtil=Math.round((hrsAllocated/capacity)*100);
    const upcoming=myAllocs.filter(a=>a.end_date).map(a=>new Date(a.end_date)).sort((a,b)=>a-b);
    const freeDate=upcoming.length?upcoming[0]:null;
    const daysToFree=freeDate?Math.ceil((freeDate-new Date())/86400000):null;
    let status="Available";
    if(hrsAllocated>0){ status = (daysToFree!=null&&daysToFree<=60) ? "Available Soon" : "Busy"; }
    return {name,projectCount:myAllocs.length,hrsAllocated,hrsAvailable,pctUtil,freeDate,daysToFree,status};
  });

  const teamTrackerSummary={
    totalMembers:teamMemberNames.length,
    activeProjects:new Set(teamAllocations.filter(a=>a.stage!=="Completed").map(a=>a.project_id)).size,
    teamCapacity:teamMemberNames.length*40,
    ending30:teamAllocations.filter(a=>{if(!a.end_date)return false;const d=Math.ceil((new Date(a.end_date)-new Date())/86400000);return d>=0&&d<=30;}).length,
    ending60:teamAllocations.filter(a=>{if(!a.end_date)return false;const d=Math.ceil((new Date(a.end_date)-new Date())/86400000);return d>=0&&d<=60;}).length,
  };

  return(<div style={{display:"flex",flexDirection:"column",height:"100vh",fontFamily:"'adobe-clean','Source Sans 3',system-ui,sans-serif",background:P.bg}}>
    <GlobalStyles/>
    <Nav initial={profile.initial} name={profile.username||profile.name} sub={`People Manager · ${profile.team}`} color={profile.avatar_color||profile.color} avatarEmoji={profile.avatar_emoji} persona={profile.persona||"mgr"} badge="Manager" onLogout={onLogout} onToggleTheme={onToggleTheme} onGoToProfile={()=>setTab("profile")}/>
    {mobile?<Tabs items={tabs} active={tab} onChange={v=>{setTab(v);setSelected(null);setShowAddMember(false);}}/>:<SideNav items={tabs} active={tab} onChange={v=>{setTab(v);setSelected(null);setShowAddMember(false);}}/>}
    <div className="nx-main-content" style={{flex:1,overflowY:"auto",paddingLeft:mobile?0:SIDENAV_WIDTH}}>
      <div style={{maxWidth:960,margin:"0 auto",padding:"24px 24px 0"}}>

      {/* MGR Home */}
      {tab==="team"&&!selected&&<div style={{display:"flex",flexDirection:"column",gap:16}}>
        {/* Top summary */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:18,fontWeight:500,color:P.txt,letterSpacing:-.3,marginBottom:4}}>AEP Analytics APAC</div>
            <div style={{fontSize:13,color:P.muted}}>{dbMembers.length>0?`${dbMembers.length} direct report${dbMembers.length!==1?"s":""} from directory`:"Upload HR roster to see your team"}</div>
          </div>
          <div style={{display:"flex",gap:8,flexShrink:0}}>
            <Btn size="sm" onClick={()=>setTab("intel")}>Team Intel <Ic as={ChevronRight} size={13} color="currentColor"/></Btn>
            <Btn variant="secondary" size="sm" onClick={()=>setTab("skills")}>Skill Matrix</Btn>
          </div>
        </div>

        {/* KPI row — live where available */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
          {[
            {v:dbMembers.length>0?dbMembers.length:(liveSummary?.total_members??"—"), l:"Team members",  s:profile.team||"From directory",                    c:P.blue},
            {v:liveSummary?.at_risk_count??"—",                                        l:"At risk",       s:"8+ weeks without capstone",                       c:P.red},
            {v:liveSummary?.capstones_completed??"—",                                  l:"Capstones done",s:"Registered members who completed",                c:P.grn},
            {v:liveSummary?.avg_days_to_capstone?`${liveSummary.avg_days_to_capstone}d`:"—",l:"Avg days to capstone",s:"Once members start learning",         c:P.purple},
          ].map(k=>(
            <div key={k.l} style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,padding:"14px 16px",boxShadow:P.shadow,borderTop:`2px solid ${k.c}`}}>
              <div style={{fontSize:20,fontWeight:500,color:P.txt,letterSpacing:-.5,marginBottom:2}}>{k.v}</div>
              <div style={{fontSize:12.5,fontWeight:600,color:P.txt,marginBottom:2}}>{k.l}</div>
              <div style={{fontSize:11,color:P.muted,lineHeight:1.4}}>{k.s}</div>
            </div>
          ))}
        </div>

        {/* Attention flags — live from behavioural telemetry */}
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          <div style={{fontSize:12,fontWeight:600,color:P.dim,letterSpacing:.3,marginBottom:2}}>Action needed</div>
          {liveSummary?.at_risk_count>0?(
            <div style={{background:P.redBg,border:`1px solid ${P.red}20`,borderRadius:10,padding:"11px 16px",display:"flex",alignItems:"center",gap:12}}>
              <div style={{width:7,height:7,borderRadius:"50%",background:P.red,flexShrink:0}}/>
              <div style={{flex:1}}>
                <span style={{fontSize:13,fontWeight:600,color:P.txt}}>{liveSummary.at_risk_count} team member{liveSummary.at_risk_count>1?"s":""} at risk</span>
                <span style={{fontSize:13,color:P.muted}}> · 8+ weeks on platform without capstone completion</span>
              </div>
              <Btn variant="secondary" size="sm" onClick={()=>setTab("members")}>View team</Btn>
            </div>
          ):(
            <div style={{background:P.surface,border:`1px solid ${P.border}`,borderRadius:10,padding:"14px 18px"}}>
              <div style={{fontSize:12.5,fontWeight:600,color:P.muted,marginBottom:4}}>At-risk flags</div>
              <div style={{fontSize:12,color:P.muted,lineHeight:1.6}}>
                Flags appear here when a team member has been on the platform for 8+ weeks without completing their capstone, or when their confidence score plateaus. Cert expiry alerts will also surface here automatically once certification data is uploaded.
              </div>
            </div>
          )}
        </div>

        {/* Live KPIs — only shown once at least one real registered+approved member exists */}
        {liveSummary&&liveSummary.total_members>0&&<div>
          <div style={{fontSize:12,fontWeight:600,color:P.dim,letterSpacing:.3,marginBottom:8}}>Your registered team — live</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
            {[
              {v:String(liveSummary.total_members),l:"Registered members",c:P.blue},
              {v:String(liveSummary.capstones_completed),l:"Capstones completed",c:P.grn},
              {v:liveSummary.avg_days_to_capstone!=null?`${liveSummary.avg_days_to_capstone}d`:"—",l:"Avg days to capstone",c:P.purple},
              {v:String(liveSummary.at_risk_count),l:"At risk (8+ weeks, no capstone)",c:liveSummary.at_risk_count>0?P.red:P.grn},
            ].map(k=>(
              <div key={k.l} style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,padding:"14px 16px",borderTop:`2px solid ${k.c}`}}>
                <div style={{fontSize:20,fontWeight:500,color:P.txt,letterSpacing:-.5,marginBottom:2}}>{k.v}</div>
                <div style={{fontSize:11.5,color:P.muted,lineHeight:1.4}}>{k.l}</div>
              </div>
            ))}
          </div>
        </div>}

        {/* Team Utilization section */}
        <TeamUtilizationSection manager={profile.name} onGoToTracker={()=>setTab("tracker")}/>

        {/* Registered learners from DB */}
        {dbMembers.length>0&&<div>
          <div style={{fontSize:12,fontWeight:600,color:P.dim,letterSpacing:.3,marginBottom:8}}>Registered learners (from onboarding)</div>
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden"}}>
            {dbMembers.map((m,idx)=>{
              const live=liveSummary?.members?.find(lm=>lm.name===m.name);
              const sub=capstoneSubs[m.id];
              const expanded=expandedCapstone===m.id;
              const historyExpanded=historyExpandedOverride[m.id]??(sub?.status==="manager_rejected");
              return(
              <div key={m.id} style={{borderBottom:idx<dbMembers.length-1?`1px solid ${P.bfaint}`:"none"}}>
                <div style={{padding:"13px 18px",display:"flex",alignItems:"center",gap:14}}>
                  <div style={{width:34,height:34,borderRadius:"50%",background:"#6030D0",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:500,fontSize:13,flexShrink:0}}>{(m.preferred_name||m.name||"?")[0].toUpperCase()}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                      <span style={{fontSize:13.5,fontWeight:600,color:P.txt}}>{m.name}</span>
                      <span style={{fontSize:11,color:P.muted,background:P.bfaint,borderRadius:4,padding:"1px 6px"}}>{m.team}</span>
                      {m.capstone_completed
                        ?<span style={{fontSize:11,fontWeight:600,color:P.grn,background:P.grnBg,borderRadius:4,padding:"1px 6px"}}>Capstone done</span>
                        :<span style={{fontSize:11,color:P.muted,background:P.bfaint,borderRadius:4,padding:"1px 6px"}}>Enablement in progress</span>}
                      {live&&<span style={{fontSize:11,color:P.blue,background:P.blueGh,borderRadius:4,padding:"1px 6px"}}>{live.modules_done}/9 modules</span>}
                      {live&&live.points>0&&<span style={{fontSize:11,color:P.purple,background:P.purpleBg,borderRadius:4,padding:"1px 6px"}}>{live.points} pts</span>}
                    </div>
                    <div style={{fontSize:11.5,color:P.muted,marginTop:2}}>{m.email} · joined {m.joining_date}</div>
                  </div>
                  <button onClick={()=>toggleCapstoneReview(m.id)}
                    style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:12,fontWeight:600,color:P.blue,background:"transparent",border:`1px solid ${P.blue}40`,borderRadius:8,padding:"6px 12px",cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",flexShrink:0}}>
                    <Ic as={expanded?ChevronUp:ChevronDown} size={12} color={P.blue}/>{expanded?"Hide":"Review"} capstone
                  </button>
                  {!m.capstone_completed&&<button
                    onClick={()=>markCapstone(m.id)}
                    disabled={capstoneLoading===m.id}
                    style={{fontSize:12,fontWeight:600,color:"#fff",background:capstoneLoading===m.id?P.muted:P.grn,border:"none",borderRadius:8,padding:"6px 14px",cursor:"pointer",fontFamily:"inherit",opacity:capstoneLoading===m.id?.7:1,whiteSpace:"nowrap",flexShrink:0}}>
                    {capstoneLoading===m.id?"Saving...":"Mark capstone complete"}
                  </button>}
                  {m.capstone_completed&&<span style={{fontSize:11.5,color:P.grn,flexShrink:0}}>Unlocked skills dashboard</span>}
                </div>

                {expanded&&(
                  <div style={{padding:"0 18px 16px 66px"}}>
                    {capstoneSubLoading===m.id&&<div style={{fontSize:12.5,color:P.muted}}>Loading submission…</div>}
                    {capstoneSubLoading!==m.id&&!sub&&<div style={{fontSize:12.5,color:P.muted,background:P.surface,border:`1px solid ${P.border}`,borderRadius:9,padding:"10px 14px"}}>No capstone generated yet.</div>}
                    {capstoneSubLoading!==m.id&&sub&&<div style={{background:P.surface,border:`1px solid ${P.border}`,borderRadius:10,padding:"14px 16px",display:"flex",flexDirection:"column",gap:12}}>
                      <div>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                          <Label>Scenario</Label>
                          {sub.manager_notes&&sub.status!=="manager_rejected"&&<span style={{fontSize:10,fontWeight:600,color:P.amber,background:P.amberBg,borderRadius:4,padding:"1px 7px"}}>Resubmission after feedback</span>}
                        </div>
                        <div style={{fontSize:13,fontWeight:600,color:P.txt,marginBottom:3}}>{sub.scenario?.title||"—"}</div>
                        <div style={{fontSize:12.5,color:P.muted,lineHeight:1.6}}>{sub.scenario?.client_context}</div>
                        {sub.scenario?.deliverable&&<div style={{fontSize:12,color:P.txt,marginTop:6}}><strong>Deliverable:</strong> {sub.scenario.deliverable}</div>}
                      </div>
                      {sub.manager_notes&&<div style={{background:P.amberBg,border:`1px solid ${P.amber}30`,borderRadius:8,padding:"9px 12px",display:"flex",gap:8,alignItems:"flex-start"}}>
                        <Ic as={AlertTriangle} size={13} color={P.amber} style={{marginTop:2}}/>
                        <div>
                          <Label style={{color:P.amber,marginBottom:3}}>Your feedback to the learner</Label>
                          <div style={{fontSize:12.5,color:P.txt,lineHeight:1.6}}>{sub.manager_notes}</div>
                        </div>
                      </div>}
                      {sub.response_text&&<div>
                        <Label style={{marginBottom:4}}>Learner's response</Label>
                        <div style={{fontSize:12.5,color:P.txt,lineHeight:1.7,whiteSpace:"pre-line",background:P.bg,border:`1px solid ${P.border}`,borderRadius:8,padding:"10px 12px"}}>{sub.response_text}</div>
                      </div>}
                      {sub.ai_evaluation&&<div>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                          <Label>AI evaluation (advisory)</Label>
                          <span style={{fontSize:13,fontWeight:700,color:sub.ai_evaluation.score>=70?P.grn:sub.ai_evaluation.score>=40?P.amber:P.red}}>{sub.ai_evaluation.score}/100</span>
                          <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:10.5,fontWeight:700,color:sub.ai_evaluation.pass?P.grn:P.amber,background:sub.ai_evaluation.pass?P.grnBg:P.amberBg,borderRadius:4,padding:"1px 7px"}}>
                            <Ic as={sub.ai_evaluation.pass?CheckmarkCircle:AlertTriangle} size={11} color={sub.ai_evaluation.pass?P.grn:P.amber}/>{sub.ai_evaluation.pass?"Meets the bar":"Needs work"}
                          </span>
                        </div>
                        <div style={{fontSize:12.5,color:P.txt,lineHeight:1.65,marginBottom:6}}>{sub.ai_evaluation.feedback}</div>
                        {(sub.ai_evaluation.strengths||[]).length>0&&<div style={{fontSize:12,color:P.muted,marginBottom:3}}><strong style={{color:P.grn}}>Strengths:</strong> {sub.ai_evaluation.strengths.join("; ")}</div>}
                        {(sub.ai_evaluation.gaps||[]).length>0&&<div style={{fontSize:12,color:P.muted,marginBottom:3}}><strong style={{color:P.amber}}>Gaps:</strong> {sub.ai_evaluation.gaps.join("; ")}</div>}
                        {sub.ai_evaluation.recommendation&&<div style={{fontSize:12,color:P.muted}}><strong>Recommendation:</strong> {sub.ai_evaluation.recommendation}</div>}
                      </div>}
                      {!sub.ai_evaluation&&sub.response_text&&<div style={{fontSize:12,color:P.muted}}>Learner hasn't run the AI self-check yet.</div>}
                      {!m.capstone_completed&&sub.response_text&&sub.status!=="manager_rejected"&&(
                        <div style={{borderTop:`1px solid ${P.border}`,paddingTop:12}}>
                          <Label style={{marginBottom:6}}>Manager decision</Label>
                          <textarea value={reviewNotes[m.id]||""} onChange={e=>setReviewNotes(prev=>({...prev,[m.id]:e.target.value}))} rows={2}
                            placeholder="Optional note on approval — required to reject..."
                            style={{width:"100%",boxSizing:"border-box",border:`1px solid ${P.border}`,borderRadius:8,padding:"8px 10px",fontSize:12.5,lineHeight:1.6,outline:"none",background:P.bg,color:P.txt,resize:"vertical",fontFamily:"inherit",marginBottom:8}}/>
                          <div style={{display:"flex",gap:8}}>
                            <Btn size="sm" variant="success" onClick={()=>markCapstone(m.id,reviewNotes[m.id])} disabled={capstoneLoading===m.id}>
                              {capstoneLoading===m.id?"Saving...":"Approve"}
                            </Btn>
                            <Btn size="sm" variant="danger" onClick={()=>rejectCapstone(m.id)} disabled={rejectLoading===m.id||!(reviewNotes[m.id]||"").trim()}>
                              {rejectLoading===m.id?"Sending...":"Reject — send back to learner"}
                            </Btn>
                          </div>
                        </div>
                      )}
                      {sub.status==="manager_rejected"&&<div style={{fontSize:12,color:P.muted}}>Waiting on the learner to revise and resubmit.</div>}
                      {(sub.manager_review_history||[]).length>0&&(
                        <div style={{borderTop:`1px solid ${P.border}`,paddingTop:12}}>
                          <button onClick={()=>setHistoryExpandedOverride(prev=>({...prev,[m.id]:!historyExpanded}))}
                            style={{display:"flex",alignItems:"center",gap:6,background:"transparent",border:"none",padding:0,cursor:"pointer",fontFamily:"inherit",width:"100%",textAlign:"left"}}>
                            <Label>Review history ({sub.manager_review_history.length})</Label>
                            <Ic as={historyExpanded?ChevronUp:ChevronDown} size={12} color={P.dim} style={{marginLeft:"auto"}}/>
                          </button>
                          {historyExpanded&&<div style={{display:"flex",flexDirection:"column",gap:8,marginTop:8}}>
                            {[...sub.manager_review_history].reverse().map((h,i)=>(
                              <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                                <span style={{fontSize:10.5,fontWeight:700,color:h.decision==="approved"?P.grn:P.amber,background:h.decision==="approved"?P.grnBg:P.amberBg,borderRadius:4,padding:"1px 7px",flexShrink:0,marginTop:1,whiteSpace:"nowrap"}}>{h.decision==="approved"?"Approved":"Rejected"}</span>
                                <div style={{flex:1,minWidth:0}}>
                                  <div style={{fontSize:12,color:P.txt,lineHeight:1.5}}>{h.notes||<span style={{color:P.dim}}>No note left</span>}</div>
                                  <div style={{fontSize:10.5,color:P.dim,marginTop:2}}>{h.manager_name||"Unknown manager"}{h.reviewed_at?` · ${new Date(h.reviewed_at).toLocaleString("en-GB",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}`:""}</div>
                                </div>
                              </div>
                            ))}
                          </div>}
                        </div>
                      )}
                    </div>}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        </div>}

        {/* Team points leaderboard — real, derived from points_ledger */}
        {leaderboard.length>0&&<div>
          <div style={{fontSize:12,fontWeight:600,color:P.dim,letterSpacing:.3,marginBottom:8}}>Team leaderboard</div>
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden"}}>
            {leaderboard.map((l,idx)=>(
              <div key={l.member_name} style={{padding:"10px 18px",borderBottom:idx<leaderboard.length-1?`1px solid ${P.bfaint}`:"none",display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:12.5,fontWeight:500,color:idx===0?P.amber:P.dim,width:20}}>{idx+1}</span>
                <span style={{fontSize:13,fontWeight:500,color:P.txt,flex:1}}>{l.member_name}</span>
                <span style={{fontSize:13,fontWeight:500,color:P.purple}}>{l.total} pts</span>
              </div>
            ))}
          </div>
        </div>}

        {/* Team */}
        <div>
          <div style={{fontSize:12,fontWeight:600,color:P.dim,letterSpacing:.3,marginBottom:8}}>
            {dbMembers.length>0
              ? <>Your team · {dbMembers.length} member{dbMembers.length!==1?"s":""} from directory · <span style={{fontWeight:400}}>go to Team Members tab for full detail</span></>
              : "Your team"}
          </div>
          {dbMembers.length===0?(
            <div style={{background:P.surface,border:`1px solid ${P.border}`,borderRadius:12,padding:"18px 20px"}}>
              <div style={{fontSize:12.5,fontWeight:600,color:P.muted,marginBottom:4}}>Team roster</div>
              <div style={{fontSize:12,color:P.muted,lineHeight:1.6}}>
                Your team members will appear here once the HR roster has been uploaded via <strong>Admin → User Provisioning</strong>. Each row shows the member's name, role, current learning track, and confidence score. Click any row to view their full profile, certifications, and progress.
              </div>
            </div>
          ):(
            <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden",boxShadow:P.shadow}}>
              {dbMembers.map((m,idx)=>{
                const name=m.full_name||m.name||m.email;
                const conf=liveSummary?.members?.find(lm=>lm.name===name)?.avg_confidence||0;
                const initials=name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
                return(
                <div key={m.email} style={{display:"flex",alignItems:"center",gap:14,padding:"13px 18px",
                  borderBottom:idx<dbMembers.length-1?`1px solid ${P.bfaint}`:"none"}}>
                  <div style={{width:34,height:34,borderRadius:"50%",background:P.blue,display:"flex",alignItems:"center",
                    justifyContent:"center",color:"#fff",fontWeight:500,fontSize:13,flexShrink:0}}>{initials}</div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:1}}>{name}</div>
                    <div style={{fontSize:11.5,color:P.muted}}>{m.role||"—"}{m.team?` · ${m.team}`:""}{m.location?` · ${m.location}`:""}</div>
                  </div>
                  <div style={{fontSize:12,color:P.muted,flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {m.active_track?m.active_track.toUpperCase()+" track":"Not started yet"}
                  </div>
                  {conf>0&&<div style={{width:120,flexShrink:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{flex:1,height:4,background:P.bfaint,borderRadius:99}}>
                        <div style={{height:"100%",width:`${conf*100}%`,background:conf>=.75?P.grn:P.amber,borderRadius:99}}/>
                      </div>
                      <span style={{fontSize:12,fontWeight:600,color:conf>=.75?P.grn:P.amber,width:30,textAlign:"right"}}>{Math.round(conf*100)}%</span>
                    </div>
                    <div style={{fontSize:10.5,color:P.dim,marginTop:2}}>Confidence</div>
                  </div>}
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>}

      {tab==="team"&&selected&&<MemberDetail member={selected} onBack={()=>setSelected(null)} memberProjects={memberProjects}/>}

      {tab==="members"&&<TeamMembersTab managerName={profile.name} managerEmail={profile.email} setTab={setTab}/>}
      {tab==="skills"&&<div>
        <div style={{marginBottom:20}}>
          <div style={{fontSize:16,fontWeight:500,color:P.txt,marginBottom:2}}>Skill Matrix</div>
          <div style={{fontSize:13,color:P.muted}}>Coverage against market demand across 6 skills</div>
        </div>
        {liveSummary&&liveSummary.total_members>0&&<Card style={{padding:"14px 18px",marginBottom:16,background:P.blueGh,border:`1px solid ${P.blue}25`}}>
          <div style={{fontSize:11,fontWeight:600,color:P.blue,letterSpacing:.4,textTransform:"uppercase",marginBottom:8}}>Registered team — real module progress</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {liveSummary.members.map(m=>(
              <div key={m.name} style={{display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:12.5,color:P.txt,width:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.name}</span>
                <div style={{flex:1,height:5,background:P.bfaint,borderRadius:99,overflow:"hidden"}}><div style={{height:"100%",width:`${(m.modules_done/9)*100}%`,background:P.blue,borderRadius:99}}/></div>
                <span style={{fontSize:11.5,fontWeight:600,color:P.muted,width:42,textAlign:"right"}}>{m.modules_done}/9</span>
              </div>
            ))}
          </div>
          <div style={{fontSize:11,color:P.muted,marginTop:10}}>Module-completion progress above is real, from each member&rsquo;s own Learning Path.</div>
        </Card>}

        {teamSkills.length>0&&<Card style={{padding:"14px 18px",marginBottom:16,background:P.purpleBg,border:`1px solid ${P.purple}25`}}>
          <div style={{fontSize:11,fontWeight:600,color:P.purple,letterSpacing:.4,textTransform:"uppercase",marginBottom:8}}>Registered team — real skill assessments</div>
          <div style={{fontSize:11.5,color:P.muted,marginBottom:10}}>From each member&rsquo;s own adaptive (CAT) skill quiz in their Skill Development tab — persisted, not estimated.</div>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            {[...new Set(teamSkills.map(a=>a.member_name))].map(name=>{
              const rows=teamSkills.filter(a=>a.member_name===name);
              return(
                <div key={name} style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",padding:"6px 0",borderBottom:`1px solid ${P.bfaint}`}}>
                  <span style={{fontSize:12.5,fontWeight:600,color:P.txt,width:130,flexShrink:0}}>{name}</span>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {rows.map(r=>(
                      <span key={r.skill} style={{display:"inline-flex",alignItems:"center",gap:4}}>
                        <span style={{fontSize:10.5,color:P.muted}}>{r.skill}:</span><LBadge s={r.level}/>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>}

        <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.4,textTransform:"uppercase",marginBottom:10}}>Illustrative demo cohort</div>
        {SKILLS.map((sk,si)=>{
          const levels=TEAM.map(m=>m.skills[si]);
          const covered=levels.filter(l=>l==="proficient"||l==="expert").length;
          const pct=Math.round(covered/TEAM.length*100);
          const mkt=MARKET[si];
          const danger=mkt==="gap"&&covered<2;
          return(<Card key={sk} style={{padding:"18px 20px",marginBottom:10}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
              <div style={{flex:1,fontSize:14,fontWeight:600,color:P.txt}}>{sk}</div>
              <div style={{display:"flex",alignItems:"center",gap:6}}><span style={{fontSize:11.5,color:P.muted}}>Market demand</span><LBadge s={mkt}/></div>
            </div>
            <div style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontSize:12,color:P.muted}}>Team coverage (proficient+)</span><span style={{fontSize:12,fontWeight:600,color:pct<50?P.red:pct<75?P.amber:P.grn}}>{covered} of {TEAM.length}</span></div>
              <div style={{height:5,background:P.bfaint,borderRadius:99,overflow:"hidden"}}><div style={{height:"100%",width:`${pct}%`,background:pct<50?P.red:pct<75?P.amber:P.grn,borderRadius:99}}/></div>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {TEAM.map(m=>{const s=m.skills[si];const c=SC(s);return(
                <div key={m.name} style={{flex:1,minWidth:80,background:c.bg,border:`1px solid ${c.bd}`,borderRadius:9,padding:"8px 10px",textAlign:"center",cursor:"pointer"}} onClick={()=>{setTab("team");setSelected(m);}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:m.color,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:500,fontSize:10,margin:"0 auto 5px"}}>{m.name[0]}</div>
                  <div style={{fontSize:9.5,fontWeight:600,color:c.fg,textTransform:"capitalize"}}>{s==="gap"?"Gap":s}</div>
                </div>
              );})}
            </div>
          </Card>);
        })}
      </div>}

      {tab==="certs"&&<MgrCertsView setTab={setTab} managerEmail={profile.email} managerName={profile.name}/>}

      {tab==="projects"&&<LiveProjectBoard managerEmail={profile.email} managerName={profile.name}/>}
      {tab==="tracker"&&<MgrTeamTrackerView profile={profile}/>}
      {tab==="approvals"&&<ApprovalsTab pendingApprovals={pendingApprovals} setPendingApprovals={setPendingApprovals} profile={profile}/>}
      {tab==="intel"&&<div style={{padding:"0 0 24px",height:"calc(100vh - 140px)",display:"flex",flexDirection:"column"}}><ManagerAgent profile={profile} groqKey={groqKey} onLog={onLog} dbMembers={dbMembers} liveSummary={liveSummary} teamSkills={teamSkills} teamProjects={teamProjects}/></div>}
      {/* Manager's own team community — scope to their OWN email so they see the
          team they lead (their reports have manager_email == this manager's email). */}
      {tab==="community"&&<Community profile={{...profile,manager_email:profile?.email||profile?.manager_email}}/>}
      {tab==="profile"&&<div style={{maxWidth:640,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:16}}>
        <Card style={{padding:"22px 24px"}}>
          <div style={{display:"flex",alignItems:"center",gap:18,marginBottom:20}}>
            <div style={{width:56,height:56,borderRadius:"50%",background:`linear-gradient(135deg,${profile.avatar_color||profile.color},${(profile.avatar_color||profile.color)}bb)`,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:500,fontSize:22,flexShrink:0}}>{profile.avatar_emoji||profile.initial}</div>
            <div style={{flex:1}}><div style={{fontSize:17,fontWeight:500,color:P.txt,marginBottom:2}}>{profile.username||profile.name}</div><div style={{fontSize:12.5,color:P.muted}}>People Manager · {profile.team}</div></div>
            <span style={{fontSize:11,fontWeight:500,background:P.amberBg,color:P.amber,border:`1px solid ${P.amber}30`,borderRadius:6,padding:"3px 10px"}}>Manager</span>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            {[{l:"Email",v:profile.email||"—"},{l:"Role",v:profile.role||"People Manager"},{l:"Team",v:profile.team||"—"},{l:"Tenure",v:profile.tenure||"—"},
              {l:"Joining date",v:profile.joining_date?(new Date(profile.joining_date).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})):"—"},{l:"Direct reports",v:String(dbMembers.length)},
            ].map(r=>(<div key={r.l} style={{background:P.surface,borderRadius:8,padding:"10px 12px"}}>
              <div style={{fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.4,textTransform:"uppercase",marginBottom:3}}>{r.l}</div>
              <div style={{fontSize:13,fontWeight:500,color:P.txt,wordBreak:"break-all"}}>{r.v}</div>
            </div>))}
          </div>
        </Card>
        <Card style={{padding:"18px 20px"}}>
          <Label style={{marginBottom:10}}>Certification</Label>
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 13px",background:profile.cert.status==="Active"?P.grnBg:P.amberBg,border:`1px solid ${profile.cert.status==="Active"?P.grn+"30":P.amber+"30"}`,borderRadius:8}}>
            <span style={{fontSize:16}}>🎖</span>
            <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600,color:P.txt}}>{profile.cert.name}</div><div style={{fontSize:11,color:P.muted}}>Expires {profile.cert.exp}</div></div>
            <span style={{fontSize:11.5,fontWeight:500,color:profile.cert.status==="Active"?P.grn:P.amber}}>{profile.cert.status}</span>
          </div>
        </Card>
        {profile.id&&<ProfileSettingsCard email={profile.email} accountType="manager" currentUsername={profile.username} currentEmoji={profile.avatar_emoji} currentColor={profile.avatar_color} fallbackColor={profile.color} onSaved={setAvatarOverride}/>}
      </div>}
      </div>
    </div>
  </div>);
}

// ── ADMIN DASHBOARD — M7 Prompt Lab · M8 Guardrails · M9 LLMOps ─────────────
// ── Member Data Explorer — Admin view of all stored data for any user ───────
function MemberDataExplorer(){
  const [query,setQuery]=useState("");
  const [report,setReport]=useState(null);
  const [loading,setLoading]=useState(false);
  const [openSection,setOpenSection]=useState(null);

  const load=async()=>{
    if(!query.trim())return;
    setLoading(true);setReport(null);
    try{
      const r=await fetch(`${BACKEND}/api/admin/member-report?member=${encodeURIComponent(query.trim())}`);
      const d=await r.json();
      setReport(d);
    }catch(e){setReport({error:"Could not load — is the backend running?"});}
    setLoading(false);
  };

  const Section=({id,title,badge,color=P.blue,children})=>{
    const open=openSection===id;
    return(
      <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:10,overflow:"hidden",marginBottom:8}}>
        <div onClick={()=>setOpenSection(open?null:id)}
          style={{padding:"12px 16px",cursor:"pointer",display:"flex",alignItems:"center",gap:10,background:open?P.blueGh:"transparent"}}>
          <span style={{flex:1,fontSize:13.5,fontWeight:600,color:open?P.blue:P.txt}}>{title}</span>
          {badge!=null&&<span style={{fontSize:11,fontWeight:500,color:color,background:color+"15",borderRadius:5,padding:"2px 8px"}}>{badge}</span>}
          <Ic as={open?ChevronUp:ChevronDown} size={14} color={P.dim}/>
        </div>
        {open&&<div style={{padding:"0 16px 14px",borderTop:`1px solid ${P.bfaint}`}}>{children}</div>}
      </div>
    );
  };

  const Row=({label,value,mono=false})=>(
    <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${P.bfaint}`,gap:16}}>
      <span style={{fontSize:12,color:P.muted,flexShrink:0}}>{label}</span>
      <span style={{fontSize:12,color:P.txt,fontFamily:mono?"ui-monospace,monospace":"inherit",wordBreak:"break-all",textAlign:"right"}}>{value??"—"}</span>
    </div>
  );

  const acc=report?.account;
  const pts=report?.points;

  return(
    <div style={{maxWidth:780,margin:"0 auto",padding:"24px"}}>
      <div style={{fontSize:17,fontWeight:500,color:P.txt,marginBottom:4}}>Member Data Explorer</div>
      <div style={{fontSize:13,color:P.muted,marginBottom:16}}>Look up all stored data for any registered user — scores, progress, behaviour, conversations, utilization.</div>

      {/* Search */}
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        <input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&load()}
          placeholder="Type member name (e.g. Alex Carter) then press Enter"
          style={{flex:1,border:`1.5px solid ${P.border}`,borderRadius:9,padding:"10px 14px",fontSize:13.5,color:P.txt,background:P.bg,outline:"none",fontFamily:"inherit"}}/>
        <Btn onClick={load} disabled={loading||!query.trim()}>{loading?"Loading…":<>Load report <Ic as={ChevronRight} size={14} color="currentColor"/></>}</Btn>
      </div>

      {report?.error&&<div style={{color:P.red,fontSize:13,padding:"12px 16px",background:P.redBg,borderRadius:8}}>{report.error}</div>}

      {report&&!report.error&&(
        <div>
          {/* Identity summary strip */}
          {acc&&(
            <div style={{background:`linear-gradient(135deg,${P.purpleBg},${P.blueGh})`,border:`1px solid ${P.purple}20`,borderRadius:12,padding:"16px 20px",marginBottom:16,display:"flex",gap:20,flexWrap:"wrap"}}>
              <div><div style={{fontSize:10.5,color:P.muted,marginBottom:2}}>Name</div><div style={{fontSize:14,fontWeight:500,color:P.txt}}>{acc.name}</div></div>
              <div><div style={{fontSize:10.5,color:P.muted,marginBottom:2}}>Role</div><div style={{fontSize:13,color:P.txt}}>{acc.role||"—"}</div></div>
              <div><div style={{fontSize:10.5,color:P.muted,marginBottom:2}}>Team</div><div style={{fontSize:13,color:P.txt}}>{acc.team}</div></div>
              <div><div style={{fontSize:10.5,color:P.muted,marginBottom:2}}>Track</div><div style={{fontSize:13,color:P.txt}}>{acc.active_track||"rtcdp"}</div></div>
              <div><div style={{fontSize:10.5,color:P.muted,marginBottom:2}}>Status</div><div style={{fontSize:13,fontWeight:600,color:acc.capstone_completed?P.grn:P.amber}}>{acc.capstone_completed?"Capstone done ✓":"In progress"}</div></div>
              <div><div style={{fontSize:10.5,color:P.muted,marginBottom:2}}>Total points</div><div style={{fontSize:14,fontWeight:500,color:P.blue}}>{pts?.total||0} pts</div></div>
            </div>
          )}

          <Section id="account" title="Account & Onboarding" badge={acc?"registered":"—"}>
            {acc?<>
              <div style={{paddingTop:10}}>
              <Row label="Email" value={acc.email} mono/>
              <Row label="Joined" value={acc.joining_date}/>
              <Row label="Manager" value={acc.manager}/>
              <Row label="Capstone started" value={acc.capstone_started_at||"Not started"}/>
              <Row label="Capstone completed" value={acc.capstone_completed_at||"Not yet"}/>
              <Row label="Active track" value={acc.active_track}/>
              </div>
            </>:<div style={{padding:"10px 0",color:P.muted,fontSize:13}}>No account found for this name.</div>}
          </Section>

          <Section id="progress" title="Module Progress" badge={report.modules_completed?.length||0} color={P.grn}>
            {report.modules_completed?.length>0
              ?<div style={{paddingTop:10,display:"flex",flexDirection:"column",gap:4}}>
                  {report.modules_completed.map((m,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12.5,padding:"5px 0",borderBottom:`1px solid ${P.bfaint}`}}>
                      <span style={{color:P.txt}}>{m.module_title||`Module ${m.module_id}`}</span>
                      <span style={{color:P.muted,fontSize:11.5}}>{m.via==="test_out"?"Test-out ✓":"Completed"} · {m.completed_at?.slice(0,10)}</span>
                    </div>
                  ))}
                </div>
              :<div style={{padding:"10px 0",color:P.muted,fontSize:13}}>No modules completed yet.</div>}
          </Section>

          <Section id="skills" title="Skill Assessments (CAT Quiz)" badge={report.skill_assessments?.length||0} color={P.purple}>
            {report.skill_assessments?.length>0
              ?<div style={{paddingTop:10}}>
                  {report.skill_assessments.map((s,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:`1px solid ${P.bfaint}`}}>
                      <span style={{fontSize:13,color:P.txt}}>{s.skill}</span>
                      <div style={{display:"flex",gap:8,alignItems:"center"}}>
                        <span style={{fontSize:11.5,fontWeight:600,color:s.level==="expert"?P.blue:s.level==="proficient"?P.grn:P.amber,background:(s.level==="expert"?P.blue:s.level==="proficient"?P.grn:P.amber)+"18",borderRadius:5,padding:"2px 8px"}}>{s.level}</span>
                        <span style={{fontSize:11,color:P.muted}}>θ={s.theta?.toFixed(2)}</span>
                        <span style={{fontSize:11,color:P.dim}}>{s.assessed_at?.slice(0,10)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              :<div style={{padding:"10px 0",color:P.muted,fontSize:13}}>No skill assessments recorded.</div>}
          </Section>

          <Section id="testouts" title="Test-Outs" badge={report.test_outs?.length||0} color={P.amber}>
            {report.test_outs?.length>0
              ?<div style={{paddingTop:10,display:"flex",flexDirection:"column",gap:4}}>
                  {report.test_outs.map((t,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12.5,padding:"5px 0",borderBottom:`1px solid ${P.bfaint}`}}>
                      <span style={{color:P.txt}}>{t.module_title||`Module ${t.module_id}`}</span>
                      <span style={{fontWeight:600,color:t.passed?P.grn:P.red}}>{t.score}% — {t.passed?"Passed":"Failed"}</span>
                    </div>
                  ))}
                </div>
              :<div style={{padding:"10px 0",color:P.muted,fontSize:13}}>No test-outs attempted.</div>}
          </Section>

          <Section id="points" title="Points Ledger" badge={pts?.total!=null?`${pts.total} pts`:"—"} color={P.blue}>
            {pts?.ledger?.length>0
              ?<div style={{paddingTop:10,display:"flex",flexDirection:"column",gap:3}}>
                  {pts.ledger.map((p,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"4px 0",borderBottom:`1px solid ${P.bfaint}`}}>
                      <span style={{color:P.muted,flex:1}}>{p.reason}</span>
                      <span style={{color:P.grn,fontWeight:500,marginLeft:12}}>+{p.points}</span>
                      <span style={{color:P.dim,fontSize:11,marginLeft:10,flexShrink:0}}>{p.created_at?.slice(0,10)}</span>
                    </div>
                  ))}
                </div>
              :<div style={{padding:"10px 0",color:P.muted,fontSize:13}}>No points awarded yet.</div>}
          </Section>

          <Section id="behaviour" title="Behaviour & Telemetry" badge={report.behaviour?.length||0}>
            {report.behaviour?.length>0
              ?<div style={{paddingTop:10,display:"flex",flexDirection:"column",gap:4}}>
                  {report.behaviour.map((e,i)=>(
                    <div key={i} style={{display:"flex",gap:10,fontSize:11.5,padding:"4px 0",borderBottom:`1px solid ${P.bfaint}`}}>
                      <span style={{color:P.blue,fontWeight:600,flexShrink:0,width:110}}>{e.event_type}</span>
                      <span style={{color:P.muted,flex:1}}>{e.module}{e.detail?` · ${e.detail}`:""}</span>
                      <span style={{color:P.dim,flexShrink:0}}>{e.created_at?.slice(0,10)}</span>
                    </div>
                  ))}
                </div>
              :<div style={{padding:"10px 0",color:P.muted,fontSize:13}}>No telemetry events yet.</div>}
          </Section>

          <Section id="convos" title="AI Tutor Conversations" badge={report.conversations?.reduce((s,c)=>s+c.messages,0)||0}>
            {report.conversations?.length>0
              ?<div style={{paddingTop:10,display:"flex",flexDirection:"column",gap:4}}>
                  {report.conversations.map((c,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:12.5,padding:"5px 0",borderBottom:`1px solid ${P.bfaint}`}}>
                      <span style={{color:P.txt}}>{c.module} <span style={{color:P.muted,fontWeight:400}}>({c.mode} mode)</span></span>
                      <span style={{color:P.muted}}>{c.messages} messages</span>
                    </div>
                  ))}
                </div>
              :<div style={{padding:"10px 0",color:P.muted,fontSize:13}}>No AI tutor conversations recorded.</div>}
          </Section>

          <Section id="utilization" title="Utilization (Last 4 Weeks)" badge={report.utilization?.length||0} color={P.amber}>
            {report.utilization?.length>0
              ?<div style={{paddingTop:10}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr .8fr .8fr .8fr .8fr .8fr",gap:4,fontSize:10.5,fontWeight:500,color:P.dim,textTransform:"uppercase",letterSpacing:.3,padding:"4px 0",borderBottom:`1px solid ${P.border}`}}>
                    <span>Week of</span><span>Billable</span><span>Non-Bill CF</span><span>Ramp</span><span>Working</span><span>CF Target</span>
                  </div>
                  {report.utilization.map((u,i)=>{
                    const avail=Math.max(u.working_hours-u.holiday_hours-u.loa_hours,0.01);
                    const cfTotal=Number(u.billable_hours)+Number(u.non_billable_cf_hours)+Number(u.ramp_credit);
                    const cfUtil=Math.round((cfTotal/avail)*100);
                    const color=cfUtil>=(u.cf_target||75)?P.grn:cfUtil>=(u.cf_target||75)*0.85?P.amber:P.red;
                    return(
                      <div key={i} style={{display:"grid",gridTemplateColumns:"1fr .8fr .8fr .8fr .8fr .8fr",gap:4,fontSize:12.5,padding:"6px 0",borderBottom:`1px solid ${P.bfaint}`,alignItems:"center"}}>
                        <span style={{color:P.txt}}>{u.week_of}</span>
                        <span style={{color:P.txt}}>{u.billable_hours}h</span>
                        <span style={{color:P.txt}}>{u.non_billable_cf_hours}h</span>
                        <span style={{color:P.txt}}>{u.ramp_credit}h</span>
                        <span style={{color:P.txt}}>{u.working_hours}h</span>
                        <span style={{fontWeight:500,color}}>{cfUtil}% / {u.cf_target}%</span>
                      </div>
                    );
                  })}
                </div>
              :<div style={{padding:"10px 0",color:P.muted,fontSize:13}}>No utilization entries yet.</div>}
          </Section>

          <Section id="projects" title="Weekly Tracker Projects" badge={report.projects?.length||0}>
            {report.projects?.length>0
              ?<div style={{paddingTop:10,display:"flex",flexDirection:"column",gap:4}}>
                  {report.projects.map((pr,i)=>(
                    <div key={i} style={{fontSize:12.5,padding:"5px 0",borderBottom:`1px solid ${P.bfaint}`}}>
                      <div style={{display:"flex",justifyContent:"space-between"}}>
                        <span style={{fontWeight:600,color:P.txt}}>{pr.project_name}</span>
                        <span style={{color:P.muted}}>{pr.hrs_per_week}h/wk</span>
                      </div>
                      <div style={{fontSize:11.5,color:P.muted}}>{pr.project_type} · {pr.health_status}</div>
                    </div>
                  ))}
                </div>
              :<div style={{padding:"10px 0",color:P.muted,fontSize:13}}>No projects logged.</div>}
          </Section>

          {/* Raw JSON dump for debugging */}
          <Section id="raw" title="Raw JSON (for debugging)">
            <pre style={{fontSize:10.5,color:P.muted,background:P.surface,padding:"12px",borderRadius:8,overflowX:"auto",maxHeight:400,marginTop:10}}>
              {JSON.stringify(report,null,2)}
            </pre>
          </Section>
        </div>
      )}
    </div>
  );
}

// ── LangGraph Agents Status Card (Admin → Integrations) ─────────────────────
function LangGraphStatusCard(){
  const [status,setStatus]=useState(null);
  const [loading,setLoading]=useState(true);
  const load=()=>{
    setLoading(true);
    fetch(`${BACKEND}/api/agents/status`)
      .then(r=>r.json()).then(d=>{setStatus(d);setLoading(false);})
      .catch(()=>{setStatus({langgraph_available:false,agents_ready:0,graphs_compiled:[],total_agents:8});setLoading(false);});
  };
  useEffect(()=>{load();},[]);
  const ALL_AGENTS=["socratic","reasoning","curriculum","advisor","capstone","practice","flashcard","rag"];
  const AGENT_LABELS={socratic:"Socratic Agent",reasoning:"Reasoning (AI Tutor)",curriculum:"Curriculum Agent",
    advisor:"AI Advisor",capstone:"Capstone Agent",practice:"Practice Scenarios",flashcard:"Flashcards",rag:"RAG / Knowledge Base"};
  const compiled=new Set(status?.graphs_compiled||[]);
  return(
    <Card style={{padding:20,marginTop:16,borderTop:`3px solid ${status?.langgraph_available?P.purple:P.border}`}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <StatusDot ok={!!status?.langgraph_available}/>
          <span style={{fontSize:14,fontWeight:500,color:P.txt}}>LangGraph Agentic Framework</span>
          {status?.langgraph_available&&<span style={{background:P.purpleBg,color:P.purple,borderRadius:4,fontSize:10,fontWeight:500,padding:"2px 8px"}}>{status.agents_ready}/{status.total_agents||8} agents ready</span>}
          {status?.engine&&<span style={{background:P.surface,color:P.muted,borderRadius:4,fontSize:10,padding:"2px 8px",border:`1px solid ${P.border}`,marginLeft:4}}>{status.engine}</span>}
        </div>
        <button onClick={load} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:6,padding:"3px 10px",fontSize:11,cursor:"pointer",color:P.muted,fontFamily:"inherit"}}>↻ Refresh</button>
      </div>
      {loading&&<div style={{fontSize:12.5,color:P.muted}}>Checking backend…</div>}
      {!loading&&!status?.langgraph_available&&(
        <div style={{background:P.amberBg,border:`1px solid ${P.amber}30`,borderRadius:9,padding:"10px 14px",marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:600,color:P.amber,marginBottom:3}}>Agents not compiled</div>
          <div style={{fontSize:12,color:P.muted}}>The backend may not be running. Start it with: <code style={{background:P.surface,borderRadius:3,padding:"0 5px",fontSize:11,fontFamily:"ui-monospace,monospace"}}>uvicorn main:app --reload</code></div>
        </div>
      )}
      {!loading&&status?.langgraph_available&&(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
          {ALL_AGENTS.map(a=>{
            const ready=compiled.has(a);
            return(
              <div key={a} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",
                background:ready?P.purpleBg:P.surface,border:`1px solid ${ready?P.purple+"30":P.border}`,borderRadius:8}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:ready?P.purple:P.dim,flexShrink:0}}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:12.5,fontWeight:ready?600:400,color:ready?P.txt:P.muted}}>{AGENT_LABELS[a]}</div>
                  <div style={{fontSize:10.5,color:ready?P.purple:P.dim}}>{ready?"Graph compiled · multi-step":"Not compiled"}</div>
                </div>
                <span style={{fontSize:11,fontWeight:500,color:ready?P.purple:P.dim}}>{ready?"✓":"–"}</span>
              </div>
            );
          })}
        </div>
      )}
      {status?.provider_order&&(
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 0",borderTop:`1px solid ${P.bfaint}`,marginTop:4,flexWrap:"wrap"}}>
          <span style={{fontSize:11,fontWeight:600,color:P.dim,textTransform:"uppercase",letterSpacing:.4}}>Provider order</span>
          {status.provider_order.map((p,i)=>{
            const configured=!!status.provider_keys_configured?.[p];
            const label={openai:"OpenAI",anthropic:"Anthropic (Claude)",groq:"Groq"}[p]||p;
            return(
              <span key={p} style={{display:"flex",alignItems:"center",gap:6}}>
                {i>0&&<span style={{color:P.dim,fontSize:11}}>→</span>}
                <span style={{fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:5,background:configured?P.grnBg:P.redBg,color:configured?P.grn:P.red}}>{label}{configured?"":" (no key)"}</span>
              </span>
            );
          })}
        </div>
      )}
      <div style={{fontSize:11.5,color:P.dim,borderTop:`1px solid ${P.bfaint}`,paddingTop:10,marginTop:4}}>
        Each compiled graph: <strong>init → retrieve context → generate → quality judge → [retry up to 2×]</strong>.
        Endpoint: <code style={{background:P.surface,borderRadius:3,padding:"1px 5px",fontSize:11}}>GET /api/agents/status</code>
      </div>
    </Card>
  );
}

// ── UploadModeToggle — "Add & update" (merge, default) vs "Overwrite all"
// (wipe the table clean, then import) — same two-option pattern on every
// upload page (User Provisioning, Tracker Import, Certification Import).
function UploadModeToggle({mode,setMode}){
  return(
    <div style={{display:"inline-flex",border:`1px solid ${P.border}`,borderRadius:8,overflow:"hidden",marginBottom:14}}>
      {[["merge","Add & update"],["overwrite","Overwrite all"]].map(([v,label])=>(
        <button key={v} onClick={()=>setMode(v)} type="button"
          style={{padding:"7px 14px",fontSize:12.5,fontWeight:600,border:"none",cursor:"pointer",fontFamily:"inherit",
            background:mode===v?P.blue:"transparent",color:mode===v?"#fff":P.txt}}>
          {label}
        </button>
      ))}
    </div>
  );
}

// ── DangerZoneWipe — hard-reset control, reused across admin data pages ───────
// Requires typing DELETE (not just a browser confirm()) before the button
// even becomes clickable, since these calls permanently drop entire tables.
function DangerZoneWipe({title,description,endpoint,onDone}){
  const [confirmText,setConfirmText]=useState("");
  const [wiping,setWiping]=useState(false);
  const [result,setResult]=useState(null);

  const doWipe=async()=>{
    if(confirmText!=="DELETE")return;
    if(!window.confirm(`${title} — this permanently deletes everything and cannot be undone. Continue?`))return;
    setWiping(true);setResult(null);
    try{
      const res=await fetch(`${BACKEND}${endpoint}?confirm=WIPE`,{method:"DELETE",credentials:"include"});
      const d=await res.json().catch(()=>({}));
      if(!res.ok){setResult({ok:false,error:d.detail||"Failed to delete."});}
      else{setResult({ok:true,...d});setConfirmText("");onDone&&onDone(d);}
    }catch(ex){setResult({ok:false,error:"Could not reach the server."});}
    finally{setWiping(false);}
  };

  return(
    <Card style={{padding:"18px 20px",border:`1px solid ${P.red}30`,background:P.redLt}}>
      <div style={{fontSize:14,fontWeight:600,color:P.red,marginBottom:4}}>Danger zone — {title}</div>
      <div style={{fontSize:12,color:P.txt,marginBottom:12}}>{description}</div>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <input value={confirmText} onChange={e=>setConfirmText(e.target.value)}
          placeholder="Type DELETE to confirm"
          style={{border:`1px solid ${P.border}`,borderRadius:8,padding:"7px 11px",fontSize:13,
            color:P.txt,background:"#fff",outline:"none",width:200,fontFamily:"inherit"}}/>
        <button onClick={doWipe} disabled={confirmText!=="DELETE"||wiping}
          style={{background:confirmText==="DELETE"?P.red:P.muted,color:"#fff",border:"none",borderRadius:8,
            padding:"8px 16px",fontSize:13,fontWeight:600,
            cursor:confirmText==="DELETE"&&!wiping?"pointer":"not-allowed",fontFamily:"inherit"}}>
          {wiping?"Deleting…":"Delete everything"}
        </button>
      </div>
      {result&&(
        <div style={{fontSize:12,color:result.ok?P.grn:P.red,marginTop:10}}>
          {result.ok
            ? `✓ Deleted. ${Object.entries(result).filter(([k])=>k!=="ok").map(([k,v])=>`${k.replace(/_/g," ")}: ${v}`).join(" · ")}`
            : `✗ ${result.error}`}
        </div>
      )}
    </Card>
  );
}

// ── Admin: All Users table ─────────────────────────────────────────────────────
// ── Admin: HR directory provisioning (Excel upload + audit) ──────────────────
function DirectoryTab(){
  const [dir,setDir]=useState([]);
  const [batches,setBatches]=useState([]);
  const [loading,setLoading]=useState(true);
  const [uploading,setUploading]=useState(false);
  const [result,setResult]=useState(null);   // {inserted,updated,deactivated,reactivated,...}
  const [errs,setErrs]=useState([]);
  const [filter,setFilter]=useState("active");// active|inactive|all
  const [search,setSearch]=useState("");
  const [openBatch,setOpenBatch]=useState(null);
  const [drag,setDrag]=useState(false);
  const [mode,setMode]=useState("merge"); // merge | overwrite
  const fileRef=useRef(null);

  const loadDir=()=>{
    const qs=new URLSearchParams();
    if(filter==="active")qs.set("active","true");
    if(filter==="inactive")qs.set("active","false");
    if(search.trim())qs.set("q",search.trim());
    fetch(`${BACKEND}/api/admin/directory?${qs.toString()}`).then(r=>r.json())
      .then(d=>{setDir(d?.employees||[]);setLoading(false);}).catch(()=>setLoading(false));
  };
  const loadBatches=()=>fetch(`${BACKEND}/api/admin/directory/batches`).then(r=>r.json())
    .then(d=>setBatches(d?.batches||[])).catch(()=>{});
  useEffect(()=>{loadDir();loadBatches();},[]);           // eslint-disable-line
  useEffect(()=>{loadDir();},[filter]);                    // eslint-disable-line

  const doUpload=async(f)=>{
    if(!f)return;
    if(!f.name.toLowerCase().endsWith(".xlsx")){setErrs(["Please choose a .xlsx file."]);setResult(null);return;}
    if(mode==="overwrite"){
      if(!window.confirm("Overwrite mode: this deletes the entire existing HR roster before importing. Continue?"))return;
      setUploading(true);setResult(null);setErrs([]);
      try{
        const wr=await fetch(`${BACKEND}/api/admin/directory/wipe?confirm=WIPE`,{method:"DELETE",credentials:"include"});
        if(!wr.ok){setErrs(["Could not clear the existing roster — import cancelled."]);setUploading(false);return;}
      }catch{setErrs(["Could not reach the server."]);setUploading(false);return;}
    } else {
      setUploading(true);setResult(null);setErrs([]);
    }
    try{
      const fd=new FormData();fd.append("file",f);
      const r=await fetch(`${BACKEND}/api/admin/directory/upload`,{method:"POST",body:fd,credentials:"include"});
      const d=await r.json().catch(()=>({}));
      if(!r.ok){
        const det=d.detail;
        if(det&&typeof det==="object")setErrs([det.message,...(det.errors||[])].filter(Boolean));
        else setErrs([det||`Upload failed (${r.status}).`]);
      }else{setResult(d);loadDir();loadBatches();}
    }catch{setErrs(["Could not reach the server."]);}
    setUploading(false);
  };
  const onFile=e=>{const f=e.target.files?.[0];doUpload(f);e.target.value="";};
  const onDrop=e=>{e.preventDefault();setDrag(false);doUpload(e.dataTransfer.files?.[0]);};
  const viewBatch=async(id)=>{
    const d=await fetch(`${BACKEND}/api/admin/directory/batches/${id}`).then(r=>r.json()).catch(()=>null);
    if(d)setOpenBatch(d);
  };

  const SUM=[
    {k:"inserted",label:"Added",color:P.grn},
    {k:"updated",label:"Updated",color:P.blue},
    {k:"reactivated",label:"Reactivated",color:P.amber},
    {k:"deactivated",label:"Deactivated",color:P.red},
  ];

  return(
    <div style={{maxWidth:980,margin:"0 auto",padding:"20px 24px"}}>
      <div style={{marginBottom:6}}>
        <div style={{fontSize:16,fontWeight:500,color:P.txt}}>User Provisioning</div>
        <div style={{fontSize:12.5,color:P.muted,marginBottom:10}}>
          <b>Add & update:</b> existing people are updated, new people added, anyone missing from the file is deactivated (not deleted) — all changes are logged.<br/>
          <b>Overwrite all:</b> the entire existing roster is permanently deleted first, then this file is imported fresh.
        </div>
        <UploadModeToggle mode={mode} setMode={setMode}/>
      </div>

      {/* Upload drop zone */}
      <div onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={onDrop}
        style={{border:`1.5px dashed ${drag?P.blue:P.border}`,borderRadius:12,padding:"22px 20px",textAlign:"center",
          background:drag?P.blueGh:P.panel,transition:"all .15s",marginTop:12,marginBottom:14}}>
        <input ref={fileRef} type="file" accept=".xlsx" onChange={onFile} style={{display:"none"}}/>
        <div style={{fontSize:13,color:P.muted,marginBottom:10}}>
          {uploading?"Uploading & applying…":"Drag an .xlsx roster here, or"}
        </div>
        <button onClick={()=>fileRef.current?.click()} disabled={uploading}
          style={{background:P.blue,color:"#fff",border:"none",borderRadius:8,padding:"9px 20px",fontSize:13,fontWeight:600,cursor:uploading?"default":"pointer",fontFamily:"inherit",opacity:uploading?.6:1}}>
          {uploading?"Working…":"Choose Excel file"}
        </button>
        <div style={{fontSize:11,color:P.dim,marginTop:10}}>Expected columns: Email, Firstname, Lastname, DateofJoining, Role, Location, Manager, Manager Email, Team, Primary Skill, Resource Email</div>
      </div>

      {/* Result summary */}
      {result&&<Card style={{padding:"14px 18px",marginBottom:14,borderColor:P.grn+"55"}}>
        <div style={{fontSize:13,fontWeight:600,color:P.grn,marginBottom:8}}>✓ Applied “{result.filename}” · {result.row_count} rows (batch #{result.batch_id})</div>
        <div style={{display:"flex",gap:18,flexWrap:"wrap"}}>
          {SUM.map(s=>(
            <div key={s.k} style={{minWidth:78}}>
              <div style={{fontSize:20,fontWeight:600,color:s.color}}>{result[s.k]??0}</div>
              <div style={{fontSize:11,color:P.dim}}>{s.label}</div>
            </div>
          ))}
        </div>
      </Card>}

      {/* Validation errors */}
      {errs.length>0&&<Card style={{padding:"14px 18px",marginBottom:14,borderColor:P.red+"55",background:P.redBg+"55"}}>
        <div style={{fontSize:13,fontWeight:600,color:P.red,marginBottom:6}}>Upload rejected — no changes were made</div>
        <ul style={{margin:0,paddingLeft:18}}>
          {errs.slice(0,20).map((e,i)=><li key={i} style={{fontSize:12,color:P.txt,marginBottom:2}}>{e}</li>)}
        </ul>
      </Card>}

      {/* Directory table */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",margin:"18px 0 10px",flexWrap:"wrap",gap:10}}>
        <div style={{fontSize:14,fontWeight:500,color:P.txt}}>Directory <span style={{fontSize:12,color:P.dim}}>({dir.length})</span></div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>e.key==="Enter"&&loadDir()}
            placeholder="Search name, email, team…" style={{border:`1px solid ${P.border}`,borderRadius:8,padding:"7px 12px",fontSize:13,color:P.txt,background:P.bg,outline:"none",width:210}}/>
          {["active","inactive","all"].map(f=>(
            <button key={f} onClick={()=>setFilter(f)} style={{padding:"6px 12px",borderRadius:20,fontSize:12,fontWeight:filter===f?600:400,cursor:"pointer",fontFamily:"inherit",
              background:filter===f?P.blue:"transparent",color:filter===f?"#fff":P.muted,border:`1px solid ${filter===f?P.blue:P.border}`}}>
              {f[0].toUpperCase()+f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {loading&&<div style={{padding:"28px 0",textAlign:"center",color:P.muted,fontSize:13}}>Loading directory…</div>}
      {!loading&&dir.length===0&&<div style={{padding:"28px 0",textAlign:"center",color:P.muted,fontSize:13}}>No employees yet — upload a roster to get started.</div>}
      {!loading&&dir.length>0&&(
        <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden"}}>
          <div style={{display:"grid",gridTemplateColumns:"1.2fr 1.5fr 0.8fr 1.2fr 0.8fr 0.6fr",gap:0,padding:"9px 16px",background:P.surface,borderBottom:`1px solid ${P.border}`,fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.4,textTransform:"uppercase"}}>
            <span>Name</span><span>Email</span><span>Team</span><span>Manager</span><span>Joined</span><span>Status</span>
          </div>
          {dir.map((e,idx)=>(
            <div key={e.email} style={{display:"grid",gridTemplateColumns:"1.2fr 1.5fr 0.8fr 1.2fr 0.8fr 0.6fr",gap:0,padding:"10px 16px",borderBottom:idx<dir.length-1?`1px solid ${P.bfaint}`:"none",alignItems:"center",opacity:e.is_active?1:.55}}>
              <div style={{fontSize:13,fontWeight:600,color:P.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{[e.first_name,e.last_name].filter(Boolean).join(" ")||"—"}<div style={{fontSize:11,color:P.dim,fontWeight:400}}>{e.role||"—"}</div></div>
              <div style={{fontSize:12,color:P.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",paddingRight:8}}>{e.email}</div>
              <div style={{fontSize:12.5,color:P.txt}}>{e.team||"—"}</div>
              <div style={{fontSize:12,color:P.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.manager_name||"—"}</div>
              <div style={{fontSize:12,color:P.txt}}>{e.doj||"—"}</div>
              <div><span style={{fontSize:11,fontWeight:500,color:e.is_active?P.grn:P.red,background:e.is_active?P.grnBg:P.redBg,borderRadius:5,padding:"3px 9px"}}>{e.is_active?"Active":"Inactive"}</span></div>
            </div>
          ))}
        </div>
      )}

      {/* Upload history / audit */}
      <div style={{fontSize:14,fontWeight:500,color:P.txt,margin:"22px 0 10px"}}>Upload History</div>
      {batches.length===0&&<div style={{fontSize:12.5,color:P.muted}}>No uploads yet.</div>}
      {batches.map(b=>(
        <Card key={b.id} style={{padding:"12px 16px",marginBottom:8}}>
          <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <div style={{flex:1,minWidth:180}}>
              <div style={{fontSize:13,fontWeight:600,color:P.txt}}>#{b.id} · {b.filename}</div>
              <div style={{fontSize:11,color:P.dim}}>{b.uploaded_at?.slice(0,19).replace("T"," ")} · by {b.uploaded_by} · {b.row_count} rows</div>
            </div>
            <div style={{display:"flex",gap:10,fontSize:11.5}}>
              <span style={{color:P.grn}}>+{b.n_insert}</span>
              <span style={{color:P.blue}}>~{b.n_update}</span>
              <span style={{color:P.amber}}>↑{b.n_reactivate}</span>
              <span style={{color:P.red}}>−{b.n_deactivate}</span>
            </div>
            <button onClick={()=>viewBatch(b.id)} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:7,padding:"5px 12px",fontSize:11.5,cursor:"pointer",color:P.muted,fontFamily:"inherit"}}>View changes</button>
          </div>
          {openBatch&&openBatch.batch&&openBatch.batch.id===b.id&&(
            <div style={{marginTop:10,borderTop:`1px solid ${P.bfaint}`,paddingTop:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{fontSize:11.5,fontWeight:600,color:P.dim}}>{openBatch.changes.length} change record(s)</div>
                <button onClick={()=>setOpenBatch(null)} style={{background:"none",border:"none",color:P.muted,cursor:"pointer",fontSize:12,fontFamily:"inherit"}}>Close ✕</button>
              </div>
              {openBatch.changes.length===0&&<div style={{fontSize:12,color:P.muted}}>No field changes recorded (all rows unchanged).</div>}
              {openBatch.changes.slice(0,200).map(c=>(
                <div key={c.id} style={{fontSize:11.5,color:P.txt,padding:"3px 0",display:"flex",gap:8}}>
                  <span style={{fontWeight:600,minWidth:150,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.email}</span>
                  <span style={{color:c.change_type==="insert"?P.grn:c.change_type==="deactivate"?P.red:c.change_type==="reactivate"?P.amber:P.blue,minWidth:80}}>{c.change_type}</span>
                  <span style={{color:P.muted}}>{c.field_name?`${c.field_name}: ${c.old_value||"∅"} → ${c.new_value||"∅"}`:""}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}

      <div style={{marginTop:20}}>
        <DangerZoneWipe title="Wipe HR roster"
          description="Permanently deletes every employee record, the change log, and all upload batch history. Use this for a clean-slate re-import."
          endpoint="/api/admin/directory/wipe"
          onDone={()=>{loadDir();loadBatches();}}/>
      </div>
    </div>
  );
}

function AllUsersTab(){
  const [users,setUsers]=useState([]);
  const [loading,setLoading]=useState(true);
  const [search,setSearch]=useState("");
  const [filter,setFilter]=useState("all"); // all|pending|approved|declined
  const [actionId,setActionId]=useState(null); // id being acted on

  const load=()=>{
    setLoading(true);
    fetch(`${BACKEND}/api/admin/users`)
      .then(r=>r.json()).then(d=>{setUsers(d?.users||[]);setLoading(false);})
      .catch(()=>setLoading(false));
  };
  useEffect(()=>{load();},[]);

  const setStatus=async(id,status)=>{
    setActionId(id);
    await fetch(`${BACKEND}/api/admin/users/${id}/status`,{
      method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({status})}).catch(()=>{});
    setUsers(prev=>prev.map(u=>u.id===id?{...u,status}:u));
    setActionId(null);
  };

  const deleteUser=async(id,name)=>{
    if(!window.confirm(`Delete ${name}? This cannot be undone.`))return;
    await fetch(`${BACKEND}/api/admin/users/${id}`,{method:"DELETE"}).catch(()=>{});
    setUsers(prev=>prev.filter(u=>u.id!==id));
  };

  const STATUS_COLOR={
    approved:{bg:P.grnBg,  color:P.grn,  label:"Approved"},
    pending: {bg:P.amberBg,color:P.amber,label:"Pending"},
    declined:{bg:P.redBg,  color:P.red,  label:"Declined"},
  };
  const TRACK_LABEL={"rtcdp":"RTCDP","analytics":"Analytics","ajo":"AJO","cja":"CJA"};

  const visible=users
    .filter(u=>filter==="all"||u.status===filter)
    .filter(u=>{
      const q=search.toLowerCase();
      return !q||u.name?.toLowerCase().includes(q)||u.email?.toLowerCase().includes(q)||u.team?.toLowerCase().includes(q);
    });

  const counts={all:users.length,pending:users.filter(u=>u.status==="pending").length,
    approved:users.filter(u=>u.status==="approved").length,declined:users.filter(u=>u.status==="declined").length};

  return(
    <div style={{maxWidth:980,margin:"0 auto",padding:"20px 24px"}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:16,fontWeight:500,color:P.txt}}>All Users</div>
          <div style={{fontSize:12.5,color:P.muted}}>{users.length} registered account{users.length!==1?"s":""}</div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Search name, email, team…"
            style={{border:`1px solid ${P.border}`,borderRadius:8,padding:"7px 12px",fontSize:13,color:P.txt,background:P.bg,outline:"none",width:220}}/>
          <button onClick={load} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:7,padding:"7px 12px",fontSize:12,cursor:"pointer",color:P.muted,fontFamily:"inherit"}}>↻ Refresh</button>
        </div>
      </div>

      {/* Filter pills */}
      <div style={{display:"flex",gap:7,marginBottom:16}}>
        {["all","pending","approved","declined"].map(f=>(
          <button key={f} onClick={()=>setFilter(f)}
            style={{padding:"5px 14px",borderRadius:20,fontSize:12,fontWeight:filter===f?600:400,cursor:"pointer",fontFamily:"inherit",
              background:filter===f?(f==="all"?P.blue:f==="pending"?P.amber:f==="approved"?P.grn:P.red):"transparent",
              color:filter===f?"#fff":(f==="pending"?P.amber:f==="approved"?P.grn:f==="declined"?P.red:P.muted),
              border:`1px solid ${filter===f?(f==="all"?P.blue:f==="pending"?P.amber:f==="approved"?P.grn:P.red):P.border}`}}>
            {f.charAt(0).toUpperCase()+f.slice(1)} ({counts[f]})
          </button>
        ))}
      </div>

      {loading&&<div style={{padding:"32px 0",textAlign:"center",color:P.muted,fontSize:13}}>Loading users…</div>}
      {!loading&&visible.length===0&&<div style={{padding:"32px 0",textAlign:"center",color:P.muted,fontSize:13}}>No users match this filter.</div>}

      {!loading&&visible.length>0&&(
        <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden"}}>
          {/* Table header */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1.4fr 0.8fr 0.8fr 0.7fr 0.6fr 0.7fr auto",
            gap:0,padding:"9px 16px",background:P.surface,borderBottom:`1px solid ${P.border}`,
            fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.4,textTransform:"uppercase"}}>
            <span>Name</span><span>Email</span><span>Team</span><span>Track</span>
            <span>Modules</span><span>Points</span><span>Status</span><span>Actions</span>
          </div>
          {/* Rows */}
          {visible.map((u,idx)=>{
            const sc=STATUS_COLOR[u.status]||STATUS_COLOR.pending;
            const isActing=actionId===u.id;
            return(
              <div key={u.id} style={{display:"grid",
                gridTemplateColumns:"1fr 1.4fr 0.8fr 0.8fr 0.7fr 0.6fr 0.7fr auto",
                gap:0,padding:"11px 16px",
                borderBottom:idx<visible.length-1?`1px solid ${P.bfaint}`:"none",
                alignItems:"center",opacity:isActing?.6:1,transition:"opacity .15s"}}>

                {/* Name */}
                <div style={{minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:P.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {u.preferred_name||u.name}
                  </div>
                  <div style={{fontSize:11,color:P.dim}}>{u.role||"—"} · {u.joining_date?.slice(0,10)||"—"}</div>
                </div>

                {/* Email */}
                <div style={{fontSize:12,color:P.muted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",paddingRight:8}}>
                  {u.email}
                </div>

                {/* Team */}
                <div style={{fontSize:12.5,color:P.txt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                  {u.team||"—"}
                </div>

                {/* Track */}
                <div>
                  <span style={{fontSize:11,fontWeight:600,color:P.blue,background:P.blueGh,borderRadius:5,padding:"2px 7px"}}>
                    {TRACK_LABEL[u.active_track]||u.active_track||"RTCDP"}
                  </span>
                </div>

                {/* Modules done */}
                <div style={{fontSize:13,color:P.txt,fontWeight:600}}>
                  {u.modules_done||0}
                  {u.capstone_completed&&<span style={{marginLeft:5,fontSize:10.5,color:P.grn}}>✓ cap</span>}
                </div>

                {/* Points */}
                <div style={{fontSize:13,fontWeight:600,color:P.purple}}>
                  {u.total_points||0}
                </div>

                {/* Status badge */}
                <div>
                  <span style={{fontSize:11,fontWeight:500,color:sc.color,background:sc.bg,
                    borderRadius:5,padding:"3px 9px",whiteSpace:"nowrap"}}>
                    {sc.label}
                  </span>
                </div>

                {/* Actions */}
                <div style={{display:"flex",gap:5,flexShrink:0}}>
                  {u.status==="pending"&&<>
                    <button onClick={()=>setStatus(u.id,"approved")} disabled={isActing}
                      style={{background:P.grn,color:"#fff",border:"none",borderRadius:6,padding:"4px 10px",fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
                      ✓ Approve
                    </button>
                    <button onClick={()=>setStatus(u.id,"declined")} disabled={isActing}
                      style={{background:"transparent",border:`1px solid ${P.red}`,color:P.red,borderRadius:6,padding:"4px 10px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>
                      Decline
                    </button>
                  </>}
                  {u.status==="approved"&&
                    <button onClick={()=>setStatus(u.id,"pending")} disabled={isActing}
                      style={{background:"transparent",border:`1px solid ${P.border}`,color:P.muted,borderRadius:6,padding:"4px 10px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>
                      Revoke
                    </button>}
                  <button onClick={()=>deleteUser(u.id,u.name)} disabled={isActing}
                    style={{background:"transparent",border:`1px solid ${P.border}`,color:P.dim,borderRadius:6,padding:"4px 8px",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}>
                    🗑
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Summary strip */}
      {!loading&&users.length>0&&(
        <div style={{display:"flex",gap:20,marginTop:16,padding:"12px 16px",background:P.panel,border:`1px solid ${P.border}`,borderRadius:10}}>
          {[
            {l:"Total registered",v:users.length},
            {l:"Pending approval",v:counts.pending,c:counts.pending>0?P.amber:P.muted},
            {l:"Active learners",v:counts.approved,c:P.grn},
            {l:"Total modules done",v:users.reduce((s,u)=>s+(u.modules_done||0),0)},
            {l:"Total points awarded",v:users.reduce((s,u)=>s+(u.total_points||0),0)},
            {l:"Capstones complete",v:users.filter(u=>u.capstone_completed).length,c:P.purple},
          ].map(s=>(
            <div key={s.l} style={{textAlign:"center"}}>
              <div style={{fontSize:18,fontWeight:500,color:s.c||P.txt}}>{s.v}</div>
              <div style={{fontSize:10.5,color:P.muted}}>{s.l}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ProfileCertList — live multi-cert display for ProfileCard ─────────────────
function ProfileCertList({userId,email,certFallback,certStatusFallback,certExpFallback}){
  const [liveCerts,setLiveCerts]=useState(null);
  useEffect(()=>{
    if(!userId&&!email)return;
    const q=userId?`user_id=${userId}`:`email=${encodeURIComponent(email)}`;
    fetch(`${BACKEND}/api/certs/my?${q}`,{credentials:"include"})
      .then(r=>r.json()).then(d=>setLiveCerts(d.certs||[])).catch(()=>{});
  },[userId,email]);

  const certsToShow=liveCerts!==null?liveCerts
    :(certFallback&&certFallback!=="—"?[{cert_name:certFallback,status:certStatusFallback,expiry_date:certExpFallback,days_remaining:null}]:[]);

  const statusColor=s=>s==="Active"?P.grn:s==="Renew Soon"||s==="Expired"?P.amber:P.blue;
  const statusBg   =s=>s==="Active"?P.grnBg:s==="Renew Soon"||s==="Expired"?P.amberBg:P.blueGh;

  return(<>
    <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:10}}>Certifications</div>
    {certsToShow.length===0
      ?<div style={{fontSize:12.5,color:P.muted,padding:"8px 0"}}>No certifications on record.</div>
      :certsToShow.map((c,i)=>{
        const st=c.status||"Active";
        return(
          <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 14px",
            background:statusBg(st),border:`1px solid ${statusColor(st)}30`,borderRadius:10,marginBottom:i<certsToShow.length-1?8:0}}>
            <span style={{fontSize:18}}>🎖</span>
            <div style={{flex:1}}>
              <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:2}}>{c.cert_name}</div>
              <div style={{fontSize:11.5,color:P.muted}}>
                {c.cert_type&&<span>{c.cert_type} · </span>}
                {c.expiry_date?`Expires ${c.expiry_date}`:"No expiry recorded"}
                {c.days_remaining!=null&&` · `}
                {c.days_remaining!=null&&<span style={{fontWeight:600,color:c.days_remaining<90?P.amber:P.muted}}>{c.days_remaining}d remaining</span>}
              </div>
            </div>
            <span style={{fontSize:11.5,fontWeight:600,color:statusColor(st),background:statusBg(st),
              borderRadius:6,padding:"3px 10px",border:`1px solid ${statusColor(st)}30`}}>{st}</span>
          </div>
        );
      })
    }
  </>);
}

// ── AdminCertsUpload — Admin → Certifications tab ─────────────────────────────
// ── AdminTrackerImport — Admin → Tracker Import tab ──────────────────────────
// ── Admin — Learning Tracks (dynamic track config the Reasoning agent reads) ──
// Previously there was no UI at all for POST/GET /api/admin/tracks — adding a
// track meant nothing happened because nothing on the frontend ever called the
// endpoint. Requires a real IMS admin session (not the demo login picker) since
// the backend gates writes with require_persona("admin").
function AdminReasoningConfig(){
  // ── #1 track management state ──
  const [tracks,setTracks]=useState([]);
  const [tkLoading,setTkLoading]=useState(false);
  const [tkMsg,setTkMsg]=useState(null);
  const blankForm={track_code:"",label:"",keywords:"",grounding_terms:"",active:true,sort_order:0};
  const [form,setForm]=useState(blankForm);
  const [saving,setSaving]=useState(false);

  const loadTracks=()=>{
    setTkLoading(true);
    fetch(`${BACKEND}/api/admin/tracks`,{credentials:"include"})
      .then(r=>r.ok?r.json():{tracks:[]})
      .then(d=>setTracks(d?.tracks||[]))
      .catch(()=>setTracks([]))
      .finally(()=>setTkLoading(false));
  };
  useEffect(()=>{loadTracks();},[]);

  const editTrack=t=>setForm({
    track_code:t.track_code,label:t.label,
    keywords:(t.keywords||[]).join(", "),
    grounding_terms:(t.grounding_terms||[]).join(", "),
    active:t.active!==false,sort_order:t.sort_order||0,
  });

  const saveTrack=async()=>{
    const code=form.track_code.trim().toLowerCase();
    if(!code||!form.label.trim()){setTkMsg({ok:false,text:"track_code and label are required."});return;}
    setSaving(true);setTkMsg(null);
    try{
      const body={
        track_code:code,label:form.label.trim(),
        keywords:form.keywords.split(",").map(s=>s.trim()).filter(Boolean),
        grounding_terms:form.grounding_terms.split(",").map(s=>s.trim()).filter(Boolean),
        active:!!form.active,sort_order:Number(form.sort_order)||0,
      };
      const r=await fetch(`${BACKEND}/api/admin/tracks`,{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      const d=await r.json().catch(()=>({}));
      if(!r.ok){setTkMsg({ok:false,text:d.detail||`Save failed (${r.status})`});return;}
      setTkMsg({ok:true,text:`Saved “${code}”. The reasoning agent picks it up within its cache TTL — no restart needed.`});
      setForm(blankForm);
      loadTracks();
    }catch(e){setTkMsg({ok:false,text:"Save failed — check backend connection."});}
    finally{setSaving(false);}
  };

  // ── #4 mentor feedback state ──
  const [fbEmail,setFbEmail]=useState("");
  const [fbData,setFbData]=useState(null);
  const [fbLoading,setFbLoading]=useState(false);
  const [fbErr,setFbErr]=useState("");
  const lookupFeedback=async()=>{
    const email=fbEmail.trim().toLowerCase();
    if(!email){setFbErr("Enter a learner email.");return;}
    setFbLoading(true);setFbErr("");setFbData(null);
    try{
      const r=await fetch(`${BACKEND}/api/admin/learner-feedback/${encodeURIComponent(email)}`,{credentials:"include"});
      const d=await r.json().catch(()=>({}));
      if(!r.ok){setFbErr(d.detail||`Lookup failed (${r.status})`);return;}
      setFbData(d);
    }catch(e){setFbErr("Lookup failed — check backend connection.");}
    finally{setFbLoading(false);}
  };

  // ── Curriculum import state ──
  const [curFile,setCurFile]=useState(null);
  const [curUploading,setCurUploading]=useState(false);
  const [curResult,setCurResult]=useState(null);
  const [curErr,setCurErr]=useState("");
  const importCurriculum=async()=>{
    if(!curFile)return;
    setCurUploading(true);setCurErr("");setCurResult(null);
    try{
      const fd=new FormData();fd.append("file",curFile);
      const r=await fetch(`${BACKEND}/api/admin/curriculum/import`,{method:"POST",credentials:"include",body:fd});
      const d=await r.json().catch(()=>({}));
      if(!r.ok){setCurErr(d.detail||`Import failed (${r.status})`);return;}
      setCurResult(d);setCurFile(null);
    }catch(e){setCurErr("Import failed — check backend connection.");}
    finally{setCurUploading(false);}
  };

  const inp={width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:8,border:`1px solid ${P.border}`,background:P.panel,color:P.txt,fontSize:13,fontFamily:"inherit",outline:"none"};
  const lbl={fontSize:11.5,fontWeight:600,color:P.muted,marginBottom:5,display:"block"};

  return(
    <div style={{maxWidth:900,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:28}}>
      {/* ── #1 Track management ── */}
      <div>
        <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>Learning Tracks</div>
        <div style={{fontSize:13,color:P.muted}}>Add or edit the Adobe products the Reasoning agent treats as on-topic. A new track is a data row — no code change or restart. Keywords decide on-topic classification; grounding terms anchor answers to the track.</div>
      </div>

      <Card style={{padding:"18px 22px"}}>
        <div style={{fontSize:13,fontWeight:600,color:P.txt,marginBottom:14}}>{form.track_code&&tracks.some(t=>t.track_code===form.track_code.trim().toLowerCase())?"Edit track":"Add track"}</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          <div><label style={lbl}>Track code (lowercase id)</label><input style={inp} value={form.track_code} onChange={e=>setForm(f=>({...f,track_code:e.target.value}))} placeholder="e.g. marketo"/></div>
          <div><label style={lbl}>Label (display name)</label><input style={inp} value={form.label} onChange={e=>setForm(f=>({...f,label:e.target.value}))} placeholder="e.g. Adobe Marketo Engage"/></div>
          <div style={{gridColumn:"1 / -1"}}><label style={lbl}>Keywords (comma-separated → on-topic detection)</label><input style={inp} value={form.keywords} onChange={e=>setForm(f=>({...f,keywords:e.target.value}))} placeholder="lead scoring, nurture, smart list"/></div>
          <div style={{gridColumn:"1 / -1"}}><label style={lbl}>Grounding terms (comma-separated → anchor answers)</label><input style={inp} value={form.grounding_terms} onChange={e=>setForm(f=>({...f,grounding_terms:e.target.value}))} placeholder="lead scoring, nurture"/></div>
          <div><label style={lbl}>Sort order</label><input type="number" style={inp} value={form.sort_order} onChange={e=>setForm(f=>({...f,sort_order:e.target.value}))}/></div>
          <div style={{display:"flex",alignItems:"flex-end",gap:8}}>
            <label style={{display:"inline-flex",alignItems:"center",gap:7,fontSize:13,color:P.txt,cursor:"pointer"}}>
              <input type="checkbox" checked={form.active} onChange={e=>setForm(f=>({...f,active:e.target.checked}))}/> Active
            </label>
          </div>
        </div>
        <div style={{display:"flex",gap:8,marginTop:16,alignItems:"center"}}>
          <button onClick={saveTrack} disabled={saving} style={{background:saving?P.muted:P.grn,color:"#fff",border:"none",borderRadius:8,padding:"9px 20px",fontSize:13,fontWeight:600,cursor:saving?"not-allowed":"pointer",fontFamily:"inherit"}}>{saving?"Saving…":"Save track"}</button>
          {form!==blankForm&&<button onClick={()=>setForm(blankForm)} style={{background:"transparent",color:P.muted,border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 16px",fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>Clear</button>}
          {tkMsg&&<span style={{fontSize:12,color:tkMsg.ok?P.grn:P.red,lineHeight:1.4}}>{tkMsg.text}</span>}
        </div>
      </Card>

      <Card style={{padding:"4px 0"}}>
        {tkLoading?<div style={{padding:20,fontSize:13,color:P.muted}}>Loading tracks…</div>:
         tracks.length===0?<div style={{padding:20,fontSize:13,color:P.muted}}>No tracks configured yet.</div>:
         <table style={{width:"100%",borderCollapse:"collapse",fontSize:12.5}}>
           <thead><tr style={{textAlign:"left",color:P.dim,fontSize:11,textTransform:"uppercase"}}>
             <th style={{padding:"10px 16px"}}>Code</th><th style={{padding:"10px 16px"}}>Label</th>
             <th style={{padding:"10px 16px"}}>Keywords</th><th style={{padding:"10px 16px"}}>Active</th><th/>
           </tr></thead>
           <tbody>{tracks.map(t=>(
             <tr key={t.track_code} style={{borderTop:`1px solid ${P.border}`}}>
               <td style={{padding:"10px 16px",fontWeight:600,color:P.txt}}>{t.track_code}</td>
               <td style={{padding:"10px 16px",color:P.txt}}>{t.label}</td>
               <td style={{padding:"10px 16px",color:P.muted,maxWidth:280,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{(t.keywords||[]).join(", ")}</td>
               <td style={{padding:"10px 16px"}}>{t.active!==false?<span style={{color:P.grn}}>● active</span>:<span style={{color:P.dim}}>○ off</span>}</td>
               <td style={{padding:"10px 16px",textAlign:"right"}}><button onClick={()=>editTrack(t)} style={{fontSize:11.5,color:P.blue,background:"transparent",border:`1px solid ${P.border}`,borderRadius:6,padding:"3px 10px",cursor:"pointer",fontFamily:"inherit"}}>Edit</button></td>
             </tr>
           ))}</tbody>
         </table>}
      </Card>

      {/* ── Curriculum import ── */}
      <div style={{marginTop:8}}>
        <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>Curriculum Import</div>
        <div style={{fontSize:13,color:P.muted}}>Upload a module's topics from Excel — adding a new product's curriculum (e.g. Workfront) becomes a data upload, not a code change. Rows upsert on (track, module_id, topic_order), so re-uploading fixes a typo instead of duplicating. Study Aid & lesson pages read this immediately.</div>
      </div>
      <Card style={{padding:"18px 22px"}}>
        <div style={{fontSize:12.5,color:P.muted,lineHeight:1.7,marginBottom:14}}>
          <b>Required columns:</b> track, module_id, topic_order, title &nbsp;·&nbsp; <b>Optional:</b> objective, activity, output, checkpoint, video_title, video_duration, el_url<br/>
          Use the sheet named <b>Curriculum</b> (the template's Instructions sheet is skipped automatically). <code>objective</code> is what grounds Study Aid flashcards — fill it where you can.
        </div>
        <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
          <label style={{display:"inline-flex",alignItems:"center",gap:10,cursor:"pointer",background:P.blue,color:"#fff",borderRadius:8,padding:"9px 18px",fontSize:13,fontWeight:600}}>
            📎 Choose Excel file
            <input type="file" accept=".xlsx,.xls,.xlsm" style={{display:"none"}} onChange={e=>{setCurFile(e.target.files?.[0]||null);setCurResult(null);setCurErr("");}}/>
          </label>
          {curFile&&<span style={{fontSize:12.5,color:P.grn,fontWeight:600}}>📄 {curFile.name}</span>}
          {curFile&&<button onClick={importCurriculum} disabled={curUploading} style={{background:curUploading?P.muted:P.grn,color:"#fff",border:"none",borderRadius:8,padding:"9px 20px",fontSize:13,fontWeight:600,cursor:curUploading?"not-allowed":"pointer",fontFamily:"inherit"}}>{curUploading?"Importing…":"Import"}</button>}
        </div>
        {curErr&&<div style={{fontSize:12.5,color:P.red,marginTop:12}}>{curErr}</div>}
        {curResult&&<div style={{marginTop:14}}>
          <div style={{fontSize:13,color:P.grn,fontWeight:600,marginBottom:6}}>
            ✓ {curResult.inserted} inserted · {curResult.updated} updated · tracks: {(curResult.tracks||[]).join(", ")}
          </div>
          {curResult.warning&&<div style={{fontSize:12,color:P.amber,background:P.amberBg,borderRadius:6,padding:"8px 12px",marginBottom:8,lineHeight:1.5}}>⚠ {curResult.warning}</div>}
          {(curResult.row_errors||[]).length>0&&<div style={{fontSize:12,color:P.red,background:P.redBg,borderRadius:6,padding:"8px 12px",lineHeight:1.6}}>
            <b>{curResult.row_errors.length} row(s) skipped:</b><br/>{curResult.row_errors.slice(0,15).map((e,i)=><div key={i}>{e}</div>)}
          </div>}
        </div>}
      </Card>

      {/* ── #4 Mentor feedback insight ── */}
      <div style={{marginTop:8}}>
        <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>Learner Feedback Insight</div>
        <div style={{fontSize:13,color:P.muted}}>See what the agent's feedback-adaptation layer has learned from a learner's 👍/👎 history — and whether it's actively steering their answers.</div>
      </div>
      <Card style={{padding:"18px 22px"}}>
        <div style={{display:"flex",gap:8,alignItems:"flex-end",flexWrap:"wrap"}}>
          <div style={{flex:1,minWidth:220}}><label style={lbl}>Learner email</label>
            <input style={inp} value={fbEmail} onChange={e=>setFbEmail(e.target.value)} placeholder="learner@adobe.com"
              onKeyDown={e=>{if(e.key==="Enter")lookupFeedback();}}/></div>
          <button onClick={lookupFeedback} disabled={fbLoading} style={{background:fbLoading?P.muted:P.blue,color:"#fff",border:"none",borderRadius:8,padding:"9px 20px",fontSize:13,fontWeight:600,cursor:fbLoading?"not-allowed":"pointer",fontFamily:"inherit"}}>{fbLoading?"Looking up…":"Look up"}</button>
        </div>
        {fbErr&&<div style={{fontSize:12.5,color:P.red,marginTop:10}}>{fbErr}</div>}
        {fbData&&<div style={{marginTop:16,display:"flex",flexDirection:"column",gap:12}}>
          <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
            <div><div style={lbl}>Rated answers</div><div style={{fontSize:20,fontWeight:600,color:P.txt}}>{fbData.sample_size??0}</div></div>
            <div><div style={lbl}>👍 / 👎</div><div style={{fontSize:20,fontWeight:600,color:P.txt}}>{fbData.up_count??0} / {fbData.down_count??0}</div></div>
            <div><div style={lbl}>Adapting?</div><div style={{fontSize:20,fontWeight:600,color:fbData.adapting?P.grn:P.dim}}>{fbData.adapting?"Yes":"No"}</div></div>
          </div>
          <div style={{fontSize:12.5,color:P.muted,lineHeight:1.5}}>{fbData.status}</div>
          {fbData.directive&&<Card style={{padding:"12px 16px",background:P.blueGh,border:`1px solid ${P.blue}20`}}>
            <div style={{fontSize:11,fontWeight:600,color:P.blue,marginBottom:6,textTransform:"uppercase"}}>Directive injected into this learner's prompts</div>
            <div style={{fontSize:12.5,color:P.txt,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{fbData.directive}</div>
          </Card>}
        </div>}
      </Card>
    </div>
  );
}


function AdminLearningTracks(){
  const blank={track_code:"",label:"",keywords:"",grounding_terms:"",active:true,sort_order:100};
  const [tracks,setTracks]=useState([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [form,setForm]=useState(blank);
  const [editing,setEditing]=useState(null); // track_code being edited, or null for "new"
  const [saving,setSaving]=useState(false);
  const [saveMsg,setSaveMsg]=useState("");

  const load=()=>{
    setLoading(true);setError("");
    fetch(`${BACKEND}/api/admin/tracks`,{credentials:"include"})
      .then(async r=>{
        const d=await r.json();
        if(!r.ok)throw new Error(d.detail||"Could not load tracks");
        setTracks(d.tracks||[]);
      })
      .catch(e=>setError(e.message))
      .finally(()=>setLoading(false));
  };
  useEffect(()=>{load();},[]);

  const startEdit=(t)=>{
    setEditing(t.track_code);
    setForm({track_code:t.track_code,label:t.label,active:t.active,sort_order:t.sort_order,
      keywords:(t.keywords||[]).join(", "),grounding_terms:(t.grounding_terms||[]).join(", ")});
    setSaveMsg("");
  };
  const startNew=()=>{setEditing("__new__");setForm(blank);setSaveMsg("");};
  const cancelEdit=()=>{setEditing(null);setForm(blank);};

  const save=async()=>{
    if(!form.track_code.trim()||!form.label.trim()){setSaveMsg("Track code and label are required.");return;}
    setSaving(true);setSaveMsg("");
    try{
      const res=await fetch(`${BACKEND}/api/admin/tracks`,{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          track_code:form.track_code.trim().toLowerCase(),
          label:form.label.trim(),
          keywords:form.keywords.split(",").map(s=>s.trim()).filter(Boolean),
          grounding_terms:form.grounding_terms.split(",").map(s=>s.trim()).filter(Boolean),
          active:!!form.active,
          sort_order:Number(form.sort_order)||100,
        })});
      const d=await res.json();
      if(!res.ok)throw new Error(d.detail||"Save failed");
      setEditing(null);setForm(blank);
      load();
    }catch(e){setSaveMsg(e.message);}
    setSaving(false);
  };

  return(
    <div style={{maxWidth:760,margin:"0 auto",padding:"24px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <div>
          <div style={{fontSize:18,fontWeight:600,color:P.txt,marginBottom:4}}>Learning Tracks</div>
          <div style={{fontSize:12.5,color:P.muted}}>Adding a track here makes it available immediately to the Reasoning agent, Study Cards, Capstone, and Practice Scenarios' track pickers — no deploy needed.</div>
        </div>
        {editing===null&&<Btn size="sm" onClick={startNew}>+ New track</Btn>}
      </div>

      {error&&<Card style={{padding:"14px 16px",marginBottom:14,borderLeft:`3px solid ${P.red}`}}>
        <div style={{fontSize:13,color:P.red}}>{error}</div>
        <div style={{fontSize:11.5,color:P.muted,marginTop:4}}>This page requires a real Adobe sign-in with admin access — the demo login picker doesn't carry a session.</div>
      </Card>}

      {editing!==null&&(
        <Card style={{padding:"18px 20px",marginBottom:16}}>
          <div style={{fontSize:13.5,fontWeight:600,color:P.txt,marginBottom:12}}>{editing==="__new__"?"New track":`Edit ${editing}`}</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
            <div>
              <Label style={{marginBottom:5}}>Track code</Label>
              <input value={form.track_code} disabled={editing!=="__new__"} onChange={e=>setForm(f=>({...f,track_code:e.target.value}))}
                placeholder="e.g. target"
                style={{width:"100%",boxSizing:"border-box",border:`1px solid ${P.border}`,borderRadius:7,padding:"8px 10px",fontSize:13,background:editing!=="__new__"?P.surface:P.bg,color:P.txt,fontFamily:"inherit"}}/>
            </div>
            <div>
              <Label style={{marginBottom:5}}>Display label</Label>
              <input value={form.label} onChange={e=>setForm(f=>({...f,label:e.target.value}))}
                placeholder="e.g. Adobe Target"
                style={{width:"100%",boxSizing:"border-box",border:`1px solid ${P.border}`,borderRadius:7,padding:"8px 10px",fontSize:13,background:P.bg,color:P.txt,fontFamily:"inherit"}}/>
            </div>
          </div>
          <div style={{marginBottom:10}}>
            <Label style={{marginBottom:5}}>Keywords (comma-separated — used to route learner questions to this track)</Label>
            <input value={form.keywords} onChange={e=>setForm(f=>({...f,keywords:e.target.value}))}
              placeholder="e.g. target, ab testing, personalization"
              style={{width:"100%",boxSizing:"border-box",border:`1px solid ${P.border}`,borderRadius:7,padding:"8px 10px",fontSize:13,background:P.bg,color:P.txt,fontFamily:"inherit"}}/>
          </div>
          <div style={{marginBottom:10}}>
            <Label style={{marginBottom:5}}>Grounding terms (comma-separated — used to ground generated content)</Label>
            <input value={form.grounding_terms} onChange={e=>setForm(f=>({...f,grounding_terms:e.target.value}))}
              placeholder="e.g. activity, experience, audience"
              style={{width:"100%",boxSizing:"border-box",border:`1px solid ${P.border}`,borderRadius:7,padding:"8px 10px",fontSize:13,background:P.bg,color:P.txt,fontFamily:"inherit"}}/>
          </div>
          <div style={{display:"flex",gap:16,alignItems:"center",marginBottom:14}}>
            <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:P.txt,cursor:"pointer"}}>
              <input type="checkbox" checked={form.active} onChange={e=>setForm(f=>({...f,active:e.target.checked}))}/> Active
            </label>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <Label style={{marginBottom:0}}>Sort order</Label>
              <input type="number" value={form.sort_order} onChange={e=>setForm(f=>({...f,sort_order:e.target.value}))}
                style={{width:70,border:`1px solid ${P.border}`,borderRadius:7,padding:"6px 8px",fontSize:13,background:P.bg,color:P.txt,fontFamily:"inherit"}}/>
            </div>
          </div>
          {saveMsg&&<div style={{fontSize:12.5,color:P.red,marginBottom:10}}>{saveMsg}</div>}
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={save} disabled={saving}>{saving?"Saving...":"Save"}</Btn>
            <Btn variant="secondary" onClick={cancelEdit} disabled={saving}>Cancel</Btn>
          </div>
        </Card>
      )}

      {loading?<div style={{fontSize:13,color:P.muted}}>Loading tracks…</div>:(
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {tracks.map(t=>(
            <Card key={t.track_code} style={{padding:"14px 16px",display:"flex",alignItems:"center",gap:12}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:13.5,fontWeight:600,color:P.txt}}>{t.label}</span>
                  <span style={{fontSize:10.5,color:P.dim,fontFamily:"monospace"}}>{t.track_code}</span>
                  {!t.active&&<span style={{fontSize:10,fontWeight:600,color:P.amber,background:P.amberBg,borderRadius:4,padding:"1px 7px"}}>Inactive</span>}
                </div>
                <div style={{fontSize:11.5,color:P.muted,marginTop:3}}>{(t.keywords||[]).length} keywords · {(t.grounding_terms||[]).length} grounding terms · order {t.sort_order}</div>
              </div>
              <button onClick={()=>startEdit(t)} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:7,padding:"5px 12px",fontSize:12,cursor:"pointer",color:P.txt,fontFamily:"inherit"}}>Edit</button>
            </Card>
          ))}
          {!tracks.length&&!error&&<div style={{fontSize:13,color:P.muted}}>No tracks configured yet.</div>}
        </div>
      )}
    </div>
  );
}

function AdminValidation(){
  const [report,setReport]=useState(null);
  const [loading,setLoading]=useState(true);
  const [authError,setAuthError]=useState(false);
  const [err,setErr]=useState(null);

  const load=()=>{
    setLoading(true);setAuthError(false);setErr(null);
    fetch(`${BACKEND}/api/admin/validate`,{credentials:"include"})
      .then(async r=>{
        if(r.status===401||r.status===403){setAuthError(true);setLoading(false);return;}
        const d=await r.json().catch(()=>({}));
        if(!r.ok){setErr(d.detail||`Failed (${r.status}).`);setLoading(false);return;}
        setReport(d);setLoading(false);
      }).catch(()=>{setErr("Could not reach the server.");setLoading(false);});
  };
  useEffect(()=>{load();},[]);

  const Badge=({tone,children})=>{
    const map={ok:["#1A7F37","rgba(26,127,55,.10)"],warn:["#B45309","rgba(180,83,9,.12)"],
               fail:["#B42318","rgba(180,35,24,.12)"],info:[P.blue,"rgba(37,99,235,.10)"]};
    const [c,bg]=map[tone]||[P.muted,"rgba(0,0,0,.05)"];
    return <span style={{fontSize:11,fontWeight:600,color:c,background:bg,borderRadius:6,padding:"2px 8px",whiteSpace:"nowrap"}}>{children}</span>;
  };
  const Section=({title,children,right})=>(
    <div style={{marginBottom:22}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",margin:"0 0 8px"}}>
        <div style={{fontSize:14,fontWeight:600,color:P.txt}}>{title}</div>{right}
      </div>
      {children}
    </div>
  );

  return(
    <div style={{maxWidth:1000,margin:"0 auto",padding:"20px 24px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div>
          <div style={{fontSize:16,fontWeight:500,color:P.txt}}>Data Validation</div>
          <div style={{fontSize:12.5,color:P.muted}}>Cross-checks curriculum, the RAG index, and how real teams &amp; roles resolve to tracks and learning journeys. Read-only — nothing is changed.</div>
        </div>
        <button onClick={load} disabled={loading}
          style={{background:P.blue,color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",fontSize:13,fontWeight:600,cursor:loading?"default":"pointer",fontFamily:"inherit",opacity:loading?.6:1}}>
          {loading?"Checking…":"Re-run checks"}</button>
      </div>

      {loading&&<div style={{padding:"24px 0",textAlign:"center",color:P.muted,fontSize:13}}>Running checks…</div>}
      {!loading&&authError&&<Card style={{padding:"14px 16px",borderLeft:`3px solid ${P.red}`}}>
        <div style={{fontSize:13,color:P.red}}>Admin sign-in required.</div>
        <div style={{fontSize:11.5,color:P.muted,marginTop:4}}>This page needs a real Adobe admin session — the demo login picker doesn't carry one.</div>
      </Card>}
      {!loading&&err&&<Card style={{padding:"14px 16px",borderLeft:`3px solid ${P.red}`}}><div style={{fontSize:13,color:P.red}}>{err}</div></Card>}

      {!loading&&!authError&&report&&<>
        <div style={{fontSize:11,color:P.dim,marginBottom:16}}>Generated {report.generated_at}</div>

        {/* ── Curriculum ─────────────────────────────────────────────── */}
        <Section title="Curriculum content">
          {/* All-tracks coverage: makes empty tracks visible, not just absent. */}
          {(()=>{
            const FE_MODS={rtcdp:(typeof MODULES!=="undefined"?MODULES.length:0),
                           analytics:(typeof ANALYTICS_MODULES!=="undefined"?ANALYTICS_MODULES.length:0),
                           ajo:(typeof AJO_MODULES!=="undefined"?AJO_MODULES.length:0),
                           cja:(typeof CJA_MODULES!=="undefined"?CJA_MODULES.length:0),
                           da:(typeof DA_MODULES!=="undefined"?DA_MODULES.length:0),
                           de:(typeof DE_MODULES!=="undefined"?DE_MODULES.length:0),
                           es:(typeof ES_MODULES!=="undefined"?ES_MODULES.length:0),
                           target:(typeof TARGET_MODULES!=="undefined"?TARGET_MODULES.length:0),
                           marketo:(typeof MARKETO_MODULES!=="undefined"?MARKETO_MODULES.length:0),
                           campaign:(typeof CAMPAIGN_MODULES!=="undefined"?CAMPAIGN_MODULES.length:0),
                           "aa-sdk":(typeof AASDK_MODULES!=="undefined"?AASDK_MODULES.length:0)};
            const cov=report.curriculum?.coverage||[];
            if(!cov.length)return null;
            const full=cov.filter(c=>c.db_topics>0).length;
            const feOnly=cov.filter(c=>c.db_topics===0&&(FE_MODS[c.track]||0)>0).length;
            const empty=cov.filter(c=>c.db_topics===0&&!(FE_MODS[c.track]||0)).length;
            return <Card style={{padding:"14px 16px",marginBottom:12}}>
              <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:10}}>
                <span style={{fontSize:13,fontWeight:600,color:P.txt}}>All tracks — content coverage</span>
                <Badge tone="ok">{full} with content</Badge>
                <Badge tone={feOnly?"warn":"ok"}>{feOnly} frontend-only</Badge>
                <Badge tone={empty?"fail":"ok"}>{empty} empty</Badge>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1.4fr 0.7fr 0.7fr 1.3fr",gap:6,fontSize:10.5,fontWeight:600,color:P.dim,textTransform:"uppercase",letterSpacing:.4,paddingBottom:6,borderBottom:`1px solid ${P.border}`}}>
                <span>Track</span><span>FE modules</span><span>DB topics</span><span>Status</span>
              </div>
              {cov.map((c,i)=>{
                const fe=FE_MODS[c.track]||0;
                const [tone,txt]=c.db_topics>0?["ok","content in DB"]
                  :fe>0?["warn","frontend-only — no DB / no doc grounding"]
                  :["fail","no content anywhere"];
                return <div key={c.track} style={{display:"grid",gridTemplateColumns:"1.4fr 0.7fr 0.7fr 1.3fr",gap:6,alignItems:"center",fontSize:12.5,padding:"6px 0",borderTop:i?`1px solid ${P.bfaint}`:"none"}}>
                  <span style={{color:P.txt}}><span style={{textTransform:"uppercase",fontWeight:600}}>{c.track}</span> <span style={{color:P.dim,fontSize:11}}>{c.label}</span></span>
                  <span style={{color:fe?P.txt:P.dim}}>{fe||"—"}</span>
                  <span style={{color:c.db_topics?P.txt:P.dim}}>{c.db_topics||"—"}</span>
                  <Badge tone={tone}>{txt}</Badge>
                </div>;
              })}
            </Card>;
          })()}
          {(report.curriculum?.tracks||[]).length===0&&<div style={{fontSize:12.5,color:P.muted}}>No curriculum_topics found. Run seed_curriculum.py.</div>}
          {(report.curriculum?.tracks||[]).map(tr=>{
            // client-side: does the frontend's module list line up with the DB?
            const feMods=(typeof getModulesForTrack==="function"?getModulesForTrack(tr.track):[])||[];
            const dbIds=new Set(tr.modules.map(m=>m.module_id));
            const feIds=new Set(feMods.map(m=>m.id));
            const feOnly=feMods.filter(m=>!dbIds.has(m.id)).map(m=>m.id);
            const dbOnly=tr.modules.filter(m=>!feIds.has(m.module_id)).map(m=>m.module_id);
            const clean=tr.issues.length===0&&feOnly.length===0&&dbOnly.length===0;
            return(
              <Card key={tr.track} style={{padding:"14px 16px",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,flexWrap:"wrap"}}>
                  <span style={{fontSize:13.5,fontWeight:600,color:P.txt,textTransform:"uppercase"}}>{tr.track}</span>
                  <Badge tone="info">{tr.modules.length} modules</Badge>
                  <Badge tone="info">{tr.topic_count} topics</Badge>
                  {clean?<Badge tone="ok">✓ looks consistent</Badge>:<Badge tone="warn">{tr.issues.length+ (feOnly.length?1:0)+(dbOnly.length?1:0)} item(s) to review</Badge>}
                </div>
                {tr.issues.map((iss,i)=><div key={i} style={{fontSize:12,color:iss.level==="fail"?P.red:"#B45309",marginBottom:3}}>• {iss.detail}</div>)}
                {feOnly.length>0&&<div style={{fontSize:12,color:"#B45309",marginBottom:3}}>• Frontend lists module(s) {feOnly.join(", ")} but the DB has no topics for them.</div>}
                {dbOnly.length>0&&<div style={{fontSize:12,color:"#B45309",marginBottom:3}}>• DB has module(s) {dbOnly.join(", ")} the frontend module list doesn't show.</div>}
                {tr.offtrack.length>0&&<details style={{marginTop:6}}>
                  <summary style={{fontSize:12,color:P.blue,cursor:"pointer"}}>{tr.offtrack.length} cross-product link(s) — review</summary>
                  <div style={{marginTop:6}}>{tr.offtrack.map((o,i)=>(
                    <div key={i} style={{fontSize:11.5,color:P.muted,padding:"3px 0",borderTop:i?`1px solid ${P.bfaint}`:"none"}}>
                      m{o.module_id}.{o.topic_order} <span style={{color:P.txt}}>{o.title}</span> — {o.reason}</div>
                  ))}</div>
                </details>}
              </Card>
            );
          })}
        </Section>

        {/* ── RAG index ──────────────────────────────────────────────── */}
        <Section title="RAG / embeddings index">
          <Card style={{padding:"14px 16px"}}>
            <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:8}}>
              {report.embeddings?.pgvector_available
                ?<Badge tone="ok">✓ pgvector live · {report.embeddings.pgvector_count} vectors</Badge>
                :<Badge tone="warn">pgvector unavailable — using in-memory fallback</Badge>}
              <Badge tone="info">{report.embeddings?.total||0} rows in doc_embeddings</Badge>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8}}>
              {Object.entries(report.embeddings?.per_track||{}).map(([t,n])=>(
                <div key={t} style={{fontSize:12,color:P.txt}}><span style={{textTransform:"uppercase",color:P.muted}}>{t}</span>: {n}</div>
              ))}
            </div>
            {report.embeddings?.total===0&&<div style={{fontSize:12,color:"#B45309",marginTop:8}}>Index is empty — run build_embeddings_index.py.</div>}
          </Card>
        </Section>

        {/* ── Org: manager-based resolution (primary) ────────────────── */}
        <Section title="People → track (by manager)">
          {(()=>{const mr=report.org?.manager_resolution||{};const total=(mr.resolved_headcount||0)+(mr.ambiguous_headcount||0)+(mr.unmapped_manager_headcount||0);
          return <Card style={{padding:"14px 16px",marginBottom:10}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6,flexWrap:"wrap"}}>
              <span style={{fontSize:13,fontWeight:600,color:P.txt}}>Resolution by manager</span>
              <Badge tone="ok">{mr.resolved_headcount||0} resolved</Badge>
              <Badge tone={mr.ambiguous_headcount?"warn":"ok"}>{mr.ambiguous_headcount||0} ambiguous</Badge>
              <Badge tone={mr.unmapped_manager_headcount?"fail":"ok"}>{mr.unmapped_manager_headcount||0} manager missing</Badge>
            </div>
            <div style={{fontSize:11.5,color:P.muted,marginBottom:10}}>Each person's track comes from their manager's team focus. <strong>Manager missing</strong> = that manager isn't in the hierarchy yet — add them in Org Data. <strong>Ambiguous</strong> = the manager's focus spans multiple tracks and needs a call.</div>
            <div style={{display:"grid",gridTemplateColumns:"1.7fr 0.5fr 1.2fr 1fr",gap:6,fontSize:10.5,fontWeight:600,color:P.dim,textTransform:"uppercase",letterSpacing:.4,paddingBottom:6,borderBottom:`1px solid ${P.border}`}}>
              <span>Manager</span><span>People</span><span>Track focus</span><span>Matrix role</span>
            </div>
            {(mr.by_manager||[]).map((m,i)=>{
              const tone=m.status==="resolved"?"ok":m.status==="ambiguous"?"warn":"fail";
              const label=m.status==="resolved"?m.matrix_role:m.status==="ambiguous"?"needs a call":"add manager";
              return <div key={i} style={{display:"grid",gridTemplateColumns:"1.7fr 0.5fr 1.2fr 1fr",gap:6,alignItems:"center",fontSize:12.5,padding:"5px 0",borderTop:i?`1px solid ${P.bfaint}`:"none"}}>
                <span style={{color:P.txt}}>{m.manager}</span>
                <span style={{color:P.dim}}>{m.people}</span>
                <span style={{color:P.muted,fontSize:11.5}}>{m.track_focus||"—"}</span>
                <Badge tone={tone}>{label}</Badge>
              </div>;
            })}
          </Card>;})()}

          <Card style={{padding:"14px 16px",marginBottom:10}}>
            <div style={{fontSize:13,fontWeight:600,color:P.txt,marginBottom:8}}>Directory teams <span style={{fontWeight:400,color:P.dim}}>({report.org?.directory_count||0} people)</span></div>
            {(report.org?.teams||[]).map(tm=>{
              const mapped=typeof TEAM_TRACK_MAP!=="undefined"?TEAM_TRACK_MAP[tm.team]:undefined;
              return <div key={tm.team} style={{display:"flex",alignItems:"center",gap:10,fontSize:12.5,padding:"4px 0"}}>
                <span style={{minWidth:120,color:P.txt}}>{tm.team}</span>
                <span style={{color:P.dim,minWidth:60}}>{tm.n} ppl</span>
                {mapped?<Badge tone="ok">→ {mapped}</Badge>:<Badge tone="info">resolved via manager, not team</Badge>}
              </div>;
            })}
          </Card>

          <Card style={{padding:"14px 16px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexWrap:"wrap"}}>
              <span style={{fontSize:13,fontWeight:600,color:P.txt}}>Role → learning journey</span>
              <Badge tone="ok">{report.org?.resolved_headcount||0} people resolve</Badge>
              <Badge tone={report.org?.unresolved_headcount?"fail":"ok"}>{report.org?.unresolved_headcount||0} people don't</Badge>
            </div>
            <div style={{fontSize:11.5,color:P.muted,marginBottom:10}}>Unresolved roles get no role-based cross-skill guidance. Add a mapping for each in <strong>Org Data → Role Aliases</strong>.</div>
            <div style={{maxHeight:320,overflowY:"auto"}}>
              {(report.org?.role_resolution||[]).map((r,i)=>(
                <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 54px 1.2fr",gap:8,alignItems:"center",fontSize:12.5,padding:"5px 0",borderTop:i?`1px solid ${P.bfaint}`:"none"}}>
                  <span style={{color:P.txt}}>{r.role}</span>
                  <span style={{color:P.dim}}>{r.count} ppl</span>
                  {r.resolves?<Badge tone="ok">→ {r.matched_role} ({r.via})</Badge>:<Badge tone="fail">no match</Badge>}
                </div>
              ))}
            </div>
          </Card>
        </Section>
      </>}
    </div>
  );
}

function AdminOrgData(){
  const [managers,setManagers]=useState([]);
  const [journey,setJourney]=useState([]);
  const [loading,setLoading]=useState(true);
  const [authError,setAuthError]=useState(false);
  const [uploading,setUploading]=useState(null); // "managers"|"journey"|null
  const [msg,setMsg]=useState({}); // {managers:{ok,text}, journey:{ok,text}}
  const mgrFileRef=useRef(null);
  const jrnFileRef=useRef(null);
  const [aliases,setAliases]=useState([]);
  const [jrForm,setJrForm]=useState({role:"",priority:"1",target_proficiency:"",tracks:"",notes:""});
  const [jrBusy,setJrBusy]=useState(false);
  const [rowMsg,setRowMsg]=useState(null);
  const [alForm,setAlForm]=useState({alias:"",canonical_role:""});
  const [alMsg,setAlMsg]=useState(null);

  const load=()=>{
    setLoading(true);setAuthError(false);
    Promise.all([
      fetch(`${BACKEND}/api/admin/manager-hierarchy`,{credentials:"include"}),
      fetch(`${BACKEND}/api/admin/learning-journey`,{credentials:"include"}),
      fetch(`${BACKEND}/api/admin/role-aliases`,{credentials:"include"}),
    ]).then(async([mRes,jRes,aRes])=>{
      if(mRes.status===401||jRes.status===401){setAuthError(true);setLoading(false);return;}
      const m=await mRes.json().catch(()=>({})),j=await jRes.json().catch(()=>({})),a=await aRes.json().catch(()=>({}));
      setManagers(m?.managers||[]);setJourney(j?.journey||[]);setAliases(a?.aliases||[]);setLoading(false);
    }).catch(()=>setLoading(false));
  };
  useEffect(()=>{load();},[]);

  const saveJourneyRow=async()=>{
    const role=jrForm.role.trim(),priority=parseInt(jrForm.priority,10);
    if(!role||!(priority>=1&&priority<=5)){setRowMsg({ok:false,text:"Role and priority (1–5) are required."});return;}
    setJrBusy(true);setRowMsg(null);
    try{
      const r=await fetch(`${BACKEND}/api/admin/learning-journey`,{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({role,priority,target_proficiency:jrForm.target_proficiency.trim(),
          tracks:jrForm.tracks.split(",").map(t=>t.trim()).filter(Boolean),notes:jrForm.notes.trim()})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)setRowMsg({ok:false,text:d.detail||`Save failed (${r.status}).`});
      else{setRowMsg({ok:true,text:`Saved ${role} · priority ${priority}.`});setJrForm({role:"",priority:"1",target_proficiency:"",tracks:"",notes:""});load();}
    }catch{setRowMsg({ok:false,text:"Could not reach the server."});}
    setJrBusy(false);
  };
  const editJourneyRow=(j)=>{setRowMsg(null);setJrForm({role:j.role,priority:String(j.priority),target_proficiency:j.target_proficiency||"",tracks:(j.tracks||[]).join(", "),notes:j.notes||""});};
  const deleteJourneyRow=async(role,priority)=>{
    if(!window.confirm(`Delete ${role} · priority ${priority}?`))return;
    try{await fetch(`${BACKEND}/api/admin/learning-journey/${encodeURIComponent(role)}/${priority}`,{method:"DELETE",credentials:"include"});load();}catch{}
  };
  const saveAlias=async()=>{
    const alias=alForm.alias.trim(),canonical_role=alForm.canonical_role.trim();
    if(!alias||!canonical_role){setAlMsg({ok:false,text:"Alias and role code are required."});return;}
    setAlMsg(null);
    try{
      const r=await fetch(`${BACKEND}/api/admin/role-aliases`,{method:"POST",credentials:"include",
        headers:{"Content-Type":"application/json"},body:JSON.stringify({alias,canonical_role})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)setAlMsg({ok:false,text:d.detail||`Save failed (${r.status}).`});
      else{setAlMsg({ok:true,text:`Mapped "${alias}" → ${canonical_role}.`});setAlForm({alias:"",canonical_role:""});load();}
    }catch{setAlMsg({ok:false,text:"Could not reach the server."});}
  };
  const deleteAlias=async(alias)=>{
    if(!window.confirm(`Remove mapping for "${alias}"?`))return;
    try{await fetch(`${BACKEND}/api/admin/role-aliases/${encodeURIComponent(alias)}`,{method:"DELETE",credentials:"include"});load();}catch{}
  };
  const inp={border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 12px",fontSize:13,color:P.txt,background:P.panel,fontFamily:"inherit",outline:"none"};

  const doUpload=async(kind,f,url)=>{
    if(!f)return;
    if(!f.name.toLowerCase().endsWith(".xlsx")){setMsg(m=>({...m,[kind]:{ok:false,text:"Please choose a .xlsx file."}}));return;}
    setUploading(kind);setMsg(m=>({...m,[kind]:null}));
    try{
      const fd=new FormData();fd.append("file",f);
      const r=await fetch(`${BACKEND}${url}`,{method:"POST",body:fd,credentials:"include"});
      const d=await r.json().catch(()=>({}));
      if(!r.ok){setMsg(m=>({...m,[kind]:{ok:false,text:d.detail||`Upload failed (${r.status}).`}}));}
      else{setMsg(m=>({...m,[kind]:{ok:true,text:`Applied ${d.rows_applied} row(s) from "${f.name}".`}}));load();}
    }catch{setMsg(m=>({...m,[kind]:{ok:false,text:"Could not reach the server."}}));}
    setUploading(null);
  };

  const UploadBox=({kind,url,fileRef,title,hint,columns})=>(
    <Card style={{padding:"18px 20px",marginBottom:16}}>
      <div style={{fontSize:14,fontWeight:600,color:P.txt,marginBottom:3}}>{title}</div>
      <div style={{fontSize:12,color:P.muted,marginBottom:12}}>{hint}</div>
      <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <input ref={fileRef} type="file" accept=".xlsx" style={{display:"none"}}
          onChange={e=>{const f=e.target.files?.[0];doUpload(kind,f,url);e.target.value="";}}/>
        <button onClick={()=>fileRef.current?.click()} disabled={uploading===kind}
          style={{background:P.blue,color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",fontSize:13,fontWeight:600,cursor:uploading===kind?"default":"pointer",fontFamily:"inherit",opacity:uploading===kind?.6:1}}>
          {uploading===kind?"Uploading…":"Choose Excel file"}
        </button>
        <div style={{fontSize:11,color:P.dim}}>Expected columns: {columns}</div>
      </div>
      {msg[kind]&&<div style={{marginTop:10,fontSize:12.5,color:msg[kind].ok?P.grn:P.red}}>{msg[kind].ok?"✓ ":"✗ "}{msg[kind].text}</div>}
    </Card>
  );

  return(
    <div style={{maxWidth:980,margin:"0 auto",padding:"20px 24px"}}>
      <div style={{marginBottom:6}}>
        <div style={{fontSize:16,fontWeight:500,color:P.txt}}>Org Data — Managers & Learning Journey</div>
        <div style={{fontSize:12.5,color:P.muted}}>Upload the manager reporting structure and the role-based learning journey matrix (.xlsx). The AI Advisor's cross-skilling agent uses these — combined with each learner's role and tenure from User Provisioning — to ground its recommendations in real org data instead of guessing.</div>
      </div>

      <UploadBox kind="managers" url="/api/admin/manager-hierarchy/upload" fileRef={mgrFileRef}
        title="Manager Hierarchy" hint="Who reports to whom, and each manager's track focus. Mapped to learners via the Manager column in User Provisioning."
        columns="Manager Name, Reports To, Track Focus, Notes"/>
      <UploadBox kind="journey" url="/api/admin/learning-journey/upload" fileRef={jrnFileRef}
        title="Role Learning Journey Matrix" hint="Which tracks are the most viable next step for each role, ranked by priority (1 = most viable, 5 = optional)."
        columns="Role, Priority, Target Proficiency, Track(s) (comma-separated), Notes"/>

      {loading&&<div style={{padding:"20px 0",textAlign:"center",color:P.muted,fontSize:13}}>Loading…</div>}

      {!loading&&authError&&<Card style={{padding:"14px 16px",marginBottom:14,borderLeft:`3px solid ${P.red}`}}>
        <div style={{fontSize:13,color:P.red}}>Not authenticated.</div>
        <div style={{fontSize:11.5,color:P.muted,marginTop:4}}>This page requires a real Adobe sign-in with admin access — the demo login picker doesn't carry a session.</div>
      </Card>}

      {!loading&&!authError&&<>
        <div style={{fontSize:14,fontWeight:500,color:P.txt,margin:"20px 0 8px"}}>Manager Hierarchy <span style={{fontSize:12,color:P.dim}}>({managers.length})</span></div>
        {managers.length===0?<div style={{fontSize:12.5,color:P.muted,marginBottom:20}}>No manager data uploaded yet.</div>:(
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden",marginBottom:20}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1.4fr 1.4fr",padding:"9px 16px",background:P.surface,borderBottom:`1px solid ${P.border}`,fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.4,textTransform:"uppercase"}}>
              <span>Manager</span><span>Reports To</span><span>Track Focus</span><span>Notes</span>
            </div>
            {managers.map((m,idx)=>(
              <div key={m.manager_name} style={{display:"grid",gridTemplateColumns:"1fr 1fr 1.4fr 1.4fr",padding:"10px 16px",borderBottom:idx<managers.length-1?`1px solid ${P.bfaint}`:"none",alignItems:"center"}}>
                <div style={{fontSize:13,fontWeight:600,color:P.txt}}>{m.manager_name}</div>
                <div style={{fontSize:12.5,color:P.muted}}>{m.reports_to||"—"}</div>
                <div style={{fontSize:12.5,color:P.txt}}>{m.track_focus||"—"}</div>
                <div style={{fontSize:11.5,color:P.dim}}>{m.notes||"—"}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{fontSize:14,fontWeight:500,color:P.txt,margin:"20px 0 8px"}}>Role Learning Journey <span style={{fontSize:12,color:P.dim}}>({journey.length})</span></div>
        {journey.length===0?<div style={{fontSize:12.5,color:P.muted}}>No learning journey data uploaded yet.</div>:(
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 0.5fr 0.9fr 1.5fr 1.1fr 0.8fr",padding:"9px 16px",background:P.surface,borderBottom:`1px solid ${P.border}`,fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.4,textTransform:"uppercase"}}>
              <span>Role</span><span>Priority</span><span>Target Prof.</span><span>Track(s)</span><span>Notes</span><span style={{textAlign:"right"}}>Edit</span>
            </div>
            {journey.map((j,idx)=>(
              <div key={`${j.role}-${j.priority}`} style={{display:"grid",gridTemplateColumns:"1fr 0.5fr 0.9fr 1.5fr 1.1fr 0.8fr",padding:"10px 16px",borderBottom:idx<journey.length-1?`1px solid ${P.bfaint}`:"none",alignItems:"center"}}>
                <div style={{fontSize:13,fontWeight:600,color:P.txt}}>{j.role}</div>
                <div style={{fontSize:12.5,color:P.txt}}>{j.priority}</div>
                <div style={{fontSize:12.5,color:P.muted}}>{j.target_proficiency||"—"}</div>
                <div style={{fontSize:12,color:P.txt}}>{(j.tracks||[]).join(", ")||"—"}</div>
                <div style={{fontSize:11.5,color:P.dim}}>{j.notes||"—"}</div>
                <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                  <button onClick={()=>editJourneyRow(j)} title="Edit in the form below" style={{background:"none",border:"none",color:P.blue,fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:0}}>Edit</button>
                  <button onClick={()=>deleteJourneyRow(j.role,j.priority)} title="Delete this row" style={{background:"none",border:"none",color:P.red,fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:0}}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <Card style={{padding:"18px 20px",margin:"18px 0"}}>
          <div style={{fontSize:14,fontWeight:600,color:P.txt,marginBottom:3}}>Add or update a role row</div>
          <div style={{fontSize:12,color:P.muted,marginBottom:12}}>Upserts on Role + Priority. Use "Edit" on any row above to load it here, change it, and save.</div>
          <div style={{display:"grid",gridTemplateColumns:"1.2fr 0.7fr 1fr",gap:10,marginBottom:10}}>
            <input value={jrForm.role} onChange={e=>setJrForm(f=>({...f,role:e.target.value}))} placeholder="Role (e.g. AEP - DA)" style={inp}/>
            <select value={jrForm.priority} onChange={e=>setJrForm(f=>({...f,priority:e.target.value}))} style={inp}>
              {[1,2,3,4,5].map(n=><option key={n} value={n}>Priority {n}</option>)}
            </select>
            <input value={jrForm.target_proficiency} onChange={e=>setJrForm(f=>({...f,target_proficiency:e.target.value}))} placeholder="Target prof. (e.g. Intermediate)" style={inp}/>
          </div>
          <input value={jrForm.tracks} onChange={e=>setJrForm(f=>({...f,tracks:e.target.value}))} placeholder="Track(s), comma-separated (e.g. DE, RTCDP, B2B)" style={{...inp,width:"100%",marginBottom:10,boxSizing:"border-box"}}/>
          <input value={jrForm.notes} onChange={e=>setJrForm(f=>({...f,notes:e.target.value}))} placeholder="Notes (optional)" style={{...inp,width:"100%",marginBottom:10,boxSizing:"border-box"}}/>
          <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <button onClick={saveJourneyRow} disabled={jrBusy} style={{background:P.blue,color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",fontSize:13,fontWeight:600,cursor:jrBusy?"default":"pointer",fontFamily:"inherit",opacity:jrBusy?.6:1}}>{jrBusy?"Saving…":"Save row"}</button>
            {jrForm.role&&<button onClick={()=>{setJrForm({role:"",priority:"1",target_proficiency:"",tracks:"",notes:""});setRowMsg(null);}} style={{background:"none",border:`1px solid ${P.border}`,borderRadius:8,padding:"9px 14px",fontSize:13,color:P.txt,cursor:"pointer",fontFamily:"inherit"}}>Clear</button>}
            {rowMsg&&<span style={{fontSize:12.5,color:rowMsg.ok?P.grn:P.red}}>{rowMsg.ok?"✓ ":"✗ "}{rowMsg.text}</span>}
          </div>
        </Card>

        <div style={{fontSize:14,fontWeight:500,color:P.txt,margin:"22px 0 4px"}}>Role Aliases <span style={{fontSize:12,color:P.dim}}>({aliases.length})</span></div>
        <div style={{fontSize:12.5,color:P.muted,marginBottom:10}}>Maps the role wording from User Provisioning (e.g. "Data Analyst") to a matrix role code (e.g. "AEP - DA") so the AI Advisor matches the right journey. Without a mapping, a learner's role won't match and the role lens is skipped.</div>
        <Card style={{padding:"16px 20px",marginBottom:14}}>
          <div style={{display:"grid",gridTemplateColumns:"1.4fr 1fr auto",gap:10,alignItems:"center"}}>
            <input value={alForm.alias} onChange={e=>setAlForm(f=>({...f,alias:e.target.value}))} placeholder="HR/profile role (e.g. Data Analyst)" style={inp}/>
            <input value={alForm.canonical_role} onChange={e=>setAlForm(f=>({...f,canonical_role:e.target.value}))} placeholder="Matrix role (e.g. AEP - DA)" style={inp}/>
            <button onClick={saveAlias} style={{background:P.blue,color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>Add mapping</button>
          </div>
          {alMsg&&<div style={{marginTop:10,fontSize:12.5,color:alMsg.ok?P.grn:P.red}}>{alMsg.ok?"✓ ":"✗ "}{alMsg.text}</div>}
        </Card>
        {aliases.length>0&&(
          <div style={{background:P.panel,border:`1px solid ${P.border}`,borderRadius:12,overflow:"hidden"}}>
            <div style={{display:"grid",gridTemplateColumns:"1.4fr 1fr 0.5fr",padding:"9px 16px",background:P.surface,borderBottom:`1px solid ${P.border}`,fontSize:10.5,fontWeight:600,color:P.dim,letterSpacing:.4,textTransform:"uppercase"}}>
              <span>HR / Profile Role</span><span>Matrix Role</span><span style={{textAlign:"right"}}>Remove</span>
            </div>
            {aliases.map((a,idx)=>(
              <div key={a.alias} style={{display:"grid",gridTemplateColumns:"1.4fr 1fr 0.5fr",padding:"10px 16px",borderBottom:idx<aliases.length-1?`1px solid ${P.bfaint}`:"none",alignItems:"center"}}>
                <div style={{fontSize:13,color:P.txt}}>{a.alias}</div>
                <div style={{fontSize:12.5,fontWeight:600,color:P.txt}}>{a.canonical_role}</div>
                <div style={{textAlign:"right"}}><button onClick={()=>deleteAlias(a.alias)} style={{background:"none",border:"none",color:P.red,fontSize:12,cursor:"pointer",fontFamily:"inherit",padding:0}}>Delete</button></div>
              </div>
            ))}
          </div>
        )}
      </>}
    </div>
  );
}

function AdminTrackerImport(){
  const [file,setFile]         = useState(null);
  const [preview,setPreview]   = useState(null);  // {members, summary}
  const [previewing,setPreviewing] = useState(false);
  const [result,setResult]     = useState(null);
  const [loading,setLoading]   = useState(false);
  const [error,setError]       = useState("");
  const [dupeReport,setDupeReport] = useState(null);
  const [dupeChecking,setDupeChecking] = useState(false);
  const [dupeApplying,setDupeApplying] = useState(false);
  const [mode,setMode] = useState("merge"); // merge | overwrite

  // Persistent "what's currently imported" snapshot — loads every time this
  // page opens, same as User Provisioning always showing the current roster,
  // not just the outcome of whatever you happened to upload most recently.
  const [summary,setSummary] = useState(null);
  const [summaryLoading,setSummaryLoading] = useState(true);
  const loadSummary = () => {
    setSummaryLoading(true);
    fetch(`${BACKEND}/api/admin/tracker/summary`,{credentials:"include"})
      .then(r=>r.json()).then(d=>{setSummary(d);setSummaryLoading(false);})
      .catch(()=>setSummaryLoading(false));
  };
  useEffect(()=>{ loadSummary(); },[]);

  function handleFile(e){
    const f=e.target.files[0];
    if(!f)return;
    const name=f.name.toLowerCase();
    if(!name.endsWith(".xlsx")&&!name.endsWith(".xls")&&!name.endsWith(".xlsm")){
      setError("Please choose a .xlsx or .xlsm file."); return;
    }
    setFile(f); setError(""); setResult(null); setPreview(null);
  }

  async function handlePreview(){
    if(!file)return;
    setPreviewing(true); setError("");
    try{
      const fd=new FormData(); fd.append("file",file);
      const res=await fetch(`${BACKEND}/api/admin/tracker/preview`,{method:"POST",credentials:"include",body:fd});
      const d=await res.json();
      if(!res.ok){setError(d.detail||"Preview failed"); return;}
      setPreview(d);
    }catch(ex){setError("Preview failed — check backend connection");}
    finally{setPreviewing(false);}
  }

  async function handleImport(){
    if(!file)return;
    setLoading(true); setResult(null); setError("");
    if(mode==="overwrite"){
      if(!window.confirm("Overwrite mode: this deletes all existing projects/tracker data before importing. Continue?")){
        setLoading(false); return;
      }
      try{
        const wr=await fetch(`${BACKEND}/api/admin/projects/wipe?confirm=WIPE`,{method:"DELETE",credentials:"include"});
        if(!wr.ok){setError("Could not clear existing data — import cancelled."); setLoading(false); return;}
      }catch(ex){setError("Could not reach the server."); setLoading(false); return;}
    }
    try{
      const fd=new FormData();
      fd.append("file",file);
      // No manager email needed — each member's projects are attributed to
      // their own manager automatically, resolved by name from the HR roster.
      const res=await fetch(`${BACKEND}/api/admin/tracker/import`,{method:"POST",credentials:"include",body:fd});
      const d=await res.json();
      if(!res.ok){setError(d.detail||"Import failed"); return;}
      setResult(d); loadSummary();
    }catch(ex){setError("Import failed — check backend connection");}
    finally{setLoading(false);}
  }

  async function checkDupes(){
    setDupeChecking(true);
    try{
      const res=await fetch(`${BACKEND}/api/admin/projects/dedupe?dry_run=true`,{method:"POST",credentials:"include"});
      setDupeReport(await res.json());
    }catch(ex){}
    finally{setDupeChecking(false);}
  }
  async function applyDupes(){
    if(!window.confirm("Merge duplicate projects and links now? This cannot be undone."))return;
    setDupeApplying(true);
    try{
      const res=await fetch(`${BACKEND}/api/admin/projects/dedupe?dry_run=false`,{method:"POST",credentials:"include"});
      setDupeReport(await res.json());
      loadSummary();
    }catch(ex){}
    finally{setDupeApplying(false);}
  }

  const infoRows=[
    ["Member column (flat sheet)","One row per project; the Member cell says who it belongs to"],
    ["Each tab (per-member sheets)","Alternative layout — one team member's data per tab"],
    ["Project Name / ID","Creates or updates a project in the Project Board"],
    ["Hrs/Week","Stored against each member-project link"],
    ["Health","Mapped to Planning / In Progress / Blocked / Completed"],
    ["Stage, Phase, Industry / Vertical","Stored as project metadata"],
    ["Solutions Used, Product Features, Data Sources, Destinations, Audiences","Stored as project detail, shown in Team Weekly Tracker"],
    ["Product Issues (Ticket ID)","Stored as project ticket reference"],
    ["Comments / Weekly Comments","Stored as project notes — editable per member in Team Weekly Tracker"],
    ["High Level Project Notes","Stored as project notes"],
  ];

  return(
    <div style={{maxWidth:900,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:20}}>
      <div>
        <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>Tracker Import</div>
        <div style={{fontSize:13,color:P.muted,marginBottom:10}}>
          Upload your existing team project tracker (.xlsx). Supports either a single flat sheet with a "Member" column per row, or one tab per team member (legacy layout). Each member's projects are mapped to their own manager automatically — by matching their name against the HR roster — so there's no manager email to enter.<br/>
          <b>Add & update:</b> existing projects are matched by Project ID/title and updated; new ones are added.<br/>
          <b>Overwrite all:</b> every existing project, link, and issue is permanently deleted first, then this file is imported fresh.
        </div>
        <UploadModeToggle mode={mode} setMode={setMode}/>
      </div>

      {/* Currently imported — persists across visits, like User Provisioning's roster */}
      <Card style={{padding:"16px 20px"}}>
        <div style={{fontSize:12,fontWeight:600,color:P.txt,marginBottom:10}}>Currently imported</div>
        {summaryLoading&&<div style={{fontSize:12.5,color:P.muted}}>Loading…</div>}
        {!summaryLoading&&summary&&summary.total_projects===0&&(
          <div style={{fontSize:12.5,color:P.muted}}>Nothing imported yet.</div>
        )}
        {!summaryLoading&&summary&&summary.total_projects>0&&(
          <>
            <div style={{display:"flex",gap:24,marginBottom:12}}>
              <div><div style={{fontSize:20,fontWeight:600,color:P.txt}}>{summary.total_projects}</div><div style={{fontSize:11,color:P.dim}}>Projects</div></div>
              <div><div style={{fontSize:20,fontWeight:600,color:P.txt}}>{summary.total_members}</div><div style={{fontSize:11,color:P.dim}}>Members linked</div></div>
              <div><div style={{fontSize:20,fontWeight:600,color:P.txt}}>{summary.by_manager.length}</div><div style={{fontSize:11,color:P.dim}}>Managers</div></div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1.6fr 0.8fr 0.8fr 1fr",gap:0,padding:"7px 0",
              borderBottom:`1px solid ${P.border}`,fontSize:10.5,fontWeight:600,color:P.dim,textTransform:"uppercase",letterSpacing:.3}}>
              <span>Manager</span><span style={{textAlign:"right"}}>Projects</span><span style={{textAlign:"right"}}>Members</span><span style={{textAlign:"right"}}>Last updated</span>
            </div>
            {summary.by_manager.map((m,i)=>(
              <div key={m.manager_email||i} style={{display:"grid",gridTemplateColumns:"1.6fr 0.8fr 0.8fr 1fr",gap:0,
                padding:"8px 0",borderBottom:i<summary.by_manager.length-1?`1px solid ${P.bfaint}`:"none",fontSize:12.5}}>
                <span style={{color:P.txt}}>{m.manager_email||"unassigned"}</span>
                <span style={{textAlign:"right",color:P.txt}}>{m.project_count}</span>
                <span style={{textAlign:"right",color:P.txt}}>{m.member_count}</span>
                <span style={{textAlign:"right",color:P.muted}}>{m.last_updated?m.last_updated.slice(0,10):"—"}</span>
              </div>
            ))}
          </>
        )}
      </Card>

      {/* Column mapping info */}
      <Card style={{padding:"16px 20px"}}>
        <div style={{fontSize:12,fontWeight:600,color:P.blue,marginBottom:10}}>What gets imported</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 24px"}}>
          {infoRows.map(([k,v])=>(
            <div key={k} style={{display:"flex",gap:8,padding:"4px 0",borderBottom:`1px solid ${P.bfaint}`}}>
              <span style={{fontSize:12,fontWeight:600,color:P.txt,width:160,flexShrink:0}}>{k}</span>
              <span style={{fontSize:12,color:P.muted}}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{fontSize:11.5,color:P.muted,marginTop:10,lineHeight:1.6}}>
          System tabs (Manager Dashboard, All Projects, All Members, All Milestones, How To Use) are automatically skipped. Member → manager mapping comes from the HR roster (Admin → User Provisioning); anyone not found there lands under "Unassigned" until the roster is uploaded.
        </div>
      </Card>

      {/* File picker */}
      <Card style={{padding:"20px 24px",display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
        <label style={{display:"inline-flex",alignItems:"center",gap:10,cursor:"pointer",
          background:P.blue,color:"#fff",borderRadius:8,padding:"9px 18px",fontSize:13,fontWeight:500}}>
          📎 Choose tracker file
          <input type="file" accept=".xlsx,.xls,.xlsm" style={{display:"none"}} onChange={handleFile}/>
        </label>
        {file&&<span style={{fontSize:12.5,color:P.grn,fontWeight:600}}>📄 {file.name}</span>}
        {error&&<div style={{fontSize:12.5,color:P.red}}>{error}</div>}
        {file&&!preview&&(
          <button onClick={handlePreview} disabled={previewing}
            style={{background:P.surface,color:P.txt,border:`1px solid ${P.border}`,borderRadius:8,
              padding:"8px 16px",fontSize:13,cursor:previewing?"wait":"pointer",fontFamily:"inherit"}}>
            {previewing?"Previewing…":"Preview first"}
          </button>
        )}
      </Card>

      {/* Preview */}
      {preview&&(
        <Card>
          <div style={{padding:"14px 20px 10px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{fontSize:13,fontWeight:500,color:P.txt}}>
              Preview — {preview.members} member sheet{preview.members!==1?"s":""} found
            </div>
          </div>
          <div style={{maxHeight:320,overflowY:"auto"}}>
            {preview.summary.map((m,i)=>(
              <div key={i} style={{display:"flex",alignItems:"flex-start",gap:14,padding:"11px 20px",
                borderTop:`1px solid ${P.bfaint}`}}>
                <div style={{width:32,height:32,borderRadius:"50%",background:P.blue,flexShrink:0,
                  display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:600,fontSize:13}}>
                  {(m.member||"?")[0].toUpperCase()}
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:500,color:P.txt,marginBottom:3}}>
                    {m.member} {m.role&&<span style={{fontWeight:400,color:P.muted}}>· {m.role}</span>}
                    <span style={{fontSize:11,color:P.blue,background:P.blueGh,borderRadius:4,
                      padding:"1px 7px",marginLeft:8}}>{m.project_count} project{m.project_count!==1?"s":""}</span>
                  </div>
                  <div style={{fontSize:11.5,color:P.muted}}>
                    {m.projects.filter(Boolean).slice(0,5).join(" · ")}{m.projects.length>5?` +${m.projects.length-5} more`:""}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{padding:"14px 20px",borderTop:`1px solid ${P.border}`,display:"flex",gap:8}}>
            <button onClick={handleImport} disabled={loading}
              style={{background:loading?P.muted:P.grn,color:"#fff",border:"none",borderRadius:8,
                padding:"9px 22px",fontSize:13,fontWeight:500,cursor:loading?"not-allowed":"pointer",fontFamily:"inherit"}}>
              {loading?"Importing…":`Import ${preview.members} member${preview.members!==1?"s":""}`}
            </button>
            <button onClick={()=>{setPreview(null);setFile(null);}}
              style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,
                padding:"9px 16px",fontSize:13,cursor:"pointer",color:P.txt,fontFamily:"inherit"}}>
              Cancel
            </button>
          </div>
        </Card>
      )}

      {/* Result */}
      {result&&(
        <Card style={{padding:"18px 20px",background:result.ok?P.grnBg:P.redLt,
          border:`1px solid ${result.ok?P.grn+"30":P.red+"30"}`}}>
          <div style={{fontSize:14,fontWeight:600,color:result.ok?P.grn:P.red,marginBottom:6}}>
            {result.ok?"Import complete":"Import failed"}
          </div>
          {result.ok&&<div style={{fontSize:12.5,color:P.muted,lineHeight:1.8}}>
            {result.message}<br/>
            {result.members_linked} member–project links created · {result.projects_inserted} new projects · {result.projects_updated} updated
            {result.skipped>0&&<span style={{color:P.amber}}> · {result.skipped} rows skipped</span>}
          </div>}
          {result.ok&&result.errors?.length>0&&(
            <div style={{fontSize:11.5,color:P.red,marginTop:8,background:P.redLt,borderRadius:6,padding:"8px 10px"}}>
              <div style={{fontWeight:600,marginBottom:4}}>Errors (first 5):</div>
              {result.errors.map((e,i)=><div key={i}>• {e}</div>)}
            </div>
          )}
          {result.ok&&result.projects_inserted>0&&<div style={{fontSize:12,color:P.muted,marginTop:8}}>
            Go to <strong>Manager → Project Board</strong> to see and edit the imported projects.
          </div>}
        </Card>
      )}

      {/* Duplicate cleanup */}
      <Card style={{padding:"18px 20px"}}>
        <div style={{fontSize:14,fontWeight:600,color:P.txt,marginBottom:4}}>Duplicate cleanup</div>
        <div style={{fontSize:12,color:P.muted,marginBottom:12}}>
          If a person or project ended up linked twice (e.g. from an import before manager/email resolution
          was fixed), check for duplicates here. Nothing is changed until you explicitly apply.
        </div>
        <div style={{display:"flex",gap:8,marginBottom:dupeReport?12:0}}>
          <button onClick={checkDupes} disabled={dupeChecking}
            style={{background:P.surface,color:P.txt,border:`1px solid ${P.border}`,borderRadius:8,
              padding:"8px 16px",fontSize:13,cursor:dupeChecking?"wait":"pointer",fontFamily:"inherit"}}>
            {dupeChecking?"Checking…":"Check for duplicates"}
          </button>
          {dupeReport&&dupeReport.dry_run&&(dupeReport.projects_merged>0||dupeReport.links_removed>0)&&(
            <button onClick={applyDupes} disabled={dupeApplying}
              style={{background:P.red,color:"#fff",border:"none",borderRadius:8,
                padding:"8px 16px",fontSize:13,fontWeight:600,cursor:dupeApplying?"wait":"pointer",fontFamily:"inherit"}}>
              {dupeApplying?"Merging…":"Merge duplicates"}
            </button>
          )}
        </div>
        {dupeReport&&(
          <div style={{fontSize:12.5,color:P.txt,lineHeight:1.8}}>
            {!dupeReport.dry_run&&<div style={{color:P.grn,fontWeight:600,marginBottom:6}}>✓ Applied</div>}
            {dupeReport.projects_merged===0&&dupeReport.links_removed===0
              ? "No duplicates found."
              : <>
                  {dupeReport.projects_merged>0&&<div>{dupeReport.duplicate_project_groups.length} project{dupeReport.duplicate_project_groups.length!==1?"s":""} had duplicates ({dupeReport.projects_merged} extra row{dupeReport.projects_merged!==1?"s":""} {dupeReport.dry_run?"would be":"were"} merged in).</div>}
                  {dupeReport.links_removed>0&&<div>{dupeReport.duplicate_link_groups.length} member–project link{dupeReport.duplicate_link_groups.length!==1?"s":""} had duplicates ({dupeReport.links_removed} extra link{dupeReport.links_removed!==1?"s":""} {dupeReport.dry_run?"would be":"were"} removed).</div>}
                </>
            }
          </div>
        )}
      </Card>

      <DangerZoneWipe title="Wipe all projects & tracker data"
        description="Permanently deletes every imported project, member link, issue, allocation, initiative, and milestone. Use this to start the tracker over from a clean slate."
        endpoint="/api/admin/projects/wipe"
        onDone={()=>{loadSummary();setDupeReport(null);setResult(null);}}/>
    </div>
  );
}

function AdminCertsUpload(){
  const [file,setFile]=useState(null);
  const [result,setResult]=useState(null);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [mode,setMode]=useState("merge"); // merge | overwrite

  // Persistent snapshot — loads every time this page opens, same pattern as
  // User Provisioning and Tracker Import.
  const [summary,setSummary]=useState(null);
  const [summaryLoading,setSummaryLoading]=useState(true);
  const loadSummary=()=>{
    setSummaryLoading(true);
    fetch(`${BACKEND}/api/admin/certs/summary`,{credentials:"include"})
      .then(r=>r.json()).then(d=>{setSummary(d);setSummaryLoading(false);})
      .catch(()=>setSummaryLoading(false));
  };
  useEffect(()=>{ loadSummary(); },[]);

  function handleFile(e){
    const f=e.target.files[0];
    if(!f)return;
    if(!f.name.toLowerCase().endsWith(".xlsx")&&!f.name.toLowerCase().endsWith(".xls")){
      setError("Please choose a .xlsx file.");return;
    }
    setFile(f);setError("");setResult(null);
  }

  async function handleImport(){
    if(!file)return;
    setLoading(true);setResult(null);setError("");
    if(mode==="overwrite"){
      if(!window.confirm("Overwrite mode: this deletes all existing certifications before importing. Continue?")){
        setLoading(false); return;
      }
      try{
        const wr=await fetch(`${BACKEND}/api/admin/certs/wipe?confirm=WIPE`,{method:"DELETE",credentials:"include"});
        if(!wr.ok){setError("Could not clear existing certifications — import cancelled."); setLoading(false); return;}
      }catch(ex){setError("Could not reach the server."); setLoading(false); return;}
    }
    try{
      const fd=new FormData();
      fd.append("file",file);
      const res=await fetch(`${BACKEND}/api/admin/certs/import`,{
        method:"POST",credentials:"include",body:fd
      });
      const d=await res.json();
      if(!res.ok){setError(d.detail||"Import failed");return;}
      setResult(d); loadSummary();
    }catch(ex){setError("Import failed — check backend connection");}
    finally{setLoading(false);}
  }

  return(
    <div style={{maxWidth:900,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:20}}>
      <div>
        <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>Certification Import</div>
        <div style={{fontSize:13,color:P.muted,marginBottom:10}}>
          <b>Add & update:</b> existing records (matched by email + cert name) are updated; new ones inserted.<br/>
          <b>Overwrite all:</b> every existing certification is permanently deleted first, then this file is imported fresh.
        </div>
        <UploadModeToggle mode={mode} setMode={setMode}/>
      </div>

      {/* Currently on file — persists across visits */}
      <Card style={{padding:"16px 20px"}}>
        <div style={{fontSize:12,fontWeight:600,color:P.txt,marginBottom:10}}>Currently on file</div>
        {summaryLoading&&<div style={{fontSize:12.5,color:P.muted}}>Loading…</div>}
        {!summaryLoading&&summary&&summary.total_certs===0&&<div style={{fontSize:12.5,color:P.muted}}>No certifications on file yet.</div>}
        {!summaryLoading&&summary&&summary.total_certs>0&&(
          <>
            <div style={{display:"flex",gap:24,marginBottom:summary.by_status.length?10:0}}>
              <div><div style={{fontSize:20,fontWeight:600,color:P.txt}}>{summary.total_certs}</div><div style={{fontSize:11,color:P.dim}}>Certifications</div></div>
              <div><div style={{fontSize:20,fontWeight:600,color:P.txt}}>{summary.total_members}</div><div style={{fontSize:11,color:P.dim}}>Members</div></div>
            </div>
            <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
              {summary.by_status.map(s=>(
                <span key={s.status} style={{fontSize:12,color:P.txt,background:P.surface,borderRadius:6,padding:"3px 10px"}}>
                  {s.status}: <b>{s.n}</b>
                </span>
              ))}
            </div>
          </>
        )}
      </Card>

      <Card style={{padding:"16px 20px",background:P.blueGh,border:`1px solid ${P.blue}20`}}>
        <div style={{fontSize:12,fontWeight:600,color:P.blue,marginBottom:8}}>Expected Excel columns</div>
        <div style={{fontSize:12,color:P.muted,lineHeight:1.9}}>
          <b>Required:</b> email, cert_name &nbsp;|&nbsp; <b>Optional:</b> full_name, cert_type, status, issued_date, expiry_date<br/>
          Dates accepted as YYYY-MM-DD, MM/DD/YYYY, or DD/MM/YYYY.<br/>
          Status is auto-computed from expiry if omitted (≤90 days → Renew Soon, past → Expired, else Active).
        </div>
      </Card>
      <Card style={{padding:"20px 24px",display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
        <label style={{display:"inline-flex",alignItems:"center",gap:10,cursor:"pointer",
          background:P.blue,color:"#fff",borderRadius:8,padding:"9px 18px",fontSize:13,fontWeight:500}}>
          📎 Choose Excel file
          <input type="file" accept=".xlsx,.xls,.xlsm" style={{display:"none"}} onChange={handleFile}/>
        </label>
        {file&&<span style={{fontSize:12.5,color:P.grn,fontWeight:600}}>📄 {file.name}</span>}
        {error&&<div style={{fontSize:12.5,color:P.red}}>{error}</div>}
      </Card>
      {file&&!result&&(
        <Card style={{padding:"14px 20px"}}>
          <button onClick={handleImport} disabled={loading}
            style={{background:loading?P.muted:P.grn,color:"#fff",border:"none",borderRadius:8,
              padding:"9px 22px",fontSize:13,fontWeight:500,cursor:loading?"not-allowed":"pointer"}}>
            {loading?"Importing…":"Import"}
          </button>
        </Card>
      )}
      {result&&<Card style={{padding:"16px 20px",background:result.ok?P.grnBg:P.redLt,border:`1px solid ${result.ok?P.grn+"30":P.red+"30"}`}}>
        <div style={{fontSize:13,fontWeight:600,color:result.ok?P.grn:P.red,marginBottom:4}}>
          {result.ok?"Import complete":"Import failed"}
        </div>
        {result.ok&&<div style={{fontSize:12.5,color:P.muted}}>
          {result.inserted} inserted · {result.updated} updated · {result.skipped} skipped · {result.total} total rows processed
        </div>}
      </Card>}

      <DangerZoneWipe title="Wipe all certifications"
        description="Permanently deletes every certification record on file. Use this for a clean-slate re-import."
        endpoint="/api/admin/certs/wipe"
        onDone={()=>{loadSummary();setResult(null);}}/>
    </div>
  );
}

// ── MgrCertsView — Manager → Certifications tab (live, per-person accordion) ──
function MgrCertsView({setTab,managerEmail,managerName}){
  const [teamData,setTeamData]=useState(null);
  const [expanded,setExpanded]=useState({});
  const [loading,setLoading]=useState(true);
  const certsReqRef=useRef(0);

  useEffect(()=>{
    const reqId=++certsReqRef.current;
    setLoading(true);
    fetch(`${BACKEND}/api/certs/team?manager_email=${encodeURIComponent(managerEmail||'')}&manager_name=${encodeURIComponent(managerName||'')}`,{credentials:"include"})
      .then(r=>r.json())
      .then(d=>{if(reqId===certsReqRef.current){setTeamData(d.team||[]);setLoading(false);}})
      .catch(()=>{if(reqId===certsReqRef.current)setLoading(false);});
  },[managerEmail,managerName]);

  const allCerts=(teamData||[]).flatMap(m=>m.certs);
  const active  =allCerts.filter(c=>c.status==="Active").length;
  const expiring=allCerts.filter(c=>c.status==="Renew Soon").length;
  const expired =allCerts.filter(c=>c.status==="Expired").length;

  const statusColor=s=>s==="Active"?P.grn:s==="Renew Soon"?P.amber:s==="Expired"?P.red:P.blue;
  const statusBg   =s=>s==="Active"?P.grnBg:s==="Renew Soon"?P.amberBg:s==="Expired"?P.redLt:P.blueGh;
  const worstStatus=certs=>{
    if(certs.find(c=>c.status==="Expired"))return "Expired";
    if(certs.find(c=>c.status==="Renew Soon"))return "Renew Soon";
    if(certs.length>0)return "Active";
    return null;
  };

  return(
    <div style={{maxWidth:860,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>Team Certifications</div>
          <div style={{fontSize:13,color:P.muted}}>Sourced from Admin-uploaded Excel · click a person to expand their certifications</div>
        </div>
        <div style={{display:"flex",gap:8}}>
          {[["Active",active,P.grn,P.grnBg],["Renew Soon",expiring,P.amber,P.amberBg],["Expired",expired,P.red,P.redLt]].map(([l,n,c,bg])=>(
            <span key={l} style={{fontSize:12,fontWeight:600,color:c,background:bg,border:`1px solid ${c}20`,borderRadius:8,padding:"4px 12px"}}>{n} {l}</span>
          ))}
        </div>
      </div>

      {loading&&<div style={{fontSize:13,color:P.muted,textAlign:"center",padding:40}}>Loading certifications…</div>}

      {!loading&&(!teamData||teamData.length===0)&&(
        <Card style={{padding:"32px 24px",textAlign:"center"}}>
          <div style={{fontSize:22,marginBottom:12}}>📋</div>
          <div style={{fontSize:14,fontWeight:500,color:P.txt,marginBottom:6}}>No certification data yet</div>
          <div style={{fontSize:13,color:P.muted}}>Ask your Admin to upload the team certification Excel file via Admin → Certifications.</div>
        </Card>
      )}

      {!loading&&teamData&&teamData.map(member=>{
        const isOpen=expanded[member.email];
        const hasCerts=member.certs.length>0;
        const worst=worstStatus(member.certs);
        const initials=(member.full_name||member.email).split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
        return(
          <Card key={member.email} style={{overflow:"hidden"}}>
            <div style={{display:"flex",alignItems:"center",gap:14,padding:"16px 20px",
              cursor:hasCerts?"pointer":"default",
              borderBottom:isOpen&&hasCerts?`1px solid ${P.border}`:"none"}}
              onClick={()=>hasCerts&&setExpanded(e=>({...e,[member.email]:!e[member.email]}))}>
              <div style={{width:36,height:36,borderRadius:"50%",background:P.blue,flexShrink:0,
                display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:600,fontSize:13}}>
                {initials}
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:14,fontWeight:500,color:P.txt}}>{member.full_name||member.email}</div>
                <div style={{fontSize:11.5,color:P.muted}}>{member.email} · {member.certs.length} certification{member.certs.length!==1?"s":""}</div>
              </div>
              {worst&&<span style={{fontSize:11.5,fontWeight:600,padding:"3px 10px",borderRadius:6,flexShrink:0,
                color:statusColor(worst),background:statusBg(worst),border:`1px solid ${statusColor(worst)}30`}}>{worst}</span>}
              {!hasCerts&&<span style={{fontSize:12,color:P.muted,fontStyle:"italic",flexShrink:0}}>No certifications</span>}
              {hasCerts&&<span style={{fontSize:18,color:P.muted,flexShrink:0}}>{isOpen?"▾":"▸"}</span>}
            </div>
            {isOpen&&hasCerts&&(
              <div>
                {member.certs.map((c,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:14,padding:"12px 20px",
                    borderBottom:i<member.certs.length-1?`1px solid ${P.bfaint}`:"none",
                    background:i%2===0?"transparent":P.surface}}>
                    <span style={{fontSize:20,flexShrink:0}}>🎖</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:13.5,fontWeight:500,color:P.txt}}>{c.cert_name}</div>
                      <div style={{fontSize:11.5,color:P.muted}}>
                        {c.cert_type&&<span>{c.cert_type} · </span>}
                        {c.expiry_date?`Expires ${c.expiry_date}`:"No expiry"}
                        {c.days_remaining!=null&&<span style={{fontWeight:600,color:c.days_remaining<90?P.amber:P.muted}}> · {c.days_remaining}d remaining</span>}
                      </div>
                    </div>
                    <span style={{fontSize:11.5,fontWeight:600,padding:"3px 10px",borderRadius:6,flexShrink:0,
                      color:statusColor(c.status),background:statusBg(c.status),border:`1px solid ${statusColor(c.status)}30`}}>
                      {c.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function AdminDash({onLogout,groqKey,setGroqKey,githubToken,setGithubToken,callLog,judgeLog,telemetry=[],onToggleTheme,profile}){
  // Real IMS admins carry a profile (name/email) from ims_auth._resolve_account;
  // the static "Emma Wilson" demo persona (login picker, no IMS) has none.
  const adminName=profile?.name||"Emma Wilson";
  const adminInitial=(adminName[0]||"E").toUpperCase();
  const {mobile}=useViewport();
  const [tab,setTab]=useState("overview");
  const [keyInput,setKeyInput]=useState(groqKey);
  const [testing,setTesting]=useState(false);
  const [testResult,setTestResult]=useState(null);
  const [selectedAgent,setSelectedAgent]=useState("socratic");
  const [editedPrompt,setEditedPrompt]=useState("");
  const [testInput,setTestInput]=useState("");
  const [testResponse,setTestResponse]=useState("");
  const [testRunning,setTestRunning]=useState(false);
  const [agentPrompts,setAgentPrompts]=useState(null);
  const [dbStats,setDbStats]=useState(null);
  const [activeUserCount,setActiveUserCount]=useState(null);
  const [pendingManagers,setPendingManagers]=useState([]);
  const [mgrActionLoading,setMgrActionLoading]=useState(null);
  const [aiSafety,setAiSafety]=useState(null);
  const [providerStatus,setProviderStatus]=useState(null);

  const loadPendingManagers=()=>{
    fetch(`${BACKEND}/api/manager/pending`).then(r=>r.json()).then(d=>setPendingManagers(d?.pending||[])).catch(()=>{});
  };
  useEffect(()=>{loadPendingManagers();const iv=setInterval(loadPendingManagers,30000);return()=>clearInterval(iv);},[]);

  const actionManager=async(id,action)=>{
    setMgrActionLoading(id);
    try{
      await fetch(`${BACKEND}/api/manager/${id}/action`,{method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action,actioned_by:adminName})});
      setPendingManagers(prev=>prev.filter(m=>m.id!==id));
    }catch(e){console.warn("Manager action failed",e);}
    setMgrActionLoading(null);
  };

  // AI Safety tab — real cross-agent guardrail + RAGAS data (not just the
  // Socratic-only client-session judgeLog). Loaded on mount + every 30s so the
  // admin sees live activity from other users' sessions, not just this tab.
  useEffect(()=>{
    const load=()=>fetch(`${BACKEND}/api/admin/ai-safety`).then(r=>r.json()).then(setAiSafety).catch(()=>{});
    load();
    const iv=setInterval(load,30000);
    return()=>clearInterval(iv);
  },[]);

  // Integrations tab — real server-side provider key presence + fallback
  // order (booleans only, never the actual keys).
  useEffect(()=>{
    fetch(`${BACKEND}/api/agents/status`).then(r=>r.json()).then(setProviderStatus).catch(()=>{});
  },[]);

  // Agent Studio — the REAL current system prompt for every agent, read
  // straight from the running backend code (agents/*.py). Seeds the sandbox
  // editor with socratic's real prompt once loaded.
  useEffect(()=>{
    fetch(`${BACKEND}/api/admin/agent-prompts`).then(r=>r.json()).then(d=>{
      setAgentPrompts(d);
      setEditedPrompt(d?.prompts?.socratic?.text||"");
    }).catch(()=>{});
  },[]);

  // Load DB stats on mount and every 30s
  useEffect(()=>{
    const load=()=>fetch(`${BACKEND}/api/stats`).then(r=>r.json()).then(setDbStats).catch(()=>{});
    load();
    const interval=setInterval(load,30000);
    return()=>clearInterval(interval);
  },[]);

  // Real active-user count (was hardcoded to "4") — reuses the same endpoint
  // the All Users tab already calls, just for the count on the Overview KPI.
  useEffect(()=>{
    const load=()=>fetch(`${BACKEND}/api/admin/users`,{credentials:"include"}).then(r=>r.ok?r.json():null)
      .then(d=>{if(typeof d?.total==="number")setActiveUserCount(d.total);}).catch(()=>{});
    load();
    const interval=setInterval(load,30000);
    return()=>clearInterval(interval);
  },[]);

  const tabs=[
    {id:"overview",  label:"Dashboard",       icon:Home},
    {id:"mgrapprovals",label:"Manager Approvals",icon:CheckmarkCircle,badge:pendingManagers.length>0?String(pendingManagers.length):null},
    {id:"llmops",    label:"LLM Operations",  icon:Cloud},
    {id:"guardrails",label:"AI Safety",       icon:Lock},
    {id:"promptlab", label:"Agent Studio",    icon:Code},
    {id:"keys",      label:"Integrations",    icon:Key},
    {id:"directory", label:"User Provisioning", icon:PeopleGroup},
    {id:"certmgmt",  label:"Certifications",   icon:Ribbon},
    {id:"trackerimport", label:"Tracker Import", icon:Data},
    {id:"tracks",    label:"Reasoning Config",  icon:MagicWand},
    {id:"orgdata",   label:"Org Data",         icon:Building},
    {id:"validate",  label:"Data Validation",  icon:CheckmarkCircle},
  ];

  // NOTE: ok:true here means "real, working integration" — not a decorative
  // green dot. ALM Tier 2/3, Slack MCP, and Workfront MCP were never built
  // (no backend anywhere in the code) and have been removed rather than shown
  // as "Not implemented" placeholders.
  const pk=providerStatus?.provider_keys_configured||{};
  const apiRows=[
    {name:"OpenAI API",   ok:!!pk.openai,   detail:pk.openai?"Configured · gpt-4o-mini":"OPENAI_API_KEY not set on backend",note:"Primary provider for every agent",latency:pk.openai?"~1-2s":"—"},
    {name:"Anthropic API",ok:!!pk.anthropic,detail:pk.anthropic?"Configured · claude fallback":"ANTHROPIC_API_KEY not set on backend",note:"2nd fallback (plain calls only — not tool-calling)",latency:pk.anthropic?"~1.5s":"—"},
    {name:"Groq API",     ok:!!pk.groq,     detail:pk.groq?"Configured · openai/gpt-oss-20b":"GROQ_API_KEY not set on backend",note:"3rd fallback / free tier",latency:pk.groq?"~0.6s":"—"},
    {name:"AdobeDocs RAG",ok:true, detail:"pgvector + LlamaIndex hybrid retrieval",note:"GitHub-backed doc corpus; live when a GitHub token is set below, local fallback otherwise",latency:githubToken?"live":"local fallback"},
  ];

  const users=[
    {name:"Alex Carter",  role:"New Joiner",   module:"4/9",conf:62,status:"⚠ At Risk",last:"2h ago",c:P.blue},
    {name:"Jennifer Park",role:"Analytics Eng",module:"Track set",conf:88,status:"✓ Active",last:"1h ago",c:P.grn},
    {name:"Rachel Kim",   role:"Data Engineer",module:"Track set",conf:91,status:"✓ Active",last:"30m ago",c:P.grn},
    {name:"Kate Moore",   role:"Analytics Eng",module:"Track set",conf:85,status:"✓ Active",last:"3h ago",c:P.grn},
  ];

  const testGroq=async()=>{
    if(!keyInput.trim().startsWith("gsk_"))return setTestResult({ok:false,msg:"Key must start with gsk_"});
    setTesting(true);setTestResult(null);
    try{
      const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${keyInput.trim()}`},body:JSON.stringify({model:"openai/gpt-oss-20b",max_tokens:10,messages:[{role:"user",content:"Say OK"}]})});
      const d=await r.json();
      if(d.error)setTestResult({ok:false,msg:d.error.message});
      else{setGroqKey(keyInput.trim());localStorage.setItem("nexus_groq_key",keyInput.trim());setTestResult({ok:true,msg:"Connected! Key saved. All agents now use GPT-OSS-20B."});}
    }catch(e){setTestResult({ok:false,msg:`${e.message} (CORS if not running locally)`});}
    setTesting(false);
  };

  // M9 aggregate metrics
  const totalCalls=dbStats?.llm?.total||callLog.length;
  const totalTokens=dbStats?.llm?.tokens||callLog.reduce((s,c)=>s+(c.totalTokens||0),0);
  const avgLatency=callLog.length?Math.round(callLog.reduce((s,c)=>s+c.latency,0)/callLog.length):0;
  const successRate=callLog.length?Math.round(callLog.filter(c=>c.ok).length/callLog.length*100):100;
  // Prefer the real per-agent breakdown from the DB (/api/stats → by_agent),
  // which covers EVERY agent that logged to llm_logs (Reasoning, Study Aid,
  // Practice, Capstone, RAG, CrossSkilling, Curriculum, Socratic, …). Fall back
  // to this session's in-memory callLog only when the DB view is unavailable.
  const byAgent=(dbStats?.by_agent?.length
    ? dbStats.by_agent.map(a=>({
        agent:a.agent_name||"Agent",
        calls:Number(a.calls)||0,
        tokens:Number(a.tokens)||0,
        latency:a.avg_latency!=null?Number(a.avg_latency):0,
        model:a.model||"—",
      }))
    : [...new Set(callLog.map(c=>c.agent))].map(a=>{
        const rows=callLog.filter(c=>c.agent===a);
        return{agent:a,calls:rows.length,tokens:rows.reduce((s,c)=>s+(c.totalTokens||0),0),latency:rows.length?Math.round(rows.reduce((s,c)=>s+c.latency,0)/rows.length):0,model:rows[0]?.model||"—"};
      }));

  // M8 aggregate metrics
  const judgeTotal=judgeLog.length;
  const judgePass=judgeLog.filter(j=>j.score>=7).length;
  const pctQ=judgeTotal?Math.round(judgeLog.filter(j=>j.hasOneQuestion).length/judgeTotal*100):100;
  const pctSafe=judgeTotal?Math.round(judgeLog.filter(j=>j.avoidsDirectAnswer).length/judgeTotal*100):100;
  const pctWords=judgeTotal?Math.round(judgeLog.filter(j=>j.wordCount<=55).length/judgeTotal*100):100;
  const avgScore=judgeTotal?Math.round(judgeLog.reduce((s,j)=>s+j.score,0)/judgeTotal*10)/10:0;

  return(<div style={{display:"flex",flexDirection:"column",height:"100vh",fontFamily:"'adobe-clean','Source Sans 3',system-ui,sans-serif",background:P.bg}}>
    <GlobalStyles/>
    <Nav initial={adminInitial} name={adminName} sub="Platform Admin · Nexus" color={P.purple} persona="admin" onLogout={onLogout} onToggleTheme={onToggleTheme}/>
    {mobile?<Tabs items={tabs} active={tab} onChange={setTab}/>:<SideNav items={tabs} active={tab} onChange={setTab}/>}
    <div className="nx-main-content" style={{flex:1,overflowY:"auto",paddingLeft:mobile?0:SIDENAV_WIDTH}}>

      {/* OVERVIEW */}
      {tab==="overview"&&<div style={{maxWidth:800,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:20}}>
        {/* KPIs */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
          {[
            {l:"Active Users",v:activeUserCount!=null?String(activeUserCount):"—",s:activeUserCount!=null?"registered accounts":"sign in as admin to load"},
            {l:"Services Connected",v:`${apiRows.filter(r=>r.ok).length} of ${apiRows.length}`,s:"API health"},
            {l:"Agent Calls",v:String(totalCalls||0),s:dbStats?"from database":"this session"},
            {l:"Token Usage",v:totalTokens?totalTokens.toLocaleString():"0",s:"this session"},
          ].map(k=>(
            <Card key={k.l} style={{padding:"18px 20px"}}>
              <div style={{fontSize:22,fontWeight:500,color:P.txt,marginBottom:4}}>{k.v}</div>
              <div style={{fontSize:13,fontWeight:500,color:P.txt,marginBottom:2}}>{k.l}</div>
              <div style={{fontSize:11.5,color:P.muted}}>{k.s}</div>
            </Card>
          ))}
        </div>

        {/* Service status */}
        <Card>
          <div style={{padding:"14px 20px",borderBottom:`1px solid ${P.border}`}}>
            <div style={{fontSize:14,fontWeight:600,color:P.txt}}>Service Status</div>
          </div>
          {apiRows.map((s,i)=>(
            <div key={s.name} style={{display:"flex",alignItems:"center",gap:14,padding:"13px 20px",borderBottom:i<apiRows.length-1?`1px solid ${P.bfaint}`:"none"}}>
              <StatusDot ok={s.ok}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13.5,fontWeight:500,color:P.txt,marginBottom:2}}>{s.name}</div>
                <div style={{fontSize:12,color:s.ok?P.muted:P.red}}>{s.detail}</div>
              </div>
              <span style={{fontSize:11.5,color:P.dim,flexShrink:0,background:P.surface,borderRadius:5,padding:"2px 9px"}}>{s.latency}</span>
            </div>
          ))}
        </Card>

        {/* Guardrail + Token */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <Card style={{padding:"20px"}}>
            <Label style={{marginBottom:12}}>Guardrail Compliance</Label>
            <div style={{fontSize:28,fontWeight:500,color:judgeTotal?avgScore>=7?P.grn:P.amber:P.dim,marginBottom:4}}>
              {judgeTotal?`${avgScore}/10`:"No evals yet"}
            </div>
            <div style={{fontSize:12,color:P.muted}}>{judgeTotal} responses evaluated this session</div>
          </Card>
          <Card style={{padding:"20px"}}>
            <Label style={{marginBottom:12}}>Average Latency</Label>
            <div style={{fontSize:28,fontWeight:500,color:avgLatency?P.blue:P.dim,marginBottom:4}}>
              {avgLatency?`${avgLatency}ms`:"—"}
            </div>
            <div style={{fontSize:12,color:P.muted}}>{`${successRate}% success rate · ${callLog.length} calls`}</div>
          </Card>
        </div>
      </div>}

      {/* LLM OPERATIONS */}
      {tab==="llmops"&&<div style={{maxWidth:800,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:20}}>
        <div>
          <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>LLM Operations</div>
          <div style={{fontSize:13,color:P.muted}}>{dbStats?"Totals sourced from PostgreSQL · live call log below":"Live metrics captured from API responses this session"}</div>
        </div>
        {/* Summary KPIs */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
          {[{l:"Total Calls",v:String(totalCalls||0)},{l:"Total Tokens",v:totalTokens.toLocaleString()},{l:"Avg Latency",v:avgLatency?`${avgLatency}ms`:"—"},{l:"Success Rate",v:`${successRate}%`}].map(k=>(
            <Card key={k.l} style={{padding:"16px 18px"}}>
              <div style={{fontSize:20,fontWeight:500,color:P.txt,marginBottom:4}}>{k.v}</div>
              <div style={{fontSize:12,color:P.muted}}>{k.l}</div>
            </Card>
          ))}
        </div>
        {/* Per-agent breakdown */}
        <Card>
          <div style={{padding:"14px 20px",borderBottom:`1px solid ${P.border}`}}>
            <div style={{fontSize:14,fontWeight:600,color:P.txt}}>Per-Agent Breakdown</div>
          </div>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr style={{background:P.surface}}>{["Agent","Calls","Tokens","Avg Latency","Model"].map(h=><th key={h} style={{padding:"10px 20px",textAlign:"left",fontSize:11,fontWeight:600,color:P.muted,borderBottom:`1px solid ${P.border}`}}>{h}</th>)}</tr></thead>
            <tbody>
              {byAgent.map((a,i)=>(
                <tr key={a.agent} style={{borderBottom:i<byAgent.length-1?`1px solid ${P.bfaint}`:"none"}}>
                  <td style={{padding:"12px 20px",fontSize:13.5,fontWeight:500,color:P.txt}}>{a.agent}</td>
                  <td style={{padding:"12px 20px",fontSize:13,color:P.txt}}>{a.calls}</td>
                  <td style={{padding:"12px 20px",fontSize:13,color:P.txt}}>{a.tokens.toLocaleString()}</td>
                  <td style={{padding:"12px 20px",fontSize:13,color:a.latency>2000?P.red:P.txt}}>{a.latency?`${a.latency}ms`:"—"}</td>
                  <td style={{padding:"12px 20px",fontSize:12,color:P.muted}}>{a.model}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        {/* Call log */}
        <Card>
          <div style={{padding:"14px 20px",borderBottom:`1px solid ${P.border}`}}>
            <div style={{fontSize:14,fontWeight:600,color:P.txt}}>Recent Calls</div>
            <div style={{fontSize:12,color:P.muted,marginTop:2}}>Last {Math.min(callLog.length,20)} calls this session</div>
          </div>
          {callLog.length===0&&<div style={{padding:"24px 20px",fontSize:13,color:P.muted}}>No calls yet — interact with any agent to see live metrics.</div>}
          {callLog.slice(0,20).map((c,i)=>(
            <div key={c.id} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 20px",borderBottom:i<Math.min(callLog.length,20)-1?`1px solid ${P.bfaint}`:"none"}}>
              <StatusDot ok={c.ok}/>
              <span style={{fontSize:13,fontWeight:500,color:P.txt,minWidth:100}}>{c.agent}</span>
              <span style={{fontSize:12,color:P.muted,flex:1}}>{c.model}</span>
              <span style={{fontSize:12,color:P.txt,minWidth:60}}>{c.totalTokens} tok</span>
              <span style={{fontSize:12,color:c.latency>2000?P.red:P.muted,minWidth:60}}>{c.latency}ms</span>
              <span style={{fontSize:11,color:P.dim}}>{c.ts}</span>
            </div>
          ))}
        </Card>
      </div>}

      {/* AI Safety */}
      {tab==="guardrails"&&(()=>{
        const GUARDRAIL_COVERAGE=[
          {agent:"Curriculum",mechanism:"Injection/unsafe input gate + a dedicated redirect guardrail node (out-of-scope questions route to Reasoning/Socratic instead of answering off-topic)."},
          {agent:"Reasoning",mechanism:"Injection/unsafe input gate + its own richer pipeline: tool-call validation, an LLM quality judge with retry, and a degraded-response flag."},
          {agent:"Socratic",mechanism:"Injection/unsafe input gate + a second LLM-judge call on every response (exactly 1 question, no direct answer, under 55 words) — see live log below."},
          {agent:"CrossSkilling",mechanism:"Injection/unsafe input gate + a lightweight heuristic response check (length, refusal, AEP-domain-term presence) logged per response."},
          {agent:"Capstone",mechanism:"Injection/unsafe input gate + the same heuristic response check + RAGAS faithfulness/relevancy/precision scoring on its search_docs grounding."},
          {agent:"Practice Scenario",mechanism:"Injection/unsafe input gate + the same heuristic response check + a fictional-company/invented-feature validation pass + RAGAS scoring on its retrieved docs."},
          {agent:"Study Aid",mechanism:"Injection/unsafe input gate + RAGAS scoring on its curriculum-topics or search_docs grounding."},
          {agent:"RAG (DocSearch)",mechanism:"Injection/unsafe input gate + an output guard step (checks the answer is actually grounded in retrieved docs) + RAGAS scoring on every retrieval."},
          {agent:"Team Intel",mechanism:"Injection/unsafe input gate only (generic LLM proxy — no retrieval, so no RAGAS applies)."},
        ];
        const ragasSummary=aiSafety?.ragas_summary||{};
        const ragasRecent=aiSafety?.ragas_recent||[];
        const blocks=aiSafety?.injection_blocks_by_agent||[];
        const genericScores=aiSafety?.generic_guardrail_by_agent||[];
        const pct=v=>v==null?"—":`${Math.round(v*100)}%`;
        // Server-configured thresholds (RAGAS_GOOD_THRESHOLD/RAGAS_WARN_THRESHOLD
        // in backend .env) — read from the API instead of hardcoding here, so the
        // UI can never drift out of sync with what the backend actually uses.
        const ragasT=aiSafety?.ragas_thresholds||{good:0.7,warn:0.4};
        const ragasColor=v=>v==null?P.muted:v>=ragasT.good?P.grn:v>=ragasT.warn?P.amber:P.red;
        return(
        <div style={{maxWidth:960,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:20}}>
        <div>
          <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>AI Safety</div>
          <div style={{fontSize:13,color:P.muted}}>Real, live guardrail and RAG-quality data across all 9 agents — not just Socratic.</div>
        </div>

        {/* Coverage reference table */}
        <Card style={{overflow:"hidden"}}>
          <div style={{padding:"14px 20px",borderBottom:`1px solid ${P.border}`,fontSize:14,fontWeight:600,color:P.txt}}>Guardrail coverage by agent</div>
          {GUARDRAIL_COVERAGE.map((g,i)=>(
            <div key={g.agent} style={{padding:"12px 20px",borderBottom:i<GUARDRAIL_COVERAGE.length-1?`1px solid ${P.bfaint}`:"none",display:"flex",gap:14}}>
              <div style={{width:130,flexShrink:0,fontSize:12.5,fontWeight:600,color:P.txt}}>{g.agent}</div>
              <div style={{fontSize:12.5,color:P.muted,lineHeight:1.55}}>{g.mechanism}</div>
            </div>
          ))}
        </Card>

        {/* Live injection/unsafe blocks */}
        <Card style={{overflow:"hidden"}}>
          <div style={{padding:"14px 20px",borderBottom:`1px solid ${P.border}`,fontSize:14,fontWeight:600,color:P.txt}}>Injection / unsafe input blocks (live, all agents)</div>
          {blocks.length===0
            ?<div style={{padding:20,fontSize:12.5,color:P.muted}}>No blocked requests yet across any agent.</div>
            :blocks.map((b,i)=>(
              <div key={b.agent_name} style={{padding:"10px 20px",borderBottom:i<blocks.length-1?`1px solid ${P.bfaint}`:"none",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12.5,fontWeight:600,color:P.txt}}>{b.agent_name}</span>
                <span style={{fontSize:12,color:P.red,fontWeight:600}}>{b.blocked_count} blocked</span>
                <span style={{fontSize:11,color:P.dim}}>last: {new Date(b.last_blocked).toLocaleString()}</span>
              </div>
            ))}
        </Card>

        {/* RAGAS quality scores */}
        <Card style={{overflow:"hidden"}}>
          <div style={{padding:"14px 20px",borderBottom:`1px solid ${P.border}`,fontSize:14,fontWeight:600,color:P.txt}}>RAG quality (RAGAS) by agent</div>
          {Object.keys(ragasSummary).length===0
            ?<div style={{padding:20,fontSize:12.5,color:P.muted}}>No RAG-grounded generations scored yet — evaluations run automatically (in the background) whenever Curriculum, Capstone, Practice, Study Aid, or RAG retrieve real content. If this stays empty even after using those agents, check the backend console for a "[ragas_eval] DISABLED" warning — scoring specifically requires OPENAI_API_KEY (Groq/Anthropic keys don't cover it).</div>
            :<div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12.5}}>
                <thead><tr style={{textAlign:"left"}}>
                  {["Agent","Samples","Faithfulness","Answer relevancy","Context utilization","Below threshold","Errors"].map(h=>(
                    <th key={h} style={{padding:"8px 20px",color:P.dim,fontWeight:600,fontSize:11}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {Object.values(ragasSummary).map(r=>(
                    <tr key={r.agent} style={{borderTop:`1px solid ${P.bfaint}`}}>
                      <td style={{padding:"8px 20px",fontWeight:600,color:P.txt}}>{r.agent}</td>
                      <td style={{padding:"8px 20px",color:P.muted}}>{r.n}</td>
                      <td style={{padding:"8px 20px",color:ragasColor(r.avg_faithfulness)}}>{pct(r.avg_faithfulness)}</td>
                      <td style={{padding:"8px 20px",color:ragasColor(r.avg_answer_relevancy)}}>{pct(r.avg_answer_relevancy)}</td>
                      <td style={{padding:"8px 20px",color:ragasColor(r.avg_context_utilization)}}>{pct(r.avg_context_utilization)}</td>
                      <td style={{padding:"8px 20px",color:r.below_threshold>0?P.amber:P.muted}}>{r.below_threshold??"—"}</td>
                      <td style={{padding:"8px 20px",color:r.error_count>0?P.red:P.muted}}>{r.error_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{padding:"8px 20px 14px",fontSize:11,color:P.dim}}>
                "Errors" rows have no real scores (e.g. missing OPENAI_API_KEY) — they aren't low-quality answers, they're un-scored ones. "Below threshold" counts real (scored) rows where any metric fell below {pct(ragasT.warn)} — the amber/red bands below {pct(ragasT.good)}/{pct(ragasT.warn)} are configurable via RAGAS_GOOD_THRESHOLD/RAGAS_WARN_THRESHOLD in the backend .env. "Context utilization" is ragas's reference-free stand-in for context precision (this deployment has no human-labeled ground-truth answers to measure true precision against).
              </div>
            </div>}
        </Card>

        {ragasRecent.length>0&&<Card style={{overflow:"hidden"}}>
          <div style={{padding:"14px 20px",borderBottom:`1px solid ${P.border}`,fontSize:14,fontWeight:600,color:P.txt}}>Recent RAGAS evaluations</div>
          {ragasRecent.slice(0,10).map(r=>(
            <div key={r.id} style={{padding:"12px 20px",borderBottom:`1px solid ${P.bfaint}`}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
                <span style={{fontSize:11,fontWeight:700,color:P.purple,background:P.purpleBg,borderRadius:5,padding:"1px 8px"}}>{r.agent}</span>
                <span style={{fontSize:12,color:ragasColor(r.faithfulness)}}>Faithfulness {pct(r.faithfulness)}</span>
                <span style={{fontSize:12,color:ragasColor(r.answer_relevancy)}}>Relevancy {pct(r.answer_relevancy)}</span>
                <span style={{fontSize:12,color:ragasColor(r.context_utilization)}}>Utilization {pct(r.context_utilization)}</span>
                {r.error&&<span style={{fontSize:11,color:P.red,background:P.redLt,borderRadius:5,padding:"1px 8px"}}>⚠ {r.error}</span>}
                <span style={{marginLeft:"auto",fontSize:11,color:P.dim}}>{new Date(r.created_at).toLocaleString()}</span>
              </div>
              <div style={{fontSize:12,color:P.muted,fontStyle:"italic"}}>"{(r.query||"").slice(0,140)}"</div>
            </div>
          ))}
        </Card>}

        {/* Generic per-agent heuristic guardrail (Capstone/CrossSkilling/Practice) */}
        {genericScores.length>0&&<Card style={{overflow:"hidden"}}>
          <div style={{padding:"14px 20px",borderBottom:`1px solid ${P.border}`,fontSize:14,fontWeight:600,color:P.txt}}>Response quality heuristic (live, all agents)</div>
          {genericScores.map((g,i)=>(
            <div key={g.agent_name} style={{padding:"10px 20px",borderBottom:i<genericScores.length-1?`1px solid ${P.bfaint}`:"none",display:"flex",justifyContent:"space-between"}}>
              <span style={{fontSize:12.5,fontWeight:600,color:P.txt}}>{g.agent_name}</span>
              <span style={{fontSize:12,color:g.avg_score>=70?P.grn:g.avg_score>=50?P.amber:P.red}}>{Math.round(g.avg_score)}/100 avg</span>
              <span style={{fontSize:11,color:P.dim}}>{g.total} scored</span>
            </div>
          ))}
        </Card>}

        {/* Socratic LLM-judge — live session data */}
        <div style={{fontSize:13,fontWeight:600,color:P.txt,marginTop:4}}>Socratic Agent — live session judge</div>
        {judgeTotal===0
          ?<Card style={{padding:"32px",textAlign:"center"}}><div style={{fontSize:14,color:P.muted}}>No evaluations yet this session — start a Socratic session in the NJ dashboard to see live results.</div></Card>
          :<>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
              {[{l:"Avg Quality",v:`${avgScore}/10`,c:avgScore>=7?P.grn:P.amber},{l:"Single Question",v:`${pctQ}%`,c:pctQ>=90?P.grn:P.amber},{l:"No Direct Answer",v:`${pctSafe}%`,c:pctSafe>=90?P.grn:P.amber},{l:"Under 55 Words",v:`${pctWords}%`,c:pctWords>=90?P.grn:P.amber}].map(k=>(
                <Card key={k.l} style={{padding:"18px 20px"}}>
                  <div style={{fontSize:22,fontWeight:500,color:k.c,marginBottom:4}}>{k.v}</div>
                  <div style={{fontSize:12,color:P.muted}}>{k.l}</div>
                </Card>
              ))}
            </div>
            <Card>
              <div style={{padding:"14px 20px",borderBottom:`1px solid ${P.border}`}}>
                <div style={{fontSize:14,fontWeight:600,color:P.txt}}>Evaluation Log</div>
              </div>
              {judgeLog.slice(0,15).map((j,i)=>(
                <div key={j.id} style={{padding:"12px 20px",borderBottom:i<judgeLog.slice(0,15).length-1?`1px solid ${P.bfaint}`:"none"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
                    <span style={{fontSize:12,fontWeight:600,padding:"2px 9px",borderRadius:5,background:j.score>=7?P.grnBg:j.score>=5?P.amberBg:P.redBg,color:j.score>=7?P.grn:j.score>=5?P.amber:P.red}}>{j.score}/10</span>
                    <span style={{fontSize:12,color:P.muted}}>{j.wordCount}w</span>
                    <span style={{fontSize:12,color:j.hasOneQuestion?P.grn:P.red}}>{j.hasOneQuestion?"Question ✓":"No question"}</span>
                    <span style={{fontSize:12,color:j.avoidsDirectAnswer?P.grn:P.red}}>{j.avoidsDirectAnswer?"Safe ✓":"Gave answer"}</span>
                    <span style={{marginLeft:"auto",fontSize:11,color:P.dim}}>{j.ts}</span>
                  </div>
                  <div style={{fontSize:12,color:P.muted,fontStyle:"italic"}}>"{j.text}…"</div>
                </div>
              ))}
            </Card>
          </>}
        <Card style={{padding:"16px 20px",background:P.blueGh,border:`1px solid ${P.blue}20`}}>
          <div style={{fontSize:13,fontWeight:600,color:P.blue,marginBottom:6}}>How this page works</div>
          <div style={{fontSize:13,color:P.txt,lineHeight:1.7}}>Every agent call passes through a shared injection/unsafe-input gate before reaching any model (blocks logged above). RAG-grounded agents are additionally scored by RAGAS — a real evaluation library, not a hand-rolled heuristic — for faithfulness (is the answer actually supported by what was retrieved), answer relevancy, and context precision, run in the background after the response is already sent so scoring never adds latency. Socratic's second-LLM-judge and the other agents' lightweight heuristic checks are session/domain-specific quality layers on top of that shared foundation.</div>
        </Card>
      </div>);
      })()}

      {/* Behavioural Data */}
      {tab==="telemetry"&&<div style={{maxWidth:800,margin:"0 auto",padding:"28px 24px",display:"flex",flexDirection:"column",gap:20}}>
        <div>
          <div style={{fontSize:18,fontWeight:500,color:P.txt,marginBottom:4}}>Behavioural Data</div>
          <div style={{fontSize:13,color:P.muted}}>IRT and BKT signals, session events, and at-risk detection derived from learner interactions.</div>
        </div>
        {/* At-risk signals */}
        <div style={{display:"flex",gap:10,marginBottom:16}}>
          {["nj","exp","mgr"].map(persona=>{
            const score=TELEMETRY.atRiskScore(telemetry,persona);
            const name=PROFILES[persona].name;
            const col=TELEMETRY.levelColor(score,P);
            const bg=score>0.6?P.redBg:score>0.3?P.amberBg:P.grnBg;
            return(<div key={persona} style={{flex:1,background:P.panel,border:`1px solid ${P.border}`,borderRadius:9,padding:"12px 14px",boxShadow:"0 1px 4px rgba(0,0,0,.06)",borderTop:`3px solid ${col}`}}>
              <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:6}}>
                <div style={{width:24,height:24,borderRadius:"50%",background:PROFILES[persona].color,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:500,fontSize:10}}>{PROFILES[persona].initial}</div>
                <span style={{fontSize:12.5,fontWeight:500,color:P.txt}}>{name.split(" ")[0]}</span>
              </div>
              <div style={{height:4,background:P.bfaint,borderRadius:2,marginBottom:6,overflow:"hidden"}}><div style={{height:"100%",width:`${score*100}%`,background:col,borderRadius:2}}/></div>
              <span style={{fontSize:11,fontWeight:500,color:col,background:bg,padding:"1px 8px",borderRadius:4}}>{TELEMETRY.levelLabel(score)}</span>
              <div style={{fontSize:10.5,color:P.dim,marginTop:4}}>score: {(score*100).toFixed(0)}%</div>
            </div>);
          })}
        </div>
        {/* Event log */}
        <Card style={{overflow:"hidden",marginBottom:14}}>
          <div style={{padding:"10px 16px",background:P.bg,borderBottom:`1px solid ${P.bfaint}`,fontSize:11,fontWeight:500,color:P.dim,letterSpacing:.5,textTransform:"uppercase"}}>Event Log · Last {telemetry.length} events</div>
          {telemetry.slice().reverse().slice(0,15).map((e,i)=>{
            const typeColor={module_view:P.blue,chat_msg:P.purple,quiz_fail:P.red,cat_complete:P.grn,conf_update:P.amber}[e.type]||P.muted;
            return(<div key={e.id} style={{display:"flex",alignItems:"center",gap:12,padding:"9px 16px",borderBottom:i<14?`1px solid ${P.bfaint}`:"none"}}>
              <span style={{width:8,height:8,borderRadius:"50%",background:typeColor,flexShrink:0}}/>
              <span style={{width:80,fontSize:11.5,fontWeight:600,color:typeColor,flexShrink:0}}>{e.type.replace("_"," ")}</span>
              <span style={{width:28,fontSize:11,color:P.dim,flexShrink:0}}>{e.persona?.toUpperCase()}</span>
              <span style={{flex:1,fontSize:12,color:P.txt}}>{e.detail}</span>
              <span style={{fontSize:11,color:P.dim,flexShrink:0}}>{e.ts}</span>
            </div>);
          })}
        </Card>
        {/* IRT item info explainer */}
        <Card style={{padding:14,background:P.blueGh,border:`1px solid #C0DAFF`}}>
          <div style={{fontSize:12,fontWeight:500,color:P.blueDk,marginBottom:4}}>How the ML engines work</div>
          <div style={{fontSize:12,color:P.txt,lineHeight:1.7}}>
            <strong>CAT (Computerised Adaptive Testing)</strong> selects each question to maximise Fisher information at the current ability estimate — so strong learners get harder questions and weaker learners get easier ones. Uses the 2PL IRT model.<br/>
            <strong>IRT (Item Response Theory)</strong> estimates learner ability θ via Newton-Raphson MLE after each response. θ maps to proficiency levels: expert (≥1.5), proficient (≥0.3), developing (≥−0.5), none (&lt;−0.5).<br/>
            <strong>BKT (Bayesian Knowledge Tracing)</strong> updates P(mastery) via a hidden Markov model after every quiz response, tracking knowledge state over time independently of IRT.<br/>
            <strong>Telemetry anomaly detection</strong> flags plateau (repeated failures), session drop (low interaction frequency), and confidence stall (no improvement over 3+ sessions).
          </div>
        </Card>
      </div>}

      {tab==="org"&&<div style={{maxWidth:760,margin:"0 auto"}}>
        <div style={{fontSize:14,fontWeight:500,color:P.txt,marginBottom:4}}>Org Analytics · L&D Leadership View</div>
        <div style={{fontSize:12,color:P.muted,marginBottom:16}}>Cohort velocity, skill coverage and compliance. Org-wide skill/cert aggregation isn't backed by a real endpoint yet — see the labeled illustrative section below. "DB Events" is the one real, live figure here.</div>

        {/* KPI row — DB Events is real (from /api/stats); the other 3 belong to
            the illustrative demo cohort below, not a real org-wide count. */}
        <div style={{display:"flex",gap:12,marginBottom:8}}>
          <Card style={{flex:1,padding:"14px 16px",borderTop:`2px solid ${P.purple}`}}>
            <div style={{fontSize:22,fontWeight:600,color:P.txt}}>{dbStats?.telemetry?.total||"—"}</div>
            <div style={{fontSize:12,fontWeight:500,color:P.txt,marginTop:2}}>DB Events</div>
            <div style={{fontSize:11,color:P.muted}}>logged interactions (real)</div>
          </Card>
        </div>
        <div style={{fontSize:11,fontWeight:600,color:P.dim,letterSpacing:.4,textTransform:"uppercase",margin:"12px 0 8px"}}>Illustrative demo cohort — not real org data</div>
        <div style={{display:"flex",gap:12,marginBottom:16}}>
          {[
            {l:"Active Learners",v:String(TEAM.length),s:"this demo cohort",c:P.blue},
            {l:"Avg Confidence",v:`${Math.round(TEAM.reduce((s,m)=>s+m.conf,0)/TEAM.length*100)}%`,s:"across modules",c:P.grn},
            {l:"At Risk",v:`${TEAM.filter(m=>m.risk).length}`,s:"flagged by Curriculum Agent",c:P.red},
          ].map((k,i)=>(
            <Card key={i} style={{flex:1,padding:"14px 16px",borderTop:`2px solid ${k.c}`}}>
              <div style={{fontSize:22,fontWeight:600,color:P.txt}}>{k.v}</div>
              <div style={{fontSize:12,fontWeight:500,color:P.txt,marginTop:2}}>{k.l}</div>
              <div style={{fontSize:11,color:P.muted}}>{k.s}</div>
            </Card>
          ))}
        </div>

        {/* Team skill heatmap */}
        <Card style={{padding:20,marginBottom:14}}>
          <div style={{fontSize:13,fontWeight:500,color:P.txt,marginBottom:12}}>Skill Coverage Heatmap <span style={{fontSize:10.5,fontWeight:400,color:P.dim}}>(illustrative demo)</span></div>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11.5}}>
              <thead>
                <tr>
                  <th style={{textAlign:"left",padding:"4px 8px",color:P.dim,fontWeight:600}}>Team Member</th>
                  {SKILLS.map(s=><th key={s} style={{padding:"4px 6px",color:P.dim,fontWeight:600,textAlign:"center",maxWidth:80,fontSize:10}}>{s}</th>)}
                </tr>
              </thead>
              <tbody>
                {TEAM.map(member=>(
                  <tr key={member.name}>
                    <td style={{padding:"6px 8px",fontWeight:600,color:P.txt,whiteSpace:"nowrap"}}>{member.name.split(" ")[0]}</td>
                    {member.skills.map((sk,i)=>{
                      const bg=sk==="expert"?P.grn:sk==="proficient"?P.blue:sk==="developing"?P.amber:P.redBg;
                      const col=sk==="expert"?"#fff":sk==="proficient"?"#fff":sk==="developing"?"#fff":P.red;
                      return<td key={i} style={{padding:"4px 6px",textAlign:"center"}}>
                        <span style={{background:bg,color:col,borderRadius:3,padding:"2px 6px",fontSize:10,fontWeight:600,display:"inline-block"}}>{sk||"—"}</span>
                      </td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Cohort velocity */}
        <Card style={{padding:20,marginBottom:14}}>
          <div style={{fontSize:13,fontWeight:500,color:P.txt,marginBottom:12}}>Cohort Progress <span style={{fontSize:10.5,fontWeight:400,color:P.dim}}>(illustrative demo)</span></div>
          {TEAM.map(member=>(
            <div key={member.name} style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:12.5,fontWeight:600,color:P.txt}}>{member.name}</span>
                <span style={{fontSize:11.5,color:member.risk?P.red:P.muted}}>{member.risk?"⚠ At risk · ":""}{member.module}</span>
              </div>
              <div style={{height:6,background:P.bfaint,borderRadius:3,overflow:"hidden"}}>
                <div style={{height:"100%",width:`${member.conf*100}%`,background:member.conf>=0.75?P.grn:member.conf>=0.5?P.blue:P.amber,borderRadius:3}}/>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:2}}>
                <span style={{fontSize:10,color:P.dim}}>Confidence {Math.round(member.conf*100)}%</span>
                <span style={{fontSize:10,color:P.dim}}>BW {member.bw}%</span>
              </div>
            </div>
          ))}
        </Card>

        {/* Certification compliance */}
        <Card style={{padding:20}}>
          <div style={{fontSize:13,fontWeight:500,color:P.txt,marginBottom:12}}>Certification Compliance <span style={{fontSize:10.5,fontWeight:400,color:P.dim}}>(illustrative demo — see Certifications tab for real data)</span></div>
          {Object.entries(MEMBER_CERTS).map(([name,cert])=>{
            const statusColor=cert.status==="Active"?P.grn:cert.status==="Renew Soon"?P.amber:P.blue;
            return(
              <div key={name} style={{display:"flex",alignItems:"center",gap:12,padding:"8px 0",borderBottom:`1px solid ${P.bfaint}`}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:statusColor,flexShrink:0}}/>
                <span style={{fontSize:12.5,fontWeight:600,color:P.txt,flex:1}}>{name}</span>
                <span style={{fontSize:12,color:P.muted}}>{cert.cert}</span>
                <span style={{fontSize:11,color:statusColor,fontWeight:600}}>{cert.status}</span>
              </div>
            );
          })}
          <div style={{marginTop:12,padding:"8px 12px",background:P.bg,borderRadius:6,fontSize:12,color:P.muted}}>
            {Object.values(MEMBER_CERTS).filter(c=>c.status==="Active").length}/{Object.keys(MEMBER_CERTS).length} members certified · {Object.values(MEMBER_CERTS).filter(c=>c.status==="Renew Soon").length} expiring soon
          </div>
        </Card>
      </div>}

      {tab==="promptlab"&&(()=>{
        const LABELS={
          curriculum:"Curriculum", crossskill_recommend:"CrossSkilling (recommend)",
          crossskill_chat:"CrossSkilling (chat)", capstone:"Capstone",
          practice_scenario:"Practice (scenario)", practice_validate:"Practice (validate)",
          rag_rewrite:"RAG (query rewrite)", rag_rerank:"RAG (rerank)",
          rag_answer:"RAG (answer)", rag_guard:"RAG (hallucination guard)",
          socratic:"Socratic", study_aid:"Study Aid", reasoning:"Reasoning",
        };
        const prompts=agentPrompts?.prompts||{};
        const errors=agentPrompts?.errors||{};
        const current=prompts[selectedAgent];
        return(
        <div style={{maxWidth:760,margin:"0 auto"}}>
        <div style={{fontSize:14,fontWeight:500,color:P.txt,marginBottom:4}}>Agent Studio</div>
        <div style={{fontSize:12,color:P.muted,marginBottom:16}}>The REAL current system prompt for every agent, read live from the running backend code (agents/*.py) — not a hardcoded mock. Editing below is a sandbox for experimenting with prompt changes; it does not modify the live agent (that requires editing the source file and redeploying).</div>
        {/* Agent selector */}
        <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
          {Object.keys(LABELS).map(k=>(
            <button key={k} onClick={()=>{setSelectedAgent(k);setEditedPrompt(prompts[k]?.text||"");setTestResponse("");}}
              style={{padding:"7px 11px",background:selectedAgent===k?P.purpleBg:"transparent",border:`1.5px solid ${selectedAgent===k?P.purple:P.border}`,borderRadius:8,fontSize:11.5,fontWeight:selectedAgent===k?700:400,cursor:"pointer",color:selectedAgent===k?P.purple:P.txt}}>
              {LABELS[k]}{errors[k]&&<span style={{color:P.red}}> ⚠</span>}
            </button>
          ))}
        </div>

        {!agentPrompts&&<Card style={{padding:24,textAlign:"center"}}><div style={{fontSize:13,color:P.muted}}>Loading real prompts from the backend…</div></Card>}
        {errors[selectedAgent]&&<Card style={{padding:16,marginBottom:12,background:P.redBg,border:`1px solid ${P.red}30`}}>
          <div style={{fontSize:12.5,color:P.red}}>Couldn't load this agent's prompt: {errors[selectedAgent]}</div>
        </Card>}

        {current&&<>
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <span style={{fontSize:12.5,fontWeight:500,color:P.txt}}>Current production prompt {current.dynamic&&<span style={{fontSize:10.5,fontWeight:400,color:P.amber}}>— example render, built dynamically per learner at runtime</span>}</span>
            </div>
            <pre style={{fontSize:11.5,color:P.txt,background:P.bg,border:`1px solid ${P.bfaint}`,borderRadius:7,padding:"10px 12px",overflowX:"auto",whiteSpace:"pre-wrap",lineHeight:1.6,margin:0,maxHeight:320,overflowY:"auto"}}>{current.text}</pre>
          </Card>

          {/* Sandbox editor */}
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
              <span style={{fontSize:12.5,fontWeight:500,color:P.txt}}>Sandbox — experiment with a modified prompt</span>
              <button onClick={()=>setEditedPrompt(current.text)} style={{fontSize:11,color:P.muted,background:"transparent",border:`1px solid ${P.border}`,borderRadius:5,padding:"3px 9px",cursor:"pointer"}}>Reset to real prompt</button>
            </div>
            <div style={{fontSize:11,color:P.muted,marginBottom:8}}>Runs against the generic LLM test endpoint only — never the live agent. Use this to prototype a change before editing the source file.</div>
            <textarea value={editedPrompt} onChange={e=>setEditedPrompt(e.target.value)} style={{width:"100%",boxSizing:"border-box",border:`1px solid ${P.border}`,borderRadius:7,padding:"10px 12px",fontSize:12.5,lineHeight:1.6,outline:"none",background:P.bg,color:P.txt,resize:"vertical",minHeight:120}}/>
          </Card>
          <Card style={{padding:16,marginBottom:12}}>
            <div style={{fontSize:12.5,fontWeight:500,color:P.txt,marginBottom:10}}>Test sandbox prompt</div>
            <div style={{display:"flex",gap:8,marginBottom:10}}>
              <input value={testInput} onChange={e=>setTestInput(e.target.value)} placeholder="Enter a test user message…" style={{flex:1,border:`1px solid ${P.border}`,borderRadius:7,padding:"8px 12px",fontSize:13,outline:"none",background:P.bg,color:P.txt}}/>
              <button onClick={async()=>{
                if(!testInput.trim()||testRunning)return;
                setTestRunning(true);setTestResponse("");
                try{const r=await callAgent([{role:"user",content:testInput}],editedPrompt,groqKey,{agentName:"PromptTest",logFn:null,maxTokens:300});setTestResponse(r);}
                catch(e){setTestResponse(`Error: ${e.message}`);}
                setTestRunning(false);
              }} disabled={testRunning||!testInput.trim()} style={{background:`linear-gradient(135deg,${P.purple},#8b6bff)`,color:"#fff",border:"none",borderRadius:7,padding:"8px 16px",fontSize:13,fontWeight:600,cursor:"pointer",flexShrink:0}}>{testRunning?"Running…":"Run Test"}</button>
            </div>
            {testResponse&&<div style={{background:P.bg,border:`1px solid ${P.border}`,borderRadius:8,padding:"10px 14px",fontSize:13,color:P.txt,lineHeight:1.6}}>{testResponse}</div>}
          </Card>
        </>}
      </div>);
      })()}

      {/* API KEYS */}
      {tab==="keys"&&<div style={{maxWidth:680,margin:"0 auto"}}>
        <Card style={{padding:20,marginBottom:16,borderTop:`3px solid ${groqKey?P.grn:P.amber}`}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}><StatusDot ok={!!groqKey}/><span style={{fontSize:14,fontWeight:500,color:P.txt}}>Groq API Key</span>{groqKey&&<span style={{background:P.grnBg,color:P.grn,borderRadius:4,fontSize:10,padding:"1px 8px",fontWeight:500}}>ACTIVE · GPT-OSS-20B</span>}</div>
          <div style={{fontSize:12,color:P.muted,marginBottom:14}}>Set once — flows to all agents. Free tier at groq.com.</div>
          <div style={{display:"flex",gap:8,marginBottom:testResult?10:0}}>
            <input value={keyInput} onChange={e=>setKeyInput(e.target.value)} placeholder="gsk_…" style={{flex:1,border:`1px solid ${groqKey?P.grn:P.border}`,borderRadius:7,padding:"9px 12px",fontSize:13,outline:"none",background:P.bg,color:P.txt,fontFamily:"monospace"}}/>
            <button onClick={testGroq} disabled={testing||!keyInput.trim()} style={{background:testing?P.border:`linear-gradient(135deg,${P.grn},#1a7a55)`,color:"#fff",border:"none",borderRadius:7,padding:"9px 18px",fontSize:13,fontWeight:600,cursor:testing?"default":"pointer",flexShrink:0}}>{testing?"Testing…":"Test & Save"}</button>
            {groqKey&&<button onClick={()=>{setGroqKey("");setKeyInput("");setTestResult(null);localStorage.removeItem("nexus_groq_key");}} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:7,padding:"9px 14px",fontSize:13,cursor:"pointer",color:P.red}}>Remove</button>}
          </div>
          {testResult&&<div style={{padding:"8px 12px",background:testResult.ok?P.grnBg:P.redBg,border:`1px solid ${testResult.ok?P.grn:P.red}`,borderRadius:7,fontSize:12.5,color:testResult.ok?P.grn:P.red}}>{testResult.ok?"✓ ":"✗ "}{testResult.msg}</div>}
        </Card>
        <Card style={{padding:20,marginBottom:16,borderTop:`3px solid ${githubToken?P.blue:P.border}`}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
            <StatusDot ok={!!githubToken}/>
            <span style={{fontSize:14,fontWeight:500,color:P.txt}}>GitHub Personal Access Token</span>
            {githubToken&&<span style={{background:P.blueGh,color:P.blue,borderRadius:4,fontSize:10,padding:"1px 8px",fontWeight:500}}>ACTIVE · Live AdobeDocs RAG</span>}
          </div>
          <div style={{fontSize:12,color:P.muted,marginBottom:6}}>Optional but recommended. Without a token, GitHub search is limited to 60 requests/hour. With a token, 5,000/hour. The Socratic Agent uses this to fetch real AdobeDocs markdown before every response.</div>
          <div style={{fontSize:12,color:P.muted,marginBottom:14}}>Create one at <span style={{color:P.blue,fontWeight:600}}>github.com/settings/tokens</span> — only needs <span style={{fontFamily:"monospace",background:P.bg,padding:"0 4px",borderRadius:3}}>public_repo</span> scope (read-only).</div>
          <div style={{display:"flex",gap:8}}>
            <input
              value={githubToken||""}
              onChange={e=>{setGithubToken(e.target.value);localStorage.setItem("nexus_github_token",e.target.value);}}
              placeholder="ghp_… (optional — falls back to local corpus without it)"
              style={{flex:1,border:`1px solid ${githubToken?P.blue:P.border}`,borderRadius:7,padding:"9px 12px",fontSize:13,outline:"none",background:P.bg,color:P.txt,fontFamily:"monospace"}}
            />
            {githubToken&&<button onClick={()=>{setGithubToken("");localStorage.removeItem("nexus_github_token");}} style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:7,padding:"9px 14px",fontSize:13,cursor:"pointer",color:P.red}}>Remove</button>}
          </div>
          {!githubToken&&<div style={{marginTop:8,fontSize:11.5,color:P.amber}}>⚠ Without a token, the AI Tutor will use the local 8-document fallback corpus instead of live AdobeDocs.</div>}
        </Card>
        <Card style={{overflow:"hidden"}}>
          {apiRows.map((k,i)=>(
            <div key={k.name} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"13px 16px",borderBottom:i<apiRows.length-1?`1px solid ${P.bfaint}`:"none"}}>
              <div style={{paddingTop:3}}><StatusDot ok={k.ok}/></div>
              <div style={{flex:1}}><div style={{fontSize:13,fontWeight:500,color:P.txt,marginBottom:2}}>{k.name}</div><div style={{fontSize:12,color:k.ok?P.muted:P.red,marginBottom:2}}>{k.detail}</div><div style={{fontSize:11,color:P.dim}}>{k.note}</div></div>
              <div style={{fontSize:11,color:P.dim,textAlign:"right",flexShrink:0}}>{k.latency}</div>
            </div>
          ))}
        </Card>

        {/* LangGraph Agents Status */}
        <LangGraphStatusCard/>
      </div>}

      {/* ALL USERS */}
      {tab==="users"&&<AllUsersTab/>}

      {/* USERS */}
      {tab==="mgrapprovals"&&<div style={{maxWidth:680,margin:"0 auto"}}>
        <div style={{fontSize:14,fontWeight:500,color:P.txt,marginBottom:4}}>Manager Approvals</div>
        <div style={{fontSize:12.5,color:P.muted,marginBottom:16}}>Anyone can self-register and claim to be a manager — nothing else confirms that. Review each request before approving access to team data, approvals, and capstone marking.</div>
        {pendingManagers.length===0&&<Card style={{padding:30,textAlign:"center"}}>
          <div style={{fontSize:24,marginBottom:8}}>✓</div>
          <div style={{fontSize:13,color:P.muted}}>No pending manager registrations.</div>
        </Card>}
        {pendingManagers.map(m=>(
          <Card key={m.id} style={{padding:"16px 20px",marginBottom:10}}>
            <div style={{display:"flex",alignItems:"center",gap:14}}>
              <div style={{width:36,height:36,borderRadius:"50%",background:P.amber,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:500,fontSize:14,flexShrink:0}}>{m.name[0].toUpperCase()}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:14,fontWeight:600,color:P.txt}}>{m.name}</div>
                <div style={{fontSize:12,color:P.muted}}>{m.email} · claims to manage {m.team||"no team specified"}</div>
                <div style={{fontSize:11,color:P.dim,marginTop:2}}>Registered {new Date(m.created_at).toLocaleString()}</div>
              </div>
              <div style={{display:"flex",gap:8,flexShrink:0}}>
                <button onClick={()=>actionManager(m.id,"approve")} disabled={mgrActionLoading===m.id}
                  style={{fontSize:12.5,fontWeight:600,color:"#fff",background:P.grn,border:"none",borderRadius:8,padding:"7px 16px",cursor:"pointer",fontFamily:"inherit",opacity:mgrActionLoading===m.id?.6:1}}>
                  {mgrActionLoading===m.id?"…":"Approve"}
                </button>
                <button onClick={()=>actionManager(m.id,"decline")} disabled={mgrActionLoading===m.id}
                  style={{fontSize:12.5,fontWeight:600,color:P.red,background:"transparent",border:`1px solid ${P.red}30`,borderRadius:8,padding:"7px 16px",cursor:"pointer",fontFamily:"inherit",opacity:mgrActionLoading===m.id?.6:1}}>
                  Decline
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>}

      {/* USER PROVISIONING — Excel roster upload + directory + audit */}
      {tab==="directory"&&<DirectoryTab/>}
      {tab==="certmgmt"&&<AdminCertsUpload/>}
      {tab==="trackerimport"&&<AdminTrackerImport/>}
      {tab==="tracks"&&<AdminReasoningConfig/>}
      {tab==="orgdata"&&<AdminOrgData/>}
      {tab==="validate"&&<AdminValidation/>}
    </div>
  </div>);
}

// ── ROOT ──────────────────────────────────────────────────────────────────────
// ── Standalone Lesson Page (opens in new browser tab) ────────────────────────
function LessonPage({moduleId,groqKey,track="rtcdp"}){
  const lessonTrack=track;
  const m=getModulesForTrack(track).find(x=>x.id===moduleId)||getModulesForTrack(track)[0];
  const lessonContent=getLessonContentForTrack(lessonTrack);
  const [subtopics,setSubtopics]=useState(lessonContent[moduleId]||[]);
  const [active,setActive]=useState(0);
  const [docContent,setDocContent]=useState(null);
  const [docLoading,setDocLoading]=useState(false);
  const [loadingCurr,setLoadingCurr]=useState(true);

  useEffect(()=>{
    // Re-fetch whenever EITHER the module OR the track changes — module ids are
    // reused across tracks (e.g. module 3 is "Analysis Workspace" on analytics
    // but "Profile & Union Schemas" on rtcdp), so keying only on moduleId left
    // the topic list stuck on whichever track was fetched first while the
    // header title (computed fresh every render, not effect-gated) correctly
    // followed the current track — title and topic list would silently drift
    // apart when navigating between same-numbered modules on different tracks.
    setActive(0);
    setLoadingCurr(true);
    fetch(`${BACKEND}/api/curriculum/${moduleId}?track=${lessonTrack}`)
      .then(r=>r.json())
      .then(data=>{
        setSubtopics(data.topics?.length
          ? data.topics.map(r=>({
              t:r.title,obj:r.objective,act:r.activity,
              out:r.output,chk:r.checkpoint,
              vid:r.video_title,dur:r.video_duration,
              order:r.topic_order,el_url:r.el_url
            }))
          : (getLessonContentForTrack(lessonTrack)[moduleId]||[]));
        setLoadingCurr(false);
      })
      .catch(()=>setLoadingCurr(false));
  },[moduleId,lessonTrack]);

  useEffect(()=>{
    if(loadingCurr)return;
    const sub=subtopics[active];
    if(!sub)return;
    setDocContent(null);setDocLoading(true);
    fetch(`${BACKEND}/api/content/${moduleId}/${sub.order||(active+1)}?track=${lessonTrack}`)
      .then(r=>r.json())
      .then(data=>{setDocContent(data);setDocLoading(false);})
      .catch(()=>setDocLoading(false));
  },[active,loadingCurr]);

  const sub=subtopics[active];

  const renderMarkdown=renderAdobeMarkdown;


  return(
    <div style={{minHeight:"100vh",background:P.bg,fontFamily:"'adobe-clean','Source Sans 3',system-ui,sans-serif",display:"flex",flexDirection:"column"}}>
      <GlobalStyles/>
      {/* Header */}
      <div style={{background:P.panel,borderBottom:`1px solid ${P.border}`,padding:"10px 20px",display:"flex",alignItems:"center",gap:12,flexShrink:0}}>
        <button onClick={()=>{if(window.history.length>1)window.history.back();else window.close();}}
          style={{display:"flex",alignItems:"center",gap:6,background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"6px 12px",fontSize:13,color:P.muted,cursor:"pointer",fontFamily:"inherit",flexShrink:0}}>
          <Ic as={ChevronLeft} size={14} color="currentColor"/> Back
        </button>
        <div style={{width:28,height:28,borderRadius:7,background:"#E34850",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:600,fontSize:13,flexShrink:0}}>N</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:11,fontWeight:600,color:P.blue,letterSpacing:.5,textTransform:"uppercase"}}>{m?.tag} · WEEK {m?.week} · {lessonTrack.toUpperCase()}</div>
          <div style={{fontSize:15,fontWeight:500,color:P.txt,letterSpacing:-.2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m?.title}</div>
        </div>
        <div style={{fontSize:12,color:P.muted,flexShrink:0}}>{subtopics.length} topics</div>
        <button onClick={()=>window.close()}
          style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"6px 14px",fontSize:12.5,color:P.muted,cursor:"pointer",fontFamily:"inherit",flexShrink:0,display:"flex",alignItems:"center",gap:6}}>
          ✕ Close tab
        </button>
      </div>

      <div style={{flex:1,display:"flex",overflow:"hidden",minHeight:0}}>
        {/* Sidebar — topic list */}
        <div style={{width:260,borderRight:`1px solid ${P.border}`,overflowY:"auto",padding:"12px 8px",flexShrink:0}}>
          {subtopics.map((s,i)=>(
            <button key={i} onClick={()=>setActive(i)}
              style={{width:"100%",display:"block",textAlign:"left",padding:"9px 12px",borderRadius:9,border:"none",cursor:"pointer",fontFamily:"inherit",background:active===i?P.blueGh:"transparent",marginBottom:3}}>
              <div style={{fontSize:12.5,fontWeight:active===i?600:400,color:active===i?P.blue:P.txt,lineHeight:1.4}}>{s.t}</div>
              {s.vid&&<div style={{fontSize:10.5,color:P.dim,marginTop:2}}>▶ {s.dur}</div>}
            </button>
          ))}
        </div>

        {/* Main content */}
        {sub&&<ContentPane sub={sub} docContent={docContent} docLoading={docLoading} renderMarkdown={renderMarkdown} groqKey={groqKey} moduleTitle={m.title} moduleId={m.id} track={track}/>}
      </div>


      {/* Footer nav */}
      <div style={{background:P.panel,borderTop:`1px solid ${P.border}`,padding:"10px 24px",display:"flex",alignItems:"center",gap:12,flexShrink:0}}>
        <button onClick={()=>setActive(a=>Math.max(0,a-1))} disabled={active===0}
          style={{background:"transparent",border:`1px solid ${P.border}`,borderRadius:8,padding:"7px 18px",fontSize:13,cursor:active===0?"not-allowed":"pointer",color:P.muted,fontFamily:"inherit",opacity:active===0?.4:1,display:"inline-flex",alignItems:"center",gap:4}}><Ic as={ChevronLeft} size={14} color="currentColor"/> Previous</button>
        <span style={{fontSize:12.5,color:P.dim,flex:1,textAlign:"center"}}>{active+1} / {subtopics.length}</span>
        <button onClick={()=>setActive(a=>Math.min(subtopics.length-1,a+1))} disabled={active===subtopics.length-1}
          style={{background:active===subtopics.length-1?"transparent":P.blue,border:"none",borderRadius:8,padding:"7px 18px",fontSize:13,cursor:"pointer",color:active===subtopics.length-1?P.muted:"#fff",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:4}}>Next <Ic as={ChevronRight} size={14} color="currentColor"/></button>
      </div>
    </div>
  );
}


  // Check if this is a standalone lesson page (opened in new tab)
export default function App(){
  const urlParams=new URLSearchParams(window.location.search);
  const lessonId=urlParams.get("lesson");
  const groqKeyParam=urlParams.get("groq")||localStorage.getItem("nexus_groq_key")||"";
  const githubParam=urlParams.get("github")||localStorage.getItem("nexus_github_token")||"";
  const lessonTrackParam=urlParams.get("track")||"rtcdp";
  if(lessonId){
    return <LessonPage moduleId={parseInt(lessonId)} groqKey={groqKeyParam} githubToken={githubParam} track={lessonTrackParam}/>;
  }

  const [persona,setPersona]=useState(null);
  const [pendingInfo,setPendingInfo]=useState(null); // new joiner waiting for approval
  const [mgrPendingInfo,setMgrPendingInfo]=useState(null); // manager registration awaiting admin approval
  // One-time "review your profile" step shown right after a fresh IMS login for
  // directory-sourced employees (auto-approved, no manager gate) — lets them
  // confirm/edit before entering the dashboard. Not shown on session-restore refresh.
  const [profileReview,setProfileReview]=useState(null); // {persona,profile}
  const [pendingApprovals,setPendingApprovals]=useState([]);  // lifted to App so Login → MGR share same list
  const [profile,setProfile]=useState(null);
  // Seed for the Login screen after an Adobe IMS round-trip: {email, openOnboarding, message}
  const [imsInit,setImsInit]=useState(null);
  const [loading,setLoading]=useState(false);
  const [groqKey,setGroqKey]=useState(()=>localStorage.getItem("nexus_groq_key")||"");
  const [githubToken,setGithubToken]=useState(()=>localStorage.getItem("nexus_github_token")||"");
  const [callLog,setCallLog]=useState([]);
  const [judgeLog,setJudgeLog]=useState([]);
  const [,rerender]=useReducer(x=>x+1,0);

  // Theme toggle
  const toggleTheme=()=>{
    setThemeMode(getThemeMode()==="light"?"dark":"light");
    rerender();
  };

  const [telemetry,setTelemetry]=useState([
    {id:1,ts:"09:14",type:"module_view",persona:"nj",module:"Segment Evaluation Logic",detail:"Viewed for 12 min"},
    {id:2,ts:"09:26",type:"chat_msg",persona:"nj",module:"Segment Evaluation Logic",detail:"Socratic session — 4 turns"},
    {id:3,ts:"09:41",type:"quiz_fail",persona:"nj",module:"Segment Evaluation Logic",detail:"Score: 40% — confidence stall"},
    {id:4,ts:"10:02",type:"module_view",persona:"nj",module:"Segment Evaluation Logic",detail:"Revisited — 18 min"},
    {id:5,ts:"10:22",type:"chat_msg",persona:"nj",module:"Segment Evaluation Logic",detail:"Reasoning session — 6 turns"},
    {id:6,ts:"11:04",type:"quiz_fail",persona:"nj",module:"Segment Evaluation Logic",detail:"Score: 55% — below gate"},
    {id:7,ts:"08:30",type:"cat_complete",persona:"exp",module:"AJO Assessment",detail:"θ=1.2 → proficient · 6 items"},
    {id:8,ts:"08:55",type:"cat_complete",persona:"exp",module:"RT-CDP Assessment",detail:"θ=-0.4 → developing · 5 items"},
    {id:9,ts:"09:10",type:"module_view",persona:"exp",module:"AJO Learning Path",detail:"Started AJO track"},
  ]);
  const logTelemetry=(type,persona,detail,module="")=>{
    setTelemetry(prev=>[...prev,{id:Date.now(),ts:new Date().toLocaleTimeString(),type,persona,detail}]);
    fetch(`${BACKEND}/api/telemetry`,{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({persona,event_type:type,module,detail})}).catch(()=>{});
  };

  const [memberProjects,setMemberProjects]=useState({...DEFAULT_MEMBER_PROJECTS});
  const [projectIssues,setProjectIssues]=useState({...INIT_ISSUES});

  const addToLog=e=>setCallLog(prev=>[e,...prev].slice(0,100));
  const addToJudge=e=>{ setJudgeLog(prev=>[e,...prev].slice(0,50)); };

  const handleLogin=(p, profileOverride=null)=>{
    setLoading(true);
    setTimeout(()=>{
      const baseProfile=PROFILES[p]||PROFILES.nj;
      const merged=profileOverride?{...baseProfile,...profileOverride,persona:p}:{persona:p,...baseProfile};
      // Real registered users (have a DB id) must NOT inherit the demo persona's
      // hardcoded `skills` array — their real skills come only from their own
      // assessments/self-reports (/api/skills/me). Clear it so nothing downstream
      // shows fabricated levels. Demo personas keep their illustrative skills.
      if(merged.id&&!(profileOverride&&"skills"in profileOverride))merged.skills=[];
      // displayName = preferred_name if set, else first word of full name
      if(!merged.displayName){
        merged.displayName=merged.preferred_name||(merged.name?merged.name.split(" ")[0]:"");
      }
      setProfile(merged);
      setPersona(p);
      setLoading(false);
    },600);
  };

  // ── Adobe IMS (Implicit grant): handle the token returned in the URL fragment,
  // then restore any existing cookie-backed session so a refresh keeps you signed in.
  // Runs once (ref-guarded against React StrictMode's double-invoke in dev).
  const imsHandledRef=useRef(false);
  useEffect(()=>{
    if(imsHandledRef.current) return;
    imsHandledRef.current=true;
    (async()=>{
      const frag=parseImsFragment();
      if(frag){
        if(frag.error){
          setImsInit({message:`Adobe sign-in could not be completed (${frag.error}). Please try again or use a fallback option below.`});
        }else if(frag.token){
          const res=await submitImsToken(frag.token);
          if(res&&res.ok&&res.persona){
            // Employee personas are directory-sourced (auto-approved) — show a
            // one-time confirm/edit screen before entering the dashboard. Manager/
            // admin/demo profiles have no directory fields to review, so skip it.
            if(["nj","nj2","exp"].includes(res.persona)&&!res.profile?.profile_confirmed){ setProfileReview({persona:res.persona,profile:res.profile}); return; }
            handleLogin(res.persona,res.profile); return;
          }
          if(res&&res.status==="pending"){
            setPendingInfo({name:res.name||res.email,email:res.email,manager:"your manager",status:"pending"});
            return;
          }
          if(res&&res.status==="onboarding"){
            // Directory members are auto-provisioned in _resolve_account and never
            // reach this branch — only true fallback (not-in-directory) users do.
            setImsInit({email:res.email,openOnboarding:true,
              message:"You're signed in with Adobe, but you're not in the employee directory yet. Enter your details below to request access."});
          }else if(res&&res.status==="declined"){
            setImsInit({email:res.email,message:"Your Nexus access was not approved. Contact your manager or administrator."});
          }else{
            setImsInit({message:(res&&res.detail)||"Adobe sign-in could not be completed. Use a fallback option below."});
          }
        }
      }
      // Restore an existing IMS session (normal refresh / already signed in).
      const s=await fetchSession();
      if(s&&s.ok&&s.persona){ handleLogin(s.persona,s.profile); }
    })();
  },[]);

  // Shared sign-out: end BOTH the Nexus session and Adobe's SSO session, so the
  // next sign-in can use a different account. signOutAdobe() navigates away when
  // IMS is configured; the local reset is the fallback (e.g. fallback logins).
  const handleLogout=async()=>{
    const leaving=await signOutAdobe();
    if(!leaving){ setPersona(null); setProfile(null); }
  };

  if(loading) return(
    <div style={{minHeight:"100vh",background:P.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,-apple-system,sans-serif",gap:12}}>
      <div style={{width:36,height:36,background:"#FA0F00",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{color:"#fff",fontWeight:500,fontSize:17}}>N</span></div>
      <div style={{fontSize:14,fontWeight:600,color:P.txt}}>Connecting to Adobe IMS…</div>
      <div style={{fontSize:12,color:P.muted}}>Fetching profile, team context, and learning track</div>
    </div>
  );

  const legend=null; // system-status legend removed per design
  if(profileReview) return <>{<ProfileConfirmScreen persona={profileReview.persona} profile={profileReview.profile}
    onContinue={updatedProfile=>{const p=profileReview.persona;setProfileReview(null);handleLogin(p,updatedProfile);}}/>}{legend}</>;
  if(!persona&&!pendingInfo&&!mgrPendingInfo) return <>{<Login onLogin={handleLogin} imsInit={imsInit} onPendingApproval={info=>{setPendingInfo(info);setPendingApprovals(p=>[...p,info]);}} onManagerPending={info=>setMgrPendingInfo(info)}/>}{legend}</>;
  if(pendingInfo&&!persona) return <>{<PendingApprovalScreen info={pendingInfo} onBack={()=>setPendingInfo(null)}/>}{legend}</>;
  if(mgrPendingInfo&&!persona) return <>{<PendingApprovalScreen info={mgrPendingInfo} onBack={()=>setMgrPendingInfo(null)}/>}{legend}</>;
  if(persona==="nj"||persona==="nj2"||persona==="nj3") return <><NJDash onLogout={handleLogout} groqKey={groqKey} onLog={addToLog} onJudge={addToJudge} profile={profile} githubToken={githubToken} onToggleTheme={toggleTheme}/>{legend}</>;
  if(persona==="exp"||persona==="demo"||persona==="exp2") return <><EXPDash onLogout={handleLogout} groqKey={groqKey} onLog={addToLog} onJudge={addToJudge} githubToken={githubToken} profile={profile} memberProjects={memberProjects} setMemberProjects={setMemberProjects} projectIssues={projectIssues} setProjectIssues={setProjectIssues} onToggleTheme={toggleTheme}/>{legend}</>;
  if(persona==="mgr")   return <><MGRDash   onLogout={handleLogout} groqKey={groqKey} onLog={addToLog} profile={profile} memberProjects={memberProjects} setMemberProjects={setMemberProjects} projectIssues={projectIssues} setProjectIssues={setProjectIssues} onToggleTheme={toggleTheme} pendingApprovals={pendingApprovals} setPendingApprovals={setPendingApprovals}/>{legend}</>;
  if(persona==="admin") return <><AdminDash onLogout={handleLogout} groqKey={groqKey} setGroqKey={setGroqKey} githubToken={githubToken} setGithubToken={setGithubToken} callLog={callLog} judgeLog={judgeLog} telemetry={telemetry} onToggleTheme={toggleTheme} profile={profile}/>{legend}</>;
  return null;
}

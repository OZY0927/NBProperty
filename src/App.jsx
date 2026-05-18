import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import FALLBACK_IMG from "./assets/nblogo.jpg";
import { getAllProjects, setProjectById, deleteProjectById, addAnalytic, getAllAnalytics, migrateAnalytics, deleteAllAnalytics, getSettings as fsGetSettings, saveSettings as fsSaveSettings } from "./firebase/firestore";
import COUNTRY_CODES from "./data/countryCodes";
// Firebase SDK — reuses the app already initialised by ./firebase/firestore
import { getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, orderBy, serverTimestamp, getDoc, getDocs } from "firebase/firestore";
import { getApp } from "firebase/app";
import { auth } from "./firebase/config";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, updatePassword, EmailAuthProvider, reauthenticateWithCredential } from "firebase/auth";

/* ═══ CRM — Firestore helpers ═══ */
const crmDb = () => getFirestore(getApp());
const leadsCol = () => collection(crmDb(), "leads");
const activitiesCol = (leadId) => collection(crmDb(), "leads", leadId, "activities");
const normalizeCrmLead = (lead) => {
  let { countryCode, phone } = lead || {};
  // If countryCode is missing but phone already contains it (e.g. "+60121234567"), split them
  if (!countryCode && phone && phone.startsWith("+")) {
    const match = phone.match(/^(\+\d{1,4})(\d+)$/);
    if (match) { countryCode = match[1]; phone = match[2]; }
  }
  if (!countryCode) countryCode = "+60";
  return {
    ...lead,
    countryCode,
    phone: phone || "",
    nextFollowUpDate:
      lead?.nextFollowUpDate ||
      lead?.followUpDate ||
      lead?.followupDate ||
      lead?.nextFollowUp ||
      "",
  };
};

async function crmAddLead(data) {
  return addDoc(leadsCol(), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
}
async function crmUpdateLead(id, data) {
  return updateDoc(doc(crmDb(), "leads", id), { ...data, updatedAt: serverTimestamp() });
}
async function crmDeleteLead(id) {
  return deleteDoc(doc(crmDb(), "leads", id));
}
function crmLeadsListener(cb) {
  return onSnapshot(query(leadsCol(), orderBy("createdAt", "desc")), snap => {
    cb(snap.docs.map(d => normalizeCrmLead({ id: d.id, ...d.data() })));
  });
}
async function crmAddActivity(leadId, data) {
  return addDoc(activitiesCol(leadId), { ...data, timestamp: serverTimestamp() });
}
async function crmGetActivities(leadId) {
  const snap = await getDocs(query(activitiesCol(leadId), orderBy("timestamp", "desc")));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function crmCreateWebsiteEnquiryLead(data, settings) {
  const lead = {
    name: data.name,
    email: data.email,
    countryCode: data.countryCode || "+60",
    phone: data.phone,
    source: "website",
    status: "new",
    propertyInterest: data.projectName || "",
    assignedAgent: "",
    nextFollowUpDate: "",
    budget: 0,
    notes: data.notes || `Website enquiry submitted${data.projectName ? ` for ${data.projectName}` : ""}.`,
  };
  const leadRef = await crmAddLead(lead);
  await crmAddActivity(leadRef.id, {
    type: "note",
    createdBy: "website",
    content: `New website enquiry${data.projectName ? ` for ${data.projectName}` : ""}.`,
  });
  await sendTelegramNotification({ ...lead, projectName: data.projectName }, settings);
  return leadRef;
}

/* ═══ CRM — constants ═══ */
const CRM_STATUSES = ["new","contacted","qualified","viewing","closed"];
const CRM_STATUS_LABELS = { new:"New Lead", contacted:"Contacted", qualified:"Qualified", viewing:"Viewing", closed:"Closed" };
const CRM_STATUS_COLORS = { new:"#9090A8", contacted:"#5E8FD0", qualified:"#BF9B4E", viewing:"#4E9A72", closed:"#C4543E" };
const CRM_STATUS_BG    = { new:"rgba(144,144,168,.15)", contacted:"rgba(94,143,208,.15)", qualified:"rgba(191,155,78,.15)", viewing:"rgba(78,154,114,.15)", closed:"rgba(196,84,62,.15)" };
const CRM_SOURCES = ["website","fb_ads","referral","walk_in","other"];
const CRM_SOURCE_LABELS = { website:"Website", fb_ads:"Facebook Ads", referral:"Referral", walk_in:"Walk-in", other:"Other" };
const EMPTY_LEAD = { name:"", phone:"", email:"", budget:"", propertyInterest:"", source:"website", status:"new", assignedAgent:"", nextFollowUpDate:"", notes:"" };

/* ═══════════════════════════════════════════════
   DATA  –  unitTypes is now an array of objects,
   each with its own image, label, beds, size etc.
═══════════════════════════════════════════════ */
const DEFAULT_PROJECTS = [];

const ADMIN_PASSWORD   = "admin123";
const STORAGE_KEY      = "nb_v3";
const SETTINGS_KEY     = "nb_settings_v1";
const ANALYTICS_KEY    = "nb_analytics_v1";

function trackEvent(type, data = {}) {
  try {
    const entry = { t: Date.now(), type, ...data };
    const raw = localStorage.getItem(ANALYTICS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    arr.push(entry);
    if (arr.length > 20000) arr.splice(0, arr.length - 20000);
    localStorage.setItem(ANALYTICS_KEY, JSON.stringify(arr));
    try { addAnalytic(entry).catch(()=>{}); } catch(e){}
  } catch {}
}

const DEFAULT_SETTINGS = {
  adminEmail:       "",
  whatsappPhone:    "60129846080",
  whatsappName:     "Joel",
  emailjsServiceId: "",
  emailjsTemplateId:"",
  emailjsPublicKey: "",
  telegramEnabled:  false,
  telegramBotToken: "",
  telegramChatId:   "",
};

async function sendTelegramNotification(lead, settings) {
  if (!settings?.telegramEnabled) return;
  const botToken = (settings?.telegramBotToken || "").trim();
  const chatId   = (settings?.telegramChatId   || "").trim();
  if (!botToken || !chatId) return;
  const phone = lead.countryCode ? `${lead.countryCode} ${lead.phone || ""}` : (lead.phone || "—");
  const text = [
    "🔥 *New Lead Received*",
    "",
    `👤 *Name:* ${lead.name || "—"}`,
    `📞 *Phone:* [${phone}](tel:${phone.replace(/\s/g,"")})`,
    `📧 *Email:* ${lead.email || "—"}`,
    `📍 *Project:* ${lead.propertyInterest || lead.projectName || "—"}`,
    `🏷 *Source:* ${lead.source || "website"}`,
  ].join("\n");
  try {
    await fetch(`/api/send-telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken, chatId, text }),
    });
  } catch (e) {
    console.warn("Telegram notify failed:", e);
  }
}

// country codes are loaded from src/data/countryCodes.js
const PROP_TYPES   = ["Condominium","Semi-Detached","Serviced Apartment","Shophouse","Terrace House","SoHo / Office","Bungalow","Duplex"];
const STATUSES     = ["New Launch","Under Construction","Completed","Sold Out"];
const TENURES      = ["Freehold","Leasehold"];
const TAG_COLORS   = ["#BF9B4E","#0D0D18","#C4543E","#BF9B4E","#8E8A84","#0D0D18","#BF9B4E","#C4543E"];
const TAG_PRESETS  = ["HOT","EXCLUSIVE","SELLING FAST","RARE FIND","FAMILY LIVING","INVESTMENT","NEW LAUNCH","LAST FEW UNITS"];
const PRICE_SLIDER_MIN = 0;
const PRICE_SLIDER_MAX = 5000000;
const PRICE_STEP       = 50000;

/* ═══ HELPERS ═══ */
const fmt   = n  => n >= 1000000 ? `RM${(n/1000000).toFixed(1)}M` : `RM${(n/1000).toFixed(0)}K`;
const bLbl  = a  => a?.length > 1 ? `${a[0]}–${a[a.length-1]}` : `${a?.[0] ?? "—"}`;
const arrStr= a  => Array.isArray(a) ? a.join(", ") : String(a ?? "");
const strArr= s  => String(s ?? "").split(",").map(x=>x.trim()).filter(Boolean);
const rStr  = a  => Array.isArray(a) ? a.join("–") : String(a ?? "");
const strR  = s  => { const p=String(s??"").split(/[-–]/).map(x=>Number(x.trim())).filter(n=>!isNaN(n)); return p.length>=2?[p[0],p[p.length-1]]:p.length===1?[p[0],p[0]]:[0,0]; };
const newId = ps => Math.max(0,...ps.map(p=>p.id))+1;
const safeJson = (v, fallback) => { try { return JSON.parse(v); } catch { return fallback; } };

const formatNum = v => {
  if (v === null || v === undefined || v === "") return v === 0 ? "0" : "-";
  const n = Number(String(v).replace(/,/g, ''));
  if (!isFinite(n)) return String(v);
  return n.toLocaleString();
};

// Password hashing helpers (browser Web Crypto API)
function genSalt(len = 12) {
  const arr = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password, salt) {
  try {
    const enc = new TextEncoder();
    const data = enc.encode(salt + password);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const hashArr = Array.from(new Uint8Array(hashBuf));
    return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return null; }
}
async function verifyPassword(plainPw, settings) {
  // If stored hash+salt exist, verify against them; otherwise fall back to default constant
  const storedHash = settings?.adminPasswordHash;
  const storedSalt = settings?.adminPasswordSalt;
  if (storedHash && storedSalt) {
    const h = await hashPassword(plainPw, storedSalt);
    return h === storedHash;
  }
  return plainPw === ADMIN_PASSWORD;
}

/* ═══ MODAL HELPERS ═══ */
function useModalEffect(onClose) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", handleKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", handleKey); };
  }, [onClose]);
}

/* ═══ PDF EXPORT ═══ */
function loadScript(src){ return new Promise((r,j)=>{ const s=document.createElement("script");s.src=src;s.onload=r;s.onerror=j;document.head.appendChild(s); }); }
async function exportPDF(projects){
  if(!window.jspdf) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
  if(!(window.jspdf?.jsPDF?.prototype?.autoTable)) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js");
  const {jsPDF}=window.jspdf,doc=new jsPDF({orientation:"landscape",unit:"mm",format:"a4"}),W=doc.internal.pageSize.getWidth(),H=doc.internal.pageSize.getHeight();
  doc.setFillColor(10,30,48);doc.rect(0,0,W,32,"F");doc.setTextColor(20,120,200);doc.setFont("helvetica","bold");doc.setFontSize(20);doc.text("NB",14,20);doc.setTextColor(255,255,255);doc.setFont("helvetica","normal");doc.setFontSize(20);doc.text("Property",20,20);doc.setTextColor(150,150,150);doc.setFontSize(8);doc.text("New Project Comparison Report",14,28);const today=new Date().toLocaleDateString("en-MY",{year:"numeric",month:"long",day:"numeric"});doc.text(`${today}  |  ${projects.length} projects`,W-14,28,{align:"right"});doc.setDrawColor(20,120,200);doc.setLineWidth(0.6);doc.line(0,32,W,32);
  const nCol=projects.length,lW=46,vW=Math.floor((W-28-lW)/nCol);
  const lS=()=>({fillColor:[245,241,234],textColor:[10,30,48],fontStyle:"bold",fontSize:8,cellWidth:lW});
  const vS=(i,b)=>({fillColor:b?[230,242,252]:i%2===0?[255,255,255]:[252,249,244],textColor:[10,30,48],fontSize:8,halign:"center",fontStyle:b?"bold":"normal",cellWidth:vW});
  const sec=t=>[{content:t,colSpan:nCol+1,styles:{fillColor:[10,30,48],textColor:[20,120,200],fontStyle:"bold",fontSize:7.5}}];
  const row=(l,f,bid=null)=>[{content:l,styles:lS()},...projects.map((p,i)=>({content:f(p),styles:vS(i,bid===p.id)}))];
  const cheap=projects.reduce((a,b)=>a.priceFrom<b.priceFrom?a:b).id,big=projects.reduce((a,b)=>a.sizeSqft[1]>b.sizeSqft[1]?a:b).id;
  const head=[[{content:"Category",styles:{...lS(),fillColor:[10,30,48],textColor:[20,120,200]}},...projects.map(p=>({content:p.name,styles:{fillColor:[10,30,48],textColor:[255,255,255],fontStyle:"bold",fontSize:9,halign:"center",cellWidth:vW}}))]];
  const body=[sec("PROJECT OVERVIEW"),row("Developer",p=>p.developer),row("Location",p=>p.location),row("Type",p=>p.type),row("Status",p=>p.status),row("Completion",p=>p.completion),row("Tenure",p=>p.tenure),row("Land Size",p=>p.landSize||"-"),row("Total Units",p=>formatNum(p.totalUnits)),sec("PRICING"),row("From",p=>fmt(p.priceFrom),cheap),row("Range",p=>`${fmt(p.priceFrom)} - ${fmt(p.priceTo)}`),row("Maintenance",p=>p.maintenanceFee||"-"),sec("UNIT SPECS"),row("Bedrooms",p=>bLbl(p.bedrooms)+" bed"),row("Built-up",p=>`${p.sizeSqft[0]?.toLocaleString()} - ${p.sizeSqft[1]?.toLocaleString()} sqft`,big),row("Car Parks",p=>p.numberOfCarParks?formatNum(p.numberOfCarParks):"-"),row("Lifts",p=>p.numberOfLifts?formatNum(p.numberOfLifts):"-"),sec("HIGHLIGHTS"),row("Highlights",p=>p.highlights.join(" · "))];
  doc.autoTable({startY:38,head,body,margin:{left:14,right:14},styles:{fontSize:8,cellPadding:3.5,overflow:"linebreak",lineColor:[220,212,200],lineWidth:0.18},headStyles:{fillColor:[10,30,48]},columnStyles:{0:{cellWidth:lW},...Object.fromEntries(projects.map((_,i)=>[i+1,{cellWidth:vW}]))},rowPageBreak:"auto"});
  const pages=doc.getNumberOfPages();for(let i=1;i<=pages;i++){doc.setPage(i);doc.setFillColor(10,30,48);doc.rect(0,H-10,W,10,"F");doc.setFontSize(7);doc.setTextColor(90,90,90);doc.text("NB Property · For illustration purposes only.",14,H-3.5);doc.text(`${i} / ${pages}`,W-14,H-3.5,{align:"right"});}
  doc.save(`NB_Comparison_${Date.now()}.pdf`);
}

/* ═══ FORM HELPERS ═══ */
const EMPTY_UNIT_TYPE = { label:"", name:"", beds:2, baths:2, size:"", priceFrom:"", image:"" };
const EMPTY_FORM = {
  name:"",developer:"",location:"",type:"Condominium",status:"New Launch",completion:"",tenure:"Freehold",
  tag:"HOT",tagColor:"#D4B880",priceFrom:"",priceTo:"",bedrooms:"",bathrooms:"",sizeSqft:"",
  totalUnits:"",floors:"",description:"",highlights:"",facilities:"",image:"",gallery:"",
  landSize:"",constructionStage:"",totalBlocks:"",totalFloorsPerTower:"",residentialStartLevel:"",
  unitsBreakdown:"",unitsPerTower:"",carParkLevels:"",numberOfCarParks:"",parkingNotes:"",
  numberOfLifts:"",unitTypes:"[]",upgrades:"",maintenanceFee:"",sinkingFund:"",
  showroom:"",scaleModel:"",nearbyAmenities:"",
  coordinateLat:"",coordinateLng:"",
};
function p2f(p){ return { ...EMPTY_FORM, name:p.name??"",developer:p.developer??"",location:p.location??"",type:p.type??"Condominium",status:p.status??"New Launch",completion:p.completion??"",tenure:p.tenure??"Freehold",tag:p.tag??"",tagColor:p.tagColor??"#D4B880",priceFrom:String(p.priceFrom??""),priceTo:String(p.priceTo??""),bedrooms:arrStr(p.bedrooms),bathrooms:arrStr(p.bathrooms),sizeSqft:rStr(p.sizeSqft),totalUnits:String(p.totalUnits??""),floors:String(p.floors??""),description:p.description??"",highlights:arrStr(p.highlights),facilities:arrStr(p.facilities),image:p.image??"",gallery:arrStr(p.gallery),landSize:p.landSize??"",constructionStage:p.constructionStage??"",totalBlocks:String(p.totalBlocks??""),totalFloorsPerTower:arrStr(p.totalFloorsPerTower),residentialStartLevel:p.residentialStartLevel??"",unitsBreakdown:p.unitsBreakdown??"",unitsPerTower:p.unitsPerTower??"",carParkLevels:p.carParkLevels??"",numberOfCarParks:p.numberOfCarParks??"",parkingNotes:p.parkingNotes??"",numberOfLifts:p.numberOfLifts??"",unitTypes:JSON.stringify(Array.isArray(p.unitTypes)?p.unitTypes:[]),upgrades:p.upgrades??"",maintenanceFee:p.maintenanceFee??"",sinkingFund:p.sinkingFund??"",showroom:p.showroom??"",scaleModel:p.scaleModel??"",nearbyAmenities:typeof p.nearbyAmenities==="string"?p.nearbyAmenities:JSON.stringify(p.nearbyAmenities??[]),coordinateLat:String(p.coordinates?.lat??""),coordinateLng:String(p.coordinates?.lng??""),visible:p.visible,visibleTabs:p.visibleTabs,visibleSections:p.visibleSections }; }
function f2p(f,id){ return { id, name:f.name.trim(),developer:f.developer.trim(),location:f.location.trim(),type:f.type,status:f.status,completion:f.completion.trim(),tenure:f.tenure,tag:f.tag.trim(),tagColor:f.tagColor,priceFrom:Number(f.priceFrom)||0,priceTo:Number(f.priceTo)||0,bedrooms:strArr(f.bedrooms).map(Number),bathrooms:strArr(f.bathrooms).map(Number),sizeSqft:strR(f.sizeSqft),totalUnits:Number(f.totalUnits)||0,floors:Number(f.floors)||0,description:f.description.trim(),highlights:strArr(f.highlights),facilities:strArr(f.facilities),image:f.image.trim(),gallery:strArr(f.gallery),landSize:f.landSize.trim(),constructionStage:f.constructionStage.trim(),totalBlocks:Number(f.totalBlocks)||0,totalFloorsPerTower:strArr(f.totalFloorsPerTower),residentialStartLevel:f.residentialStartLevel.trim(),unitsBreakdown:f.unitsBreakdown.trim(),unitsPerTower:f.unitsPerTower.trim(),carParkLevels:f.carParkLevels.trim(),numberOfCarParks:f.numberOfCarParks.trim(),parkingNotes:f.parkingNotes.trim(),numberOfLifts:f.numberOfLifts.trim(),unitTypes:safeJson(f.unitTypes,[]),upgrades:f.upgrades.trim(),maintenanceFee:f.maintenanceFee.trim(),sinkingFund:f.sinkingFund.trim(),showroom:f.showroom.trim(),scaleModel:f.scaleModel.trim(),nearbyAmenities:safeJson(f.nearbyAmenities,[]),coordinates:{lat:parseFloat(f.coordinateLat)||0,lng:parseFloat(f.coordinateLng)||0} }; }

/* ═══ CSS ═══ */
const css=`
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --ink:#2D0E14;--parchment:#FFF5F6;--warm:#FCE8EB;
  --gold:#C17E87;--gold-l:#D4A4AC;--muted:#A07880;
  --border:#F0D0D4;--card:#FFFFFF;
  --cta:#2D0E14;--cta-l:#5C2030;
  --r-sm:10px;--r-md:16px;--r-lg:22px;
  --serif:'Cormorant Garamond',Georgia,serif;
  --sans:'DM Sans',system-ui,sans-serif;
  --a-bg:#0D0D18;--a-surface:#141426;--a-surface2:#1C1C30;
  --a-border:#2C2A3E;--a-muted:#9090A8;--a-text:#FAF8F3;
  --a-gold:#BF9B4E;--a-red:#C4543E;--a-green:#4E9A72;--a-blue:#5E8FD0;
  --a-cta:#BF9B4E;
}
html{scroll-behavior:smooth;font-size:18px;}
body{font-family:var(--sans);background:linear-gradient(160deg,#FFF5F6 0%,#FDE8EC 55%,#FCE0E6 100%);color:var(--ink);transition:background .4s ease,color .4s ease;}
/* ── DARK MODE overrides ── */
body.dark{background:linear-gradient(180deg,#0B0D1A 0%,#070910 100%);color:#FAF8F3;}
body.dark{--ink:#FAF8F3;--parchment:#0D0D18;--warm:#141428;--border:#2C2A3E;--card:#141428;--muted:#9090A8;--cta:#0D0D18;--cta-l:#1C1C30;--gold:#BF9B4E;--gold-l:#D4B880;}
body.dark .proj-card{background:#141428;border-color:#2C2A3E;}
body.dark .proj-card:hover{background:#1C1C30;border-color:rgba(191,155,78,.3);}
body.dark .card{background:#141428;border-color:#2C2A3E;}
body.dark .filter-panel{background:#141428;border-color:#2C2A3E;}
/* Compare table dark overrides */
body.dark .sec-hd{background:#080812;border-color:rgba(191,155,78,.12);}
body.dark .val-cell.sec{background:#080812;border-color:rgba(191,155,78,.12);}
body.dark .pdf-btn{background:#0D0D18;border-color:rgba(191,155,78,.25);}
body.dark .pdf-btn:hover{border-color:#D4B880;}
body.dark .lux-hero{background:#04040E;}
body.dark .wcu-sec{background:#0D0D18;}
body.dark .wcu-img-wrap{filter:brightness(.9);}
body.dark .showcase-sec{filter:brightness(.85);}
body.dark .lux-ft{background:#06060F;border-color:#2C2A3E;}
body.dark input,body.dark select,body.dark textarea{background:#1C1C30;border-color:#2C2A3E;color:#FAF8F3;}
body.dark input::placeholder,body.dark textarea::placeholder{color:#6060780;}
body.dark .lc-finp{background:rgba(255,255,255,.06);color:#FFE08A;}
body.dark .det-content{background:#0D0D18;}
body.dark .det{background:#0D0D18;}
/* ── Register Interest / Visit Showroom dialog — dark mode ── */
body.dark .ri-ov{background:rgba(4,4,14,.82);}
body.dark .ri-box{background:#0F0F22;box-shadow:0 32px 80px rgba(0,0,0,.65),0 0 0 1px rgba(191,155,78,.14);}
body.dark .ri-hd{background:linear-gradient(135deg,#12101E 0%,#1E1830 55%,#0E0C18 100%);}
body.dark .ri-hd::after{background:linear-gradient(90deg,transparent,rgba(191,155,78,.4),#BF9B4E,rgba(191,155,78,.4),transparent);}
body.dark .ri-options{border-bottom-color:#2C2A3E;}
body.dark .ri-opt-btn{background:#0F0F22;color:#9090A8;}
body.dark .ri-opt-btn.on{background:#141428;color:#F0EDE6;border-bottom-color:#BF9B4E;}
body.dark .ri-opt-btn:hover:not(.on){background:#1C1C30;color:#D0CCE0;}
body.dark .ri-body{background:#0F0F22;}
body.dark .ri-label{color:#9090A8;}
body.dark .ri-inp{background:#1C1C30;border-color:#2C2A3E;color:#F0EDE6;}
body.dark .ri-inp::placeholder{color:#6060A0;}
body.dark .ri-inp:focus{background:#20203A;border-color:#BF9B4E;box-shadow:0 0 0 3px rgba(191,155,78,.12);}
body.dark .ri-submit{background:linear-gradient(135deg,#D4B880 0%,#BF9B4E 50%,#D4B880 100%);background-size:200% auto;color:#080810;box-shadow:0 4px 18px rgba(191,155,78,.28);}
body.dark .ri-submit:hover:not(:disabled){box-shadow:0 8px 28px rgba(191,155,78,.42);}
body.dark .ri-err{background:#1C1820;border-color:rgba(196,84,62,.4);color:#E07868;}
body.dark .ri-divider{color:#4A4A68;}
body.dark .ri-divider::before,body.dark .ri-divider::after{background:#2C2A3E;}
body.dark .ri-wa-body{background:#0F0F22;}
body.dark .ri-wa-title{color:#F0EDE6;}
body.dark .ri-wa-sub{color:#9090A8;}
body.dark .ri-success{background:#0F0F22;}
body.dark .ri-success-title{color:#F0EDE6;}
body.dark .ri-success-sub{color:#9090A8;}
body.dark .tslot-btn{background:#1C1C30;color:#D0CCE0;border-color:#2C2A3E;}
body.dark .tslot-btn:hover{background:#242442;border-color:#BF9B4E;color:#F0EDE6;}
body.dark .tslot-btn.on{background:linear-gradient(135deg,#D4B880,#BF9B4E);color:#080810;border-color:#BF9B4E;box-shadow:0 2px 12px rgba(191,155,78,.3);}
body.dark .ri-booking-note{color:#9090A8;}
body.dark .ri-booking-note strong{color:#D4B880;}
/* ── Theme toggle button ── */
@keyframes thSpin{from{transform:rotate(0deg) scale(.7);}to{transform:rotate(360deg) scale(1);}}
@keyframes thRayPop{0%{opacity:0;transform:scale(0) rotate(-30deg);}60%{opacity:1;transform:scale(1.2);}100%{transform:scale(1);}}
@keyframes thMoonSlide{0%{opacity:0;transform:rotate(45deg) scale(.6);}100%{opacity:1;transform:rotate(0deg) scale(1);}}
.nav-theme{background:rgba(191,155,78,.06);border:1px solid rgba(191,155,78,.22);width:40px;height:40px;border-radius:999px;display:flex;align-items:center;justify-content:center;color:#FAF8F3;cursor:pointer;transition:background .2s,border-color .2s,transform .2s;flex-shrink:0;backdrop-filter:blur(6px);position:relative;overflow:hidden;}
.nav-theme:hover{background:rgba(191,155,78,.16);transform:translateY(-1px);border-color:rgba(191,155,78,.45);}
.nav-theme:active{transform:scale(.92);}
.nav-theme-ico{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;transition:opacity .25s,transform .3s;}
.nav-theme-ico.sun{opacity:1;transform:scale(1) rotate(0deg);}
.nav-theme-ico.sun.hide{opacity:0;transform:scale(.4) rotate(90deg);}
.nav-theme-ico.moon{opacity:1;transform:scale(1) rotate(0deg);}
.nav-theme-ico.moon.hide{opacity:0;transform:scale(.4) rotate(-90deg);}
.nav-theme.anim .nav-theme-ico.sun:not(.hide){animation:thSpin .45s cubic-bezier(.34,1.56,.64,1) both;}
.nav-theme.anim .nav-theme-ico.moon:not(.hide){animation:thMoonSlide .4s cubic-bezier(.34,1.56,.64,1) both;}
/* ── LIGHT (ROSE GOLD) MODE overrides ── */
body:not(.dark) .nav{background:linear-gradient(135deg,#5C1828 0%,#7A2238 52%,#9B3048 100%);border-bottom-color:rgba(193,126,135,.35);box-shadow:0 8px 32px rgba(92,24,40,.35);}
body:not(.dark) .nav-logo span{color:#FFE0E4;}
body:not(.dark) .ntab{color:rgba(255,210,218,.72);}
body:not(.dark) .ntab:hover{color:#fff;}
body:not(.dark) .ntab.on{color:var(--gold);}
body:not(.dark) .nav-admin{background:rgba(193,126,135,.1);border-color:rgba(193,126,135,.3);}
body:not(.dark) .nav-admin:hover{background:rgba(193,126,135,.22);border-color:rgba(193,126,135,.55);}
body:not(.dark) .nav-admin.on{background:rgba(193,126,135,.25);border-color:rgba(193,126,135,.6);}
body:not(.dark) .nav-theme{background:rgba(193,126,135,.1);border-color:rgba(193,126,135,.3);}
body:not(.dark) .nav-theme:hover{background:rgba(193,126,135,.22);border-color:rgba(193,126,135,.55);}
body:not(.dark) .nav-hamburger{background:rgba(193,126,135,.1);border-color:rgba(193,126,135,.3);}
body:not(.dark) .nav-hamburger:hover{background:rgba(193,126,135,.22);}
body:not(.dark) .nav-hamburger span{background:#FFE0E4;}
body:not(.dark) .nav-cta{box-shadow:0 8px 18px rgba(193,126,135,.4);}
body:not(.dark) .nav-cta:hover{box-shadow:0 14px 28px rgba(193,126,135,.55);}
body:not(.dark) .mob-drawer{background:linear-gradient(180deg,#5C1828 0%,#7A2238 100%);border-right-color:rgba(193,126,135,.22);}
body:not(.dark) .mob-drawer-hd{border-bottom-color:rgba(193,126,135,.22);}
body:not(.dark) .mob-drawer-logo{color:var(--gold);}
body:not(.dark) .mob-drawer-logo span{color:#FFE0E4;}
body:not(.dark) .mob-drawer-x{border-color:rgba(193,126,135,.3);color:var(--gold);}
body:not(.dark) .mob-nav-item{color:rgba(255,210,218,.72);border-left-color:transparent;}
body:not(.dark) .mob-nav-item:hover{background:rgba(193,126,135,.12);color:#fff;}
body:not(.dark) .mob-nav-item.on{color:var(--gold);border-left-color:var(--gold);background:rgba(193,126,135,.1);}
body:not(.dark) .mob-admin-sub-item{color:rgba(255,210,218,.65);}
body:not(.dark) .mob-admin-sub-item:hover{color:#fff;}
body:not(.dark) .mob-admin-sub-item.on{color:var(--gold);}
body:not(.dark) .proj-card{box-shadow:0 2px 16px rgba(193,126,135,.08);}
body:not(.dark) .proj-card:hover{box-shadow:0 8px 32px rgba(193,126,135,.18);border-color:var(--gold);}
body:not(.dark) .lux-hero{background:linear-gradient(160deg,#3D0E1A 0%,#5C1828 40%,#7A2238 100%);}
body:not(.dark) .lux-ft{background:linear-gradient(135deg,#3D0E1A 0%,#5C1828 100%);border-top-color:rgba(193,126,135,.22);}
body:not(.dark) .wcu-sec{background:#FFF5F6;}
body:not(.dark) .showcase-sec{filter:hue-rotate(330deg) saturate(1.1);}
body:not(.dark) .fd-ov{background:rgba(92,24,40,.65);}
body:not(.dark) .fd-sheet{background:linear-gradient(180deg,#5C1828 0%,#3D0E1A 100%);border-color:rgba(193,126,135,.25);}
body:not(.dark) .fd-sheet-hd{border-bottom-color:rgba(193,126,135,.2);}
body:not(.dark) .fd-bar{background:linear-gradient(135deg,#5C1828,#4A1220);border-color:rgba(193,126,135,.18);}
body:not(.dark) .fd-trigger{color:var(--gold);background:rgba(193,126,135,.08);border-color:rgba(193,126,135,.32);}
body:not(.dark) .fd-trigger:hover{background:rgba(193,126,135,.15);}
body:not(.dark) .fd-chip.on{background:linear-gradient(135deg,rgba(193,126,135,.2),rgba(212,164,172,.1));border-color:rgba(193,126,135,.55);color:var(--gold);}
body:not(.dark) .lux-btn-pri{background:linear-gradient(135deg,var(--gold-l),var(--gold));color:#fff;box-shadow:0 8px 18px rgba(193,126,135,.4);}
body:not(.dark) .lux-btn-pri:hover{box-shadow:0 14px 28px rgba(193,126,135,.55);}
body:not(.dark) .lux-stat-num{color:var(--gold);}
body:not(.dark) .list-pager button:hover{background:rgba(193,126,135,.1);}
body:not(.dark) .list-pager button.on{background:var(--gold);}
/* ── LIGHT MODE: reset all hardcoded dark backgrounds ── */
body:not(.dark){
  color:#2D0E14;
  background:linear-gradient(160deg,#FFF5F6 0%,#FDE8EC 55%,#FCE0E6 100%) !important;
  /* Re-map all admin/CRM/settings CSS variables to rose-gold light values */
  --a-bg:#FFFFFF;
  --a-surface:#FFF5F6;
  --a-surface2:#FCE8EB;
  --a-border:#F0D0D4;
  --a-muted:#A07880;
  --a-text:#2D0E14;
  --a-gold:#C17E87;
  --a-cta:#7A2238;
}
body:not(.dark) html,body:not(.dark) .main{background:transparent;}
/* ── LIGHT MODE: admin hardcoded-color overrides (not using --a-vars) ── */
body:not(.dark) .a-shell{background:#FFF5F6;}
body:not(.dark) .a-sidebar{background:#fff;border-right-color:#F0D0D4;}
body:not(.dark) .a-main{background:#FFF5F6;}
body:not(.dark) .a-pg-title{color:#2D0E14;}
body:not(.dark) .a-pg-title em{color:#C17E87;}
body:not(.dark) .a-stat-val{color:#2D0E14;}
body:not(.dark) .a-tbl-name{color:#2D0E14;}
body:not(.dark) .a-tbl thead tr{background:#FCE8EB;}
body:not(.dark) .a-tbl tbody tr:hover{background:rgba(193,126,135,.04);}
body:not(.dark) .a-card-name{color:#2D0E14;}
body:not(.dark) .a-card-grid .a-proj-card{background:#fff;}
body:not(.dark) .a-modal-hd{background:linear-gradient(135deg,#FCE8EB,#F7D4D9);}
body:not(.dark) .a-modal-title{color:#2D0E14;}
body:not(.dark) .a-modal-title em{color:#C17E87;}
body:not(.dark) .a-modal-body{background:#fff;}
body:not(.dark) .a-ico-btn:hover.edit{background:rgba(193,126,135,.06);}
body:not(.dark) .a-ico-btn:hover.del{background:rgba(196,84,62,.06);}
body:not(.dark) .a-sb-item:hover{background:#FCE8EB;color:#5C1828;}
body:not(.dark) .a-sb-item.on{background:#FCE8EB;color:#7A2238;border-left-color:#C17E87;}
/* admin login */
body:not(.dark) .a-login{background:#FFF5F6;}
/* Toggle switch */
body:not(.dark) .tog-track{background:#F0D0D4;border-color:#F0D0D4;}
/* Visibility panel */
body:not(.dark) .vis-master-card{background:#fff;border-color:#F0D0D4;}
body:not(.dark) .vis-master-title{color:#2D0E14;}
body:not(.dark) .vis-tab-card{background:#fff;border-color:#F0D0D4;}
body:not(.dark) .vis-tab-name{color:#2D0E14;}
body:not(.dark) .vis-preview{background:rgba(193,126,135,.06);border-color:rgba(193,126,135,.15);}
/* Settings */
body:not(.dark) .set-card{background:#fff;border-color:#F0D0D4;}
body:not(.dark) .set-preview{background:rgba(193,126,135,.06);border-color:rgba(193,126,135,.15);}
/* CRM hardcoded colors */
body:not(.dark) .crm-modal-hd{background:linear-gradient(135deg,#FCE8EB,#F7D4D9);}
body:not(.dark) .crm-modal-title{color:#2D0E14;}
body:not(.dark) .crm-modal-title em{color:#C17E87;}
body:not(.dark) .crm-modal-body{background:#fff;}
body:not(.dark) .crm-modal-ft{background:#FFF5F6;}
body:not(.dark) .crm-drawer{background:#fff;border-left-color:#F0D0D4;}
body:not(.dark) .crm-drawer-hd{background:linear-gradient(180deg,#FFF5F6,#fff);}
body:not(.dark) .crm-drawer-name{color:#2D0E14;}
body:not(.dark) .crm-drawer-body{background:#FFF5F6;}
body:not(.dark) .crm-stat-val{color:#2D0E14;}
body:not(.dark) .crm-chart-card{background:#fff;}
body:not(.dark) .crm-bar-track{background:rgba(193,126,135,.1);}
body:not(.dark) .crm-tbl thead tr{background:#FCE8EB;}
body:not(.dark) .crm-tbl tbody tr:hover{background:rgba(193,126,135,.04);}
body:not(.dark) .crm-col-body.drag-over{background:rgba(193,126,135,.05);outline-color:rgba(193,126,135,.25);}
body:not(.dark) .crm-card:hover{border-color:rgba(193,126,135,.4);transform:translateY(-1px);}
body:not(.dark) .crm-score-bar{background:rgba(193,126,135,.12);}
body:not(.dark) .crm-wa-link{color:#7A2238;background:rgba(122,34,56,.06);border-color:rgba(122,34,56,.15);}
body:not(.dark) .crm-drawer-sec-hd{background:#FCE8EB;}
/* Map picker */
body:not(.dark) .map-picker-container{background:#FFF5F6;border-color:#F0D0D4;}
body:not(.dark) .map-picker-modal-ft{background:#FFF5F6;}
/* Compare tray */
body:not(.dark) .tray{background:#fff;border-top-color:#F0D0D4;box-shadow:0 -4px 16px rgba(193,126,135,.12);}
body:not(.dark) .tray-lbl{color:#7A2238;}
body:not(.dark) .tslot{border-color:rgba(193,126,135,.3);color:#C17E87;}
body:not(.dark) .tslot.fill{border-color:#F0D0D4;background:#FFF5F6;}
body:not(.dark) .tray-clr{border-color:#F0D0D4;color:#A07880;}
/* Compare table — section header stays dark burgundy (intentional accent) */
body:not(.dark) .sec-hd{background:linear-gradient(135deg,#5C1828,#7A2238);border-color:#7A2238;}
body:not(.dark) .pdf-btn{background:#5C1828;border-color:rgba(255,200,210,.2);}
body:not(.dark) .pdf-btn:hover{border-color:rgba(255,200,210,.55);}
body:not(.dark) .pdf-btn.busy{border-color:#C17E87;box-shadow:0 0 0 1px rgba(193,126,135,.35),0 0 24px rgba(193,126,135,.2);}
body:not(.dark) .cmp-pdf-fx-core{background:radial-gradient(circle,#fff 0%,#C17E87 48%,rgba(193,126,135,.08) 100%);box-shadow:0 0 24px rgba(193,126,135,.65),0 0 80px rgba(193,126,135,.25);}
body:not(.dark) .cmp-pdf-fx-ring{border-color:rgba(193,126,135,.76);}
body:not(.dark) .cmp-pdf-fx-beam{background:linear-gradient(90deg,rgba(193,126,135,.9),rgba(193,126,135,0));}
body:not(.dark) .cmp-pdf-fx-dot{background:#E8B7BE;box-shadow:0 0 10px rgba(193,126,135,.72);}
/* Register interest modal stays light (already uses var(--ink)/parchment correctly) */
body:not(.dark) .ri-opt-btn{background:#FFF5F6;}
body:not(.dark) .ri-opt-btn.on{background:#fff;color:#2D0E14;border-bottom-color:#C17E87;}
/* Cards & listing */
body:not(.dark) .card{background:#fff;border-color:#F0D0D4;box-shadow:0 4px 18px rgba(193,126,135,.1);backdrop-filter:none;}
body:not(.dark) .card:hover{box-shadow:0 12px 40px rgba(193,126,135,.2);border-color:var(--gold);}
body:not(.dark) .cbody{background:#fff;}
body:not(.dark) .cname{color:#2D0E14;}
body:not(.dark) .cdev,.cdev{color:#A07880;}
body:not(.dark) .cloc{color:#A07880;}
body:not(.dark) .cdiv{background:rgba(193,126,135,.18);}
body:not(.dark) .cplbl{color:#A07880;}
body:not(.dark) .cprice{color:var(--gold);}
body:not(.dark) .cmeta{color:#A07880;}
body:not(.dark) .empty-h{color:#2D0E14;}
/* Filter bar & inputs */
body:not(.dark) .filter-panel{background:#fff;border-color:#F0D0D4;backdrop-filter:none;}
body:not(.dark) .filter-top{background:#FFF5F6;border-bottom-color:#F0D0D4;}
body:not(.dark) .filter-row2{background:#FFF5F6;border-bottom-color:#F0D0D4;}
body:not(.dark) .flbl{color:#A07880;}
body:not(.dark) .fsel{background:#FFF5F6;border-color:#F0D0D4;color:#2D0E14;}
body:not(.dark) .fmore-btn{background:#FFF5F6;border-color:#F0D0D4;color:#A07880;}
body:not(.dark) .fmore-btn:hover{border-color:var(--gold);color:var(--gold);}
body:not(.dark) .fclear-btn{color:#A07880;border-color:#F0D0D4;}
body:not(.dark) .rcnt{color:#A07880;}
body:not(.dark) .rcnt strong{color:#2D0E14;}
body:not(.dark) .filter-divider{background:rgba(193,126,135,.2);}
body:not(.dark) .fsize-inp{background:#FFF5F6;border-color:#F0D0D4;color:#2D0E14;}
body:not(.dark) .fsize-inp::placeholder{color:#A07880;}
body:not(.dark) .fsize-sep{color:#A07880;}
body:not(.dark) .s-inp{background:rgba(255,245,246,.95);border-color:rgba(193,126,135,.3);color:#2D0E14;backdrop-filter:none;}
body:not(.dark) .s-inp::placeholder{color:#A07880;}
body:not(.dark) .price-panel{background:#FFF5F6;}
body:not(.dark) .price-panel-label{color:#A07880;}
body:not(.dark) .price-panel-value{color:#2D0E14;}
body:not(.dark) .ps-rail{background:rgba(193,126,135,.18);}
body:not(.dark) .ps-tick-lbl{color:#A07880;}
body:not(.dark) .price-reset{color:#A07880;border-color:#F0D0D4;}
body:not(.dark) .list-pager button{color:#A07880;border-color:#F0D0D4;}
/* Compare page */
body:not(.dark) .cmp-pg{background:linear-gradient(160deg,#FFF5F6 0%,#FDE8EC 100%);}
body:not(.dark) .cmp-title{color:#2D0E14;}
body:not(.dark) .cmp-sub{color:#A07880;}
body:not(.dark) .cmp-nil-h{color:#2D0E14;}
body:not(.dark) .cmp-nil-s{color:#A07880;}
body:not(.dark) .lbl-cell{background:rgba(255,240,242,.97);color:#2D0E14;border-color:rgba(193,126,135,.15);}
body:not(.dark) .val-cell{background:#fff;color:#2D0E14;border-color:rgba(193,126,135,.12);}
body:not(.dark) .val-cell.best-cell{background:rgba(255,230,234,.9);}
body:not(.dark) .proj-card{background:#fff;border-color:rgba(193,126,135,.18);}
body:not(.dark) .proj-nm{color:#2D0E14;}
body:not(.dark) .ctag2{background:rgba(255,230,234,.8);border-color:rgba(193,126,135,.22);color:#5C1828;}
body:not(.dark) .add-more{background:rgba(255,240,242,.8);border-color:rgba(193,126,135,.22);}
body:not(.dark) .add-more p{color:#A07880;}
/* Loan calculator */
body:not(.dark) .lc-pg{background:linear-gradient(160deg,#FFF5F6 0%,#FDE8EC 55%,#FCD8E0 100%);}
body:not(.dark) .lc-pg-grid{background-image:linear-gradient(rgba(193,126,135,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(193,126,135,.06) 1px,transparent 1px);}
body:not(.dark) .lc-pg-blob1{background:radial-gradient(circle,rgba(193,126,135,.1) 0%,transparent 70%);}
body:not(.dark) .lc-pg-blob2{background:radial-gradient(circle,rgba(193,126,135,.07) 0%,transparent 70%);}
body:not(.dark) .lc-gc{background:rgba(255,255,255,.75);border-color:rgba(193,126,135,.2);}
body:not(.dark) .lc-gc:hover{border-color:rgba(193,126,135,.4);box-shadow:0 12px 40px rgba(193,126,135,.12);}
body:not(.dark) .lc-hero-headline{background:linear-gradient(135deg,#7A2238,#C17E87 50%,#5C1828);-webkit-background-clip:text;background-clip:text;}
body:not(.dark) .lc-monthly{background:linear-gradient(160deg,rgba(255,240,242,.97) 0%,rgba(255,235,238,.99) 100%);border-color:rgba(193,126,135,.22);}
body:not(.dark) .lc-monthly::before{background:radial-gradient(ellipse at 50% 0%,rgba(193,126,135,.14) 0%,transparent 65%);}
body:not(.dark) .lc-monthly-val{background:linear-gradient(135deg,#7A2238,#C17E87);-webkit-background-clip:text;background-clip:text;}
body:not(.dark) .lc-monthly-eyebrow{color:rgba(92,24,40,.6);}
body:not(.dark) .lc-monthly-meta{color:rgba(45,14,20,.45);}
body:not(.dark) .lc-monthly-leg{color:rgba(45,14,20,.5);}
body:not(.dark) .lc-metric{background:rgba(255,255,255,.8);}
body:not(.dark) .lc-metric-lbl{color:rgba(45,14,20,.4);}
body:not(.dark) .lc-metric-val{color:#7A2238;}
body:not(.dark) .lc-metric-val.cyan{color:#5C1828;}
body:not(.dark) .lc-netcash{background:linear-gradient(135deg,rgba(220,252,231,.9),rgba(187,247,208,.8));border-color:rgba(74,222,128,.3);}
body:not(.dark) .lc-bkd-btn{color:rgba(92,24,40,.6);}
body:not(.dark) .lc-bkd-btn:hover{color:#7A2238;}
body:not(.dark) .lc-bkd-section-title{color:rgba(122,34,56,.5);}
body:not(.dark) .lc-bkd-row{border-bottom-color:rgba(193,126,135,.08);}
body:not(.dark) .lc-bkd-rowlbl{color:rgba(45,14,20,.5);}
body:not(.dark) .lc-bkd-rowval{color:rgba(45,14,20,.8);}
body:not(.dark) .lc-bkd-rowval.gold{color:#7A2238;}
body:not(.dark) .lc-bkd-total{border-top-color:rgba(193,126,135,.25);}
body:not(.dark) .lc-bkd-total-lbl{color:#2D0E14;}
body:not(.dark) .lc-bkd-note{color:rgba(45,14,20,.3);}
body:not(.dark) .lc-finp{background:rgba(255,245,246,.9);color:#7A2238;border-color:rgba(193,126,135,.25);}
body:not(.dark) .lc-finp:focus{border-color:var(--gold);}
body:not(.dark) .lc-fslider{background:linear-gradient(90deg,rgba(193,126,135,.25),rgba(193,126,135,.1));}
body:not(.dark) .lc-fslider::-webkit-slider-thumb{background:linear-gradient(135deg,#D4A4AC,#C17E87);}
body:not(.dark) .lc-fslider-val{color:var(--gold);}
body:not(.dark) .lc-fslider-ends{color:rgba(45,14,20,.3);}
body:not(.dark) .lc-flbl{color:rgba(45,14,20,.55);}
body:not(.dark) .lc-adj{background:rgba(255,230,234,.5);border-color:rgba(193,126,135,.22);}
body:not(.dark) .lc-adj strong{color:#7A2238;}
body:not(.dark) .lc-rebate-note{background:rgba(255,245,246,.7);border-color:rgba(193,126,135,.14);color:rgba(45,14,20,.5);}
body:not(.dark) .lc-foreign-note{background:rgba(255,230,234,.5);border-color:rgba(193,126,135,.2);color:#7A2238;}
body:not(.dark) .lc-tpill{border-color:rgba(193,126,135,.22);}
body:not(.dark) .lc-tpill button{color:rgba(45,14,20,.4);}
body:not(.dark) .lc-tpill button.on{background:linear-gradient(135deg,#C17E87,#D4A4AC);color:#fff;}
body:not(.dark) .lc-mob-bar{background:rgba(255,245,246,.96);border-top-color:rgba(193,126,135,.2);}
body:not(.dark) .lc-mob-val{color:var(--gold);}
body:not(.dark) .lc-mob-monthly,.lc-mob-sub{color:rgba(45,14,20,.45);}
/* Why Choose Us & sections */
body:not(.dark) .wcu-sec{background:#FFF5F6;}
body:not(.dark) .wcu-title{color:#2D0E14;}
body:not(.dark) .wcu-desc{color:rgba(45,14,20,.55);}
body:not(.dark) .wcu-feat{background:rgba(255,240,242,.7);border-color:rgba(193,126,135,.14);}
body:not(.dark) .wcu-feat:hover{border-color:rgba(193,126,135,.4);box-shadow:0 12px 32px rgba(193,126,135,.15);}
body:not(.dark) .wcu-feat-title{color:#2D0E14;}
body:not(.dark) .wcu-feat-desc{color:rgba(45,14,20,.5);}
body:not(.dark) .sec-label{background:#FFF5F6;}
body:not(.dark) .sec-label-title{color:#2D0E14;}
body:not(.dark) .sec-label-sub{color:rgba(45,14,20,.5);}
/* Stats bar on hero (light) */
body:not(.dark) .lux-stats-bar{background:rgba(255,245,246,.9);border-top-color:rgba(193,126,135,.18);}
body:not(.dark) .lux-stat{border-right-color:rgba(193,126,135,.15);}
body:not(.dark) .lux-stat-lbl{color:rgba(45,14,20,.45);}
body:not(.dark) .lux-h1{color:#fff;}
body:not(.dark) .lux-tagline{color:rgba(255,240,242,.72);}
body:not(.dark) .lux-hero-search-inp{background:rgba(255,245,246,.1);border-color:rgba(255,210,218,.35);color:#fff;}
body:not(.dark) .lux-hero-search-inp::placeholder{color:rgba(255,220,225,.45);}
body:not(.dark) .lux-btn-sec{border-color:rgba(255,220,225,.35);color:#FFE0E4;}
body:not(.dark) .lux-btn-sec:hover{border-color:var(--gold);color:#fff;}
/* ── LIGHT MODE: text contrast fixes ── */
/* Filter dialog — all text inside fd-sheet on rose background is readable */
body:not(.dark) .fd-hd-title{color:#fff;}
body:not(.dark) .fd-close{color:rgba(255,230,234,.7);border-color:rgba(255,200,210,.2);}
body:not(.dark) .fd-close:hover{color:#fff;}
body:not(.dark) .fd-rcnt{color:rgba(255,220,225,.65);}
body:not(.dark) .fd-rcnt strong{color:#fff;}
body:not(.dark) .fd-sec-title{color:rgba(255,210,218,.55);}
body:not(.dark) .fd-chip{color:rgba(255,215,220,.8);border-color:rgba(255,200,210,.18);background:rgba(255,255,255,.06);}
body:not(.dark) .fd-chip:hover{color:#fff;border-color:rgba(255,200,210,.45);}
body:not(.dark) .fd-sidebar-title{color:#fff;}
body:not(.dark) .fd-sidebar-empty{color:rgba(255,210,218,.4);}
body:not(.dark) .fd-sidebar-clear{color:rgba(255,210,218,.5);border-color:rgba(255,200,210,.2);}
body:not(.dark) .fd-size-inp{color:#fff;background:rgba(255,255,255,.1);border-color:rgba(255,200,210,.25);}
body:not(.dark) .fd-size-inp::placeholder{color:rgba(255,210,218,.4);}
body:not(.dark) .fd-size-sep{color:rgba(255,210,218,.4);}
body:not(.dark) .fd-ft-clear{color:rgba(255,210,218,.6);border-color:rgba(255,200,210,.15);}
/* Filter — bright mode mobile overrides */
@media(max-width:768px){
  body:not(.dark) .fd-bar{background:#fff;border-color:#F0D0D4;box-shadow:0 2px 12px rgba(193,126,135,.12);}
  body:not(.dark) .fd-rcnt{background:rgba(193,126,135,.05);border-color:rgba(193,126,135,.2);color:#7A2238;}
  body:not(.dark) .fd-rcnt strong{color:#2D0E14;}
  body:not(.dark) .fd-pills{border-top-color:rgba(193,126,135,.12);}
  body:not(.dark) .fd-sheet{background:linear-gradient(190deg,#fff 0%,#FFF0F3 100%);}
  body:not(.dark) .fd-handle{background:rgba(193,126,135,.22);}
  body:not(.dark) .fd-hd{border-bottom-color:#F0D0D4;}
  body:not(.dark) .fd-hd-title{color:#2D0E14;}
  body:not(.dark) .fd-hd-cnt{color:#7A2238;background:rgba(193,126,135,.1);border-color:rgba(193,126,135,.22);}
  body:not(.dark) .fd-close{color:#A07880;border-color:#F0D0D4;}
  body:not(.dark) .fd-close:hover{color:#2D0E14;background:rgba(193,126,135,.08);}
  body:not(.dark) .fd-sec-label{color:#A07880;border-bottom-color:#F0D0D4;}
  body:not(.dark) .fd-sec-label::before{background:rgba(193,126,135,.35);}
  body:not(.dark) .fd-chip{color:#7A2238;border-color:rgba(193,126,135,.2);background:rgba(255,245,246,.8);}
  body:not(.dark) .fd-chip:hover{background:rgba(255,225,230,.95);border-color:rgba(193,126,135,.45);color:#5C1828;}
  body:not(.dark) .fd-chip.on{background:linear-gradient(135deg,rgba(193,126,135,.18),rgba(212,164,172,.12));border-color:rgba(193,126,135,.55);color:#5C1828;font-weight:700;}
  body:not(.dark) .fd-size-inp{background:rgba(255,245,246,.9);border-color:rgba(193,126,135,.25);color:#2D0E14;}
  body:not(.dark) .fd-size-inp::placeholder{color:#C17E87;}
  body:not(.dark) .fd-size-sep{color:#C17E87;}
  body:not(.dark) .fd-ft{border-top-color:#F0D0D4;background:linear-gradient(0deg,rgba(255,245,246,.95),transparent);}
  body:not(.dark) .fd-ft-clear{color:#A07880;border-color:#F0D0D4;background:transparent;}
  body:not(.dark) .fd-ft-apply{background:linear-gradient(135deg,#C17E87,#A05060);color:#fff;box-shadow:0 4px 20px rgba(193,126,135,.35);}
  body:not(.dark) .fd-ft-apply:hover{box-shadow:0 6px 28px rgba(193,126,135,.55);transform:translateY(-1px);}
}
/* Filter bar (inline) — sits on rose-gradient page bg, text must be dark */
body:not(.dark) .fd-bar{background:#fff;border-color:#F0D0D4;box-shadow:0 2px 12px rgba(193,126,135,.12);}
body:not(.dark) .fd-trigger{color:#7A2238;background:rgba(193,126,135,.06);border-color:rgba(193,126,135,.28);}
body:not(.dark) .fd-trigger:hover{color:#5C1828;background:rgba(193,126,135,.12);}
body:not(.dark) .fd-rcnt{color:#A07880;}
body:not(.dark) .fd-rcnt strong{color:#2D0E14;}
body:not(.dark) .fd-pills .fd-pill{background:rgba(193,126,135,.1);border-color:rgba(193,126,135,.25);color:#7A2238;}
body:not(.dark) .fd-pill-x{color:#C17E87;}
/* Listing cards — dark ink on white */
body:not(.dark) .cname{color:#2D0E14;}
body:not(.dark) .cdev{color:#7A2238;}
body:not(.dark) .cloc{color:#7A2238;}
body:not(.dark) .cplbl{color:#A07880;}
body:not(.dark) .cprice{color:#7A2238;}
body:not(.dark) .cmeta{color:#A07880;}
body:not(.dark) .cbody{color:#2D0E14;}
/* Section label */
body:not(.dark) .sec-label-eye{color:#C17E87;}
body:not(.dark) .sec-label-title{color:#2D0E14;}
body:not(.dark) .sec-label-title em{color:#C17E87;}
body:not(.dark) .sec-label-sub{color:#7A2238;}
/* Filter pills / selects */
body:not(.dark) .fsel{color:#2D0E14;}
body:not(.dark) .fsel option{color:#2D0E14;background:#fff;}
body:not(.dark) .flbl{color:#7A2238;}
body:not(.dark) .rcnt{color:#A07880;}
body:not(.dark) .rcnt strong{color:#2D0E14;}
body:not(.dark) .fmore-btn{color:#7A2238;}
body:not(.dark) .fclear-btn{color:#A07880;}
body:not(.dark) .fsize-inp{color:#2D0E14;}
body:not(.dark) .fsize-inp::placeholder{color:#C17E87;}
body:not(.dark) .fsize-sep{color:#C17E87;}
body:not(.dark) .s-inp{color:#2D0E14;}
body:not(.dark) .s-inp::placeholder{color:#C17E87;}
body:not(.dark) .price-panel-label{color:#7A2238;}
body:not(.dark) .price-panel-value{color:#2D0E14;}
body:not(.dark) .ps-tick-lbl{color:#A07880;}
body:not(.dark) .price-reset{color:#A07880;}
body:not(.dark) .list-pager button{color:#7A2238;}
body:not(.dark) .list-pager .page-info{color:#A07880;}
/* Compare page */
body:not(.dark) .cmp-title{color:#2D0E14;}
body:not(.dark) .cmp-sub{color:#7A2238;}
body:not(.dark) .cmp-nil-h{color:#2D0E14;}
body:not(.dark) .cmp-nil-s{color:#7A2238;}
body:not(.dark) .lbl-cell{color:#2D0E14;}
body:not(.dark) .val-cell{color:#2D0E14;}
body:not(.dark) .proj-nm{color:#2D0E14;}
body:not(.dark) .ctag2{color:#5C1828;}
body:not(.dark) .add-more p{color:#A07880;}
/* WCU */
body:not(.dark) .wcu-eyebrow{color:#C17E87;}
body:not(.dark) .wcu-title{color:#2D0E14;}
body:not(.dark) .wcu-title em{color:#C17E87;}
body:not(.dark) .wcu-desc{color:#7A2238;}
body:not(.dark) .wcu-feat-title{color:#2D0E14;}
body:not(.dark) .wcu-feat-desc{color:#7A2238;}
/* Loan calculator light contrast */
body:not(.dark) .lc-hero-eyebrow{color:#C17E87;}
body:not(.dark) .lc-hero-desc{color:#7A2238;}
body:not(.dark) .lc-savings-band{color:#2D0E14;}
body:not(.dark) .lc-savings-band strong{color:#16a34a;}
body:not(.dark) .lc-savings-band span{color:#7A2238;}
body:not(.dark) .lc-bm-badge{color:#166534;}
body:not(.dark) .lc-sec-title{color:#7A2238;}
/* ── Loan calculator light-theme text contrast fixes ── */
body:not(.dark) .lc-flbl{color:rgba(45,14,20,.6);}
body:not(.dark) .lc-fslider-ends{color:rgba(45,14,20,.38);}
body:not(.dark) .lc-adj{color:rgba(45,14,20,.7);background:rgba(255,230,234,.4);border-color:rgba(193,126,135,.22);}
body:not(.dark) .lc-rebate-note{color:rgba(45,14,20,.52);background:rgba(255,245,246,.6);border-color:rgba(193,126,135,.14);}
body:not(.dark) .lc-tpill button{color:rgba(45,14,20,.45);}
body:not(.dark) .lc-mode-toggle{border-color:rgba(193,126,135,.3);}
body:not(.dark) .lc-mode-toggle button{color:rgba(45,14,20,.45);}
body:not(.dark) .lc-monthly-meta{color:rgba(45,14,20,.5);}
body:not(.dark) .lc-metric-lbl{color:rgba(45,14,20,.5);}
body:not(.dark) .lc-metric-val.dim{color:rgba(45,14,20,.5);}
body:not(.dark) .lc-netcash-lbl{color:rgba(22,101,52,.7);}
body:not(.dark) .lc-netcash-val{color:#16a34a;}
body:not(.dark) .lc-netcash-save-lbl{color:rgba(22,101,52,.6);}
body:not(.dark) .lc-netcash-save-val{color:#16a34a;}
body:not(.dark) .lc-bkd-total-lbl{color:#2D0E14;}
body:not(.dark) .lc-bkd-note{color:rgba(45,14,20,.38);}
body:not(.dark) .lc-amort-eyebrow{color:var(--gold);}
body:not(.dark) .lc-amort-axis{color:rgba(45,14,20,.35);}
body:not(.dark) .lc-amort-svg-wrap{background:rgba(193,126,135,.05);}
body:not(.dark) .lc-cbar-title{color:rgba(45,14,20,.4);}
body:not(.dark) .lc-cbar-leg{color:rgba(45,14,20,.5);}
body:not(.dark) .lc-mob-monthly{color:rgba(45,14,20,.5);}
body:not(.dark) .lc-mob-sub{color:rgba(45,14,20,.42);}
body:not(.dark) .lc-monthly-ring-pct{color:#7A2238;}
body:not(.dark) .lc-monthly-ring-pctlbl{color:rgba(92,24,40,.5);}
body:not(.dark) .ob-ov{background:rgba(45,14,20,.7);}
body:not(.dark) .ob-desc{color:rgba(45,14,20,.6);}
body:not(.dark) .ob-eyebrow{color:#C17E87;}
body:not(.dark) .ob-title{background:linear-gradient(135deg,#5C1828,#C17E87 50%,#7A2238);-webkit-background-clip:text;background-clip:text;}
body:not(.dark) .ob-feat{background:rgba(255,240,242,.6);border-color:rgba(193,126,135,.15);}
body:not(.dark) .ob-feat-title{color:#2D0E14;}
body:not(.dark) .ob-feat-desc{color:#7A2238;}
body:not(.dark) .ob-tip-box{background:rgba(255,230,234,.5);border-color:rgba(193,126,135,.2);color:#7A2238;}
body:not(.dark) .ob-skip{color:rgba(45,14,20,.35);}
body:not(.dark) .ob-skip:hover{color:rgba(45,14,20,.6);}
body:not(.dark) .ob-dot{background:rgba(45,14,20,.2);}
body:not(.dark) .ob-btn-back{color:rgba(45,14,20,.5);border-color:rgba(45,14,20,.15);}
body:not(.dark) .ob-btn-back:hover{color:rgba(45,14,20,.8);}
/* Footer links */
body:not(.dark) .lux-ft-tagline{color:rgba(255,230,234,.6);}
body:not(.dark) .lux-ft-link{color:rgba(255,220,225,.55);}
body:not(.dark) .lux-ft-link:hover{color:#fff;}
body:not(.dark) .lux-ft-copy{color:rgba(255,220,225,.35);}
body:not(.dark) .lux-ft-copy span{color:rgba(255,200,210,.55);}
/* Pager info */
body:not(.dark) .list-pager .page-info{color:#A07880;}
/* ── LIGHT MODE: Detail page overrides ── */
/* Base page & content area */
body:not(.dark) .det{background:var(--parchment);}
body:not(.dark) .det-content{background:var(--parchment);}
/* Gallery strip */
body:not(.dark) .gal-strip{background:linear-gradient(180deg,#F2D6DB,#ECC8CF);}
body:not(.dark) .gal-t{opacity:.7;}
body:not(.dark) .gal-t:hover,body:not(.dark) .gal-t.on{opacity:1;}
/* Tab bar */
body:not(.dark) .det-tabs{background:linear-gradient(180deg,#fff,#FFF0F2);border-bottom:1px solid #F0D0D4;box-shadow:0 2px 8px rgba(193,126,135,.1);}
body:not(.dark) .det-tab{color:rgba(45,14,20,.45);}
body:not(.dark) .det-tab:hover{color:#7A2238;background:rgba(193,126,135,.06);}
body:not(.dark) .det-tab.on{color:#5C1828;}
body:not(.dark) .det-tab.on::after{background:linear-gradient(90deg,#C17E87,#7A2238);box-shadow:none;}
/* Spec section headers (dark strip inside cards) */
body:not(.dark) .spec-sec-hd,body:not(.dark) .lu-hd{background:linear-gradient(180deg,#FCE8EB,#F7D4D9);color:#5C1828;border-bottom:1px solid #F0D0D4;}
body:not(.dark) .spec-sec-hd span,body:not(.dark) .lu-hd span{background:rgba(92,24,40,.1);}
/* Spec rows */
body:not(.dark) .spec-row:hover{background:rgba(193,126,135,.04);}
body:not(.dark) .spec-key{color:#A07880;}
body:not(.dark) .spec-val{color:#2D0E14;}
/* Highlights */
body:not(.dark) .hi-item{color:#2D0E14;border-bottom-color:rgba(193,126,135,.12);}
body:not(.dark) .hi-item:hover{background:rgba(193,126,135,.06);}
body:not(.dark) .hi-dot{background:linear-gradient(135deg,#C17E87,#D4A4AC);box-shadow:0 0 0 3px rgba(193,126,135,.12);}
/* Description */
body:not(.dark) .det-desc-p{background:linear-gradient(180deg,#fff,#FFF5F6);color:#2D0E14;}
body:not(.dark) .det-desc-p::before{color:#C17E87;}
/* Facility chips */
body:not(.dark) .fac-chips{background:linear-gradient(180deg,#fff,#FFF5F6);}
body:not(.dark) .fac-chip{background:#fff;border-color:#F0D0D4;color:#2D0E14;}
body:not(.dark) .fac-chip::before{background:#C17E87;}
body:not(.dark) .fac-chip:hover{background:#5C1828;color:#fff;border-color:#5C1828;}
/* Amenity cards */
body:not(.dark) .amenity-cat{background:#fff;border-color:#F0D0D4;}
body:not(.dark) .amenity-hd{background:linear-gradient(180deg,#FCE8EB,#F7D4D9);color:#5C1828;border-bottom-color:#F0D0D4;}
body:not(.dark) .amenity-item{color:#2D0E14;border-bottom-color:rgba(193,126,135,.1);}
body:not(.dark) .amenity-item:hover{background:rgba(193,126,135,.05);}
body:not(.dark) .amenity-dot{background:linear-gradient(135deg,#C17E87,#D4A4AC);}
/* Section cards */
body:not(.dark) .spec-section{background:#fff;border-color:#F0D0D4;}
body:not(.dark) .spec-section:hover{border-color:rgba(193,126,135,.35);}
/* Unit layout cards */
body:not(.dark) .ut-card{background:#fff;border-color:#F0D0D4;}
body:not(.dark) .ut-img-label{background:linear-gradient(135deg,#5C1828,#7A2238);}
body:not(.dark) .ut-label-badge{background:rgba(255,255,255,.15);color:#fff;}
body:not(.dark) .ut-name{color:#2D0E14;}
body:not(.dark) .ut-price-badge{background:linear-gradient(135deg,#5C1828,#7A2238);}
body:not(.dark) .ut-stat{background:#FFF5F6;border-color:#F0D0D4;}
body:not(.dark) .ut-stat:hover{border-color:#C17E87;background:#FCE8EB;}
body:not(.dark) .ut-desc{color:#7A2238;}
body:not(.dark) .layouts-intro{background:rgba(193,126,135,.08);color:#5C1828;}
/* Scrollbar */
body:not(.dark) .det-content::-webkit-scrollbar-thumb{background:rgba(193,126,135,.25);}
body:not(.dark) .det-sticky-bar::before{background:linear-gradient(to top,rgba(255,245,246,.98),transparent);}
/* Price / CTA bar stays dark burgundy (intentional — matches nav/footer) */
body:not(.dark) .price-bar{background:linear-gradient(135deg,#5C1828 0%,#7A2238 60%,#9B3048 100%);border-top:1px solid rgba(255,200,210,.12);}
body:not(.dark) .price-bar::after{opacity:.2;}
body:not(.dark) .pb-left .pb-lbl{color:rgba(255,220,225,.6);}
body:not(.dark) .pb-price{color:#FFD4D8;}
body:not(.dark) .pb-price span{color:rgba(255,200,210,.7);}
body:not(.dark) .pb-btn1{background:linear-gradient(135deg,#D4A4AC,#C17E87);box-shadow:0 6px 18px -4px rgba(193,126,135,.45);}
body:not(.dark) .pb-btn2{border-color:rgba(255,200,210,.35);color:rgba(255,230,234,.85);}
body:not(.dark) .pb-btn2:hover{border-color:#FFD4D8;color:#fff;background:rgba(255,200,210,.1);}
/* Map */
body:not(.dark) .map-embed{border-color:#F0D0D4;}
body:not(.dark) .map-placeholder{background:#FCE8EB;color:#A07880;}
/* ══════════════════════════════════════════════
   LIGHT MODE — Cinema / Project Detail Page (cine-*)
   All elements were hardcoded dark; override here.
══════════════════════════════════════════════ */
/* Base container */
body:not(.dark) .cine-det{background:linear-gradient(160deg,#FFF5F6 0%,#FDE8EC 55%,#FCE0E6 100%);color:#2D0E14;}
/* Ambient blobs — shift to rose tones */
body:not(.dark) .cine-blob.b1{background:radial-gradient(circle,rgba(193,126,135,.4),transparent 70%);}
body:not(.dark) .cine-blob.b2{background:radial-gradient(circle,rgba(212,164,172,.3),transparent 70%);}
body:not(.dark) .cine-blob.b3{background:radial-gradient(circle,rgba(193,126,135,.35),transparent 70%);}
body:not(.dark) .cine-blob.b4{background:radial-gradient(circle,rgba(160,120,128,.25),transparent 70%);}
/* Floating nav pill */
body:not(.dark) .cine-nav{background:rgba(255,255,255,.9);border-color:rgba(193,126,135,.25);box-shadow:0 8px 32px rgba(92,24,40,.15),inset 0 1px 0 rgba(255,255,255,.8);}
body:not(.dark) .cine-back{color:#7A2238;background:rgba(193,126,135,.08);border-color:rgba(193,126,135,.22);}
body:not(.dark) .cine-back:hover{background:rgba(193,126,135,.18);border-color:rgba(193,126,135,.5);color:#5C1828;}
body:not(.dark) .cine-nav-divider{background:rgba(193,126,135,.2);}
body:not(.dark) .cine-nav-tab{color:rgba(45,14,20,.45);}
body:not(.dark) .cine-nav-tab:hover{color:rgba(45,14,20,.85);background:rgba(193,126,135,.06);}
body:not(.dark) .cine-nav-tab.on{background:linear-gradient(135deg,rgba(193,126,135,.15),rgba(212,164,172,.08));border-color:rgba(193,126,135,.4);color:#7A2238;box-shadow:0 0 16px rgba(193,126,135,.12);}
/* Hero — keep dark overlay since it's over a photo */
body:not(.dark) .cine-hero-overlay{background:linear-gradient(180deg,rgba(45,14,20,.15) 0%,rgba(45,14,20,.05) 30%,rgba(45,14,20,.5) 65%,rgba(45,14,20,.94) 100%);}
body:not(.dark) .cine-hero-side-glow{background:radial-gradient(ellipse 50% 60% at 50% 100%,rgba(193,126,135,.1),transparent 60%);}
/* Gallery thumbs */
body:not(.dark) .cine-gal-thumb{border-color:rgba(255,255,255,.2);}
body:not(.dark) .cine-gal-thumb.on{border-color:#C17E87;box-shadow:0 0 14px rgba(193,126,135,.35);}
/* Hero nav arrows */
body:not(.dark) .cine-hero-nav-btn{background:rgba(255,255,255,.15);border-color:rgba(255,255,255,.25);}
body:not(.dark) .cine-hero-nav-btn:hover{background:rgba(193,126,135,.25);border-color:rgba(193,126,135,.6);}
/* Hero meta chips — on dark overlay, stay light */
body:not(.dark) .cine-meta-chip{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.22);color:rgba(255,255,255,.85);}
body:not(.dark) .cine-meta-chip.accent{background:linear-gradient(135deg,rgba(193,126,135,.25),rgba(212,164,172,.15));border-color:rgba(193,126,135,.55);color:#FFD4D8;}
/* Sub-hero info bar */
body:not(.dark) .cine-hero-bar{background:rgba(255,255,255,.9);border-top-color:rgba(193,126,135,.18);border-bottom-color:rgba(193,126,135,.08);backdrop-filter:blur(20px);box-shadow:0 8px 32px rgba(92,24,40,.1);}
body:not(.dark) .cine-hero-bar-subtitle{color:rgba(45,14,20,.6);}
body:not(.dark) .cine-stats{gap:.65rem;}
body:not(.dark) .cine-stat{background:rgba(255,245,246,.8);border-color:rgba(193,126,135,.2);}
body:not(.dark) .cine-stat:hover{background:rgba(255,230,234,.9);border-color:rgba(193,126,135,.45);}
body:not(.dark) .cine-stat-lbl{color:rgba(122,34,56,.6);}
body:not(.dark) .cine-stat-val{color:#2D0E14;}
body:not(.dark) .cine-stat-val span{color:rgba(122,34,56,.75);}
/* CTA buttons — keep primary, update secondary */
body:not(.dark) .cine-cta-pri{color:#fff;}
body:not(.dark) .cine-cta-sec{background:rgba(193,126,135,.06);border-color:rgba(193,126,135,.32);color:#fff;}
body:not(.dark) .cine-cta-sec:hover{background:rgba(193,126,135,.15);border-color:rgba(193,126,135,.6);color:#fff;}
/* Eyebrow / section labels */
body:not(.dark) .cine-eyebrow{color:rgba(193,126,135,.85);}
body:not(.dark) .cine-eyebrow::before{background:rgba(193,126,135,.6);}
body:not(.dark) .cine-sec-eyebrow{color:rgba(193,126,135,.8);}
body:not(.dark) .cine-sec-eyebrow::before{background:rgba(193,126,135,.55);}
body:not(.dark) .cine-sec-title{color:#2D0E14;}
body:not(.dark) .cine-sec-num{color:rgba(193,126,135,.06);}
/* Sections & dividers */
body:not(.dark) .cine-section+.cine-section{border-top-color:rgba(193,126,135,.1);}
body:not(.dark) .cine-divider::before,body:not(.dark) .cine-divider::after{background:linear-gradient(90deg,transparent,rgba(193,126,135,.25),transparent);}
body:not(.dark) .cine-divider-gem{background:rgba(193,126,135,.5);box-shadow:0 0 8px rgba(193,126,135,.35);}
/* Stats strip */
body:not(.dark) .cine-stats-strip{background:rgba(255,255,255,.95);border-bottom-color:rgba(193,126,135,.15);}
body:not(.dark) .cine-stats-strip::before{background:radial-gradient(ellipse 60% 100% at 50% 0%,rgba(193,126,135,.05),transparent);}
body:not(.dark) .css-item{border-right-color:rgba(193,126,135,.1);}
body:not(.dark) .css-item:hover{background:rgba(193,126,135,.04);}
body:not(.dark) .css-lbl{color:rgba(122,34,56,.55);}
body:not(.dark) .css-val{color:#2D0E14;}
body:not(.dark) .css-val em{color:rgba(122,34,56,.75);}
/* Bento cards (highlights) */
body:not(.dark) .cine-bento-card{background:rgba(255,245,246,.6);border-color:rgba(193,126,135,.12);}
body:not(.dark) .cine-bento-card:hover{background:rgba(255,235,238,.8);border-color:rgba(193,126,135,.35);box-shadow:0 20px 48px rgba(92,24,40,.1),0 0 32px rgba(193,126,135,.06);}
body:not(.dark) .cine-bento-icon{background:linear-gradient(135deg,rgba(193,126,135,.12),rgba(212,164,172,.07));border-color:rgba(193,126,135,.22);}
body:not(.dark) .cine-bento-card:hover .cine-bento-icon{background:linear-gradient(135deg,rgba(193,126,135,.22),rgba(212,164,172,.14));}
body:not(.dark) .cine-bento-title{color:#2D0E14;}
body:not(.dark) .cine-bento-desc{color:rgba(45,14,20,.5);}
body:not(.dark) .cine-bento-accent{background:linear-gradient(90deg,transparent,rgba(193,126,135,.45),transparent);}
/* Spec table */
body:not(.dark) .cine-info-group-title{color:rgba(122,34,56,.8);border-bottom-color:rgba(193,126,135,.15);}
body:not(.dark) .cine-info-group-title::before{background:linear-gradient(90deg,#C17E87,#D4A4AC);}
body:not(.dark) .cine-spec-table{background:rgba(255,245,246,.5);border-color:rgba(193,126,135,.12);}
body:not(.dark) .cine-spec-row{border-bottom-color:rgba(193,126,135,.08);}
body:not(.dark) .cine-spec-row:hover{background:rgba(193,126,135,.04);}
body:not(.dark) .cine-spec-key{color:rgba(122,34,56,.65);}
body:not(.dark) .cine-spec-val{color:rgba(45,14,20,.82);}
/* Description block */
body:not(.dark) .cine-desc-block{background:rgba(255,245,246,.5);border-color:rgba(193,126,135,.12);border-left-color:rgba(193,126,135,.55);color:rgba(45,14,20,.7);}
body:not(.dark) .cine-desc-block::before{color:rgba(193,126,135,.18);}
/* Facility chips & cards */
body:not(.dark) .cine-fac-chip{background:rgba(255,245,246,.5);border-color:rgba(193,126,135,.15);color:rgba(45,14,20,.65);}
body:not(.dark) .cine-fac-chip::before{background:rgba(193,126,135,.65);}
body:not(.dark) .cine-fac-chip:hover{background:rgba(255,230,234,.8);border-color:rgba(193,126,135,.38);color:#7A2238;}
body:not(.dark) .cine-fac-card{background:rgba(255,245,246,.5);border-color:rgba(193,126,135,.12);}
body:not(.dark) .cine-fac-card:hover{background:rgba(255,230,234,.8);border-color:rgba(193,126,135,.35);}
body:not(.dark) .cine-fac-card-icon{background:linear-gradient(135deg,rgba(193,126,135,.1),rgba(212,164,172,.06));border-color:rgba(193,126,135,.2);}
body:not(.dark) .cine-fac-card:hover .cine-fac-card-icon{background:linear-gradient(135deg,rgba(193,126,135,.2),rgba(212,164,172,.12));}
body:not(.dark) .cine-fac-card-name{color:rgba(45,14,20,.65);}
body:not(.dark) .cine-fac-card:hover .cine-fac-card-name{color:#7A2238;}
/* Map */
body:not(.dark) .cine-map-wrap{border-color:rgba(193,126,135,.18);}
body:not(.dark) .cine-map-placeholder{background:rgba(193,126,135,.04);color:rgba(45,14,20,.4);}
body:not(.dark) .cine-map-overlay-tag{background:rgba(255,255,255,.92);border-color:rgba(193,126,135,.28);color:#2D0E14;backdrop-filter:blur(12px);}
/* Location distance cards */
body:not(.dark) .cine-loc-dist-card{background:rgba(255,245,246,.5);border-color:rgba(193,126,135,.12);}
body:not(.dark) .cine-loc-dist-card:hover{background:rgba(255,230,234,.8);border-color:rgba(193,126,135,.3);}
body:not(.dark) .cine-loc-dist-card .lbl{color:rgba(122,34,56,.6);}
body:not(.dark) .cine-loc-dist-card .val{color:#2D0E14;}
/* Amenity cards */
body:not(.dark) .cine-amenity-card{background:rgba(255,245,246,.5);border-color:rgba(193,126,135,.1);}
body:not(.dark) .cine-amenity-card:hover{background:rgba(255,235,238,.8);border-color:rgba(193,126,135,.3);box-shadow:0 12px 32px rgba(92,24,40,.1);}
body:not(.dark) .cine-amenity-hd{background:rgba(255,230,234,.5);border-bottom-color:rgba(193,126,135,.1);color:rgba(45,14,20,.75);}
body:not(.dark) .cine-amenity-icon{background:linear-gradient(135deg,rgba(193,126,135,.1),rgba(212,164,172,.06));border-color:rgba(193,126,135,.2);}
body:not(.dark) .cine-amenity-item{color:rgba(45,14,20,.58);border-bottom-color:rgba(193,126,135,.05);}
body:not(.dark) .cine-amenity-item:hover{color:#2D0E14;background:rgba(193,126,135,.04);}
body:not(.dark) .cine-amenity-dot{background:rgba(193,126,135,.65);}
/* Unit layout cards */
body:not(.dark) .cine-unit-card{background:rgba(255,245,246,.6);border-color:rgba(193,126,135,.12);}
body:not(.dark) .cine-unit-card:hover{border-color:rgba(193,126,135,.32);box-shadow:0 24px 60px rgba(92,24,40,.12),0 0 40px rgba(193,126,135,.06);}
body:not(.dark) .cine-unit-img-overlay{background:linear-gradient(135deg,rgba(45,14,20,.08),rgba(45,14,20,.25));}
body:not(.dark) .cine-unit-img-label{background:rgba(255,255,255,.92);border-color:rgba(193,126,135,.35);color:#7A2238;}
body:not(.dark) .cine-unit-noimg{background:rgba(193,126,135,.04);}
body:not(.dark) .cine-unit-label{color:rgba(122,34,56,.75);}
body:not(.dark) .cine-unit-name{color:#2D0E14;}
body:not(.dark) .cine-unit-price{background:linear-gradient(135deg,rgba(193,126,135,.1),rgba(212,164,172,.06));border-color:rgba(193,126,135,.28);}
body:not(.dark) .cine-unit-price-lbl{color:rgba(122,34,56,.6);}
body:not(.dark) .cine-unit-price-val{color:#7A2238;}
body:not(.dark) .cine-unit-pills{gap:.5rem;}
body:not(.dark) .cine-unit-pill{background:rgba(255,245,246,.6);border-color:rgba(193,126,135,.18);color:rgba(45,14,20,.68);}
body:not(.dark) .cine-unit-pill:hover{background:rgba(255,230,234,.9);border-color:rgba(193,126,135,.35);}
body:not(.dark) .cine-unit-desc{color:rgba(45,14,20,.55);}
body:not(.dark) .cine-unit-cta{background:rgba(193,126,135,.06);border-color:rgba(193,126,135,.28);color:rgba(45,14,20,.75);}
body:not(.dark) .cine-unit-cta:hover{background:rgba(193,126,135,.16);border-color:rgba(193,126,135,.55);color:#5C1828;}
body:not(.dark) .cine-unit-empty{color:rgba(45,14,20,.35);}
/* Upgrades */
body:not(.dark) .cine-upgrades{background:rgba(255,245,246,.5);border-color:rgba(193,126,135,.1);}
body:not(.dark) .cine-upgrades-title{color:rgba(122,34,56,.8);}
body:not(.dark) .cine-upgrades-title::before{background:linear-gradient(90deg,#C17E87,#D4A4AC);}
body:not(.dark) .cine-upgrades-body{color:rgba(45,14,20,.6);}
/* Pull quote */
body:not(.dark) .cine-pull-quote{background:linear-gradient(135deg,rgba(255,240,242,.6),rgba(255,230,234,.4));border-color:rgba(193,126,135,.12);border-left-color:rgba(193,126,135,.55);color:rgba(45,14,20,.78);}
body:not(.dark) .cine-pull-quote::before{color:rgba(193,126,135,.18);}
/* FAB */
body:not(.dark) .cine-fab-action{background:rgba(255,255,255,.95);color:#7A2238;border-color:rgba(193,126,135,.35);box-shadow:0 8px 28px rgba(92,24,40,.15);}
body:not(.dark) .cine-fab-action:hover{background:rgba(255,240,242,.98);border-color:#C17E87;box-shadow:0 0 28px rgba(193,126,135,.2);}
/* AI zone — bright mode */
body:not(.dark) .ai-zone{background:linear-gradient(135deg,rgba(255,245,246,.85) 0%,rgba(253,232,236,.75) 100%);border-color:rgba(193,126,135,.22);}
body:not(.dark) .ai-zone-hd{border-bottom-color:rgba(193,126,135,.18);}
body:not(.dark) .ai-zone-icon{background:linear-gradient(135deg,rgba(193,126,135,.15),rgba(212,164,172,.08));border:1px solid rgba(193,126,135,.25);}
body:not(.dark) .ai-zone-title{color:#2D0E14;}
body:not(.dark) .ai-zone-sub{color:rgba(122,34,56,.6);}
/* Footer — keep dark (intentional dark-on-dark cinematic feel for the CTA strip) */
body:not(.dark) .cine-footer{background:linear-gradient(180deg,transparent,rgba(92,24,40,.97) 40%,rgba(60,10,20,1) 100%);}
body:not(.dark) .cine-footer::before{background:radial-gradient(ellipse 80% 60% at 50% 0%,rgba(193,126,135,.1),transparent 55%);}
body:not(.dark) .cine-footer-bottom{border-top-color:rgba(255,200,210,.12);color:rgba(255,220,225,.22);}
body:not(.dark) .cine-footer-logo{color:rgba(255,200,210,.55);}
/* ── LIGHT MODE: lux-pi-* sample-inspired redesign ── */
body:not(.dark) .lux-pi-wrap{gap:1.2rem;}
body:not(.dark) .lux-pi-hero-card{background:rgba(255,255,255,.72);border-color:rgba(240,208,212,.85);box-shadow:0 20px 48px rgba(92,24,40,.07);}
body:not(.dark) .lux-pi-hero-card::before{background:linear-gradient(120deg,rgba(193,126,135,.22),rgba(255,255,255,.55),rgba(193,126,135,.25));}
body:not(.dark) .lux-pi-hero-card::after{background:linear-gradient(105deg,transparent 36%,rgba(255,255,255,.6) 50%,transparent 64%);mix-blend-mode:normal;opacity:.55;}
body:not(.dark) .lux-pi-hero-left{border-right-color:rgba(240,208,212,.9);}
body:not(.dark) .lux-pi-hero-right{background:linear-gradient(180deg,rgba(252,232,235,.88),rgba(255,245,246,.94));}
body:not(.dark) .lux-pi-orb.o1{background:radial-gradient(circle,rgba(193,126,135,.5),transparent 68%);}
body:not(.dark) .lux-pi-orb.o2{background:radial-gradient(circle,rgba(212,164,172,.45),transparent 70%);}
body:not(.dark) .lux-pi-orb.o3{background:radial-gradient(circle,rgba(193,126,135,.32),transparent 70%);}
body:not(.dark) .lux-pi-orb.o4{background:radial-gradient(circle,rgba(160,120,128,.22),transparent 72%);}
body:not(.dark) .lux-pi-ray{background:linear-gradient(90deg,transparent,rgba(193,126,135,.42),transparent);}
body:not(.dark) .lux-pi-grid{background-image:linear-gradient(rgba(193,126,135,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(193,126,135,.08) 1px,transparent 1px);opacity:.35;}
body:not(.dark) .lux-pi-spark{background:rgba(193,126,135,.85);box-shadow:0 0 14px rgba(193,126,135,.52);}
body:not(.dark) .lux-pi-eyebrow{color:#B98989;}
body:not(.dark) .lux-pi-title{color:#4E3D3D;}
body:not(.dark) .lux-pi-title-accent{color:#C89C58;}
body:not(.dark) .lux-pi-desc{color:#7D6666;}
body:not(.dark) .lux-pi-quick-card{background:rgba(255,255,255,.9);border-color:#F0DEDE;box-shadow:0 8px 22px rgba(92,24,40,.06);}
body:not(.dark) .lux-pi-quick-card::before{background:radial-gradient(circle at 20% 0%,rgba(193,126,135,.22),transparent 58%);}
body:not(.dark) .lux-pi-quick-card::after{background:linear-gradient(90deg,transparent,rgba(193,126,135,.68),transparent);}
body:not(.dark) .lux-pi-quick-lbl{color:#B98989;}
body:not(.dark) .lux-pi-quick-val{color:#4E3D3D;}
body:not(.dark) .lux-pi-side-block{border-bottom-color:#EAD5D5;}
body:not(.dark) .lux-pi-side-lbl{color:#B98989;}
body:not(.dark) .lux-pi-side-val{color:#4E3D3D;}
body:not(.dark) .lux-pi-detail-grid .lux-pi-panel{background:rgba(255,255,255,.72);border-color:rgba(255,255,255,.95);box-shadow:0 16px 36px rgba(92,24,40,.06);}
body:not(.dark) .lux-pi-panel::before{background:linear-gradient(120deg,rgba(193,126,135,.12),transparent 45%,rgba(193,126,135,.08));}
body:not(.dark) .lux-pi-panel::after{background:linear-gradient(180deg,transparent,rgba(193,126,135,.2),transparent);}
body:not(.dark) .lux-pi-panel-hd{color:#B98989;}
body:not(.dark) .lux-pi-panel-dot{background:#D4AF6D;}
body:not(.dark) .lux-pi-line-lbl{color:#B98989;}
body:not(.dark) .lux-pi-line-val{color:#4E3D3D;}
body:not(.dark) .lux-pi-fac-pill{background:#F5ECEC;border-color:#ECDCdc;color:#5F4A4A;}
body:not(.dark) .lux-pi-fac-pill:hover{background:#F1E2E2;border-color:#DFCACA;color:#4E3D3D;}
body:not(.dark) .lux-pi-park-wrap{border-top-color:#EADCDC;}
body:not(.dark) .lux-pi-note{background:#F6F1E8;border-color:#EAD9B8;color:#846C44;}
body:not(.dark) .lux-pi-fin-wrap{background:rgba(255,255,255,.72);border-color:rgba(255,255,255,.95);box-shadow:0 16px 36px rgba(92,24,40,.06);}
body:not(.dark) .lux-pi-fin-wrap::before{background:radial-gradient(circle at 90% 18%,rgba(193,126,135,.13),transparent 45%),radial-gradient(circle at 12% 100%,rgba(193,126,135,.1),transparent 48%);opacity:.8;}
body:not(.dark) .lux-pi-fin-card{background:#F7EFEF;border-color:#F0DEDE;}
body:not(.dark) .lux-pi-fin-card::after{background:linear-gradient(90deg,transparent,rgba(193,126,135,.68),transparent);}
body:not(.dark) .lux-pi-fin-lbl{color:#B98989;}
body:not(.dark) .lux-pi-fin-val{color:#4E3D3D;}
body:not(.dark) .lux-pi-fin-sub{color:#8B7272;}

.filter-panel,.card,.proj-card,.spec-section,.amenity-cat,.layouts-upgrades,.ri-box,.set-card,.a-login-box,.a-stat,.a-tbl-wrap,.a-modal,.vis-master-card,.vis-tab-card,.vis-preview,.vis-group-hd,.vis-group-body,.map-embed,.a-map-preview,.map-picker-container,.map-picker-modal,.crm-tbl-wrap,.crm-col,.crm-card,.crm-modal,.crm-drawer-sec,.crm-stat,.crm-chart-card,.tray,.tslot,.add-more,.price-panel{border-radius:var(--r-md);}
.card,.proj-card,.ri-box,.a-tbl-wrap,.a-modal,.map-embed,.a-map-preview,.map-picker-modal,.crm-tbl-wrap,.crm-col,.crm-modal,.crm-drawer-sec,.tray,.tslot,.add-more,.filter-panel,.spec-section,.amenity-cat,.layouts-upgrades{overflow:hidden;}
.list-pager button,.pdf-btn,.go-btn,.a-add-btn,.a-pg-btn,.a-ico-btn,.a-card-menu-btn,.a-modal-x,.ri-x,.ri-wa-btn,.ri-submit,.set-save-btn,.a-login-btn,.map-picker-expand,.map-picker-modal-x,.crm-search,.crm-select,.crm-ico,.crm-inp,.crm-textarea,.crm-btn-pri,.crm-btn-sec,.crm-note-inp,.crm-note-add,.a-search,.a-fsel,.a-inp,.a-txt,.a-sel,.set-inp,.a-login-inp,.fsel,.fmore-btn,.fsize-inp,.fclear-btn,.price-reset,.s-inp,.cbtn,.cstat,.proj-rm,.pb-btn1,.pb-btn2{border-radius:var(--r-sm);}
.a-proj-card,.ut-card,.det-hero-dots,.fac-chip,.ctag2,.det-meta-chip,.layouts-intro,.crm-subbtn,.crm-badge,.crm-wa-link,.crm-col-count,.crm-score-bar,.crm-bar-track,.a-schip,.vis-prev-tab,.tpre,.tag-presets .tpre,.ri-err,.a-login-err{border-radius:var(--r-sm);}
.det-tabs,.gal-strip{border-radius:0;}

.nav{position:sticky;top:0;z-index:100;background:linear-gradient(135deg,#0D0D18 0%,#141428 52%,#1C1C30 100%);backdrop-filter:blur(14px);padding:0 2rem;height:64px;display:flex;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid rgba(191,155,78,.22);box-shadow:0 8px 32px rgba(13,13,24,.45);}
.nav-logo{font-family:var(--serif);font-size:1.5rem;font-weight:600;color:var(--gold);letter-spacing:.04em;white-space:nowrap;cursor:pointer;}
.nav-logo span{color:#FAF8F3;font-weight:300;}
.nav-tabs{display:flex;height:64px;position:absolute;left:50%;transform:translateX(-50%);}
.ntab{height:64px;padding:0 1.2rem;background:transparent;border:none;color:#D4B880;font-family:var(--sans);font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;position:relative;transition:color .2s;display:flex;align-items:center;gap:.45rem;white-space:nowrap;}
.ntab:hover{color:#FAF8F3;}
.ntab.on{color:var(--gold);}
.ntab.on::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--gold);}
.ntab.adm.on{color:var(--a-gold);}
.badge{background:linear-gradient(135deg,var(--gold-l),var(--gold));color:#0D0D18;border-radius:999px;font-size:.62rem;font-weight:700;padding:.08rem .42rem;min-width:17px;text-align:center;box-shadow:0 4px 12px rgba(191,155,78,.35);}
.nav-cta{background:linear-gradient(135deg,var(--gold-l),var(--gold));color:#0D0D18;border:none;padding:.45rem 1.1rem;font-family:var(--sans);font-size:.76rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:transform .2s,box-shadow .2s;white-space:nowrap;box-shadow:0 8px 18px rgba(191,155,78,.38);}
.nav-cta:hover{transform:translateY(-1px);box-shadow:0 14px 28px rgba(191,155,78,.52);}
.nav-cta-short{display:none;}
.nav-cta-full{display:inline;}

/* Hamburger (mobile only — hidden on desktop) */
.nav-hamburger{display:none;flex-direction:column;justify-content:center;align-items:center;gap:5px;width:40px;height:40px;background:rgba(191,155,78,.06);border:1px solid rgba(191,155,78,.22);cursor:pointer;flex-shrink:0;padding:0;border-radius:10px;backdrop-filter:blur(6px);}
.nav-hamburger span{display:block;width:20px;height:2px;background:#FAF8F3;border-radius:2px;transition:transform .25s,opacity .25s,width .25s;}
.nav-hamburger.open span:nth-child(1){transform:translateY(7px) rotate(45deg);}
.nav-hamburger.open span:nth-child(2){opacity:0;width:0;}
.nav-hamburger.open span:nth-child(3){transform:translateY(-7px) rotate(-45deg);}

/* Right-side nav group (admin icon + hamburger) */
.nav-right{display:flex;align-items:center;gap:0.6rem;z-index:170;margin-left:auto}
.nav-admin{background:rgba(191,155,78,.06);border:1px solid rgba(191,155,78,.22);width:40px;height:40px;border-radius:999px;display:flex;align-items:center;justify-content:center;color:#FAF8F3;cursor:pointer;transition:all .15s;flex-shrink:0;backdrop-filter:blur(6px)}
.nav-admin:hover{background:rgba(191,155,78,.16);transform:translateY(-1px);border-color:rgba(191,155,78,.45)}

/* Drawer overlay */
.mob-drawer-ov{display:none;position:fixed;inset:0;z-index:150;background:rgba(0,0,0,.55);animation:fadeIn .2s ease;}
.mob-drawer-ov.open{display:block;}

/* Side drawer */
.mob-drawer{position:fixed;top:0;left:0;bottom:0;z-index:160;width:280px;background:linear-gradient(180deg,#0D0D18 0%,#141428 100%);border-right:1px solid rgba(191,155,78,.18);transform:translateX(-100%);transition:transform .3s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;overflow-y:auto;}
.mob-drawer.open{transform:translateX(0);}
.mob-drawer-hd{display:flex;align-items:center;justify-content:space-between;padding:1rem 1.2rem;border-bottom:1px solid rgba(191,155,78,.18);min-height:64px;flex-shrink:0;}
.mob-drawer-logo{font-family:var(--serif);font-size:1.35rem;font-weight:600;color:var(--gold);letter-spacing:.04em;cursor:pointer;}
.mob-drawer-logo span{color:#FAF8F3;font-weight:300;}
.mob-drawer-x{background:transparent;border:1px solid rgba(191,155,78,.22);color:#D4B880;width:32px;height:32px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.85rem;border-radius:2px;transition:all .15s;flex-shrink:0;}
.mob-drawer-x:hover{border-color:rgba(191,155,78,.5);color:#FAF8F3;}
.mob-drawer-nav{display:flex;flex-direction:column;padding:.6rem 0;flex:1;}
.mob-nav-item{display:flex;align-items:center;gap:.8rem;padding:.9rem 1.4rem;background:transparent;border:none;border-left:3px solid transparent;color:#D4B880;font-family:var(--sans);font-size:.84rem;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:background .15s,color .15s,border-color .15s;text-align:left;width:100%;}
.mob-nav-item:hover{background:rgba(191,155,78,.08);color:#FAF8F3;}
.mob-nav-item.on{color:var(--gold);border-left-color:var(--gold);background:rgba(191,155,78,.08);}
.mob-nav-item .mob-badge{background:var(--gold);color:#FAF8F3;border-radius:999px;font-size:.58rem;font-weight:700;padding:.05rem .38rem;min-width:16px;text-align:center;}
.mob-drawer-ft{padding:1.2rem;border-top:1px solid rgba(191,155,78,.18);flex-shrink:0;}
.mob-drawer-cta{width:100%;background:linear-gradient(135deg,var(--gold-l),var(--gold));color:#0D0D18;border:none;padding:.8rem;font-family:var(--sans);font-size:.82rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:opacity .2s;box-shadow:0 10px 20px rgba(191,155,78,.38);}
.mob-drawer-cta:hover{opacity:.88;}

/* Mobile admin sub-nav dropdown */
.mob-admin-sub{display:flex;flex-direction:column;padding:0;overflow:hidden;max-height:0;transition:max-height .3s ease;background:rgba(0,0,0,.18);}
.mob-admin-sub.open{max-height:300px;}
.mob-admin-sub-item{display:flex;align-items:center;gap:.7rem;padding:.7rem 1.4rem .7rem 2.6rem;background:transparent;border:none;color:#D4B880;font-family:var(--sans);font-size:.78rem;letter-spacing:.04em;cursor:pointer;transition:background .15s,color .15s;text-align:left;width:100%;border-left:3px solid transparent;}
.mob-admin-sub-item:hover{background:rgba(191,155,78,.08);color:#FAF8F3;}
.mob-admin-sub-item.on{color:var(--gold);border-left-color:var(--gold);background:rgba(191,155,78,.1);}
.mob-admin-chevron{margin-left:auto;font-size:.6rem;transition:transform .25s;color:#D4B880;}
.mob-admin-chevron.open{transform:rotate(180deg);}

.hero{background:linear-gradient(145deg,#FAF8F3 0%,#F5F0E8 55%,#F0E9DC 100%);padding:5rem 2.5rem 4rem;text-align:center;position:relative;overflow:hidden;border-bottom:1px solid rgba(191,155,78,.15);isolation:isolate;}
.hero::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 80% 60% at 50% 100%,rgba(191,155,78,.1) 0%,transparent 45%),radial-gradient(circle at 18% 22%,rgba(191,155,78,.18) 0%,transparent 28%),radial-gradient(circle at 82% 18%,rgba(212,184,128,.14) 0%,transparent 24%);}
.hero::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,rgba(250,248,243,.95) 0%,rgba(250,248,243,.4) 25%,rgba(250,248,243,.15) 50%,rgba(250,248,243,.4) 75%,rgba(250,248,243,.95) 100%);pointer-events:none;z-index:0;}
.hero>*{position:relative;z-index:2;}
.hero-art{position:absolute;inset:0;pointer-events:none;z-index:1;overflow:hidden;}
.hero-grid{position:absolute;inset:-8% -4% auto -4%;height:88%;background-image:linear-gradient(rgba(13,13,24,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(13,13,24,.06) 1px,transparent 1px);background-size:64px 64px;mask-image:linear-gradient(180deg,rgba(0,0,0,.7),transparent 92%);opacity:.55;transform:perspective(900px) rotateX(70deg) scale(1.15);transform-origin:top center;animation:heroGridDrift 16s linear infinite;}
.hero-orb{position:absolute;border-radius:50%;filter:blur(2px);opacity:.75;animation:heroFloat 8s ease-in-out infinite;}
.hero-orb.o1{width:220px;height:220px;left:-40px;top:26px;background:radial-gradient(circle at 30% 30%,rgba(191,155,78,.32),rgba(191,155,78,0) 72%);}
.hero-orb.o2{width:280px;height:280px;right:-70px;top:12px;background:radial-gradient(circle at 50% 50%,rgba(191,155,78,.22),rgba(191,155,78,0) 72%);animation-delay:-3s;}
.hero-orb.o3{width:180px;height:180px;right:18%;bottom:-32px;background:radial-gradient(circle at 50% 50%,rgba(212,184,128,.34),rgba(212,184,128,0) 72%);animation-delay:-5s;}
.hero-line{position:absolute;border:1px solid rgba(191,155,78,.28);border-radius:999px;opacity:.7;animation:heroPulse 6s ease-in-out infinite;}
.hero-line.l1{width:420px;height:420px;right:-110px;top:-180px;}
.hero-line.l2{width:300px;height:300px;left:-120px;bottom:-120px;animation-delay:-2s;}
@keyframes heroFloat{0%,100%{transform:translate3d(0,0,0);}50%{transform:translate3d(0,-16px,0);}}
@keyframes heroPulse{0%,100%{transform:scale(1);opacity:.42;}50%{transform:scale(1.04);opacity:.78;}}
@keyframes heroGridDrift{0%{transform:perspective(900px) rotateX(70deg) translateY(0) scale(1.15);}50%{transform:perspective(900px) rotateX(70deg) translateY(10px) scale(1.17);}100%{transform:perspective(900px) rotateX(70deg) translateY(0) scale(1.15);}}
@keyframes heroRise{0%{opacity:0;transform:translateY(0) scale(1)}30%{opacity:.85}80%{opacity:.45}100%{opacity:0;transform:translateY(-75px) scale(.4)}}
@keyframes heroDiamond{0%,100%{transform:rotate(45deg) scale(1);opacity:.28}50%{transform:rotate(45deg) scale(1.1);opacity:.6}}
@keyframes heroScan{0%{left:-32%}100%{left:118%}}
@keyframes heroBlink{0%,100%{opacity:.07;transform:scale(.65)}50%{opacity:.8;transform:scale(1)}}
@keyframes heroBadge1{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-13px) rotate(0deg)}}
@keyframes heroBadge2{0%,100%{transform:translateY(0) rotate(2deg)}50%{transform:translateY(-10px) rotate(3.5deg)}}
.hero-particles{position:absolute;inset:0;pointer-events:none;}
.hero-pt{position:absolute;border-radius:50%;background:var(--gold);}
.hero-pt.pt1{width:3px;height:3px;left:8%;bottom:22%;animation:heroRise 4.2s ease-in 0s infinite;opacity:.7;}
.hero-pt.pt2{width:2px;height:2px;left:15%;bottom:16%;animation:heroRise 5.1s ease-in .6s infinite;opacity:.5;}
.hero-pt.pt3{width:3px;height:3px;left:23%;bottom:28%;animation:heroRise 4.7s ease-in 1.2s infinite;opacity:.6;}
.hero-pt.pt4{width:2px;height:2px;left:33%;bottom:12%;animation:heroRise 5.4s ease-in .3s infinite;opacity:.45;}
.hero-pt.pt5{width:3px;height:3px;left:42%;bottom:20%;animation:heroRise 4.0s ease-in 1.8s infinite;opacity:.65;}
.hero-pt.pt6{width:2px;height:2px;left:53%;bottom:14%;animation:heroRise 5.8s ease-in .9s infinite;opacity:.4;}
.hero-pt.pt7{width:3px;height:3px;left:62%;bottom:24%;animation:heroRise 4.5s ease-in 2.1s infinite;opacity:.6;}
.hero-pt.pt8{width:2px;height:2px;left:72%;bottom:10%;animation:heroRise 5.2s ease-in .4s infinite;opacity:.5;}
.hero-pt.pt9{width:3px;height:3px;left:78%;bottom:22%;animation:heroRise 4.8s ease-in 1.5s infinite;opacity:.55;}
.hero-pt.pt10{width:2px;height:2px;left:85%;bottom:17%;animation:heroRise 5.0s ease-in 2.4s infinite;opacity:.45;}
.hero-pt.pt11{width:3px;height:3px;left:91%;bottom:26%;animation:heroRise 4.3s ease-in .7s infinite;opacity:.6;}
.hero-pt.pt12{width:2px;height:2px;left:96%;bottom:11%;animation:heroRise 5.6s ease-in 1.9s infinite;opacity:.4;}
.hero-city{position:absolute;bottom:0;left:0;width:100%;height:200px;pointer-events:none;}
.hero-diamond{position:absolute;border:1.5px solid rgba(191,155,78,.32);pointer-events:none;animation:heroDiamond 6s ease-in-out infinite;}
.hero-diamond.hd1{width:78px;height:78px;right:11%;top:10%;transform:rotate(45deg);}
.hero-diamond.hd2{width:48px;height:48px;left:7%;top:18%;transform:rotate(45deg);animation-delay:-2s;}
.hero-diamond.hd3{width:32px;height:32px;right:27%;bottom:22%;transform:rotate(45deg);animation-delay:-4s;}
.hero-diamond.hd1-inner{width:52px;height:52px;right:calc(11% + 13px);top:calc(10% + 13px);border-color:rgba(191,155,78,.14);transform:rotate(45deg);animation-delay:-.5s;}
.hero-scan{position:absolute;top:0;bottom:0;width:28%;background:linear-gradient(90deg,transparent,rgba(191,155,78,.055),transparent);pointer-events:none;animation:heroScan 7s ease-in-out infinite;}
.hero-star{position:absolute;width:3px;height:3px;border-radius:50%;background:#BF9B4E;pointer-events:none;animation:heroBlink var(--bd,3s) ease-in-out var(--bdd,0s) infinite;}
.hero-star.hs1{left:5%;top:12%;--bd:2.8s;--bdd:.2s}
.hero-star.hs2{left:18%;top:8%;--bd:3.5s;--bdd:1.1s}
.hero-star.hs3{left:35%;top:14%;--bd:2.5s;--bdd:.5s}
.hero-star.hs4{left:50%;top:7%;--bd:3.2s;--bdd:1.8s}
.hero-star.hs5{left:65%;top:13%;--bd:2.9s;--bdd:.8s}
.hero-star.hs6{left:80%;top:8%;--bd:3.8s;--bdd:2.2s}
.hero-star.hs7{left:93%;top:16%;--bd:2.6s;--bdd:.4s}
.hero-star.hs8{left:27%;top:5%;--bd:3.1s;--bdd:1.5s}
.hero-badge{position:absolute;background:rgba(255,255,255,.92);border:1px solid rgba(191,155,78,.28);border-radius:14px;padding:.7rem .9rem;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 28px rgba(13,13,24,.1),inset 0 1px 0 rgba(255,255,255,.8);backdrop-filter:blur(14px);pointer-events:none;}
.hero-badge.hb1{left:4%;top:30%;animation:heroBadge1 5s ease-in-out infinite;}
.hero-badge.hb2{right:4%;top:36%;animation:heroBadge2 5.5s ease-in-out infinite;}
@media(max-width:900px){.hero-badge{display:none;}.hero-diamond.hd2{display:none;}.hero-city{height:140px;}}
.h-eye{position:relative;font-size:.72rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);margin-bottom:1.2rem;font-weight:500;}
.h-ttl{position:relative;font-family:var(--serif);font-size:clamp(2.4rem,5vw,4rem);font-weight:300;color:var(--ink);line-height:1.15;margin-bottom:1rem;}
.h-ttl em{font-style:italic;color:var(--gold);}
.h-sub{position:relative;color:var(--muted);font-size:1rem;max-width:480px;margin:0 auto 2.5rem;line-height:1.6;}
.s-wrap{position:relative;max-width:560px;margin:0 auto;}
.s-inp{width:100%;padding:1rem 3.5rem 1rem 1.5rem;background:rgba(255,255,255,.94);border:1px solid rgba(13,13,24,.12);color:var(--ink);font-family:var(--sans);font-size:.95rem;outline:none;transition:border-color .2s,box-shadow .2s;backdrop-filter:blur(10px);box-shadow:0 10px 28px rgba(13,13,24,.1);}
.s-inp::placeholder{color:#8E8A84;}
.s-inp:focus{border-color:var(--gold);}
.s-ico{position:absolute;right:1.2rem;top:50%;transform:translateY(-50%);color:var(--gold);pointer-events:none;}

.main{width:100%;padding:3rem 2rem;}
/* ═══════════════════════════════════
   FILTER — Luxury Glassmorphism (fd-*)
═══════════════════════════════════ */
/* ── Trigger bar ── */
.fd-bar{display:flex;align-items:center;gap:.65rem;background:linear-gradient(135deg,#12101e,#0e0c1a);border:1px solid rgba(191,155,78,.18);border-radius:16px;padding:.75rem 1.1rem;margin-bottom:1.75rem;box-shadow:0 4px 24px rgba(0,0,0,.18),inset 0 1px 0 rgba(191,155,78,.06);flex-wrap:wrap;}
.fd-trigger{display:flex;align-items:center;gap:.5rem;padding:.52rem 1.1rem;border-radius:999px;border:1.5px solid rgba(191,155,78,.32);background:rgba(191,155,78,.08);color:#D4B880;font-family:var(--sans);font-size:.76rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:all .22s;white-space:nowrap;flex-shrink:0;}
.fd-trigger:hover{background:rgba(191,155,78,.16);border-color:rgba(191,155,78,.6);box-shadow:0 0 18px rgba(191,155,78,.2);}
.fd-trigger svg{width:14px;height:14px;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;fill:none;flex-shrink:0;}
.fd-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:linear-gradient(135deg,#D4B880,#BF9B4E);color:#0A0A16;font-size:.6rem;font-weight:800;line-height:1;}
.fd-pills{display:flex;align-items:center;gap:.35rem;flex:1;overflow-x:auto;scrollbar-width:none;min-width:0;}
.fd-pills::-webkit-scrollbar{display:none;}
.fd-pill{display:inline-flex;align-items:center;gap:.28rem;padding:.25rem .6rem;border-radius:999px;background:rgba(191,155,78,.1);border:1px solid rgba(191,155,78,.28);color:#D4B880;font-size:.68rem;font-weight:500;white-space:nowrap;animation:fdPillIn .18s ease;}
.fd-pill-x{background:none;border:none;cursor:pointer;color:rgba(191,155,78,.5);font-size:.85rem;line-height:1;padding:0;margin-left:.05rem;transition:color .15s;}
.fd-pill-x:hover{color:#e05a5a;}
.fd-rcnt{margin-left:auto;font-size:.74rem;color:rgba(200,196,216,.45);white-space:nowrap;flex-shrink:0;letter-spacing:.03em;}
.fd-rcnt strong{color:#F0EDE6;font-weight:700;}
@keyframes fdPillIn{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:scale(1)}}
/* ── Overlay ── */
.fd-ov{position:fixed;inset:0;z-index:400;background:rgba(4,4,14,.72);backdrop-filter:blur(8px);animation:fdOvIn .25s ease;}
@keyframes fdOvIn{from{opacity:0}to{opacity:1}}
/* ── Sheet (mobile: slide up, desktop: centered modal) ── */
.fd-sheet{position:fixed;bottom:0;left:0;right:0;z-index:401;background:linear-gradient(180deg,#141228 0%,#0e0c1a 100%);border:1px solid rgba(191,155,78,.14);border-bottom:none;border-radius:24px 24px 0 0;box-shadow:0 -12px 64px rgba(0,0,0,.55),inset 0 1px 0 rgba(191,155,78,.08);display:flex;flex-direction:column;max-height:92svh;animation:fdSheetUp .32s cubic-bezier(.18,1.02,.32,1);}
@keyframes fdSheetUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
@media(min-width:769px){
  .fd-sheet{position:fixed;bottom:auto;top:50%;left:50%;right:auto;transform:translate(-50%,-50%);width:min(780px,94vw);border-radius:20px;max-height:88svh;border:1px solid rgba(191,155,78,.16);animation:fdModalIn .28s cubic-bezier(.22,1,.36,1);}
  @keyframes fdModalIn{from{opacity:0;transform:translate(-50%,-48%)}to{opacity:1;transform:translate(-50%,-50%)}}
  .fd-sheet-inner{display:flex;flex:1;min-height:0;}
  .fd-sidebar{width:220px;flex-shrink:0;border-right:1px solid rgba(191,155,78,.1);padding:1.4rem 1.2rem;display:flex;flex-direction:column;gap:1.2rem;background:rgba(255,255,255,.015);}
  .fd-sidebar-title{font-family:'Cormorant Garamond',Georgia,serif;font-size:1rem;font-weight:600;color:#F0EDE6;letter-spacing:.02em;}
  .fd-sidebar-cnt{font-size:.62rem;letter-spacing:.16em;text-transform:uppercase;color:rgba(191,155,78,.7);font-weight:600;}
  .fd-sidebar-filters{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:.4rem;scrollbar-width:none;}
  .fd-sidebar-filters::-webkit-scrollbar{display:none;}
  .fd-sidebar-item{display:flex;align-items:center;justify-content:space-between;padding:.4rem .6rem;border-radius:8px;background:rgba(191,155,78,.07);border:1px solid rgba(191,155,78,.14);}
  .fd-sidebar-lbl{font-size:.7rem;color:#D4B880;font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .fd-sidebar-rm{background:none;border:none;color:rgba(191,155,78,.45);cursor:pointer;font-size:.85rem;padding:0;line-height:1;flex-shrink:0;transition:color .15s;}
  .fd-sidebar-rm:hover{color:#e05a5a;}
  .fd-sidebar-empty{font-size:.72rem;color:rgba(200,196,216,.28);font-style:italic;text-align:center;padding:.8rem 0;}
  .fd-sidebar-clear{padding:.5rem .8rem;border-radius:999px;border:1px solid rgba(191,155,78,.2);background:transparent;color:rgba(200,196,216,.4);font-family:var(--sans);font-size:.68rem;cursor:pointer;transition:all .2s;letter-spacing:.04em;margin-top:auto;}
  .fd-sidebar-clear:hover{border-color:#e05a5a;color:#e05a5a;}
}
/* ── Handle ── */
.fd-handle{width:40px;height:4px;border-radius:2px;background:rgba(191,155,78,.2);margin:.8rem auto .15rem;flex-shrink:0;}
@media(min-width:769px){.fd-handle{display:none;}}
/* ── Header ── */
.fd-hd{display:flex;align-items:center;gap:.65rem;padding:.9rem 1.4rem .75rem;border-bottom:1px solid rgba(191,155,78,.1);flex-shrink:0;}
.fd-hd-title{font-family:'Cormorant Garamond',Georgia,serif;font-size:1.2rem;font-weight:600;color:#F0EDE6;flex:1;letter-spacing:.02em;}
.fd-hd-cnt{font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;color:#BF9B4E;font-weight:700;background:rgba(191,155,78,.1);border:1px solid rgba(191,155,78,.2);padding:.2rem .6rem;border-radius:999px;}
.fd-close{width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.05);border:1px solid rgba(191,155,78,.15);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.85rem;color:rgba(200,196,216,.55);transition:all .2s;}
.fd-close:hover{background:rgba(191,155,78,.12);border-color:rgba(191,155,78,.4);color:#F0EDE6;}
/* ── Body ── */
.fd-body{overflow-y:auto;padding:1.2rem 1.4rem;flex:1;min-height:0;display:flex;flex-direction:column;gap:1.5rem;scrollbar-width:thin;scrollbar-color:rgba(191,155,78,.15) transparent;}
.fd-body::-webkit-scrollbar{width:4px;}
.fd-body::-webkit-scrollbar-thumb{background:rgba(191,155,78,.2);border-radius:2px;}
.fd-sec-label{font-size:.6rem;letter-spacing:.22em;text-transform:uppercase;color:rgba(191,155,78,.65);font-weight:700;margin-bottom:.7rem;display:flex;align-items:center;gap:.5rem;}
.fd-sec-label::before{content:'';flex-shrink:0;width:16px;height:1px;background:rgba(191,155,78,.35);}
.fd-chips{display:flex;flex-wrap:wrap;gap:.4rem;}
.fd-chip{padding:.35rem .82rem;border-radius:999px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:rgba(200,196,216,.7);font-family:var(--sans);font-size:.75rem;cursor:pointer;transition:all .2s;white-space:nowrap;font-weight:500;backdrop-filter:blur(4px);}
.fd-chip:hover{border-color:rgba(191,155,78,.45);color:#D4B880;background:rgba(191,155,78,.08);}
.fd-chip.on{background:linear-gradient(135deg,rgba(212,184,128,.2),rgba(191,155,78,.14));border-color:rgba(191,155,78,.55);color:#D4B880;font-weight:700;box-shadow:0 0 0 2px rgba(191,155,78,.12),0 2px 12px rgba(191,155,78,.15);}
/* ── Size inputs ── */
.fd-size-row{display:flex;align-items:center;gap:.6rem;}
.fd-size-inp{flex:1;padding:.52rem .85rem;border:1px solid rgba(191,155,78,.2);border-radius:10px;background:rgba(255,255,255,.04);color:#F0EDE6;font-family:var(--sans);font-size:.82rem;outline:none;transition:border-color .2s,box-shadow .2s;}
.fd-size-inp:focus{border-color:rgba(191,155,78,.55);box-shadow:0 0 0 3px rgba(191,155,78,.1);}
.fd-size-inp::placeholder{color:rgba(200,196,216,.3);font-size:.75rem;}
.fd-size-sep{color:rgba(200,196,216,.35);font-size:1rem;flex-shrink:0;}
/* ── Sticky footer ── */
.fd-ft{display:flex;gap:.7rem;padding:1rem 1.4rem 1.3rem;border-top:1px solid rgba(191,155,78,.1);flex-shrink:0;background:linear-gradient(0deg,rgba(10,8,20,.6) 0%,transparent 100%);}
.fd-ft-clear{flex:0 0 auto;padding:.62rem 1.2rem;border-radius:999px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:rgba(200,196,216,.5);font-family:var(--sans);font-size:.76rem;font-weight:600;cursor:pointer;transition:all .22s;letter-spacing:.05em;}
.fd-ft-clear:hover{border-color:rgba(224,90,90,.5);color:#e05a5a;background:rgba(224,90,90,.06);}
.fd-ft-apply{flex:1;padding:.68rem 1.2rem;border-radius:999px;border:none;background:linear-gradient(135deg,#D4B880,#BF9B4E);color:#080810;font-family:var(--sans);font-size:.8rem;font-weight:800;cursor:pointer;letter-spacing:.1em;text-transform:uppercase;transition:all .22s;box-shadow:0 4px 20px rgba(191,155,78,.4);}
.fd-ft-apply:hover{box-shadow:0 6px 32px rgba(191,155,78,.6);transform:translateY(-1px);}
/* ── Desktop 2-col grid inside body ── */
@media(min-width:769px){
  .fd-body{display:grid;grid-template-columns:1fr 1fr;gap:1.4rem 2rem;align-content:start;}
  .fd-sec-price{grid-column:1/-1;}
}
/* ── Legacy (price slider uses these) ── */
.fsize-range{display:flex;align-items:center;gap:.3rem;}
.fsize-inp{width:80px;padding:.44rem .6rem;border:1px solid var(--border);background:var(--parchment);color:var(--ink);font-family:var(--sans);font-size:.8rem;outline:none;transition:border-color .18s;}
.fsize-inp:focus{border-color:var(--gold);}
.fsize-inp::placeholder{color:var(--muted);font-size:.75rem;}
.fsize-sep{color:var(--muted);font-size:.8rem;}
.flbl{font-size:.65rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600;}
.fsel{padding:.48rem 2rem .48rem .85rem;border:1px solid var(--border);background:var(--parchment);color:var(--ink);font-family:var(--sans);font-size:.81rem;cursor:pointer;outline:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='%238a8578' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .65rem center;transition:border-color .18s;}
.fsel:focus{border-color:var(--gold);outline:none;}
.filter-divider{width:1px;height:20px;background:var(--border);flex-shrink:0;}
.rcnt{margin-left:auto;font-size:.8rem;color:var(--muted);white-space:nowrap;}
.rcnt strong{color:var(--ink);font-weight:600;}

/* ── Price Slider Panel ── */
.price-panel{padding:1rem 1.4rem 1.3rem;}
.price-panel-top{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:.9rem;flex-wrap:wrap;gap:.4rem;}
.price-panel-label{font-size:.65rem;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600;}
.price-panel-value{font-family:var(--serif);font-size:1.05rem;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:.4rem;}
.price-panel-value .sep{font-size:.75rem;color:var(--muted);font-family:var(--sans);font-weight:400;}
.price-panel-value .any{font-size:.85rem;color:var(--muted);font-family:var(--sans);font-style:italic;font-weight:400;}
.price-reset{font-size:.68rem;color:var(--muted);background:transparent;border:1px solid var(--border);padding:.18rem .6rem;cursor:pointer;font-family:var(--sans);letter-spacing:.04em;transition:all .15s;margin-left:.4rem;}
.price-reset:hover{border-color:var(--gold);color:var(--gold);}

/* Track + thumbs */
.ps-track-area{position:relative;padding:18px 0 22px;touch-action:none;user-select:none;}
.ps-rail{position:relative;height:5px;background:var(--border);border-radius:3px;cursor:pointer;}
.ps-fill{position:absolute;top:0;height:100%;background:linear-gradient(90deg,var(--gold-l),var(--gold));border-radius:3px;pointer-events:none;}

/* Thumb */
.ps-thumb{position:absolute;top:50%;transform:translate(-50%,-50%);width:22px;height:22px;border-radius:50%;background:var(--gold);border:3px solid var(--card);box-shadow:0 2px 8px rgba(0,0,0,.18),0 0 0 1px rgba(13,13,24,.3);cursor:grab;transition:box-shadow .15s,transform .12s;z-index:3;touch-action:none;}
.ps-thumb:hover{box-shadow:0 3px 12px rgba(0,0,0,.22),0 0 0 4px rgba(13,13,24,.18);transform:translate(-50%,-50%) scale(1.12);}
.ps-thumb.dragging{cursor:grabbing;box-shadow:0 4px 18px rgba(0,0,0,.22),0 0 0 6px rgba(13,13,24,.22);transform:translate(-50%,-50%) scale(1.18);}

/* Tooltip above thumb */
.ps-tooltip{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:var(--ink);color:var(--gold);font-family:var(--serif);font-size:.78rem;font-weight:600;padding:.22rem .55rem;white-space:nowrap;pointer-events:none;border-radius:2px;opacity:0;transition:opacity .15s;}
.ps-tooltip::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);border:4px solid transparent;border-top-color:var(--ink);}
.ps-thumb:hover .ps-tooltip,.ps-thumb.dragging .ps-tooltip{opacity:1;}

/* Tick marks */
.ps-ticks{display:flex;justify-content:space-between;padding:0 0;margin-top:2px;}
.ps-tick{display:flex;flex-direction:column;align-items:center;gap:3px;}
.ps-tick-mark{width:1px;height:5px;background:var(--border);}
.ps-tick-lbl{font-size:.58rem;color:var(--muted);white-space:nowrap;letter-spacing:.02em;}
.ps-tick.active .ps-tick-lbl{color:var(--gold);}

/* ── Card-based project listing ── */
.a-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:1rem;margin-bottom:1rem;}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1.25rem;}
.list-pager{display:flex;align-items:center;justify-content:center;gap:.6rem;margin-top:1rem;margin-bottom:1.2rem;}
.list-pager button{background:transparent;border:1px solid var(--border);color:var(--muted);padding:.45rem .7rem;border-radius:4px;cursor:pointer;}
.list-pager button.on{background:var(--gold);color:var(--card);border-color:var(--gold);}
.list-pager .page-info{font-size:.82rem;color:var(--muted);}
.a-proj-card{background:var(--a-surface);border:1px solid var(--a-border);display:flex;flex-direction:column;transition:border-color .18s,box-shadow .18s;position:relative;}
.a-proj-card:hover{border-color:var(--a-gold);box-shadow:0 2px 12px rgba(0,0,0,.18);}
.a-proj-card.dimmed{opacity:.55;}
.a-card-img-wrap{position:relative;height:160px;overflow:hidden;flex-shrink:0;}
.a-card-img{width:100%;height:100%;object-fit:cover;display:block;}
.a-card-status{position:absolute;top:.6rem;left:.6rem;}
.a-card-vis-badge{position:absolute;top:.6rem;right:.6rem;font-size:.58rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:.18rem .5rem;background:rgba(0,0,0,.6);color:#fff;backdrop-filter:blur(4px);}
.a-card-vis-badge.hidden{color:var(--a-red);}
.a-card-body{padding:1rem 1.1rem;flex:1;display:flex;flex-direction:column;gap:.55rem;}
.a-card-name{font-weight:600;color:#FAF8F3;font-size:.92rem;line-height:1.35;}
.a-card-dev{font-size:.72rem;color:var(--a-muted);line-height:1.4;}
.a-card-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;font-size:.74rem;color:var(--a-muted);}
.a-card-meta-sep{color:var(--a-border);}
.a-card-price{font-family:var(--serif);font-size:1.05rem;color:var(--a-gold);font-weight:600;margin-top:auto;padding-top:.3rem;}
.a-card-footer{display:flex;align-items:center;justify-content:space-between;padding:.65rem 1.1rem;border-top:1px solid var(--a-border);gap:.5rem;}
.a-card-toggle{display:flex;align-items:center;}
.a-card-menu-wrap{position:relative;}
.a-card-menu-btn{width:36px;height:36px;background:transparent;border:1px solid var(--a-border);color:var(--a-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:1.1rem;transition:all .15s;line-height:1;}
.a-card-menu-btn:hover{border-color:var(--a-gold);color:var(--a-gold);}
.a-card-dropdown{position:absolute;right:0;bottom:calc(100% + 4px);background:var(--a-surface);border:1px solid var(--a-border);box-shadow:0 4px 16px rgba(0,0,0,.35);z-index:50;min-width:140px;animation:fadeIn .12s ease;}
.a-card-drop-item{display:flex;align-items:center;gap:.6rem;padding:.6rem 1rem;font-size:.8rem;color:var(--a-text);cursor:pointer;transition:background .12s;white-space:nowrap;border:none;background:none;width:100%;font-family:var(--sans);text-align:left;}
.a-card-drop-item:hover{background:var(--a-surface2);}
.a-card-drop-item.danger{color:var(--a-red);}
.a-card-drop-item.danger:hover{background:rgba(191,155,78,.1);}
.a-card-empty{grid-column:1/-1;text-align:center;padding:3rem;color:var(--a-muted);font-size:.84rem;}
.a-fab{display:none;position:fixed;bottom:1.5rem;right:1.5rem;width:52px;height:52px;border-radius:50%;background:var(--a-gold);color:var(--a-bg);border:none;font-size:1.6rem;cursor:pointer;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.4);z-index:100;transition:transform .15s;}
.a-fab:hover{transform:scale(1.08);}
.a-toolbar.sticky{position:sticky;top:0;z-index:20;background:var(--a-bg);padding-top:.5rem;padding-bottom:.5rem;}

/* ══════════════════════════════
   RESPONSIVE — 768 px
══════════════════════════════ */
@media(min-width:769px) and (max-width:1100px){.grid{grid-template-columns:repeat(2,1fr);}}
@media(max-width:768px){
  /* Nav */
  .nav{padding:0 1rem;height:56px;}
  .nav-logo{font-size:1.2rem;}
  .nav-tabs{display:none;}
  .nav-admin{display:none;}
  .nav-cta{display:none;}
  .nav-hamburger{display:flex;}

  /* Landing hero */
  .hero{padding:3rem 1.25rem 2.5rem;}
  .h-sub{font-size:.9rem;}
  .hero-grid{background-size:40px 40px;opacity:.35;}
  .h-ttl{font-size:clamp(1.9rem,6vw,2.8rem);}

  /* Properties grid — 2 col on tablet */
  .main{padding:1.5rem 1rem;}
  .grid{grid-template-columns:repeat(2,1fr);gap:.9rem;}

  /* Section header */
  .sec-label{padding:3rem 1.25rem 1.75rem;}

  /* ── Filter bar — mobile redesign ── */
  .fd-bar{padding:.6rem .85rem .55rem;gap:.5rem;flex-wrap:wrap;border-radius:16px;margin-bottom:1.5rem;}
  .fd-trigger{flex:1 0 auto;justify-content:center;padding:.58rem 1rem;border-radius:10px;font-size:.78rem;min-height:40px;}
  .fd-rcnt{font-size:.72rem;padding:.32rem .65rem;background:rgba(255,255,255,.04);border:1px solid rgba(191,155,78,.15);border-radius:8px;flex-shrink:0;margin-left:0;}
  .fd-pills{order:3;width:100%;min-width:0;padding-top:.4rem;border-top:1px solid rgba(191,155,78,.08);margin-top:.1rem;}
  /* ── Filter sheet — mobile scrollable fix ── */
  .fd-sheet{border-radius:26px 26px 0 0;max-height:93svh;background:linear-gradient(190deg,#181632 0%,#0D0B19 100%);}
  .fd-sheet-inner{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;}
  .fd-sidebar{display:none!important;}
  .fd-handle{width:52px;height:5px;background:rgba(191,155,78,.28);margin:1rem auto .5rem;}
  .fd-hd{padding:.8rem 1.2rem .7rem;border-bottom-color:rgba(191,155,78,.12);flex-shrink:0;}
  .fd-hd-title{font-size:1.15rem;}
  .fd-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:.85rem 1rem;gap:1rem;}
  .fd-sec{margin-bottom:.1rem;}
  .fd-sec-label{padding-bottom:.4rem;border-bottom:1px solid rgba(191,155,78,.1);width:100%;margin-bottom:.5rem;font-size:.58rem;}
  .fd-chips{display:grid;grid-template-columns:repeat(2,1fr);gap:.4rem;}
  .fd-chip{padding:.55rem .5rem;font-size:.76rem;border-radius:9px;min-height:36px;text-align:center;white-space:normal;line-height:1.2;}
  .fd-ft{padding:.8rem 1rem calc(env(safe-area-inset-bottom) + .8rem);gap:.55rem;border-top-color:rgba(191,155,78,.12);flex-shrink:0;}
  .fd-ft-clear{padding:.68rem 1rem;font-size:.76rem;border-radius:11px;}
  .fd-ft-apply{padding:.75rem 1.2rem;font-size:.84rem;font-weight:800;border-radius:11px;letter-spacing:.04em;}
  .price-panel{padding:.85rem;}

  /* Card image */
  .cimg{height:200px;}
  .cbody{padding:1rem;}
  .cname{font-size:1.1rem;}

  /* Compare tray */
  .tray{padding:.6rem 1rem;gap:.65rem;}
  .tray-lbl{display:none;}
  .tslot{width:100px;height:44px;}

  /* Compare page */
  .cmp-pg{padding:1.5rem 1rem 5rem;}
  .cmp-title{font-size:1.7rem;}

  /* RI / VS modals */
  .ri-ov{padding:.75rem;}
  .ri-box{max-height:calc(100svh - 1.5rem);}

  /* Admin */
  .a-main{padding:1.5rem 1rem;}
  .a-stats{grid-template-columns:1fr 1fr;}
  .a-form-grid{grid-template-columns:1fr;}
  .a-form-grid.c3{grid-template-columns:1fr 1fr;}
  .a-sidebar{display:none;}
  .a-modal{max-height:calc(100svh - 1.5rem);}
  .a-modal-body{padding:1.2rem 1rem;}
  .a-modal-ft{padding:1rem;}
  .a-modal-hd{padding:1rem 1.2rem;}
  .a-card-grid{grid-template-columns:repeat(auto-fill,minmax(280px,1fr));}
  .a-card-img-wrap{height:140px;}
  .a-fab{display:flex;}
  .a-add-btn.desktop-only{display:none;}
  .a-toolbar.sticky{position:sticky;top:0;z-index:20;background:var(--a-bg);padding:.6rem 0;margin-bottom:.8rem;}
}

/* ══════════════════════════════
   RESPONSIVE — 480 px
══════════════════════════════ */
@media(max-width:480px){
  /* Nav */
  .nav{padding:0 .75rem;height:52px;}
  .nav-logo{font-size:1.05rem;}

  /* Landing hero */
  .hero{padding:2.5rem 1rem 2rem;}
  .hero-line{display:none;}
  .hero-orb.o1{width:160px;height:160px;left:-50px;top:18px;}
  .hero-orb.o2{width:180px;height:180px;right:-60px;top:20px;}
  .hero-orb.o3{display:none;}
  .h-ttl{font-size:clamp(1.7rem,7vw,2.2rem);}
  .h-sub{font-size:.82rem;}

  /* Properties grid — single column on phone */
  .main{padding:1rem .75rem;}
  .grid{grid-template-columns:1fr;gap:.85rem;}

  /* Section header */
  .sec-label{padding:1.75rem 1rem 1.25rem;}
  .sec-label-title{font-size:clamp(1.55rem,5.5vw,2rem);}
  .sec-label-sub{font-size:.8rem;}

  /* ── Filter bar — phone ── */
  .fd-bar{border-radius:14px;margin-bottom:1.25rem;padding:.55rem .75rem;}
  .fd-trigger{font-size:.74rem;padding:.5rem .9rem;}
  .fd-chips{grid-template-columns:repeat(2,1fr);gap:.35rem;}
  .fd-chip{padding:.48rem .4rem;font-size:.74rem;border-radius:8px;min-height:34px;}
  .fd-body{padding:.75rem .9rem;gap:.85rem;}
  .fd-sec-label{font-size:.56rem;}
  .fd-ft{padding:.7rem .9rem calc(env(safe-area-inset-bottom) + .7rem);}

  /* Card */
  .cimg{height:185px;}
  .cbody{padding:.9rem;}
  .cname{font-size:1rem;}

  /* Compare tray */
  .tray{padding:.5rem .75rem;gap:.5rem;}
  .tslot{width:80px;height:40px;}
  .tslot-nm{font-size:.52rem;}
  .tray-go{padding:.45rem 1rem;font-size:.7rem;}
  .tray-clr{padding:.42rem .7rem;font-size:.68rem;}

  /* Compare page */
  .cmp-pg{padding:1rem .75rem 5rem;}
  .cmp-title{font-size:1.4rem;}

  /* RI / VS modals */
  .ri-ov{padding:0;align-items:flex-end;}
  .ri-box{max-height:96svh;border-radius:var(--r-lg);width:100%;max-width:100%;}
  .ri-body,.ri-wa-body,.ri-success{padding:1.2rem 1.1rem;}
  .ri-hd{padding:1.1rem 1.2rem;}

  /* Admin */
  .a-stats{grid-template-columns:1fr;}
  .a-form-grid.c3{grid-template-columns:1fr;}
  .a-modal{max-height:96svh;}
  .a-toolbar{flex-direction:column;align-items:stretch;}
  .a-search{min-width:unset;}
  .a-tbl-wrap{font-size:.76rem;}
  .a-pg-title{font-size:1.4rem;}
  .a-card-grid{grid-template-columns:1fr;}
  .a-card-img-wrap{height:130px;}
  .a-main{padding:1rem .75rem;}
  .a-login-box{padding:1.8rem 1.2rem;}
}

/* ═══════════════════════════════════════════
   CRM — Lead Management System styles
═══════════════════════════════════════════ */
/* CRM sub-nav */
.crm-subnav{display:flex;gap:.3rem;margin-bottom:1.5rem;border-bottom:1px solid var(--a-border);padding-bottom:.5rem;}
.crm-subbtn{background:transparent;border:none;padding:.5rem 1rem;font-family:var(--sans);font-size:.76rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--a-muted);cursor:pointer;border-radius:6px 6px 0 0;transition:all .18s;}
.crm-subbtn:hover{color:var(--a-text);}
.crm-subbtn.on{background:var(--a-surface2);color:var(--a-gold);}

/* Status badge */
.crm-badge{display:inline-block;font-size:.6rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;padding:.2rem .6rem;border-radius:999px;white-space:nowrap;}

/* Lead table */
.crm-toolbar{display:flex;align-items:center;gap:.65rem;margin-bottom:1rem;flex-wrap:wrap;}
.crm-search{flex:1;min-width:180px;background:var(--a-surface);border:1px solid var(--a-border);color:var(--a-text);padding:.55rem .9rem;font-family:var(--sans);font-size:.82rem;outline:none;border-radius:4px;}
.crm-search:focus{border-color:var(--a-gold);}
.crm-select{background:var(--a-surface);border:1px solid var(--a-border);color:var(--a-text);padding:.55rem 2rem .55rem .85rem;font-family:var(--sans);font-size:.8rem;cursor:pointer;outline:none;border-radius:4px;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238e8a84' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .6rem center;}

/* Lead table */
.crm-tbl-wrap{overflow-x:auto;border:1px solid var(--a-border);border-radius:6px;margin-bottom:1rem;}
.crm-tbl{width:100%;border-collapse:collapse;min-width:700px;}
.crm-tbl thead tr{background:var(--a-surface2);}
.crm-tbl th{padding:.65rem .9rem;text-align:left;font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:var(--a-muted);font-weight:700;border-bottom:1px solid var(--a-border);cursor:pointer;user-select:none;white-space:nowrap;}
.crm-tbl th:hover{color:var(--a-text);}
.crm-tbl td{padding:.7rem .9rem;font-size:.81rem;color:var(--a-text);border-bottom:1px solid var(--a-border);}
.crm-tbl tr:last-child td{border-bottom:none;}
.crm-tbl tbody tr{transition:background .15s;cursor:pointer;}
.crm-tbl tbody tr:hover{background:rgba(255,255,255,.025);}
.crm-score{display:inline-flex;align-items:center;gap:.3rem;font-size:.74rem;font-weight:700;}
.crm-score-bar{height:6px;border-radius:999px;background:rgba(255,255,255,.08);width:48px;overflow:hidden;}
.crm-score-fill{height:100%;border-radius:999px;}
.crm-wa-link{display:inline-flex;align-items:center;gap:.35rem;color:#D4B880;font-size:.76rem;font-weight:600;text-decoration:none;background:rgba(212,184,128,.08);border:1px solid rgba(212,184,128,.2);border-radius:999px;padding:.22rem .65rem;transition:all .18s;}
.crm-wa-link:hover{background:rgba(212,184,128,.18);}
.crm-row-act{display:flex;gap:.3rem;}
.crm-ico{width:28px;height:28px;background:transparent;border:1px solid var(--a-border);color:var(--a-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:4px;transition:all .15s;font-size:.8rem;}
.crm-ico:hover{border-color:var(--a-gold);color:var(--a-gold);}
.crm-ico.del:hover{border-color:var(--a-red);color:var(--a-red);}

/* Kanban */
.crm-kanban{display:flex;gap:1rem;overflow-x:auto;padding-bottom:1rem;min-height:520px;-webkit-overflow-scrolling:touch;}
.crm-col{flex:0 0 240px;background:var(--a-surface);border:1px solid var(--a-border);border-radius:8px;display:flex;flex-direction:column;max-height:calc(100vh - 220px);}
.crm-col-hd{padding:.7rem .9rem;border-bottom:1px solid var(--a-border);display:flex;align-items:center;gap:.5rem;flex-shrink:0;border-radius:8px 8px 0 0;}
.crm-col-hd-label{font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--a-text);flex:1;}
.crm-col-count{background:var(--a-bg);color:var(--a-muted);font-size:.62rem;font-weight:700;padding:.1rem .42rem;border-radius:999px;}
.crm-col-body{flex:1;overflow-y:auto;padding:.5rem;display:flex;flex-direction:column;gap:.5rem;scrollbar-width:thin;scrollbar-color:var(--a-border) transparent;}
.crm-col-body.drag-over{background:rgba(13,13,24,.06);outline:2px dashed rgba(13,13,24,.3);outline-offset:-4px;border-radius:0 0 8px 8px;}
.crm-card{background:var(--a-bg);border:1px solid var(--a-border);border-radius:6px;padding:.75rem .85rem;cursor:grab;transition:all .2s ease;user-select:none;}
.crm-card:hover{border-color:rgba(13,13,24,.35);box-shadow:0 4px 14px rgba(0,0,0,.2);transform:translateY(-1px);}
.crm-card.dragging{opacity:.45;cursor:grabbing;}
.crm-card-name{font-size:.84rem;font-weight:700;color:var(--a-text);margin-bottom:.3rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.crm-card-meta{font-size:.72rem;color:var(--a-muted);margin-bottom:.5rem;line-height:1.5;}
.crm-card-foot{display:flex;align-items:center;justify-content:space-between;gap:.4rem;}
.crm-card-src{font-size:.6rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--a-muted);}
.crm-card-score{font-size:.68rem;font-weight:700;}
.crm-overdue{color:#C4543E;font-size:.64rem;font-weight:700;margin-top:.35rem;display:flex;align-items:center;gap:.25rem;}

/* Lead form modal */
.crm-modal-ov{position:fixed;inset:0;z-index:400;background:rgba(5,7,12,.88);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:1.5rem;animation:fadeIn .2s ease;}
.crm-modal{background:var(--a-surface);border:1px solid var(--a-border);width:100%;max-width:640px;max-height:90vh;display:flex;flex-direction:column;border-radius:8px;overflow:hidden;animation:slideUp .25s ease;}
.crm-modal-hd{background:var(--a-bg);padding:1.2rem 1.5rem;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--a-border);flex-shrink:0;}
.crm-modal-title{font-family:var(--serif);font-size:1.35rem;color:#fff;font-weight:400;}
.crm-modal-title em{color:var(--a-gold);font-style:italic;}
.crm-modal-x{width:32px;height:32px;background:transparent;border:1px solid var(--a-border);color:var(--a-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:4px;transition:all .15s;}
.crm-modal-x:hover{border-color:var(--a-red);color:var(--a-red);}
.crm-modal-body{padding:1.4rem 1.5rem;overflow-y:auto;flex:1;}
.crm-modal-ft{padding:1rem 1.5rem;border-top:1px solid var(--a-border);display:flex;justify-content:flex-end;gap:.65rem;flex-shrink:0;}
.crm-field{margin-bottom:.95rem;}
.crm-label{display:block;font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:var(--a-muted);font-weight:700;margin-bottom:.35rem;}
.crm-inp{width:100%;background:var(--a-bg);border:1px solid var(--a-border);color:var(--a-text);padding:.6rem .85rem;font-family:var(--sans);font-size:.84rem;outline:none;border-radius:4px;transition:border-color .18s;}
.crm-inp:focus{border-color:var(--a-gold);}
.crm-inp::placeholder{color:var(--a-muted);}
.crm-grid2{display:grid;grid-template-columns:1fr 1fr;gap:.85rem;}
.crm-textarea{width:100%;background:var(--a-bg);border:1px solid var(--a-border);color:var(--a-text);padding:.6rem .85rem;font-family:var(--sans);font-size:.84rem;outline:none;border-radius:4px;resize:vertical;min-height:72px;transition:border-color .18s;}
.crm-textarea:focus{border-color:var(--a-gold);}
.crm-btn-pri{background:var(--a-cta);color:var(--a-bg);border:none;padding:.6rem 1.4rem;font-family:var(--sans);font-size:.8rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;border-radius:4px;transition:opacity .2s;}
.crm-btn-pri:hover{opacity:.88;}
.crm-btn-sec{background:transparent;border:1px solid var(--a-border);color:var(--a-muted);padding:.6rem 1.2rem;font-family:var(--sans);font-size:.8rem;cursor:pointer;border-radius:4px;transition:all .18s;}
.crm-btn-sec:hover{border-color:var(--a-text);color:var(--a-text);}

/* Lead detail drawer */
.crm-drawer-ov{position:fixed;inset:0;z-index:350;background:rgba(5,7,12,.55);animation:fadeIn .2s ease;}
.crm-drawer{position:fixed;top:0;right:0;bottom:0;width:min(500px,100vw);background:var(--a-bg);border-left:1px solid var(--a-border);display:flex;flex-direction:column;animation:slideLeft .28s ease;overflow:hidden;}
.crm-drawer{z-index:360;}
@keyframes slideLeft{from{opacity:0;transform:translateX(32px);}to{opacity:1;transform:translateX(0);}}
.crm-drawer-hd{padding:1.2rem 1.4rem;border-bottom:1px solid var(--a-border);display:flex;align-items:flex-start;gap:1rem;flex-shrink:0;background:linear-gradient(180deg,var(--a-surface),var(--a-bg));}
.crm-drawer-body{flex:1 1 0;min-height:0;height:0;overflow-y:scroll;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:1.2rem 1.4rem;}
.crm-drawer-name{font-family:var(--serif);font-size:1.3rem;font-weight:600;color:#fff;flex:1;}
.crm-drawer-sec{background:var(--a-surface);border:1px solid var(--a-border);border-radius:8px;overflow:hidden;margin-bottom:1.2rem;}
.crm-drawer-sec:last-child{margin-bottom:0;}
.crm-drawer-sec-hd{padding:.6rem 1rem;background:var(--a-surface2);font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;color:var(--a-gold);font-weight:700;border-bottom:1px solid var(--a-border);}
.crm-drawer-sec-body{padding:.85rem 1rem;}
.crm-detail-row{display:flex;gap:.5rem;padding:.4rem 0;border-bottom:1px solid var(--a-border);font-size:.8rem;}
.crm-detail-row:last-child{border-bottom:none;}
.crm-detail-key{color:var(--a-muted);font-size:.72rem;min-width:110px;flex-shrink:0;font-weight:600;letter-spacing:.04em;padding-top:.05rem;}
.crm-detail-val{color:var(--a-text);flex:1;font-weight:500;line-height:1.5;}

/* Activity feed */
.crm-activity-list{display:flex;flex-direction:column;gap:.6rem;}
.crm-activity-item{display:flex;gap:.75rem;font-size:.79rem;}
.crm-activity-dot{width:30px;height:30px;border-radius:50%;background:var(--a-surface2);border:1px solid var(--a-border);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:.85rem;}
.crm-activity-content{flex:1;padding-top:.2rem;}
.crm-activity-text{color:var(--a-text);line-height:1.5;margin-bottom:.18rem;}
.crm-activity-time{color:var(--a-muted);font-size:.68rem;}
.crm-note-form{display:flex;gap:.5rem;margin-top:.65rem;}
.crm-note-inp{flex:1;background:var(--a-bg);border:1px solid var(--a-border);color:var(--a-text);padding:.55rem .8rem;font-family:var(--sans);font-size:.82rem;outline:none;border-radius:4px;}
.crm-note-inp:focus{border-color:var(--a-gold);}
.crm-note-add{background:var(--a-cta);color:var(--a-bg);border:none;padding:.55rem 1rem;font-family:var(--sans);font-size:.76rem;font-weight:700;cursor:pointer;border-radius:4px;white-space:nowrap;}

/* Analytics cards */
.crm-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.85rem;margin-bottom:1.5rem;}
.crm-stat{background:var(--a-surface);border:1px solid var(--a-border);padding:1rem 1.2rem;border-radius:8px;}
.crm-stat-lbl{font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:var(--a-muted);margin-bottom:.45rem;font-weight:600;}
.crm-stat-val{font-family:var(--serif);font-size:1.9rem;font-weight:600;color:#fff;line-height:1;}
.crm-stat-sub{font-size:.72rem;color:var(--a-muted);margin-top:.25rem;}
/* SVG chart */
.crm-chart-card{background:var(--a-surface);border:1px solid var(--a-border);border-radius:8px;padding:1.1rem 1.3rem;margin-bottom:1rem;}
.crm-chart-title{font-size:.65rem;letter-spacing:.12em;text-transform:uppercase;color:var(--a-gold);font-weight:700;margin-bottom:1rem;}
.crm-bar-row{display:flex;align-items:center;gap:.65rem;margin-bottom:.55rem;font-size:.78rem;}
.crm-bar-lbl{width:90px;flex-shrink:0;color:var(--a-muted);text-align:right;font-size:.72rem;}
.crm-bar-track{flex:1;height:8px;background:rgba(255,255,255,.06);border-radius:999px;overflow:hidden;}
.crm-bar-fill{height:100%;border-radius:999px;transition:width .5s ease;}
.crm-bar-val{width:32px;flex-shrink:0;color:var(--a-text);font-weight:700;font-size:.76rem;}

@media(max-width:768px){
  .crm-kanban{flex-direction:column;}
  .crm-col{flex:0 0 auto;max-height:320px;}
  .crm-grid2{grid-template-columns:1fr;}
  .crm-drawer{width:100vw;border-radius:var(--r-lg) var(--r-lg) 0 0;top:auto;height:92svh;}
}

.card{background:var(--card);border:1px solid var(--border);cursor:pointer;overflow:hidden;transition:transform .25s,box-shadow .25s;position:relative;}
.card:hover{transform:translateY(-4px);box-shadow:0 18px 44px rgba(0,0,0,.1);}
.card.sel{outline:2.5px solid var(--gold);}
.cimg{position:relative;height:260px;overflow:hidden;}
.cimg img{width:100%;height:100%;object-fit:cover;transition:transform .5s;}
.card:hover .cimg img{transform:scale(1.05);}
.ctag{position:absolute;top:1rem;left:1rem;font-size:.65rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#fff;padding:.25rem .6rem;}
.cstat{position:absolute;bottom:1rem;right:1rem;background:rgba(0,0,0,.6);color:#fff;font-size:.68rem;letter-spacing:.06em;padding:.2rem .6rem;backdrop-filter:blur(4px);}
.cbtn{position:absolute;top:1rem;right:1rem;width:32px;height:32px;background:rgba(0,0,0,.55);border:1.5px solid rgba(255,255,255,.4);color:#fff;font-size:1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .2s,border-color .2s;backdrop-filter:blur(4px);z-index:5;}
.cbtn:hover,.cbtn.on{background:var(--gold);border-color:var(--gold);color:var(--ink);}
.cbody{padding:1.4rem;}
.ctype{font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);font-weight:500;margin-bottom:.35rem;}
.cname{font-family:var(--serif);font-size:1.3rem;font-weight:600;line-height:1.2;margin-bottom:.25rem;}
.cdev{font-size:.76rem;color:var(--muted);margin-bottom:.7rem;}
.cloc{display:flex;align-items:center;gap:.35rem;font-size:.78rem;color:var(--muted);margin-bottom:.9rem;}
.cdiv{height:1px;background:var(--border);margin-bottom:.9rem;}
.crow{display:flex;justify-content:space-between;align-items:flex-end;}
.cplbl{font-size:.65rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);}
.cprice{font-family:var(--serif);font-size:1.45rem;font-weight:600;}
.cmeta{display:flex;gap:.9rem;font-size:.74rem;color:var(--muted);}
.cmeta span{display:flex;align-items:center;gap:.25rem;}
.empty{text-align:center;padding:5rem 2rem;grid-column:1/-1;}
.empty-ico{font-size:3rem;margin-bottom:1rem;opacity:.3;}
.empty-h{font-family:var(--serif);font-size:1.8rem;margin-bottom:.5rem;}
.empty-s{color:var(--muted);font-size:.9rem;}

.tray{position:fixed;bottom:0;left:0;right:0;z-index:90;background:#0D0D18;border-top:1px solid #0D0D18;padding:.8rem 1.5rem;display:flex;align-items:center;gap:1rem;transform:translateY(100%);transition:transform .3s;border-radius:var(--r-md) var(--r-md) 0 0;}
.tray.show{transform:translateY(0);}
.tray-lbl{font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:#D4B880;white-space:nowrap;}
.tray-slots{display:flex;gap:.4rem;flex:1;overflow-x:auto;}
.tslot{width:120px;height:50px;flex-shrink:0;border:1px dashed #0D0D18;display:flex;align-items:center;justify-content:center;font-size:.68rem;color:#D4B880;}
.tslot.fill{border:1px solid #0D0D18;background:#0D0D18;position:relative;overflow:hidden;}
.tslot img{width:100%;height:100%;object-fit:cover;opacity:.55;}
.tslot-nm{position:absolute;bottom:0;left:0;right:0;padding:.12rem .3rem;background:rgba(0,0,0,.75);color:#bbb;font-size:.58rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.tslot-x{position:absolute;top:2px;right:2px;width:16px;height:16px;background:rgba(13,13,24,.9);border:none;color:#D4B880;font-size:.7rem;cursor:pointer;display:flex;align-items:center;justify-content:center;}
.tslot-x:hover{background:#D4B880;color:#fff;}
.tray-go{background:var(--cta);color:#fff;border:none;padding:.5rem 1.3rem;font-family:var(--sans);font-size:.76rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;white-space:nowrap;}
.tray-go:hover{opacity:.88;}
.tray-clr{background:transparent;color:#D4B880;border:1px solid #0D0D18;padding:.48rem .9rem;font-family:var(--sans);font-size:.72rem;cursor:pointer;}
.tray-clr:hover{color:#ccc;}

.cmp-pg{width:100%;padding:2.5rem 2rem 5rem;}
.cmp-hd{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:2rem;flex-wrap:wrap;gap:1rem;}
.cmp-title{font-family:var(--serif);font-size:2.2rem;font-weight:300;}
.cmp-title em{font-style:italic;color:var(--gold);}
.cmp-sub{color:var(--muted);font-size:.84rem;margin-top:.3rem;}
.cmp-pdf-fx{position:fixed;inset:0;pointer-events:none;z-index:230;opacity:0;transition:opacity .2s ease;}
.cmp-pdf-fx.on{opacity:1;}
.cmp-pdf-fx-core{position:absolute;top:18%;right:8%;width:14px;height:14px;border-radius:50%;background:radial-gradient(circle,#fff 0%,#D4B880 48%,rgba(212,184,128,.08) 100%);box-shadow:0 0 24px rgba(212,184,128,.85),0 0 80px rgba(212,184,128,.38);animation:cmpFxCore .95s cubic-bezier(.22,1,.36,1) forwards;}
.cmp-pdf-fx-ring{position:absolute;top:18%;right:8%;width:14px;height:14px;border-radius:50%;border:2px solid rgba(212,184,128,.8);transform:translate(0,0) scale(.2);opacity:.9;animation:cmpFxRing .95s cubic-bezier(.22,1,.36,1) forwards;}
.cmp-pdf-fx-ring.r2{animation-delay:.08s;}
.cmp-pdf-fx-ring.r3{animation-delay:.14s;}
.cmp-pdf-fx-beam{position:absolute;top:18%;right:8%;width:140px;height:2px;background:linear-gradient(90deg,rgba(212,184,128,.95),rgba(212,184,128,0));transform-origin:right center;opacity:0;animation:cmpFxBeam .9s ease-out forwards;}
.cmp-pdf-fx-beam.b2{transform:rotate(40deg);animation-delay:.06s;}
.cmp-pdf-fx-beam.b3{transform:rotate(-38deg);animation-delay:.1s;}
.cmp-pdf-fx-beam.b4{transform:rotate(88deg);animation-delay:.14s;}
.cmp-pdf-fx-beam.b5{transform:rotate(-82deg);animation-delay:.18s;}
.cmp-pdf-fx-dot{position:absolute;top:18%;right:8%;width:6px;height:6px;border-radius:50%;background:#FFE08A;box-shadow:0 0 10px rgba(255,224,138,.75);animation:cmpFxDot .9s ease-out forwards;}
.cmp-pdf-fx-dot.d1{--tx:74px;--ty:-36px;animation-delay:.02s;}
.cmp-pdf-fx-dot.d2{--tx:106px;--ty:8px;animation-delay:.05s;}
.cmp-pdf-fx-dot.d3{--tx:62px;--ty:54px;animation-delay:.08s;}
.cmp-pdf-fx-dot.d4{--tx:-38px;--ty:40px;animation-delay:.11s;}
.cmp-pdf-fx-dot.d5{--tx:-52px;--ty:-16px;animation-delay:.14s;}
.cmp-pdf-fx-dot.d6{--tx:18px;--ty:-68px;animation-delay:.17s;}

.pdf-btn-wrap{position:relative;display:inline-flex;}
.pdf-btn{position:relative;overflow:hidden;display:flex;align-items:center;gap:.5rem;background:var(--ink);color:#fff;border:1px solid rgba(255,255,255,.2);padding:.6rem 1.4rem;font-family:var(--sans);font-size:.78rem;font-weight:500;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:border-color .2s,transform .22s ease,box-shadow .22s ease;}
.pdf-btn:hover{border-color:var(--gold);transform:translateY(-2px);box-shadow:0 10px 24px rgba(0,0,0,.25),0 0 24px rgba(212,184,128,.18);}
.pdf-btn::before{content:'';position:absolute;inset:0;background:linear-gradient(110deg,transparent 25%,rgba(255,255,255,.34) 50%,transparent 75%);transform:translateX(-130%);transition:transform .5s ease;pointer-events:none;}
.pdf-btn:hover::before{transform:translateX(130%);}
.pdf-btn.busy{border-color:var(--gold);box-shadow:0 0 0 1px rgba(212,184,128,.36),0 0 26px rgba(212,184,128,.28);}
.pdf-btn.busy .pdf-btn-ico{animation:pdfSpin 1s linear infinite;}
.pdf-btn.busy .pdf-btn-txt{animation:pdfPulse .9s ease-in-out infinite;}
.pdf-btn .pdf-btn-spark{position:absolute;right:.55rem;top:50%;width:6px;height:6px;border-radius:50%;background:#FFE08A;box-shadow:0 0 10px rgba(255,224,138,.78);transform:translateY(-50%) scale(0);opacity:0;}
.pdf-btn.busy .pdf-btn-spark{animation:pdfSpark 1.1s ease-in-out infinite;}
.pdf-btn:disabled{opacity:.5;cursor:not-allowed;}

@keyframes cmpFxCore{0%{transform:scale(.25);opacity:0;}25%{transform:scale(1.3);opacity:1;}100%{transform:scale(.6);opacity:0;}}
@keyframes cmpFxRing{0%{transform:scale(.2);opacity:.95;}100%{transform:scale(14);opacity:0;}}
@keyframes cmpFxBeam{0%{opacity:0;transform:scaleX(.1);}20%{opacity:.95;transform:scaleX(1);}100%{opacity:0;transform:scaleX(1.15);}}
@keyframes cmpFxDot{0%{transform:translate(0,0) scale(.2);opacity:1;}80%{opacity:.92;}100%{transform:translate(var(--tx),var(--ty)) scale(.95);opacity:0;}}
@keyframes pdfSpin{from{transform:rotate(0);}to{transform:rotate(360deg);}}
@keyframes pdfPulse{0%,100%{opacity:.75;}50%{opacity:1;}}
@keyframes pdfSpark{0%{transform:translateY(-50%) scale(0);opacity:0;}35%{transform:translateY(-50%) scale(1.1);opacity:1;}100%{transform:translateY(-50%) scale(0);opacity:0;}}
.cmp-nil{text-align:center;padding:5rem 2rem;}
.cmp-nil-ico{font-size:3.5rem;margin-bottom:1.2rem;opacity:.22;}
.cmp-nil-h{font-family:var(--serif);font-size:2rem;margin-bottom:.5rem;}
.cmp-nil-s{color:var(--muted);font-size:.9rem;margin-bottom:1.5rem;}
.go-btn{background:var(--cta);color:#fff;border:none;padding:.65rem 1.8rem;font-family:var(--sans);font-size:.82rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;}
.go-btn:hover{opacity:.88;}
.ctbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
.ctbl{border-collapse:collapse;min-width:700px;width:100%;}
.ctbl th,.ctbl td{padding:0;vertical-align:stretch;}
.ctbl tbody td{vertical-align:stretch;height:1px;}
.proj-col{min-width:180px;width:auto;}
.proj-card{background:var(--card);border:1px solid var(--border);overflow:hidden;position:relative;}
.proj-img{width:100%;height:120px;object-fit:cover;}
.proj-info{padding:.8rem;}
.proj-type{font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:var(--gold);margin-bottom:.18rem;}
.proj-nm{font-family:var(--serif);font-size:.98rem;font-weight:600;line-height:1.2;margin-bottom:.18rem;}
.proj-dv{font-size:.68rem;color:var(--muted);}
.proj-rm{position:absolute;top:.4rem;right:.4rem;width:22px;height:22px;background:rgba(0,0,0,.55);border:none;color:#D4B880;font-size:.72rem;cursor:pointer;display:flex;align-items:center;justify-content:center;}
.proj-rm:hover{background:#D4B880;color:#fff;}
.lbl-col{width:150px;min-width:150px;}
.lbl-cell{padding:.7rem .9rem;font-size:.74rem;font-weight:600;color:var(--ink);border-bottom:1px solid var(--border);border-right:1px solid var(--border);min-height:50px;height:100%;display:flex;align-items:center;background:var(--warm);box-sizing:border-box;}
.sec-hd{padding:.55rem .9rem;font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);font-weight:700;background:var(--ink);border-bottom:1px solid #0D0D18;border-right:1px solid #0D0D18;min-height:34px;height:100%;display:flex;align-items:center;box-sizing:border-box;}
.val-cell{padding:.7rem .9rem;font-size:.8rem;color:var(--ink);border-bottom:1px solid var(--border);border-right:1px solid var(--border);min-height:50px;height:100%;display:flex;align-items:center;background:var(--card);overflow:hidden;box-sizing:border-box;}
.val-cell.best-cell{background:#FAF8F3;}
.val-cell.sec{background:var(--ink);border-bottom:1px solid #0D0D18;border-right:1px solid #0D0D18;min-height:34px;}
.best-tag{background:var(--gold);color:var(--ink);font-size:.56rem;font-weight:700;letter-spacing:.06em;padding:.1rem .38rem;margin-left:.4rem;white-space:nowrap;}
.tw{display:flex;flex-wrap:wrap;gap:.3rem;overflow:hidden;max-width:100%;}
.ctag2{background:var(--warm);border:1px solid var(--border);font-size:.62rem;padding:.15rem .45rem;color:var(--ink);max-width:100%;word-break:break-word;white-space:normal;line-height:1.4;}
.add-more{text-align:center;padding:1.8rem;background:var(--warm);border:1px dashed var(--border);margin-top:1rem;}
.add-more p{color:var(--muted);font-size:.84rem;margin-bottom:.7rem;}

/* ═══ LOAN CALCULATOR — LUXURY FINTECH DASHBOARD ═══ */
@keyframes lcPulse{0%,100%{opacity:.6;transform:scale(1);}50%{opacity:1;transform:scale(1.08);}}
@keyframes lcFloat{0%,100%{transform:translateY(0);}50%{transform:translateY(-8px);}}
@keyframes lcGlow{0%,100%{box-shadow:0 0 20px rgba(191,155,78,.12);}50%{box-shadow:0 0 40px rgba(191,155,78,.28),0 0 60px rgba(0,212,255,.08);}}
@keyframes lcRingFill{from{stroke-dasharray:0 999;}to{stroke-dasharray:var(--fill) 999;}}
@keyframes lcFadeUp{from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:translateY(0);}}
@keyframes lcNumFlash{0%{color:rgba(212,184,128,.4);}50%{color:#FFE08A;}100%{color:#D4B880;}}
.lc-pg{min-height:100vh;background:linear-gradient(160deg,#02030A 0%,#070B1A 45%,#0B1020 100%);position:relative;overflow:hidden;padding:0 0 6rem;}
.lc-pg-blob1{position:absolute;top:-120px;left:-80px;width:520px;height:520px;background:radial-gradient(circle,rgba(191,155,78,.07) 0%,transparent 70%);pointer-events:none;border-radius:50%;animation:lcFloat 8s ease-in-out infinite;}
.lc-pg-blob2{position:absolute;top:30%;right:-100px;width:400px;height:400px;background:radial-gradient(circle,rgba(0,212,255,.05) 0%,transparent 70%);pointer-events:none;border-radius:50%;animation:lcFloat 11s ease-in-out infinite reverse;}
.lc-pg-blob3{position:absolute;bottom:10%;left:20%;width:300px;height:300px;background:radial-gradient(circle,rgba(191,155,78,.04) 0%,transparent 70%);pointer-events:none;border-radius:50%;animation:lcFloat 9s ease-in-out infinite;}
.lc-pg-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(191,155,78,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(191,155,78,.04) 1px,transparent 1px);background-size:60px 60px;pointer-events:none;}
/* Hero band */
.lc-hero-band{position:relative;padding:3.5rem 3rem 2.5rem;text-align:center;z-index:2;}
.lc-hero-eyebrow{font-size:.6rem;letter-spacing:.25em;text-transform:uppercase;color:rgba(0,212,255,.7);font-weight:600;margin-bottom:.8rem;}
.lc-hero-headline{font-family:var(--serif);font-size:clamp(2.2rem,5vw,3.6rem);font-weight:300;line-height:1.1;margin-bottom:.6rem;background:linear-gradient(135deg,#D4B880 0%,#FFE08A 40%,#BF9B4E 70%,rgba(0,212,255,.9) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.lc-hero-desc{font-size:.84rem;color:rgba(255,255,255,.38);max-width:520px;margin:0 auto 1.4rem;line-height:1.7;}
/* Savings badge */
.lc-savings-band{display:inline-flex;align-items:center;gap:.9rem;background:rgba(22,163,74,.08);border:1px solid rgba(74,222,128,.18);border-radius:999px;padding:.45rem 1.2rem;font-size:.78rem;margin-top:.4rem;}
.lc-savings-band strong{color:#4ade80;font-weight:700;}
.lc-savings-band span{color:rgba(255,255,255,.4);font-size:.72rem;}
.lc-bm-badge{display:inline-flex;align-items:center;gap:.4rem;background:linear-gradient(135deg,rgba(22,163,74,.18),rgba(16,185,129,.12));border:1px solid rgba(74,222,128,.3);color:#4ade80;font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:.3rem .9rem;border-radius:999px;margin-left:.6rem;}
/* Main layout */
.lc-dash{display:grid;grid-template-columns:1fr 1fr;gap:1.6rem;padding:0 2.5rem;position:relative;z-index:2;align-items:start;}
/* Glass card base */
.lc-gc{background:rgba(255,255,255,.03);border:1px solid rgba(191,155,78,.14);border-radius:18px;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);transition:border-color .3s,box-shadow .3s,transform .3s;}
.lc-gc:hover{border-color:rgba(191,155,78,.28);box-shadow:0 12px 40px rgba(0,0,0,.3),0 0 0 1px rgba(191,155,78,.06) inset;transform:translateY(-2px);}
/* Input column */
.lc-inp-col{display:flex;flex-direction:column;gap:1.1rem;}
/* Section card */
.lc-sec{padding:1.4rem 1.5rem;}
.lc-sec-hd{display:flex;align-items:center;gap:.55rem;margin-bottom:1.1rem;}
.lc-sec-ico{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:.85rem;flex-shrink:0;}
.lc-sec-ico-gold{background:linear-gradient(135deg,rgba(191,155,78,.2),rgba(212,184,128,.1));border:1px solid rgba(191,155,78,.25);}
.lc-sec-ico-cyan{background:linear-gradient(135deg,rgba(0,212,255,.15),rgba(0,180,220,.07));border:1px solid rgba(0,212,255,.2);}
.lc-sec-ico-grn{background:linear-gradient(135deg,rgba(74,222,128,.15),rgba(22,163,74,.07));border:1px solid rgba(74,222,128,.2);}
.lc-sec-title{font-size:.6rem;letter-spacing:.18em;text-transform:uppercase;color:rgba(212,184,128,.65);font-weight:700;}
/* Fields */
.lc-flds{display:flex;flex-direction:column;gap:1rem;}
.lc-fld{display:flex;flex-direction:column;gap:.28rem;}
.lc-fld2{display:grid;grid-template-columns:1fr 1fr;gap:.7rem;}
.lc-flbl{font-size:.68rem;font-weight:600;color:rgba(255,255,255,.45);letter-spacing:.06em;text-transform:uppercase;}
/* Premium input */
.lc-finp{background:rgba(255,255,255,.04);border:1px solid rgba(191,155,78,.18);border-radius:10px;padding:.7rem 1rem;font-family:var(--sans);font-size:1rem;font-weight:600;color:#FFE08A;outline:none;width:100%;box-sizing:border-box;transition:border-color .25s,box-shadow .25s,background .25s;}
.lc-finp:focus{border-color:rgba(191,155,78,.55);box-shadow:0 0 0 3px rgba(191,155,78,.08),0 0 20px rgba(191,155,78,.08);background:rgba(255,255,255,.06);}
/* Slider */
.lc-fslider-wrap{display:flex;flex-direction:column;gap:.35rem;}
.lc-fslider-top{display:flex;justify-content:space-between;align-items:center;}
.lc-fslider-val{font-size:.82rem;font-weight:700;color:#D4B880;font-family:var(--serif);}
.lc-fslider{-webkit-appearance:none;appearance:none;width:100%;height:5px;border-radius:999px;background:linear-gradient(90deg,rgba(191,155,78,.22),rgba(191,155,78,.08));outline:none;cursor:pointer;position:relative;}
.lc-fslider::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:linear-gradient(135deg,#D4B880,#BF9B4E);border:2px solid rgba(255,235,180,.4);box-shadow:0 0 12px rgba(191,155,78,.5),0 2px 6px rgba(0,0,0,.4);cursor:pointer;transition:transform .2s,box-shadow .2s;}
.lc-fslider::-webkit-slider-thumb:hover{transform:scale(1.25);box-shadow:0 0 20px rgba(191,155,78,.8);}
.lc-fslider-ends{display:flex;justify-content:space-between;font-size:.6rem;color:rgba(255,255,255,.25);margin-top:.1rem;}
/* Hints */
.lc-fhint{font-size:.68rem;margin-top:.1rem;}
.lc-fhint-gold{color:rgba(212,184,128,.7);font-weight:600;}
.lc-fhint-grn{color:#4ade80;font-weight:600;}
/* Adj banner */
.lc-adj{display:flex;justify-content:space-between;align-items:center;background:linear-gradient(135deg,rgba(191,155,78,.08),rgba(191,155,78,.04));border:1px solid rgba(191,155,78,.2);border-radius:10px;padding:.65rem 1rem;font-size:.76rem;color:rgba(255,255,255,.55);}
.lc-adj strong{color:#D4B880;font-weight:700;font-size:.88rem;}
.lc-rebate-note{font-size:.68rem;color:rgba(255,255,255,.3);background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:.5rem .8rem;line-height:1.6;}
.lc-foreign-note{margin-top:.6rem;padding:.6rem .9rem;background:rgba(191,155,78,.06);border:1px solid rgba(191,155,78,.18);border-radius:10px;font-size:.72rem;color:rgba(212,184,128,.75);line-height:1.5;}
/* Toggle group */
.lc-tgrp{display:flex;gap:.5rem;flex-wrap:wrap;}
.lc-tpill{display:flex;border-radius:999px;overflow:hidden;border:1px solid rgba(191,155,78,.18);background:rgba(255,255,255,.02);}
.lc-tpill button{padding:.38rem 1.1rem;font-family:var(--sans);font-size:.7rem;font-weight:600;background:transparent;color:rgba(255,255,255,.35);border:none;cursor:pointer;transition:all .2s;white-space:nowrap;letter-spacing:.05em;}
.lc-tpill button.on{background:linear-gradient(135deg,#BF9B4E,#D4B880);color:#02030A;box-shadow:0 0 14px rgba(191,155,78,.4);}
/* Mode toggle (% vs RM) */
.lc-mode-toggle{display:inline-flex;border-radius:6px;overflow:hidden;border:1px solid rgba(191,155,78,.3);}
.lc-mode-toggle button{padding:.18rem .55rem;font-family:var(--sans);font-size:.65rem;font-weight:600;background:transparent;color:rgba(255,255,255,.4);border:none;cursor:pointer;transition:all .18s;letter-spacing:.03em;}
.lc-mode-toggle button.on{background:linear-gradient(135deg,#BF9B4E,#D4B880);color:#02030A;}
/* ── Result column ── */
.lc-res-col{display:flex;flex-direction:column;gap:1.1rem;position:sticky;top:1.5rem;}
/* Monthly hero */
.lc-monthly{padding:2rem 1.8rem;text-align:center;position:relative;overflow:hidden;background:linear-gradient(160deg,rgba(12,10,30,.9) 0%,rgba(5,5,18,.95) 100%);border:1px solid rgba(191,155,78,.2);}
.lc-monthly::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 50% 0%,rgba(191,155,78,.12) 0%,transparent 65%);pointer-events:none;}
.lc-monthly-ring{position:relative;margin:0 auto 1.2rem;width:130px;height:130px;}
.lc-monthly-ring svg{transform:rotate(-90deg);}
.lc-monthly-ring-inner{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;}
.lc-monthly-ring-pct{font-size:.78rem;font-weight:700;color:#D4B880;}
.lc-monthly-ring-pctlbl{font-size:.5rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(212,184,128,.45);}
.lc-monthly-eyebrow{font-size:.58rem;letter-spacing:.22em;text-transform:uppercase;color:rgba(0,212,255,.65);margin-bottom:.5rem;}
.lc-monthly-val{font-family:var(--serif);font-size:clamp(2rem,4vw,2.8rem);font-weight:300;line-height:1;margin-bottom:.3rem;background:linear-gradient(135deg,#FFE08A,#D4B880);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.lc-monthly-meta{font-size:.72rem;color:rgba(255,255,255,.3);line-height:1.7;}
.lc-monthly-legend{display:flex;justify-content:center;gap:1.2rem;margin-top:.8rem;}
.lc-monthly-leg{display:flex;align-items:center;gap:.35rem;font-size:.65rem;color:rgba(255,255,255,.4);}
.lc-monthly-legdot{width:8px;height:8px;border-radius:2px;}
/* Metrics grid */
.lc-metrics{display:grid;grid-template-columns:1fr 1fr;gap:.7rem;}
.lc-metric{padding:.9rem 1rem;position:relative;overflow:hidden;}
.lc-metric::after{content:"";position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,rgba(191,155,78,.25),transparent);}
.lc-metric-lbl{font-size:.56rem;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.3);margin-bottom:.25rem;}
.lc-metric-val{font-family:var(--serif);font-size:1.05rem;font-weight:600;color:#D4B880;line-height:1.2;}
.lc-metric-val.cyan{color:#00D4FF;}
.lc-metric-val.grn{color:#4ade80;}
.lc-metric-val.dim{color:rgba(255,255,255,.4);font-size:.88rem;}
/* Net cash */
.lc-netcash{padding:1.2rem 1.5rem;background:linear-gradient(135deg,rgba(10,40,20,.9),rgba(5,25,12,.95));border:1px solid rgba(74,222,128,.2);position:relative;overflow:hidden;}
.lc-netcash::before{content:"";position:absolute;top:-30px;right:-30px;width:100px;height:100px;background:radial-gradient(circle,rgba(74,222,128,.12),transparent 70%);pointer-events:none;}
.lc-netcash-top{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:.5rem;}
.lc-netcash-lbl{font-size:.58rem;letter-spacing:.18em;text-transform:uppercase;color:rgba(74,222,128,.6);margin-bottom:.3rem;}
.lc-netcash-val{font-family:var(--serif);font-size:1.9rem;font-weight:300;color:#4ade80;line-height:1;}
.lc-netcash-save{text-align:right;}
.lc-netcash-save-lbl{font-size:.56rem;letter-spacing:.12em;text-transform:uppercase;color:rgba(74,222,128,.45);}
.lc-netcash-save-val{font-size:1rem;font-weight:700;color:#4ade80;}
/* Breakdown */
.lc-bkd{overflow:hidden;}
.lc-bkd-btn{width:100%;padding:1rem 1.5rem;background:transparent;border:none;font-family:var(--sans);font-size:.72rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(212,184,128,.7);cursor:pointer;display:flex;justify-content:space-between;align-items:center;transition:color .2s;}
.lc-bkd-btn:hover{color:#D4B880;}
.lc-bkd-btn-ico{font-size:.8rem;transition:transform .25s;}
.lc-bkd-btn-ico.open{transform:rotate(180deg);}
.lc-bkd-inner{padding:0 1.5rem 1.2rem;animation:lcFadeUp .25s ease;}
.lc-bkd-section-title{font-size:.55rem;letter-spacing:.18em;text-transform:uppercase;color:rgba(191,155,78,.55);font-weight:700;padding:.6rem 0 .3rem;border-bottom:1px solid rgba(191,155,78,.1);margin-bottom:.2rem;}
.lc-bkd-row{display:flex;justify-content:space-between;align-items:center;padding:.42rem 0;border-bottom:1px solid rgba(255,255,255,.03);}
.lc-bkd-row:last-child{border-bottom:none;}
.lc-bkd-rowlbl{font-size:.72rem;color:rgba(255,255,255,.4);}
.lc-bkd-rowval{font-size:.74rem;font-weight:600;color:rgba(255,255,255,.7);}
.lc-bkd-rowval.gold{color:#D4B880;}
.lc-bkd-rowval.grn{color:#4ade80;}
.lc-bkd-total{display:flex;justify-content:space-between;align-items:center;padding:.8rem 0 .2rem;margin-top:.4rem;border-top:1px solid rgba(191,155,78,.25);}
.lc-bkd-total-lbl{font-size:.8rem;font-weight:700;color:rgba(255,255,255,.8);}
.lc-bkd-total-val{font-family:var(--serif);font-size:1.1rem;font-weight:600;color:#4ade80;}
.lc-bkd-note{font-size:.6rem;color:rgba(255,255,255,.2);line-height:1.6;margin-top:.6rem;padding-top:.6rem;border-top:1px solid rgba(255,255,255,.04);}
/* Actions */
.lc-actions{display:flex;gap:.75rem;flex-wrap:wrap;padding:0 2.5rem;position:relative;z-index:2;margin-top:.5rem;}
.lc-wa-btn{display:inline-flex;align-items:center;gap:.55rem;background:linear-gradient(135deg,#25D366,#128C7E);color:#fff;padding:.7rem 1.5rem;border-radius:999px;font-family:var(--sans);font-size:.74rem;font-weight:700;text-decoration:none;letter-spacing:.05em;transition:opacity .2s,box-shadow .2s;box-shadow:0 4px 16px rgba(37,211,102,.25);}
.lc-wa-btn:hover{opacity:.9;box-shadow:0 6px 24px rgba(37,211,102,.4);}
.lc-save-btn{display:inline-flex;align-items:center;gap:.45rem;background:rgba(191,155,78,.08);border:1px solid rgba(191,155,78,.25);color:#D4B880;padding:.66rem 1.4rem;border-radius:999px;font-family:var(--sans);font-size:.72rem;font-weight:600;cursor:pointer;letter-spacing:.06em;transition:all .2s;}
.lc-save-btn:hover{background:rgba(191,155,78,.15);border-color:rgba(191,155,78,.45);}
.lc-load-btn{display:inline-flex;align-items:center;gap:.45rem;background:rgba(0,212,255,.06);border:1px solid rgba(0,212,255,.2);color:rgba(0,212,255,.8);padding:.66rem 1.3rem;border-radius:999px;font-family:var(--sans);font-size:.72rem;font-weight:600;cursor:pointer;letter-spacing:.06em;transition:all .2s;}
.lc-load-btn:hover{background:rgba(0,212,255,.12);border-color:rgba(0,212,255,.4);}
/* Mobile sticky bar */
.lc-mob-bar{display:none;}
/* Responsive */
@media(max-width:992px){
  .lc-dash{grid-template-columns:1fr;}
  .lc-res-col{position:static;}
}
@media(max-width:768px){
  .lc-hero-band{padding:2.5rem 1.2rem 1.5rem;}
  .lc-dash{padding:0 1rem;gap:1rem;}
  .lc-actions{padding:0 1rem;}
  .lc-monthly-val{font-size:2rem;}
  .lc-metrics{grid-template-columns:1fr 1fr;}
  .lc-mob-bar{display:flex;align-items:center;justify-content:space-between;position:fixed;bottom:0;left:0;right:0;z-index:90;background:rgba(7,11,26,.95);border-top:1px solid rgba(191,155,78,.18);backdrop-filter:blur(16px);padding:.9rem 1.2rem;padding-bottom:calc(.9rem + env(safe-area-inset-bottom));}
  .lc-mob-monthly{font-size:.6rem;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.4);}
  .lc-mob-val{font-size:1.15rem;font-weight:700;color:#D4B880;font-family:var(--serif);}
  .lc-mob-sub{font-size:.62rem;color:rgba(255,255,255,.3);}
  .lc-mob-wa{background:linear-gradient(135deg,#25D366,#128C7E);color:#fff;font-family:var(--sans);font-size:.78rem;font-weight:700;padding:.6rem 1.3rem;border-radius:999px;text-decoration:none;box-shadow:0 4px 14px rgba(37,211,102,.3);}
}
/* ── Entry stagger ── */
@keyframes lcCardIn{from{opacity:0;transform:translateY(22px);}to{opacity:1;transform:translateY(0);}}
.lc-monthly{animation:lcCardIn .5s .05s both;}
.lc-amort{animation:lcCardIn .5s .15s both;}
.lc-cbar{animation:lcCardIn .5s .2s both;}
.lc-netcash{animation:lcCardIn .5s .28s both;}
.lc-bkd{animation:lcCardIn .5s .36s both;}
.lc-metrics>.lc-gc:nth-child(1){animation:lcCardIn .45s .22s both;}
.lc-metrics>.lc-gc:nth-child(2){animation:lcCardIn .45s .29s both;}
.lc-metrics>.lc-gc:nth-child(3){animation:lcCardIn .45s .36s both;}
.lc-metrics>.lc-gc:nth-child(4){animation:lcCardIn .45s .43s both;}
.lc-inp-col>.lc-gc:nth-child(1){animation:lcCardIn .5s .05s both;}
.lc-inp-col>.lc-gc:nth-child(2){animation:lcCardIn .5s .13s both;}
.lc-inp-col>.lc-gc:nth-child(3){animation:lcCardIn .5s .21s both;}
/* ── Ring arc draw ── */
@keyframes lcRingDraw{from{stroke-dasharray:0 999;}to{stroke-dasharray:var(--fill) 999;}}
.lc-ring-arc{animation:lcRingDraw .8s cubic-bezier(.4,0,.2,1) both;}
/* ── Value flash ── */
@keyframes lcValFlash{from{opacity:.4;transform:scale(.96);}to{opacity:1;transform:scale(1);}}
.lc-val-flash{display:inline-block;animation:lcValFlash .35s cubic-bezier(.4,0,.2,1) both;}
/* ── Amortization chart ── */
.lc-amort{padding:1.2rem 1.5rem;}
.lc-amort-eyebrow{font-size:.55rem;letter-spacing:.18em;text-transform:uppercase;color:rgba(0,212,255,.65);display:flex;justify-content:space-between;align-items:center;margin-bottom:.65rem;}
.lc-amort-svg-wrap{width:100%;border-radius:8px;overflow:hidden;background:rgba(0,0,0,.18);}
.lc-amort-axis{display:flex;justify-content:space-between;font-size:.57rem;color:rgba(255,255,255,.22);margin-top:.35rem;}
@keyframes lcAmortDraw{to{stroke-dashoffset:0;}}
.lc-amort-line{stroke-dasharray:2000;stroke-dashoffset:2000;animation:lcAmortDraw 1.2s cubic-bezier(.4,0,.2,1) .2s both;}
/* ── Cost composition bar ── */
.lc-cbar{padding:1rem 1.5rem 1.1rem;}
.lc-cbar-title{font-size:.55rem;letter-spacing:.16em;text-transform:uppercase;color:rgba(255,255,255,.28);margin-bottom:.5rem;}
.lc-cbar-track{height:11px;border-radius:999px;overflow:hidden;display:flex;gap:2px;background:rgba(255,255,255,.04);}
.lc-cbar-seg{height:100%;transition:flex .55s cubic-bezier(.4,0,.2,1);}
.lc-cbar-legs{display:flex;flex-wrap:wrap;gap:.32rem .85rem;margin-top:.55rem;}
.lc-cbar-leg{display:flex;align-items:center;gap:.28rem;font-size:.6rem;color:rgba(255,255,255,.38);}
.lc-cbar-dot{width:7px;height:7px;border-radius:2px;flex-shrink:0;}

/* ═══ DETAIL PAGE (replaces overlay modal) ═══ */
/* ════════════════════════════════════════════
   DETAIL PAGE — MOBILE (full-page scroll)
════════════════════════════════════════════ */
.det-pg{display:flex;flex-direction:column;min-height:100vh;background:var(--bg);}
.det-pg-inner{width:100%;flex:1;display:flex;flex-direction:column;min-height:0;}

/* Back button — floating icon on image */
.det-back-btn{position:absolute;top:1rem;left:1rem;z-index:20;width:40px;height:40px;background:rgba(0,0,0,.45);border:none;color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;backdrop-filter:blur(6px);transition:background .18s,transform .18s;font-size:1.2rem;padding:0;line-height:1;}
.det-back-btn:hover{background:rgba(0,0,0,.75);transform:scale(1.08);}

/* ─── Shared base styles (mobile-first) ─── */
.det{background:var(--parchment);width:100%;flex:1;position:relative;display:flex;flex-direction:column;}
@keyframes slideUp{from{opacity:0;transform:translateY(18px);}to{opacity:1;transform:translateY(0);}}

/* Hero — mobile */
.det-hero{position:relative;height:360px;overflow:hidden;flex-shrink:0;}
.det-hero img{width:100%;height:100%;object-fit:cover;}
.det-hero-ov{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.72) 0%,rgba(0,0,0,.1) 55%,transparent 100%);}
.det-hc{position:absolute;bottom:1.8rem;left:2.2rem;right:2.2rem;}
.det-tag-pill{display:inline-block;font-size:.62rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#fff;padding:.22rem .65rem;margin-bottom:.6rem;}
.det-title{font-family:var(--serif);font-size:2.2rem;font-weight:600;color:#fff;line-height:1.1;margin-bottom:.35rem;}
.det-dv{color:rgba(255,255,255,.6);font-size:.84rem;display:flex;align-items:center;gap:.5rem;}
.det-close{display:none;}

/* Gallery strip */
.gal-strip{display:flex;gap:.3rem;padding:.3rem;background:var(--ink);flex-shrink:0;}
.gal-t{flex:1;height:72px;overflow:hidden;cursor:pointer;opacity:.6;transition:opacity .18s;}
.gal-t:hover,.gal-t.on{opacity:1;}
.gal-t.on{outline:2px solid var(--gold);outline-offset:-2px;}
.gal-t img{width:100%;height:100%;object-fit:cover;}

/* Tabs */
.det-tabs{display:flex;background:#0D0D18;border-bottom:1px solid #0D0D18;flex-shrink:0;position:relative;z-index:5;box-shadow:0 2px 8px rgba(0,0,0,.15);}
.det-tab{flex:1;padding:.85rem 1rem;background:transparent;border:none;border-bottom:2px solid transparent;color:#D4B880;font-family:var(--sans);font-size:.76rem;letter-spacing:.07em;text-transform:uppercase;cursor:pointer;transition:color .18s,border-color .18s;text-align:center;}
.det-tab:hover{color:#D4B880;}
.det-tab.on{color:var(--gold);border-bottom-color:var(--gold);}

/* Content scroll area — mobile */
.det-content{flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;scroll-behavior:smooth;min-height:0;}

/* Split container */
.det-split{display:flex;flex-direction:column;flex:1;min-height:0;}
.det-left{flex-shrink:0;position:relative;}
.det-right{display:flex;flex-direction:column;flex:1;min-height:0;}
.det-right-hd{display:none;}

/* Hero nav arrows — shown on mobile, hidden on desktop */
.det-hero-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:8;width:40px;height:40px;border-radius:50%;background:rgba(0,0,0,.5);border:none;color:#fff;font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:background .18s;}
.det-hero-nav:hover{background:rgba(0,0,0,.75);}
.det-hero-nav.prev{left:.75rem;}
.det-hero-nav.next{right:.75rem;}
.det-hero-dots{position:absolute;bottom:.6rem;left:50%;transform:translateX(-50%);z-index:8;display:flex;gap:.4rem;}
.det-hero-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.4);border:none;padding:0;cursor:pointer;transition:background .18s,transform .18s;}
.det-hero-dot.on{background:#fff;transform:scale(1.3);}

@media(min-width:1024px){.det-hero-nav,.det-hero-dots{display:none !important;}}
@media(max-width:1023px){.gal-strip{display:none !important;}}

/* ─── Base content styles — declared BEFORE desktop overrides so media query wins cascade ─── */
.ov-body{padding:2rem 2.2rem;}
.spec-grid{display:grid;grid-template-columns:1fr;gap:1.5rem;margin-bottom:2rem;}
.spec-section{background:var(--card);border:1px solid var(--border);overflow:hidden;}
.spec-sec-hd{display:flex;align-items:center;gap:.55rem;padding:.65rem 1rem;background:var(--ink);font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);font-weight:700;}
.spec-sec-hd span{font-size:.95rem;}
.spec-row{display:flex;padding:.58rem 1rem;border-bottom:1px solid var(--border);gap:.5rem;}
.spec-row:last-child{border-bottom:none;}
.spec-key{font-size:.72rem;color:var(--muted);min-width:140px;flex-shrink:0;padding-top:.1rem;}
.spec-val{font-size:.78rem;color:var(--ink);font-weight:500;flex:1;line-height:1.5;}
.spec-section.full{grid-column:1/-1;}
.ov-desc-row{display:grid;grid-template-columns:1fr;gap:1.5rem;margin-bottom:2rem;}
.ov-desc-row .spec-section{margin:0;}
.hi-list{padding:.6rem 1rem;}
.hi-item{display:flex;align-items:flex-start;gap:.6rem;padding:.4rem 0;border-bottom:1px solid var(--border);font-size:.78rem;color:var(--ink);}
.hi-item:last-child{border-bottom:none;}
.hi-dot{width:6px;height:6px;background:var(--gold);flex-shrink:0;margin-top:.4rem;}
.det-desc-p{padding:1rem;font-size:.84rem;line-height:1.75;color:var(--muted);}
.fac-chips{padding:.75rem 1rem;display:flex;flex-wrap:wrap;gap:.4rem;}
.fac-chip{background:var(--warm);border:1px solid var(--border);font-size:.72rem;padding:.28rem .65rem;color:var(--ink);}
.price-bar{background:var(--ink);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem;padding:1.3rem 2.2rem;}
.det-sticky-bar{margin-top:0;}
.pb-left .pb-lbl{font-size:.62rem;letter-spacing:.12em;text-transform:uppercase;color:#D4B880;margin-bottom:.18rem;}
.pb-price{font-family:var(--serif);font-size:1.8rem;color:var(--gold);}
.pb-price span{font-size:.9rem;color:#D4B880;font-weight:300;}
.pb-btns{display:flex;gap:.65rem;}
.pb-btn1{background:var(--gold);color:var(--ink);border:none;padding:.65rem 1.5rem;font-family:var(--sans);font-size:.78rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;}
.pb-btn1:hover{opacity:.88;transform:translateY(-1px);box-shadow:0 4px 12px rgba(191,155,78,.3);}
.pb-btn2{background:transparent;color:var(--card);border:1px solid rgba(255,255,255,.4);padding:.65rem 1.5rem;font-family:var(--sans);font-size:.78rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;}
.pb-btn2:hover{border-color:var(--gold);color:var(--gold);background:rgba(191,155,78,.1);}
.loc-body{padding:2rem 2.2rem;}
.map-embed{width:100%;height:300px;border:1px solid var(--border);background:#FAF8F3;margin-bottom:1.8rem;overflow:hidden;}
.map-embed iframe{width:100%;height:100%;border:none;display:block;}
.map-placeholder{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--warm);color:var(--muted);gap:.5rem;font-size:.84rem;}
.amenities-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1.2rem;}
.amenity-cat{background:var(--card);border:1px solid var(--border);overflow:hidden;}
.amenity-hd{display:flex;align-items:center;gap:.5rem;padding:.6rem .9rem;background:var(--warm);border-bottom:1px solid var(--border);font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:var(--ink);font-weight:700;}
.amenity-item{padding:.5rem .9rem;font-size:.78rem;color:var(--ink);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.55rem;}
.amenity-item:last-child{border-bottom:none;}
.amenity-dot{width:5px;height:5px;background:var(--gold);flex-shrink:0;}
.layouts-body{padding:2rem 2.2rem;}
.layouts-intro{font-size:.65rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);font-weight:700;margin-bottom:1.4rem;}

/* ════════════════════════════════════════════
   DETAIL PAGE — DESKTOP (viewport-locked)
   Full 100vh, no outer scroll, 3-zone right
════════════════════════════════════════════ */
@media(min-width:1024px){

  /* 1. Lock the page to 100vh — no outer scroll */
  body:has(.det-pg){overflow:hidden;}
  .det-pg{
    height:100vh;
    max-height:100vh;
    overflow:hidden;
  }
  .det-pg-inner{
    height:100%;
    max-height:100%;
    overflow:hidden;
  }

  /* 2. Inner shell fills the page */
  .det{
    height:100%;
    max-height:100%;
    overflow:hidden;
  }

  /* 3. Horizontal split — fills 100% height */
  .det-split{
    flex-direction:row;
    height:100%;
    max-height:100%;
    overflow:hidden;
    flex:1;
  }

  /* ── LEFT: image column ── */
  .det-left{
    width:45%;
    min-width:380px;
    max-width:540px;
    height:100%;
    flex-shrink:0;
    display:flex;
    flex-direction:column;
    overflow:hidden;
    position:relative;
  }
  /* Hero fills the entire left column */
  .det-left .det-hero{
    flex:1;
    height:100%;
    min-height:0;
    position:relative;
    overflow:hidden;
  }
  .det-left .det-hero img{
    width:100%;
    height:100%;
    object-fit:cover;
    display:block;
  }
  .det-left .det-hero-ov{
    background:linear-gradient(to top,rgba(0,0,0,.82) 0%,rgba(0,0,0,.1) 40%,transparent 100%);
  }
  .det-left .det-hc{left:1.8rem;right:1.8rem;bottom:1.5rem;}
  .det-left .det-title{font-size:1.75rem;}
  /* Gallery strip pinned at bottom of left col */
  .det-left .gal-strip{flex-shrink:0;}

  /* ── RIGHT: 3-zone flex column ── */
  .det-right{
    flex:1;
    height:100%;
    display:flex;
    flex-direction:column;
    overflow:hidden;       /* clip children — only .det-content scrolls */
    border-left:1px solid var(--border);
  }

  /* ZONE 1 — Tabs (fixed height, never scrolls) */
  .det-tabs{
    flex-shrink:0;
    height:52px;
    z-index:10;
    box-shadow:0 2px 12px rgba(0,0,0,.18);
  }
  .det-tab{padding:.7rem 1rem;}

  /* ZONE 2 — Scrollable content (flex:1 = takes remaining space) */
  .det-content{
    flex:1;
    min-height:0;          /* ← prevents overflow escape */
    overflow-y:auto;
    overflow-x:hidden;
    scroll-behavior:smooth;
    -webkit-overflow-scrolling:touch;
    padding-bottom:1rem;   /* breathing room above CTA */
    /* Subtle custom scrollbar */
    scrollbar-width:thin;
    scrollbar-color:rgba(13,13,24,.3) transparent;
  }
  .det-content::-webkit-scrollbar{width:5px;}
  .det-content::-webkit-scrollbar-track{background:transparent;}
  .det-content::-webkit-scrollbar-thumb{background:rgba(13,13,24,.3);border-radius:3px;}
  .det-content::-webkit-scrollbar-thumb:hover{background:rgba(13,13,24,.5);}

  /* ZONE 3 — Bottom CTA bar (fixed height, always visible) */
  .det-sticky-bar{
    flex-shrink:0;
    position:relative;     /* relative so ::before gradient works */
    z-index:10;
    border-top:1px solid var(--border);
    box-shadow:0 -6px 20px rgba(0,0,0,.1);
  }
  /* Gradient fade above CTA to signal more content below */
  .det-sticky-bar::before{
    content:'';
    position:absolute;
    top:-24px;
    left:0;
    right:0;
    height:24px;
    background:linear-gradient(to top,rgba(245,247,255,.95),transparent);
    pointer-events:none;
    z-index:1;
  }

  /* Compact the ov-body padding on desktop to reclaim vertical space */
  .ov-body{padding:1.4rem 1.8rem;}
  .spec-grid{gap:1rem;margin-bottom:1.4rem;}
  .ov-desc-row{gap:1rem;margin-bottom:1.4rem;}
  .spec-row{padding:.45rem .9rem;}
  .hi-item{padding:.3rem 0;}
  .loc-body{padding:1.4rem 1.8rem;}
  .layouts-body{padding:1.4rem 1.8rem;}
  .map-embed{height:240px;margin-bottom:1.2rem;}

  .det-right-hd{display:none;}
  .det-close{display:none;}
}

/* ════════════════════════════════════════════
   DETAIL PAGE — UI ENHANCEMENTS (v2)
   Modern polish for both mobile & desktop
════════════════════════════════════════════ */

/* ── Hero polish ── */
.det-hero{background:#0D0D18;}
.det-hero img{transition:transform 8s ease-out;}
.det-hero:hover img{transform:scale(1.04);}
.det-hero-ov{background:linear-gradient(180deg,rgba(0,0,0,.15) 0%,rgba(0,0,0,.05) 35%,rgba(7,9,15,.55) 70%,rgba(7,9,15,.92) 100%);}
.det-hc{display:flex;flex-direction:column;gap:.55rem;}
.det-tag-pill{align-self:flex-start;border-radius:999px;backdrop-filter:blur(6px);box-shadow:0 4px 14px rgba(0,0,0,.25);font-weight:800;}
.det-title{text-shadow:0 2px 24px rgba(0,0,0,.45);letter-spacing:-.01em;}
.det-title em{font-style:italic;color:var(--gold);}
.det-dv{flex-wrap:wrap;color:rgba(255,255,255,.85);font-size:.85rem;}
.det-dv svg{color:var(--gold);}

/* Hero meta chips — quick facts row */
.det-hero-meta{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.85rem;}
.det-meta-chip{
  display:inline-flex;align-items:center;gap:.35rem;
  background:rgba(255,255,255,.12);
  border:1px solid rgba(255,255,255,.2);
  color:#fff;font-size:.72rem;font-weight:600;
  padding:.32rem .7rem;border-radius:999px;
  backdrop-filter:blur(8px);
  letter-spacing:.02em;
  transition:all .18s ease;
}
.det-meta-chip:hover{background:rgba(255,255,255,.2);border-color:rgba(255,255,255,.35);}
.det-meta-chip.primary{
  background:linear-gradient(135deg,rgba(13,13,24,.85),rgba(109,100,240,.85));
  border-color:rgba(255,255,255,.3);
  color:#fff;font-weight:700;
  box-shadow:0 4px 14px rgba(13,13,24,.4);
}

/* Glassy back button */
.det-back-btn{background:rgba(7,9,15,.5) !important;border:1px solid rgba(255,255,255,.18) !important;box-shadow:0 6px 20px rgba(0,0,0,.25);}
.det-back-btn:hover{background:rgba(7,9,15,.82) !important;border-color:var(--gold) !important;color:var(--gold) !important;}

/* Hero nav arrows — modern glass */
.det-hero-nav{background:rgba(255,255,255,.12) !important;border:1px solid rgba(255,255,255,.2) !important;backdrop-filter:blur(10px);box-shadow:0 4px 14px rgba(0,0,0,.2);transition:all .2s ease;}
.det-hero-nav:hover{background:rgba(255,255,255,.25) !important;transform:translateY(-50%) scale(1.08);}
.det-hero-dots{padding:.3rem .6rem;background:rgba(0,0,0,.35);border-radius:999px;backdrop-filter:blur(6px);}
.det-hero-dot{transition:all .25s ease;}
.det-hero-dot.on{width:18px;border-radius:4px;}

/* Gallery strip — refined */
.gal-strip{background:linear-gradient(180deg,#0D0D18,#0D0D18);padding:.45rem;gap:.45rem;}
.gal-t{height:64px;border-radius:4px;transition:all .2s ease;}
.gal-t:hover{transform:translateY(-2px);}
.gal-t.on{outline:2px solid var(--gold);outline-offset:0;box-shadow:0 4px 12px rgba(13,13,24,.4);}

/* ── Tabs — modern pill style ── */
.det-tabs{background:linear-gradient(180deg,#0D0D18,#0D0D18);gap:.15rem;padding:0 .5rem;}
.det-tab{position:relative;border-bottom:none;font-weight:600;color:rgba(255,255,255,.55);transition:all .2s ease;}
.det-tab:hover{color:rgba(255,255,255,.9);background:rgba(255,255,255,.05);}
.det-tab.on{color:var(--gold);background:rgba(13,13,24,.12);}
.det-tab.on::after{content:'';position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:32px;height:3px;background:var(--gold);border-radius:3px 3px 0 0;box-shadow:0 0 12px rgba(13,13,24,.6);}

/* ── Section cards (spec / amenity / unit) — unified card system ── */
.spec-section,.amenity-cat,.layouts-upgrades{
  border-radius:8px;
  border:1px solid var(--border);
  transition:transform .25s ease,box-shadow .25s ease,border-color .25s ease;
  position:relative;
}
.spec-section:hover,.amenity-cat:hover,.layouts-upgrades:hover{
  transform:translateY(-2px);
  box-shadow:0 12px 32px -12px rgba(20,40,60,.18);
  border-color:rgba(13,13,24,.35);
}

/* Section headers — refined */
.spec-sec-hd,.amenity-hd,.lu-hd{
  background:linear-gradient(180deg,#0D0D18,#0D0D18);
  border-bottom:1px solid rgba(13,13,24,.2);
  padding:.7rem 1rem;
  color:var(--gold);
  font-size:.62rem;
  letter-spacing:.16em;
  position:relative;
}
.spec-sec-hd span,.lu-hd span{
  display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;
  background:rgba(13,13,24,.15);
  border-radius:6px;
  font-size:.85rem;
  margin-right:.1rem;
}
.amenity-hd{background:linear-gradient(180deg,var(--warm),#FAF8F3);color:var(--ink);border-bottom:1px solid rgba(13,13,24,.12);}
.amenity-hd span{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;background:rgba(13,13,24,.12);border-radius:6px;font-size:.85rem;}

/* Spec rows — refined hover */
.spec-row{transition:background .15s ease;}
.spec-row:hover{background:rgba(13,13,24,.04);}
.spec-key{font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:.66rem;color:var(--muted);}
.spec-val{font-weight:500;color:var(--ink);}

/* Highlights list — modern */
.hi-list{padding:.5rem 0;}
.hi-item{padding:.55rem 1rem;border-bottom:1px solid rgba(0,0,0,.04);transition:background .15s ease,padding-left .2s ease;font-size:.8rem;}
.hi-item:hover{background:rgba(13,13,24,.06);padding-left:1.3rem;}
.hi-dot{width:8px;height:8px;background:linear-gradient(135deg,var(--gold),var(--gold-l));border-radius:50%;box-shadow:0 0 0 3px rgba(13,13,24,.12);margin-top:.35rem;}

/* Description — quote-card feel */
.det-desc-p{padding:1.1rem 1.2rem;font-size:.88rem;line-height:1.75;color:var(--ink);background:linear-gradient(180deg,#fff,var(--parchment));position:relative;}
.det-desc-p::before{content:'\\201C';position:absolute;top:.2rem;left:.4rem;font-family:var(--serif);font-size:2.5rem;color:var(--gold);opacity:.18;line-height:1;}

/* Facility chips — refined pills */
.fac-chips{padding:1rem 1rem;gap:.5rem;background:linear-gradient(180deg,#fff,var(--parchment));}
.fac-chip{
  background:#fff;border:1px solid var(--border);border-radius:999px;
  font-size:.74rem;padding:.4rem .9rem;font-weight:500;
  transition:all .18s ease;cursor:default;
  display:inline-flex;align-items:center;gap:.4rem;
}
.fac-chip::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--gold);}
.fac-chip:hover{background:var(--ink);color:#fff;border-color:var(--ink);transform:translateY(-1px);box-shadow:0 4px 12px rgba(20,40,60,.15);}
.fac-chip:hover::before{background:var(--gold);}

/* Amenity items */
.amenity-item{padding:.6rem 1rem;font-size:.78rem;transition:background .15s ease,padding-left .2s ease;}
.amenity-item:hover{background:rgba(13,13,24,.05);padding-left:1.3rem;}
.amenity-dot{width:6px;height:6px;background:linear-gradient(135deg,var(--gold),var(--gold-l));border-radius:50%;}

/* Map embed — softer */
.map-embed{border-radius:8px;border:1px solid var(--border);box-shadow:0 8px 24px -10px rgba(20,40,60,.15);}

/* ── Sticky price bar — premium feel ── */
.price-bar{
  background:linear-gradient(135deg,#0D0D18 0%,#0D0D18 100%);
  padding:1.2rem 2.2rem;
  border-top:1px solid rgba(13,13,24,.25);
  position:relative;
}
.price-bar::after{
  content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,var(--gold),transparent);
  opacity:.35;
}
.pb-left .pb-lbl{color:rgba(255,255,255,.55);font-weight:600;}
.pb-price{font-size:1.95rem;letter-spacing:-.01em;text-shadow:0 1px 8px rgba(13,13,24,.2);}
.pb-btn1{
  background:linear-gradient(135deg,var(--gold-l),var(--gold));
  color:var(--ink);
  border-radius:6px;font-weight:700;
  box-shadow:0 6px 18px -4px rgba(191,155,78,.4),inset 0 1px 0 rgba(255,255,255,.3);
  transition:all .2s ease;letter-spacing:.08em;
  padding:.75rem 1.7rem;
}
.pb-btn1:hover{transform:translateY(-2px);box-shadow:0 10px 24px -6px rgba(191,155,78,.55),inset 0 1px 0 rgba(255,255,255,.4);opacity:1;}
.pb-btn2{
  border-radius:6px;border:1.5px solid rgba(255,255,255,.3);font-weight:600;
  color:var(--card);
  transition:all .2s ease;letter-spacing:.08em;
  padding:.75rem 1.5rem;
}
.pb-btn2:hover{background:rgba(255,255,255,.06);border-color:var(--gold);color:var(--gold);transform:translateY(-2px);}

/* ── Unit type cards — image overlay & polish ── */
.ut-card{border-radius:10px;border:1px solid var(--border);box-shadow:0 4px 14px -8px rgba(20,40,60,.12);transition:all .3s ease;}
.ut-card:hover{transform:translateY(-3px);box-shadow:0 18px 40px -16px rgba(20,40,60,.25);border-color:rgba(13,13,24,.35);}
.ut-img-panel{position:relative;}
.ut-img-panel::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,transparent 60%,rgba(0,0,0,.35));pointer-events:none;}
.ut-img-label{
  border-radius:6px;
  background:linear-gradient(135deg,#0D0D18,#0D0D18);
  box-shadow:0 4px 12px rgba(0,0,0,.25);
  letter-spacing:.14em;
  z-index:1;
}
.ut-label-badge{display:inline-block;background:rgba(13,13,24,.12);color:var(--gold);padding:.22rem .65rem;border-radius:999px;font-weight:700;}
.ut-name{letter-spacing:-.01em;}
.ut-price-badge{
  background:linear-gradient(135deg,var(--ink),#0D0D18);
  border-radius:6px;font-weight:600;
  box-shadow:0 4px 12px rgba(20,40,60,.2);
}
.ut-stat{
  border-radius:999px;background:#fff;border:1px solid var(--border);
  padding:.4rem .85rem;font-weight:500;font-size:.76rem;
  transition:all .18s ease;
}
.ut-stat:hover{border-color:var(--gold);background:var(--warm);}
.ut-desc{border-radius:0 6px 6px 0;font-style:italic;}
.layouts-intro{display:inline-flex;align-items:center;gap:.5rem;padding:.5rem .9rem;background:rgba(13,13,24,.1);border-radius:999px;}

/* ════════════════════════════════════════════
   MOBILE ENHANCEMENTS (≤ 768px)
════════════════════════════════════════════ */
@media(max-width:768px){
  .det-hero{height:42vh;max-height:340px;min-height:240px;}
  .det-title{font-size:1.55rem;line-height:1.15;}
  .det-dv{font-size:.78rem;}
  .det-back-btn{width:36px;height:36px;font-size:1rem;top:.75rem;left:.75rem;}
  .det-hero-nav{width:34px;height:34px;font-size:.95rem;}
  .det-hero-dots{bottom:.85rem;}
  .det-tab{padding:.85rem .9rem;font-size:.7rem;letter-spacing:.05em;font-weight:700;min-width:max-content;}
  .det-tab.on::after{width:24px;height:2.5px;}
  .det-hero-meta{gap:.3rem;margin-top:.6rem;}
  .det-meta-chip{font-size:.66rem;padding:.25rem .55rem;}
  .ov-body,.loc-body,.layouts-body{padding:1.1rem .9rem;}
  .spec-grid{gap:.85rem;margin-bottom:1.1rem;}
  .spec-sec-hd,.amenity-hd,.lu-hd{padding:.6rem .85rem;}
  .spec-row{padding:.55rem .85rem;}
  .spec-key{min-width:108px;}
  .det-desc-p{padding:.95rem 1rem;font-size:.84rem;}
  .det-desc-p::before{font-size:2rem;top:.1rem;left:.3rem;}
  .map-embed{height:200px;}
  /* Sticky price bar — mobile reflow */
  .price-bar{padding:.85rem 1rem;flex-direction:column;align-items:stretch;gap:.65rem;}
  .pb-left{display:flex;align-items:baseline;justify-content:space-between;gap:.5rem;}
  .pb-left .pb-lbl{font-size:.6rem;margin-bottom:0;}
  .pb-price{font-size:1.4rem;}
  .pb-btns{flex-direction:row;gap:.5rem;}
  .pb-btn1,.pb-btn2{flex:1;width:auto;padding:.7rem .5rem;font-size:.74rem;border-radius:6px;}
  /* Sticky CTA on mobile — hover above content */
  .det-sticky-bar{position:sticky;bottom:0;z-index:8;box-shadow:0 -8px 24px rgba(0,0,0,.18);}
  .ut-img-panel{min-height:200px;}
  .ut-info-panel{padding:1.1rem 1rem;}
  .ut-name{font-size:1.25rem;}
  .ut-price-badge{font-size:1rem;}
  .gal-strip{display:none;}
}

@media(max-width:480px){
  .det-hero{height:36vh;max-height:280px;min-height:200px;}
  .det-title{font-size:1.3rem;}
  .det-tag-pill{font-size:.58rem;padding:.18rem .55rem;}
  .det-dv{font-size:.74rem;gap:.35rem;}
  .det-tab{padding:.75rem .8rem;font-size:.66rem;}
  .det-meta-chip{font-size:.62rem;padding:.22rem .5rem;}
  .det-hero-meta{margin-top:.5rem;gap:.25rem;}
  .ov-body,.loc-body,.layouts-body{padding:1rem .75rem;}
  .spec-key{min-width:95px;font-size:.62rem;}
  .spec-val{font-size:.78rem;}
  .pb-price{font-size:1.25rem;}
  .pb-btn1,.pb-btn2{padding:.65rem .4rem;font-size:.7rem;min-height:42px;}
  .det-back-btn{width:34px;height:34px;font-size:.95rem;}
  .ut-stat{padding:.32rem .7rem;font-size:.72rem;}
  .fac-chip{font-size:.7rem;padding:.32rem .75rem;}
}

/* ════════════════════════════════════════════
   DESKTOP ENHANCEMENTS (≥ 1024px)
════════════════════════════════════════════ */
@media(min-width:1024px){
  .det-left{box-shadow:inset -1px 0 0 rgba(0,0,0,.05);}
  .det-left .det-hc{bottom:1.8rem;}
  .det-left .det-title{font-size:1.85rem;letter-spacing:-.015em;}
  .det-tabs{padding:0 .75rem;}
  .det-tab{font-weight:600;letter-spacing:.05em;}
  /* Two-column spec grid on desktop for better density */
  .spec-grid{grid-template-columns:repeat(2,1fr);gap:1rem;}
  .spec-section.full{grid-column:1/-1;}
  .ov-desc-row{grid-template-columns:1.3fr 1fr;}
  .price-bar{padding:1.1rem 1.8rem;}
  .pb-price{font-size:1.85rem;}
  .ut-card{grid-template-columns:340px 1fr;}
}

/* ═══ LAYOUTS TAB — redesigned ═══ */

/* Each unit type is a full horizontal card: image left, info right */
.ut-card{background:var(--card);border:1px solid var(--border);display:grid;grid-template-columns:320px 1fr;overflow:hidden;margin-bottom:1.4rem;transition:box-shadow .25s;max-width:100%;}
.ut-card:hover{box-shadow:0 8px 32px rgba(0,0,0,.1);}
.ut-card:last-child{margin-bottom:0;}

/* image panel */
.ut-img-panel{position:relative;overflow:hidden;min-height:220px;}
.ut-img-panel img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .5s;}
.ut-card:hover .ut-img-panel img{transform:scale(1.04);}
.ut-img-label{position:absolute;top:.8rem;left:.8rem;background:var(--ink);color:var(--gold);font-size:.62rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:.22rem .6rem;}

/* info panel */
.ut-info-panel{padding:1.6rem 2rem;display:flex;flex-direction:column;justify-content:space-between;gap:1rem;}
.ut-header{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap;}
.ut-name-group{}
.ut-label-badge{font-size:.62rem;letter-spacing:.1em;text-transform:uppercase;color:var(--gold);font-weight:600;margin-bottom:.3rem;}
.ut-name{font-family:var(--serif);font-size:1.5rem;font-weight:600;color:var(--ink);line-height:1.15;}
.ut-price-badge{background:var(--ink);color:var(--gold);font-family:var(--serif);font-size:1.1rem;padding:.3rem .9rem;white-space:nowrap;align-self:flex-start;}

/* stat chips row */
.ut-stats{display:flex;gap:.5rem;flex-wrap:wrap;}
.ut-stat{display:flex;align-items:center;gap:.4rem;background:var(--warm);border:1px solid var(--border);padding:.35rem .75rem;font-size:.75rem;color:var(--ink);}
.ut-stat svg{color:var(--muted);}

/* description */
.ut-desc{font-size:.82rem;line-height:1.7;color:var(--muted);padding:.75rem 1rem;background:var(--warm);border-left:3px solid var(--gold);}

/* divider + upgrades */
.layouts-upgrades{margin-top:2rem;background:var(--card);border:1px solid var(--border);}
.lu-hd{display:flex;align-items:center;gap:.55rem;padding:.65rem 1rem;background:var(--ink);font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);font-weight:700;}
.lu-hd span{font-size:.9rem;}
.lu-body{padding:1rem;font-size:.82rem;line-height:1.7;color:var(--muted);}

/* empty state */
.ut-empty{text-align:center;padding:4rem 2rem;color:var(--muted);}
.ut-empty span{font-size:2rem;display:block;margin-bottom:.5rem;opacity:.3;}

/* ADMIN */
/* ── Register Interest / Visit Showroom Modal ── */
@keyframes riBoxIn{from{opacity:0;transform:translateY(22px) scale(.965)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes riSuccessIco{0%{transform:scale(0) rotate(-20deg)}65%{transform:scale(1.28) rotate(5deg)}100%{transform:scale(1) rotate(0)}}
@keyframes riFieldIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes riHdGlow{0%,100%{box-shadow:0 0 0 rgba(193,126,135,0)}50%{box-shadow:0 4px 32px rgba(193,126,135,.18)}}
.ri-ov{position:fixed;inset:0;z-index:500;background:rgba(4,4,14,.72);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:1.5rem;animation:fadeIn .22s ease;}
.ri-box{background:#fff;width:100%;max-width:460px;max-height:88vh;box-shadow:0 32px 80px rgba(15,42,69,.28),0 0 0 1px rgba(193,126,135,.15);animation:riBoxIn .34s cubic-bezier(.22,1,.36,1);overflow:hidden;display:flex;flex-direction:column;border-radius:20px;}
.ri-hd{flex-shrink:0;background:linear-gradient(135deg,#1E0B10 0%,#2D1420 55%,#1A0810 100%);padding:1.5rem 1.6rem;display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;position:relative;overflow:hidden;}
.ri-hd::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,rgba(193,126,135,.55),#C17E87,rgba(193,126,135,.55),transparent);}
.ri-hd-left{position:relative;z-index:1;}
.ri-hd-eyebrow{font-size:.6rem;letter-spacing:.18em;text-transform:uppercase;color:#D4A4AC;font-weight:600;margin-bottom:.35rem;}
.ri-hd-title{font-family:var(--serif);font-size:1.45rem;font-weight:600;color:#fff;line-height:1.15;}
.ri-hd-proj{font-size:.76rem;color:rgba(255,255,255,.5);margin-top:.3rem;}
.ri-x{position:relative;z-index:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.65);width:32px;height:32px;cursor:pointer;font-size:.85rem;display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:8px;transition:all .2s;}
.ri-x:hover{background:rgba(255,255,255,.18);border-color:rgba(255,255,255,.28);color:#fff;transform:scale(1.08);}
.ri-options{flex-shrink:0;display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #F0D0D4;}
.ri-opt-btn{padding:.9rem;font-family:var(--sans);font-size:.8rem;font-weight:600;letter-spacing:.03em;cursor:pointer;border:none;border-bottom:2.5px solid transparent;transition:all .2s;background:#FAF8F3;color:#A07880;}
.ri-opt-btn.on{background:#fff;color:#2D0E14;border-bottom-color:#C17E87;font-weight:700;}
.ri-opt-btn:hover:not(.on){background:#FFF5F6;color:#7A2238;}
.ri-body{padding:1.4rem 1.6rem;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0;background:#fff;}
.ri-field{margin-bottom:.9rem;animation:riFieldIn .3s ease both;}
.ri-field:nth-child(1){animation-delay:.04s}.ri-field:nth-child(2){animation-delay:.08s}.ri-field:nth-child(3){animation-delay:.12s}.ri-field:nth-child(4){animation-delay:.16s}.ri-field:nth-child(5){animation-delay:.2s}.ri-field:nth-child(6){animation-delay:.24s}.ri-field:nth-child(7){animation-delay:.28s}
.ri-label{display:block;font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;color:#A07880;font-weight:700;margin-bottom:.38rem;}
.ri-inp{width:100%;padding:.68rem .95rem;border:1.5px solid #F0D0D4;background:#FFF5F6;color:#2D0E14;font-family:var(--sans);font-size:.88rem;outline:none;border-radius:8px;transition:border-color .2s,background .2s,box-shadow .2s;}
.ri-inp:focus{border-color:#C17E87;background:#fff;box-shadow:0 0 0 3px rgba(193,126,135,.14);}
.ri-inp::placeholder{color:#C4A0A8;}
.ri-submit{width:100%;background:linear-gradient(135deg,#2D0E14 0%,#5C1828 50%,#2D0E14 100%);background-size:200% auto;color:#fff;border:none;padding:.9rem;font-family:var(--sans);font-size:.86rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;border-radius:10px;transition:transform .2s,box-shadow .2s,background-position .5s;margin-top:.5rem;box-shadow:0 4px 18px rgba(45,14,20,.25);}
.ri-submit:hover:not(:disabled){background-position:right center;transform:translateY(-2px);box-shadow:0 8px 28px rgba(45,14,20,.32);}
.ri-submit:active:not(:disabled){transform:translateY(0);box-shadow:0 2px 10px rgba(45,14,20,.2);}
.ri-submit:disabled{opacity:.45;cursor:not-allowed;}
.ri-wa-body{padding:1.6rem 1.8rem;text-align:center;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0;background:#fff;}
.ri-wa-icon{font-size:3.2rem;margin-bottom:.85rem;display:block;animation:riSuccessIco .5s cubic-bezier(.34,1.56,.64,1) both .1s;}
.ri-wa-title{font-family:var(--serif);font-size:1.35rem;color:#2D0E14;margin-bottom:.5rem;font-weight:600;}
.ri-wa-sub{font-size:.83rem;color:#A07880;line-height:1.65;margin-bottom:1.5rem;}
.ri-wa-btn{display:inline-flex;align-items:center;gap:.6rem;background:linear-gradient(135deg,#25D366,#128C7E);color:#fff;border:none;padding:.88rem 2.2rem;font-family:var(--sans);font-size:.88rem;font-weight:700;letter-spacing:.04em;cursor:pointer;transition:all .22s;border-radius:999px;box-shadow:0 4px 18px rgba(37,211,102,.28);}
.ri-wa-btn:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(37,211,102,.4);}
.ri-wa-btn svg{flex-shrink:0;}
.ri-success{padding:2.2rem 1.8rem;text-align:center;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0;background:#fff;}
.ri-success-ico{font-size:2.8rem;margin-bottom:.85rem;display:block;animation:riSuccessIco .5s cubic-bezier(.34,1.56,.64,1) both .1s;}
.ri-success-title{font-family:var(--serif);font-size:1.5rem;color:#2D0E14;margin-bottom:.4rem;font-weight:600;}
.ri-success-sub{font-size:.83rem;color:#A07880;line-height:1.65;}
.ri-divider{display:flex;align-items:center;gap:.75rem;margin:.5rem 0 1rem;font-size:.72rem;color:#C4A0A8;}
.ri-divider::before,.ri-divider::after{content:'';flex:1;height:1px;background:#F0D0D4;}
.ri-err{background:#FFF5F6;border:1px solid rgba(196,84,62,.35);color:#B03020;font-size:.76rem;padding:.6rem .9rem;margin-bottom:.85rem;border-radius:6px;font-weight:500;}
/* Time slot buttons */
.tslot-btn{padding:.55rem .4rem;background:#FFF5F6;color:#7A2238;border:1.5px solid #F0D0D4;font-family:var(--sans);font-size:.72rem;letter-spacing:.04em;cursor:pointer;transition:all .18s;font-weight:500;border-radius:7px;}
.tslot-btn:hover{background:#FFE8EC;border-color:#C17E87;color:#5C1828;}
.tslot-btn.on{background:linear-gradient(135deg,#2D0E14,#5C1828);color:#fff;border-color:#2D0E14;font-weight:700;box-shadow:0 2px 10px rgba(45,14,20,.25);}
/* Booking note under submit */
.ri-booking-note{font-size:.68rem;color:#A07880;margin-top:.65rem;text-align:center;line-height:1.55;}
.ri-booking-note strong{color:#5C1828;}

/* ── Admin Settings Tab ── */
.set-card{background:var(--a-bg);border:1px solid var(--a-border);padding:1.4rem;margin-bottom:1.2rem;}
.set-card-title{font-size:.78rem;font-weight:600;color:var(--a-text);margin-bottom:.25rem;display:flex;align-items:center;gap:.5rem;}
.set-card-sub{font-size:.72rem;color:var(--a-muted);margin-bottom:1rem;line-height:1.5;}
.set-field{margin-bottom:.85rem;}
.set-label{display:block;font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:var(--a-muted);font-weight:600;margin-bottom:.38rem;}
.set-inp{width:100%;background:var(--a-surface2);border:1px solid var(--a-border);color:var(--a-text);padding:.6rem .9rem;font-family:var(--sans);font-size:.84rem;outline:none;transition:border-color .18s;}
.set-inp:focus{border-color:var(--a-gold);}
.set-inp::placeholder{color:var(--a-muted);}
.set-save-btn{background:var(--a-cta);color:var(--a-bg);border:none;padding:.62rem 1.6rem;font-family:var(--sans);font-size:.8rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:opacity .2s;}
.set-save-btn:hover{opacity:.88;}
.set-preview{background:rgba(13,13,24,.08);border:1px solid rgba(13,13,24,.2);padding:.75rem 1rem;margin-top:.85rem;font-size:.76rem;color:var(--a-text);line-height:1.6;}
.set-preview a{color:var(--a-gold);word-break:break-all;}
.set-note{font-size:.7rem;color:var(--a-muted);line-height:1.55;margin-top:.5rem;}

.a-login{min-height:100vh;background:var(--a-bg);display:flex;align-items:center;justify-content:center;padding:2rem;}
.a-login-box{width:100%;max-width:380px;background:var(--a-surface);border:1px solid var(--a-border);padding:2.5rem;}
.a-login-logo{font-family:var(--serif);font-size:1.6rem;font-weight:600;color:var(--a-gold);margin-bottom:.25rem;}
.a-login-logo span{color:var(--a-text);font-weight:300;}
.a-login-sub{font-size:.75rem;color:var(--a-muted);margin-bottom:2rem;}
.a-login-lbl{display:block;font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--a-muted);margin-bottom:.5rem;font-weight:500;}
.a-login-inp{width:100%;background:var(--a-bg);border:1px solid var(--a-border);color:var(--a-text);padding:.75rem 1rem;font-family:var(--sans);font-size:.9rem;outline:none;margin-bottom:1.2rem;}
.a-login-inp:focus{border-color:var(--a-gold);}
.a-login-btn{width:100%;background:var(--a-cta);color:var(--a-bg);border:none;padding:.8rem;font-family:var(--sans);font-size:.84rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;}
.a-login-btn:hover{opacity:.88;}
.a-login-err{background:rgba(191,155,78,.12);border:1px solid rgba(191,155,78,.3);color:#D4B880;font-size:.78rem;padding:.6rem .9rem;margin-bottom:1rem;}
.a-login-hint{font-size:.7rem;color:var(--a-muted);text-align:center;margin-top:1rem;}
.a-shell{display:flex;min-height:calc(100vh - 64px);background:var(--a-bg);}
.a-sidebar{width:220px;flex-shrink:0;background:var(--a-surface);border-right:1px solid var(--a-border);padding:1.5rem 0;}
.a-sidebar-sec{font-size:.6rem;letter-spacing:.16em;text-transform:uppercase;color:var(--a-muted);padding:.4rem 1.3rem .6rem;font-weight:600;}
.a-sb-item{display:flex;align-items:center;gap:.7rem;padding:.62rem 1.3rem;font-size:.82rem;color:var(--a-text);cursor:pointer;transition:background .15s,color .15s;border-left:3px solid transparent;}
.a-sb-item:hover{background:var(--a-surface2);color:#fff;}
.a-sb-item.on{background:var(--a-surface2);color:var(--a-gold);border-left-color:var(--a-gold);}
.a-main{flex:1;padding:2rem 2.5rem;overflow-x:hidden;}
.a-pg-title{font-family:var(--serif);font-size:1.9rem;font-weight:300;color:#fff;margin-bottom:.3rem;}
.a-pg-title em{color:var(--a-gold);font-style:italic;}
.a-pg-sub{font-size:.8rem;color:var(--a-muted);margin-bottom:2rem;}
.a-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:1rem;margin-bottom:2rem;}
.a-stat{background:var(--a-surface);border:1px solid var(--a-border);padding:1.2rem 1.5rem;}
.a-stat-lbl{font-size:.65rem;letter-spacing:.12em;text-transform:uppercase;color:var(--a-muted);margin-bottom:.5rem;font-weight:500;}
.a-stat-val{font-family:var(--serif);font-size:2rem;font-weight:600;color:#fff;line-height:1;}
.a-stat-sub{font-size:.72rem;color:var(--a-muted);margin-top:.3rem;}
.a-stat.gold .a-stat-val{color:var(--a-gold);}
.a-stat.blue .a-stat-val{color:var(--a-blue);}
.a-stat.green .a-stat-val{color:var(--a-green);}
.a-toolbar{display:flex;align-items:center;gap:.75rem;margin-bottom:1.2rem;flex-wrap:wrap;}
.a-search{flex:1;min-width:200px;background:var(--a-surface);border:1px solid var(--a-border);color:var(--a-text);padding:.6rem 1rem;font-family:var(--sans);font-size:.84rem;outline:none;}
.a-search:focus{border-color:var(--a-gold);}
.a-search::placeholder{color:var(--a-muted);}
.a-fsel{background:var(--a-surface);border:1px solid var(--a-border);color:var(--a-text);padding:.6rem 2rem .6rem .85rem;font-family:var(--sans);font-size:.82rem;cursor:pointer;outline:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238e8a84' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .6rem center;}
.a-add-btn{display:flex;align-items:center;gap:.5rem;background:var(--a-gold);color:var(--a-bg);border:none;padding:.62rem 1.3rem;font-family:var(--sans);font-size:.78rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;white-space:nowrap;}
.a-add-btn:hover{opacity:.88;}
.a-tbl-wrap{overflow-x:auto;border:1px solid var(--a-border);}
.a-tbl{width:100%;border-collapse:collapse;min-width:800px;}
.a-tbl thead tr{background:var(--a-surface2);}
.a-tbl th{padding:.75rem 1rem;text-align:left;font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:var(--a-muted);font-weight:600;border-bottom:1px solid var(--a-border);white-space:nowrap;}
.a-tbl tbody tr{border-bottom:1px solid var(--a-border);transition:background .15s;}
.a-tbl tbody tr:hover{background:rgba(255,255,255,.02);}
.a-tbl td{padding:.75rem 1rem;font-size:.82rem;color:var(--a-text);vertical-align:middle;}
.a-tbl-img{width:54px;height:38px;object-fit:cover;display:block;}
.a-tbl-name{font-weight:600;color:#FAF8F3;font-size:.85rem;margin-bottom:.15rem;}
.a-tbl-dev{font-size:.72rem;color:var(--a-muted);}
.a-schip{display:inline-block;font-size:.62rem;font-weight:600;letter-spacing:.06em;padding:.18rem .55rem;text-transform:uppercase;}
.a-schip.nl{background:rgba(212,184,128,.15);color:#D4B880;border:1px solid rgba(212,184,128,.3);}
.a-schip.uc{background:rgba(13,13,24,.15);color:#0D0D18;border:1px solid rgba(13,13,24,.3);}
.a-schip.co{background:rgba(142,138,132,.15);color:#D4B880;border:1px solid rgba(142,138,132,.3);}
.a-schip.so{background:rgba(191,155,78,.12);color:#D4B880;border:1px solid rgba(191,155,78,.25);}
.a-row-act{display:flex;gap:.4rem;}
.a-ico-btn{width:30px;height:30px;background:transparent;border:1px solid var(--a-border);color:var(--a-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;}
.a-ico-btn:hover.edit{border-color:var(--a-gold);color:var(--a-gold);background:rgba(13,13,24,.09);}
.a-ico-btn:hover.del{border-color:var(--a-red);color:var(--a-red);background:rgba(191,155,78,.08);}
.a-tbl-empty{text-align:center;padding:3rem;color:var(--a-muted);}
.a-pager{display:flex;align-items:center;justify-content:space-between;padding:.9rem 1rem;border-top:1px solid var(--a-border);font-size:.76rem;color:var(--a-muted);}
.a-pager-btns{display:flex;gap:.3rem;}
.a-pg-btn{width:28px;height:28px;background:transparent;border:1px solid var(--a-border);color:var(--a-muted);cursor:pointer;font-family:var(--sans);font-size:.78rem;transition:all .15s;}
.a-pg-btn:hover,.a-pg-btn.on{background:var(--a-gold);color:var(--a-bg);border-color:var(--a-gold);}
.a-pg-btn:disabled{opacity:.35;cursor:not-allowed;}

/* Form modal */
.a-modal-ov{position:fixed;inset:0;z-index:300;background:rgba(5,7,12,.88);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:2rem 1rem;overflow:hidden;animation:fadeIn .2s ease;}
.a-modal{background:var(--a-surface);border:1px solid var(--a-border);width:100%;max-width:860px;max-height:80vh;position:relative;animation:slideUp .28s ease;display:flex;flex-direction:column;overflow:hidden;}
.a-modal-hd{background:var(--a-bg);padding:1.4rem 2rem;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--a-border);flex-shrink:0;}
.a-modal-title{font-family:var(--serif);font-size:1.5rem;color:#fff;font-weight:400;}
.a-modal-title em{color:var(--a-gold);font-style:italic;}
.a-modal-x{width:34px;height:34px;background:transparent;border:1px solid var(--a-border);color:var(--a-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.9rem;transition:all .15s;}
.a-modal-x:hover{border-color:var(--a-red);color:var(--a-red);}
.a-modal-body{padding:1.8rem 2rem;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;flex:1;min-height:0;}

/* Image modal */
.img-modal-ov{position:fixed;inset:0;z-index:850;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center;padding:1rem;}
.img-modal{position:relative;max-width:98vw;max-height:96vh;display:flex;align-items:center;justify-content:center;}
.img-modal-body{display:flex;align-items:center;justify-content:center;overflow:hidden;}
.img-modal img{max-width:100%;max-height:100%;display:block;}
.img-modal-close{position:absolute;top:10px;right:10px;background:transparent;border:1px solid rgba(255,255,255,.25);color:#fff;width:36px;height:36px;border-radius:6px;cursor:pointer;font-size:1rem}
.img-modal-nav{position:absolute;top:50%;transform:translateY(-50%);background:transparent;border:1px solid rgba(255,255,255,.18);color:#fff;width:42px;height:56px;border-radius:8px;cursor:pointer;font-size:1.6rem;display:flex;align-items:center;justify-content:center}
.img-modal-nav.prev{left:10px}
.img-modal-nav.next{right:10px}

/* ── Toggle Switch ── */
.tog-wrap{display:inline-flex;align-items:center;gap:.55rem;cursor:pointer;user-select:none;}
.tog{position:relative;width:42px;height:24px;flex-shrink:0;}
.tog input{position:absolute;opacity:0;width:0;height:0;pointer-events:none;}
.tog-track{position:absolute;inset:0;background:#0D0D18;border-radius:12px;transition:background .22s;border:1px solid #0D0D18;}
.tog input:checked~.tog-track{background:var(--a-green);border-color:var(--a-green);}
.tog-thumb{position:absolute;top:3px;left:3px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .22s;box-shadow:0 1px 4px rgba(0,0,0,.35);}
.tog input:checked~.tog-thumb{transform:translateX(18px);}
.tog-lbl{font-size:.8rem;color:var(--a-text);}
.tog-lbl.off{color:var(--a-muted);}
/* Visibility panel */
.vis-master-card{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.2rem;background:var(--a-bg);border:1px solid var(--a-border);margin-bottom:1.5rem;}
.vis-master-title{font-size:.88rem;font-weight:600;color:#FAF8F3;margin-bottom:.2rem;}
.vis-master-title.off{color:var(--a-muted);}
.vis-master-sub{font-size:.74rem;color:var(--a-muted);line-height:1.45;}
.vis-tabs-grid{display:grid;grid-template-columns:1fr;gap:.6rem;margin-bottom:1.5rem;}
.vis-tab-card{display:flex;align-items:center;gap:.9rem;padding:.85rem 1.1rem;background:var(--a-bg);border:1px solid var(--a-border);transition:border-color .18s;}
.vis-tab-card.on{border-color:rgba(142,138,132,.3);}
.vis-tab-card.off{opacity:.6;}
.vis-tab-icon{font-size:1.2rem;flex-shrink:0;width:32px;text-align:center;}
.vis-tab-info{flex:1;}
.vis-tab-name{font-size:.82rem;font-weight:600;color:#FAF8F3;margin-bottom:.15rem;}
.vis-tab-desc{font-size:.72rem;color:var(--a-muted);}
.vis-preview{background:rgba(13,13,24,.08);border:1px solid rgba(13,13,24,.2);padding:1rem 1.1rem;}
.vis-preview-lbl{font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:var(--a-gold);font-weight:700;margin-bottom:.65rem;}
.vis-preview-tabs{display:flex;gap:.45rem;flex-wrap:wrap;}
.vis-prev-tab{background:var(--a-surface2);border:1px solid var(--a-border);font-size:.76rem;color:var(--a-text);padding:.3rem .75rem;}
.vis-no-tabs{font-size:.78rem;color:var(--a-red);}
.vis-hidden-warn{display:flex;align-items:center;gap:.5rem;padding:.65rem 1rem;background:rgba(191,155,78,.08);border:1px solid rgba(191,155,78,.2);font-size:.76rem;color:#D4B880;margin-top:1rem;}

/* Section-level visibility */
.vis-group{margin-bottom:1.4rem;}
.vis-group-hd{display:flex;align-items:center;gap:.6rem;padding:.55rem .9rem;background:var(--a-surface2);border:1px solid var(--a-border);border-bottom:none;font-size:.65rem;letter-spacing:.12em;text-transform:uppercase;color:var(--a-gold);font-weight:700;}
.vis-group-hd-ico{font-size:.95rem;}
.vis-group-body{border:1px solid var(--a-border);}
.vis-sec-row{display:flex;align-items:center;gap:.8rem;padding:.6rem .9rem;border-bottom:1px solid var(--a-border);transition:background .15s;}
.vis-sec-row:last-child{border-bottom:none;}
.vis-sec-row.hidden{opacity:.5;}
.vis-sec-row.disabled{opacity:.3;pointer-events:none;}
.vis-sec-ico{font-size:.9rem;width:22px;text-align:center;flex-shrink:0;}
.vis-sec-info{flex:1;}
.vis-sec-name{font-size:.78rem;color:#FAF8F3;font-weight:500;}
.vis-sec-desc{font-size:.68rem;color:var(--a-muted);margin-top:.08rem;}
.vis-tab-disabled-note{font-size:.68rem;color:var(--a-red);font-style:italic;margin-left:auto;white-space:nowrap;}

.a-form-tabs{display:flex;border-bottom:1px solid var(--a-border);margin-bottom:1.5rem;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;}
.a-form-tabs::-webkit-scrollbar{display:none;}
.a-form-tab{padding:.6rem 1.2rem;background:transparent;border:none;border-bottom:2px solid transparent;color:var(--a-muted);font-family:var(--sans);font-size:.76rem;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:color .15s,border-color .15s;}
.a-form-tab.on{color:var(--a-gold);border-bottom-color:var(--a-gold);}
.a-form-sec{font-size:.6rem;letter-spacing:.15em;text-transform:uppercase;color:var(--a-gold);font-weight:700;margin-bottom:.8rem;padding-bottom:.5rem;border-bottom:1px solid var(--a-border);}
.a-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.5rem;}
.a-form-grid.c3{grid-template-columns:1fr 1fr 1fr;}
.a-form-grid.c1{grid-template-columns:1fr;}
.a-ff{display:flex;flex-direction:column;gap:.35rem;}
.a-ff.s2{grid-column:1/-1;}
.a-flbl{font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--a-muted);font-weight:500;}
.a-flbl small{color:#666;font-style:italic;text-transform:none;letter-spacing:0;font-weight:400;}
.a-inp{background:var(--a-bg);border:1px solid var(--a-border);color:var(--a-text);padding:.65rem .9rem;font-family:var(--sans);font-size:.85rem;outline:none;transition:border-color .2s;width:100%;}
.a-inp:focus{border-color:var(--a-gold);}
.a-inp::placeholder{color:var(--a-muted);}
.a-txt{background:var(--a-bg);border:1px solid var(--a-border);color:var(--a-text);padding:.65rem .9rem;font-family:var(--sans);font-size:.85rem;outline:none;resize:vertical;min-height:76px;width:100%;transition:border-color .2s;}
.a-txt:focus{border-color:var(--a-gold);}
.a-sel{background:var(--a-bg);border:1px solid var(--a-border);color:var(--a-text);padding:.65rem .9rem;font-family:var(--sans);font-size:.85rem;outline:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238e8a84' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .8rem center;width:100%;cursor:pointer;transition:border-color .2s;}
.a-sel:focus{border-color:var(--a-gold);}
.color-row{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;}
.csw{width:26px;height:26px;border:2px solid transparent;cursor:pointer;transition:transform .15s,border-color .15s;}
.csw:hover{transform:scale(1.15);}
.csw.pk{border-color:#fff;transform:scale(1.1);}
.tag-presets{display:flex;gap:.3rem;flex-wrap:wrap;margin-top:.3rem;}
.tpre{background:transparent;border:1px solid var(--a-border);color:var(--a-muted);padding:.22rem .55rem;font-family:var(--sans);font-size:.7rem;cursor:pointer;transition:all .15s;}
.tpre:hover{border-color:var(--a-gold);color:var(--a-gold);}
.img-prev{width:100%;height:80px;object-fit:cover;margin-top:.4rem;border:1px solid var(--a-border);}
.a-map-preview{width:100%;height:200px;border:1px solid var(--a-border);margin-bottom:1rem;overflow:hidden;}
.a-map-preview iframe{width:100%;height:100%;border:none;display:block;}
.map-picker-mini{margin-bottom:1rem;}
.map-picker-container{width:100%;height:200px;border:1px solid var(--a-border);background:#0D0D18;z-index:1;}
.map-picker-actions{display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-top:.4rem;}
.map-picker-expand{background:transparent;border:1px solid var(--a-border);color:var(--a-text);font-family:var(--sans);font-size:.72rem;padding:.35rem .75rem;cursor:pointer;transition:all .18s;letter-spacing:.04em;}
.map-picker-expand:hover{border-color:var(--a-gold);color:var(--a-gold);}
.map-picker-hint{font-size:.66rem;color:var(--a-muted);font-style:italic;}
.map-picker-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.85);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:1.5rem;animation:fadeIn .2s ease;}
.map-picker-modal{background:var(--a-surface);border:1px solid var(--a-border);width:100%;max-width:900px;max-height:90vh;display:flex;flex-direction:column;animation:slideUp .25s ease;overflow:hidden;}
.map-picker-modal-hd{display:flex;align-items:center;justify-content:space-between;padding:.85rem 1.2rem;border-bottom:1px solid var(--a-border);font-size:.85rem;font-weight:600;color:var(--a-text);}
.map-picker-modal-x{background:transparent;border:1px solid var(--a-border);color:var(--a-muted);width:30px;height:30px;font-size:.85rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;}
.map-picker-modal-x:hover{border-color:var(--a-gold);color:#fff;}
.map-picker-modal-body{flex:1;min-height:400px;height:60vh;z-index:1;}
.map-picker-modal-ft{display:flex;align-items:center;justify-content:space-between;padding:.75rem 1.2rem;border-top:1px solid var(--a-border);background:var(--a-bg);}
.map-picker-coords{font-family:var(--sans);font-size:.78rem;color:var(--a-gold);font-weight:500;letter-spacing:.02em;}
.map-picker-confirm{background:var(--a-cta);color:#fff;border:none;padding:.55rem 1.4rem;font-family:var(--sans);font-size:.78rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:opacity .2s;}
.map-picker-confirm:hover{opacity:.88;}
@media(max-width:768px){.map-picker-overlay{padding:.5rem;}.map-picker-modal{max-height:100vh;}.map-picker-modal-body{min-height:300px;height:50vh;}}
@media(max-width:480px){.map-picker-overlay{padding:0;}.map-picker-modal{max-height:100vh;border-radius:var(--r-lg) var(--r-lg) 0 0;}.map-picker-modal-body{min-height:250px;height:45vh;}.map-picker-actions{flex-direction:column;align-items:flex-start;}}
.a-form-err{background:rgba(191,155,78,.1);border:1px solid rgba(191,155,78,.3);color:#D4B880;font-size:.78rem;padding:.6rem .9rem;margin-bottom:1rem;}
.a-modal-ft{padding:1.2rem 2rem;border-top:1px solid var(--a-border);display:flex;justify-content:flex-end;gap:.75rem;background:var(--a-bg);flex-shrink:0;}
.a-cancel{background:transparent;color:var(--a-muted);border:1px solid var(--a-border);padding:.65rem 1.5rem;font-family:var(--sans);font-size:.8rem;cursor:pointer;}
.a-cancel:hover{color:var(--a-text);}
.a-save{background:var(--a-gold);color:var(--a-bg);border:none;padding:.65rem 1.8rem;font-family:var(--sans);font-size:.8rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;}
.a-save:hover{opacity:.88;}

/* Unit type editor in admin form */
.ut-editor{display:flex;flex-direction:column;gap:.75rem;}
.ut-editor-row{background:var(--a-bg);border:1px solid var(--a-border);padding:1rem;}
.ut-editor-row-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem;}
.ut-editor-row-title{font-size:.72rem;font-weight:600;color:var(--a-gold);letter-spacing:.06em;}
.ut-rm-btn{background:transparent;border:1px solid var(--a-border);color:var(--a-muted);width:26px;height:26px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.7rem;}
.ut-rm-btn:hover{border-color:var(--a-red);color:var(--a-red);}
.ut-row-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:.6rem;}
.ut-row-grid.two{grid-template-columns:1fr 1fr;}
.ut-add-btn{background:transparent;border:1px dashed var(--a-border);color:var(--a-muted);padding:.6rem;font-family:var(--sans);font-size:.75rem;cursor:pointer;transition:all .15s;text-align:center;}
.ut-add-btn:hover{border-color:var(--a-gold);color:var(--a-gold);}
.ut-img-mini{width:100%;height:52px;object-fit:cover;margin-top:.3rem;border:1px solid var(--a-border);}

/* AI PDF Autofill */
.ai-zone{border:1px solid var(--a-border);background:linear-gradient(135deg,#0D0D18 0%,#0D0D18 100%);margin-bottom:1.5rem;overflow:hidden;}
.ai-zone-hd{display:flex;align-items:center;gap:.7rem;padding:.85rem 1.2rem;border-bottom:1px solid var(--a-border);}
.ai-zone-icon{width:30px;height:30px;background:linear-gradient(135deg,rgba(191,155,78,.18),rgba(212,184,108,.10));border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0;}
.ai-zone-title{font-size:.78rem;font-weight:600;color:#FAF8F3;letter-spacing:.04em;}
.ai-zone-sub{font-size:.68rem;color:var(--a-muted);margin-top:.1rem;}
.ai-zone-body{padding:1rem 1.2rem;}
.ai-drop{border:1.5px dashed #0D0D18;background:rgba(255,255,255,.02);padding:1.5rem;text-align:center;cursor:pointer;transition:border-color .2s,background .2s;position:relative;}
.ai-drop:hover,.ai-drop.over{border-color:var(--a-gold);background:rgba(13,13,24,.08);}
.ai-drop input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;}
.ai-drop-ico{font-size:1.6rem;margin-bottom:.5rem;}
.ai-drop-txt{font-size:.78rem;color:var(--a-muted);line-height:1.5;}
.ai-drop-txt strong{color:var(--a-text);}
.ai-drop-txt small{display:block;font-size:.68rem;margin-top:.2rem;color:#0D0D18;}
.ai-file-row{display:flex;align-items:center;gap:.75rem;background:rgba(13,13,24,.09);border:1px solid rgba(13,13,24,.25);padding:.65rem 1rem;margin-top:.75rem;}
.ai-file-ico{font-size:1.1rem;}
.ai-file-name{font-size:.78rem;color:var(--a-text);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ai-file-size{font-size:.68rem;color:var(--a-muted);white-space:nowrap;}
.ai-file-rm{background:transparent;border:none;color:var(--a-muted);cursor:pointer;font-size:.8rem;padding:.2rem;}
.ai-file-rm:hover{color:var(--a-red);}
.ai-parse-btn{width:100%;margin-top:.75rem;background:linear-gradient(135deg,#0D0D18,#0D0D18);color:#fff;border:none;padding:.72rem;font-family:var(--sans);font-size:.8rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:opacity .2s;display:flex;align-items:center;justify-content:center;gap:.5rem;}
.ai-parse-btn:hover{opacity:.88;}
.ai-parse-btn:disabled{opacity:.45;cursor:not-allowed;}
.ai-progress{margin-top:.75rem;background:rgba(255,255,255,.04);border:1px solid var(--a-border);padding:.85rem 1rem;}
.ai-progress-steps{display:flex;flex-direction:column;gap:.45rem;}
.ai-step{display:flex;align-items:center;gap:.6rem;font-size:.75rem;}
.ai-step-dot{width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.6rem;flex-shrink:0;}
.ai-step-dot.done{background:var(--a-green);color:#fff;}
.ai-step-dot.active{background:var(--a-gold);color:#0D0D18;animation:pulse 1s infinite;}
.ai-step-dot.wait{background:var(--a-surface2);color:var(--a-muted);}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:.5;}}
.ai-step-txt.done{color:var(--a-text);}
.ai-step-txt.active{color:var(--a-gold);}
.ai-step-txt.wait{color:var(--a-muted);}
.ai-result-bar{display:flex;align-items:flex-start;flex-direction:column;gap:.4rem;margin-top:.75rem;padding:.7rem 1rem;background:rgba(142,138,132,.1);border:1px solid rgba(142,138,132,.25);}
.ai-result-bar.fallback{background:rgba(13,13,24,.1);border:1px solid rgba(13,13,24,.25);}
.ai-result-bar.fallback .ai-result-txt{color:var(--a-gold);}
.ai-result-bar.fallback .ai-field-tag{background:rgba(13,13,24,.12);border-color:rgba(13,13,24,.22);color:var(--a-gold);}
.ai-result-txt{font-size:.75rem;color:#D4B880;font-weight:600;}
.ai-result-count{font-size:.7rem;color:var(--a-muted);}
.ai-field-flash{animation:ai-field-pop .4s ease;border-radius:6px;}
@keyframes ai-field-pop{0%{background:#D4B880;transform:scale(1.015);}60%{background:#D4B880;}100%{background:transparent;transform:scale(1);}}
.ai-inp.ai-hl,.ai-txt.ai-hl,.ai-sel.ai-hl{border-color:#D4B880!important;background:#D4B880!important;box-shadow:0 0 0 3px #D4B8801a;transition:all .3s ease;}
.ai-autofill-badge{display:inline-flex;align-items:center;margin-left:6px;font-size:9px;font-weight:700;color:#D4B880;background:#D4B880;border:1px solid #D4B88055;border-radius:3px;padding:1px 5px;letter-spacing:.3px;vertical-align:middle;animation:ai-badge-in .25s ease;}
@keyframes ai-badge-in{from{opacity:0;transform:translateY(-3px) scale(.85);}to{opacity:1;transform:translateY(0) scale(1);}}
.ai-result-ico{font-size:20px;margin-bottom:2px;}
.ai-err-bar{display:flex;align-items:flex-start;gap:.6rem;margin-top:.75rem;padding:.7rem 1rem;background:rgba(191,155,78,.1);border:1px solid rgba(191,155,78,.25);font-size:.75rem;color:#D4B880;line-height:1.5;}
.ai-filled-fields{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.4rem;}
.ai-field-tag{background:rgba(142,138,132,.15);border:1px solid rgba(142,138,132,.2);color:#D4B880;font-size:.62rem;padding:.12rem .45rem;}
.ai-btn-row{display:flex;gap:.5rem;margin-top:.75rem;flex-wrap:wrap;}
.ai-btn-row .ai-parse-btn{flex:1;margin-top:0;}
.ai-fallback-btn{flex:1;background:transparent;color:var(--a-text);border:1px solid var(--a-border);padding:.72rem;font-family:var(--sans);font-size:.76rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:all .2s;display:flex;align-items:center;justify-content:center;gap:.5rem;}
.ai-fallback-btn:hover{border-color:var(--a-gold);color:var(--a-gold);}
.ai-fallback-btn:disabled{opacity:.45;cursor:not-allowed;}
.ai-progress-hd{font-size:.72rem;color:var(--a-gold);font-weight:600;margin-bottom:.5rem;display:flex;align-items:center;gap:.4rem;}

.del-modal{background:var(--a-surface);border:1px solid var(--a-border);width:100%;max-width:420px;max-height:80vh;padding:2rem;animation:slideUp .2s ease;overflow-y:auto;border-radius:var(--r-md);}
.del-ico{font-size:2.5rem;margin-bottom:1rem;text-align:center;}
.del-title{font-family:var(--serif);font-size:1.4rem;color:#fff;text-align:center;margin-bottom:.5rem;}
.del-sub{font-size:.84rem;color:var(--a-muted);text-align:center;line-height:1.6;margin-bottom:1.5rem;}
.del-btns{display:flex;gap:.75rem;}
.del-cancel{flex:1;background:transparent;color:var(--a-text);border:1px solid var(--a-border);padding:.7rem;font-family:var(--sans);font-size:.82rem;cursor:pointer;}
.del-confirm{flex:1;background:var(--a-red);color:#fff;border:none;padding:.7rem;font-family:var(--sans);font-size:.82rem;font-weight:600;cursor:pointer;}
.del-confirm:hover{opacity:.85;}
.toast{position:fixed;bottom:1.5rem;right:1.5rem;z-index:999;background:var(--a-surface);border:1px solid var(--a-border);color:var(--a-text);padding:.8rem 1.2rem;font-size:.82rem;display:flex;align-items:center;gap:.6rem;animation:slideToast .3s ease;max-width:320px;box-shadow:0 8px 32px rgba(0,0,0,.4);}
@keyframes slideToast{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}
.toast.success .t-ico{color:var(--a-green);}
.toast.error   .t-ico{color:var(--a-red);}
.toast.info    .t-ico{color:var(--a-gold);}
.ft{background:linear-gradient(135deg,#0D0D18 0%,#141428 100%);color:#8E8A84;padding:2.5rem;text-align:center;font-size:.76rem;border-top:1px solid rgba(191,155,78,.18);margin-top:4rem;}
.ft span{color:var(--gold);}

/* ═══ ANALYTICS DASHBOARD ═══ */
.an-hd{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:1rem;}
.an-hd-controls{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;}
.an-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin-bottom:1.5rem;}
.an-stat{background:var(--a-surface);border:1px solid var(--a-border);padding:1.1rem 1.2rem;display:flex;align-items:center;gap:.9rem;}
.an-stat-ico{font-size:1.4rem;flex-shrink:0;}
.an-stat-val{font-family:var(--serif);font-size:1.7rem;font-weight:600;color:#fff;line-height:1;}
.an-stat-lbl{font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:var(--a-muted);margin-top:.25rem;}
.an-views .an-stat-val{color:#D4B880;}
.an-clicks .an-stat-val{color:#BF9B4E;}
.an-inq .an-stat-val{color:#5E8FD0;}
.an-conv .an-stat-val{color:#4E9A72;}
.an-chart-card{background:var(--a-surface);border:1px solid var(--a-border);padding:1.2rem 1.4rem;margin-bottom:1.2rem;}
.an-card-title{font-size:.65rem;letter-spacing:.12em;text-transform:uppercase;color:var(--a-gold);font-weight:700;margin-bottom:.75rem;}
.an-chart{display:flex;align-items:flex-end;gap:2px;height:120px;overflow-x:auto;padding-bottom:.5rem;}
.an-chart-col{display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;min-width:24px;}
.an-bars{display:flex;align-items:flex-end;gap:1px;height:100px;width:100%;}
.an-bar{flex:1;border-radius:2px 2px 0 0;min-height:1px;transition:height .3s;}
.an-bar-views{background:#D4B880;}
.an-bar-clicks{background:#BF9B4E;}
.an-bar-inq{background:#5E8FD0;}
.an-chart-lbl{font-size:.52rem;color:var(--a-muted);white-space:nowrap;text-align:center;}
.an-legend{display:flex;gap:1.2rem;margin-top:.75rem;flex-wrap:wrap;}
.an-leg-item{display:flex;align-items:center;gap:.4rem;font-size:.72rem;color:var(--a-muted);}
.an-leg-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
.an-row{display:flex;gap:1rem;flex-wrap:wrap;}
.an-row>.an-chart-card{min-width:0;}
.an-inq-card{flex:0 0 260px;}
.an-proj-card{flex:1;min-width:0;}
.an-inq-bars{display:flex;flex-direction:column;gap:.9rem;margin-top:1rem;}
.an-inq-row-hd{display:flex;justify-content:space-between;font-size:.78rem;color:var(--a-text);margin-bottom:.3rem;}
.an-inq-cnt{color:var(--a-muted);}
.an-inq-track{height:4px;background:var(--a-border);border-radius:2px;}
.an-inq-fill{height:100%;border-radius:2px;transition:width .4s;}
.an-proj-tbl{width:100%;border-collapse:collapse;margin-top:.75rem;font-size:.78rem;min-width:360px;}
.an-proj-tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
.an-proj-tbl th{text-align:left;padding:.4rem .6rem;color:var(--a-muted);font-weight:600;font-size:.65rem;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid var(--a-border);}
.an-proj-tbl th.num{text-align:center;}
.an-proj-tbl td{padding:.5rem .6rem;color:var(--a-text);border-bottom:1px solid var(--a-border);}
.an-proj-tbl td.num{text-align:center;}
.an-proj-tbl td.gold{color:var(--a-gold);text-align:center;}
.an-proj-tbl td.pale{color:#D4B880;text-align:center;}
.an-proj-tbl td.muted{color:var(--a-muted);text-align:center;}
.an-empty{background:rgba(255,255,255,.03);border:1px solid var(--a-border);padding:2rem;text-align:center;margin-top:1rem;}
.an-empty-ico{font-size:2rem;margin-bottom:.5rem;}
.an-empty-h{color:var(--a-text);font-size:.88rem;margin-bottom:.25rem;}
.an-empty-s{color:var(--a-muted);font-size:.76rem;}
.an-range-btn{background:transparent;border:1px solid var(--a-border);color:var(--a-muted);padding:.38rem .85rem;font-family:var(--sans);font-size:.72rem;cursor:pointer;transition:all .15s;border-radius:4px;}
.an-range-btn:hover{border-color:var(--a-gold);color:var(--a-gold);}
.an-range-btn.on{background:var(--a-gold);color:var(--a-bg);border-color:var(--a-gold);font-weight:600;}
.an-clear-btn{background:transparent;border:1px solid rgba(196,84,62,.3);color:#C4543E;padding:.38rem .85rem;font-family:var(--sans);font-size:.72rem;cursor:pointer;transition:all .15s;border-radius:4px;}
.an-clear-btn:hover{background:rgba(196,84,62,.1);}
@media(max-width:768px){
  .an-stats{grid-template-columns:repeat(2,1fr);}
  .an-hd-controls{width:100%;}
  .an-row{flex-direction:column;}
  .an-inq-card{flex:none;width:100%;}
  .an-proj-card{width:100%;}
  .an-proj-tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;}
  .an-proj-tbl{min-width:340px;}
}
@media(max-width:480px){
  .an-stats{grid-template-columns:repeat(2,1fr);gap:.6rem;}
  .an-stat{padding:.8rem .9rem;gap:.6rem;}
  .an-stat-ico{font-size:1.1rem;}
  .an-stat-val{font-size:1.35rem;}
  .an-hd-controls{gap:.3rem;}
  .an-range-btn,.an-clear-btn{padding:.35rem .6rem;font-size:.68rem;}
  .an-chart-card{padding:.9rem 1rem;}
  .an-chart{height:90px;}
  .an-bars{height:72px;}
  .an-proj-tbl{font-size:.72rem;}
}

/* (layout overrides already handled in the 768px/480px blocks above) */

/* ═══════════════════════════════════════
   DARK LUXURY THEME OVERRIDES
═══════════════════════════════════════ */
html{background:#080812;}
body{background:#080812;color:#E8E4F0;}
.main{background:#080812;}.lux-hero-bg,.lux-hero-overlay,.lux-hero-side-glow,.lux-hero-grid{transition:none;}
.card{background:rgba(14,14,30,0.92);border:1px solid rgba(191,155,78,.16);backdrop-filter:blur(16px);box-shadow:0 8px 32px rgba(0,0,0,.5);}
.card:hover{transform:translateY(-6px);box-shadow:0 24px 60px rgba(0,0,0,.6),0 0 0 1px rgba(191,155,78,.32),0 0 40px rgba(191,155,78,.07);border-color:rgba(191,155,78,.42);}
.cimg img{filter:brightness(.9);}
.cbody{background:rgba(12,12,26,.96);}
.cname{color:#F0EDE6;}
.cdev{color:#6E6A84;}
.cloc{color:#6E6A84;}
.cdiv{background:rgba(191,155,78,.15);}
.cplbl{color:#6E6A84;}
.cprice{color:#BF9B4E;}
.cmeta{color:#6E6A84;}
.empty-h{color:#F0EDE6;}
.filter-panel{background:rgba(10,10,22,.97);border:1px solid rgba(191,155,78,.18);backdrop-filter:blur(16px);}
.filter-top{background:rgba(10,10,22,.97);border-bottom:1px solid rgba(191,155,78,.12);}
.filter-row2{background:rgba(8,8,18,.97);border-bottom:1px solid rgba(191,155,78,.12);}
.flbl{color:#6E6A84;}
.fsel{background:rgba(20,18,38,.9);border:1px solid rgba(191,155,78,.2);color:#D0CCE0;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='%236E6A84' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");}
.fsel:focus{border-color:#BF9B4E;}
.fmore-btn{background:rgba(20,18,38,.8);border:1px solid rgba(191,155,78,.2);color:#8E8AA4;}
.fmore-btn:hover{border-color:#BF9B4E;color:#BF9B4E;}
.fclear-btn{color:#6E6A84;border:1px solid rgba(191,155,78,.2);background:transparent;}
.fclear-btn:hover{border-color:#C4543E;color:#C4543E;}
.rcnt{color:#6E6A84;}
.rcnt strong{color:#D0CCE0;}
.filter-divider{background:rgba(191,155,78,.2);}
.fsize-inp{background:rgba(20,18,38,.9);border:1px solid rgba(191,155,78,.2);color:#D0CCE0;}
.fsize-inp::placeholder{color:#6E6A84;}
.fsize-inp:focus{border-color:#BF9B4E;}
.fsize-sep{color:#6E6A84;}
.s-inp{background:rgba(10,10,22,.9);border:1px solid rgba(191,155,78,.28);color:#E8E4F0;backdrop-filter:blur(16px);}
.s-inp::placeholder{color:#6E6A84;}
.s-inp:focus{border-color:#BF9B4E;}
.price-panel{background:rgba(10,10,22,.97);}
.price-panel-label{color:#6E6A84;}
.price-panel-value{color:#F0EDE6;}
.ps-rail{background:rgba(191,155,78,.15);}
.ps-tick-lbl{color:#6E6A84;}
.price-reset{color:#6E6A84;border:1px solid rgba(191,155,78,.2);background:transparent;}
.price-reset:hover{border-color:#BF9B4E;color:#BF9B4E;}
.list-pager button{background:transparent;border:1px solid rgba(191,155,78,.2);color:#6E6A84;}
.list-pager button:hover{border-color:#BF9B4E;color:#BF9B4E;}
.list-pager button.on{background:#BF9B4E;color:#0A0A16;border-color:#BF9B4E;}
.list-pager .page-info{color:#6E6A84;}
.cmp-pg{background:#080812;min-height:100vh;}
.cmp-title{color:#F0EDE6;}
.cmp-sub{color:#6E6A84;}
.cmp-nil-h{color:#F0EDE6;}
.cmp-nil-s{color:#6E6A84;}
.lbl-cell{background:rgba(14,14,30,.97);color:#D0CCE0;border-color:rgba(191,155,78,.12);}
.val-cell{background:rgba(10,10,22,.9);color:#D0CCE0;border-color:rgba(191,155,78,.12);}
.val-cell.best-cell{background:rgba(20,16,38,.97);}
.proj-card{background:rgba(14,14,30,.97);border:1px solid rgba(191,155,78,.15);}
.proj-nm{color:#F0EDE6;}
.ctag2{background:rgba(20,18,38,.8);border:1px solid rgba(191,155,78,.2);color:#D0CCE0;}
.add-more{background:rgba(14,14,30,.8);border:1px dashed rgba(191,155,78,.2);}
.add-more p{color:#6E6A84;}
.go-btn{background:linear-gradient(135deg,#D4B880,#BF9B4E);color:#0A0A16;font-weight:700;}
.lc-pg{background:#080812;min-height:100vh;}
.lc-title{color:#F0EDE6;}
.lc-sub{color:#6E6A84;}
.lc-card{background:rgba(14,14,30,.92);border:1px solid rgba(191,155,78,.15);}
.lc-lbl{color:#C0BCCC;}
.lc-inp{background:rgba(20,18,38,.9);border:1px solid rgba(191,155,78,.2);color:#E8E4F0;}
.lc-inp:focus{border-color:#BF9B4E;}
.lc-slider-ends{color:#6E6A84;}
.lc-toggle{background:rgba(20,18,38,.9);color:#6E6A84;border:none;}
.lc-toggle-group{border:1px solid rgba(191,155,78,.2);}
.lc-adj-banner{background:rgba(191,155,78,.1);border:1px solid rgba(191,155,78,.25);}
.lc-rebate-note{background:rgba(14,14,30,.9);border:1px solid rgba(191,155,78,.15);color:#6E6A84;}
.lc-sum-card{background:rgba(14,14,30,.92);border:1px solid rgba(191,155,78,.15);}
.lc-sum-lbl{color:#6E6A84;}
.lc-sum-val{color:#F0EDE6;}
.lc-breakdown-btn{background:rgba(20,18,38,.9);color:#D0CCE0;}
.lc-breakdown-btn:hover{background:rgba(30,28,48,.9);}
.lc-hint{color:#6E6A84;}
.lc-hint-grn{color:#4ade80;font-weight:600;}
.lc-foreign-note{background:rgba(191,155,78,.08);border:1px solid rgba(191,155,78,.2);color:#BF9B4E;}
.lc-saved-card{background:rgba(191,155,78,.07);border-color:rgba(191,155,78,.22);}

/* ── Luxury Hero ── */
.lux-hero{position:relative;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;background:#04040E;}
.lux-hero-bg{position:absolute;inset:0;background-image:url('https://images.unsplash.com/photo-1613490493576-7fde63acd811?w=1920&q=80');background-size:cover;background-position:center;filter:brightness(.28);transform:scale(1.04);transition:transform 10s ease;}
.lux-hero:hover .lux-hero-bg{transform:scale(1.08);}
.lux-hero-overlay{position:absolute;inset:0;background:linear-gradient(to bottom,rgba(4,4,14,.45) 0%,rgba(4,4,14,.15) 45%,rgba(4,4,14,.85) 100%);}
.lux-hero-side-glow{position:absolute;inset:0;background:radial-gradient(ellipse 70% 50% at 50% 50%,rgba(191,155,78,.07) 0%,transparent 70%);pointer-events:none;}
.lux-hero-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(191,155,78,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(191,155,78,.03) 1px,transparent 1px);background-size:80px 80px;pointer-events:none;mask-image:radial-gradient(ellipse 80% 80% at 50% 50%,rgba(0,0,0,.4),transparent);}
.lux-hero-content{position:relative;z-index:2;text-align:center;padding:2rem 1.5rem 8rem;max-width:960px;width:100%;}
.lux-eyebrow{font-size:.7rem;letter-spacing:.3em;text-transform:uppercase;color:#BF9B4E;margin-bottom:1.8rem;display:flex;align-items:center;justify-content:center;gap:.8rem;font-weight:500;}
.lux-eyebrow::before,.lux-eyebrow::after{content:'';display:block;width:40px;height:1px;background:rgba(191,155,78,.45);}
.lux-h1{font-family:'Cormorant Garamond',Georgia,serif;font-size:clamp(2.8rem,7vw,5.5rem);font-weight:300;color:#F0EDE6;line-height:1.06;margin-bottom:1.5rem;letter-spacing:-.01em;}
.lux-h1 em{font-style:italic;color:#BF9B4E;}
.lux-tagline{font-size:clamp(.88rem,1.5vw,1.05rem);color:rgba(240,237,230,.55);max-width:500px;margin:0 auto 2.5rem;line-height:1.75;font-weight:300;}
.lux-ctas{display:flex;gap:.9rem;justify-content:center;flex-wrap:wrap;margin-bottom:2.8rem;overflow:visible;}
.lux-btn-pri{background:linear-gradient(135deg,#D4B880,#BF9B4E);color:#0A0A16;padding:.88rem 2.2rem;border:none;font-family:'DM Sans',sans-serif;font-size:.78rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:all .3s;position:relative;overflow:hidden;white-space:nowrap;flex-shrink:0;}
.lux-btn-pri::after{content:'';position:absolute;inset:0;background:rgba(255,255,255,.12);opacity:0;transition:opacity .2s;}
.lux-btn-pri:hover::after{opacity:1;}
.lux-btn-pri:hover{box-shadow:0 0 40px rgba(191,155,78,.5),0 8px 32px rgba(0,0,0,.4);transform:translateY(-2px);}
.lux-btn-sec{background:transparent;color:#F0EDE6;padding:.86rem 2.2rem;border:1px solid rgba(240,237,230,.28);font-family:'DM Sans',sans-serif;font-size:.78rem;font-weight:500;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:all .3s;white-space:nowrap;flex-shrink:0;}
.lux-btn-sec:hover{border-color:rgba(191,155,78,.6);color:#BF9B4E;box-shadow:0 0 20px rgba(191,155,78,.15);transform:translateY(-2px);}
.lux-hero-search{width:100%;max-width:600px;margin:0 auto;position:relative;}
.lux-hero-search-inp{width:100%;padding:1.1rem 3.5rem 1.1rem 1.8rem;background:rgba(8,8,20,.88);border:1px solid rgba(191,155,78,.32);color:#E8E4F0;font-family:'DM Sans',sans-serif;font-size:.95rem;outline:none;backdrop-filter:blur(20px);transition:all .3s;box-sizing:border-box;}
.lux-hero-search-inp::placeholder{color:rgba(200,196,216,.45);}
.lux-hero-search-inp:focus{border-color:#BF9B4E;box-shadow:0 0 30px rgba(191,155,78,.18);}
.lux-hero-search-ico{position:absolute;right:1.2rem;top:50%;transform:translateY(-50%);color:#BF9B4E;pointer-events:none;}
.lux-stats-bar{position:absolute;bottom:0;left:0;right:0;z-index:3;background:rgba(4,4,14,.88);border-top:1px solid rgba(191,155,78,.16);backdrop-filter:blur(20px);padding:1.4rem 2rem;display:flex;justify-content:center;gap:0;}
.lux-stat{flex:0 1 200px;text-align:center;padding:0 2rem;border-right:1px solid rgba(191,155,78,.14);}
.lux-stat:last-child{border-right:none;}
.lux-stat-num{font-family:'Cormorant Garamond',Georgia,serif;font-size:2rem;font-weight:600;color:#BF9B4E;line-height:1;margin-bottom:.28rem;}
.lux-stat-lbl{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(200,196,216,.45);font-weight:500;}
@media(max-width:768px){
  /* Hero grows to fit all content — no overflow clip so nothing is hidden */
  .lux-hero{min-height:100svh;overflow:visible;flex-direction:column;justify-content:flex-start;}
  /* Clip only the background elements inside their own overflow wrapper */
  .lux-hero-bg,.lux-hero-overlay,.lux-hero-side-glow,.lux-hero-grid{position:absolute;}
  /* Contain the scaled bg so it doesn't bleed outside hero */
  .lux-hero::before{content:'';position:absolute;inset:0;overflow:hidden;pointer-events:none;}
  /* Content: padding-top clears the global nav */
  .lux-hero-content{padding:7rem 1.2rem 2rem;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;}
  .lux-h1{font-size:clamp(1.9rem,7vw,2.6rem);margin-bottom:1rem;}
  .lux-tagline{font-size:.84rem;margin-bottom:1.8rem;}
  .lux-eyebrow{font-size:.62rem;margin-bottom:1.2rem;}
  .lux-eyebrow::before,.lux-eyebrow::after{width:24px;}
  .lux-ctas{gap:.65rem;margin-bottom:1.8rem;}
  .lux-btn-pri,.lux-btn-sec{padding:.78rem 1.6rem;font-size:.72rem;width:100%;text-align:center;box-sizing:border-box;}
  .lux-hero-search{max-width:100%;}
  .lux-hero-search-inp{font-size:.88rem;padding:.9rem 3rem .9rem 1.2rem;}
  /* Stats bar: in normal flow below content, not absolute */
  .lux-stats-bar{position:relative;bottom:auto;left:auto;right:auto;padding:1rem;flex-wrap:wrap;}
  .lux-stat{flex:0 1 50%;padding:.65rem 0;}
  .lux-stat:nth-child(2){border-right:none;}
  .lux-stat-num{font-size:1.6rem;}
}

/* ── Why Choose Us ── */
.wcu-sec{padding:7rem 2rem;background:#080812;position:relative;overflow:hidden;}
.wcu-sec::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 60% 40% at 50% 50%,rgba(191,155,78,.04) 0%,transparent 70%);pointer-events:none;}
.wcu-inner{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:5rem;align-items:center;}
.wcu-img-wrap{position:relative;flex-shrink:0;}
.wcu-img{width:100%;aspect-ratio:4/5;object-fit:cover;filter:brightness(.82);display:block;}
.wcu-img-frame{position:absolute;inset:0;border:1px solid rgba(191,155,78,.22);transform:translate(16px,16px);pointer-events:none;}
.wcu-img-badge{position:absolute;bottom:-24px;left:-24px;background:linear-gradient(135deg,#BF9B4E,#D4B880);padding:1.2rem 1.5rem;text-align:center;}
.wcu-img-badge-num{font-family:'Cormorant Garamond',serif;font-size:2.2rem;font-weight:600;color:#0A0A16;line-height:1;}
.wcu-img-badge-lbl{font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;color:rgba(10,10,22,.7);font-weight:600;margin-top:.25rem;}
.wcu-eyebrow{font-size:.66rem;letter-spacing:.25em;text-transform:uppercase;color:#BF9B4E;font-weight:600;margin-bottom:1rem;}
.wcu-title{font-family:'Cormorant Garamond',serif;font-size:clamp(2rem,3.5vw,2.8rem);font-weight:300;color:#F0EDE6;line-height:1.2;margin-bottom:1rem;}
.wcu-title em{font-style:italic;color:#BF9B4E;}
.wcu-desc{color:rgba(200,196,216,.58);font-size:.88rem;line-height:1.82;margin-bottom:2.5rem;}
.wcu-features{display:grid;grid-template-columns:1fr 1fr;gap:1rem;}
.wcu-feat{background:rgba(14,14,30,.85);border:1px solid rgba(191,155,78,.12);padding:1.2rem;transition:border-color .3s,transform .3s,box-shadow .3s;}
.wcu-feat:hover{border-color:rgba(191,155,78,.42);transform:translateY(-4px);box-shadow:0 12px 32px rgba(0,0,0,.4);}
.wcu-feat-icon{font-size:1.5rem;margin-bottom:.6rem;}
.wcu-feat-title{font-size:.82rem;font-weight:600;color:#F0EDE6;margin-bottom:.35rem;letter-spacing:.02em;}
.wcu-feat-desc{font-size:.74rem;color:rgba(200,196,216,.52);line-height:1.62;}
@media(max-width:768px){
  .wcu-inner{grid-template-columns:1fr;gap:3rem;}
  .wcu-img-wrap{display:none;}
  .wcu-sec{padding:4rem 1.25rem;}
}

/* ── Section label ── */
.sec-label{text-align:center;padding:5rem 2rem 2.5rem;background:#080812;}
.sec-label-eye{font-size:.66rem;letter-spacing:.25em;text-transform:uppercase;color:#BF9B4E;font-weight:600;margin-bottom:.7rem;}
.sec-label-title{font-family:'Cormorant Garamond',serif;font-size:clamp(1.8rem,3vw,2.6rem);font-weight:300;color:#F0EDE6;}
.sec-label-title em{font-style:italic;color:#BF9B4E;}
.sec-label-sub{color:rgba(200,196,216,.52);font-size:.86rem;margin-top:.5rem;}

/* ── Showcase Banner ── */
.showcase-sec{position:relative;height:55vh;min-height:380px;overflow:hidden;}
.showcase-bg{position:absolute;inset:0;background-image:url('https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1920&q=80');background-size:cover;background-position:center 35%;filter:brightness(.38);transition:transform 8s ease;}
.showcase-sec:hover .showcase-bg{transform:scale(1.04);}
.showcase-ov{position:absolute;inset:0;background:linear-gradient(135deg,rgba(4,4,14,.75) 0%,rgba(4,4,14,.25) 60%,rgba(4,4,14,.5) 100%);}
.showcase-content{position:relative;z-index:2;height:100%;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;padding:4rem;max-width:700px;}
.showcase-eyebrow{font-size:.63rem;letter-spacing:.28em;text-transform:uppercase;color:#BF9B4E;margin-bottom:1rem;font-weight:600;}
.showcase-title{font-family:'Cormorant Garamond',serif;font-size:clamp(2rem,4vw,3rem);font-weight:300;color:#F0EDE6;line-height:1.18;margin-bottom:1.2rem;}
.showcase-title em{font-style:italic;color:#BF9B4E;}
.showcase-sub{color:rgba(240,237,230,.55);font-size:.88rem;line-height:1.72;margin-bottom:2rem;max-width:440px;}
@media(max-width:768px){
  .showcase-content{padding:2rem 1.5rem;}
  .showcase-title{font-size:1.9rem;}
}

/* ── Luxury Footer ── */
.lux-ft{background:#04040E;border-top:1px solid rgba(191,155,78,.15);padding:4rem 2rem 2.5rem;margin-top:0;}
.lux-ft-inner{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:2fr 1fr 1fr;gap:3rem;margin-bottom:3rem;}
.lux-ft-logo{font-family:'Cormorant Garamond',serif;font-size:1.85rem;font-weight:600;color:#BF9B4E;letter-spacing:.04em;margin-bottom:.8rem;}
.lux-ft-logo span{color:#F0EDE6;font-weight:300;}
.lux-ft-tagline{font-size:.78rem;color:rgba(200,196,216,.42);line-height:1.72;max-width:280px;}
.lux-ft-col-title{font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;color:#BF9B4E;font-weight:600;margin-bottom:1.2rem;}
.lux-ft-links{display:flex;flex-direction:column;gap:.65rem;}
.lux-ft-link{font-size:.8rem;color:rgba(200,196,216,.48);cursor:pointer;transition:color .2s;text-decoration:none;background:none;border:none;text-align:left;font-family:'DM Sans',sans-serif;padding:0;}
.lux-ft-link:hover{color:#BF9B4E;}
.lux-ft-divider{height:1px;background:rgba(191,155,78,.1);max-width:1200px;margin:0 auto 1.5rem;}
.lux-ft-bottom{max-width:1200px;margin:0 auto;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem;}
.lux-ft-copy{font-size:.7rem;color:rgba(200,196,216,.28);}
.lux-ft-copy span{color:rgba(191,155,78,.55);}
@media(max-width:768px){
  .lux-ft-inner{grid-template-columns:1fr;gap:2rem;}
  .lux-ft{padding:3rem 1.25rem 2rem;}
}

/* ── CSS Animation helpers (replaces framer-motion) ── */
@keyframes luxFadeUp{0%{opacity:0;transform:translateY(28px);}100%{opacity:1;transform:translateY(0);}}
@keyframes luxFadeIn{0%{opacity:0;}100%{opacity:1;}}
.lux-anim{opacity:0;animation:luxFadeUp .85s cubic-bezier(.25,.1,.25,1) forwards;}
.lux-reveal{opacity:0;transition:opacity .75s ease,transform .75s ease;}
.lux-reveal.lux-revealed{opacity:1;transform:none!important;}
.lux-reveal-up{transform:translateY(30px);}
.lux-reveal-left{transform:translateX(-48px);}
.lux-reveal-right{transform:translateX(48px);}
@keyframes cardFadeUp{0%{opacity:0;transform:translateY(28px);}100%{opacity:1;transform:translateY(0);}}
.card-anim{opacity:0;animation:cardFadeUp .55s ease forwards;}
.lux-btn-pri{transition:transform .2s,box-shadow .2s;}
.lux-btn-pri:hover{transform:translateY(-2px);box-shadow:0 0 36px rgba(191,155,78,.48),0 8px 24px rgba(0,0,0,.4);}
.lux-btn-sec:hover{transform:translateY(-2px);}

/* ═══════════════════════════════════════════════════════════
   CINEMA DETAIL PAGE — Full Luxury Dark Redesign
═══════════════════════════════════════════════════════════ */
.cine-cursor{position:fixed;pointer-events:none;z-index:99999;mix-blend-mode:difference;width:12px;height:12px;border-radius:50%;background:#fff;transform:translate(-50%,-50%);transition:width .2s,height .2s,opacity .3s;}
.cine-cursor-ring{position:fixed;pointer-events:none;z-index:99998;width:40px;height:40px;border-radius:50%;border:1.5px solid rgba(191,155,78,.7);transform:translate(-50%,-50%);transition:width .25s,height .25s,border-color .25s,opacity .3s;}
.cine-cursor-ring.hovering{width:64px;height:64px;border-color:rgba(212,184,128,.9);box-shadow:0 0 24px rgba(191,155,78,.4);}
body.cine-active *{cursor:none !important;}
.cine-det{position:relative;min-height:100vh;background:#080810;color:#f0f0f0;font-family:'DM Sans',system-ui,sans-serif;overflow-x:hidden;}
.cine-blobs{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;}
.cine-blob{position:absolute;border-radius:50%;filter:blur(130px);animation:blobFloat 14s ease-in-out infinite;opacity:.12;}
.cine-blob.b1{width:600px;height:600px;left:-10%;top:-15%;background:radial-gradient(circle,#BF9B4E,transparent 70%);animation-duration:18s;}
.cine-blob.b2{width:500px;height:500px;right:-12%;top:20%;background:radial-gradient(circle,#D4B880,transparent 70%);animation-duration:14s;animation-delay:-5s;opacity:.08;}
.cine-blob.b3{width:400px;height:400px;left:30%;bottom:-10%;background:radial-gradient(circle,#BF9B4E,transparent 70%);animation-duration:20s;animation-delay:-9s;}
.cine-blob.b4{width:350px;height:350px;right:25%;top:55%;background:radial-gradient(circle,#A0842E,transparent 70%);animation-duration:16s;animation-delay:-3s;opacity:.07;}
@keyframes blobFloat{0%,100%{transform:translate(0,0) scale(1);}33%{transform:translate(30px,-20px) scale(1.05);}66%{transform:translate(-20px,25px) scale(.97);}}
.cine-nav{position:fixed;top:1.2rem;left:50%;transform:translateX(-50%);z-index:200;display:flex;align-items:center;gap:.4rem;background:rgba(8,8,16,.82);border:1px solid rgba(191,155,78,.2);border-radius:999px;padding:.45rem .6rem;backdrop-filter:blur(24px);box-shadow:0 8px 32px rgba(0,0,0,.5),inset 0 1px 0 rgba(191,155,78,.07);animation:cineNavFade .6s ease forwards;}
@keyframes cineNavFade{from{opacity:0;transform:translateX(-50%) translateY(-12px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}
.cine-back{display:flex;align-items:center;gap:.45rem;padding:.42rem .9rem;border-radius:999px;background:rgba(191,155,78,.07);border:1px solid rgba(191,155,78,.2);color:rgba(255,255,255,.8);font-size:.8rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:all .2s ease;}
.cine-back:hover{background:rgba(191,155,78,.15);border-color:rgba(191,155,78,.5);color:#D4B880;}
.cine-nav-divider{width:1px;height:20px;background:rgba(191,155,78,.18);margin:0 .2rem;}
.cine-nav-tab{padding:.42rem .9rem;border-radius:999px;background:transparent;border:1px solid transparent;color:rgba(255,255,255,.5);font-size:.78rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:all .2s ease;white-space:nowrap;}
.cine-nav-tab:hover{color:rgba(255,255,255,.85);background:rgba(191,155,78,.06);}
.cine-nav-tab.on{background:linear-gradient(135deg,rgba(191,155,78,.18),rgba(212,184,128,.12));border-color:rgba(191,155,78,.45);color:#D4B880;box-shadow:0 0 16px rgba(191,155,78,.15);}
.cine-hero{position:relative;height:100vh;min-height:600px;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;}
.cine-hero-bg{position:absolute;inset:0;z-index:0;}
.cine-hero-bg img{width:100%;height:100%;object-fit:cover;animation:cineZoom 22s ease-out forwards;}
@keyframes cineZoom{from{transform:scale(1.14);}to{transform:scale(1);}}
.cine-hero-overlay{position:absolute;inset:0;z-index:1;pointer-events:none;background:linear-gradient(180deg,rgba(8,8,16,.25) 0%,rgba(8,8,16,.05) 30%,rgba(8,8,16,.55) 65%,rgba(8,8,16,.97) 100%);} 
.cine-hero-side-glow{position:absolute;inset:0;z-index:1;pointer-events:none;background:radial-gradient(ellipse 50% 60% at 50% 100%,rgba(191,155,78,.07),transparent 60%);}
.cine-gal-nav{position:absolute;top:50%;right:1.5rem;transform:translateY(-50%);z-index:10;display:flex;flex-direction:column;gap:.5rem;}
.cine-gal-thumb{width:60px;height:44px;border-radius:7px;overflow:hidden;border:2px solid rgba(255,255,255,.15);cursor:pointer;transition:all .22s ease;opacity:.5;}
.cine-gal-thumb:hover{opacity:.85;border-color:rgba(191,155,78,.6);}
.cine-gal-thumb.on{opacity:1;border-color:#BF9B4E;box-shadow:0 0 14px rgba(191,155,78,.4);}
.cine-gal-thumb img{width:100%;height:100%;object-fit:cover;display:block;}
.cine-hero-nav-btn{position:absolute;top:50%;z-index:10;width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#fff;font-size:1.3rem;cursor:pointer;display:none;align-items:center;justify-content:center;backdrop-filter:blur(8px);transition:all .2s ease;transform:translateY(-50%);}
.cine-hero-nav-btn.prev{left:1rem;}
.cine-hero-nav-btn.next{right:1rem;left:auto;}
.cine-hero-nav-btn:hover{background:rgba(191,155,78,.18);border-color:rgba(191,155,78,.5);}
@media(max-width:768px){.cine-hero-nav-btn{display:flex;}}
/* Hero name-only overlay */
.cine-hero-content{position:relative;z-index:5;padding:2.5rem 6vw 4rem;animation:cineHeroRise .9s cubic-bezier(.22,1,.36,1) .2s both;}
@keyframes cineHeroRise{from{opacity:0;transform:translateY(36px);}to{opacity:1;transform:translateY(0);}}
.cine-hero-name-only{display:flex;flex-direction:column;gap:.9rem;}
.cine-tag-pill{display:inline-flex;align-items:center;gap:.4rem;padding:.3rem .9rem;border-radius:999px;font-size:.72rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#fff;backdrop-filter:blur(8px);box-shadow:0 4px 14px rgba(0,0,0,.35);align-self:flex-start;}
.cine-eyebrow{font-size:.78rem;letter-spacing:.22em;text-transform:uppercase;color:rgba(191,155,78,.85);font-weight:600;display:flex;align-items:center;gap:.55rem;}
.cine-eyebrow::before{content:'';width:28px;height:1px;background:rgba(191,155,78,.6);}
.cine-hero-title{font-family:'Cormorant Garamond',Georgia,serif;font-size:clamp(3.2rem,7vw,6.5rem);font-weight:300;line-height:1.0;background:linear-gradient(135deg,#fff 0%,#F0ECE4 45%,#D4B880 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:-.02em;text-shadow:none;}
/* Sub-hero info bar below the image */
.cine-hero-bar{background:rgba(8,8,16,.9);border-top:1px solid rgba(191,155,78,.18);border-bottom:1px solid rgba(191,155,78,.08);padding:1.8rem 6vw;display:flex;flex-wrap:wrap;align-items:center;gap:2rem;animation:cineHeroRise .8s cubic-bezier(.22,1,.36,1) .4s both;}
.cine-hero-bar-left{flex:1;min-width:220px;}
.cine-hero-bar-subtitle{font-size:1rem;color:rgba(255,255,255,.55);line-height:1.65;max-width:540px;margin-bottom:.9rem;}
.cine-hero-ctas{display:flex;flex-wrap:wrap;gap:.85rem;align-items:center;}
.cine-meta-row{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:.6rem;}
.cine-meta-chip{display:inline-flex;align-items:center;gap:.38rem;padding:.32rem .85rem;border-radius:999px;background:rgba(191,155,78,.07);border:1px solid rgba(191,155,78,.2);color:rgba(255,255,255,.75);font-size:.8rem;font-weight:500;backdrop-filter:blur(6px);transition:all .2s ease;}
.cine-meta-chip.accent{background:linear-gradient(135deg,rgba(191,155,78,.18),rgba(212,184,128,.12));border-color:rgba(191,155,78,.45);color:#D4B880;font-weight:700;font-size:.85rem;}
.cine-stats{display:flex;flex-wrap:wrap;gap:.65rem;flex-shrink:0;}
.cine-stat{background:rgba(191,155,78,.06);border:1px solid rgba(191,155,78,.18);border-radius:12px;padding:.9rem 1.3rem;backdrop-filter:blur(12px);transition:all .25s ease;min-width:110px;}
.cine-stat:hover{background:rgba(191,155,78,.12);border-color:rgba(191,155,78,.4);transform:translateY(-2px);box-shadow:0 8px 24px rgba(191,155,78,.12);}
.cine-stat-lbl{font-size:.68rem;letter-spacing:.14em;text-transform:uppercase;color:rgba(191,155,78,.6);margin-bottom:.32rem;}
.cine-stat-val{font-family:'Cormorant Garamond',Georgia,serif;font-size:1.5rem;font-weight:600;color:#F0ECE4;line-height:1.1;}
.cine-stat-val span{font-size:.78rem;font-family:'DM Sans',sans-serif;color:rgba(191,155,78,.85);font-weight:600;}
.cine-cta-pri{display:inline-flex;align-items:center;gap:.6rem;padding:.85rem 2.2rem;border-radius:999px;background:linear-gradient(135deg,#D4B880,#BF9B4E);color:#080810;font-size:.85rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;border:none;cursor:pointer;box-shadow:0 0 28px rgba(191,155,78,.35),0 8px 20px rgba(0,0,0,.3);transition:all .25s ease;}
.cine-cta-pri:hover{transform:translateY(-3px);box-shadow:0 0 48px rgba(191,155,78,.55),0 14px 30px rgba(0,0,0,.4);}
.cine-cta-sec{display:inline-flex;align-items:center;gap:.6rem;padding:.85rem 1.8rem;border-radius:999px;background:rgba(191,155,78,.06);border:1.5px solid rgba(191,155,78,.3);color:rgba(255,255,255,.82);font-size:.85rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;backdrop-filter:blur(8px);transition:all .25s ease;}
.cine-cta-sec:hover{background:rgba(191,155,78,.14);border-color:rgba(191,155,78,.6);color:#D4B880;transform:translateY(-3px);}
/* ── Detail Page FAB ── */
.cine-fab{position:fixed;bottom:2rem;right:2rem;z-index:200;display:flex;flex-direction:column;align-items:flex-end;gap:.6rem;}
.cine-fab-actions{display:flex;flex-direction:column;align-items:flex-end;gap:.5rem;pointer-events:none;}
.cine-fab-actions.open{pointer-events:auto;}
.cine-fab-action{display:flex;align-items:center;gap:.65rem;padding:.6rem 1.1rem .6rem .85rem;border-radius:999px;border:1.5px solid rgba(191,155,78,.38);background:rgba(4,4,14,.92);color:#D4B880;font-family:'DM Sans',sans-serif;font-size:.76rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;cursor:pointer;backdrop-filter:blur(18px);box-shadow:0 8px 28px rgba(0,0,0,.45);white-space:nowrap;opacity:0;transform:translateY(12px) scale(.95);transition:opacity .22s ease,transform .22s ease,background .2s,box-shadow .2s;}
.cine-fab-actions.open .cine-fab-action{opacity:1;transform:translateY(0) scale(1);}
.cine-fab-actions.open .cine-fab-action:nth-child(1){transition-delay:.05s;}
.cine-fab-actions.open .cine-fab-action:nth-child(2){transition-delay:.0s;}
.cine-fab-action:hover{background:rgba(191,155,78,.15);border-color:#BF9B4E;box-shadow:0 0 28px rgba(191,155,78,.3),0 8px 28px rgba(0,0,0,.5);}
.cine-fab-action-ico{font-size:1rem;line-height:1;flex-shrink:0;}
.cine-fab-main{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#D4B880,#BF9B4E);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 0 32px rgba(191,155,78,.45),0 8px 24px rgba(0,0,0,.5);transition:transform .25s ease,box-shadow .25s ease;position:relative;flex-shrink:0;}
.cine-fab-main:hover{transform:scale(1.08);box-shadow:0 0 48px rgba(191,155,78,.65),0 12px 32px rgba(0,0,0,.55);}
.cine-fab-main-ico{color:#080810;font-size:1.3rem;font-weight:700;line-height:1;transition:opacity .25s ease,transform .25s ease;user-select:none;position:absolute;}
.cine-fab-main-ico.phone{opacity:1;transform:scale(1) rotate(0deg);}
.cine-fab-main-ico.close{opacity:0;transform:scale(.5) rotate(-90deg);}
.cine-fab-main.open .cine-fab-main-ico.phone{opacity:0;transform:scale(.5) rotate(90deg);}
.cine-fab-main.open .cine-fab-main-ico.close{opacity:1;transform:scale(1) rotate(0deg);}
@media(max-width:768px){.cine-fab{bottom:1.25rem;right:1.25rem;}.cine-fab-main{width:46px;height:46px;}.cine-fab-action{font-size:.7rem;padding:.55rem .9rem .55rem .75rem;}}
/* ── Back-to-Top FAB (mobile listing only) ── */
.btt-fab{display:none;}
@media(max-width:992px){
  .btt-fab{display:flex;align-items:center;justify-content:center;position:fixed;bottom:2rem;right:2rem;z-index:300;width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#D4B880,#BF9B4E);border:none;cursor:pointer;box-shadow:0 0 24px rgba(191,155,78,.45),0 6px 18px rgba(0,0,0,.45);transition:opacity .28s ease,transform .28s ease;}
  .btt-fab.hidden{opacity:0;transform:translateY(14px) scale(.88);pointer-events:none;}
  .btt-fab.visible{opacity:1;transform:translateY(0) scale(1);pointer-events:auto;}
  .btt-fab svg{width:18px;height:18px;stroke:#080810;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;fill:none;}
  .btt-fab:hover{box-shadow:0 0 36px rgba(191,155,78,.65),0 8px 24px rgba(0,0,0,.55);}
}
.cine-sections{position:relative;z-index:5;}
.cine-section{padding:5rem 6vw;position:relative;}
.cine-section+.cine-section{border-top:1px solid rgba(191,155,78,.06);}
.cine-sec-label{margin-bottom:3rem;}
.cine-sec-eyebrow{font-size:.72rem;letter-spacing:.28em;text-transform:uppercase;color:rgba(191,155,78,.75);font-weight:600;display:flex;align-items:center;gap:.6rem;margin-bottom:.8rem;}
.cine-sec-eyebrow::before{content:'';width:24px;height:1px;background:rgba(191,155,78,.5);}
.cine-sec-title{font-family:'Cormorant Garamond',Georgia,serif;font-size:clamp(2.2rem,4vw,3.4rem);font-weight:300;color:#F0ECE4;letter-spacing:-.01em;line-height:1.15;}
.cine-sec-title em{font-style:italic;background:linear-gradient(135deg,#D4B880,#BF9B4E);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.cine-bento{display:grid;grid-template-columns:repeat(3,1fr);gap:1.2rem;}
.cine-bento-card{position:relative;overflow:hidden;background:rgba(191,155,78,.03);border:1px solid rgba(191,155,78,.1);border-radius:16px;padding:2rem;cursor:default;transition:all .3s ease;}
.cine-bento-card:hover{background:rgba(191,155,78,.07);border-color:rgba(191,155,78,.3);transform:translateY(-4px);box-shadow:0 20px 48px rgba(0,0,0,.4),0 0 32px rgba(191,155,78,.08);}
.cine-bento-card.lg{grid-column:span 2;}
.cine-bento-icon{width:52px;height:52px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:1.6rem;margin-bottom:1.4rem;background:linear-gradient(135deg,rgba(191,155,78,.14),rgba(212,184,128,.08));border:1px solid rgba(191,155,78,.22);box-shadow:0 0 20px rgba(191,155,78,.1);transition:all .3s ease;}
.cine-bento-card:hover .cine-bento-icon{background:linear-gradient(135deg,rgba(191,155,78,.24),rgba(212,184,128,.16));box-shadow:0 0 32px rgba(191,155,78,.28);transform:scale(1.05);}
.cine-bento-title{font-size:1.05rem;font-weight:600;color:#F0ECE4;margin-bottom:.5rem;letter-spacing:-.01em;}
.cine-bento-desc{font-size:.88rem;color:rgba(255,255,255,.42);line-height:1.6;}
.cine-bento-accent{position:absolute;bottom:0;left:0;right:0;height:2px;border-radius:0 0 16px 16px;background:linear-gradient(90deg,transparent,rgba(191,155,78,.5),transparent);opacity:0;transition:opacity .3s ease;}
.cine-bento-card:hover .cine-bento-accent{opacity:1;}
.cine-info-group{margin-bottom:2.5rem;}
.cine-info-group-title{font-size:.78rem;letter-spacing:.18em;text-transform:uppercase;color:rgba(191,155,78,.8);font-weight:700;display:flex;align-items:center;gap:.6rem;margin-bottom:1.2rem;padding-bottom:.65rem;border-bottom:1px solid rgba(191,155,78,.1);}
.cine-info-group-title::before{content:'';width:18px;height:2px;background:linear-gradient(90deg,#BF9B4E,#D4B880);border-radius:2px;}
.cine-spec-table{background:rgba(191,155,78,.025);border:1px solid rgba(191,155,78,.1);border-radius:12px;overflow:hidden;}
.cine-spec-row{display:flex;align-items:baseline;padding:.8rem 1.4rem;border-bottom:1px solid rgba(191,155,78,.07);transition:background .15s ease;}
.cine-spec-row:last-child{border-bottom:none;}
.cine-spec-row:hover{background:rgba(191,155,78,.04);}
.cine-spec-key{font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(191,155,78,.6);font-weight:600;min-width:170px;flex-shrink:0;}
.cine-spec-val{font-size:.95rem;color:rgba(255,255,255,.82);font-weight:500;flex:1;line-height:1.55;}
.cine-desc-block{background:rgba(191,155,78,.03);border:1px solid rgba(191,155,78,.1);border-left:3px solid rgba(191,155,78,.5);border-radius:0 12px 12px 0;padding:1.8rem 2rem;font-size:1rem;line-height:1.85;color:rgba(255,255,255,.65);position:relative;margin-bottom:2rem;}
.cine-desc-block::before{content:'\u201C';position:absolute;top:-.4rem;left:1rem;font-family:'Cormorant Garamond',Georgia,serif;font-size:4rem;color:rgba(191,155,78,.18);line-height:1;}
.cine-fac-chips{display:flex;flex-wrap:wrap;gap:.5rem;}
.cine-fac-chip{display:inline-flex;align-items:center;gap:.35rem;padding:.4rem .95rem;border-radius:999px;background:rgba(191,155,78,.05);border:1px solid rgba(191,155,78,.15);font-size:.82rem;color:rgba(255,255,255,.58);transition:all .2s ease;}
.cine-fac-chip::before{content:'';width:4px;height:4px;border-radius:50%;background:rgba(191,155,78,.7);}
.cine-fac-chip:hover{background:rgba(191,155,78,.12);border-color:rgba(191,155,78,.35);color:#D4B880;}
.cine-loc{display:grid;grid-template-columns:1fr 1fr;gap:2.5rem;align-items:start;}
.cine-map-wrap{position:relative;height:420px;border-radius:16px;overflow:hidden;border:1px solid rgba(191,155,78,.15);box-shadow:0 24px 64px rgba(0,0,0,.5);margin-bottom:1.5rem;}
.cine-map-wrap iframe{width:100%;height:100%;border:none;display:block;filter:saturate(.8) brightness(.85);}
.cine-map-placeholder{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(191,155,78,.03);color:rgba(255,255,255,.4);gap:.6rem;font-size:.85rem;}
.cine-map-overlay-tag{position:absolute;bottom:1rem;left:1rem;background:rgba(8,8,16,.88);border:1px solid rgba(191,155,78,.25);border-radius:10px;padding:.6rem 1rem;backdrop-filter:blur(12px);color:rgba(255,255,255,.82);font-size:.85rem;font-weight:600;display:flex;align-items:center;gap:.5rem;}
.cine-loc-dist-cards{display:grid;grid-template-columns:1fr 1fr;gap:.75rem;}
.cine-loc-dist-card{background:rgba(191,155,78,.04);border:1px solid rgba(191,155,78,.12);border-radius:12px;padding:.95rem 1.1rem;transition:all .2s ease;}
.cine-loc-dist-card:hover{background:rgba(191,155,78,.09);border-color:rgba(191,155,78,.3);transform:translateY(-2px);}
.cine-loc-dist-card .lbl{font-size:.68rem;letter-spacing:.12em;text-transform:uppercase;color:rgba(191,155,78,.6);margin-bottom:.32rem;}
.cine-loc-dist-card .val{font-size:.95rem;font-weight:600;color:#F0ECE4;}
.cine-amenities-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;}
.cine-amenity-card{background:rgba(191,155,78,.03);border:1px solid rgba(191,155,78,.1);border-radius:14px;overflow:hidden;transition:all .28s ease;}
.cine-amenity-card:hover{background:rgba(191,155,78,.07);border-color:rgba(191,155,78,.3);transform:translateY(-3px);box-shadow:0 12px 32px rgba(0,0,0,.3),0 0 24px rgba(191,155,78,.08);}
.cine-amenity-hd{display:flex;align-items:center;gap:.55rem;padding:.8rem 1rem;background:rgba(191,155,78,.05);border-bottom:1px solid rgba(191,155,78,.08);font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.72);font-weight:700;}
.cine-amenity-icon{width:30px;height:30px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:1rem;background:linear-gradient(135deg,rgba(191,155,78,.12),rgba(212,184,128,.08));border:1px solid rgba(191,155,78,.2);}
.cine-amenity-item{display:flex;align-items:center;gap:.5rem;padding:.55rem 1rem;font-size:.84rem;color:rgba(255,255,255,.52);border-bottom:1px solid rgba(255,255,255,.03);transition:all .15s ease;}
.cine-amenity-item:last-child{border-bottom:none;}
.cine-amenity-item:hover{color:rgba(255,255,255,.85);background:rgba(191,155,78,.04);padding-left:1.3rem;}
.cine-amenity-dot{width:4px;height:4px;border-radius:50%;background:rgba(191,155,78,.65);flex-shrink:0;}
.cine-unit-list{display:flex;flex-direction:column;gap:2.5rem;}
.cine-unit-card{display:grid;grid-template-columns:1fr 1fr;background:rgba(191,155,78,.025);border:1px solid rgba(191,155,78,.1);border-radius:20px;overflow:hidden;transition:all .35s ease;}
.cine-unit-card:nth-child(even){direction:rtl;}
.cine-unit-card:nth-child(even)>*{direction:ltr;}
.cine-unit-card:hover{border-color:rgba(191,155,78,.3);box-shadow:0 24px 60px rgba(0,0,0,.45),0 0 40px rgba(191,155,78,.07);}
.cine-unit-img{position:relative;overflow:hidden;min-height:300px;}
.cine-unit-img img{width:100%;height:100%;object-fit:cover;transition:transform .8s ease;display:block;}
.cine-unit-card:hover .cine-unit-img img{transform:scale(1.06);}
.cine-unit-img-overlay{position:absolute;inset:0;background:linear-gradient(135deg,rgba(8,8,16,.18),rgba(8,8,16,.42));pointer-events:none;}
.cine-unit-img-label{position:absolute;top:1rem;left:1rem;background:rgba(8,8,16,.82);border:1px solid rgba(191,155,78,.35);border-radius:8px;padding:.35rem .8rem;font-size:.72rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#D4B880;backdrop-filter:blur(8px);}
.cine-unit-noimg{width:100%;height:100%;min-height:300px;display:flex;align-items:center;justify-content:center;background:rgba(191,155,78,.02);font-size:3rem;}
.cine-unit-body{padding:2.6rem 2.6rem;display:flex;flex-direction:column;justify-content:space-between;gap:1rem;}
.cine-unit-label{font-size:.7rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(191,155,78,.75);font-weight:700;margin-bottom:.3rem;}
.cine-unit-name{font-family:'Cormorant Garamond',Georgia,serif;font-size:2.1rem;font-weight:300;color:#F0ECE4;line-height:1.1;margin-bottom:.5rem;letter-spacing:-.01em;}
.cine-unit-price{display:inline-flex;align-items:baseline;gap:.4rem;padding:.55rem 1.1rem;border-radius:999px;background:linear-gradient(135deg,rgba(191,155,78,.12),rgba(212,184,128,.07));border:1px solid rgba(191,155,78,.28);margin-bottom:.3rem;align-self:flex-start;}
.cine-unit-price-lbl{font-size:.68rem;text-transform:uppercase;letter-spacing:.12em;color:rgba(191,155,78,.6);}
.cine-unit-price-val{font-family:'Cormorant Garamond',Georgia,serif;font-size:1.55rem;font-weight:600;color:#D4B880;}
.cine-unit-pills{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0;}
.cine-unit-pill{display:inline-flex;align-items:center;gap:.4rem;padding:.4rem .95rem;border-radius:999px;background:rgba(191,155,78,.05);border:1px solid rgba(191,155,78,.18);font-size:.82rem;color:rgba(255,255,255,.68);font-weight:500;transition:all .2s ease;}
.cine-unit-pill:hover{background:rgba(191,155,78,.12);border-color:rgba(191,155,78,.35);}
.cine-unit-desc{font-size:.95rem;color:rgba(255,255,255,.5);line-height:1.75;flex:1;}
.cine-unit-cta{display:inline-flex;align-items:center;gap:.5rem;padding:.7rem 1.8rem;border-radius:999px;background:rgba(191,155,78,.07);border:1.5px solid rgba(191,155,78,.28);color:rgba(255,255,255,.78);font-size:.82rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:all .25s ease;align-self:flex-start;}
.cine-unit-cta:hover{background:rgba(191,155,78,.16);border-color:rgba(191,155,78,.55);color:#D4B880;transform:translateX(3px);}
.cine-unit-empty{text-align:center;padding:4rem 2rem;color:rgba(255,255,255,.35);font-size:1rem;}
.cine-upgrades{background:rgba(191,155,78,.025);border:1px solid rgba(191,155,78,.1);border-radius:14px;padding:1.8rem 2rem;margin-top:2rem;}
.cine-upgrades-title{font-size:.72rem;letter-spacing:.18em;text-transform:uppercase;color:rgba(191,155,78,.8);font-weight:700;margin-bottom:1rem;display:flex;align-items:center;gap:.5rem;}
.cine-upgrades-title::before{content:'';width:16px;height:2px;background:linear-gradient(90deg,#BF9B4E,#D4B880);}
.cine-upgrades-body{font-size:.95rem;color:rgba(255,255,255,.55);line-height:1.75;}
.cine-footer{position:relative;overflow:hidden;padding:7rem 6vw 5rem;text-align:center;background:linear-gradient(180deg,transparent,rgba(4,4,8,.97) 40%,rgba(4,4,8,1) 100%);}
.cine-footer::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 80% 60% at 50% 0%,rgba(191,155,78,.07),transparent 55%),radial-gradient(ellipse 50% 40% at 50% 100%,rgba(191,155,78,.05),transparent 50%);pointer-events:none;}
.cine-footer-eye{font-size:.72rem;letter-spacing:.28em;text-transform:uppercase;color:rgba(191,155,78,.65);margin-bottom:1rem;position:relative;}
.cine-footer-title{font-family:'Cormorant Garamond',Georgia,serif;font-size:clamp(2.5rem,6vw,5rem);font-weight:300;color:#F0ECE4;letter-spacing:-.02em;line-height:1.05;margin-bottom:1rem;position:relative;}
.cine-footer-title em{font-style:italic;background:linear-gradient(135deg,#D4B880,#BF9B4E);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.cine-footer-sub{font-size:1rem;color:rgba(255,255,255,.42);max-width:520px;margin:0 auto 3rem;line-height:1.65;position:relative;}
.cine-footer-btns{display:flex;justify-content:center;align-items:center;gap:1rem;flex-wrap:wrap;position:relative;}
.cine-footer-bottom{margin-top:4rem;padding-top:2rem;border-top:1px solid rgba(191,155,78,.1);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.75rem;font-size:.78rem;color:rgba(255,255,255,.22);}
.cine-footer-logo{font-family:'Cormorant Garamond',Georgia,serif;font-size:1.2rem;color:rgba(191,155,78,.55);}

/* ═══════════════════════════════════════════
   LUXURY PROJECT INFO REDESIGN  (lux-pi-*)
═══════════════════════════════════════════ */
.lux-pi-wrap{display:flex;flex-direction:column;gap:1.4rem;position:relative;isolation:isolate;}
.lux-pi-wrap>*:not(.lux-pi-atmo){position:relative;z-index:2;}
.lux-pi-atmo{position:absolute;inset:-2rem -1rem -1rem -1rem;z-index:1;pointer-events:none;overflow:hidden;}
.lux-pi-orb{position:absolute;border-radius:50%;filter:blur(32px);opacity:.18;animation:luxFloat 14s ease-in-out infinite;}
.lux-pi-orb.o1{width:220px;height:220px;left:-30px;top:90px;background:radial-gradient(circle,rgba(191,155,78,.55),transparent 68%);animation-duration:16s;}
.lux-pi-orb.o2{width:260px;height:260px;right:-40px;top:-20px;background:radial-gradient(circle,rgba(212,184,128,.45),transparent 70%);animation-duration:18s;animation-delay:-6s;}
.lux-pi-orb.o3{width:180px;height:180px;left:35%;bottom:60px;background:radial-gradient(circle,rgba(191,155,78,.35),transparent 70%);animation-duration:13s;animation-delay:-3s;}
.lux-pi-orb.o4{width:150px;height:150px;right:22%;bottom:20px;background:radial-gradient(circle,rgba(160,120,128,.25),transparent 72%);animation-duration:12s;animation-delay:-8s;}
.lux-pi-ray{position:absolute;width:52%;height:1px;background:linear-gradient(90deg,transparent,rgba(191,155,78,.48),transparent);opacity:.28;transform:rotate(-10deg);animation:luxSweep 8s ease-in-out infinite;}
.lux-pi-ray.r1{top:28%;left:-6%;}
.lux-pi-ray.r2{bottom:18%;right:-8%;transform:rotate(12deg);animation-delay:-3.2s;}
.lux-pi-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(191,155,78,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(191,155,78,.05) 1px,transparent 1px);background-size:38px 38px;mask-image:radial-gradient(circle at 50% 50%,#000 24%,transparent 82%);opacity:.3;animation:luxGridDrift 14s linear infinite;}
.lux-pi-spark{position:absolute;width:5px;height:5px;border-radius:50%;background:rgba(212,184,128,.8);box-shadow:0 0 14px rgba(191,155,78,.65);animation:luxTwinkle 2.8s ease-in-out infinite;}
.lux-pi-spark.s1{left:12%;top:24%;animation-delay:.1s;}
.lux-pi-spark.s2{left:76%;top:17%;animation-delay:.7s;}
.lux-pi-spark.s3{left:58%;top:51%;animation-delay:1.3s;}
.lux-pi-spark.s4{left:26%;top:67%;animation-delay:.4s;}
.lux-pi-spark.s5{left:86%;top:63%;animation-delay:1.9s;}
.lux-pi-spark.s6{left:45%;top:83%;animation-delay:2.4s;}

.lux-pi-hero-card{background:rgba(14,14,30,.5);border:1px solid rgba(191,155,78,.2);border-radius:36px;backdrop-filter:blur(20px);overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.35);transform-style:preserve-3d;animation:luxCardRise .9s cubic-bezier(.22,1,.36,1) both;}
.lux-pi-hero-card::before{content:'';position:absolute;inset:0;border-radius:inherit;padding:1px;background:linear-gradient(120deg,rgba(191,155,78,.15),rgba(255,255,255,.05),rgba(191,155,78,.22));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;animation:luxBorderFlow 6s linear infinite;}
.lux-pi-hero-card::after{content:'';position:absolute;inset:-45% -20%;background:linear-gradient(105deg,transparent 36%,rgba(255,255,255,.14) 50%,transparent 64%);transform:translateX(-45%) rotate(4deg);animation:luxGlassSweep 6.6s cubic-bezier(.22,1,.36,1) infinite;pointer-events:none;mix-blend-mode:screen;}
.lux-pi-hero-grid{display:grid;grid-template-columns:3fr 2fr;}
.lux-pi-hero-left{padding:2.4rem 2.6rem;border-right:1px solid rgba(191,155,78,.12);}
.lux-pi-hero-right{padding:2.4rem 2.1rem;background:linear-gradient(180deg,rgba(191,155,78,.08),rgba(191,155,78,.02));}
.lux-pi-eyebrow{font-size:.68rem;letter-spacing:.35em;text-transform:uppercase;color:rgba(212,184,128,.62);margin-bottom:.85rem;font-weight:600;}
.lux-pi-title{font-family:'Cormorant Garamond',Georgia,serif;font-size:clamp(2.3rem,4.8vw,4.4rem);line-height:.98;font-weight:500;color:#F0ECE4;letter-spacing:-.01em;position:relative;display:inline-block;}
.lux-pi-title-accent{display:block;font-style:italic;color:#D4B880;font-weight:600;}
.lux-pi-title-accent{animation:luxPulseText 3.6s ease-in-out infinite;}
.lux-pi-desc{margin-top:1.15rem;max-width:760px;font-size:1rem;line-height:1.8;color:rgba(255,255,255,.6);}
.lux-pi-quick-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.75rem;margin-top:1.45rem;}
.lux-pi-quick-card{padding:.95rem 1rem;border-radius:18px;background:rgba(255,255,255,.06);border:1px solid rgba(191,155,78,.18);transition:all .28s cubic-bezier(.22,1,.36,1);position:relative;overflow:hidden;animation:luxCardRise .8s cubic-bezier(.22,1,.36,1) both;}
.lux-pi-quick-grid .lux-pi-quick-card:nth-child(1){animation-delay:.08s;}
.lux-pi-quick-grid .lux-pi-quick-card:nth-child(2){animation-delay:.16s;}
.lux-pi-quick-grid .lux-pi-quick-card:nth-child(3){animation-delay:.24s;}
.lux-pi-quick-grid .lux-pi-quick-card:nth-child(4){animation-delay:.32s;}
.lux-pi-quick-card::before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 20% 0%,rgba(191,155,78,.25),transparent 58%);opacity:0;transition:opacity .25s ease;}
.lux-pi-quick-card::after{content:'';position:absolute;inset:auto -40% 0 -40%;height:2px;background:linear-gradient(90deg,transparent,rgba(191,155,78,.7),transparent);opacity:.22;animation:luxLineRun 4s linear infinite;}
.lux-pi-quick-card:hover{transform:translateY(-4px) scale(1.01);border-color:rgba(191,155,78,.45);box-shadow:0 14px 32px rgba(0,0,0,.26),0 0 24px rgba(191,155,78,.15);}
.lux-pi-quick-card:hover::before{opacity:1;}
.lux-pi-quick-lbl{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(212,184,128,.56);margin-bottom:.35rem;}
.lux-pi-quick-val{font-family:'Cormorant Garamond',Georgia,serif;font-size:1.3rem;font-weight:600;color:#F0ECE4;line-height:1.2;}
.lux-pi-side-stack{display:flex;flex-direction:column;gap:0;}
.lux-pi-side-block{padding:.95rem 0;border-bottom:1px solid rgba(191,155,78,.14);animation:luxFadeSlide .75s cubic-bezier(.22,1,.36,1) both;}
.lux-pi-side-stack .lux-pi-side-block:nth-child(1){animation-delay:.14s;}
.lux-pi-side-stack .lux-pi-side-block:nth-child(2){animation-delay:.22s;}
.lux-pi-side-stack .lux-pi-side-block:nth-child(3){animation-delay:.3s;}
.lux-pi-side-stack .lux-pi-side-block:nth-child(4){animation-delay:.38s;}
.lux-pi-side-block:last-child{border-bottom:none;}
.lux-pi-side-lbl{font-size:.62rem;letter-spacing:.25em;text-transform:uppercase;color:rgba(212,184,128,.58);margin-bottom:.35rem;}
.lux-pi-side-val{font-family:'Cormorant Garamond',Georgia,serif;font-size:1.35rem;font-weight:600;color:#F0ECE4;line-height:1.3;}

.lux-pi-detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem;}
.lux-pi-panel{background:rgba(14,14,30,.52);border:1px solid rgba(191,155,78,.15);border-radius:30px;padding:1.35rem 1.25rem;backdrop-filter:blur(14px);box-shadow:0 18px 44px rgba(0,0,0,.28);transition:transform .32s cubic-bezier(.22,1,.36,1),border-color .24s ease,box-shadow .24s ease;position:relative;overflow:hidden;animation:luxCardRise .9s cubic-bezier(.22,1,.36,1) both;}
.lux-pi-detail-grid .lux-pi-panel:nth-child(1){animation-delay:.1s;}
.lux-pi-detail-grid .lux-pi-panel:nth-child(2){animation-delay:.18s;}
.lux-pi-detail-grid .lux-pi-panel:nth-child(3){animation-delay:.26s;}
.lux-pi-panel::before{content:'';position:absolute;inset:0;background:linear-gradient(120deg,rgba(191,155,78,.11),transparent 45%,rgba(191,155,78,.09));opacity:0;transition:opacity .25s ease;pointer-events:none;}
.lux-pi-panel::after{content:'';position:absolute;top:-120%;left:50%;width:80%;height:220%;background:linear-gradient(180deg,transparent,rgba(191,155,78,.18),transparent);transform:translateX(-50%) rotate(8deg);opacity:0;transition:opacity .25s ease;pointer-events:none;}
.lux-pi-panel:hover{transform:translateY(-6px);border-color:rgba(191,155,78,.4);box-shadow:0 22px 48px rgba(0,0,0,.32),0 0 24px rgba(191,155,78,.14);}
.lux-pi-panel:hover::before,.lux-pi-panel:hover::after{opacity:1;}
.lux-pi-panel-head{display:flex;align-items:center;gap:.55rem;margin-bottom:1rem;}
.lux-pi-panel-dot{width:.62rem;height:.62rem;border-radius:50%;background:#D4B880;box-shadow:0 0 10px rgba(191,155,78,.4);animation:luxPulseDot 2.5s ease-in-out infinite;}
.lux-pi-panel-hd{font-size:.62rem;letter-spacing:.3em;text-transform:uppercase;color:rgba(212,184,128,.62);font-weight:600;}
.lux-pi-lines{display:flex;flex-direction:column;gap:.75rem;}
.lux-pi-line-item{display:flex;flex-direction:column;gap:.2rem;}
.lux-pi-line-lbl{font-size:.62rem;letter-spacing:.19em;text-transform:uppercase;color:rgba(212,184,128,.48);}
.lux-pi-line-val{font-size:.95rem;color:rgba(255,255,255,.78);line-height:1.55;}

.lux-pi-fac-pills{display:flex;flex-wrap:wrap;gap:.45rem;}
.lux-pi-fac-pill{display:inline-flex;align-items:center;gap:.35rem;padding:.42rem .85rem;border-radius:16px;background:rgba(191,155,78,.08);border:1px solid rgba(191,155,78,.2);font-size:.8rem;color:rgba(240,237,230,.72);transition:all .2s ease;animation:luxFadeSlide .6s cubic-bezier(.22,1,.36,1) both;position:relative;overflow:hidden;}
.lux-pi-fac-pill::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,transparent 20%,rgba(255,255,255,.2) 50%,transparent 80%);transform:translateX(-120%);transition:transform .5s ease;}
.lux-pi-fac-pill:hover{transform:translateY(-2px);background:rgba(191,155,78,.16);border-color:rgba(191,155,78,.4);}
.lux-pi-fac-pill:hover::after{transform:translateX(120%);}
.lux-pi-park-wrap{margin-top:1rem;padding-top:1rem;border-top:1px solid rgba(191,155,78,.15);}
.lux-pi-note{margin-top:.7rem;padding:.72rem .8rem;border-radius:14px;background:rgba(191,155,78,.1);border:1px solid rgba(191,155,78,.2);font-size:.82rem;line-height:1.6;color:rgba(240,237,230,.78);}

.lux-pi-fin-wrap{padding:1.25rem;background:rgba(14,14,30,.52);border:1px solid rgba(191,155,78,.15);border-radius:30px;backdrop-filter:blur(14px);box-shadow:0 18px 44px rgba(0,0,0,.28);position:relative;overflow:hidden;animation:luxCardRise .95s cubic-bezier(.22,1,.36,1) both;animation-delay:.2s;}
.lux-pi-fin-wrap::before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 90% 18%,rgba(191,155,78,.18),transparent 45%),radial-gradient(circle at 12% 100%,rgba(191,155,78,.1),transparent 48%);opacity:.5;pointer-events:none;}
.lux-pi-fin-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.8rem;}
.lux-pi-fin-card{padding:.95rem 1rem;border-radius:18px;background:rgba(191,155,78,.08);border:1px solid rgba(191,155,78,.2);transition:all .24s ease;position:relative;overflow:hidden;animation:luxCardRise .75s cubic-bezier(.22,1,.36,1) both;}
.lux-pi-fin-grid .lux-pi-fin-card:nth-child(1){animation-delay:.12s;}
.lux-pi-fin-grid .lux-pi-fin-card:nth-child(2){animation-delay:.2s;}
.lux-pi-fin-grid .lux-pi-fin-card:nth-child(3){animation-delay:.28s;}
.lux-pi-fin-grid .lux-pi-fin-card:nth-child(4){animation-delay:.36s;}
.lux-pi-fin-card::after{content:'';position:absolute;inset:auto -35% 0 -35%;height:2px;background:linear-gradient(90deg,transparent,rgba(191,155,78,.75),transparent);animation:luxLineRun 4.8s linear infinite;opacity:.35;}
.lux-pi-fin-card:hover{transform:translateY(-4px) scale(1.01);border-color:rgba(191,155,78,.42);box-shadow:0 14px 32px rgba(0,0,0,.25),0 0 22px rgba(191,155,78,.14);}
.lux-pi-fin-lbl{font-size:.62rem;letter-spacing:.2em;text-transform:uppercase;color:rgba(212,184,128,.58);margin-bottom:.3rem;}
.lux-pi-fin-val{font-family:'Cormorant Garamond',Georgia,serif;font-size:1.18rem;font-weight:600;color:#F0ECE4;line-height:1.35;}
.lux-pi-fin-sub{font-size:.76rem;color:rgba(255,255,255,.44);margin-top:.25rem;line-height:1.5;}

@keyframes luxFloat{0%,100%{transform:translate(0,0) scale(1);}33%{transform:translate(16px,-22px) scale(1.08);}66%{transform:translate(-10px,18px) scale(.94);}}
@keyframes luxSweep{0%,100%{opacity:.05;transform:translateX(0) rotate(-10deg);}50%{opacity:.35;transform:translateX(16px) rotate(-10deg);}}
@keyframes luxGridDrift{0%{transform:translateY(0);}100%{transform:translateY(38px);}}
@keyframes luxTwinkle{0%,100%{opacity:.2;transform:scale(.75);}50%{opacity:.95;transform:scale(1.3);}}
@keyframes luxBorderFlow{0%{filter:hue-rotate(0deg);}100%{filter:hue-rotate(360deg);}}
@keyframes luxGlassSweep{0%{transform:translateX(-55%) rotate(4deg);}55%{transform:translateX(55%) rotate(4deg);}100%{transform:translateX(55%) rotate(4deg);}}
@keyframes luxPulseText{0%,100%{text-shadow:0 0 0 rgba(191,155,78,0);}50%{text-shadow:0 0 14px rgba(191,155,78,.22);}}
@keyframes luxLineRun{0%{transform:translateX(-10%);}100%{transform:translateX(110%);}}
@keyframes luxPulseDot{0%,100%{transform:scale(1);box-shadow:0 0 10px rgba(191,155,78,.35);}50%{transform:scale(1.35);box-shadow:0 0 20px rgba(191,155,78,.62);}}
@keyframes luxCardRise{from{opacity:0;transform:translateY(22px) scale(.98);}to{opacity:1;transform:translateY(0) scale(1);}}
@keyframes luxFadeSlide{from{opacity:0;transform:translateX(-8px);}to{opacity:1;transform:translateX(0);}}

@media (prefers-reduced-motion: reduce){
  .lux-pi-wrap *, .lux-pi-wrap *::before, .lux-pi-wrap *::after{animation:none !important;transition:none !important;}
}

@media(max-width:1200px){
  .lux-pi-quick-grid{grid-template-columns:repeat(2,minmax(0,1fr));}
  .lux-pi-fin-grid{grid-template-columns:repeat(2,minmax(0,1fr));}
}
@media(max-width:920px){
  .lux-pi-hero-grid{grid-template-columns:1fr;}
  .lux-pi-hero-left{border-right:none;border-bottom:1px solid rgba(191,155,78,.12);}
  .lux-pi-detail-grid{grid-template-columns:1fr;}
}
@media(max-width:620px){
  .lux-pi-hero-left,.lux-pi-hero-right{padding:1.25rem 1rem;}
  .lux-pi-title{font-size:clamp(2rem,9vw,3rem);}
  .lux-pi-quick-grid{grid-template-columns:1fr 1fr;}
  .lux-pi-fin-grid{grid-template-columns:1fr;}
}

@media(max-width:1100px){.cine-loc{grid-template-columns:1fr;}.cine-unit-card{grid-template-columns:1fr;direction:ltr !important;}.cine-unit-card:nth-child(even){direction:ltr;}.cine-bento{grid-template-columns:1fr 1fr;}.cine-bento-card.lg{grid-column:span 2;}.cine-hero-bar{gap:1.5rem;}}
@media(max-width:768px){
  .cine-hero{height:75vw;min-height:380px;}
  .cine-hero-title{font-size:clamp(2rem,7vw,3rem);}
  .cine-hero-content{padding:1.5rem 1.2rem 2rem;}
  .cine-hero-bar{flex-direction:column;align-items:flex-start;padding:1.4rem 1.2rem;gap:1rem;}
  .cine-section{padding:3rem 1.2rem;}
  .cine-sec-num{font-size:4rem;right:1.2rem;}
  .cine-nav{top:.5rem;padding:.22rem .28rem;max-width:calc(100vw - 1rem);gap:.15rem;}
  .cine-nav-tab{font-size:.58rem;padding:.25rem .45rem;letter-spacing:.04em;}
  .cine-back{padding:.36rem .7rem;font-size:.72rem;}
  .cine-back span{display:none;}
  .cine-bento{grid-template-columns:1fr;}
  .cine-bento-card.lg{grid-column:span 1;}
  .cine-info-grid{grid-template-columns:1fr;}
  .cine-amenities-grid{grid-template-columns:1fr;}
  .cine-unit-card{grid-template-columns:1fr;}
  .cine-unit-body{padding:1.5rem;}
  .cine-unit-name{font-size:1.6rem;}
  .cine-fac-grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr));}
  .cine-pull-quote{padding:1.8rem 1.5rem 1.8rem 3rem;font-size:1.1rem;}
  .cine-map-wrap{height:280px;}
  .cine-loc{gap:1.5rem;}
  .cine-gal-nav{display:none;}
  .cine-cursor,.cine-cursor-ring{display:none;}
  .cine-stats-strip{grid-template-columns:repeat(2,1fr);}
  .css-item:nth-child(n+3){border-top:1px solid rgba(191,155,78,.08);}
  .cine-footer{padding:4rem 1.2rem 3rem;}
  .cine-footer-title{font-size:clamp(2rem,7vw,3.2rem);}
  .cine-footer-btns{flex-direction:column;align-items:center;}
  .cine-cta-pri,.cine-cta-sec{width:100%;justify-content:center;}
  .cine-loc-dist-cards{grid-template-columns:1fr;}
}
@media(max-width:480px){
  .cine-hero{height:88vw;min-height:300px;}
  .cine-hero-title{font-size:clamp(1.7rem,7vw,2.4rem);}
  .cine-hero-content{padding:1.2rem 1rem 1.8rem;}
  .cine-eyebrow{font-size:.65rem;}
  .cine-tag-pill{font-size:.62rem;}
  .cine-section{padding:2.5rem 1rem;}
  .cine-sec-title{font-size:1.6rem;}
  .cine-sec-num{display:none;}
  .cine-nav{gap:.1rem;padding:.18rem .22rem;}
  .cine-nav-tab{font-size:.52rem;padding:.2rem .36rem;letter-spacing:.03em;}
  .cine-nav-divider{display:none;}
  .cine-bento-icon{width:38px;height:38px;font-size:1.2rem;}
  .cine-bento-title{font-size:.9rem;}
  .cine-fac-grid{grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:.6rem;}
  .cine-fac-card{padding:1rem .7rem;}
  .cine-fac-card-icon{width:36px;height:36px;font-size:1.1rem;}
  .cine-fac-card-name{font-size:.72rem;}
  .cine-unit-body{padding:1.2rem;}
  .cine-unit-name{font-size:1.35rem;}
  .cine-unit-price-val{font-size:1.2rem;}
  .cine-unit-pill{font-size:.72rem;padding:.3rem .75rem;}
  .cine-pull-quote{padding:1.5rem 1.2rem 1.5rem 2.5rem;font-size:1rem;}
  .cine-pull-quote::before{font-size:4rem;left:.6rem;}
  .cine-map-wrap{height:240px;}
  .cine-stats-strip{grid-template-columns:repeat(2,1fr);}
  .css-val{font-size:1.4rem;}
  .cine-footer{padding:3rem 1rem 2.5rem;}
  .cine-footer-bottom{flex-direction:column;align-items:flex-start;gap:.4rem;font-size:.7rem;}
  .cine-amenity-hd{font-size:.68rem;}
  .cine-amenity-item{font-size:.78rem;}
}
@media(max-width:360px){
  .cine-hero-title{font-size:1.5rem;}
  .cine-nav-tab{font-size:.48rem;padding:.18rem .28rem;}
  .cine-back{padding:.3rem .55rem;font-size:.65rem;}
  .cine-sec-title{font-size:1.35rem;}
  .cine-fac-grid{grid-template-columns:repeat(2,1fr);}
  .cine-unit-name{font-size:1.15rem;}
  .css-val{font-size:1.2rem;}
}

/* ── Scroll-reveal ── */
.cr{opacity:0;transform:translateY(40px);transition:opacity .7s cubic-bezier(.22,1,.36,1),transform .7s cubic-bezier(.22,1,.36,1);}
.cr.vis{opacity:1;transform:none;}
.cr.d1{transition-delay:.1s;}.cr.d2{transition-delay:.2s;}.cr.d3{transition-delay:.3s;}
.cr.d4{transition-delay:.4s;}.cr.d5{transition-delay:.5s;}.cr.d6{transition-delay:.6s;}
.cr-left{opacity:0;transform:translateX(-40px);transition:opacity .7s cubic-bezier(.22,1,.36,1),transform .7s cubic-bezier(.22,1,.36,1);}
.cr-left.vis{opacity:1;transform:none;}
.cr-right{opacity:0;transform:translateX(40px);transition:opacity .7s cubic-bezier(.22,1,.36,1),transform .7s cubic-bezier(.22,1,.36,1);}
.cr-right.vis{opacity:1;transform:none;}

/* ── Stats strip ── */
.cine-stats-strip{display:grid;grid-template-columns:repeat(5,1fr);background:rgba(8,8,16,.95);border-bottom:1px solid rgba(191,155,78,.12);position:relative;z-index:5;}
.cine-stats-strip::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 60% 100% at 50% 0%,rgba(191,155,78,.05),transparent);pointer-events:none;}
.css-item{padding:1.6rem 1.2rem;text-align:center;border-right:1px solid rgba(191,155,78,.08);position:relative;transition:background .25s;}
.css-item:last-child{border-right:none;}
.css-item:hover{background:rgba(191,155,78,.05);}
.css-lbl{font-size:.68rem;letter-spacing:.16em;text-transform:uppercase;color:rgba(191,155,78,.55);margin-bottom:.45rem;}
.css-val{font-family:'Cormorant Garamond',Georgia,serif;font-size:1.9rem;font-weight:600;color:#F0ECE4;line-height:1;}
.css-val em{font-family:'DM Sans',sans-serif;font-size:.78rem;font-style:normal;color:rgba(191,155,78,.8);margin-left:.25rem;}
@keyframes cntUp{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:translateY(0);}}
.css-item.vis .css-val{animation:cntUp .6s cubic-bezier(.22,1,.36,1) both;}
.css-item.vis:nth-child(1) .css-val{animation-delay:.05s;}
.css-item.vis:nth-child(2) .css-val{animation-delay:.12s;}
.css-item.vis:nth-child(3) .css-val{animation-delay:.19s;}
.css-item.vis:nth-child(4) .css-val{animation-delay:.26s;}
.css-item.vis:nth-child(5) .css-val{animation-delay:.33s;}
@media(max-width:900px){.cine-stats-strip{grid-template-columns:repeat(3,1fr);}.css-item:nth-child(n+4){border-top:1px solid rgba(191,155,78,.08);}}
@media(max-width:560px){.cine-stats-strip{grid-template-columns:repeat(2,1fr);}.css-item:nth-child(n+3){border-top:1px solid rgba(191,155,78,.08);}}

/* ── Section divider ── */
.cine-divider{display:flex;align-items:center;gap:1.2rem;padding:0 6vw;margin:.5rem 0;}
.cine-divider::before,.cine-divider::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,transparent,rgba(191,155,78,.2),transparent);}
.cine-divider-gem{width:6px;height:6px;border-radius:50%;background:rgba(191,155,78,.5);box-shadow:0 0 8px rgba(191,155,78,.4);}

/* ── Section number badge ── */
.cine-sec-num{font-family:'Cormorant Garamond',Georgia,serif;font-size:7rem;font-weight:700;line-height:1;color:rgba(191,155,78,.04);position:absolute;top:-1rem;right:6vw;pointer-events:none;user-select:none;letter-spacing:-.04em;}

/* ── Info grid (2-col spec layout) ── */
.cine-info-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;}
@media(max-width:768px){.cine-info-grid{grid-template-columns:1fr;}}

/* ── Facility icon cards ── */
.cine-fac-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:.85rem;}
.cine-fac-card{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.55rem;padding:1.4rem 1rem;background:rgba(191,155,78,.04);border:1px solid rgba(191,155,78,.12);border-radius:14px;text-align:center;transition:all .28s ease;cursor:default;}
.cine-fac-card:hover{background:rgba(191,155,78,.1);border-color:rgba(191,155,78,.35);transform:translateY(-4px);box-shadow:0 12px 32px rgba(0,0,0,.3),0 0 24px rgba(191,155,78,.1);}
.cine-fac-card-icon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:1.4rem;background:linear-gradient(135deg,rgba(191,155,78,.12),rgba(212,184,128,.07));border:1px solid rgba(191,155,78,.2);transition:all .28s ease;}
.cine-fac-card:hover .cine-fac-card-icon{background:linear-gradient(135deg,rgba(191,155,78,.22),rgba(212,184,128,.15));box-shadow:0 0 20px rgba(191,155,78,.25);}
.cine-fac-card-name{font-size:.78rem;font-weight:500;color:rgba(255,255,255,.6);line-height:1.3;}
.cine-fac-card:hover .cine-fac-card-name{color:#D4B880;}

/* ── Pull quote / description ── */
.cine-pull-quote{position:relative;padding:2.5rem 3rem 2.5rem 4rem;background:linear-gradient(135deg,rgba(191,155,78,.04),rgba(191,155,78,.02));border:1px solid rgba(191,155,78,.1);border-left:4px solid rgba(191,155,78,.6);border-radius:0 16px 16px 0;font-family:'Cormorant Garamond',Georgia,serif;font-size:1.35rem;line-height:1.8;color:rgba(255,255,255,.78);font-style:italic;}
.cine-pull-quote::before{content:'\u201C';position:absolute;top:0;left:1rem;font-size:6rem;color:rgba(191,155,78,.15);line-height:1;font-style:normal;}
.cine-pull-quote::after{content:'\u201D';position:absolute;bottom:-1.5rem;right:1.5rem;font-size:6rem;color:rgba(191,155,78,.08);line-height:1;font-style:normal;}

/* ── Shimmer on bento hover ── */
@keyframes shimmer{0%{left:-100%;}100%{left:200%;}}
.cine-bento-card::after{content:'';position:absolute;top:0;left:-100%;width:60%;height:100%;background:linear-gradient(90deg,transparent,rgba(191,155,78,.06),transparent);transform:skewX(-15deg);pointer-events:none;}
.cine-bento-card:hover::after{animation:shimmer .6s ease;}

/* ── Map reveal animation ── */
@keyframes mapReveal{from{opacity:0;transform:scale(.97);}to{opacity:1;transform:scale(1);}}
.cine-map-wrap.vis{animation:mapReveal .8s cubic-bezier(.22,1,.36,1) both;}

/* ── Unit card stagger ── */
.cine-unit-card{opacity:0;transform:translateY(32px);transition:opacity .6s cubic-bezier(.22,1,.36,1),transform .6s cubic-bezier(.22,1,.36,1),border-color .35s,box-shadow .35s;}
.cine-unit-card.vis{opacity:1;transform:translateY(0);}
.cine-unit-card:nth-child(1){transition-delay:0s;}.cine-unit-card:nth-child(2){transition-delay:.12s;}.cine-unit-card:nth-child(3){transition-delay:.24s;}.cine-unit-card:nth-child(4){transition-delay:.36s;}

/* ── Progress bar for unit price ── */
.cine-unit-progress{height:2px;background:rgba(191,155,78,.1);border-radius:2px;margin:1rem 0;overflow:hidden;}
.cine-unit-progress-fill{height:100%;background:linear-gradient(90deg,#BF9B4E,#D4B880);border-radius:2px;transform-origin:left;animation:progFill .9s cubic-bezier(.22,1,.36,1) .3s both;}
@keyframes progFill{from{transform:scaleX(0);}to{transform:scaleX(1);}}

/* ── Amenity card stagger ── */
.cine-amenity-card{opacity:0;transform:translateY(20px);transition:opacity .5s cubic-bezier(.22,1,.36,1),transform .5s cubic-bezier(.22,1,.36,1),background .28s,border-color .28s,box-shadow .28s;}
.cine-amenity-card.vis{opacity:1;transform:translateY(0);}

/* ═══ TOUR GUIDE ═══ */
@keyframes tgTipIn{from{opacity:0;transform:scale(.88) translateY(12px);}to{opacity:1;transform:scale(1) translateY(0);}}
@keyframes tgSheetUp{from{opacity:0;transform:translateY(64px);}to{opacity:1;transform:translateY(0);}}
@keyframes tgRipple{0%{transform:scale(1);opacity:.55;}100%{transform:scale(3);opacity:0;}}
@keyframes tgSpotFadeIn{from{opacity:0;}to{opacity:1;}}
@keyframes tgPulseRing{0%,100%{transform:scale(1);opacity:.7;}50%{transform:scale(1.04);opacity:1;}}
/* ── Tour overlay (SVG handles the dim, this is the pointer blocker) ── */
.tg-ov{position:fixed;inset:0;z-index:9000;pointer-events:none;}
/* Ripple */
.tg-ripple{position:fixed;border-radius:50%;pointer-events:none;z-index:9003;animation:tgRipple .65s ease-out forwards;background:rgba(191,155,78,.32);}
body:not(.dark) .tg-ripple{background:rgba(193,126,135,.32);}
/* Desktop tooltip */
.tg-tip{position:fixed;z-index:9010;width:296px;border-radius:16px;overflow:hidden;animation:tgTipIn .32s cubic-bezier(.22,1,.36,1) both;pointer-events:all;box-shadow:0 20px 56px rgba(0,0,0,.5),0 0 0 1px rgba(191,155,78,.08) inset;}
body.dark .tg-tip{background:rgba(9,8,22,.97);border:1px solid rgba(191,155,78,.22);}
body:not(.dark) .tg-tip{background:#fff;border:1px solid rgba(193,126,135,.28);box-shadow:0 20px 56px rgba(45,14,20,.14),0 0 0 1px rgba(193,126,135,.06) inset;}
/* Top accent bar */
.tg-tip-bar{height:2px;}
body.dark .tg-tip-bar{background:linear-gradient(90deg,#BF9B4E,#FFE08A,rgba(78,171,255,.8));}
body:not(.dark) .tg-tip-bar{background:linear-gradient(90deg,var(--gold),var(--gold-l));}
/* Tooltip arrow */
.tg-arrow{position:absolute;width:0;height:0;pointer-events:none;}
.tg-arrow.from-top{top:-7px;border-left:7px solid transparent;border-right:7px solid transparent;}
body.dark .tg-arrow.from-top{border-bottom:7px solid rgba(191,155,78,.22);}
body:not(.dark) .tg-arrow.from-top{border-bottom:7px solid rgba(193,126,135,.28);}
.tg-arrow.from-bottom{bottom:-7px;border-left:7px solid transparent;border-right:7px solid transparent;}
body.dark .tg-arrow.from-bottom{border-top:7px solid rgba(191,155,78,.22);}
body:not(.dark) .tg-arrow.from-bottom{border-top:7px solid rgba(193,126,135,.28);}
.tg-arrow.from-right{right:-7px;top:50%;transform:translateY(-50%);border-top:7px solid transparent;border-bottom:7px solid transparent;}
body.dark .tg-arrow.from-right{border-left:7px solid rgba(191,155,78,.22);}
body:not(.dark) .tg-arrow.from-right{border-left:7px solid rgba(193,126,135,.28);}
.tg-arrow.from-left{left:-7px;top:50%;transform:translateY(-50%);border-top:7px solid transparent;border-bottom:7px solid transparent;}
body.dark .tg-arrow.from-left{border-right:7px solid rgba(191,155,78,.22);}
body:not(.dark) .tg-arrow.from-left{border-right:7px solid rgba(193,126,135,.28);}
/* Tip head */
.tg-tip-hd{padding:.85rem 1rem .4rem;display:flex;align-items:center;gap:.55rem;}
.tg-badge{font-size:.54rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;padding:.19rem .55rem;border-radius:999px;white-space:nowrap;flex-shrink:0;}
body.dark .tg-badge{background:rgba(191,155,78,.12);color:#BF9B4E;border:1px solid rgba(191,155,78,.22);}
body:not(.dark) .tg-badge{background:rgba(193,126,135,.1);color:var(--gold);border:1px solid rgba(193,126,135,.22);}
.tg-title{font-size:.84rem;font-weight:700;line-height:1.25;}
body.dark .tg-title{color:#FAF8F3;}
body:not(.dark) .tg-title{color:var(--cta);}
/* Tip body */
.tg-body{padding:.1rem 1rem .7rem;font-size:.73rem;line-height:1.72;}
body.dark .tg-body{color:rgba(255,255,255,.46);}
body:not(.dark) .tg-body{color:var(--muted);}
/* Progress */
.tg-prog{height:2px;margin:0 1rem .65rem;border-radius:2px;overflow:hidden;}
body.dark .tg-prog{background:rgba(255,255,255,.07);}
body:not(.dark) .tg-prog{background:rgba(45,14,20,.08);}
.tg-prog-fill{height:100%;border-radius:2px;transition:width .45s cubic-bezier(.65,0,.35,1);}
body.dark .tg-prog-fill{background:linear-gradient(90deg,#BF9B4E,#FFE08A);}
body:not(.dark) .tg-prog-fill{background:linear-gradient(90deg,var(--gold),var(--gold-l));}
/* Tip footer */
.tg-ft{padding:.6rem 1rem .75rem;display:flex;align-items:center;justify-content:space-between;gap:.4rem;}
body.dark .tg-ft{border-top:1px solid rgba(255,255,255,.05);}
body:not(.dark) .tg-ft{border-top:1px solid var(--border);}
.tg-skip{font-size:.59rem;letter-spacing:.1em;text-transform:uppercase;background:transparent;border:none;cursor:pointer;font-family:var(--sans);transition:color .2s;padding:.2rem .25rem;}
body.dark .tg-skip{color:rgba(255,255,255,.2);}
body.dark .tg-skip:hover{color:rgba(255,255,255,.5);}
body:not(.dark) .tg-skip{color:rgba(45,14,20,.28);}
body:not(.dark) .tg-skip:hover{color:rgba(45,14,20,.6);}
.tg-btns{display:flex;gap:.38rem;}
.tg-btn-bk{font-size:.67rem;font-weight:600;font-family:var(--sans);border-radius:999px;padding:.36rem .8rem;cursor:pointer;transition:all .2s;}
body.dark .tg-btn-bk{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:rgba(255,255,255,.45);}
body.dark .tg-btn-bk:hover{background:rgba(255,255,255,.1);color:#fff;}
body:not(.dark) .tg-btn-bk{background:rgba(193,126,135,.07);border:1px solid rgba(193,126,135,.2);color:var(--gold);}
body:not(.dark) .tg-btn-bk:hover{background:rgba(193,126,135,.14);}
.tg-btn-nx{font-size:.67rem;font-weight:700;font-family:var(--sans);border:none;border-radius:999px;padding:.38rem .92rem;cursor:pointer;transition:all .2s;letter-spacing:.04em;}
body.dark .tg-btn-nx{background:linear-gradient(135deg,#BF9B4E,#D4B880);color:#02030A;box-shadow:0 3px 12px rgba(191,155,78,.35);}
body.dark .tg-btn-nx:hover{box-shadow:0 5px 18px rgba(191,155,78,.5);transform:translateY(-1px);}
body:not(.dark) .tg-btn-nx{background:linear-gradient(135deg,var(--gold),var(--gold-l));color:#fff;box-shadow:0 3px 12px rgba(193,126,135,.3);}
body:not(.dark) .tg-btn-nx:hover{box-shadow:0 5px 18px rgba(193,126,135,.45);transform:translateY(-1px);}
.tg-btn-nx:active{transform:scale(.96);}
/* Mobile bottom sheet */
.tg-sheet{position:fixed;bottom:0;left:0;right:0;z-index:9010;border-radius:20px 20px 0 0;padding:.9rem 1.2rem calc(env(safe-area-inset-bottom,0px) + 1.4rem);pointer-events:all;animation:tgSheetUp .36s cubic-bezier(.22,1,.36,1) both;}
body.dark .tg-sheet{background:rgba(9,8,22,.99);border-top:1px solid rgba(191,155,78,.18);box-shadow:0 -12px 40px rgba(0,0,0,.5);}
body:not(.dark) .tg-sheet{background:#fff;border-top:1px solid rgba(193,126,135,.22);box-shadow:0 -10px 36px rgba(45,14,20,.1);}
.tg-drag{width:32px;height:4px;border-radius:2px;margin:0 auto .8rem;}
body.dark .tg-drag{background:rgba(255,255,255,.14);}
body:not(.dark) .tg-drag{background:rgba(45,14,20,.14);}
.tg-sheet-hd{display:flex;align-items:center;gap:.55rem;margin-bottom:.45rem;}
.tg-sheet-title{font-size:.9rem;font-weight:700;flex:1;}
body.dark .tg-sheet-title{color:#FAF8F3;}
body:not(.dark) .tg-sheet-title{color:var(--cta);}
.tg-sheet-body{font-size:.76rem;line-height:1.75;margin-bottom:.8rem;}
body.dark .tg-sheet-body{color:rgba(255,255,255,.46);}
body:not(.dark) .tg-sheet-body{color:var(--muted);}
.tg-sheet-ft{display:flex;align-items:center;justify-content:space-between;gap:.4rem;}
/* Dots */
.tg-dots{display:flex;gap:.32rem;align-items:center;}
.tg-dot{width:5px;height:5px;border-radius:50%;transition:all .3s cubic-bezier(.34,1.56,.64,1);}
body.dark .tg-dot{background:rgba(255,255,255,.18);}
body:not(.dark) .tg-dot{background:rgba(45,14,20,.15);}
.tg-dot.on{width:16px;border-radius:2px;}
body.dark .tg-dot.on{background:linear-gradient(90deg,#BF9B4E,#FFE08A);box-shadow:0 0 8px rgba(191,155,78,.4);}
body:not(.dark) .tg-dot.on{background:linear-gradient(90deg,var(--gold),var(--gold-l));}
/* No-target centered card */
.tg-center{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9010;width:min(320px,88vw);border-radius:18px;padding:1.6rem 1.4rem;pointer-events:all;animation:tgTipIn .35s cubic-bezier(.22,1,.36,1) both;}
body.dark .tg-center{background:rgba(9,8,22,.97);border:1px solid rgba(191,155,78,.2);box-shadow:0 24px 60px rgba(0,0,0,.5);}
body:not(.dark) .tg-center{background:#fff;border:1px solid rgba(193,126,135,.25);box-shadow:0 24px 60px rgba(45,14,20,.12);}
/* ── Mobile ── */
@media(max-width:767px){
  .tg-tip{display:none;}
}
/* ── Desktop: hide sheet ── */
@media(min-width:768px){
  .tg-sheet{display:none;}
}
/* ── Landscape phone ── */
@media(max-width:767px) and (orientation:landscape){
  .tg-sheet{padding:.6rem 1.2rem calc(env(safe-area-inset-bottom,0px) + .8rem);border-radius:14px 14px 0 0;}
  .tg-drag{margin-bottom:.5rem;}
  .tg-sheet-body{margin-bottom:.5rem;font-size:.72rem;}
}
`;



/* ═══ PRICE RANGE SLIDER ═══ */
/* ── Price slider helpers ── */
function fmtSlider(n) {
  if (n <= 0)          return "RM 0";
  if (n >= 1000000)    return `RM ${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
  return `RM ${(n / 1000).toFixed(0)}K`;
}

const TICKS = [0, 500000, 1000000, 2000000, 3000000, 4000000, 5000000];
const TICK_LABELS = ["RM 0", "500K", "1M", "2M", "3M", "4M", "5M+"];

function PriceRangeSlider({ minVal, maxVal, onChange }) {
  const SMIN = PRICE_SLIDER_MIN;
  const SMAX = PRICE_SLIDER_MAX;
  const STEP = PRICE_STEP;

  const railRef    = React.useRef(null);
  const dragging   = React.useRef(null);   // "min" | "max" | null
  const [activeThumb, setActiveThumb] = React.useState(null);

  const toPercent = v => ((v - SMIN) / (SMAX - SMIN)) * 100;
  const fromPercent = p => {
    const raw = (p / 100) * (SMAX - SMIN) + SMIN;
    return Math.round(raw / STEP) * STEP;
  };

  const clientXFromEvent = e =>
    e.touches && e.touches.length ? e.touches[0].clientX : e.clientX;

  const percentFromEvent = e => {
    if (!railRef.current) return 0;
    const rect = railRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(100, ((clientXFromEvent(e) - rect.left) / rect.width) * 100));
  };

  const startDrag = (handle, e) => {
    e.preventDefault && e.preventDefault();
    dragging.current = handle;
    setActiveThumb(handle);
    const move = ev => {
      if (!dragging.current) return;
      if (ev.cancelable) ev.preventDefault();
      const v = fromPercent(percentFromEvent(ev));
      if (dragging.current === "min") onChange(Math.max(SMIN, Math.min(v, maxVal - STEP)), maxVal);
      else onChange(minVal, Math.max(SMIN + STEP, Math.min(v, SMAX)));
    };
    const up = () => {
      dragging.current = null;
      setActiveThumb(null);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", up);
  };

  // Click on rail → move nearest handle
  const onRailClick = e => {
    if (dragging.current) return;
    const v = fromPercent(percentFromEvent(e));
    const dMin = Math.abs(v - minVal), dMax = Math.abs(v - maxVal);
    if (dMin <= dMax) onChange(Math.max(SMIN, Math.min(v, maxVal - STEP)), maxVal);
    else              onChange(minVal, Math.max(minVal + STEP, Math.min(v, SMAX)));
  };

  const isDefault = minVal === SMIN && maxVal === SMAX;
  const leftPct   = toPercent(minVal);
  const rightPct  = toPercent(maxVal);

  return (
    <div className="price-panel">
      {/* Header row */}
      <div className="price-panel-top">
        <span className="price-panel-label">Price Range</span>
        <div className="price-panel-value">
          {isDefault
            ? <span className="any">All prices</span>
            : <>
                <span>{fmtSlider(minVal)}</span>
                <span className="sep">—</span>
                <span>{maxVal >= SMAX ? "No Max" : fmtSlider(maxVal)}</span>
              </>
          }
          {!isDefault && (
            <button className="price-reset" onClick={() => onChange(SMIN, SMAX)}>✕ Clear</button>
          )}
        </div>
      </div>

      {/* Track area */}
      <div className="ps-track-area">
        <div className="ps-rail" ref={railRef} onClick={onRailClick}>
          {/* Filled range */}
          <div className="ps-fill" style={{ left: leftPct + "%", right: (100 - rightPct) + "%" }}/>

          {/* Min thumb */}
          <div
            className={`ps-thumb${activeThumb === "min" ? " dragging" : ""}`}
            style={{ left: leftPct + "%" }}
            onMouseDown={e => startDrag("min", e)}
            onTouchStart={e => startDrag("min", e)}
          >
            <div className="ps-tooltip">{fmtSlider(minVal)}</div>
          </div>

          {/* Max thumb */}
          <div
            className={`ps-thumb${activeThumb === "max" ? " dragging" : ""}`}
            style={{ left: rightPct + "%" }}
            onMouseDown={e => startDrag("max", e)}
            onTouchStart={e => startDrag("max", e)}
          >
            <div className="ps-tooltip">{maxVal >= SMAX ? "No Max" : fmtSlider(maxVal)}</div>
          </div>
        </div>

        {/* Tick marks */}
        <div className="ps-ticks">
          {TICKS.map((t, i) => {
            const inRange = t >= minVal && t <= maxVal;
            return (
              <div key={t} className={`ps-tick${inRange && !isDefault ? " active" : ""}`}>
                <div className="ps-tick-mark"/>
                <span className="ps-tick-lbl">{TICK_LABELS[i]}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ═══ TOGGLE SWITCH ═══ */
function Toggle({ checked, onChange, label }) {
  return (
    <label className="tog-wrap">
      <span className="tog">
        <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)}/>
        <span className="tog-track"/>
        <span className="tog-thumb"/>
      </span>
      {label && <span className={`tog-lbl${checked ? "" : " off"}`}>{label}</span>}
    </label>
  );
}

/* ═══ ICONS ═══ */
const IPin   =()=><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>;
const IBed   =()=><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>;
const IArea  =()=><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>;
const ISearch=()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const IPDF   =()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>;
const IEdit  =()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
const ITrash =()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>;
const IPlus  =()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
const IGrid  =()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>;
const IList  =()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>;
const ILock  =()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>;
const ILogout=()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>;
const IBath  =()=><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 12h16v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-4z"/><path d="M6 12V6a2 2 0 0 1 2-2h4"/><line x1="4" y1="12" x2="4" y2="8"/></svg>;
const IMapPin=()=><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>;
const IPerson=()=><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>;

/* ═══ STATUS CHIP ═══ */
const SCls=s=>s==="New Launch"?"nl":s==="Under Construction"?"uc":s==="Completed"?"co":"so";
const SChip=({s})=><span className={`a-schip ${SCls(s)}`}>{s}</span>;

/* ═══ TOAST ═══ */
function Toast({msg,type,onDone}){
  useEffect(()=>{const t=setTimeout(onDone,2800);return()=>clearTimeout(t);},[]);
  return <div className={`toast ${type}`}><span className="t-ico">{type==="success"?"✓":type==="error"?"✕":"ℹ"}</span><span>{msg}</span></div>;
}

/* ═══ WHATSAPP ICON ═══ */
const IWhatsApp=()=>(
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
    <path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.977-1.404A9.96 9.96 0 0 0 12 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18a7.946 7.946 0 0 1-4.065-1.112l-.29-.173-3.005.847.855-2.94-.19-.303A7.96 7.96 0 0 1 4 12c0-4.418 3.582-8 8-8s8 3.582 8 8-3.582 8-8 8z"/>
  </svg>
);

/* Inline compact country select (uses flags) */
function InlineCountrySelect({ value, onChange }){
  const selected = COUNTRY_CODES.find(c=>String(c.dial)===String(value)) || COUNTRY_CODES.find(c=>c.code==='MY');
  return (
    <select className="ri-inp" value={selected?.dial || "60"} onChange={e=>onChange(e.target.value)}>
      {COUNTRY_CODES.map(c=> (
        <option key={c.code} value={c.dial}>{`${c.flag} ${c.name} (+${c.dial})`}</option>
      ))}
    </select>
  );
}

/* ═══ REGISTER INTEREST MODAL ═══ */
function RegisterInterestModal({ project, settings, onClose }) {
  useModalEffect(onClose);
  const [mode, setMode]     = useState("form");  // "form" | "whatsapp" | "sent"
  const [name, setName]     = useState("");
  const [email, setEmail]   = useState("");
  const [phone, setPhone]   = useState("");
  const [phoneCountry, setPhoneCountry] = useState((settings && settings.countryCode) ? String(settings.countryCode) : "60");
  const [sending, setSending] = useState(false);
  const [formErr, setFormErr] = useState("");

  const projName = project?.name || "this property";

  // Build WhatsApp URL with project name formatted like *Word* *Word*
  const waName = projName.split(" ").map(w => `*${w}*`).join("%20");
  const waPhone = (settings?.whatsappPhone || "60129846080").replace(/[^0-9]/g,"");
  const waSender = settings?.whatsappName || "Joel";
  const waURL = `https://api.whatsapp.com/send?phone=${waPhone}&text=Hi%20${encodeURIComponent(waSender)},%20I%27m%20interested%20in%20your%20${waName}%20Please%20contact%20me,%20Thanks!`;

  const validate = () => {
    if (!name.trim())                         return "Please enter your name.";
    if (!email.trim()||!email.includes("@"))  return "Please enter a valid email address.";
    if (!phone.trim())                        return "Please enter your phone number.";
    if (!phoneCountry.trim() || !/^[0-9]+$/.test(phoneCountry)) return "Please enter a valid country code.";
    return "";
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { setFormErr(err); return; }
    setFormErr("");
    setSending(true);
    trackEvent("inquiry_submit", { projectName: projName });
    const phoneDigits = String(phone).replace(/[^0-9]/g, "");
    const phoneNormalized = phoneDigits.replace(/^0+/, "");
    // Separate country code and phone as requested
    try {
      await crmCreateWebsiteEnquiryLead({
        name: name.trim(),
        email: email.trim(),
        countryCode: `+${phoneCountry}`,
        phone: phoneNormalized,
        projectName: projName,
      }, settings);
      setSending(false);
      setMode("sent");
    } catch (e) {
      setSending(false);
      setFormErr(e?.message || "Failed to submit enquiry. Please try again.");
    }
  };

  return (
    <div className="ri-ov" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="ri-box">
        {/* Header */}
        <div className="ri-hd">
          <div className="ri-hd-left">
            <div className="ri-hd-eyebrow">Register Your Interest</div>
            <div className="ri-hd-title">Get in Touch</div>
            {project && <div className="ri-hd-proj">📍 {projName}</div>}
          </div>
          <button className="ri-x" onClick={onClose}>✕</button>
        </div>

        {/* Sent success */}
        {mode==="sent" && (
          <div className="ri-success">
            <div className="ri-success-ico">✅</div>
            <div className="ri-success-title">Enquiry Sent!</div>
            <p className="ri-success-sub">
              Thank you, <strong>{name}</strong>. Your interest in <strong>{projName}</strong> has been noted.<br/>
              Your details have been added to our CRM and our team will be in touch with you shortly.
            </p>
          </div>
        )}

        {/* Form / WhatsApp tabs */}
        {mode!=="sent" && <>
          <div className="ri-options">
            <button className={`ri-opt-btn${mode==="form"?" on":""}`} onClick={()=>setMode("form")}>
              📝 Submit Enquiry
            </button>
            <button className={`ri-opt-btn${mode==="whatsapp"?" on":""}`} onClick={()=>setMode("whatsapp")}>
              💬 WhatsApp
            </button>
          </div>

          {/* ── Enquiry Form ── */}
          {mode==="form" && (
            <div className="ri-body">
              {formErr && <div className="ri-err">{formErr}</div>}
              <div className="ri-field">
                <label className="ri-label">Full Name</label>
                <input className="ri-inp" type="text" placeholder="e.g. Ahmad bin Ibrahim"
                  value={name} onChange={e=>{setName(e.target.value);setFormErr("");}}/>
              </div>
              <div className="ri-field">
                <label className="ri-label">Email Address</label>
                <input className="ri-inp" type="email" placeholder="e.g. ahmad@email.com"
                  value={email} onChange={e=>{setEmail(e.target.value);setFormErr("");}}/>
              </div>
              <div className="ri-field">
                <label className="ri-label">Country Code</label>
                <InlineCountrySelect value={phoneCountry} onChange={v=>{setPhoneCountry(String(v));setFormErr("");}} />
              </div>
              <div className="ri-field">
                <label className="ri-label">Phone Number</label>
                <input className="ri-inp" type="tel" placeholder="e.g. 12-345 6789"
                  value={phone} onChange={e=>{setPhone(e.target.value);setFormErr("");}}/>
              </div>
              <button className="ri-submit" onClick={handleSubmit} disabled={sending}>
                {sending ? "Sending…" : "Submit Enquiry →"}
              </button>
            </div>
          )}

          {/* ── WhatsApp ── */}
          {mode==="whatsapp" && (
            <div className="ri-wa-body">
              <div className="ri-wa-icon">💬</div>
              <div className="ri-wa-title">Chat on WhatsApp</div>
              <p className="ri-wa-sub">
                Click below to open WhatsApp and send a pre-filled message about<br/>
                <strong>{projName}</strong>.
              </p>
              <a href={waURL} target="_blank" rel="noopener noreferrer" className="ri-wa-btn" onClick={()=>trackEvent("inquiry_wa",{projectName:projName})}>
                <IWhatsApp/> Open WhatsApp
              </a>
            </div>
          )}
        </>}
      </div>
    </div>
  );
}

/* ═══ VISIT SHOWROOM MODAL ═══ */
function VisitShowroomModal({ project, settings, onClose }) {
  useModalEffect(onClose);
  const [mode, setMode]   = useState("form"); // "form" | "sent"
  const [name, setName]   = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCountry, setPhoneCountry] = useState((settings && settings.countryCode) ? String(settings.countryCode) : "60");
  const [date, setDate]   = useState("");
  const [time, setTime]   = useState("");
  const [notes, setNotes] = useState("");
  const [sending, setSending] = useState(false);
  const [formErr, setFormErr] = useState("");

  const projName = project?.name || "this property";
  const projLoc  = project?.location || "";
  const showroom = project?.showroom || "";

  // Min selectable date = tomorrow
  const minDate = (() => {
    const d = new Date(); d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
  })();

  // Time slots (10am – 6pm every 30 min)
  const TIME_SLOTS = [
    "10:00 AM","10:30 AM",
    "11:00 AM","11:30 AM",
    "12:00 PM","12:30 PM",
    "01:00 PM","01:30 PM",
    "02:00 PM","02:30 PM",
    "03:00 PM","03:30 PM",
    "04:00 PM","04:30 PM",
    "05:00 PM","05:30 PM",
    "06:00 PM",
  ];

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
  };

  const validate = () => {
    if (!name.trim())                        return "Please enter your name.";
    if (!email.trim()||!email.includes("@")) return "Please enter a valid email address.";
    if (!phone.trim())                       return "Please enter your phone number.";
    if (!phoneCountry.trim() || !/^[0-9]+$/.test(phoneCountry)) return "Please enter a valid country code.";
    if (!date)                               return "Please select an appointment date.";
    if (!time)                               return "Please select a preferred time slot.";
    return "";
  };

  const handleBook = () => {
    const err = validate();
    if (err) { setFormErr(err); return; }
    setFormErr("");
    setSending(true);

    const adminEmail = settings?.adminEmail || "";
    const waPhone    = (settings?.whatsappPhone || "60129846080").replace(/[^0-9]/g,"");
    const waSender   = settings?.whatsappName || "Joel";

    const dateStr = fmtDate(date);

    // Normalize phone for booking
    const phoneDigits = String(phone).replace(/[^0-9]/g, "");
    let phoneNormalized = phoneDigits.replace(/^0+/, "");
    const fullPhone = `+${phoneCountry}${phoneNormalized}`;

    // ── WhatsApp message ──
    const waText =
`Hi ${waSender}, I would like to *book a showroom visit*.

*Project:* ${projName}${projLoc?`\n*Location:* ${projLoc}`:""}
*Date:* ${dateStr}
*Time:* ${time}

*Name:* ${name}
*Email:* ${email}

Please confirm my appointment. Thanks!`;
    const waURL = `https://api.whatsapp.com/send?phone=${waPhone}&text=${encodeURIComponent(waText)}`;

    // ── Email message ──
    const subject = encodeURIComponent(`Showroom Visit Booking — ${projName}`);
    const body = encodeURIComponent(
`New showroom visit appointment booked via NB Property website.

Project:   ${projName}
${projLoc?`Location:  ${projLoc}\n`:""}${showroom?`Showroom:  ${showroom}\n`:""}
Appointment Date:  ${dateStr}
Appointment Time:  ${time}

Visitor Details
---------------
Name:   ${name}
Email:  ${email}
Phone:  ${fullPhone}
${notes?`\nNotes:\n${notes}\n`:""}
Sent via NB Property website.`
    );

    // Open WhatsApp in a new tab
    trackEvent("showroom_book", { projectName: projName });
    window.open(waURL, "_blank", "noopener,noreferrer");

    // Open mailto if admin email configured
    if (adminEmail) {
      setTimeout(() => {
        window.open(`mailto:${adminEmail}?subject=${subject}&body=${body}`, "_blank");
      }, 400);
    } else {
      const txt = decodeURIComponent(body);
      navigator.clipboard?.writeText(txt).catch(()=>{});
    }

    setTimeout(() => { setSending(false); setMode("sent"); }, 700);
  };

  return (
    <div className="ri-ov" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="ri-box">
        {/* Header */}
        <div className="ri-hd">
          <div className="ri-hd-left">
            <div className="ri-hd-eyebrow">Schedule a Visit</div>
            <div className="ri-hd-title">Visit Showroom</div>
            {project && <div className="ri-hd-proj">📍 {projName}</div>}
          </div>
          <button className="ri-x" onClick={onClose}>✕</button>
        </div>

        {mode==="sent" ? (
          <div className="ri-success">
            <div className="ri-success-ico">📅</div>
            <div className="ri-success-title">Appointment Booked!</div>
            <p className="ri-success-sub">
              Thank you, <strong>{name}</strong>.<br/>
              Your visit to <strong>{projName}</strong> is requested for<br/>
              <strong>{fmtDate(date)} at {time}</strong>.<br/><br/>
              WhatsApp has been opened with your appointment details — please send the message to confirm.
              {settings?.adminEmail
                ? " A confirmation email has also been prepared for our team."
                : ""}
            </p>
          </div>
        ) : (
          <div className="ri-body">
            {formErr && <div className="ri-err">{formErr}</div>}

            <div className="ri-field">
              <label className="ri-label">Full Name</label>
              <input className="ri-inp" type="text" placeholder="e.g. Ahmad bin Ibrahim"
                value={name} onChange={e=>{setName(e.target.value);setFormErr("");}}/>
            </div>
            <div className="ri-field">
              <label className="ri-label">Email Address</label>
              <input className="ri-inp" type="email" placeholder="e.g. ahmad@email.com"
                value={email} onChange={e=>{setEmail(e.target.value);setFormErr("");}}/>
            </div>
            <div className="ri-field">
              <label className="ri-label">Country Code</label>
              <InlineCountrySelect value={phoneCountry} onChange={v=>{setPhoneCountry(String(v));setFormErr("");}} />
            </div>
            <div className="ri-field">
              <label className="ri-label">Phone Number</label>
              <input className="ri-inp" type="tel" placeholder="e.g. 12-345 6789"
                value={phone} onChange={e=>{setPhone(e.target.value);setFormErr("");}}/>
            </div>
            <div className="ri-field">
              <label className="ri-label">Preferred Date</label>
              <input className="ri-inp" type="date" min={minDate}
                value={date} onChange={e=>{setDate(e.target.value);setFormErr("");}}/>
            </div>
            <div className="ri-field">
              <label className="ri-label">Preferred Time Slot</label>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:".5rem"}}>
                {TIME_SLOTS.map(t => (
                  <button
                    key={t}
                    type="button"
                    className={`tslot-btn${time===t?" on":""}`}
                    onClick={()=>{setTime(t);setFormErr("");}}
                  >{t}</button>
                ))}
              </div>
            </div>
            <div className="ri-field">
              <label className="ri-label">Notes (optional)</label>
              <textarea className="ri-inp" rows={3} placeholder="Anything we should know? e.g. number of visitors, specific unit type interest…"
                value={notes} onChange={e=>setNotes(e.target.value)} style={{resize:"vertical",fontFamily:"var(--sans)"}}/>
            </div>

            <button className="ri-submit" onClick={handleBook} disabled={sending}>
              {sending ? "Booking…" : "Book Appointment →"}
            </button>
            <div className="ri-booking-note">
              On booking, your appointment details will be sent via <strong>WhatsApp</strong>
              {settings?.adminEmail ? <> and <strong>email</strong></> : null}.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════
   CUSTOM CURSOR
═══════════════════════════════════════ */
function CustomCursor() {
  const curRef = useRef(null);
  const ringRef = useRef(null);
  const posRef = useRef({ x: -200, y: -200 });
  const ringPosRef = useRef({ x: -200, y: -200 });
  const rafRef = useRef(null);
  const hoverRef = useRef(false);

  useEffect(() => {
    document.body.classList.add('cine-active');
    const onMove = (e) => {
      posRef.current = { x: e.clientX, y: e.clientY };
      if (curRef.current) {
        curRef.current.style.left = e.clientX + 'px';
        curRef.current.style.top = e.clientY + 'px';
      }
    };
    const onOver = (e) => {
      const t = e.target;
      const isHoverable = t.matches('button,a,[role="button"],.cine-bento-card,.cine-amenity-card,.cine-unit-card,.cine-stat,.cine-loc-dist-card,.cine-gal-thumb,.lux-pi-quick-card,.lux-pi-panel,.lux-pi-fin-card,.lux-pi-fac-pill');
      if (isHoverable !== hoverRef.current) {
        hoverRef.current = isHoverable;
        if (ringRef.current) ringRef.current.classList.toggle('hovering', isHoverable);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseover', onOver);
    const tick = () => {
      ringPosRef.current.x += (posRef.current.x - ringPosRef.current.x) * 0.45;
      ringPosRef.current.y += (posRef.current.y - ringPosRef.current.y) * 0.45;
      if (ringRef.current) {
        ringRef.current.style.left = ringPosRef.current.x + 'px';
        ringRef.current.style.top = ringPosRef.current.y + 'px';
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      document.body.classList.remove('cine-active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseover', onOver);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <>
      <div ref={curRef} className="cine-cursor" style={{left:'-200px',top:'-200px'}}/>
      <div ref={ringRef} className="cine-cursor-ring" style={{left:'-200px',top:'-200px'}}/>
    </>
  );
}

/* ═══════════════════════════════════════
   DETAIL MODAL
═══════════════════════════════════════ */
function DetailPage({p, onClose, onRegisterInterest, onVisitShowroom}){
  const [activeImg, setActiveImg] = useState(0);
  const [fabOpen, setFabOpen] = useState(false);
  const [imgModal, setImgModal] = useState({open:false, src:'', group:[], index:0});
  const openImage = (src, group = [], index = 0) => setImgModal({open:true, src, group, index});
  const closeImage = () => setImgModal({open:false, src:'', group:[], index:0});
  useEffect(()=>{
    const onKey = (e) => {
      if(!imgModal.open) return;
      if(e.key === 'Escape') return closeImage();
      if(e.key === 'ArrowLeft' && imgModal.group && imgModal.group.length>1){
        const ni = (imgModal.index - 1 + imgModal.group.length) % imgModal.group.length;
        setImgModal(m=>({...m, index:ni, src:m.group[ni]}));
      }
      if(e.key === 'ArrowRight' && imgModal.group && imgModal.group.length>1){
        const ni = (imgModal.index + 1) % imgModal.group.length;
        setImgModal(m=>({...m, index:ni, src:m.group[ni]}));
      }
    };
    window.addEventListener('keydown', onKey);
    return ()=>window.removeEventListener('keydown', onKey);
  },[imgModal.open,imgModal.group,imgModal.index]);
  useEffect(()=>{ window.scrollTo(0,0); },[]);

  /* ── Scroll-reveal helper ── */
  const revealRef = useRef([]);
  useEffect(()=>{
    const obs = new IntersectionObserver(entries=>{
      entries.forEach(e=>{ if(e.isIntersecting){ e.target.classList.add('vis'); obs.unobserve(e.target); } });
    },{threshold:0.12});
    revealRef.current.forEach(el=>{ if(el) obs.observe(el); });
    return ()=>obs.disconnect();
  },[]);
  const rv=(cls='')=>({ ref:el=>{ if(el&&!revealRef.current.includes(el)) revealRef.current.push(el); }, className:`cr${cls?' '+cls:''}` });
  const rvl=(cls='')=>({ ref:el=>{ if(el&&!revealRef.current.includes(el)) revealRef.current.push(el); }, className:`cr-left${cls?' '+cls:''}` });
  const rvr=(cls='')=>({ ref:el=>{ if(el&&!revealRef.current.includes(el)) revealRef.current.push(el); }, className:`cr-right${cls?' '+cls:''}` });
  const vt = p.visibleTabs || {};
  const ALL_DET_TABS = [
    { k:"overview", l:"Overview",   show: vt.overview  !== false },
    { k:"location", l:"Location",   show: vt.location  !== false },
    { k:"layouts",  l:"Layouts",    show: vt.layouts   !== false },
  ];
  const visDetTabs = ALL_DET_TABS.filter(t=>t.show);
  const [activeTab, setActiveTab] = useState(visDetTabs[0]?.k || "overview");
  const secRefs = useRef({});
  const scrollTo = (k) => {
    const el = secRefs.current[k];
    if(el) { const top = el.getBoundingClientRect().top + window.scrollY - 80; window.scrollTo({top, behavior:'smooth'}); }
  };
  useEffect(()=>{
    const handleScroll = () => {
      const entries = Object.entries(secRefs.current);
      let best = null, bestDist = Infinity;
      entries.forEach(([k, el])=>{
        if(!el) return;
        const rect = el.getBoundingClientRect();
        const dist = Math.abs(rect.top - 90);
        if(dist < bestDist){ bestDist = dist; best = k; }
      });
      if(best) setActiveTab(best);
    };
    window.addEventListener('scroll', handleScroll, {passive:true});
    return ()=>window.removeEventListener('scroll', handleScroll);
  },[]);
  const allImgs = [p.image,...(p.gallery||[])];
  const handleThumbClick = (i) => {
    try{
      if(window.innerWidth >= 1024) {
        setActiveImg(i);
      } else {
        openImage(allImgs[i], allImgs, i);
      }
    }catch(err){ setActiveImg(i); }
  };
  const amenities = Array.isArray(p.nearbyAmenities) ? p.nearbyAmenities : [];
  const unitTypes = Array.isArray(p.unitTypes) ? p.unitTypes : [];
  const mapSrc = p.coordinates?.lat
    ? `https://maps.google.com/maps?q=${p.coordinates.lat},${p.coordinates.lng}&z=15&output=embed`
    : null;
  const vs = p.visibleSections || {};
  // sec() checks BOTH tab-level AND section-level visibility — if a tab is disabled, all its sections return false
  const sec = (tabKey, secKey) => vt[tabKey] !== false && vs[`${tabKey}.${secKey}`] !== false;

  const CineSpecGroup = ({title, icon, rows}) => {
    const filled = rows.filter(([,v])=>v!=null&&String(v).trim()!==''&&String(v).trim()!=='—'&&!String(v).includes('undefined')&&!String(v).includes('NaN'));
    if(!filled.length) return null;
    return (
      <div className="cine-info-group">
        <div className="cine-info-group-title">{icon} {title}</div>
        <div className="cine-spec-table">
          {filled.map(([k,v],i)=>(
            <div key={i} className="cine-spec-row">
              <div className="cine-spec-key">{k}</div>
              <div className="cine-spec-val">{v}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const CAT_ICONS = {Education:'🎓',Healthcare:'🏥','Shopping & Dining':'🛍',Transport:'🚌','Beach & Leisure':'🏖','Heritage & Tourism':'🏛','Business & Industry':'🏭','Dining & Nightlife':'🍜'};
  const BENTO_ICONS = ['✦','◈','⬡','◉','▲','⬢','◇','★','⬟','◆'];
  const FAC_ICONS = {'Swimming Pool':'🏊','Gym':'🏋','Gymnasium':'🏋','BBQ Area':'🔥','Tennis Court':'🎾','Basketball Court':'🏀','Badminton Court':'🏸','Kids Playground':'🧸','Children Playground':'🧸','Jogging Track':'🏃','Garden':'🌿','Landscaped Garden':'🌿','Sky Garden':'🌱','Sauna':'🧖','Multi-Purpose Hall':'🏛','Function Room':'🏛','Reading Room':'📚','Library':'📚','Co-working Space':'💻','Mini Market':'🛒','Cafe':'☕','Restaurant':'🍽','Parking':'🚗','Car Park':'🚗','Security':'🔒','24-Hour Security':'🔒','CCTV':'📹','Concierge':'🔔','Sky Lounge':'🏢','Rooftop':'🌅','Infinity Pool':'🌊','Lap Pool':'🌊','Wading Pool':'🚿'};
  const getFacIcon = f => FAC_ICONS[f] || FAC_ICONS[Object.keys(FAC_ICONS).find(k=>f.toLowerCase().includes(k.toLowerCase()))||''] || '✨';
  const projectName = (p.name || 'Project').trim();
  const projectNameParts = projectName.split(/\s+/).filter(Boolean);
  const projectNameLead = projectNameParts.length > 1 ? projectNameParts.slice(0, -1).join(' ') : projectName;
  const projectNameAccent = projectNameParts.length > 1 ? projectNameParts[projectNameParts.length - 1] : '';
  const sizeRange = p.sizeSqft?.[0]
    ? `${p.sizeSqft[0].toLocaleString()}${p.sizeSqft?.[1] ? ` - ${p.sizeSqft[1].toLocaleString()}` : ''} sqft`
    : '';
  const priceRange = p.priceFrom && p.priceTo
    ? `${fmt(p.priceFrom)} - ${fmt(p.priceTo)}`
    : p.priceFrom
      ? fmt(p.priceFrom)
      : p.priceTo
        ? fmt(p.priceTo)
        : '';
  const shortOverview = p.description || `${p.type || 'Residential'} development${p.location ? ` in ${p.location}` : ''}${p.developer ? ` by ${p.developer}` : ''}.`;

  return (
    <div className="cine-det">
      {/* ── Ambient blobs ── */}
      <div className="cine-blobs" aria-hidden="true">
        <div className="cine-blob b1"/><div className="cine-blob b2"/>
        <div className="cine-blob b3"/><div className="cine-blob b4"/>
      </div>

      {/* ── Floating pill nav ── */}
      <nav className="cine-nav">
        <button className="cine-back" onClick={onClose}>
          ← <span>Back</span>
        </button>
        {visDetTabs.length > 1 && <>
          <div className="cine-nav-divider"/>
          {visDetTabs.map(({k,l})=>(
            <button key={k} className={`cine-nav-tab${activeTab===k?' on':''}`} onClick={()=>scrollTo(k)}>{l}</button>
          ))}
        </>}
      </nav>

      {/* ── CINEMATIC HERO ── */}
      <section className="cine-hero">
        <div
          className="cine-hero-bg"
          role="button"
          tabIndex={0}
          style={{cursor:'zoom-in'}}
          onClick={()=>openImage(allImgs[activeImg], allImgs, activeImg)}
          onKeyDown={e=>{ if(e.key==='Enter' || e.key===' ') openImage(allImgs[activeImg], allImgs, activeImg); }}
        >
          <img key={activeImg}
               src={allImgs[activeImg]}
               alt={p.name}
               style={{pointerEvents:'none'}}
               onError={e=>{e.target.onerror=null;e.target.src=FALLBACK_IMG;}}/>
        </div>
        <div className="cine-hero-overlay"/>
        <div className="cine-hero-side-glow"/>

        {allImgs.length > 1 && (
          <div className="cine-gal-nav">
            {allImgs.slice(0,6).map((img,i)=>(
              <div key={i} className={`cine-gal-thumb${activeImg===i?' on':''}`} onClick={()=>handleThumbClick(i)}>
                <img src={img} alt="" onClick={()=>handleThumbClick(i)} style={{cursor: window.innerWidth>=1024? 'pointer':'zoom-in'}} onError={e=>{e.target.onerror=null;e.target.src=FALLBACK_IMG;}}/>
              </div>
            ))}
          </div>
        )}
        {allImgs.length > 1 && <>
          <button className="cine-hero-nav-btn prev" onClick={()=>setActiveImg(i=>(i-1+allImgs.length)%allImgs.length)}>‹</button>
          <button className="cine-hero-nav-btn next" onClick={()=>setActiveImg(i=>(i+1)%allImgs.length)}>›</button>
        </>}

        {/* Hero overlay: name only */}
        <div className="cine-hero-content">
          <div className="cine-hero-name-only">
            <div className="cine-eyebrow">{p.developer}{p.location?` · ${p.location}`:''}</div>
            {p.tag && <div className="cine-tag-pill" style={{background:p.tagColor||'#BF9B4E'}}>{p.tag}</div>}
            <h1 className="cine-hero-title">{p.name}</h1>
          </div>
        </div>
      </section>

      {imgModal.open && (
        <div className="img-modal-ov" onClick={e=>e.target===e.currentTarget&&closeImage()}>
          <div className="img-modal">
            {imgModal.group && imgModal.group.length>1 && (
              <button className="img-modal-nav prev" onClick={()=>{
                setImgModal(m=>{ const ni=(m.index-1+m.group.length)%m.group.length; return {...m, index:ni, src:m.group[ni]}; });
              }}>‹</button>
            )}
            <div className="img-modal-body">
              <img src={imgModal.src} alt="" onError={e=>{e.target.onerror=null;e.target.src=FALLBACK_IMG;}} style={{maxWidth:'95vw',maxHeight:'90vh',objectFit:'contain',display:'block'}}/>
            </div>
            {imgModal.group && imgModal.group.length>1 && (
              <button className="img-modal-nav next" onClick={()=>{
                setImgModal(m=>{ const ni=(m.index+1)%m.group.length; return {...m, index:ni, src:m.group[ni]}; });
              }}>›</button>
            )}
            <button className="img-modal-close" onClick={closeImage}>✕</button>
          </div>
        </div>
      )}

      {/* ── Stats Strip below hero ── */}
      {(p.priceFrom>0||p.totalUnits>0||p.sizeSqft?.[0]>0||(p.bedrooms||[]).length>0||p.completion) && (
        <div className="cine-stats-strip">
          {p.priceFrom>0 && <div {...rv()} className="cr css-item"><div className="css-lbl">Starting From</div><div className="css-val">{fmt(p.priceFrom)}</div></div>}
          {p.totalUnits>0 && <div {...rv()} className="cr css-item"><div className="css-lbl">Total Units</div><div className="css-val">{p.totalUnits.toLocaleString()}<em>units</em></div></div>}
          {p.sizeSqft?.[0]>0 && <div {...rv()} className="cr css-item"><div className="css-lbl">Built-up From</div><div className="css-val">{p.sizeSqft[0].toLocaleString()}<em>sf</em></div></div>}
          {(p.bedrooms||[]).length>0 && <div {...rv()} className="cr css-item"><div className="css-lbl">Bedrooms</div><div className="css-val">{bLbl(p.bedrooms)}<em>bed</em></div></div>}
          {p.completion && <div {...rv()} className="cr css-item"><div className="css-lbl">Completion</div><div className="css-val" style={{fontSize:'1.2rem'}}>{p.completion}</div></div>}
        </div>
      )}

      <div className="cine-sections">

        {/* ═══ OVERVIEW ═══ */}
        <div ref={el=>secRefs.current.overview=el} data-sec="overview">

          {/* Key Highlights — Bento grid */}
          {sec("overview","highlights") && (p.highlights||[]).length>0 && (
            <section className="cine-section" style={{position:'relative'}}>
              <div className="cine-sec-num">01</div>
              <div {...rv()} className="cr cine-sec-label">
                <div className="cine-sec-eyebrow">Signature Features</div>
                <h2 className="cine-sec-title">Key <em>Highlights</em></h2>
              </div>
              <div className="cine-bento">
                {(p.highlights||[]).map((h,i)=>(
                  <div {...rv(`d${Math.min(i+1,6)}`)} key={i} className={`cr d${Math.min(i+1,6)} cine-bento-card${i===0||i===3?' lg':''}`}>
                    <div className="cine-bento-icon">{BENTO_ICONS[i%BENTO_ICONS.length]}</div>
                    <div className="cine-bento-title">{h}</div>
                    <div className="cine-bento-accent"/>
                  </div>
                ))}
              </div>
            </section>
          )}


          {/* ═══ PROJECT INFORMATION — SAMPLE-STYLE REDESIGN ═══ */}
          {(sec("overview","basicInfo")||sec("overview","development")||sec("overview","unitInfo")||sec("overview","parking")||sec("overview","facilities")||sec("overview","financial")||sec("overview","sales")) && (
            <section className="cine-section">
              <div {...rv()} className="cr cine-sec-label">
                <div className="cine-sec-eyebrow">Development Details</div>
                <h2 className="cine-sec-title">Project <em>Information</em></h2>
              </div>

              <div className="lux-pi-wrap">
                <div className="lux-pi-atmo" aria-hidden="true">
                  <span className="lux-pi-orb o1"/>
                  <span className="lux-pi-orb o2"/>
                  <span className="lux-pi-orb o3"/>
                  <span className="lux-pi-orb o4"/>
                  <span className="lux-pi-ray r1"/>
                  <span className="lux-pi-ray r2"/>
                  <span className="lux-pi-grid"/>
                  <span className="lux-pi-spark s1"/>
                  <span className="lux-pi-spark s2"/>
                  <span className="lux-pi-spark s3"/>
                  <span className="lux-pi-spark s4"/>
                  <span className="lux-pi-spark s5"/>
                  <span className="lux-pi-spark s6"/>
                </div>
                {sec("overview","basicInfo") && (
                  <div {...rv()} className="cr lux-pi-hero-card">
                    <div className="lux-pi-hero-grid">
                      <div className="lux-pi-hero-left">
                        <div className="lux-pi-eyebrow">Development Details</div>
                        <h3 className="lux-pi-title">
                          {projectNameLead}
                          {projectNameAccent && <span className="lux-pi-title-accent">{projectNameAccent}</span>}
                        </h3>
                        <p className="lux-pi-desc">{shortOverview}</p>

                        <div className="lux-pi-quick-grid">
                          <div className="lux-pi-quick-card">
                            <div className="lux-pi-quick-lbl">Starting From</div>
                            <div className="lux-pi-quick-val">{p.priceFrom ? fmt(p.priceFrom) : '—'}</div>
                          </div>
                          <div className="lux-pi-quick-card">
                            <div className="lux-pi-quick-lbl">Total Units</div>
                            <div className="lux-pi-quick-val">{p.totalUnits ? p.totalUnits.toLocaleString() : '—'}</div>
                          </div>
                          <div className="lux-pi-quick-card">
                            <div className="lux-pi-quick-lbl">Tenure</div>
                            <div className="lux-pi-quick-val">{p.tenure || '—'}</div>
                          </div>
                          <div className="lux-pi-quick-card">
                            <div className="lux-pi-quick-lbl">Completion</div>
                            <div className="lux-pi-quick-val">{p.completion || '—'}</div>
                          </div>
                        </div>
                      </div>

                      <div className="lux-pi-hero-right">
                        <div className="lux-pi-side-stack">
                          <div className="lux-pi-side-block">
                            <div className="lux-pi-side-lbl">Developer</div>
                            <div className="lux-pi-side-val">{p.developer || '—'}</div>
                          </div>
                          <div className="lux-pi-side-block">
                            <div className="lux-pi-side-lbl">Property Type</div>
                            <div className="lux-pi-side-val">{p.type || '—'}</div>
                          </div>
                          <div className="lux-pi-side-block">
                            <div className="lux-pi-side-lbl">Location</div>
                            <div className="lux-pi-side-val">{p.location || '—'}</div>
                          </div>
                          <div className="lux-pi-side-block">
                            <div className="lux-pi-side-lbl">Land Size</div>
                            <div className="lux-pi-side-val">{p.landSize || '—'}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {(sec("overview","development") || sec("overview","unitInfo") || sec("overview","facilities") || sec("overview","parking")) && (
                  <div className="lux-pi-detail-grid">
                    {sec("overview","development") && (
                      <article {...rv()} className="cr lux-pi-panel">
                        <div className="lux-pi-panel-head"><span className="lux-pi-panel-dot"/><div className="lux-pi-panel-hd">Development Details</div></div>
                        <div className="lux-pi-lines">
                          <div className="lux-pi-line-item"><div className="lux-pi-line-lbl">Construction Stage</div><div className="lux-pi-line-val">{p.constructionStage || '—'}</div></div>
                          <div className="lux-pi-line-item"><div className="lux-pi-line-lbl">Floors / Levels</div><div className="lux-pi-line-val">{(p.totalFloorsPerTower||[]).length>0 ? p.totalFloorsPerTower.join(' | ') : (p.floors ? `${p.floors} floors` : '—')}</div></div>
                          <div className="lux-pi-line-item"><div className="lux-pi-line-lbl">Total Floors</div><div className="lux-pi-line-val">{p.floors ? `${p.floors} floors` : '—'}</div></div>
                          <div className="lux-pi-line-item"><div className="lux-pi-line-lbl">Residential Start</div><div className="lux-pi-line-val">{p.residentialStartLevel || '—'}</div></div>
                        </div>
                      </article>
                    )}

                    {sec("overview","unitInfo") && (
                      <article {...rv()} className="cr lux-pi-panel">
                        <div className="lux-pi-panel-head"><span className="lux-pi-panel-dot"/><div className="lux-pi-panel-hd">Unit Information</div></div>
                        <div className="lux-pi-lines">
                          <div className="lux-pi-line-item"><div className="lux-pi-line-lbl">Bedrooms</div><div className="lux-pi-line-val">{p.bedrooms?.length ? `${bLbl(p.bedrooms)} Bedrooms` : '—'}</div></div>
                          <div className="lux-pi-line-item"><div className="lux-pi-line-lbl">Bathrooms</div><div className="lux-pi-line-val">{p.bathrooms?.length ? `${bLbl(p.bathrooms)} Bathrooms` : '—'}</div></div>
                          <div className="lux-pi-line-item"><div className="lux-pi-line-lbl">Size Range</div><div className="lux-pi-line-val">{sizeRange || '—'}</div></div>
                          <div className="lux-pi-line-item"><div className="lux-pi-line-lbl">Public / Bumi</div><div className="lux-pi-line-val">{p.unitsBreakdown || '—'}</div></div>
                        </div>
                      </article>
                    )}

                    {(sec("overview","facilities") || sec("overview","parking")) && (
                      <article {...rv()} className="cr lux-pi-panel">
                        <div className="lux-pi-panel-head"><span className="lux-pi-panel-dot"/><div className="lux-pi-panel-hd">Facilities & Access</div></div>
                        {sec("overview","facilities") && (
                          <div className="lux-pi-fac-pills">
                            {(p.facilities||[]).length>0
                              ? (p.facilities||[]).map((item,idx)=>(
                                  <span key={idx} className="lux-pi-fac-pill">{getFacIcon(item)} {item}</span>
                                ))
                              : <span className="lux-pi-line-val">No facilities listed.</span>
                            }
                          </div>
                        )}
                        {sec("overview","parking") && (
                          <div className="lux-pi-park-wrap">
                            <div className="lux-pi-line-item"><div className="lux-pi-line-lbl">Parking Bays</div><div className="lux-pi-line-val">{p.numberOfCarParks || '—'}</div></div>
                            <div className="lux-pi-line-item"><div className="lux-pi-line-lbl">Parking Type</div><div className="lux-pi-line-val">{p.carParkLevels || '—'}</div></div>
                            {p.parkingNotes && <div className="lux-pi-note">{p.parkingNotes}</div>}
                          </div>
                        )}
                      </article>
                    )}
                  </div>
                )}

                {(sec("overview","financial") || sec("overview","sales")) && (
                  <div {...rv()} className="cr lux-pi-fin-wrap">
                    <div className="lux-pi-panel-head"><span className="lux-pi-panel-dot"/><div className="lux-pi-panel-hd">Financial Information</div></div>
                    <div className="lux-pi-fin-grid">
                      <div className="lux-pi-fin-card">
                        <div className="lux-pi-fin-lbl">Price Range</div>
                        <div className="lux-pi-fin-val">{priceRange || '—'}</div>
                      </div>
                      <div className="lux-pi-fin-card">
                        <div className="lux-pi-fin-lbl">Maintenance</div>
                        <div className="lux-pi-fin-val">{p.maintenanceFee || '—'}</div>
                        {p.maintenanceFee && <div className="lux-pi-fin-sub">per month</div>}
                      </div>
                      <div className="lux-pi-fin-card">
                        <div className="lux-pi-fin-lbl">Sinking Fund</div>
                        <div className="lux-pi-fin-val">{p.sinkingFund || '—'}</div>
                        {p.sinkingFund && <div className="lux-pi-fin-sub">per month</div>}
                      </div>
                      <div className="lux-pi-fin-card">
                        <div className="lux-pi-fin-lbl">Showroom</div>
                        <div className="lux-pi-fin-val">{sec("overview","sales") ? (p.showroom || '—') : 'Hidden'}</div>
                        {sec("overview","sales") && p.scaleModel && <div className="lux-pi-fin-sub">Scale Model: {p.scaleModel}</div>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

        </div>

        {/* ═══ LOCATION ═══ */}
        <div ref={el=>secRefs.current.location=el} data-sec="location">
          {vt.location !== false && (<>
          <div className="cine-divider"><div className="cine-divider-gem"/></div>
          <section className="cine-section" style={{position:'relative'}}>
            <div className="cine-sec-num">05</div>
            <div {...rv()} className="cr cine-sec-label">
              <div className="cine-sec-eyebrow">{p.location}</div>
              <h2 className="cine-sec-title">Prime <em>Location</em></h2>
            </div>
            <div className="cine-loc">
              <div {...rvl()} className="cr-left cine-loc-left">
                {sec("location","map") && (
                  <div className="cine-map-wrap">
                    {mapSrc
                      ? <iframe src={mapSrc} title="Location Map" loading="lazy" referrerPolicy="no-referrer-when-downgrade" allowFullScreen/>
                      : <div className="cine-map-placeholder">📍<span>{p.location}</span></div>
                    }
                    <div className="cine-map-overlay-tag">📍 {p.name} · {p.location}</div>
                  </div>
                )}
              </div>
              <div {...rvr()} className="cr-right cine-loc-right">
                {sec("location","amenities") && amenities.length>0 && (<>
                  <div className="cine-sec-label" style={{marginBottom:'1.5rem'}}>
                    <div className="cine-sec-eyebrow">Surroundings</div>
                    <h3 className="cine-sec-title" style={{fontSize:'1.8rem'}}>Nearby <em>Amenities</em></h3>
                  </div>
                  <div className="cine-amenities-grid">
                    {amenities.map((cat,i)=>(
                      <div {...rv(`d${Math.min(i+1,6)}`)} key={i} className={`cr d${Math.min(i+1,6)} cine-amenity-card`}>
                        <div className="cine-amenity-hd">
                          <div className="cine-amenity-icon">{CAT_ICONS[cat.category]||'📍'}</div>
                          {cat.category}
                        </div>
                        {(cat.items||[]).map((item,j)=>(
                          <div key={j} className="cine-amenity-item"><div className="cine-amenity-dot"/>{item}</div>
                        ))}
                      </div>
                    ))}
                  </div>
                </>)}
              </div>
            </div>
          </section>
          </>)}
        </div>

        {/* ═══ UNIT LAYOUTS ═══ */}
        <div ref={el=>secRefs.current.layouts=el} data-sec="layouts">
          {vt.layouts !== false && (
          <section className="cine-section">
            <div className="cine-sec-label">
              <div className="cine-sec-eyebrow">Floor Plans</div>
              <h2 className="cine-sec-title">Unit <em>Layouts</em></h2>
            </div>
            {sec("layouts","unitTypes") && (
              unitTypes.length===0
                ? <div className="cine-unit-empty">📐 No unit layouts available for this project.</div>
                : <div className="cine-unit-list">
                    {unitTypes.map((ut,i)=>(
                      <div
                        key={i}
                        ref={el=>{ if(el&&!revealRef.current.includes(el)) revealRef.current.push(el); }}
                        className="cr cine-unit-card"
                      >
                        <div className="cine-unit-img">
                          {ut.image
                            ? <img
                                src={ut.image}
                                alt={ut.name||ut.label}
                                style={{cursor:'zoom-in'}}
                                tabIndex={0}
                                onClick={()=>openImage(ut.image,[ut.image],0)}
                                onKeyDown={e=>{ if(e.key==='Enter' || e.key===' ') openImage(ut.image,[ut.image],0); }}
                                onError={e=>{e.target.onerror=null;e.target.src=FALLBACK_IMG;}}
                              />
                            : <div className="cine-unit-noimg">📐</div>
                          }
                          <div className="cine-unit-img-overlay"/>
                          <div className="cine-unit-img-label">{ut.label||`Type ${String.fromCharCode(65+i)}`}</div>
                        </div>
                        <div className="cine-unit-body">
                          <div>
                            <div className="cine-unit-label">Unit Type {i+1}</div>
                            <div className="cine-unit-name">{ut.name||`${ut.label||'Layout'}`}</div>
                            {ut.priceFrom && (
                              <div className="cine-unit-price">
                                <span className="cine-unit-price-lbl">From</span>
                                <span className="cine-unit-price-val">{ut.priceFrom}</span>
                              </div>
                            )}
                            <div className="cine-unit-pills">
                              {ut.beds>0 && <span className="cine-unit-pill">🛏 {ut.beds} Bed{ut.beds>1?'s':''}</span>}
                              {ut.baths>0 && <span className="cine-unit-pill">🚿 {ut.baths} Bath</span>}
                              {ut.size && <span className="cine-unit-pill">📐 {ut.size}{/sqft|sq ft|sf\b/i.test(ut.size)?'':' sqft'}</span>}
                            </div>
                          </div>
                          <button className="cine-unit-cta" onClick={onRegisterInterest}>Enquire Now →</button>
                        </div>
                      </div>
                    ))}
                  </div>
            )}
            {sec("layouts","upgrades") && p.upgrades && (
              <div className="cine-upgrades">
                <div className="cine-upgrades-title">🔧 Upgrade Specifications</div>
                <div className="cine-upgrades-body">{p.upgrades}</div>
              </div>
            )}
            {!sec("layouts","unitTypes") && !sec("layouts","upgrades") && vt.layouts !== false && (
              <div className="cine-unit-empty">🔒 Content hidden by admin settings.</div>
            )}
          </section>
          )}
        </div>

        {/* ═══ FOOTER CTA ═══ */}
        {vs["overview.priceBar"] !== false && (<>
        <div className="cine-divider"><div className="cine-divider-gem"/></div>
        <div className="cine-footer">
          <div className="cine-footer-eye">Limited Units Available</div>
          <div className="cine-footer-title">Ready to Make <em>Your Move?</em></div>
          <p className="cine-footer-sub">
            Register your interest today and our consultants will get back to you with exclusive pricing, availability, and showroom scheduling for {p.name}.
          </p>
          <div className="cine-footer-btns">
            <button className="cine-cta-pri" onClick={onRegisterInterest}>Register Interest</button>
            {p.showroom && p.showroom.trim().toLowerCase()!=="no" && p.showroom.trim()!=="" && (
              <button className="cine-cta-sec" onClick={onVisitShowroom}>Visit Showroom</button>
            )}
          </div>
          <div className="cine-footer-bottom">
            <div className="cine-footer-logo">NB <span style={{opacity:.35}}>Property</span></div>
            <div>{p.name} · {p.location}</div>
            <div>© {new Date().getFullYear()} NB Property</div>
          </div>
        </div>
        </>)}

      </div>

      {/* ═══ FLOATING ACTION BUTTON ═══ */}
      <div className="cine-fab">
        <div className={`cine-fab-actions${fabOpen?' open':''}`}>
          <button className="cine-fab-action" onClick={()=>{setFabOpen(false);onRegisterInterest();}}>
            <span className="cine-fab-action-ico">✉️</span>Register Interest
          </button>
          {p.showroom&&p.showroom.trim().toLowerCase()!=="no"&&p.showroom.trim()!==""&&(
            <button className="cine-fab-action" onClick={()=>{setFabOpen(false);onVisitShowroom();}}>
              <span className="cine-fab-action-ico">📍</span>Visit Showroom
            </button>
          )}
        </div>
        <button className={`cine-fab-main${fabOpen?' open':''}`} onClick={()=>setFabOpen(v=>!v)} aria-label="Quick Actions">
          <span className="cine-fab-main-ico phone">📞</span>
          <span className="cine-fab-main-ico close">✕</span>
        </button>
      </div>

    </div>
  );
}

/* ═══ UNIT TYPE EDITOR (admin form) ═══ */
function UnitTypeEditor({unitTypes, onChange}){
  const types = Array.isArray(unitTypes) ? unitTypes : [];
  const update=(i,k,v)=>{ const next=[...types]; next[i]={...next[i],[k]:v}; onChange(next); };
  const add=()=>onChange([...types,{...EMPTY_UNIT_TYPE}]);
  const remove=i=>onChange(types.filter((_,j)=>j!==i));
  return(
    <div className="ut-editor">
      {types.map((ut,i)=>(
        <div key={i} className="ut-editor-row">
          <div className="ut-editor-row-hd">
            <div className="ut-editor-row-title">Unit Type {i+1}: {ut.label||"(unnamed)"}</div>
            <button className="ut-rm-btn" onClick={()=>remove(i)} title="Remove">✕</button>
          </div>
          <div className="ut-row-grid" style={{marginBottom:".6rem"}}>
            <div className="a-ff"><label className="a-flbl">Label</label><input className="a-inp" value={ut.label||""} placeholder="e.g. Type A" onChange={e=>update(i,"label",e.target.value)}/></div>
            <div className="a-ff"><label className="a-flbl">Name</label><input className="a-inp" value={ut.name||""} placeholder="e.g. 2-Bedroom" onChange={e=>update(i,"name",e.target.value)}/></div>
            <div className="a-ff"><label className="a-flbl">Price From</label><input className="a-inp" value={ut.priceFrom||""} placeholder="e.g. From RM 480,000" onChange={e=>update(i,"priceFrom",e.target.value)}/></div>
          </div>
          <div className="ut-row-grid" style={{marginBottom:".6rem"}}>
            <div className="a-ff"><label className="a-flbl">Beds</label><input className="a-inp" type="number" min="0" value={ut.beds||""} placeholder="2" onChange={e=>update(i,"beds",Number(e.target.value))}/></div>
            <div className="a-ff"><label className="a-flbl">Baths</label><input className="a-inp" type="number" min="0" value={ut.baths||""} placeholder="2" onChange={e=>update(i,"baths",Number(e.target.value))}/></div>
            <div className="a-ff"><label className="a-flbl">Size (sqft)</label><input className="a-inp" value={ut.size||""} placeholder="e.g. 900 sqft" onChange={e=>update(i,"size",e.target.value)}/></div>
          </div>
          <div className="a-ff" style={{marginBottom:".6rem"}}>
            <label className="a-flbl">Layout Image URL</label>
            <input className="a-inp" value={ut.image||""} placeholder="https://..." onChange={e=>update(i,"image",e.target.value)}/>
            {ut.image&&<img className="ut-img-mini" src={ut.image} alt="" onError={e=>e.target.style.display="none"} onLoad={e=>e.target.style.display="block"}/>}
          </div>
        </div>
      ))}
      <button className="ut-add-btn" onClick={add}>+ Add Unit Type</button>
    </div>
  );
}

/* ═══ PDF.js TEXT-BASED FALLBACK PARSER ═══ */
async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  // Use pdf.js 3.x UMD build for maximum browser compatibility
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
  const lib = window.pdfjsLib;
  if (!lib) throw new Error("Failed to load PDF.js library");
  lib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return lib;
}

async function extractPdfText(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items.map(it => it.str).join(" "));
  }
  return pages.join("\n");
}

function parsePdfTextToFields(text) {
  const result = {};
  const t = text.replace(/\s+/g, " ");

  // Helper: first regex match
  const m = (regex) => { const r = t.match(regex); return r ? r[1].trim() : null; };
  const mi = (regex) => { const r = t.match(regex); return r ? parseInt(r[1].replace(/,/g,""),10) : null; };

  // Project name — typically the largest/first prominent text; try common patterns
  result.name = m(/(?:project\s*name|nama\s*projek)[:\s–-]*([^\n|·•,]{3,80})/i)
    || m(/^([A-Z][A-Za-z0-9 &'@.()-]{4,60})\s/);
  result.developer = m(/(?:developer|developed\s*by|pemaju)[:\s–-]*([^\n|·•]{3,80})/i);
  result.location = m(/(?:location|lokasi|address|alamat)[:\s–-]*([^\n|·•]{5,120})/i);

  // Type
  const typeMap = {"condominium":"Condominium","condo":"Condominium","semi-d":"Semi-Detached","semi detached":"Semi-Detached","semi-detached":"Semi-Detached","serviced apartment":"Serviced Apartment","serviced residence":"Serviced Apartment","shophouse":"Shophouse","shop house":"Shophouse","terrace":"Terrace House","terraced":"Terrace House","townhouse":"Terrace House","soho":"SoHo / Office","sovo":"SoHo / Office","office":"SoHo / Office","bungalow":"Bungalow","duplex":"Duplex"};
  const tl = t.toLowerCase();
  for (const [kw, val] of Object.entries(typeMap)) { if (tl.includes(kw)) { result.type = val; break; } }

  // Tenure
  if (/freehold/i.test(t)) result.tenure = "Freehold";
  else if (/leasehold/i.test(t)) result.tenure = "Leasehold";

  // Status
  if (/completed|siap/i.test(t)) result.status = "Completed";
  else if (/under\s*construction|sedang\s*dibina/i.test(t)) result.status = "Under Construction";
  else if (/new\s*launch|pelancaran\s*baru/i.test(t)) result.status = "New Launch";
  else if (/sold\s*out|habis\s*dijual/i.test(t)) result.status = "Sold Out";

  result.completion = m(/(?:completion|expected\s*completion|est\.?\s*completion|siap)[:\s–-]*(Q[1-4]\s*\d{4}|\d{4})/i);
  result.landSize = m(/(?:land\s*(?:area|size)|keluasan\s*tanah)[:\s–-]*([\d.,]+\s*(?:acres?|hectares?|sq\s*ft|sf))/i);
  result.constructionStage = m(/(?:construction\s*stage|progress)[:\s–-]*([^\n|·•]{3,100})/i);

  // Numeric fields
  result.totalUnits = mi(/(?:total\s*units?|jumlah\s*unit)[:\s–-]*([\d,]+)/i);
  result.floors = mi(/(?:total\s*(?:floors?|storeys?|levels?)|tingkat)[:\s–-]*([\d,]+)/i);
  result.totalBlocks = mi(/(?:total\s*(?:blocks?|towers?))[:\s–-]*([\d,]+)/i);

  // Size range
  const szMatch = t.match(/(?:built[\s-]*up|size|keluasan)[:\s–-]*([\d,]+)\s*(?:[-–to]+)\s*([\d,]+)\s*(?:sq\s*ft|sf)/i);
  if (szMatch) result.sizeSqft = `${szMatch[1].replace(/,/g,"")}-${szMatch[2].replace(/,/g,"")}`;
  else { const szSingle = m(/(?:built[\s-]*up|size|keluasan)[:\s–-]*([\d,]+\s*(?:sq\s*ft|sf))/i); if(szSingle) result.sizeSqft = szSingle; }

  // Bedrooms / bathrooms
  const bedMatch = t.match(/([\d,]+)\s*(?:[-–to]+)\s*([\d,]+)\s*(?:bed(?:room)?s?)/i);
  if (bedMatch) result.bedrooms = `${bedMatch[1]}, ${bedMatch[2]}`;
  else { const b = m(/(\d+)\s*(?:bed(?:room)?s?)/i); if(b) result.bedrooms = b; }
  const bathMatch = t.match(/([\d,]+)\s*(?:[-–to]+)\s*([\d,]+)\s*(?:bath(?:room)?s?)/i);
  if (bathMatch) result.bathrooms = `${bathMatch[1]}, ${bathMatch[2]}`;
  else { const b = m(/(\d+)\s*(?:bath(?:room)?s?)/i); if(b) result.bathrooms = b; }

  // Pricing
  const priceAll = [...t.matchAll(/RM\s*([\d,]+(?:\.\d+)?(?:\s*(?:mil(?:lion)?|k))?)/gi)].map(x => {
    let v = x[1].replace(/,/g,"").trim();
    if (/mil/i.test(v)) v = parseFloat(v) * 1000000;
    else if (/k$/i.test(v)) v = parseFloat(v) * 1000;
    else v = parseFloat(v);
    return isNaN(v) ? 0 : v;
  }).filter(v => v >= 50000 && v <= 50000000).sort((a,b) => a-b);
  if (priceAll.length >= 2) { result.priceFrom = priceAll[0]; result.priceTo = priceAll[priceAll.length-1]; }
  else if (priceAll.length === 1) { result.priceFrom = priceAll[0]; }

  // Parking
  result.numberOfCarParks = m(/(?:car\s*parks?|parking\s*(?:bays?|lots?))[:\s–-]*([\d,]+\s*(?:bays?|lots?|units?)?)/i);
  result.carParkLevels = m(/(?:car\s*park\s*levels?|parking\s*levels?)[:\s–-]*([^\n|·•]{2,60})/i);
  result.parkingNotes = m(/(?:parking\s*notes?|parking\s*info)[:\s–-]*([^\n|·•]{3,120})/i);
  result.numberOfLifts = m(/(?:lifts?|elevators?)[:\s–-]*([\d]+[^\n|·•]{0,60})/i);

  // Maintenance
  result.maintenanceFee = m(/(?:maintenance\s*fee|service\s*charge|caj\s*penyelenggaraan)[:\s–-]*(RM[^\n|·•]{2,60})/i);
  result.sinkingFund = m(/(?:sinking\s*fund|tabung\s*penjelas)[:\s–-]*(RM[^\n|·•]{2,60})/i);

  // Facilities & highlights — grab comma / bullet lists after keywords
  const facMatch = t.match(/(?:facilities|kemudahan)[:\s–-]*([^\n]{10,400})/i);
  if (facMatch) result.facilities = facMatch[1].replace(/[•·|]+/g,",").trim();
  const hiMatch = t.match(/(?:highlights?|ciri[- ]?ciri)[:\s–-]*([^\n]{10,400})/i);
  if (hiMatch) result.highlights = hiMatch[1].replace(/[•·|]+/g,",").trim();

  result.showroom = m(/(?:show\s*room|gallery|galeri)[:\s–-]*([^\n|·•]{3,120})/i);
  result.upgrades = m(/(?:upgrades?|finishes|specifications?)[:\s–-]*([^\n]{10,300})/i);
  result.description = m(/(?:description|about\s*the\s*project|overview)[:\s–-]*([^\n]{15,500})/i);

  result.residentialStartLevel = m(/(?:residential\s*(?:start|from)\s*level)[:\s–-]*([^\n|·•]{2,40})/i);
  result.unitsBreakdown = m(/(?:units?\s*breakdown|bumi(?:putera)?\s*quota)[:\s–-]*([^\n|·•]{3,80})/i);
  result.unitsPerTower = m(/(?:units?\s*per\s*tower)[:\s–-]*([^\n|·•]{3,80})/i);

  // Clean nulls
  for (const k of Object.keys(result)) { if (result[k] === null || result[k] === undefined) delete result[k]; }
  return result;
}

/* ═══ AI PDF PARSER ═══ */
async function parsePDFWithAI(base64Data) {
  const response = await fetch("/api/parse-pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64Data }),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `API error ${response.status}`);
  }
  return response.json();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ═══ AI PDF UPLOAD WIDGET ═══ */
function AIPDFWidget({ onAutofill }) {
  const [file, setFile] = useState(null);
  const [step, setStep] = useState("idle"); // idle | loading | done | error | fallback-loading | fallback-done
  const [progress, setProgress] = useState(0); // 0-3
  const [filledFields, setFilledFields] = useState([]);
  const [errMsg, setErrMsg] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [usedFallback, setUsedFallback] = useState(false);

  const STEPS = [
    "Reading PDF document…",
    "Sending to AI for analysis…",
    "Extracting property details…",
    "Filling in form fields…",
  ];

  const FALLBACK_STEPS = [
    "Loading PDF reader…",
    "Extracting text from pages…",
    "Matching fields with patterns…",
    "Filling in form fields…",
  ];

  const handleFile = f => {
    if (!f || f.type !== "application/pdf") { setErrMsg("Please upload a PDF file."); return; }
    if (f.size > 20 * 1024 * 1024) { setErrMsg("File too large (max 20 MB)."); return; }
    setFile(f); setErrMsg(""); setStep("idle"); setFilledFields([]); setUsedFallback(false);
  };

  const handleDrop = e => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    handleFile(f);
  };

  // Shared: map result object → form patch + filled list
  // Handles both direct-key matches AND aliased keys from AI (projectName→name etc.)
  const applyResult = (result) => {
    const filled = [];
    const formPatch = {};

    // Normalise: merge AI aliased keys into canonical form keys
    const r = { ...result };
    const ALIASES = {
      name:                  ["projectName","project_name","project","title"],
      developer:             ["developerName","developer_name","developedBy"],
      location:              ["address","projectLocation","project_location"],
      type:                  ["propertyType","property_type","projectType"],
      status:                ["projectStatus","project_status","currentStatus"],
      completion:            ["completionDate","completion_date","expectedCompletion","targetCompletion"],
      tenure:                ["landTenure"],
      landSize:              ["land_size","siteArea","site_area","plotSize"],
      constructionStage:     ["construction_stage","buildingStage","currentStage","stage"],
      totalBlocks:           ["total_blocks","numBlocks","numberOfBlocks","blocks"],
      floors:                ["totalFloors","total_floors","numFloors","numberOfFloors","storeys"],
      totalUnits:            ["total_units","numUnits","numberOfUnits","units"],
      residentialStartLevel: ["residentialStart","residential_start","startLevel"],
      unitsBreakdown:        ["units_breakdown","bumiBreakdown","publicBumiBreakdown"],
      unitsPerTower:         ["units_per_tower","unitsPerBlock"],
      bedrooms:              ["bedroom","beds","numBedrooms","numberOfBedrooms"],
      bathrooms:             ["bathroom","baths","numBathrooms","numberOfBathrooms"],
      sizeSqft:              ["builtUpArea","built_up_area","size","unitSize","builtUp","sizeRange","builtUpAreaMin"],
      carParkLevels:         ["car_park_levels","parkingLevels","carpark_levels"],
      numberOfCarParks:      ["carparks","numberOfCarparks","numCarParks","parkingBays","car_parks"],
      parkingNotes:          ["parking_notes","parkingInfo","parking_info"],
      numberOfLifts:         ["lifts","numLifts","elevators","numberOfElevators"],
      priceFrom:             ["priceMin","price_from","price_min","startingPrice","starting_price","fromPrice"],
      priceTo:               ["priceMax","price_to","price_max","maxPrice","toPrice"],
      maintenanceFee:        ["maintenance_fee","service_charge","maintenanceCharge","maintFee"],
      sinkingFund:           ["sinking_fund","sinkFund"],
      showroom:              ["showroomInfo","showroom_info","showroomLocation","gallery"],
      scaleModel:            ["scale_model","modelUnit","model_unit"],
      description:           ["projectDescription","project_description","overview","about"],
      highlights:            ["keyHighlights","key_highlights","sellingPoints","selling_points","features"],
      facilities:            ["amenities","projectFacilities","project_facilities","facilityList"],
      upgrades:              ["specifications","specs","finishes","interior","interiorSpecs"],
      image:                 ["mainImage","main_image","coverImage","cover_image","heroImage","imageUrl","imageURL"],
      gallery:               ["galleryImages","gallery_images","images","photos"],
      tag:                   ["projectTag","project_tag","badge","label"],
    };
    for (const [canonical, alts] of Object.entries(ALIASES)) {
      if (!r[canonical] || r[canonical] === null || r[canonical] === "") {
        for (const alt of alts) {
          if (r[alt] !== null && r[alt] !== undefined && r[alt] !== "") {
            r[canonical] = r[alt];
            break;
          }
        }
      }
    }

    // String fields: join arrays, skip nulls
    const STRING_FIELDS = {
      name:"Project Name", developer:"Developer", location:"Location", type:"Property Type",
      status:"Status", completion:"Completion Date", tenure:"Tenure", landSize:"Land Size",
      constructionStage:"Construction Stage", totalBlocks:"Total Blocks", floors:"Total Floors",
      totalUnits:"Total Units", residentialStartLevel:"Residential Start Level",
      unitsBreakdown:"Units Breakdown", unitsPerTower:"Units per Tower",
      bedrooms:"Bedrooms", bathrooms:"Bathrooms", sizeSqft:"Size (sqft)",
      carParkLevels:"Car Park Levels", numberOfCarParks:"No. of Car Parks",
      parkingNotes:"Parking Notes", numberOfLifts:"No. of Lifts",
      maintenanceFee:"Maintenance Fee", sinkingFund:"Sinking Fund",
      showroom:"Showroom", scaleModel:"Scale Model",
      description:"Description", highlights:"Highlights", facilities:"Facilities",
      upgrades:"Upgrades", image:"Main Image", tag:"Badge Tag",
    };
    for (const [k, label] of Object.entries(STRING_FIELDS)) {
      const v = r[k];
      if (v !== null && v !== undefined && v !== "") {
        formPatch[k] = Array.isArray(v) ? v.join(", ") : String(v);
        filled.push(label);
      }
    }

    // Price: extract numeric value if string contains currency
    const parsePrice = (v) => {
      if (typeof v === "number") return v;
      if (typeof v === "string") {
        const clean = v.replace(/[^\d.]/g, "");
        const n = parseFloat(clean);
        if (/mil/i.test(v)) return n * 1000000;
        if (/k$/i.test(v)) return n * 1000;
        return n;
      }
      return null;
    };
    if (r.priceFrom !== null && r.priceFrom !== undefined && r.priceFrom !== "") {
      const n = parsePrice(r.priceFrom);
      if (n && !isNaN(n)) { formPatch.priceFrom = String(Math.round(n)); filled.push("Price From"); }
    }
    if (r.priceTo !== null && r.priceTo !== undefined && r.priceTo !== "") {
      const n = parsePrice(r.priceTo);
      if (n && !isNaN(n)) { formPatch.priceTo = String(Math.round(n)); filled.push("Price To"); }
    }

    // totalFloorsPerTower — array → comma string
    if (Array.isArray(r.totalFloorsPerTower) && r.totalFloorsPerTower.length) {
      formPatch.totalFloorsPerTower = r.totalFloorsPerTower.join(", ");
      filled.push("Floors per Tower");
    } else if (typeof r.totalFloorsPerTower === "string" && r.totalFloorsPerTower) {
      formPatch.totalFloorsPerTower = r.totalFloorsPerTower;
      filled.push("Floors per Tower");
    }

    // Gallery — array → comma string of URLs
    if (Array.isArray(r.gallery) && r.gallery.length) {
      formPatch.gallery = r.gallery.join(", ");
      filled.push("Gallery Images");
    }

    // Coordinates — can come as { lat, lng } object or flat keys
    const lat = r.coordinateLat ?? r.coordinates?.lat ?? r.lat ?? r.latitude;
    const lng = r.coordinateLng ?? r.coordinates?.lng ?? r.lng ?? r.longitude;
    if (lat && !isNaN(parseFloat(lat))) { formPatch.coordinateLat = String(parseFloat(lat).toFixed(6)); filled.push("Latitude"); }
    if (lng && !isNaN(parseFloat(lng))) { formPatch.coordinateLng = String(parseFloat(lng).toFixed(6)); filled.push("Longitude"); }

    // nearbyAmenities — serialise to JSON string if it's an array/object
    if (r.nearbyAmenities && r.nearbyAmenities !== "") {
      formPatch.nearbyAmenities = typeof r.nearbyAmenities === "string"
        ? r.nearbyAmenities
        : JSON.stringify(r.nearbyAmenities);
      filled.push("Nearby Amenities");
    }

    // unitTypes — must stay as structured array, passed separately
    const unitTypes = Array.isArray(r.unitTypes) ? r.unitTypes : [];

    return { formPatch, filled, unitTypes };
  };

  // Fallback: pdf.js text extraction + regex matching (runs client-side, no API needed)
  const runFallbackParse = async () => {
    if (!file) return;
    setStep("fallback-loading"); setProgress(0); setErrMsg(""); setFilledFields([]); setUsedFallback(true);
    try {
      setProgress(0);
      const text = await extractPdfText(file);
      setProgress(1);
      if (!text || text.trim().length < 20) throw new Error("Could not extract readable text from this PDF.");
      setProgress(2);
      const result = parsePdfTextToFields(text);
      setProgress(3);
      const { formPatch, filled, unitTypes } = applyResult(result);
      setFilledFields(filled);
      setStep(filled.length > 0 ? "fallback-done" : "error");
      if (filled.length === 0) { setErrMsg("No property fields could be detected from this PDF."); return; }
      onAutofill(formPatch, unitTypes);
    } catch (e) {
      setErrMsg(e.message || "Basic PDF reader failed. Please fill manually.");
      setStep("error");
    }
  };

  const runParse = async () => {
    if (!file) return;
    setStep("loading"); setProgress(0); setErrMsg(""); setFilledFields([]); setUsedFallback(false);
    try {
      setProgress(0);
      const b64 = await fileToBase64(file);
      setProgress(1);
      const result = await parsePDFWithAI(b64);
      setProgress(2);

      const { formPatch, filled, unitTypes } = applyResult(result);

      setProgress(3);
      setFilledFields(filled);
      setStep("done");

      onAutofill(formPatch, unitTypes);

    } catch (e) {
      // AI failed → automatically try fallback
      console.warn("AI PDF parse failed, trying basic PDF reader fallback:", e.message);
      try {
        setUsedFallback(true);
        setStep("fallback-loading"); setProgress(0);
        setErrMsg("");
        const text = await extractPdfText(file);
        setProgress(1);
        if (!text || text.trim().length < 20) throw new Error("Could not extract readable text.");
        setProgress(2);
        const result = parsePdfTextToFields(text);
        setProgress(3);
        const { formPatch, filled, unitTypes } = applyResult(result);
        setFilledFields(filled);
        if (filled.length === 0) {
          setErrMsg("AI failed and basic reader found no fields. Please fill manually.");
          setStep("error");
          return;
        }
        setStep("fallback-done");
        onAutofill(formPatch, unitTypes);
      } catch (e2) {
        setErrMsg(e.message + " — Basic PDF reader also failed.");
        setStep("error");
      }
    }
  };

  const fmt = b => b < 1024 ? `${b} B` : b < 1048576 ? `${(b/1024).toFixed(1)} KB` : `${(b/1048576).toFixed(1)} MB`;

  return (
    <div className="ai-zone">
      <div className="ai-zone-hd">
        <div className="ai-zone-icon">✨</div>
        <div>
          <div className="ai-zone-title">AI Auto-fill from Brochure PDF</div>
          <div className="ai-zone-sub">Upload a project brochure or factsheet — AI will extract and fill in all available fields automatically</div>
        </div>
      </div>
      <div className="ai-zone-body">
        {!file ? (
          <div className={`ai-drop${dragOver?" over":""}`}
            onDragOver={e=>{e.preventDefault();setDragOver(true);}}
            onDragLeave={()=>setDragOver(false)}
            onDrop={handleDrop}
          >
            <input type="file" accept="application/pdf" onChange={e=>handleFile(e.target.files?.[0])}/>
            <div className="ai-drop-ico">📄</div>
            <div className="ai-drop-txt">
              <strong>Drop PDF here or click to browse</strong>
              <small>Supports project brochures, factsheets, e-brochures · Max 20 MB</small>
            </div>
          </div>
        ) : (
          <div className="ai-file-row">
            <span className="ai-file-ico">📄</span>
            <span className="ai-file-name">{file.name}</span>
            <span className="ai-file-size">{fmt(file.size)}</span>
            <button className="ai-file-rm" onClick={()=>{setFile(null);setStep("idle");setFilledFields([]);setErrMsg("");setUsedFallback(false);}}>✕</button>
          </div>
        )}

        {file && step !== "loading" && step !== "fallback-loading" && (
          <div className="ai-btn-row">
            <button className="ai-parse-btn" onClick={runParse} disabled={step==="loading"||step==="fallback-loading"}>
              <span>✨</span> Extract & Auto-fill with AI
            </button>
            <button className="ai-fallback-btn" onClick={runFallbackParse} disabled={step==="loading"||step==="fallback-loading"}>
              <span>📖</span> Basic PDF Reader
            </button>
          </div>
        )}

        {step==="loading" && (
          <div className="ai-progress">
            <div className="ai-progress-steps">
              {STEPS.map((s,i)=>{
                const state = i < progress ? "done" : i === progress ? "active" : "wait";
                return (
                  <div key={i} className="ai-step">
                    <div className={`ai-step-dot ${state}`}>{state==="done"?"✓":state==="active"?"⟳":i+1}</div>
                    <span className={`ai-step-txt ${state}`}>{s}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {step==="fallback-loading" && (
          <div className="ai-progress">
            <div className="ai-progress-hd">📖 Using Basic PDF Reader (fallback){usedFallback && errMsg ? "" : ""}</div>
            <div className="ai-progress-steps">
              {FALLBACK_STEPS.map((s,i)=>{
                const state = i < progress ? "done" : i === progress ? "active" : "wait";
                return (
                  <div key={i} className="ai-step">
                    <div className={`ai-step-dot ${state}`}>{state==="done"?"✓":state==="active"?"⟳":i+1}</div>
                    <span className={`ai-step-txt ${state}`}>{s}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {step==="done" && filledFields.length > 0 && (
          <div className="ai-result-bar">
            <div className="ai-result-ico">✅</div>
            <div className="ai-result-txt">AI filled <strong>{filledFields.length} field{filledFields.length!==1?"s":""}</strong> — watch them light up in the form below!</div>
            <div className="ai-filled-fields">
              {filledFields.map(f=><span key={f} className="ai-field-tag">✓ {f}</span>)}
            </div>
            <div className="ai-result-count">Review all tabs — scroll down and check each highlighted field.</div>
          </div>
        )}

        {step==="fallback-done" && filledFields.length > 0 && (
          <div className="ai-result-bar fallback">
            <div className="ai-result-txt">📖 Basic PDF Reader filled {filledFields.length} field{filledFields.length!==1?"s":""}{usedFallback ? " (AI was unavailable)" : ""}</div>
            <div className="ai-filled-fields">
              {filledFields.map(f=><span key={f} className="ai-field-tag">{f}</span>)}
            </div>
            <div className="ai-result-count">Basic extraction uses text patterns — please review all values carefully.</div>
          </div>
        )}

        {(step==="error" || errMsg) && (
          <div className="ai-err-bar">⚠ {errMsg || "Something went wrong. Please try again."}</div>
        )}
      </div>
    </div>
  );
}

/* ═══ PROPERTY FORM ═══ */
const FORM_TABS=[["basic","Basic Info"],["development","Development"],["units","Units & Parking"],["financials","Financials & Media"],["visibility","👁 Visibility"]];

// All granular sections per tab
const SECTION_DEFS = {
  overview: [
    { k:"description",    icon:"📝", name:"Description",         desc:"Project narrative overview" },
    { k:"highlights",     icon:"✨", name:"Key Highlights",       desc:"Bullet-point selling points" },
    { k:"basicInfo",      icon:"🏢", name:"Basic Project Info",   desc:"Name, developer, location, tenure, completion" },
    { k:"development",    icon:"🏗", name:"Development Details",  desc:"Blocks, floors, residential start level" },
    { k:"unitInfo",       icon:"🏠", name:"Unit Information",     desc:"Total units, Bumi breakdown, beds, baths, size" },
    { k:"parking",        icon:"🚗", name:"Parking",              desc:"Car park levels, bays, and notes" },
    { k:"facilities",     icon:"🛗", name:"Facilities & Access",  desc:"Lifts per tower and facility list" },
    { k:"financial",      icon:"💰", name:"Financial Info",       desc:"Price range, maintenance fee, sinking fund" },
    { k:"sales",          icon:"🏢", name:"Sales & Marketing",    desc:"Showroom availability and scale model" },
    { k:"facList",        icon:"🏊", name:"Full Facilities List", desc:"Chip grid of all amenities" },
    { k:"priceBar",       icon:"💳", name:"Price CTA Bar",        desc:"Bottom bar with Register Interest button" },
  ],
  location: [
    { k:"map",            icon:"🗺", name:"Interactive Map",      desc:"Embedded Google Maps iframe" },
    { k:"amenities",      icon:"📌", name:"Nearby Amenities",     desc:"Education, healthcare, shopping, transport" },
  ],
  layouts: [
    { k:"unitTypes",      icon:"📐", name:"Unit Types",           desc:"Individual layout cards with image and specs" },
    { k:"upgrades",       icon:"🔧", name:"Upgrade Specifications",desc:"Premium finishes and inclusions" },
  ],
};

function defaultSections() {
  const out = {};
  for (const [tab, secs] of Object.entries(SECTION_DEFS))
    for (const { k } of secs) out[`${tab}.${k}`] = true;
  return out;
}

/* ═══ INTERACTIVE MAP PICKER (Leaflet + OpenStreetMap) ═══ */
function loadCSS(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.appendChild(l);
}
async function ensureLeaflet() {
  loadCSS("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css");
  if (!window.L) await loadScript("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js");
  return window.L;
}

function MapPicker({ lat, lng, onPick }) {
  const [expanded, setExpanded] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const mapRef = React.useRef(null);
  const markerRef = React.useRef(null);
  const containerRef = React.useRef(null);
  const expandedContainerRef = React.useRef(null);
  const initLat = parseFloat(lat) || 5.35;
  const initLng = parseFloat(lng) || 100.35;

  // Initialize mini map
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = await ensureLeaflet();
      if (cancelled || !containerRef.current) return;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
      const map = L.map(containerRef.current, { scrollWheelZoom: false, zoomControl: true, attributionControl: false })
        .setView([initLat, initLng], 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
      const marker = L.marker([initLat, initLng], { draggable: true }).addTo(map);
      marker.on("dragend", () => { const p = marker.getLatLng(); onPick(p.lat.toFixed(6), p.lng.toFixed(6)); });
      map.on("click", (e) => { marker.setLatLng(e.latlng); onPick(e.latlng.lat.toFixed(6), e.latlng.lng.toFixed(6)); });
      mapRef.current = map;
      markerRef.current = marker;
      setMapReady(true);
      setTimeout(() => map.invalidateSize(), 200);
    })();
    return () => { cancelled = true; if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, []);

  // Update marker when lat/lng props change externally
  useEffect(() => {
    if (!markerRef.current || !mapRef.current) return;
    const la = parseFloat(lat), ln = parseFloat(lng);
    if (!isNaN(la) && !isNaN(ln) && la !== 0 && ln !== 0) {
      const cur = markerRef.current.getLatLng();
      if (Math.abs(cur.lat - la) > 0.00001 || Math.abs(cur.lng - ln) > 0.00001) {
        markerRef.current.setLatLng([la, ln]);
        mapRef.current.setView([la, ln], mapRef.current.getZoom());
      }
    }
  }, [lat, lng]);

  // Expanded map modal
  const expandedMapRef = React.useRef(null);
  const expandedMarkerRef = React.useRef(null);

  useEffect(() => {
    if (!expanded) { if (expandedMapRef.current) { expandedMapRef.current.remove(); expandedMapRef.current = null; } return; }
    let cancelled = false;
    (async () => {
      const L = await ensureLeaflet();
      if (cancelled) return;
      // small delay to let DOM render
      await new Promise(r => setTimeout(r, 100));
      if (!expandedContainerRef.current || cancelled) return;
      const cLat = parseFloat(lat) || initLat, cLng = parseFloat(lng) || initLng;
      const map = L.map(expandedContainerRef.current, { zoomControl: true, attributionControl: true })
        .setView([cLat, cLng], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
      const marker = L.marker([cLat, cLng], { draggable: true }).addTo(map);
      marker.bindPopup("Drag me or click the map").openPopup();
      marker.on("dragend", () => {
        const p = marker.getLatLng();
        onPick(p.lat.toFixed(6), p.lng.toFixed(6));
        if (markerRef.current) markerRef.current.setLatLng(p);
        if (mapRef.current) mapRef.current.setView(p, mapRef.current.getZoom());
      });
      map.on("click", (e) => {
        marker.setLatLng(e.latlng);
        onPick(e.latlng.lat.toFixed(6), e.latlng.lng.toFixed(6));
        if (markerRef.current) markerRef.current.setLatLng(e.latlng);
        if (mapRef.current) mapRef.current.setView(e.latlng, mapRef.current.getZoom());
      });
      expandedMapRef.current = map;
      expandedMarkerRef.current = marker;
      setTimeout(() => map.invalidateSize(), 200);
    })();
    return () => { cancelled = true; if (expandedMapRef.current) { expandedMapRef.current.remove(); expandedMapRef.current = null; } };
  }, [expanded]);

  // Sync expanded marker when lat/lng change
  useEffect(() => {
    if (!expandedMarkerRef.current || !expandedMapRef.current) return;
    const la = parseFloat(lat), ln = parseFloat(lng);
    if (!isNaN(la) && !isNaN(ln)) {
      expandedMarkerRef.current.setLatLng([la, ln]);
    }
  }, [lat, lng]);

  const handleConfirmClose = () => {
    setExpanded(false);
  };

  return (
    <>
      <div className="map-picker-mini">
        <div className="map-picker-container" ref={containerRef} />
        <div className="map-picker-actions">
          <button type="button" className="map-picker-expand" onClick={() => setExpanded(true)}>⛶ Enlarge Map</button>
          <span className="map-picker-hint">Click map or drag pin to set location</span>
        </div>
      </div>
      {expanded && (
        <div className="map-picker-overlay" onClick={e => { if (e.target === e.currentTarget) handleConfirmClose(); }}>
          <div className="map-picker-modal">
            <div className="map-picker-modal-hd">
              <span>📍 Select Location on Map</span>
              <button type="button" className="map-picker-modal-x" onClick={handleConfirmClose}>✕</button>
            </div>
            <div className="map-picker-modal-body" ref={expandedContainerRef} />
            <div className="map-picker-modal-ft">
              <span className="map-picker-coords">
                {lat && lng ? `${parseFloat(lat).toFixed(6)}, ${parseFloat(lng).toFixed(6)}` : "Click to pick a point"}
              </span>
              <button type="button" className="map-picker-confirm" onClick={handleConfirmClose}>✓ Confirm Location</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PropertyForm({initial,onSave,onClose,isEdit}){
  useModalEffect(onClose);
  const [form,setForm]=useState(initial||EMPTY_FORM);
  const [tab,setTab]=useState("basic");
  const [unitTypesList,setUnitTypesList]=useState(()=>safeJson(initial?.unitTypes||"[]",[]));
  const [err,setErr]=useState("");
  // Visibility settings (tabs + granular sections)
  const [vis,setVis]=useState({
    visible:   initial?.visible             !== false,
    overview:  initial?.visibleTabs?.overview  !== false,
    location:  initial?.visibleTabs?.location  !== false,
    layouts:   initial?.visibleTabs?.layouts   !== false,
    // sections keyed as "tab.section"
    ...(initial?.visibleSections || defaultSections()),
  });
  const toggleVis=(k)=>setVis(v=>({...v,[k]:!v[k]}));
  const sv=(tabKey,secKey)=>vis[`${tabKey}.${secKey}`]!==false;
  const toggleSec=(tabKey,secKey)=>setVis(v=>({...v,[`${tabKey}.${secKey}`]:!sv(tabKey,secKey)}));
  const allOnInTab=(tabKey)=>SECTION_DEFS[tabKey]?.every(s=>sv(tabKey,s.k));
  const toggleAllInTab=(tabKey)=>{
    const allOn=allOnInTab(tabKey);
    setVis(v=>({...v,...Object.fromEntries(SECTION_DEFS[tabKey].map(s=>[`${tabKey}.${s.k}`,!allOn]))}));
  };
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const validate=()=>{ if(!form.name.trim())return"Project name required."; if(!form.developer.trim())return"Developer required."; if(!form.priceFrom||isNaN(Number(form.priceFrom)))return"Valid starting price required."; if(!form.image.trim())return"Main image URL required."; return""; };
  const handleSave=()=>{
    const e=validate();if(e){setErr(e);return;}setErr("");
    // Pull out sections into visibleSections object
    const sections=defaultSections();
    for(const key of Object.keys(sections)) if(vis[key]===false) sections[key]=false;
    onSave({...form,unitTypes:JSON.stringify(unitTypesList)}, vis, sections);
  };

  // AI autofill handler — stagger field highlights for visual feedback
  const [highlightedFields, setHighlightedFields] = useState({});
  const handleAIAutofill = (formPatch, unitTypes) => {
    setForm(f => ({ ...f, ...formPatch }));
    if (unitTypes && unitTypes.length > 0) setUnitTypesList(unitTypes);
    // Flash each filled field green briefly
    const keys = Object.keys(formPatch);
    const newHighlights = {};
    keys.forEach((k, i) => {
      setTimeout(() => {
        setHighlightedFields(prev => ({ ...prev, [k]: true }));
        setTimeout(() => setHighlightedFields(prev => { const n={...prev}; delete n[k]; return n; }), 1800);
      }, i * 60);
    });
  };
  const hl=(k)=>highlightedFields[k]?"ai-hl":"";
  const ff=(label,k,ph="",type="text",hint)=>{
    const isNum = type==='number';
    const displayVal = isNum
      ? (form[k]!==undefined && form[k]!=='' ? formatNum(String(form[k]).replace(/,/g,'')) : '')
      : (form[k]??"");
    return (
    <div className={`a-ff${highlightedFields[k]?" ai-field-flash":""}`}>
      <label className="a-flbl">{label}{hint&&<small> — {hint}</small>}{highlightedFields[k]&&<span className="ai-autofill-badge">✨ AI</span>}</label>
      <input
        className={`a-inp ${hl(k)}`}
        type="text"
        inputMode={isNum ? "numeric" : undefined}
        value={displayVal}
        placeholder={ph}
        onChange={e=>{
          if(isNum){
            const raw = e.target.value.replace(/[^0-9]/g,'');
            set(k, raw);
          } else {
            set(k, e.target.value);
          }
        }}
      />
    </div>
    );
  };
  const ft=(label,k,ph="",rows=2,hint)=>(<div className={`a-ff${highlightedFields[k]?" ai-field-flash":""}`}><label className="a-flbl">{label}{hint&&<small> — {hint}</small>}{highlightedFields[k]&&<span className="ai-autofill-badge">✨ AI</span>}</label><textarea className={`a-txt ${hl(k)}`} rows={rows} value={form[k]??""} placeholder={ph} onChange={e=>set(k,e.target.value)}/></div>);
  const fs=(label,k,opts)=>(<div className={`a-ff${highlightedFields[k]?" ai-field-flash":""}`}><label className="a-flbl">{label}{highlightedFields[k]&&<span className="ai-autofill-badge">✨ AI</span>}</label><select className={`a-sel ${hl(k)}`} value={form[k]??""} onChange={e=>set(k,e.target.value)}>{opts.map(o=><option key={o}>{o}</option>)}</select></div>);
  return(
    <div className="a-modal-ov" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="a-modal">
        <div className="a-modal-hd">
          <div className="a-modal-title">{isEdit?<><em>Edit</em> Project</>:<>Add <em>New</em> Project</>}</div>
          <button className="a-modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="a-modal-body">
          {!isEdit && <AIPDFWidget onAutofill={handleAIAutofill}/>}
          <div className="a-form-tabs">{FORM_TABS.map(([k,l])=><button key={k} className={`a-form-tab${tab===k?" on":""}`} onClick={()=>setTab(k)}>{l}</button>)}</div>
          {err&&<div className="a-form-err">{err}</div>}

          {tab==="basic"&&<>
            <div className="a-form-sec">Identification</div>
            <div className="a-form-grid c1" style={{marginBottom:"1rem"}}>
              <div className="a-ff s2"><label className="a-flbl">Project Name</label><input className="a-inp" value={form.name} placeholder="e.g. The Pinnacle Residences" onChange={e=>set("name",e.target.value)}/></div>
            </div>
            <div className="a-form-grid" style={{marginBottom:"1rem"}}>
              {ff("Developer","developer","e.g. Mah Sing Group")}
              {ff("Location","location","e.g. Georgetown, Penang")}
              {fs("Property Type","type",PROP_TYPES)}
              {fs("Status","status",STATUSES)}
              {ff("Completion","completion","e.g. Q4 2026")}
              {fs("Tenure","tenure",TENURES)}
              {ff("Land Size","landSize","e.g. 3.2 acres")}
              {ff("Construction Stage","constructionStage","e.g. Piling & Foundation")}
            </div>
            <div className="a-form-sec">Coordinates (for Google Map)</div>
            <div className="a-form-grid" style={{marginBottom:".5rem"}}>
              {ff("Latitude","coordinateLat","e.g. 5.3636","text","decimal degrees")}
              {ff("Longitude","coordinateLng","e.g. 100.4565","text","decimal degrees")}
            </div>
            <MapPicker lat={form.coordinateLat} lng={form.coordinateLng} onPick={(la,ln)=>setForm(f=>({...f,coordinateLat:la,coordinateLng:ln}))} />
            <div className="a-form-sec">Badge</div>
            <div className="a-form-grid">
              <div className="a-ff"><label className="a-flbl">Tag Label</label><input className="a-inp" value={form.tag} placeholder="e.g. HOT" onChange={e=>set("tag",e.target.value.toUpperCase())}/><div className="tag-presets">{TAG_PRESETS.map(t=><button key={t} className="tpre" onClick={()=>set("tag",t)}>{t}</button>)}</div></div>
              <div className="a-ff"><label className="a-flbl">Tag Colour</label><div className="color-row">{TAG_COLORS.map(c=><div key={c} className={`csw${form.tagColor===c?" pk":""}`} style={{background:c}} onClick={()=>set("tagColor",c)}/>) }<input type="color" value={form.tagColor} onChange={e=>set("tagColor",e.target.value)} style={{width:26,height:26,border:"none",padding:0,cursor:"pointer",background:"transparent"}}/></div>{form.tag&&<div style={{marginTop:".5rem"}}><span style={{background:form.tagColor,color:"#fff",fontSize:".62rem",fontWeight:700,letterSpacing:".1em",padding:".2rem .55rem"}}>{form.tag}</span></div>}</div>
            </div>
          </>}

          {tab==="development"&&<>
            <div className="a-form-sec">Structure</div>
            <div className="a-form-grid c3" style={{marginBottom:"1rem"}}>{ff("Total Blocks","totalBlocks","2","number")}{ff("Total Floors","floors","38","number")}{ff("Total Units","totalUnits","320","number")}</div>
            <div className="a-form-grid c1" style={{marginBottom:"1rem"}}>{ft("Floors per Tower","totalFloorsPerTower","Tower A: 38 floors, Tower B: 36 floors",2,"comma-sep")}{ff("Residential Start Level","residentialStartLevel","e.g. Level 5")}</div>
            <div className="a-form-sec">Units Breakdown</div>
            <div className="a-form-grid c1">{ff("Public / Bumi Breakdown","unitsBreakdown","e.g. 280 Public / 40 Bumi")}{ff("Units per Tower","unitsPerTower","e.g. Tower A: 168 | Tower B: 152")}</div>
          </>}

          {tab==="units"&&<>
            <div className="a-form-sec">Unit Specs (Overview)</div>
            <div className="a-form-grid c3" style={{marginBottom:"1rem"}}>{ff("Bedrooms","bedrooms","2, 3, 4","text","comma-sep")}{ff("Bathrooms","bathrooms","2, 3","text","comma-sep")}{ff("Size sqft","sizeSqft","900–2200","text","min–max")}</div>
            <div className="a-form-sec">Unit Types with Layouts</div>
            <UnitTypeEditor unitTypes={unitTypesList} onChange={setUnitTypesList}/>
            <div style={{marginTop:"1.2rem"}}/>
            <div className="a-form-sec">Parking & Lifts</div>
            <div className="a-form-grid" style={{marginBottom:"1rem"}}>{ff("Car Park Levels","carParkLevels","e.g. Level 1–4")}{ff("Number of Car Parks","numberOfCarParks","e.g. 480 bays")}{ff("Number of Lifts","numberOfLifts","e.g. 4 per tower")}</div>
            {ft("Parking Notes","parkingNotes","EV charging, ANPR...",2)}
            <div style={{marginTop:"1rem"}}/>
            {ft("Upgrade Specifications","upgrades","Bosch appliances, Italian tiles...",2)}
          </>}

          {tab==="financials"&&<>
            <div className="a-form-sec">Pricing</div>
            <div className="a-form-grid c3" style={{marginBottom:"1rem"}}>{ff("Starting Price (RM)","priceFrom","480000","number")}{ff("Max Price (RM)","priceTo","1200000","number")}</div>
            <div className="a-form-grid" style={{marginBottom:"1rem"}}>{ff("Maintenance Fee","maintenanceFee","e.g. RM 0.35 / sf / month")}{ff("Sinking Fund","sinkingFund","e.g. RM 0.10 / sf / month")}{ff("Showroom","showroom","Location & hours")}{ff("Scale Model","scaleModel","Yes / No")}</div>
            <div className="a-form-sec">Media</div>
            <div className="a-form-grid c1">
              <div className="a-ff"><label className="a-flbl">Main Image URL</label><input className="a-inp" value={form.image} placeholder="https://..." onChange={e=>set("image",e.target.value)}/>{form.image&&<img className="img-prev" src={form.image} alt="" onError={e=>e.target.style.display="none"} onLoad={e=>e.target.style.display="block"}/>}</div>
              {ft("Gallery Images","gallery","https://img1.jpg, https://img2.jpg",2,"comma-sep URLs")}
              <div className="a-ff"><label className="a-flbl">Description</label><textarea className="a-txt" rows={3} value={form.description} onChange={e=>set("description",e.target.value)}/></div>
              {ft("Highlights","highlights","Smart Home, Sky Pool...",2,"comma-sep")}
              {ft("Facilities","facilities","Pool, Gym, Sky Lounge...",2,"comma-sep")}
            </div>
          </>}

          {tab==="visibility"&&<>
            {/* ── Master publish switch ── */}
            <div className="a-form-sec">Publication</div>
            <div className="vis-master-card">
              <div className="vis-master-info">
                <div className={`vis-master-title${vis.visible?"":" off"}`}>{vis.visible?"This project is visible to users":"This project is hidden from users"}</div>
                <div className="vis-master-sub">{vis.visible?"Appears on the public listing page and can be opened by anyone.":"Saved but hidden — not shown on the public website."}</div>
              </div>
              <Toggle checked={vis.visible} onChange={()=>toggleVis("visible")} label={vis.visible?"Published":"Hidden"}/>
            </div>
            {!vis.visible&&<div className="vis-hidden-warn">⚠ Users will not see this project until you enable it.</div>}

            {/* ── Tab + Section visibility ── */}
            <div className="a-form-sec" style={{marginTop:"1.5rem"}}>Detail Tabs & Section Visibility</div>
            <p style={{fontSize:".78rem",color:"var(--a-muted)",marginBottom:"1.2rem",lineHeight:1.6}}>
              Toggle each tab on/off, then control which individual sections appear within it.
              Hidden sections are completely removed from the user's view.
            </p>

            {[
              {tabKey:"overview", icon:"📊", label:"Project Info"},
              {tabKey:"location", icon:"📍", label:"Location & Amenities"},
              {tabKey:"layouts",  icon:"📐", label:"Unit Layouts"},
            ].map(({tabKey,icon,label})=>{
              const tabOn = vis[tabKey]!==false;
              const secs  = SECTION_DEFS[tabKey]||[];
              const visCount = secs.filter(s=>sv(tabKey,s.k)).length;
              return(
                <div key={tabKey} className="vis-group">
                  {/* Tab header row */}
                  <div className="vis-group-hd">
                    <span className="vis-group-hd-ico">{icon}</span>
                    <span style={{flex:1}}>{label}</span>
                    <span style={{fontSize:".65rem",color:tabOn?"var(--a-muted)":"var(--a-red)",marginRight:".75rem"}}>
                      {tabOn?`${visCount}/${secs.length} sections visible`:"Tab hidden"}
                    </span>
                    <Toggle checked={tabOn} onChange={()=>toggleVis(tabKey)} label={tabOn?"Tab On":"Tab Off"}/>
                  </div>
                  {/* Section rows */}
                  <div className="vis-group-body">
                    {/* Select all toggle */}
                    <div className="vis-sec-row" style={{background:"rgba(13,13,24,.04)"}}>
                      <div className="vis-sec-ico">☰</div>
                      <div className="vis-sec-info">
                        <div className="vis-sec-name" style={{fontStyle:"italic",color:"var(--a-muted)"}}>All sections in this tab</div>
                      </div>
                      {!tabOn&&<span className="vis-tab-disabled-note">enable tab first</span>}
                      <Toggle
                        checked={allOnInTab(tabKey)}
                        onChange={()=>toggleAllInTab(tabKey)}
                        label={allOnInTab(tabKey)?"All On":"Some Off"}
                      />
                    </div>
                    {secs.map(({k,icon:ico,name,desc})=>{
                      const on=sv(tabKey,k);
                      return(
                        <div key={k} className={`vis-sec-row${!on?" hidden":""}${!tabOn?" disabled":""}`}>
                          <div className="vis-sec-ico">{ico}</div>
                          <div className="vis-sec-info">
                            <div className="vis-sec-name">{name}</div>
                            <div className="vis-sec-desc">{desc}</div>
                          </div>
                          <Toggle checked={on} onChange={()=>toggleSec(tabKey,k)} label={on?"Show":"Hide"}/>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* ── Live summary preview ── */}
            <div className="vis-preview">
              <div className="vis-preview-lbl">What users will see:</div>
              {(vis.overview||vis.location||vis.layouts)?(
                <div className="vis-preview-tabs">
                  {vis.overview&&<span className="vis-prev-tab">📊 Project Info ({SECTION_DEFS.overview.filter(s=>sv("overview",s.k)).length}/{SECTION_DEFS.overview.length})</span>}
                  {vis.location&&<span className="vis-prev-tab">📍 Location ({SECTION_DEFS.location.filter(s=>sv("location",s.k)).length}/{SECTION_DEFS.location.length})</span>}
                  {vis.layouts &&<span className="vis-prev-tab">📐 Layouts ({SECTION_DEFS.layouts.filter(s=>sv("layouts",s.k)).length}/{SECTION_DEFS.layouts.length})</span>}
                </div>
              ):<div className="vis-no-tabs">⚠ No tabs enabled — detail view will be empty.</div>}
            </div>
          </>}
        </div>
        <div className="a-modal-ft"><button className="a-cancel" onClick={onClose}>Cancel</button><button className="a-save" onClick={handleSave}>{isEdit?"Save Changes":"Add Project"}</button></div>
      </div>
    </div>
  );
}

/* ═══ ANALYTICS DASHBOARD ═══ */
function AnalyticsDashboard() {
  const [range, setRange] = useState("7d");
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const fsData = await getAllAnalytics();
        if (Array.isArray(fsData) && fsData.length > 0) {
          setEvents(fsData);
        } else {
          // Fallback: read from localStorage
          const raw = localStorage.getItem(ANALYTICS_KEY);
          setEvents(raw ? JSON.parse(raw) : []);
        }
      } catch {
        try { const raw = localStorage.getItem(ANALYTICS_KEY); setEvents(raw ? JSON.parse(raw) : []); }
        catch { setEvents([]); }
      }
      setLoading(false);
    })();
  }, []);
  // Normalize: Firestore timestamps may be objects {seconds, nanoseconds}
  const normalized = events.map(e => ({
    ...e,
    t: typeof e.t === "number" ? e.t : (e.t?.seconds ? e.t.seconds * 1000 : (e.t?.toMillis ? e.t.toMillis() : Date.now()))
  }));
  const now = Date.now();
  const cutoff = range==="today" ? new Date(new Date().setHours(0,0,0,0)).getTime()
               : range==="7d"   ? now - 7*86400000
               : range==="30d"  ? now - 30*86400000 : 0;
  const filtered = normalized.filter(e => e.t >= cutoff);
  const views     = filtered.filter(e => e.type==="page_view").length;
  const clicks    = filtered.filter(e => e.type==="project_click").length;
  const inquiries = filtered.filter(e => ["inquiry_email","inquiry_wa","showroom_book"].includes(e.type)).length;
  const conversion = views > 0 ? ((inquiries/views)*100).toFixed(1) : "0.0";
  // Per-project breakdown
  const projMap = {};
  filtered.forEach(e => {
    if (!e.projectName) return;
    if (!projMap[e.projectName]) projMap[e.projectName] = { clicks:0, inquiries:0 };
    if (e.type==="project_click") projMap[e.projectName].clicks++;
    if (["inquiry_email","inquiry_wa","showroom_book"].includes(e.type)) projMap[e.projectName].inquiries++;
  });
  const projRows = Object.entries(projMap).sort((a,b)=>(b[1].clicks+b[1].inquiries)-(a[1].clicks+a[1].inquiries));
  // Daily chart
  const chartDays = range==="30d"||range==="all" ? 30 : range==="today" ? 1 : 7;
  const days = Array.from({length:chartDays},(_,i) => {
    const d = new Date(); d.setDate(d.getDate()-(chartDays-1-i)); d.setHours(0,0,0,0); return d.getTime();
  });
  const dailyData = days.map(s => {
    const evs = normalized.filter(e=>e.t>=s&&e.t<s+86400000);
    return {
      label: new Date(s).toLocaleDateString("en-GB",{day:"numeric",month:"short"}),
      v: evs.filter(e=>e.type==="page_view").length,
      c: evs.filter(e=>e.type==="project_click").length,
      i: evs.filter(e=>["inquiry_email","inquiry_wa","showroom_book"].includes(e.type)).length,
    };
  });
  const maxBar = Math.max(1,...dailyData.map(d=>Math.max(d.v,d.c,d.i)));
  const clearData = async () => {
    if (!window.confirm("Clear all analytics data? This cannot be undone.")) return;
    try {
      await deleteAllAnalytics();
    } catch (e) { console.error('Failed to clear analytics in Firestore', e); }
    try { localStorage.removeItem(ANALYTICS_KEY); } catch(_){}
    setEvents([]);
  };
  if (loading) return <div style={{padding:"3rem",textAlign:"center",color:"var(--a-muted)"}}>Loading analytics…</div>;
  return (
    <div>
      <div className="an-hd">
        <div>
          <div className="a-pg-title">Analytics <em>Dashboard</em></div>
          <div className="a-pg-sub">Track views, clicks, and inquiries from visitors.</div>
        </div>
        <div className="an-hd-controls">
          {["today","7d","30d","all"].map(r=>(
            <button key={r} className={`an-range-btn${range===r?" on":""}`} onClick={()=>setRange(r)}>
              {r==="today"?"Today":r==="7d"?"7 Days":r==="30d"?"30 Days":"All Time"}
            </button>
          ))}
          <button className="an-clear-btn" onClick={clearData}>Clear Data</button>
        </div>
      </div>
      {/* Summary cards */}
      <div className="an-stats">
        <div className="an-stat an-views"><div className="an-stat-ico">👁️</div><div className="an-stat-body"><div className="an-stat-val">{views.toLocaleString()}</div><div className="an-stat-lbl">Page Views</div></div></div>
        <div className="an-stat an-clicks"><div className="an-stat-ico">🖱️</div><div className="an-stat-body"><div className="an-stat-val">{clicks.toLocaleString()}</div><div className="an-stat-lbl">Project Clicks</div></div></div>
        <div className="an-stat an-inq"><div className="an-stat-ico">📩</div><div className="an-stat-body"><div className="an-stat-val">{inquiries.toLocaleString()}</div><div className="an-stat-lbl">Inquiries</div></div></div>
        <div className="an-stat an-conv"><div className="an-stat-ico">📊</div><div className="an-stat-body"><div className="an-stat-val">{conversion}%</div><div className="an-stat-lbl">Conversion Rate</div></div></div>
      </div>
      {/* Daily activity chart */}
      {chartDays > 1 && (
        <div className="an-chart-card">
          <div className="an-card-title">Daily Activity{range==="all"?" · Last 30 Days":""}</div>
          <div className="an-chart">
            {dailyData.map((d,i)=>(
              <div key={i} className="an-chart-col">
                <div className="an-bars">
                  <div className="an-bar an-bar-views" style={{height:`${(d.v/maxBar)*100}%`}} title={`Views: ${d.v}`}/>
                  <div className="an-bar an-bar-clicks" style={{height:`${(d.c/maxBar)*100}%`}} title={`Clicks: ${d.c}`}/>
                  <div className="an-bar an-bar-inq" style={{height:`${(d.i/maxBar)*100}%`}} title={`Inquiries: ${d.i}`}/>
                </div>
                <div className="an-chart-lbl">{d.label}</div>
              </div>
            ))}
          </div>
          <div className="an-legend">
            <span className="an-leg-item"><span className="an-leg-dot" style={{background:"#D4B880"}}/> Views</span>
            <span className="an-leg-item"><span className="an-leg-dot" style={{background:"#BF9B4E"}}/> Clicks</span>
            <span className="an-leg-item"><span className="an-leg-dot" style={{background:"#5E8FD0"}}/> Inquiries</span>
          </div>
        </div>
      )}
      {/* Bottom row: inquiry breakdown + top projects */}
      <div className="an-row">
        <div className="an-chart-card an-inq-card">
          <div className="an-card-title">Inquiry Breakdown</div>
          {(() => {
            const em=filtered.filter(e=>e.type==="inquiry_email").length;
            const wa=filtered.filter(e=>e.type==="inquiry_wa").length;
            const sr=filtered.filter(e=>e.type==="showroom_book").length;
            const tot=em+wa+sr||1;
            return (
              <div className="an-inq-bars">
                {[["✉️ Email Enquiry",em,"#D4B880"],["💬 WhatsApp",wa,"#5E8FD0"],["🏢 Showroom",sr,"#BF9B4E"]].map(([lbl,cnt,clr])=>(
                  <div key={lbl}>
                    <div className="an-inq-row-hd"><span>{lbl}</span><span className="an-inq-cnt">{cnt}</span></div>
                    <div className="an-inq-track"><div className="an-inq-fill" style={{width:`${(cnt/tot)*100}%`,background:clr}}/></div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
        <div className="an-chart-card an-proj-card">
          <div className="an-card-title">Top Projects by Engagement</div>
          {projRows.length===0
            ? <div className="an-empty" style={{border:"none",padding:"1.5rem 0",marginTop:0}}><div style={{color:"var(--a-muted)",fontSize:".8rem",textAlign:"center"}}>No project activity recorded yet.</div></div>
            : <div className="an-proj-tbl-wrap"><table className="an-proj-tbl">
                <thead><tr>
                  <th>Project</th>
                  <th className="num">Clicks</th>
                  <th className="num">Inquiries</th>
                  <th className="num">Conv %</th>
                </tr></thead>
                <tbody>
                  {projRows.slice(0,8).map(([name,d])=>(
                    <tr key={name}>
                      <td>{name}</td>
                      <td className="gold">{d.clicks}</td>
                      <td className="pale">{d.inquiries}</td>
                      <td className="muted">{d.clicks>0?((d.inquiries/d.clicks)*100).toFixed(0):0}%</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
          }
        </div>
      </div>
      {events.length===0&&(
        <div className="an-empty">
          <div className="an-empty-ico">📊</div>
          <div className="an-empty-h">No data recorded yet</div>
          <div className="an-empty-s">Analytics will populate as visitors browse and interact with listings.</div>
        </div>
      )}
    </div>
  );
}

/* ═══ CRM / LEAD MANAGEMENT ═══ */
const crmScore=(lead)=>{let s=0;if(lead.email)s+=15;if(lead.phone)s+=20;if(lead.budget&&Number(lead.budget)>0)s+=20;if(lead.propertyInterest)s+=10;if(lead.assignedAgent)s+=15;if(lead.nextFollowUpDate)s+=10;if(lead.notes&&lead.notes.length>20)s+=10;const age=lead.createdAt&&lead.createdAt.toMillis?(Date.now()-lead.createdAt.toMillis())/86400000:0;if(age<3)s+=5;else if(age>14)s=Math.max(0,s-15);return Math.min(100,s);};
const crmFmtDate=(ts)=>{if(!ts)return"—";const d=ts.toDate?ts.toDate():new Date(ts);const diff=(Date.now()-d)/1000;if(diff<60)return"just now";if(diff<3600)return`${Math.floor(diff/60)}m ago`;if(diff<86400)return`${Math.floor(diff/3600)}h ago`;if(diff<604800)return`${Math.floor(diff/86400)}d ago`;return d.toLocaleDateString("en-MY",{day:"numeric",month:"short",year:"2-digit"})+" · "+d.toLocaleTimeString("en-MY",{hour:"2-digit",minute:"2-digit",hour12:true});};
const crmWaLink=(countryCode,phone,name,project)=>{const full=`${countryCode||'+60'}${phone||""}`;const p=full.replace(/[^0-9]/g,"");const msg=encodeURIComponent(`Hi, I'm following up on your enquiry${project?` about ${project}`:""}. Are you still interested?`);return{href:`https://wa.me/${p}?text=${msg}`,label:`${countryCode||'+60'} ${phone||""}`};};;
const crmExportCSV=(leads)=>{const esc=v=>`"${String(v||"").replace(/"/g,'""')}"`;const headers=["Name","Phone","Email","Source","Status","Budget","Interest","Agent","Follow-up","Created","Notes"];const rows=leads.map(l=>[l.name,l.phone,l.email,l.source,l.status,l.budget,l.propertyInterest,l.assignedAgent,l.nextFollowUpDate,l.createdAt&&l.createdAt.toDate?l.createdAt.toDate().toISOString().split("T")[0]:"",l.notes].map(esc).join(","));const csv=[headers.join(","),...rows].join("\n");const blob=new Blob([csv],{type:"text/csv"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`leads_${new Date().toISOString().split("T")[0]}.csv`;a.click();URL.revokeObjectURL(url);};
const LeadBadge=({status})=>(<span className="crm-badge" style={{color:CRM_STATUS_COLORS[status]||"var(--a-muted)",background:CRM_STATUS_BG[status]||"transparent",border:`1px solid ${(CRM_STATUS_COLORS[status]||"#333")}44`}}>{CRM_STATUS_LABELS[status]||status}</span>);
const CRMScoreBar=({score})=>{const color=score>=75?"#4E9A72":score>=50?"#BF9B4E":score>=25?"#5E8FD0":"#C4543E";return(<span className="crm-score" style={{color}}>{score}<span className="crm-score-bar"><span className="crm-score-fill" style={{width:`${score}%`,background:color}}/></span></span>);};
function LeadForm({lead,projects,onSave,onClose}){
  const blank={name:"",countryCode:"+60",phone:"",email:"",budget:"",propertyInterest:"",source:"website",status:"new",assignedAgent:"",nextFollowUpDate:"",notes:""};
  const [f,setF]=useState({...blank,...(lead&&lead!=="new"?normalizeCrmLead(lead):{})});
  const upd=(k,v)=>setF(p=>({...p,[k]:v}));
  const [busy,setBusy]=useState(false);
  const handleSave=async()=>{if(!f.name.trim()){alert("Name is required.");return;}setBusy(true);await onSave({...f,budget:f.budget?Number(f.budget):0});setBusy(false);};
  useEffect(()=>{const h=e=>{if(e.key==="Escape")onClose();};document.addEventListener("keydown",h);return()=>document.removeEventListener("keydown",h);},[onClose]);
  return(
    <div className="crm-modal-ov" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="crm-modal">
        <div className="crm-modal-hd">
          <div className="crm-modal-title">{lead&&lead!=="new"?"Edit":"New"} <em>Lead</em></div>
          <button className="crm-modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="crm-modal-body">
          <div className="crm-grid2">
            <div className="crm-field"><label className="crm-label">Full Name *</label><input className="crm-inp" value={f.name} onChange={e=>upd("name",e.target.value)} placeholder="Ahmad bin Ali"/></div>
            <div className="crm-field"><label className="crm-label">Phone</label>
              <div style={{display:"flex",gap:".4rem"}}>
                <input className="crm-inp" value={f.countryCode} onChange={e=>upd("countryCode",e.target.value)} placeholder="+60" style={{flex:"0 0 70px",textAlign:"center"}}/>
                <input className="crm-inp" value={f.phone} onChange={e=>upd("phone",e.target.value)} placeholder="12-345 6789" type="tel" style={{flex:1}}/>
              </div>
            </div>
          </div>
          <div className="crm-grid2">
            <div className="crm-field"><label className="crm-label">Email</label><input className="crm-inp" value={f.email} onChange={e=>upd("email",e.target.value)} placeholder="email@example.com" type="email"/></div>
            <div className="crm-field"><label className="crm-label">Budget (RM)</label><input className="crm-inp" value={f.budget} onChange={e=>upd("budget",e.target.value)} placeholder="650000" type="number" min="0"/></div>
          </div>
          <div className="crm-grid2">
            <div className="crm-field"><label className="crm-label">Source</label><select className="crm-inp" value={f.source} onChange={e=>upd("source",e.target.value)}>{CRM_SOURCES.map(s=><option key={s} value={s}>{CRM_SOURCE_LABELS[s]}</option>)}</select></div>
            <div className="crm-field"><label className="crm-label">Status</label><select className="crm-inp" value={f.status} onChange={e=>upd("status",e.target.value)}>{CRM_STATUSES.map(s=><option key={s} value={s}>{CRM_STATUS_LABELS[s]}</option>)}</select></div>
          </div>
          <div className="crm-grid2">
            <div className="crm-field"><label className="crm-label">Property Interest</label><select className="crm-inp" value={f.propertyInterest} onChange={e=>upd("propertyInterest",e.target.value)}><option value="">— Any —</option>{(projects||[]).map(p=><option key={p.id} value={p.name}>{p.name}</option>)}</select></div>
            <div className="crm-field"><label className="crm-label">Assigned Agent</label><input className="crm-inp" value={f.assignedAgent} onChange={e=>upd("assignedAgent",e.target.value)} placeholder="Agent name"/></div>
          </div>
          <div className="crm-field"><label className="crm-label">Next Follow-up Date</label><input className="crm-inp" value={f.nextFollowUpDate} onChange={e=>upd("nextFollowUpDate",e.target.value)} type="date"/></div>
          <div className="crm-field"><label className="crm-label">Notes</label><textarea className="crm-textarea" value={f.notes} onChange={e=>upd("notes",e.target.value)} placeholder="Quick notes about this lead…"/></div>
        </div>
        <div className="crm-modal-ft">
          <button className="crm-btn-sec" onClick={onClose}>Cancel</button>
          <button className="crm-btn-pri" onClick={handleSave} disabled={busy}>{busy?"Saving…":"Save Lead"}</button>
        </div>
      </div>
    </div>
  );
}
function LeadDrawer({lead,activities,projects,onClose,onUpdate,onAddActivity,onEdit,onDelete}){
  const [note,setNote]=useState("");
  const [noteType,setNoteType]=useState("note");
  const [busy,setBusy]=useState(false);
  const score=crmScore(lead);
  const wa=lead.phone?crmWaLink(lead.countryCode,lead.phone,lead.name,lead.propertyInterest):null;
  const isOverdue=lead.nextFollowUpDate&&new Date(lead.nextFollowUpDate)<new Date();
  const addNote=async()=>{if(!note.trim())return;setBusy(true);await onAddActivity({type:noteType,content:note.trim(),createdBy:"admin"});setNote("");setBusy(false);};
  const typeIcons={note:"📝",call:"📞",email:"✉️",status_change:"🔄",assignment:"👤"};
  return(
    <>
      <div className="crm-drawer-ov" onClick={onClose}/>
      <div className="crm-drawer">
        <div className="crm-drawer-hd">
          <div style={{flex:1}}>
            <div className="crm-drawer-name">{lead.name}</div>
            <div style={{marginTop:".35rem",display:"flex",gap:".4rem",flexWrap:"wrap",alignItems:"center"}}><LeadBadge status={lead.status}/><span style={{fontSize:".72rem",color:"var(--a-muted)"}}>{CRM_SOURCE_LABELS[lead.source]||lead.source}</span><CRMScoreBar score={score}/></div>
          </div>
          <div style={{display:"flex",gap:".4rem"}}>
            <button className="crm-ico" onClick={onEdit} title="Edit">✏️</button>
            <button className="crm-ico del" onClick={()=>{if(window.confirm(`Delete lead "${lead.name}"?`)){onDelete(lead.id);}}} title="Delete">🗑</button>
            <button className="crm-ico" onClick={onClose} title="Close">✕</button>
          </div>
        </div>
        <div className="crm-drawer-body">
          <div className="crm-drawer-sec">
            <div className="crm-drawer-sec-hd">Contact Info</div>
            <div className="crm-drawer-sec-body" style={{padding:0}}>
              <div className="crm-detail-row" style={{padding:".5rem 1rem"}}><span className="crm-detail-key">Phone</span><span className="crm-detail-val">{wa?<a href={wa.href} className="crm-wa-link" onClick={e=>e.stopPropagation()} target="_blank" rel="noopener noreferrer">💬 {wa.label}</a>:"—"}</span></div>
              <div className="crm-detail-row" style={{padding:".5rem 1rem"}}><span className="crm-detail-key">Email</span><span className="crm-detail-val">{lead.email||"—"}</span></div>
              <div className="crm-detail-row" style={{padding:".5rem 1rem"}}><span className="crm-detail-key">Budget</span><span className="crm-detail-val">{lead.budget?`RM ${Number(lead.budget).toLocaleString()}`:"—"}</span></div>
              <div className="crm-detail-row" style={{padding:".5rem 1rem"}}><span className="crm-detail-key">Interest</span><span className="crm-detail-val">{lead.propertyInterest||"Any"}</span></div>
              <div className="crm-detail-row" style={{padding:".5rem 1rem"}}><span className="crm-detail-key">Agent</span><span className="crm-detail-val">{lead.assignedAgent||"Unassigned"}</span></div>
              <div className="crm-detail-row" style={{padding:".5rem 1rem",borderBottom:"none"}}><span className="crm-detail-key">Follow-up</span><span className="crm-detail-val" style={{color:isOverdue?"#C4543E":"inherit"}}>{lead.nextFollowUpDate||"—"}{isOverdue?" ⚠":""}</span></div>
            </div>
          </div>
          <div className="crm-drawer-sec">
            <div className="crm-drawer-sec-hd">Move Stage</div>
            <div className="crm-drawer-sec-body" style={{display:"flex",gap:".4rem",flexWrap:"wrap"}}>
              {CRM_STATUSES.map(s=><button key={s} onClick={()=>onUpdate({status:s})} style={{background:lead.status===s?CRM_STATUS_BG[s]:"transparent",border:`1px solid ${lead.status===s?CRM_STATUS_COLORS[s]:"var(--a-border)"}`,color:lead.status===s?CRM_STATUS_COLORS[s]:"var(--a-muted)",padding:".35rem .75rem",borderRadius:999,font:"600 .7rem var(--sans)",cursor:"pointer",letterSpacing:".06em",textTransform:"uppercase",transition:"all .18s"}}>{CRM_STATUS_LABELS[s]}</button>)}
            </div>
          </div>
          {lead.notes&&<div className="crm-drawer-sec"><div className="crm-drawer-sec-hd">Notes</div><div className="crm-drawer-sec-body" style={{fontSize:".82rem",color:"var(--a-text)",lineHeight:1.6,whiteSpace:"pre-wrap"}}>{lead.notes}</div></div>}
          <div className="crm-drawer-sec">
            <div className="crm-drawer-sec-hd">Activity ({(activities||[]).length})</div>
            <div className="crm-drawer-sec-body">
              <div className="crm-activity-list">
                {(activities||[]).length===0&&<div style={{color:"var(--a-muted)",fontSize:".78rem",textAlign:"center",padding:"1rem 0"}}>No activity yet.</div>}
                {(activities||[]).map(a=><div key={a.id} className="crm-activity-item"><div className="crm-activity-dot">{typeIcons[a.type]||"📌"}</div><div className="crm-activity-content"><div className="crm-activity-text">{a.content}</div><div className="crm-activity-time">{crmFmtDate(a.timestamp)} · {a.createdBy||"admin"}</div></div></div>)}
              </div>
              <div className="crm-note-form" style={{marginTop:".85rem"}}>
                <select value={noteType} onChange={e=>setNoteType(e.target.value)} style={{background:"var(--a-surface)",border:"1px solid var(--a-border)",color:"var(--a-muted)",borderRadius:4,padding:".5rem",font:"600 .76rem var(--sans)",cursor:"pointer",flexShrink:0}}>
                  <option value="note">📝 Note</option>
                  <option value="call">📞 Call</option>
                  <option value="email">✉️ Email</option>
                </select>
                <input className="crm-note-inp" value={note} onChange={e=>setNote(e.target.value)} placeholder="Log a note, call, or email…" onKeyDown={e=>e.key==="Enter"&&addNote()}/>
                <button className="crm-note-add" onClick={addNote} disabled={busy||!note.trim()}>Add</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
function LeadTable({leads,projects,onSelect,onAdd,onEdit,onDelete}){
  const [srch,setSrch]=useState("");
  const [statF,setStatF]=useState("all");
  const [srcF,setSrcF]=useState("all");
  const [sort,setSort]=useState({k:"createdAt",asc:false});
  const sortBy=k=>setSort(s=>({k,asc:s.k===k?!s.asc:false}));
  const filtered=useMemo(()=>{
    let rows=[...leads];
    if(statF!=="all")rows=rows.filter(l=>l.status===statF);
    if(srcF!=="all")rows=rows.filter(l=>l.source===srcF);
    if(srch){const q=srch.toLowerCase();rows=rows.filter(l=>(l.name||"").toLowerCase().includes(q)||(l.phone||"").includes(q)||(l.email||"").toLowerCase().includes(q)||(l.propertyInterest||"").toLowerCase().includes(q));}
    rows.sort((a,b)=>{let av=a[sort.k],bv=b[sort.k];if(sort.k==="createdAt"){av=av&&av.toMillis?av.toMillis():0;bv=bv&&bv.toMillis?bv.toMillis():0;}else if(sort.k==="score"){av=crmScore(a);bv=crmScore(b);}else{av=(av||"").toString().toLowerCase();bv=(bv||"").toString().toLowerCase();}return sort.asc?(av>bv?1:-1):(av<bv?1:-1);});
    return rows;
  },[leads,srch,statF,srcF,sort]);
  const SortIco=({k})=><span style={{opacity:sort.k===k?1:.3,fontSize:".6rem",marginLeft:".2rem"}}>{sort.k===k?(sort.asc?"▲":"▼"):"⇅"}</span>;
  return(
    <div>
      <div className="crm-toolbar">
        <input className="crm-search" placeholder="Search name, phone, email…" value={srch} onChange={e=>setSrch(e.target.value)}/>
        <select className="crm-select" value={statF} onChange={e=>setStatF(e.target.value)}><option value="all">All Status</option>{CRM_STATUSES.map(s=><option key={s} value={s}>{CRM_STATUS_LABELS[s]}</option>)}</select>
        <select className="crm-select" value={srcF} onChange={e=>setSrcF(e.target.value)}><option value="all">All Sources</option>{CRM_SOURCES.map(s=><option key={s} value={s}>{CRM_SOURCE_LABELS[s]}</option>)}</select>
        <button className="crm-btn-pri" onClick={onAdd}>＋ Add Lead</button>
        <button className="crm-btn-sec" onClick={()=>crmExportCSV(filtered)} title="Export leads to CSV">⬇ CSV</button>
      </div>
      <div className="crm-tbl-wrap">
        <table className="crm-tbl">
          <thead><tr>
            <th onClick={()=>sortBy("name")}>Name<SortIco k="name"/></th>
            <th>Phone / WA</th>
            <th onClick={()=>sortBy("status")}>Status<SortIco k="status"/></th>
            <th onClick={()=>sortBy("source")}>Source<SortIco k="source"/></th>
            <th onClick={()=>sortBy("budget")}>Budget<SortIco k="budget"/></th>
            <th>Interest</th>
            <th onClick={()=>sortBy("score")}>Score<SortIco k="score"/></th>
            <th onClick={()=>sortBy("nextFollowUpDate")}>Follow-up<SortIco k="nextFollowUpDate"/></th>
            <th/>
          </tr></thead>
          <tbody>
            {filtered.length===0&&<tr><td colSpan={9} style={{textAlign:"center",padding:"2.5rem",color:"var(--a-muted)"}}>No leads found.</td></tr>}
            {filtered.map(l=>{const wa=l.phone?crmWaLink(l.countryCode,l.phone,l.name,l.propertyInterest):null;const overdue=l.nextFollowUpDate&&new Date(l.nextFollowUpDate)<new Date();return(
              <tr key={l.id} onClick={()=>onSelect(l)}>
                <td><div style={{fontWeight:700,color:"#fff"}}>{l.name}</div><div style={{fontSize:".7rem",color:"var(--a-muted)"}}>{l.email}</div></td>
                <td>{wa?<a href={wa.href} className="crm-wa-link" onClick={e=>e.stopPropagation()} target="_blank" rel="noopener noreferrer">💬 {l.countryCode} {l.phone}</a>:"—"}</td>
                <td><LeadBadge status={l.status}/></td>
                <td style={{color:"var(--a-muted)",fontSize:".76rem"}}>{CRM_SOURCE_LABELS[l.source]||l.source||"—"}</td>
                <td style={{color:"var(--a-text)"}}>{l.budget?`RM ${Number(l.budget).toLocaleString()}`:"—"}</td>
                <td style={{color:"var(--a-muted)",fontSize:".76rem"}}>{l.propertyInterest||"Any"}</td>
                <td><CRMScoreBar score={crmScore(l)}/></td>
                <td style={{color:overdue?"#C4543E":"var(--a-muted)",fontSize:".76rem"}}>{l.nextFollowUpDate||"—"}{overdue?" ⚠":""}</td>
                <td><div className="crm-row-act" onClick={e=>e.stopPropagation()}>
                  <button className="crm-ico" onClick={e=>{e.stopPropagation();onEdit(l);}} title="Edit">✏️</button>
                  <button className="crm-ico del" onClick={e=>{e.stopPropagation();if(window.confirm(`Delete "${l.name}"?`))onDelete(l.id);}} title="Delete">🗑</button>
                </div></td>
              </tr>
            );})}
          </tbody>
        </table>
      </div>
      <div style={{color:"var(--a-muted)",fontSize:".74rem",textAlign:"right",marginTop:".4rem"}}>{filtered.length} lead{filtered.length!==1?"s":""} · Showing {leads.length} total</div>
    </div>
  );
}
function KanbanBoard({leads,onSelect,onStatusChange}){
  const [dragId,setDragId]=useState(null);
  const [overCol,setOverCol]=useState(null);
  const cols=CRM_STATUSES.map(s=>({status:s,leads:leads.filter(l=>l.status===s)}));
  return(
    <div className="crm-kanban">
      {cols.map(col=>(
        <div key={col.status} className="crm-col"
          onDragOver={e=>{e.preventDefault();setOverCol(col.status);}}
          onDragLeave={()=>setOverCol(null)}
          onDrop={e=>{e.preventDefault();if(dragId){const l=leads.find(x=>x.id===dragId);if(l&&l.status!==col.status)onStatusChange(dragId,col.status);}setDragId(null);setOverCol(null);}}>
          <div className="crm-col-hd">
            <span style={{width:8,height:8,borderRadius:"50%",background:CRM_STATUS_COLORS[col.status],flexShrink:0,display:"inline-block"}}/>
            <span className="crm-col-hd-label">{CRM_STATUS_LABELS[col.status]}</span>
            <span className="crm-col-count">{col.leads.length}</span>
          </div>
          <div className={`crm-col-body${overCol===col.status?" drag-over":""}`}>
            {col.leads.length===0&&<div style={{color:"var(--a-muted)",fontSize:".72rem",textAlign:"center",padding:"1.2rem",opacity:.5}}>Drag here</div>}
            {col.leads.map(l=>{const wa=l.phone?crmWaLink(l.phone,l.name,l.propertyInterest):null;const overdue=l.nextFollowUpDate&&new Date(l.nextFollowUpDate)<new Date();return(
              <div key={l.id} className={`crm-card${dragId===l.id?" dragging":""}`} draggable onDragStart={()=>setDragId(l.id)} onDragEnd={()=>setDragId(null)} onClick={()=>onSelect(l)}>
                <div className="crm-card-name">{l.name}</div>
                <div className="crm-card-meta">
                  {l.budget?`RM ${Number(l.budget).toLocaleString()}`:""}{l.budget&&l.propertyInterest?" · ":""}{l.propertyInterest||""}
                  {l.assignedAgent&&<div style={{marginTop:".2rem",opacity:.7,fontSize:".7rem"}}>👤 {l.assignedAgent}</div>}
                  {overdue&&<div className="crm-overdue">⚠ Overdue: {l.nextFollowUpDate}</div>}
                </div>
                <div className="crm-card-foot">
                  <span className="crm-card-src">{CRM_SOURCE_LABELS[l.source]||l.source}</span>
                  <span className="crm-card-score" style={{color:crmScore(l)>=60?"#0D0D18":"var(--a-muted)"}}>●{crmScore(l)}</span>
                  {wa&&<a href={wa.href} className="crm-wa-link" onClick={e=>e.stopPropagation()} target="_blank" rel="noopener noreferrer" style={{fontSize:".62rem",padding:".15rem .45rem"}}>💬</a>}
                </div>
              </div>
            );})}
          </div>
        </div>
      ))}
    </div>
  );
}
function CRMAnalytics({leads}){
  const total=leads.length;
  const closed=leads.filter(l=>l.status==="closed").length;
  const viewing=leads.filter(l=>l.status==="viewing").length;
  const overdue=leads.filter(l=>l.nextFollowUpDate&&new Date(l.nextFollowUpDate)<new Date()).length;
  const budgetLeads=leads.filter(l=>l.budget>0);
  const avgBudget=budgetLeads.reduce((a,l)=>a+Number(l.budget),0)/Math.max(1,budgetLeads.length);
  const maxStatus=Math.max(1,...CRM_STATUSES.map(s=>leads.filter(l=>l.status===s).length));
  const maxSource=Math.max(1,...CRM_SOURCES.map(s=>leads.filter(l=>l.source===s).length));
  return(
    <div>
      <div className="crm-stats">
        <div className="crm-stat"><div className="crm-stat-lbl">Total Leads</div><div className="crm-stat-val">{total}</div><div className="crm-stat-sub">all time</div></div>
        <div className="crm-stat"><div className="crm-stat-lbl">Closed / Won</div><div className="crm-stat-val" style={{color:"#4E9A72"}}>{closed}</div><div className="crm-stat-sub">{total?((closed/total)*100).toFixed(0):0}% conversion</div></div>
        <div className="crm-stat"><div className="crm-stat-lbl">Viewing Sched.</div><div className="crm-stat-val" style={{color:"#BF9B4E"}}>{viewing}</div><div className="crm-stat-sub">in pipeline</div></div>
        <div className="crm-stat"><div className="crm-stat-lbl">Overdue</div><div className="crm-stat-val" style={{color:"#C4543E"}}>{overdue}</div><div className="crm-stat-sub">need attention</div></div>
        <div className="crm-stat"><div className="crm-stat-lbl">Avg Budget</div><div className="crm-stat-val" style={{fontSize:"1.3rem"}}>{budgetLeads.length?`RM ${Math.round(avgBudget/1000)}k`:"—"}</div><div className="crm-stat-sub">{budgetLeads.length} with budget</div></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:"1rem"}}>
        <div className="crm-chart-card">
          <div className="crm-chart-title">Leads by Stage</div>
          {CRM_STATUSES.map(s=>{const c=leads.filter(l=>l.status===s).length;return(<div key={s} className="crm-bar-row"><span className="crm-bar-lbl">{CRM_STATUS_LABELS[s]}</span><div className="crm-bar-track"><div className="crm-bar-fill" style={{width:`${(c/maxStatus)*100}%`,background:CRM_STATUS_COLORS[s]}}/></div><span className="crm-bar-val" style={{color:CRM_STATUS_COLORS[s]}}>{c}</span></div>);})}
        </div>
        <div className="crm-chart-card">
          <div className="crm-chart-title">Leads by Source</div>
          {CRM_SOURCES.map(s=>{const c=leads.filter(l=>l.source===s).length;return(<div key={s} className="crm-bar-row"><span className="crm-bar-lbl">{CRM_SOURCE_LABELS[s]}</span><div className="crm-bar-track"><div className="crm-bar-fill" style={{width:`${(c/maxSource)*100}%`,background:"var(--a-gold)"}}/></div><span className="crm-bar-val">{c}</span></div>);})}
        </div>
      </div>
    </div>
  );
}
function CRMPanel({projects, settings}){
  const [leads,setLeads]=useState([]);
  const [crmTab,setCrmTab]=useState("table");
  const [selectedLead,setSelectedLead]=useState(null);
  const [editLead,setEditLead]=useState(null);
  const [activities,setActivities]=useState([]);
  const [loading,setLoading]=useState(true);
  useEffect(()=>{
    try{const unsub=crmLeadsListener(data=>{setLeads(data);setLoading(false);});return unsub;}
    catch(e){console.warn("CRM listener:",e);setLoading(false);}
  },[]);
  useEffect(()=>{
    if(!selectedLead){setActivities([]);return;}
    crmGetActivities(selectedLead.id).then(data=>setActivities(data)).catch(()=>setActivities([]));
  },[selectedLead?.id]);
  // Keep selected lead in sync with realtime leads
  useEffect(()=>{
    if(!selectedLead)return;
    const fresh=leads.find(l=>l.id===selectedLead.id);
    if(fresh)setSelectedLead(fresh);
  },[leads]);
  const handleSaveLead=async(formData)=>{
    try{
      if(!editLead||editLead==="new"){
        await crmAddLead(formData);
        await sendTelegramNotification(formData, settings);
      }else{
        await crmUpdateLead(editLead.id,formData);
      }
      setEditLead(null);
    }
    catch(e){alert("Failed to save: "+e.message);}
  };
  const handleDeleteLead=async(id)=>{
    try{await crmDeleteLead(id);if(selectedLead?.id===id)setSelectedLead(null);}
    catch(e){alert("Delete failed: "+e.message);}
  };
  const handleStatusChange=async(id,status)=>{try{await crmUpdateLead(id,{status});}catch(e){alert("Update failed: "+e.message);}};
  const handleAddActivity=async(data)=>{
    if(!selectedLead)return;
    try{await crmAddActivity(selectedLead.id,data);const a=await crmGetActivities(selectedLead.id);setActivities(a);}
    catch(e){alert("Failed to log activity: "+e.message);}
  };
  const handleUpdateLead=async(patch)=>{
    if(!selectedLead)return;
    try{
      await crmUpdateLead(selectedLead.id,patch);
      if(patch.status){await crmAddActivity(selectedLead.id,{type:"status_change",content:`Status → "${CRM_STATUS_LABELS[patch.status]}"`,createdBy:"admin"});const a=await crmGetActivities(selectedLead.id);setActivities(a);}
    }catch(e){alert("Update failed: "+e.message);}
  };
  return(
    <div>
      <div className="a-pg-title">Lead <em>CRM</em></div>
      <div className="a-pg-sub">Manage enquiries, track pipeline and log activities.</div>
      <div className="crm-subnav">
        <button className={`crm-subbtn${crmTab==="table"?" on":""}`} onClick={()=>setCrmTab("table")}>📋 Table</button>
        <button className={`crm-subbtn${crmTab==="kanban"?" on":""}`} onClick={()=>setCrmTab("kanban")}>🗂 Kanban</button>
        <button className={`crm-subbtn${crmTab==="analytics"?" on":""}`} onClick={()=>setCrmTab("analytics")}>📊 Analytics</button>
      </div>
      {loading&&<div style={{color:"var(--a-muted)",textAlign:"center",padding:"3rem",fontSize:".86rem"}}>Loading leads…</div>}
      {!loading&&crmTab==="table"&&<LeadTable leads={leads} projects={projects} onSelect={l=>setSelectedLead(l)} onAdd={()=>setEditLead("new")} onEdit={l=>setEditLead(l)} onDelete={handleDeleteLead}/>}
      {!loading&&crmTab==="kanban"&&<KanbanBoard leads={leads} onSelect={l=>setSelectedLead(l)} onStatusChange={handleStatusChange}/>}
      {!loading&&crmTab==="analytics"&&<CRMAnalytics leads={leads}/>}
      {selectedLead&&<LeadDrawer lead={selectedLead} activities={activities} projects={projects} onClose={()=>setSelectedLead(null)} onUpdate={handleUpdateLead} onAddActivity={handleAddActivity} onEdit={()=>setEditLead(selectedLead)} onDelete={handleDeleteLead}/>}
      {editLead&&<LeadForm lead={editLead} projects={projects} onSave={handleSaveLead} onClose={()=>setEditLead(null)}/>}
    </div>
  );
}

/* ═══ ADMIN PANEL ═══ */
const PAGE_SZ=8;
function AdminPanel({projects,onSave,onLogout,settings,onSaveSettings,aTab:externalATab,setATab:externalSetATab}){
  const [internalATab,internalSetATab]=useState("projects");
  const aTab = externalATab || internalATab;
  const setATab = externalSetATab || internalSetATab;
  const [srch,setSrch]=useState("");
  const [tf,setTf]=useState("All Types");
  const [sf,setSf]=useState("All Status");
  const [pg,setPg]=useState(1);
  const [editT,setEditT]=useState(null);
  const [delT,setDelT]=useState(null);
  const [openMenu,setOpenMenu]=useState(null);
  // ESC to close delete modal
  useEffect(() => {
    if (!delT) return;
    const h = (e) => { if (e.key === "Escape") setDelT(null); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [delT]);
  // Click-outside to close card dropdown menu
  useEffect(() => {
    if (openMenu === null) return;
    const h = (e) => {
      if (!e.target.closest(".a-card-menu-wrap")) setOpenMenu(null);
    };
    document.addEventListener("click", h);
    return () => document.removeEventListener("click", h);
  }, [openMenu]);
  const [toast,setToast]=useState(null);
  const showToast=(msg,type="success")=>setToast({msg,type});
  // Settings local state (copy so edits don't save until Save clicked)
  const [sett,setSett]=useState({...DEFAULT_SETTINGS,...settings});
  const setSF=(k,v)=>setSett(s=>({...s,[k]:v}));
  const handleSaveSettings=()=>{onSaveSettings(sett);showToast("Settings saved.","success");};
  // Password change fields
  const [curPw,setCurPw] = useState("");
  const [newPw,setNewPw] = useState("");
  const [newPw2,setNewPw2] = useState("");
  const [pwMsg,setPwMsg] = useState("");
  const [pwBusy,setPwBusy] = useState(false);
  const handleChangePassword = async () => {
    setPwMsg("");
    if (!newPw.trim()) { setPwMsg("New password cannot be empty."); return; }
    if (newPw !== newPw2) { setPwMsg("New passwords do not match."); return; }
    if (newPw.length < 6) { setPwMsg("New password must be at least 6 characters."); return; }
    setPwBusy(true);
    try {
      const user = auth.currentUser;
      if (!user || !user.email) { setPwMsg("No authenticated session found."); setPwBusy(false); return; }
      const credential = EmailAuthProvider.credential(user.email, curPw);
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, newPw);
      showToast("Password changed.","success"); setCurPw(""); setNewPw(""); setNewPw2("");
    } catch(e) {
      const bad=["auth/wrong-password","auth/invalid-credential"];
      setPwMsg(bad.includes(e.code)?"Current password is incorrect.":"Failed to change password. "+(e.message||""));
    }
    setPwBusy(false);
  };
  // Build preview WhatsApp URL
  const prevWaPhone=(sett.whatsappPhone||"60129846080").replace(/[^0-9]/g,"");
  const prevWaName=sett.whatsappName||"Joel";
  const prevWaURL=`https://api.whatsapp.com/send?phone=${prevWaPhone}&text=Hi%20${encodeURIComponent(prevWaName)},%20I%27m%20interested%20in%20your%20*Project%20Name*%20Please%20contact%20me,%20Thanks!`;
  const filt=useMemo(()=>projects.filter(p=>{if(tf!=="All Types"&&p.type!==tf)return false;if(sf!=="All Status"&&p.status!==sf)return false;if(srch){const q=srch.toLowerCase();if(!p.name.toLowerCase().includes(q)&&!p.developer.toLowerCase().includes(q)&&!p.location.toLowerCase().includes(q))return false;}return true;}),[projects,srch,tf,sf]);
  const totPg=Math.max(1,Math.ceil(filt.length/PAGE_SZ)),safePg=Math.min(pg,totPg),items=filt.slice((safePg-1)*PAGE_SZ,safePg*PAGE_SZ);
  useEffect(()=>{setPg(1);},[srch,tf,sf]);
  const handleSaveForm=(form,vis,sections)=>{
    const applyVis=(proj)=>({
      ...proj,
      visible: vis?.visible !== false,
      visibleTabs:{
        overview: vis?.overview !== false,
        location: vis?.location !== false,
        layouts:  vis?.layouts  !== false,
      },
      visibleSections: sections||defaultSections(),
    });
    if(editT==="new"){const proj=applyVis(f2p(form,newId(projects)));onSave([...projects,proj]);showToast(`"${proj.name}" added.`);}
    else{const proj=applyVis(f2p(form,editT.id));onSave(projects.map(p=>p.id===proj.id?proj:p));showToast(`"${proj.name}" updated.`,"info");}
    setEditT(null);
  };
  // Instant visibility toggle from table row
  const toggleProjectVisible=(id)=>{
    const updated=projects.map(p=>p.id===id?{...p,visible:p.visible===false?true:false}:p);
    const proj=updated.find(p=>p.id===id);
    onSave(updated);
    showToast(`"${proj.name}" is now ${proj.visible?"visible":"hidden"}.`, proj.visible?"success":"info");
  };
  const confirmDel=()=>{onSave(projects.filter(p=>p.id!==delT.id));showToast(`"${delT.name}" deleted.`,"error");setDelT(null);};
  const byS=s=>projects.filter(p=>p.status===s).length;
  return(
    <div className="a-shell">
      <aside className="a-sidebar">
        <div className="a-sidebar-sec">Management</div>
        <div className={`a-sb-item${aTab==="analytics"?" on":""}`} onClick={()=>setATab("analytics")}>📊 Analytics</div>
        <div className={`a-sb-item${aTab==="dashboard"?" on":""}`} onClick={()=>setATab("dashboard")}><IGrid/> Dashboard</div>
        <div className={`a-sb-item${aTab==="projects"?" on":""}`} onClick={()=>setATab("projects")}><IList/> Projects<span style={{marginLeft:"auto",background:"var(--a-gold)",color:"var(--a-bg)",borderRadius:999,fontSize:".6rem",fontWeight:700,padding:".05rem .38rem"}}>{projects.length}</span></div>
        <div className={`a-sb-item${aTab==="crm"?" on":""}`} onClick={()=>setATab("crm")}>👥 Leads CRM</div>
        <div className={`a-sb-item${aTab==="settings"?" on":""}`} onClick={()=>setATab("settings")}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> Settings</div>
        <div style={{height:1,background:"var(--a-border)",margin:"1rem 0"}}/>
        <div className="a-sidebar-sec">Account</div>
        <div className="a-sb-item" onClick={onLogout} style={{color:"#8E8A84"}}><ILogout/> Sign Out</div>
      </aside>
      <div className="a-main">
        {aTab==="analytics"&&<AnalyticsDashboard/>}
        {aTab==="crm"&&<CRMPanel projects={projects} settings={sett}/>}
        {aTab==="dashboard"&&<>
          <div className="a-pg-title">Admin <em>Dashboard</em></div>
          <div className="a-pg-sub">Overview of all NB Property listings.</div>
          <div className="a-stats">
            <div className="a-stat gold"><div className="a-stat-lbl">Total Projects</div><div className="a-stat-val">{projects.length}</div></div>
            <div className="a-stat blue"><div className="a-stat-lbl">New Launch</div><div className="a-stat-val">{byS("New Launch")}</div></div>
            <div className="a-stat green"><div className="a-stat-lbl">Under Construction</div><div className="a-stat-val">{byS("Under Construction")}</div></div>
            <div className="a-stat"><div className="a-stat-lbl">Completed</div><div className="a-stat-val">{byS("Completed")}</div></div>
          </div>
          <div style={{background:"var(--a-surface)",border:"1px solid var(--a-border)",padding:"1.5rem",marginBottom:"1.5rem"}}>
            <div style={{fontSize:".65rem",letterSpacing:".12em",textTransform:"uppercase",color:"var(--a-gold)",fontWeight:700,marginBottom:"1rem"}}>By Type</div>
            {PROP_TYPES.filter(t=>projects.some(p=>p.type===t)).map(t=>{const c=projects.filter(p=>p.type===t).length,pct=Math.round((c/projects.length)*100);return(<div key={t} style={{marginBottom:".6rem"}}><div style={{display:"flex",justifyContent:"space-between",fontSize:".78rem",color:"var(--a-text)",marginBottom:".25rem"}}><span>{t}</span><span style={{color:"var(--a-muted)"}}>{c}</span></div><div style={{height:3,background:"var(--a-border)"}}><div style={{height:"100%",background:"var(--a-gold)",width:`${pct}%`}}/></div></div>);})}
          </div>
          <button className="a-add-btn" style={{width:"100%",justifyContent:"center"}} onClick={()=>setATab("projects")}><IList/> Manage Projects</button>
        </>}
        {aTab==="projects"&&<>
          <div className="a-pg-title">Manage <em>Projects</em></div>
          <div className="a-pg-sub">Create, update, or remove property listings.</div>
          <div className="a-toolbar sticky">
            <input className="a-search" placeholder="Search…" value={srch} onChange={e=>setSrch(e.target.value)}/>
            <select className="a-fsel" value={tf} onChange={e=>setTf(e.target.value)}>{["All Types",...PROP_TYPES].map(t=><option key={t}>{t}</option>)}</select>
            <select className="a-fsel" value={sf} onChange={e=>setSf(e.target.value)}>{["All Status",...STATUSES].map(s=><option key={s}>{s}</option>)}</select>
            <button className="a-add-btn desktop-only" onClick={()=>setEditT("new")}><IPlus/> Add Project</button>
          </div>
          <div className="a-card-grid">
            {items.length===0?<div className="a-card-empty">No projects found.</div>:items.map(p=>(
              <div key={p.id} className={`a-proj-card${p.visible===false?" dimmed":""}`}>
                <div className="a-card-img-wrap">
                  <img className="a-card-img" src={p.image} alt={p.name} onError={e=>{e.target.onerror=null;e.target.src=FALLBACK_IMG;}}/>
                  <div className="a-card-status"><SChip s={p.status}/></div>
                  <div className={`a-card-vis-badge${p.visible===false?" hidden":""}`}>{p.visible!==false?"Live":"Hidden"}</div>
                </div>
                <div className="a-card-body">
                  <div className="a-card-name">{p.name}</div>
                  <div className="a-card-dev">{p.developer} · {p.location}</div>
                  <div className="a-card-meta">
                    <span>{p.type}</span>
                    <span className="a-card-meta-sep">·</span>
                    <span>{p.totalUnits?`${formatNum(p.totalUnits)} units`:'—'}</span>
                    <span className="a-card-meta-sep">·</span>
                    <span>{Array.isArray(p.unitTypes)?p.unitTypes.length:0} layouts</span>
                  </div>
                  <div className="a-card-price">{fmt(p.priceFrom)}</div>
                </div>
                <div className="a-card-footer">
                  <div className="a-card-toggle">
                    <Toggle checked={p.visible!==false} onChange={()=>toggleProjectVisible(p.id)} label={p.visible!==false?"Live":"Hidden"}/>
                  </div>
                  <div className="a-card-menu-wrap">
                    <button className="a-card-menu-btn" onClick={()=>setOpenMenu(openMenu===p.id?null:p.id)} title="Actions">⋮</button>
                    {openMenu===p.id&&(
                      <div className="a-card-dropdown">
                        <button className="a-card-drop-item" onClick={()=>{setEditT(p);setOpenMenu(null);}}><IEdit/> Edit</button>
                        <button className="a-card-drop-item danger" onClick={()=>{setDelT(p);setOpenMenu(null);}}><ITrash/> Delete</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="a-pager" style={{border:"1px solid var(--a-border)"}}>
            <span>Showing {filt.length===0?0:(safePg-1)*PAGE_SZ+1}–{Math.min(safePg*PAGE_SZ,filt.length)} of {filt.length}</span>
            <div className="a-pager-btns">
              <button className="a-pg-btn" onClick={()=>setPg(p=>Math.max(1,p-1))} disabled={safePg<=1}>‹</button>
              {Array.from({length:totPg},(_,i)=>i+1).map(n=><button key={n} className={`a-pg-btn${n===safePg?" on":""}`} onClick={()=>setPg(n)}>{n}</button>)}
              <button className="a-pg-btn" onClick={()=>setPg(p=>Math.min(totPg,p+1))} disabled={safePg>=totPg}>›</button>
            </div>
          </div>
          <button className="a-fab" onClick={()=>setEditT("new")} title="Add Project">+</button>
        </>}

        {aTab==="settings"&&<>
          <div className="a-pg-title">Contact <em>Settings</em></div>
          <div className="a-pg-sub">Configure how users can reach you when they click Register Interest.</div>

          {/* Email settings */}
          <div className="set-card">
            <div className="set-card-title">✉️ Admin Email</div>
            <div className="set-card-sub">
              Register Interest submissions are now saved directly into the CRM leads pipeline.<br/>
              This email is only used for other admin contact flows that still rely on email, such as showroom booking follow-up.
            </div>
            <div className="set-field">
              <label className="set-label">Admin Email Address</label>
              <input className="set-inp" type="email" value={sett.adminEmail} placeholder="e.g. admin@nbproperty.com"
                onChange={e=>setSF("adminEmail",e.target.value)}/>
            </div>
          </div>

          {/* WhatsApp settings */}
          <div className="set-card">
            <div className="set-card-title">💬 WhatsApp Contact</div>
            <div className="set-card-sub">
              When a user clicks the WhatsApp option, they will be directed to a pre-filled WhatsApp message including the project name they were viewing.
            </div>
            <div className="a-form-grid" style={{marginBottom:"1rem"}}>
              <div className="set-field">
                <label className="set-label">WhatsApp Phone Number</label>
                <input className="set-inp" type="tel" value={sett.whatsappPhone} placeholder="e.g. 60129846080"
                  onChange={e=>setSF("whatsappPhone",e.target.value.replace(/[^0-9]/g,""))}/>
                <div className="set-note">Include country code without + or spaces (e.g. 60129846080)</div>
              </div>
              <div className="set-field">
                <label className="set-label">Contact Name (for greeting)</label>
                <input className="set-inp" type="text" value={sett.whatsappName} placeholder="e.g. Joel"
                  onChange={e=>setSF("whatsappName",e.target.value)}/>
                <div className="set-note">Appears in the WhatsApp message as "Hi Joel, …"</div>
              </div>
            </div>
            <div className="a-form-grid" style={{marginBottom:"1rem", marginTop:'.5rem'}}>
              <div className="set-field">
                <label className="set-label">Default Country Code</label>
                <InlineCountrySelect value={sett.countryCode || "60"} onChange={v=>setSF("countryCode", String(v))} />
                <div className="set-note">Used to prefix mobile numbers in enquiry forms (no +)</div>
              </div>
            </div>
            <div className="set-preview">
              <div style={{fontSize:".65rem",letterSpacing:".1em",textTransform:"uppercase",color:"var(--a-gold)",fontWeight:700,marginBottom:".4rem"}}>Preview Link</div>
              <a href={prevWaURL} target="_blank" rel="noopener noreferrer">{prevWaURL}</a>
            </div>
          </div>

          <div className="set-card">
            <div className="set-card-title">🔒 Admin Password</div>
            <div className="set-card-sub">Change the password used to access the Admin Portal. Passwords are stored securely (hashed).</div>
            <div className="a-form-grid" style={{marginBottom:"1rem"}}>
              <div className="set-field">
                <label className="set-label">Current Password</label>
                <input className="set-inp" type="password" value={curPw} placeholder="Current password" onChange={e=>setCurPw(e.target.value)}/>
              </div>
              <div className="set-field">
                <label className="set-label">New Password</label>
                <input className="set-inp" type="password" value={newPw} placeholder="New password" onChange={e=>setNewPw(e.target.value)}/>
              </div>
              <div className="set-field">
                <label className="set-label">Confirm New Password</label>
                <input className="set-inp" type="password" value={newPw2} placeholder="Confirm new password" onChange={e=>setNewPw2(e.target.value)}/>
              </div>
            </div>
            {pwMsg && <div className="set-note" style={{color:"#8E8A84"}}>{pwMsg}</div>}
            <div style={{marginTop:".6rem"}}>
              <button className="set-save-btn" onClick={handleChangePassword} disabled={pwBusy}>{pwBusy?"Updating…":"Change Password"}</button>
              <div className="set-note" style={{marginTop:".6rem"}}>Password is managed via Firebase Authentication.</div>
            </div>
          </div>

          {/* Telegram Notification Settings */}
          <div className="set-card">
            <div className="set-card-title">🔔 Telegram Notification Settings</div>
            <div className="set-card-sub">
              Send an instant Telegram message every time a new lead is received. Your bot token is stored securely and never exposed to the browser — it is forwarded server-side through <code>/api/send-telegram</code>.
            </div>
            <div className="set-field" style={{marginBottom:".75rem"}}>
              <label className="set-label" style={{display:"flex",alignItems:"center",gap:".5rem",cursor:"pointer"}}>
                <input type="checkbox" checked={!!sett.telegramEnabled} onChange={e=>setSF("telegramEnabled",e.target.checked)} style={{width:16,height:16,accentColor:"var(--a-gold)",cursor:"pointer"}}/>
                Enable Telegram Notifications
              </label>
            </div>
            <div className="a-form-grid" style={{marginBottom:"1rem"}}>
              <div className="set-field">
                <label className="set-label">Bot Token</label>
                <input className="set-inp" type="text" value={sett.telegramBotToken||""} placeholder="123456:ABC-DEF…"
                  onChange={e=>setSF("telegramBotToken",e.target.value.trim())}/>
                <div className="set-note">From @BotFather → /mybots → API Token</div>
              </div>
              <div className="set-field">
                <label className="set-label">Chat ID</label>
                <input className="set-inp" type="text" value={sett.telegramChatId||""} placeholder="e.g. 123456789"
                  onChange={e=>setSF("telegramChatId",e.target.value.trim())}/>
                <div className="set-note">Your personal or group chat ID (use @userinfobot to find it)</div>
              </div>
            </div>
            <div style={{display:"flex",gap:".6rem",alignItems:"center",flexWrap:"wrap"}}>
              <button className="set-save-btn" onClick={async()=>{
                const botToken=(sett.telegramBotToken||"").trim();
                const chatId=(sett.telegramChatId||"").trim();
                if(!botToken||!chatId){showToast("Enter Bot Token and Chat ID first.","error");return;}
                try{
                  const res=await fetch("/api/send-telegram",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({botToken,chatId,text:"✅ *Test Notification*\n\nYour NB Property Telegram notifications are working correctly."})});
                  if(res.ok){showToast("Test message sent!","success");}else{showToast("Failed — check your Bot Token & Chat ID.","error");}
                }catch{showToast("Network error sending test.","error");}
              }}>Send Test Message</button>
              <span style={{fontSize:".72rem",color:"var(--a-muted)"}}>Sends a sample message to verify the configuration.</span>
            </div>
          </div>

          <button className="set-save-btn" onClick={handleSaveSettings}>Save Settings</button>
        </>}
      </div>

      {editT!==null&&<PropertyForm initial={editT==="new"?EMPTY_FORM:p2f(editT)} isEdit={editT!=="new"} onSave={handleSaveForm} onClose={()=>setEditT(null)}/>}
      {delT&&<div className="a-modal-ov" onClick={e=>e.target===e.currentTarget&&setDelT(null)}><div className="del-modal"><div className="del-ico">🗑️</div><div className="del-title">Delete Project?</div><p className="del-sub">Permanently remove <strong>{delT.name}</strong>. Cannot be undone.</p><div className="del-btns"><button className="del-cancel" onClick={()=>setDelT(null)}>Cancel</button><button className="del-confirm" onClick={confirmDel}>Yes, Delete</button></div></div></div>}
      {toast&&<Toast msg={toast.msg} type={toast.type} onDone={()=>setToast(null)}/>}
    </div>
  );
}

/* ═══ ADMIN LOGIN ═══ */
function AdminLogin(){
  const [email,setEmail]=useState("");
  const [pw,setPw]=useState("");
  const [err,setErr]=useState("");
  const [checking,setChecking]=useState(false);
  const go=async()=>{
    if(!email.trim()||!pw){setErr("Please enter your email and password.");return;}
    setChecking(true);setErr("");
    try{
      await signInWithEmailAndPassword(auth,email.trim(),pw);
    }catch(e){
      const bad=["auth/invalid-credential","auth/wrong-password","auth/user-not-found","auth/invalid-email"];
      setErr(bad.includes(e.code)?"Incorrect email or password.":"Sign-in failed. Please try again.");
      setChecking(false);
    }
  };
  return(
    <div className="a-login">
      <div className="a-login-box">
        <div className="a-login-logo">NB<span>Property</span></div>
        <div className="a-login-sub">Admin Portal — Restricted Access</div>
        {err&&<div className="a-login-err">{err}</div>}
        <label className="a-login-lbl">Email</label>
        <input className="a-login-inp" type="email" placeholder="admin@example.com" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()}/>
        <label className="a-login-lbl">Password</label>
        <input className="a-login-inp" type="password" placeholder="Enter password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()}/>
        <button className="a-login-btn" onClick={go} disabled={checking}>{checking?"Signing in…":"Sign In"}</button>
      </div>
    </div>
  );
}

/* ═══ LOAN CALCULATOR (Tools tab) ═══ */
const fmtRM=(n)=>(!n&&n!==0)||isNaN(n)?"RM 0":"RM "+Math.round(n).toLocaleString("en-MY");
const fmtPct=(n)=>(+n||0).toFixed(2).replace(/\.?0+$/,"")+" %";

function calculateAdjustedPrice(price,discountPct){
  const discountAmt=price*(discountPct/100);
  return{discountAmt,adjustedPrice:price-discountAmt};
}
function lcLegalFee(amount){
  if(!amount||amount<=0)return 0;
  if(amount<=500000)return amount*0.0125;
  return 500000*0.0125+(amount-500000)*0.01;
}
function lcMOT(adjPrice,isForeign){
  if(!adjPrice||adjPrice<=0)return 0;
  if(isForeign)return adjPrice*0.08;
  let m=0;
  if(adjPrice<=100000)return adjPrice*0.01;
  m+=100000*0.01;
  if(adjPrice<=500000)return m+(adjPrice-100000)*0.02;
  m+=400000*0.02;
  if(adjPrice<=1000000)return m+(adjPrice-500000)*0.03;
  m+=500000*0.03;
  return m+(adjPrice-1000000)*0.04;
}
function calculateLoan(loanAmt,rate,years){
  if(loanAmt<=0||rate<=0||years<=0)return{monthly:0,totalPay:0,totalInterest:0};
  const r=rate/12/100,n=years*12;
  const monthly=loanAmt*(r*Math.pow(1+r,n))/(Math.pow(1+r,n)-1);
  const totalPay=monthly*n;
  return{monthly,totalPay,totalInterest:totalPay-loanAmt};
}
function calculateInitialCash(adjPrice,loanAmt,dpAmt,isForeign,isCommercial){
  const legalSPA=lcLegalFee(adjPrice);
  const legalLoan=lcLegalFee(loanAmt);
  const spaStamp=40;
  const loanStamp=loanAmt*0.005;
  const mot=lcMOT(adjPrice,isForeign);
  const levy=isForeign?adjPrice*0.03:0;
  const stateFee=isForeign?(isCommercial?20000:10000):0;
  const total=dpAmt+legalSPA+legalLoan+spaStamp+loanStamp+mot+levy+stateFee;
  return{legalSPA,legalLoan,spaStamp,loanStamp,mot,levy,stateFee,total};
}
function calculateNetCash(totalInitialCash,rebateAmt){
  return totalInitialCash-rebateAmt;
}

function AnimNum({value,format=(v=>v)}){
  const [display,setDisplay]=useState(value);
  const state=useRef({from:value,raf:null,first:true});
  useEffect(()=>{
    if(state.current.first){state.current.first=false;state.current.from=value;return;}
    const from=state.current.from,to=value;
    if(from===to)return;
    const t0=performance.now(),dur=480;
    const tick=(now)=>{
      const p=Math.min((now-t0)/dur,1);
      const ease=1-Math.pow(1-p,3);
      setDisplay(Math.round(from+(to-from)*ease));
      if(p<1)state.current.raf=requestAnimationFrame(tick);
      else{state.current.from=to;setDisplay(to);}
    };
    if(state.current.raf)cancelAnimationFrame(state.current.raf);
    state.current.raf=requestAnimationFrame(tick);
    state.current.from=from;
    return()=>{if(state.current.raf)cancelAnimationFrame(state.current.raf);};
  },[value]);
  return <span key={value} className="lc-val-flash">{format(display)}</span>;
}

function LoanCalculator({settings}){
  const [price,setPrice]=useState(500000);
  const [discountMode,setDiscountMode]=useState("pct"); // "pct" | "amt"
  const [discountPct,setDiscountPct]=useState(0);
  const [discountAmt2,setDiscountAmt2]=useState(0);
  const [rebateMode,setRebateMode]=useState("pct"); // "pct" | "amt"
  const [rebatePct,setRebatePct]=useState(0);
  const [rebateAmt2,setRebateAmt2]=useState(0);
  const [dpPct,setDpPct]=useState(10);
  const [rate,setRate]=useState(4);
  const [years,setYears]=useState(35);
  const [isForeign,setIsForeign]=useState(false);
  const [isCommercial,setIsCommercial]=useState(false);
  const [showBreakdown,setShowBreakdown]=useState(false);
  const [saved,setSaved]=useState(null);

  // ── Core calculations in correct order ──
  const discountAmt=discountMode==="pct"?price*(discountPct/100):discountAmt2;
  const adjustedPrice=Math.max(0,price-discountAmt);
  const rebateAmt=rebateMode==="pct"?adjustedPrice*(rebatePct/100):rebateAmt2;
  const dpAmt=Math.round(adjustedPrice*(dpPct/100));
  const loanAmt=Math.max(0,adjustedPrice-dpAmt);
  const loan=calculateLoan(loanAmt,rate,years);
  const cash=calculateInitialCash(adjustedPrice,loanAmt,dpAmt,isForeign,isCommercial);
  const netCash=calculateNetCash(cash.total,rebateAmt);
  const totalSavings=discountAmt+rebateAmt;
  const savingsPct=price>0?(totalSavings/price)*100:0;
  const isBelowMarket=savingsPct>10;
  const piePct=loan.totalPay>0?Math.round((loanAmt/loan.totalPay)*100):0;
  // ring circumference for r=52: 2πr ≈ 326.7
  const ringC=326.7;
  const ringFill=ringC*(piePct/100);

  // ── Amortization curve data ──
  const amortData=useMemo(()=>{
    if(loanAmt<=0||loan.monthly<=0||years<=0)return{pathD:"",fillD:"",W:300,H:72,midYr:0};
    const W=300,H=72,r=rate/12/100;
    let bal=loanAmt;
    const pts=[];
    for(let yr=0;yr<=years;yr++){
      const x=(yr/years)*W;
      const y=H*(1-bal/loanAmt); // 0=top(full debt) → H=bottom(paid)
      pts.push({x,y});
      for(let m=0;m<12&&bal>0;m++){
        const interest=bal*r;
        bal=Math.max(0,bal-Math.max(0,loan.monthly-interest));
      }
    }
    const pathD="M "+pts.map(p=>`${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ");
    const last=pts[pts.length-1];
    const fillD=pathD+` L ${last.x.toFixed(1)},${H} L 0,${H} Z`;
    return{pathD,fillD,W,H,midYr:Math.floor(years/2)};
  },[loanAmt,rate,years,loan.monthly]);

  // ── Cost composition bar ──
  const cbarTotal=cash.total;
  const cbarSegs=cbarTotal>0?[
    {label:"Down Payment",color:"#BF9B4E",val:dpAmt},
    {label:"Legal Fees",color:"#5E8FD0",val:cash.legalSPA+cash.legalLoan},
    {label:"Stamp Duties",color:"#9090A8",val:cash.spaStamp+cash.loanStamp},
    {label:"MOT / Transfer",color:"#C4543E",val:cash.mot+cash.levy+cash.stateFee},
  ]:[];

  const waPhone=(settings?.whatsappPhone||"60129846080").replace(/\D/g,"");
  const waName=settings?.whatsappName||"Joel";
  const waMsg=`Hi ${waName}, I used the NB Property Loan Calculator.\n\nProperty: RM ${price.toLocaleString()}\nAdjusted SPA: ${fmtRM(adjustedPrice)}\nMonthly Installment: ${fmtRM(loan.monthly)}\nNet Cash Out: ${fmtRM(netCash)}\n\nCan you advise?`;
  const waUrl=`https://api.whatsapp.com/send?phone=${waPhone}&text=${encodeURIComponent(waMsg)}`;

  const saveCalc=()=>{
    const data={price,discountMode,discountPct,discountAmt2,rebateMode,rebatePct,rebateAmt2,dpPct,rate,years,isForeign,isCommercial,monthly:loan.monthly,netCash,ts:Date.now()};
    localStorage.setItem("nb_calc_saved",JSON.stringify(data));
    setSaved(data);
  };
  useEffect(()=>{
    try{const s=localStorage.getItem("nb_calc_saved");if(s)setSaved(JSON.parse(s));}catch{}
  },[]);
  const loadSaved=()=>{
    if(!saved)return;
    setPrice(saved.price||500000);
    setDiscountMode(saved.discountMode||"pct");setDiscountPct(saved.discountPct||0);setDiscountAmt2(saved.discountAmt2||0);
    setRebateMode(saved.rebateMode||"pct");setRebatePct(saved.rebatePct||0);setRebateAmt2(saved.rebateAmt2||0);
    setDpPct(saved.dpPct||10);setRate(saved.rate||4);setYears(saved.years||35);
    setIsForeign(!!saved.isForeign);setIsCommercial(!!saved.isCommercial);
  };

  const numInp=(set,min=0,max=99999999)=>e=>{const v=parseFloat(String(e.target.value).replace(/,/g,""));if(!isNaN(v)&&v>=min&&v<=max)set(v);};

  const BkdRow=({label,value,gold,grn})=>(
    <div className="lc-bkd-row">
      <span className="lc-bkd-rowlbl">{label}</span>
      <span className={`lc-bkd-rowval${gold?" gold":grn?" grn":""}`}>{value}</span>
    </div>
  );

  return(
    <div className="lc-pg">
      {/* Ambient blobs + grid */}
      <div className="lc-pg-blob1"/>
      <div className="lc-pg-blob2"/>
      <div className="lc-pg-blob3"/>
      <div className="lc-pg-grid"/>

      {/* Hero band */}
      <div className="lc-hero-band">
        <div className="lc-hero-eyebrow">Malaysia Property Finance Intelligence</div>
        <h2 className="lc-hero-headline">Luxury Loan Calculator</h2>
        <p className="lc-hero-desc">Precision financing insights for premium property buyers — instant calculations for monthly installments, legal costs, and net cash out.</p>
        {isBelowMarket&&<span className="lc-bm-badge">🏷 Below Market Deal</span>}
        {totalSavings>0&&(
          <div style={{marginTop:".7rem"}}>
            <div className="lc-savings-band">
              <span>💰 Total Savings</span>
              <strong>{fmtRM(totalSavings)}</strong>
              <span>({fmtPct(savingsPct)} off market)</span>
            </div>
          </div>
        )}
      </div>

      {/* Main dashboard */}
      <div className="lc-dash">
        {/* ── INPUT COLUMN ── */}
        <div className="lc-inp-col">

          {/* Property Price & Adjustments */}
          <div className="lc-gc lc-sec">
            <div className="lc-sec-hd">
              <div className="lc-sec-ico lc-sec-ico-gold">🏠</div>
              <div className="lc-sec-title">Property Price &amp; Adjustments</div>
            </div>
            <div className="lc-flds">
              <div className="lc-fld">
                <div className="lc-flbl">Listing / Market Price (RM)</div>
                <input className="lc-finp" type="number" min="0" value={price} onChange={numInp(setPrice)} onFocus={e=>e.target.select()}/>
              </div>
              <div className="lc-fld2">
                <div className="lc-fld">
                  <div className="lc-flbl" style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:".5rem"}}>
                    <span>Discount</span>
                    <span className="lc-mode-toggle">
                      <button className={discountMode==="pct"?"on":""} onClick={()=>setDiscountMode("pct")}>%</button>
                      <button className={discountMode==="amt"?"on":""} onClick={()=>setDiscountMode("amt")}>RM</button>
                    </span>
                  </div>
                  {discountMode==="pct"
                    ?<input className="lc-finp" type="number" min="0" max="50" step="0.5" value={discountPct} onChange={numInp(setDiscountPct,0,50)} onFocus={e=>e.target.select()}/>
                    :<input className="lc-finp" type="number" min="0" value={discountAmt2} onChange={numInp(setDiscountAmt2,0,price)} onFocus={e=>e.target.select()} placeholder="e.g. 47000"/>
                  }
                  {discountAmt>0&&<div className="lc-fhint lc-fhint-grn">−{fmtRM(discountAmt)}{discountMode==="amt"?"":` (${((discountAmt/price)*100).toFixed(1)}%)`}</div>}
                </div>
                <div className="lc-fld">
                  <div className="lc-flbl" style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:".5rem"}}>
                    <span>Rebate / Cashback</span>
                    <span className="lc-mode-toggle">
                      <button className={rebateMode==="pct"?"on":""} onClick={()=>setRebateMode("pct")}>%</button>
                      <button className={rebateMode==="amt"?"on":""} onClick={()=>setRebateMode("amt")}>RM</button>
                    </span>
                  </div>
                  {rebateMode==="pct"
                    ?<input className="lc-finp" type="number" min="0" max="20" step="0.5" value={rebatePct} onChange={numInp(setRebatePct,0,20)} onFocus={e=>e.target.select()}/>
                    :<input className="lc-finp" type="number" min="0" value={rebateAmt2} onChange={numInp(setRebateAmt2,0,adjustedPrice)} onFocus={e=>e.target.select()} placeholder="e.g. 30000"/>
                  }
                  {rebateAmt>0&&<div className="lc-fhint lc-fhint-grn">−{fmtRM(rebateAmt)}{rebateMode==="amt"?"":` (${((rebateAmt/adjustedPrice)*100).toFixed(1)}%)`}</div>}
                </div>
              </div>
              {(discountPct>0||rebatePct>0)&&(
                <div className="lc-adj">
                  <span>SPA Price (after discount)</span>
                  <strong>{fmtRM(adjustedPrice)}</strong>
                </div>
              )}
              {rebatePct>0&&<div className="lc-rebate-note">ℹ️ Rebate reduces your cash out only — legal fees &amp; MOT are based on the SPA price.</div>}
            </div>
          </div>

          {/* Loan Terms */}
          <div className="lc-gc lc-sec">
            <div className="lc-sec-hd">
              <div className="lc-sec-ico lc-sec-ico-cyan">📈</div>
              <div className="lc-sec-title">Loan Terms</div>
            </div>
            <div className="lc-flds">
              <div className="lc-fld">
                <div className="lc-fslider-wrap">
                  <div className="lc-fslider-top">
                    <div className="lc-flbl">Interest Rate</div>
                    <div className="lc-fslider-val">{rate}% p.a.</div>
                  </div>
                  <input className="lc-fslider" type="range" min="1" max="12" step="0.05" value={rate} onChange={e=>setRate(parseFloat(e.target.value))}/>
                  <div className="lc-fslider-ends"><span>1%</span><span>12%</span></div>
                </div>
              </div>
              <div className="lc-fld">
                <div className="lc-fslider-wrap">
                  <div className="lc-fslider-top">
                    <div className="lc-flbl">Loan Tenure</div>
                    <div className="lc-fslider-val">{years} years</div>
                  </div>
                  <input className="lc-fslider" type="range" min="5" max="35" step="1" value={years} onChange={e=>setYears(parseInt(e.target.value))}/>
                  <div className="lc-fslider-ends"><span>5 yrs</span><span>35 yrs</span></div>
                </div>
              </div>
              <div className="lc-fld">
                <div className="lc-fslider-wrap">
                  <div className="lc-fslider-top">
                    <div className="lc-flbl">Down Payment</div>
                    <div className="lc-fslider-val">{fmtRM(dpAmt)}</div>
                  </div>
                  <input className="lc-fslider" type="range" min="0" max="30" step="5" value={dpPct} onChange={e=>setDpPct(parseInt(e.target.value))}/>
                  <div className="lc-fslider-ends"><span>0%</span><span>30%</span></div>
                  <span style={{fontSize:".66rem",color:"rgba(255,255,255,.3)"}}>{dpPct}% of SPA</span>
                </div>
              </div>
            </div>
          </div>

          {/* Buyer & Property Type */}
          <div className="lc-gc lc-sec">
            <div className="lc-sec-hd">
              <div className="lc-sec-ico lc-sec-ico-grn">🌐</div>
              <div className="lc-sec-title">Buyer &amp; Property Type</div>
            </div>
            <div className="lc-tgrp">
              <div className="lc-tpill">
                <button className={!isForeign?"on":""} onClick={()=>setIsForeign(false)}>🇲🇾 Local</button>
                <button className={isForeign?"on":""} onClick={()=>setIsForeign(true)}>🌏 Foreign</button>
              </div>
              <div className="lc-tpill">
                <button className={!isCommercial?"on":""} onClick={()=>setIsCommercial(false)}>🏠 Residential</button>
                <button className={isCommercial?"on":""} onClick={()=>setIsCommercial(true)}>🏢 Commercial</button>
              </div>
            </div>
            {isForeign&&<div className="lc-foreign-note">⚠️ Foreign buyer: 8% MOT (flat) + 3% Levy + State Fee ({isCommercial?"RM 20,000":"RM 10,000"}) applies</div>}
          </div>

        </div>

        {/* ── RESULT COLUMN ── */}
        <div className="lc-res-col">

          {/* Monthly installment hero */}
          <div className="lc-gc lc-monthly">
            <div className="lc-monthly-eyebrow">Monthly Installment</div>
            <div className="lc-monthly-ring">
              <svg width="130" height="130" viewBox="0 0 130 130">
                <circle cx="65" cy="65" r="52" fill="none" stroke="rgba(191,155,78,.12)" strokeWidth="10"/>
                <circle key={Math.round(ringFill)} cx="65" cy="65" r="52" fill="none" stroke="url(#lcRingGrad)" strokeWidth="10"
                  strokeDasharray={`${ringFill} ${ringC-ringFill}`}
                  strokeDashoffset="0" strokeLinecap="round"
                  className="lc-ring-arc" style={{"--fill":ringFill.toFixed(1)}}/>
                <defs>
                  <linearGradient id="lcRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#FFE08A"/>
                    <stop offset="100%" stopColor="#BF9B4E"/>
                  </linearGradient>
                </defs>
              </svg>
              <div className="lc-monthly-ring-inner">
                <div className="lc-monthly-ring-pct" style={{fontSize:'.58rem'}}>{fmtRM(Math.round(loan.monthly))}</div>
                <div className="lc-monthly-ring-pctlbl">/ month</div>
              </div>
            </div>
            <div className="lc-monthly-val"><AnimNum value={Math.round(loan.monthly)} format={fmtRM}/></div>
            <div className="lc-monthly-meta">
              {years} years &nbsp;·&nbsp; {rate}% p.a. &nbsp;·&nbsp; Loan {fmtRM(loanAmt)}
            </div>
            <div className="lc-monthly-legend">
              <div className="lc-monthly-leg">
                <div className="lc-monthly-legdot" style={{background:"linear-gradient(135deg,#FFE08A,#BF9B4E)"}}/>
                Principal {fmtRM(Math.round(loan.monthly*(piePct/100)))}
              </div>
              <div className="lc-monthly-leg">
                <div className="lc-monthly-legdot" style={{background:"rgba(191,155,78,.22)"}}/>
                Interest {fmtRM(Math.round(loan.monthly*(1-piePct/100)))}
              </div>
            </div>
          </div>

          {/* Metrics grid */}
          <div className="lc-metrics">
            <div className="lc-gc lc-metric">
              <div className="lc-metric-lbl">Adjusted SPA Price</div>
              <div className="lc-metric-val">{fmtRM(adjustedPrice)}</div>
            </div>
            <div className="lc-gc lc-metric">
              <div className="lc-metric-lbl">Loan Amount</div>
              <div className="lc-metric-val cyan">{fmtRM(loanAmt)}</div>
            </div>
            <div className="lc-gc lc-metric">
              <div className="lc-metric-lbl">Total Initial Cash</div>
              <div className="lc-metric-val">{fmtRM(cash.total)}</div>
            </div>
            <div className="lc-gc lc-metric">
              <div className="lc-metric-lbl">{rebateAmt>0?"Rebate Received":"Total Interest Paid"}</div>
              <div className={`lc-metric-val${rebateAmt>0?" grn":" dim"}`}>
                {rebateAmt>0?`−${fmtRM(rebateAmt)}`:fmtRM(loan.totalInterest)}
              </div>
            </div>
          </div>

          {/* Amortization curve */}
          {amortData.pathD&&(
            <div className="lc-gc lc-amort">
              <div className="lc-amort-eyebrow">
                <span>Loan Balance Over Time</span>
                <span style={{color:"rgba(255,255,255,.28)"}}>{years}yr @ {rate}%</span>
              </div>
              <div className="lc-amort-svg-wrap">
                <svg key={amortData.pathD.slice(0,30)} viewBox={`0 0 ${amortData.W} ${amortData.H}`} preserveAspectRatio="none" width="100%" height="80">
                  <defs>
                    <linearGradient id="amortLineGrad" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#00D4FF"/>
                      <stop offset="100%" stopColor="#BF9B4E"/>
                    </linearGradient>
                    <linearGradient id="amortAreaFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgba(0,212,255,.22)"/>
                      <stop offset="100%" stopColor="rgba(191,155,78,.04)"/>
                    </linearGradient>
                  </defs>
                  {/* Year marker lines */}
                  {[0,amortData.midYr,years].map(yr=>{
                    const x=((yr/years)*amortData.W).toFixed(1);
                    return <line key={yr} x1={x} y1="0" x2={x} y2={amortData.H} stroke="rgba(255,255,255,.07)" strokeWidth="1" strokeDasharray="3,3"/>;
                  })}
                  <path d={amortData.fillD} fill="url(#amortAreaFill)"/>
                  <path d={amortData.pathD} fill="none" stroke="url(#amortLineGrad)" strokeWidth="2.2" strokeLinecap="round" className="lc-amort-line"/>
                  {/* Midpoint dot */}
                  <circle cx={(amortData.W/2).toFixed(1)} cy={(amortData.H*0.5).toFixed(1)} r="3" fill="#00D4FF" opacity=".7"/>
                </svg>
              </div>
              <div className="lc-amort-axis">
                <span>Year 0</span>
                <span>Year {amortData.midYr}</span>
                <span>Year {years}</span>
              </div>
            </div>
          )}

          {/* Cost composition bar */}
          {cbarTotal>0&&(
            <div className="lc-gc lc-cbar">
              <div className="lc-cbar-title">Initial Cash Composition</div>
              <div className="lc-cbar-track">
                {cbarSegs.map((s,i)=>s.val>0&&(
                  <div key={i} className="lc-cbar-seg" style={{flex:s.val/cbarTotal,background:s.color,opacity:.88}}/>
                ))}
              </div>
              <div className="lc-cbar-legs">
                {cbarSegs.map((s,i)=>s.val>0&&(
                  <div key={i} className="lc-cbar-leg">
                    <div className="lc-cbar-dot" style={{background:s.color}}/>
                    {s.label} ({((s.val/cbarTotal)*100).toFixed(0)}%)
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Net Cash Out */}
          <div className="lc-gc lc-netcash">
            <div className="lc-netcash-top">
              <div>
                <div className="lc-netcash-lbl">✅ Net Cash Out</div>
                <div className="lc-netcash-val"><AnimNum value={Math.round(netCash)} format={fmtRM}/></div>
              </div>
              {rebateAmt>0&&(
                <div className="lc-netcash-save">
                  <div className="lc-netcash-save-lbl">Rebate Saves</div>
                  <div className="lc-netcash-save-val">−{fmtRM(rebateAmt)}</div>
                </div>
              )}
            </div>
          </div>

          {/* Full Cost Breakdown */}
          <div className="lc-gc lc-bkd">
            <button className="lc-bkd-btn" onClick={()=>setShowBreakdown(v=>!v)}>
              <span>Full Cost Breakdown</span>
              <span className={`lc-bkd-btn-ico${showBreakdown?" open":""}`}>▼</span>
            </button>
            {showBreakdown&&(
              <div className="lc-bkd-inner">
                <div className="lc-bkd-section-title">Price</div>
                <BkdRow label="Original Listing Price" value={fmtRM(price)}/>
                {discountAmt>0&&<BkdRow label={`Discount (${discountPct}%)`} value={`−${fmtRM(discountAmt)}`} grn/>}
                <BkdRow label="Adjusted SPA Price" value={fmtRM(adjustedPrice)} gold/>
                {rebateAmt>0&&<BkdRow label={`Rebate / Cashback${rebateMode==="pct"?` (${rebatePct}%)`:" (flat)"}`} value={`−${fmtRM(rebateAmt)}`} grn/>}

                <div className="lc-bkd-section-title" style={{marginTop:".5rem"}}>Down Payment &amp; Loan</div>
                <BkdRow label={`Down Payment (${dpPct}%)`} value={fmtRM(dpAmt)} gold/>
                <BkdRow label="Loan Amount" value={fmtRM(loanAmt)}/>

                <div className="lc-bkd-section-title" style={{marginTop:".5rem"}}>Legal &amp; Stamp Fees</div>
                <BkdRow label="Legal Fee — SPA" value={fmtRM(cash.legalSPA)}/>
                <BkdRow label="Legal Fee — Loan Agreement" value={fmtRM(cash.legalLoan)}/>
                <BkdRow label="SPA Stamp Duty (RM40 fixed)" value={fmtRM(cash.spaStamp)}/>
                <BkdRow label="Loan Stamp Duty (0.5% of loan)" value={fmtRM(cash.loanStamp)}/>

                <div className="lc-bkd-section-title" style={{marginTop:".5rem"}}>Transfer &amp; Taxes</div>
                <BkdRow label={`MOT / Transfer Stamp Duty${isForeign?" (8% flat)":""}`} value={fmtRM(cash.mot)} gold/>
                {isForeign&&<BkdRow label="Foreign Buyer Levy (3%)" value={fmtRM(cash.levy)} gold/>}
                {isForeign&&<BkdRow label={`State Fee (${isCommercial?"Commercial":"Residential"})`} value={fmtRM(cash.stateFee)} gold/>}

                <div className="lc-bkd-total">
                  <span className="lc-bkd-total-lbl">Total Initial Cash</span>
                  <span className="lc-bkd-total-val" style={{color:"#D4B880"}}>{fmtRM(cash.total)}</span>
                </div>
                {rebateAmt>0&&<BkdRow label={`Rebate Deducted (${rebatePct}%)`} value={`−${fmtRM(rebateAmt)}`} grn/>}
                <div className="lc-bkd-total">
                  <span className="lc-bkd-total-lbl">✅ Net Cash Out</span>
                  <span className="lc-bkd-total-val">{fmtRM(netCash)}</span>
                </div>
                <div className="lc-bkd-note">* Estimates only. Legal fees subject to solicitor discretion. MOT per Stamp Act 1949 (Amendment 2019). Foreign buyer fees vary by state.</div>
              </div>
            )}
          </div>

        </div>
      </div>



      {/* Mobile sticky bar */}
      <div className="lc-mob-bar">
        <div>
          <div className="lc-mob-monthly">Monthly</div>
          <div className="lc-mob-val">{fmtRM(loan.monthly)}</div>
          <div className="lc-mob-sub">Net Cash {fmtRM(netCash)}</div>
        </div>
        <a href={waUrl} target="_blank" rel="noopener noreferrer" className="lc-mob-wa">Contact Agent</a>
      </div>
    </div>
  );
}

/* ═══ MAIN APP ═══ */
/* ── Lightweight scroll-reveal hook (no external deps) ── */
function useScrollInView(ref, { once = true, margin = "0px" } = {}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); if (once) obs.disconnect(); } },
      { rootMargin: margin }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return visible;
}

/* ═══════════════════════════════════════
   MAIN SECTIONS
═══════════════════════════════════════ */
function LuxuryHero({ search, onSearch, onExplore, onContact }) {
  const stats = [
    { num: "250+", label: "Projects Listed" },
    { num: "15+", label: "Years Experience" },
    { num: "All Budgets", label: "Catered For" },
    { num: "98%", label: "Client Satisfaction" },
  ];
  return (
    <section className="lux-hero">
      <div className="lux-hero-bg"/>
      <div className="lux-hero-overlay"/>
      <div className="lux-hero-side-glow"/>
      <div className="lux-hero-grid"/>
      <div className="lux-hero-content">
        <div className="lux-eyebrow lux-anim" style={{animationDelay:".1s"}}>
          Penang's Most Complete New Launch Platform
        </div>
        <h1 className="lux-h1 lux-anim" style={{animationDelay:".28s"}}>
          Find a Home That<br/><em>Fits Your Life</em>
        </h1>
        <p className="lux-tagline lux-anim" style={{animationDelay:".44s"}}>
          From first-home condos to spacious family houses — browse every new launch across Penang Island and Seberang Perai, matched to your lifestyle and budget.
        </p>
        <div className="lux-ctas lux-anim" style={{animationDelay:".58s"}}>
          <button className="lux-btn-pri" onClick={onExplore}>Browse All Projects</button>
          <button className="lux-btn-sec" onClick={onContact}>Talk to an Agent</button>
        </div>
        <div className="lux-hero-search lux-anim" style={{animationDelay:".72s"}}>
          <input
            className="lux-hero-search-inp"
            placeholder="Search by project name, area, or developer…"
            value={search}
            onChange={e => onSearch(e.target.value)}
          />
          <span className="lux-hero-search-ico"><ISearch/></span>
        </div>
      </div>
      <div className="lux-stats-bar">
        {stats.map((s, i) => (
          <div key={s.label} className="lux-stat lux-anim" style={{animationDelay:`${.9 + i * 0.1}s`}}>
            <div className="lux-stat-num">{s.num}</div>
            <div className="lux-stat-lbl">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function WhyChooseUs() {
  const ref = useRef(null);
  const isInView = useScrollInView(ref, { once: true, margin: "-80px" });
  const features = [
    { icon: "�", title: "All Property Types", desc: "Condos, terraces, semidees, shophouses and more — every budget, every lifestyle." },
    { icon: "📊", title: "Clear Market Info", desc: "Honest pricing, up-to-date specs and real developer data in one place." },
    { icon: "🤝", title: "Personalised Guidance", desc: "Our agents listen first — then match you with the right project for your needs." },
    { icon: "✅", title: "Verified Projects Only", desc: "Every listing is checked and updated so you can enquire with confidence." },
  ];
  return (
    <section className="wcu-sec" ref={ref}>
      <div className="wcu-inner">
        <div className={`wcu-img-wrap lux-reveal lux-reveal-left${isInView ? " lux-revealed" : ""}`}>
          <img
            className="wcu-img"
            src="https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=900&q=80"
            alt="Modern Home Interior"
          />
          <div className="wcu-img-frame"/>
          <div className="wcu-img-badge">
            <div className="wcu-img-badge-num">15+</div>
            <div className="wcu-img-badge-lbl">Years in Penang</div>
          </div>
        </div>
        <div className={`lux-reveal lux-reveal-right${isInView ? " lux-revealed" : ""}`} style={{transitionDelay:".18s"}}>
          <div className="wcu-eyebrow">Why Choose NB Property</div>
          <h2 className="wcu-title">Built Around<br/><em>Your Lifestyle</em></h2>
          <p className="wcu-desc">Whether you're a first-time buyer, growing family or seasoned investor, we have projects across every price range in Penang. We don't push one type — we find what works for you.</p>
          <div className="wcu-features">
            {features.map((f, i) => (
              <div
                key={f.title}
                className={`wcu-feat lux-reveal lux-reveal-up${isInView ? " lux-revealed" : ""}`}
                style={{transitionDelay:`${.38 + i * 0.1}s`}}
              >
                <div className="wcu-feat-icon">{f.icon}</div>
                <div className="wcu-feat-title">{f.title}</div>
                <div className="wcu-feat-desc">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ShowcaseBanner({ onExplore }) {
  const ref = useRef(null);
  const isInView = useScrollInView(ref, { once: true, margin: "-50px" });
  return (
    <section className="showcase-sec" ref={ref}>
      <div className="showcase-bg"/>
      <div className="showcase-ov"/>
      <div className={`showcase-content lux-reveal lux-reveal-left${isInView ? " lux-revealed" : ""}`}>
        <div className="showcase-eyebrow">Every Budget. Every Lifestyle.</div>
        <h2 className="showcase-title">Your Home<br/><em>Is Out There</em></h2>
        <p className="showcase-sub">Starter condos, family terraces, investment units or upgraded semidees — whatever stage of life you're in, we'll help you find the right fit in Penang.</p>
        <button className="lux-btn-pri" onClick={onExplore}>View All Projects</button>
      </div>
    </section>
  );
}

function LuxuryFooter({ onTab, onRI }) {
  return (
    <footer className="lux-ft">
      <div className="lux-ft-inner">
        <div>
          <div className="lux-ft-logo">NB<span>Property</span></div>
          <div className="lux-ft-tagline">Penang's most complete new launch platform — for every budget, every lifestyle, every stage of life.</div>
        </div>
        <div>
          <div className="lux-ft-col-title">Navigation</div>
          <div className="lux-ft-links">
            <button className="lux-ft-link" onClick={() => onTab("listings")}>Home</button>
            <button className="lux-ft-link" onClick={() => onTab("properties")}>Properties</button>
            <button className="lux-ft-link" onClick={() => onTab("compare")}>Compare Projects</button>
            <button className="lux-ft-link" onClick={() => onTab("tools")}>Loan Calculator</button>
          </div>
        </div>
        <div>
          <div className="lux-ft-col-title">Contact Us</div>
          <div className="lux-ft-links">
            <button className="lux-ft-link" onClick={() => onRI && onRI()}>Register Interest</button>
            <span className="lux-ft-link" style={{cursor:"default"}}>Penang, Malaysia</span>
            <span className="lux-ft-link" style={{cursor:"default"}}>WhatsApp Available</span>
          </div>
        </div>
      </div>
      <div className="lux-ft-divider"/>
      <div className="lux-ft-bottom">
        <div className="lux-ft-copy">© 2025 <span>NB Property</span> · All rights reserved</div>
        <div className="lux-ft-copy">Penang Island &amp; Seberang Perai, Malaysia</div>
      </div>
    </footer>
  );
}

/* ═══ TOUR GUIDE COMPONENT ═══ */
// mkStep — helper so onEnter callbacks are always functions
const mkStep = (target, title, desc, onEnter) => ({ target, title, desc, onEnter });

// TOUR_STEPS — each step may have an onEnter({isMobile, openNav, closeNav, goTab}) callback
// Desktop: highlights the top nav tabs. Mobile: opens the drawer and highlights the drawer items.
const TOUR_STEPS = [
  mkStep(
    () => document.querySelector('.nav-logo'),
    'Welcome to NB Property',
    'Your complete guide to premium new launches in Penang. Browse, compare, and calculate — all in one place.',
    ({ closeNav }) => closeNav(),
  ),
  mkStep(
    ({ isMobile }) => isMobile
      ? document.querySelectorAll('.mob-nav-item')[0]
      : document.querySelectorAll('.ntab')[0],
    'Home',
    'Showcases hero projects, live stats, and curated highlights — your starting point every visit.',
    ({ isMobile, openNav, closeNav, goTab }) => { goTab('listings'); if (isMobile) openNav(); else closeNav(); },
  ),
  mkStep(
    ({ isMobile }) => isMobile
      ? document.querySelectorAll('.mob-nav-item')[1]
      : document.querySelectorAll('.ntab')[1],
    'Browse Properties',
    'Explore hundreds of verified new launch projects. Filter by type, location, price, bedrooms, and completion year.',
    ({ isMobile, openNav, closeNav, goTab }) => { goTab('properties'); if (isMobile) openNav(); else closeNav(); },
  ),
  mkStep(
    ({ isMobile }) => isMobile
      ? document.querySelectorAll('.mob-nav-item')[2]
      : document.querySelectorAll('.ntab')[2],
    'Compare Projects',
    'Add up to 5 projects and compare specs, pricing, size and facilities side by side — instantly.',
    ({ isMobile, openNav, closeNav }) => { if (isMobile) openNav(); else closeNav(); },
  ),
  mkStep(
    ({ isMobile }) => isMobile
      ? document.querySelectorAll('.mob-nav-item')[3]
      : document.querySelectorAll('.ntab')[3],
    'Loan Calculator',
    'Calculate true monthly costs — discounts, rebates, legal fees, stamp duty and MOT for local and foreign buyers.',
    ({ isMobile, openNav, closeNav }) => { if (isMobile) openNav(); else closeNav(); },
  ),
  mkStep(
    () => document.querySelector('.fd-trigger'),
    'Smart Filters',
    'Tap Filters to narrow results instantly by property type, area, status, bedrooms, size, and developer.',
    ({ closeNav, goTab }) => { goTab('properties'); closeNav(); },
  ),
  mkStep(
    () => {
      // Pick the first proj-card that is actually visible in the viewport (or any first one)
      const cards = Array.from(document.querySelectorAll('.proj-card'));
      return cards.find(c => c.getBoundingClientRect().width > 0) || null;
    },
    'Project Cards',
    'Tap any card for the full detail page — gallery, floor plans, facilities, location map and pricing.',
    ({ closeNav, goTab }) => { goTab('properties'); closeNav(); },
  ),
  mkStep(
    () => document.querySelector('.nav-theme'),
    'Light & Dark Mode',
    'Switch themes anytime. Your preference is saved and remembered across every visit.',
    ({ closeNav }) => closeNav(),
  ),
];

function TourGuide({ steps, onDone, openNav, closeNav, goTab }) {
  const PAD = 12, TW = 296, TH = 200, GAP = 16, EDGE = 10;
  const [step,   setStep]   = useState(0);
  const [spot,   setSpot]   = useState({ x:0, y:0, w:0, h:0, ok:false });
  const [side,   setSide]   = useState('bottom');
  const [aKey,   setAKey]   = useState(0);
  const [ripples,setRipples]= useState([]);
  const [mob,    setMob]    = useState(() => window.innerWidth < 768);
  const txRef = useRef(0), tyRef = useRef(0);

  const isMobile = () => window.innerWidth < 768;

  const measure = useCallback(() => {
    const s = steps[step];
    const el = typeof s.target === 'function' ? s.target({ isMobile: isMobile() }) : document.querySelector(s.target);
    if (!el) { setSpot(v => ({ ...v, ok: false })); return; }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { setSpot(v => ({ ...v, ok: false })); return; }
    const vw = window.innerWidth, vh = window.innerHeight;
    setSpot({ x: r.left, y: r.top, w: r.width, h: r.height, ok: true });
    const spB = vh - r.bottom - PAD, spT = r.top - PAD;
    const spR = vw - r.right - PAD,  spL = r.left - PAD;
    if      (spB >= TH + GAP) setSide('bottom');
    else if (spT >= TH + GAP) setSide('top');
    else if (spR >= TW + GAP) setSide('right');
    else if (spL >= TW + GAP) setSide('left');
    else                       setSide('bottom');
  }, [step, steps]);

  useEffect(() => {
    const s = steps[step];
    // Fire the step's onEnter hook (opens/closes drawer, switches tab, etc.)
    if (typeof s.onEnter === 'function') {
      s.onEnter({ isMobile: isMobile(), openNav, closeNav, goTab });
    }
    // Allow layout to settle before measuring; retry up to 4 times if element not yet in DOM
    const t1 = setTimeout(() => {
      const el = typeof s.target === 'function' ? s.target({ isMobile: isMobile() }) : document.querySelector(s.target);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }, 80);
    let attempts = 0;
    const tryMeasure = () => {
      const el = typeof s.target === 'function' ? s.target({ isMobile: isMobile() }) : document.querySelector(s.target);
      if (el && el.getBoundingClientRect().width > 0) { measure(); return; }
      if (++attempts < 4) setTimeout(tryMeasure, 220);
      else measure(); // fall through → spot.ok=false → centered display
    };
    const t2 = setTimeout(tryMeasure, 380);
    setAKey(k => k + 1);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [step]);

  useEffect(() => {
    const h = () => { setMob(window.innerWidth < 768); measure(); };
    window.addEventListener('resize', h);
    window.addEventListener('scroll', h, true);
    return () => { window.removeEventListener('resize', h); window.removeEventListener('scroll', h, true); };
  }, [measure]);

  // Close drawer when tour finishes / is skipped
  const handleDone = () => { closeNav(); onDone(); };

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape')                              handleDone();
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') go(1);
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  const ripple = () => {
    if (!spot.ok) return;
    const id = Date.now(), cx = spot.x + spot.w / 2, cy = spot.y + spot.h / 2;
    setRipples(r => [...r, { id, cx, cy }]);
    setTimeout(() => setRipples(r => r.filter(x => x.id !== id)), 680);
  };

  const go = dir => {
    ripple();
    if (dir > 0) { if (step < steps.length - 1) setStep(s => s + 1); else handleDone(); }
    else         { if (step > 0)                setStep(s => s - 1); }
  };

  const tipPos = () => {
    if (!spot.ok) return { top: '50%', left: '50%', transform: 'translate(-50%,-50%)' };
    const vw = window.innerWidth, vh = window.innerHeight;
    const cx = spot.x + spot.w / 2;
    switch (side) {
      case 'bottom': return { left: Math.max(EDGE, Math.min(cx - TW/2, vw - TW - EDGE)), top: spot.y + spot.h + PAD + GAP };
      case 'top':    return { left: Math.max(EDGE, Math.min(cx - TW/2, vw - TW - EDGE)), top: Math.max(EDGE, spot.y - PAD - GAP - TH) };
      case 'right':  return { left: spot.x + spot.w + PAD + GAP, top: Math.max(EDGE, Math.min(spot.y + spot.h/2 - TH/2, vh - TH - EDGE)) };
      case 'left':   return { right: vw - (spot.x - PAD - GAP), top: Math.max(EDGE, Math.min(spot.y + spot.h/2 - TH/2, vh - TH - EDGE)) };
      default:       return {};
    }
  };

  const arrowH = () => {
    if (!spot.ok || (side !== 'bottom' && side !== 'top')) return {};
    const vw = window.innerWidth;
    const cx  = spot.x + spot.w / 2;
    const tl  = Math.max(EDGE, Math.min(cx - TW/2, vw - TW - EDGE));
    return { left: Math.max(18, Math.min(cx - tl - 7, TW - 32)) };
  };

  const total = steps.length, pct = ((step + 1) / total) * 100;
  const s = steps[step], isLast = step === total - 1;
  const sx = spot.x - PAD, sy = spot.y - PAD, sw = spot.w + PAD*2, sh = spot.h + PAD*2;
  /* SVG geometry CSS transitions — supported Chrome88+, FF89+, Safari15.4+ */
  const geomT = 'x .4s cubic-bezier(.22,1,.36,1),y .4s cubic-bezier(.22,1,.36,1),width .4s cubic-bezier(.22,1,.36,1),height .4s cubic-bezier(.22,1,.36,1),opacity .28s';

  const Tip = () => (
    <>
      <div className="tg-tip-bar"/>
      {side === 'bottom' && <div className="tg-arrow from-top"  style={arrowH()}/>}
      {side === 'top'    && <div className="tg-arrow from-bottom" style={arrowH()}/>}
      {side === 'right'  && <div className="tg-arrow from-right"/>}
      {side === 'left'   && <div className="tg-arrow from-left"/>}
      <div className="tg-tip-hd">
        <span className="tg-badge">{step + 1} / {total}</span>
        <span className="tg-title">{s.title}</span>
      </div>
      <div className="tg-body">{s.desc}</div>
      <div className="tg-prog"><div className="tg-prog-fill" style={{ width: `${pct}%` }}/></div>
      <div className="tg-ft">
        <button className="tg-skip" onClick={handleDone}>Skip tour</button>
        <div className="tg-btns">
          {step > 0 && <button className="tg-btn-bk" onClick={() => go(-1)}>← Back</button>}
          <button className="tg-btn-nx" onClick={() => go(1)}>{isLast ? 'Finish ✦' : 'Next →'}</button>
        </div>
      </div>
    </>
  );

  return (
    <div
      className="tg-ov"
      role="dialog" aria-modal="true" aria-label="Application tour"
      onTouchStart={e => { txRef.current = e.touches[0].clientX; tyRef.current = e.touches[0].clientY; }}
      onTouchEnd={e => {
        const dx = txRef.current - e.changedTouches[0].clientX;
        const dy = tyRef.current - e.changedTouches[0].clientY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 48) go(dx > 0 ? 1 : -1);
      }}
    >
      {/* ── SVG spotlight overlay ── */}
      <svg
        key={`svg-${aKey}`}
        style={{ position:'fixed', inset:0, width:'100%', height:'100%', zIndex:9001, pointerEvents:'none', animation:'tgSpotFadeIn .3s ease both' }}
        aria-hidden="true"
      >
        <defs>
          <mask id="tg-mask">
            <rect width="100%" height="100%" fill="white"/>
            <rect fill="black" style={{ x:sx, y:sy, width:sw, height:sh, rx:14, opacity: spot.ok ? 1 : 0, transition: geomT }}/>
          </mask>
        </defs>
        {/* Dim layer */}
        <rect width="100%" height="100%" fill="rgba(2,3,10,.82)" mask="url(#tg-mask)"/>
        {/* Glow ring */}
        <rect fill="none" stroke="rgba(191,155,78,.75)" strokeWidth="1.5"
          style={{ x:sx, y:sy, width:sw, height:sh, rx:14, opacity: spot.ok ? 1 : 0, transition: geomT, filter:'drop-shadow(0 0 7px rgba(191,155,78,.55))' }}/>
        {/* Outer soft ring */}
        <rect fill="none" stroke="rgba(191,155,78,.18)" strokeWidth="1"
          style={{ x:sx-6, y:sy-6, width:sw+12, height:sh+12, rx:20, opacity: spot.ok ? 1 : 0, transition: geomT }}/>
      </svg>

      {/* ── Ripple effects ── */}
      {ripples.map(r => (
        <div key={r.id} className="tg-ripple" style={{ left:r.cx-36, top:r.cy-36, width:72, height:72, zIndex:9002, position:'fixed', pointerEvents:'none' }}/>
      ))}

      {/* ── Desktop tooltip ── */}
      <div
        className="tg-tip"
        key={`tip-${aKey}`}
        style={{ ...tipPos(), position:'fixed', pointerEvents:'all' }}
        role="status" aria-live="polite"
      >
        <Tip/>
      </div>

      {/* ── Mobile bottom sheet ── */}
      <div
        className="tg-sheet"
        key={`sheet-${aKey}`}
        role="status" aria-live="polite"
      >
        <div className="tg-drag"/>
        <div className="tg-sheet-hd">
          <span className="tg-badge">{step + 1} / {total}</span>
          <span className="tg-sheet-title">{s.title}</span>
        </div>
        <p className="tg-sheet-body">{s.desc}</p>
        <div className="tg-prog" style={{ margin:'0 0 .75rem' }}>
          <div className="tg-prog-fill" style={{ width:`${pct}%` }}/>
        </div>
        <div className="tg-sheet-ft">
          <button className="tg-skip" onClick={handleDone}>Skip</button>
          <div className="tg-dots">{steps.map((_,i) => <div key={i} className={`tg-dot${i===step?' on':''}`}/>)}</div>
          <div className="tg-btns">
            {step > 0 && <button className="tg-btn-bk" onClick={() => go(-1)}>←</button>}
            <button className="tg-btn-nx" onClick={() => go(1)}>{isLast ? 'Finish ✦' : 'Next →'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App(){
  const [projects,setProjects]=useState([]);
  const [settings,setSettings]=useState(DEFAULT_SETTINGS);
  const [ready,setReady]=useState(false);
  const [showGuide,setShowGuide]=useState(()=>!localStorage.getItem("nb_guide_done"));
  const dismissGuide=()=>{localStorage.setItem("nb_guide_done","1");setShowGuide(false);};
  useEffect(()=>{(async()=>{
    try{
      const docs = await getAllProjects();
      if (Array.isArray(docs) && docs.length>0) setProjects(docs);
      else setProjects(DEFAULT_PROJECTS);
    }catch(err){
      console.error('Failed to load projects from Firestore', err);
      setProjects(DEFAULT_PROJECTS);
    }
    try{ const s = await fsGetSettings(); if(s) setSettings({...DEFAULT_SETTINGS,...s}); }catch{}

    // Migrate any existing analytics stored in browser localStorage into Firestore (one-time)
    try{
      if (!window.__analytics_migrated) {
        const raw = localStorage.getItem(ANALYTICS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (Array.isArray(arr) && arr.length>0) {
          try{ await migrateAnalytics(arr); window.__analytics_migrated = true; console.log('Analytics migrated to Firestore'); }catch(e){ console.error('Analytics migration failed', e); }
        } else {
          window.__analytics_migrated = true;
        }
      }
    }catch(e){console.error('Analytics migration check failed', e);}

    setReady(true);
  })();},[]);

  const saveProjects=useCallback(async updated=>{
    setProjects(updated);
    try{
      // Fetch existing docs to detect deletions
      const existing = await getAllProjects();
      const existingIds = new Set(existing.map(d=>String(d.id)));
      const updatedIds = new Set(updated.map(p=>String(p.id)));

      // Upsert all provided projects
      for(const p of updated){
        try{ await setProjectById(String(p.id), p); }catch(e){ console.error('Upsert failed', e); }
      }

      // Remove any docs that are no longer present
      for(const doc of existing){
        if (!updatedIds.has(String(doc.id))){
          try{ await deleteProjectById(String(doc.id)); }catch(e){ console.error('Delete failed', e); }
        }
      }
    }catch(e){ console.error('Firestore sync failed', e); }
  },[]);
  const saveSettings=useCallback(async updated=>{setSettings(updated);try{await fsSaveSettings(updated);}catch{}},[]);

  const [tab,setTab]=useState(()=>{
    // Secret URL access: ?admin or #admin opens admin tab on load
    const hash=window.location.hash;
    const search=window.location.search;
    if(hash==="#admin"||search.includes("admin"))return"admin";
    return"listings";
  });
  const goTab=(t)=>{setTab(t);window.scrollTo({top:0,behavior:'instant'});};
  const [adminTab,setAdminTab]=useState("projects");
  const [adminSubOpen,setAdminSubOpen]=useState(false);
  // Secret logo tap: 5 clicks within 3 seconds
  const logoTapRef=useRef({count:0,timer:null});
  const handleLogoTap=()=>{
    const s=logoTapRef.current;
    s.count++;
    if(s.timer)clearTimeout(s.timer);
    if(s.count>=5){s.count=0;goTab("admin");return;}
    s.timer=setTimeout(()=>{s.count=0;},3000);
    if(tab!=="admin"&&tab!=="detail")goTab("listings");
  };
  const [darkMode,setDarkMode]=useState(()=>localStorage.getItem("nb_theme")!=null?localStorage.getItem("nb_theme")==="dark":true);
  const [themeAnim,setThemeAnim]=useState(false);
  useEffect(()=>{
    document.body.classList.toggle("dark",darkMode);
    localStorage.setItem("nb_theme",darkMode?"dark":"light");
  },[darkMode]);
  const toggleTheme=()=>{
    setThemeAnim(true);
    setDarkMode(v=>!v);
    setTimeout(()=>setThemeAnim(false),500);
  };
  const [search,setSearch]=useState("");
  const [type,setType]=useState("All Types");
  const [loc,setLoc]=useState("All Areas");
  const [stat,setStat]=useState("All Status");
  const [priceMin,setPriceMin]=useState(PRICE_SLIDER_MIN);
  const [priceMax,setPriceMax]=useState(PRICE_SLIDER_MAX);
  const [fBed,setFBed]=useState("All Beds");
  const [fBath,setFBath]=useState("All Baths");
  const [fTenure,setFTenure]=useState("All Tenure");
  const [fCompletion,setFCompletion]=useState("All Completion");
  const [fSizeMin,setFSizeMin]=useState("");
  const [fSizeMax,setFSizeMax]=useState("");
  const [showMoreFilters,setShowMoreFilters]=useState(false);
  const [filterOpen,setFilterOpen]=useState(false);
  const clearAllFilters=useCallback(()=>{setSearch("");setType("All Types");setLoc("All Areas");setStat("All Status");setPriceMin(PRICE_SLIDER_MIN);setPriceMax(PRICE_SLIDER_MAX);setFBed("All Beds");setFBath("All Baths");setFTenure("All Tenure");setFCompletion("All Completion");setFSizeMin("");setFSizeMax("");},[]);
  const [selected,setSelected]=useState(null);
  const [cmpIds,setCmpIds]=useState([]);
  const [pdfBusy,setPdfBusy]=useState(false);
  const [pdfFxBurst,setPdfFxBurst]=useState(0);
  const [pdfFxActive,setPdfFxActive]=useState(false);
  const [adminAuthed,setAdminAuthed]=useState(false);
  useEffect(()=>{ const unsub=onAuthStateChanged(auth,user=>setAdminAuthed(!!user)); return unsub; },[]);
  const [riProject,setRiProject]=useState(null);  // project for Register Interest modal
  const openRI = useCallback((proj=null) => setRiProject(proj||"general"), []);
  const closeRI = useCallback(()=>setRiProject(null),[]);
  const [vsProject,setVsProject]=useState(null);  // project for Visit Showroom modal
  const openVS = useCallback((proj=null) => setVsProject(proj||"general"), []);
  const closeVS = useCallback(()=>setVsProject(null),[]);
  const [mobileNavOpen,setMobileNavOpen]=useState(false);

  // Track page view whenever the listings tab is shown
  useEffect(()=>{ if(tab==="listings"||tab==="properties") trackEvent("page_view"); },[tab]);

  const handleExportPdf = async () => {
    if (pdfBusy || cmpProjects.length < 2) return;
    setPdfFxBurst(v=>v+1);
    setPdfFxActive(false);
    requestAnimationFrame(()=>setPdfFxActive(true));
    setTimeout(()=>setPdfFxActive(false),1000);
    setPdfBusy(true);
    try {
      await exportPDF(cmpProjects);
    } catch {
      alert("PDF failed.");
    } finally {
      setPdfBusy(false);
    }
  };

  const LOCS  = useMemo(()=>["All Areas",...new Set(projects.map(p=>p.location))],[projects]);
  const TYPES = useMemo(()=>["All Types",...new Set(projects.map(p=>p.type))],[projects]);
  const STATS = useMemo(()=>["All Status",...new Set(projects.map(p=>p.status))],[projects]);
  const BEDS  = useMemo(()=>{const s=new Set();projects.forEach(p=>(p.bedrooms||[]).forEach(b=>s.add(b)));return ["All Beds",...[...s].sort((a,b)=>a-b).map(String)];},[projects]);
  const BATHS = useMemo(()=>{const s=new Set();projects.forEach(p=>(p.bathrooms||[]).forEach(b=>s.add(b)));return ["All Baths",...[...s].sort((a,b)=>a-b).map(String)];},[projects]);
  const TENURE_OPTS = ["All Tenure","Freehold","Leasehold"];
  const COMPLETION_OPTS = useMemo(()=>{const s=new Set();projects.forEach(p=>{if(p.completion)s.add(p.completion);});return ["All Completion",...[...s].sort()];},[projects]);

  const filtered=useMemo(()=>{return projects.filter(p=>{if(p.visible===false)return false;if(type!=="All Types"&&p.type!==type)return false;if(loc!=="All Areas"&&p.location!==loc)return false;if(stat!=="All Status"&&p.status!==stat)return false;if(p.priceFrom>priceMax||p.priceTo<priceMin)return false;if(fBed!=="All Beds"&&!(p.bedrooms||[]).includes(Number(fBed)))return false;if(fBath!=="All Baths"&&!(p.bathrooms||[]).includes(Number(fBath)))return false;if(fTenure!=="All Tenure"&&p.tenure!==fTenure)return false;if(fCompletion!=="All Completion"&&p.completion!==fCompletion)return false;if(fSizeMin){const mn=Number(fSizeMin);if(!isNaN(mn)&&mn>0&&(p.sizeSqft?.[1]||0)<mn)return false;}if(fSizeMax){const mx=Number(fSizeMax);if(!isNaN(mx)&&mx>0&&(p.sizeSqft?.[0]||0)>mx)return false;}if(search){const q=search.toLowerCase();if(!p.name.toLowerCase().includes(q)&&!p.location.toLowerCase().includes(q)&&!p.developer.toLowerCase().includes(q)&&!p.type.toLowerCase().includes(q))return false;}return true;});},[projects,search,type,loc,stat,priceMin,priceMax,fBed,fBath,fTenure,fCompletion,fSizeMin,fSizeMax]);
  // Desktop-only pagination: show 3 columns x 3 rows = 9 items per page on desktop
  const [isDesktop,setIsDesktop]=useState(typeof window!=='undefined'?window.innerWidth>=992:true);
  useEffect(()=>{
    const h=()=>setIsDesktop(window.innerWidth>=992);
    h();window.addEventListener('resize',h);
    return ()=>window.removeEventListener('resize',h);
  },[]);
  const [listPage,setListPage]=useState(()=>{
    // Restore the page the user was on when they open a detail and come back
    const saved=sessionStorage.getItem("listingPage");
    return saved?Number(saved):1;
  });
  useEffect(()=>setListPage(1),[filtered,isDesktop]);
  const itemsPerPage = isDesktop?9:filtered.length||9999;
  const totalPages = isDesktop?Math.max(1,Math.ceil(filtered.length/itemsPerPage)):1;

  // ── Scroll-position restore when returning to listings ─────────────────────
  useEffect(()=>{
    if(tab!=="properties")return;
    const savedY=sessionStorage.getItem("listingScrollY");
    const savedPage=sessionStorage.getItem("listingPage");
    if(!savedY&&!savedPage)return;
    // Restore page first (state update), then scroll on next paint
    if(savedPage)setListPage(Number(savedPage));
    const target=parseInt(savedY||"0",10);
    // Use rAF to let React flush the DOM before scrolling
    const raf=requestAnimationFrame(()=>{
      window.scrollTo({top:target,behavior:"instant"});
    });
    // Clean up so normal filter resets still work
    sessionStorage.removeItem("listingScrollY");
    sessionStorage.removeItem("listingPage");
    return ()=>cancelAnimationFrame(raf);
  },[tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const visibleProjects = isDesktop?filtered.slice((listPage-1)*itemsPerPage,listPage*itemsPerPage):filtered;
  const cmpProjects=useMemo(()=>projects.filter(p=>cmpIds.includes(p.id)&&p.visible!==false),[projects,cmpIds]);

  // ── Back-to-top FAB for mobile listing ────────────────────────────────────
  const [showBackTop, setShowBackTop] = useState(false);
  useEffect(()=>{
    if(tab!=="properties"){setShowBackTop(false);return;}
    const onScroll=()=>setShowBackTop(window.scrollY>320);
    window.addEventListener('scroll',onScroll,{passive:true});
    return ()=>window.removeEventListener('scroll',onScroll);
  },[tab]);

  const toggleCmp=useCallback((e,id)=>{e.stopPropagation();setCmpIds(prev=>prev.includes(id)?prev.filter(x=>x!==id):prev.length>=5?prev:[...prev,id]);},[]);
  const cheapest=cmpProjects.length?cmpProjects.reduce((a,b)=>a.priceFrom<b.priceFrom?a:b).id:null;
  const largest =cmpProjects.length?cmpProjects.reduce((a,b)=>a.sizeSqft[1]>b.sizeSqft[1]?a:b).id:null;

  if(!ready) return (<><style>{css}</style><style>{`
    @keyframes nb-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
    @keyframes nb-pulse{0%,100%{opacity:.25;transform:scale(.88)}50%{opacity:1;transform:scale(1)}}
    @keyframes nb-fade-up{0%{opacity:0;transform:translateY(18px)}100%{opacity:1;transform:translateY(0)}}
    @keyframes nb-shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
    @keyframes nb-orbit{0%{transform:rotate(0deg) translateX(28px) rotate(0deg)}100%{transform:rotate(360deg) translateX(28px) rotate(-360deg)}}
    @keyframes nb-orbit2{0%{transform:rotate(180deg) translateX(20px) rotate(-180deg)}100%{transform:rotate(540deg) translateX(20px) rotate(-540deg)}}
    .nb-loader-screen{min-height:100vh;background:radial-gradient(ellipse at 60% 30%,#1a1628 0%,#0D0D18 60%,#060610 100%);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'DM Sans',system-ui,sans-serif;position:relative;overflow:hidden;}
    .nb-loader-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(191,155,78,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(191,155,78,.04) 1px,transparent 1px);background-size:48px 48px;pointer-events:none;}
    .nb-loader-glow1{position:absolute;width:520px;height:520px;border-radius:50%;background:radial-gradient(circle,rgba(191,155,78,.13) 0%,transparent 70%);top:-120px;right:-80px;pointer-events:none;}
    .nb-loader-glow2{position:absolute;width:380px;height:380px;border-radius:50%;background:radial-gradient(circle,rgba(191,155,78,.09) 0%,transparent 70%);bottom:-100px;left:-60px;pointer-events:none;}
    .nb-loader-orbit-wrap{position:relative;width:90px;height:90px;display:flex;align-items:center;justify-content:center;margin-bottom:2.2rem;}
    .nb-loader-ring{position:absolute;inset:0;border-radius:50%;border:1.5px solid rgba(191,155,78,.18);box-sizing:border-box;}
    .nb-loader-ring-spin{position:absolute;inset:0;border-radius:50%;border:2px solid transparent;border-top-color:#BF9B4E;border-right-color:rgba(191,155,78,.35);box-sizing:border-box;animation:nb-spin 1.2s cubic-bezier(.6,.1,.4,.9) infinite;}
    .nb-loader-ring2{position:absolute;inset:10px;border-radius:50%;border:1.5px solid transparent;border-bottom-color:#D4B880;border-left-color:rgba(212,184,128,.3);box-sizing:border-box;animation:nb-spin 1.9s cubic-bezier(.6,.1,.4,.9) infinite reverse;}
    .nb-loader-dot{position:absolute;width:7px;height:7px;border-radius:50%;background:#BF9B4E;box-shadow:0 0 10px rgba(191,155,78,.8);animation:nb-orbit 1.2s linear infinite;}
    .nb-loader-dot2{position:absolute;width:5px;height:5px;border-radius:50%;background:#D4B880;box-shadow:0 0 8px rgba(212,184,128,.7);animation:nb-orbit2 1.9s linear infinite;}
    .nb-loader-icon{width:30px;height:30px;display:flex;align-items:center;justify-content:center;}
    .nb-loader-logo{font-family:'Cormorant Garamond',Georgia,serif;font-size:2.1rem;font-weight:600;color:#BF9B4E;letter-spacing:.06em;animation:nb-fade-up .7s ease both;}
    .nb-loader-logo span{color:#FAF8F3;font-weight:400;}
    .nb-loader-tagline{font-size:.72rem;letter-spacing:.22em;text-transform:uppercase;color:rgba(212,184,128,.55);margin-top:.35rem;animation:nb-fade-up .7s .15s ease both;}
    .nb-loader-bar-wrap{width:180px;height:2px;background:rgba(255,255,255,.07);border-radius:2px;margin-top:2.4rem;overflow:hidden;animation:nb-fade-up .7s .3s ease both;}
    .nb-loader-bar{height:100%;width:45%;border-radius:2px;background:linear-gradient(90deg,transparent,#BF9B4E,#D4B880,transparent);background-size:400px 100%;animation:nb-shimmer 1.4s linear infinite;}
    .nb-loader-dots{display:flex;gap:.45rem;margin-top:1.2rem;animation:nb-fade-up .7s .45s ease both;}
    .nb-loader-dots span{width:5px;height:5px;border-radius:50%;background:#BF9B4E;animation:nb-pulse 1.2s ease-in-out infinite;}
    .nb-loader-dots span:nth-child(2){animation-delay:.2s;}
    .nb-loader-dots span:nth-child(3){animation-delay:.4s;}
    .nb-loader-msg{font-size:.73rem;color:rgba(212,184,128,.45);letter-spacing:.1em;margin-top:.9rem;animation:nb-fade-up .7s .55s ease both;}
  `}</style>
  <div className="nb-loader-screen">
    <div className="nb-loader-grid"/>
    <div className="nb-loader-glow1"/>
    <div className="nb-loader-glow2"/>
    <div className="nb-loader-orbit-wrap">
      <div className="nb-loader-ring"/>
      <div className="nb-loader-ring-spin"/>
      <div className="nb-loader-ring2"/>
      <div className="nb-loader-dot"/>
      <div className="nb-loader-dot2"/>
      <div className="nb-loader-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M3 22V10L12 3l9 7v12H3z" stroke="#BF9B4E" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M9 22v-6h6v6" stroke="#BF9B4E" strokeWidth="1.5" strokeLinejoin="round"/>
        </svg>
      </div>
    </div>
    <div className="nb-loader-logo">NB<span>Property</span></div>
    <div className="nb-loader-tagline">Luxury Real Estate</div>
    <div className="nb-loader-bar-wrap"><div className="nb-loader-bar"/></div>
    <div className="nb-loader-dots"><span/><span/><span/></div>
    <div className="nb-loader-msg">Loading your experience…</div>
  </div>
</>);

  return (
    <>
      <style>{css}</style>
      <CustomCursor/>
      {showGuide&&<TourGuide steps={TOUR_STEPS} onDone={dismissGuide} openNav={()=>setMobileNavOpen(true)} closeNav={()=>setMobileNavOpen(false)} goTab={goTab}/>}

      {/* ── Mobile side-nav overlay — hidden on detail page ── */}
      {tab!=="detail"&&<div className={`mob-drawer-ov${mobileNavOpen?" open":""}`} onClick={()=>setMobileNavOpen(false)}/>}

      {/* ── Mobile side-nav drawer — hidden on detail page ── */}
      {tab!=="detail"&&<div className={`mob-drawer${mobileNavOpen?" open":""}`}>
        <div className="mob-drawer-hd">
          <div className="mob-drawer-logo" onClick={()=>{handleLogoTap();setMobileNavOpen(false);}}>NB<span>Property</span></div>
          <button className="mob-drawer-x" onClick={()=>setMobileNavOpen(false)}>✕</button>
        </div>
        <div className="mob-drawer-nav">
          <button className={`mob-nav-item${tab==="listings"?" on":""}`} onClick={()=>{goTab("listings");setAdminSubOpen(false);setMobileNavOpen(false);}}>🏠 Home</button>
          <button className={`mob-nav-item${tab==="properties"?" on":""}`} onClick={()=>{goTab("properties");setAdminSubOpen(false);setMobileNavOpen(false);}}>🏘️ Properties</button>
          <button className={`mob-nav-item${tab==="compare"?" on":""}`} onClick={()=>{goTab("compare");setAdminSubOpen(false);setMobileNavOpen(false);}}>⚖️ Compare{cmpIds.length>0&&<span className="mob-badge" style={{marginLeft:".5rem"}}>{cmpIds.length}</span>}</button>
          <button className={`mob-nav-item${tab==="tools"?" on":""}`} onClick={()=>{goTab("tools");setAdminSubOpen(false);setMobileNavOpen(false);}}>🧮 Tools</button>
          {tab==="admin"&&adminAuthed&&(
            <div className={`mob-admin-sub${adminSubOpen?" open":""}`}>
              <button className={`mob-admin-sub-item${adminTab==="analytics"?" on":""}`} onClick={()=>{setAdminTab("analytics");setMobileNavOpen(false);}}>📊 Analytics</button>
              <button className={`mob-admin-sub-item${adminTab==="dashboard"?" on":""}`} onClick={()=>{setAdminTab("dashboard");setMobileNavOpen(false);}}>📋 Dashboard</button>
              <button className={`mob-admin-sub-item${adminTab==="projects"?" on":""}`} onClick={()=>{setAdminTab("projects");setMobileNavOpen(false);}}>📁 Projects</button>
              <button className={`mob-admin-sub-item${adminTab==="crm"?" on":""}`} onClick={()=>{setAdminTab("crm");setMobileNavOpen(false);}}>👥 Leads CRM</button>
              <button className={`mob-admin-sub-item${adminTab==="settings"?" on":""}`} onClick={()=>{setAdminTab("settings");setMobileNavOpen(false);}}>⚙️ Settings</button>
            </div>
          )}
        </div>
      </div>}

      {/* ── Top navigation — hidden on detail page ── */}
      <nav className="nav" style={tab==="detail"?{display:"none"}:undefined}>
        <div className="nav-logo" onClick={handleLogoTap}>NB<span>Property</span></div>
        {/* Desktop tabs (centered) */}
        <div className="nav-tabs">
          <button className={`ntab${tab==="listings"?" on":""}`} onClick={()=>goTab("listings")}><span>Home</span></button>
          <button className={`ntab${tab==="properties"?" on":""}`} onClick={()=>goTab("properties")}><span>Properties</span></button>
          <button className={`ntab${tab==="compare"?" on":""}`} onClick={()=>goTab("compare")}><span>Compare</span>{cmpIds.length>0&&<span className="badge">{cmpIds.length}</span>}</button>
          <button className={`ntab${tab==="tools"?" on":""}`} onClick={()=>goTab("tools")}><span>Tools</span></button>
        </div>

        {/* Right-side controls: admin icon + mobile hamburger */}
        <div className="nav-right">
          <button className={`nav-theme${themeAnim?" anim":""}`} onClick={toggleTheme} aria-label="Toggle theme">
            <span className={`nav-theme-ico sun${darkMode?" hide":""}`}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#FFE08A" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="4"/>
                <line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/>
                <line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/>
                <line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>
                <line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/>
              </svg>
            </span>
            <span className={`nav-theme-ico moon${!darkMode?" hide":""}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D4B880" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            </span>
          </button>
          <button className={`nav-hamburger${mobileNavOpen?" open":""}`} onClick={()=>setMobileNavOpen(v=>!v)} aria-label="Menu">
            <span/><span/><span/>
          </button>
        </div>
      </nav>

      {tab==="admin"&&(adminAuthed
        ? <AdminPanel projects={projects} onSave={saveProjects} settings={settings} onSaveSettings={saveSettings} onLogout={()=>signOut(auth)} aTab={adminTab} setATab={setAdminTab}/>
        : <AdminLogin/>
      )}

      {tab==="tools"&&<LoanCalculator settings={settings}/>}
      {tab!=="admin" && tab==="tools" && <LuxuryFooter onTab={setTab} onRI={openRI}/>}

      {tab==="listings"&&<>
        <LuxuryHero
          search={search}
          onSearch={(v)=>{ setSearch(v); if(v) setTab("properties"); }}
          onExplore={()=>setTab("properties")}
          onContact={()=>openRI()}
        />
        <WhyChooseUs/>
        <ShowcaseBanner onExplore={()=>setTab("properties")}/>
        <LuxuryFooter onTab={setTab} onRI={openRI}/>
      </>}

      {tab==="properties"&&<>
        <div className="sec-label">
          <div className="sec-label-eye">All Project Types</div>
          <h2 className="sec-label-title">Browse <em>Listings</em></h2>
          <p className="sec-label-sub">From affordable starter homes to spacious family properties — find your perfect match across Penang</p>
        </div>
        <main className="main" id="listings-main">
          {/* ── Filter bar ── */}
          {(()=>{
            const activePills=[];
            if(type!=="All Types") activePills.push({label:`Type: ${type}`,clear:()=>setType("All Types")});
            if(loc!=="All Areas") activePills.push({label:`Area: ${loc}`,clear:()=>setLoc("All Areas")});
            if(stat!=="All Status") activePills.push({label:`Status: ${stat}`,clear:()=>setStat("All Status")});
            if(fBed!=="All Beds") activePills.push({label:`${fBed} Bed`,clear:()=>setFBed("All Beds")});
            if(fBath!=="All Baths") activePills.push({label:`${fBath} Bath`,clear:()=>setFBath("All Baths")});
            if(fTenure!=="All Tenure") activePills.push({label:fTenure,clear:()=>setFTenure("All Tenure")});
            if(fCompletion!=="All Completion") activePills.push({label:fCompletion,clear:()=>setFCompletion("All Completion")});
            if(priceMin>PRICE_SLIDER_MIN||priceMax<PRICE_SLIDER_MAX) activePills.push({label:"Custom Price",clear:()=>{setPriceMin(PRICE_SLIDER_MIN);setPriceMax(PRICE_SLIDER_MAX);}});
            if(fSizeMin||fSizeMax) activePills.push({label:"Size Range",clear:()=>{setFSizeMin("");setFSizeMax("");}});
            return(
              <div className="fd-bar">
                <button className="fd-trigger" onClick={()=>setFilterOpen(true)}>
                  <svg viewBox="0 0 24 24"><line x1="4" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="11" y1="18" x2="13" y2="18"/></svg>
                  Filters
                  {activePills.length>0&&<span className="fd-badge">{activePills.length}</span>}
                </button>
                <div className="fd-pills">
                  {activePills.map(pill=>(
                    <span key={pill.label} className="fd-pill">
                      {pill.label}
                      <button className="fd-pill-x" onClick={pill.clear}>×</button>
                    </span>
                  ))}
                </div>
                <div className="fd-rcnt"><strong>{filtered.length}</strong> project{filtered.length!==1?"s":""}</div>
              </div>
            );
          })()}

          {/* ── Filter dialog ── */}
          {filterOpen&&(
            <>
              <div className="fd-ov" onClick={()=>setFilterOpen(false)}/>
              <div className="fd-sheet">
                <div className="fd-handle"/>
                <div className="fd-hd">
                  <span className="fd-hd-title">Filter Projects</span>
                  {(()=>{const n=[type!=="All Types",loc!=="All Areas",stat!=="All Status",fBed!=="All Beds",fBath!=="All Baths",fTenure!=="All Tenure",fCompletion!=="All Completion",priceMin>PRICE_SLIDER_MIN||priceMax<PRICE_SLIDER_MAX,!!fSizeMin||!!fSizeMax].filter(Boolean).length;return n>0&&<span className="fd-hd-cnt">{n} active</span>;})()}
                  <button className="fd-close" onClick={()=>setFilterOpen(false)}>✕</button>
                </div>
                {/* Desktop: sidebar + body side by side */}
                <div className="fd-sheet-inner">
                  <div className="fd-sidebar">
                    <div>
                      <div className="fd-sidebar-title">Active Filters</div>
                      <div className="fd-sidebar-cnt">{filtered.length} result{filtered.length!==1?"s":""}</div>
                    </div>
                    <div className="fd-sidebar-filters">
                      {(()=>{
                        const items=[];
                        if(type!=="All Types") items.push({l:`Type: ${type}`,rm:()=>setType("All Types")});
                        if(loc!=="All Areas") items.push({l:`Area: ${loc}`,rm:()=>setLoc("All Areas")});
                        if(stat!=="All Status") items.push({l:`Status: ${stat}`,rm:()=>setStat("All Status")});
                        if(fBed!=="All Beds") items.push({l:`${fBed} Bed`,rm:()=>setFBed("All Beds")});
                        if(fBath!=="All Baths") items.push({l:`${fBath} Bath`,rm:()=>setFBath("All Baths")});
                        if(fTenure!=="All Tenure") items.push({l:fTenure,rm:()=>setFTenure("All Tenure")});
                        if(fCompletion!=="All Completion") items.push({l:fCompletion,rm:()=>setFCompletion("All Completion")});
                        if(priceMin>PRICE_SLIDER_MIN||priceMax<PRICE_SLIDER_MAX) items.push({l:"Custom Price",rm:()=>{setPriceMin(PRICE_SLIDER_MIN);setPriceMax(PRICE_SLIDER_MAX);}});
                        if(fSizeMin||fSizeMax) items.push({l:"Size Range",rm:()=>{setFSizeMin("");setFSizeMax("");}});
                        return items.length===0
                          ? <div className="fd-sidebar-empty">No filters applied</div>
                          : items.map(it=>(
                            <div key={it.l} className="fd-sidebar-item">
                              <span className="fd-sidebar-lbl">{it.l}</span>
                              <button className="fd-sidebar-rm" onClick={it.rm}>×</button>
                            </div>
                          ));
                      })()}
                    </div>
                  </div>
                  <div className="fd-body">
                    <div className="fd-sec">
                      <div className="fd-sec-label">Property Type</div>
                      <div className="fd-chips">{TYPES.map(t=><button key={t} className={`fd-chip${type===t?" on":""}`} onClick={()=>setType(t)}>{t}</button>)}</div>
                    </div>
                    <div className="fd-sec">
                      <div className="fd-sec-label">Location / Area</div>
                      <div className="fd-chips">{LOCS.map(l=><button key={l} className={`fd-chip${loc===l?" on":""}`} onClick={()=>setLoc(l)}>{l}</button>)}</div>
                    </div>
                    <div className="fd-sec">
                      <div className="fd-sec-label">Status</div>
                      <div className="fd-chips">{STATS.map(s=><button key={s} className={`fd-chip${stat===s?" on":""}`} onClick={()=>setStat(s)}>{s}</button>)}</div>
                    </div>
                    <div className="fd-sec">
                      <div className="fd-sec-label">Bedrooms</div>
                      <div className="fd-chips">{BEDS.map(b=><button key={b} className={`fd-chip${fBed===b?" on":""}`} onClick={()=>setFBed(b)}>{b}</button>)}</div>
                    </div>
                    <div className="fd-sec">
                      <div className="fd-sec-label">Bathrooms</div>
                      <div className="fd-chips">{BATHS.map(b=><button key={b} className={`fd-chip${fBath===b?" on":""}`} onClick={()=>setFBath(b)}>{b}</button>)}</div>
                    </div>
                    <div className="fd-sec">
                      <div className="fd-sec-label">Tenure</div>
                      <div className="fd-chips">{TENURE_OPTS.map(t=><button key={t} className={`fd-chip${fTenure===t?" on":""}`} onClick={()=>setFTenure(t)}>{t}</button>)}</div>
                    </div>
                    <div className="fd-sec">
                      <div className="fd-sec-label">Completion</div>
                      <div className="fd-chips">{COMPLETION_OPTS.map(c=><button key={c} className={`fd-chip${fCompletion===c?" on":""}`} onClick={()=>setFCompletion(c)}>{c}</button>)}</div>
                    </div>
                    <div className="fd-sec fd-sec-price">
                      <div className="fd-sec-label">Price Range</div>
                      <PriceRangeSlider minVal={priceMin} maxVal={priceMax} onChange={(mn,mx)=>{setPriceMin(mn);setPriceMax(mx);}}/>
                    </div>
                    <div className="fd-sec fd-sec-price">
                      <div className="fd-sec-label">Built-up Size (sqft)</div>
                      <div className="fd-size-row">
                        <input className="fd-size-inp" type="number" placeholder="Min sqft" value={fSizeMin} onChange={e=>setFSizeMin(e.target.value)} min="0"/>
                        <span className="fd-size-sep">–</span>
                        <input className="fd-size-inp" type="number" placeholder="Max sqft" value={fSizeMax} onChange={e=>setFSizeMax(e.target.value)} min="0"/>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="fd-ft">
                  <button className="fd-ft-clear" onClick={clearAllFilters}>Clear All</button>
                  <button className="fd-ft-apply" onClick={()=>setFilterOpen(false)}>Show {filtered.length} Result{filtered.length!==1?"s":""} →</button>
                </div>
              </div>
            </>
          )}

          <div className="grid">
            {filtered.length===0 ? <div className="empty"><div className="empty-ico">🔍</div><div className="empty-h">No projects found</div><p className="empty-s">Try adjusting filters.</p></div>
            : visibleProjects.map((p, idx) => (
              <div
                key={p.id}
                className={`card card-anim${cmpIds.includes(p.id)?" sel":""}`}
                style={{animationDelay:`${Math.min(idx, 11) * 0.07}s`}}
                onClick={()=>{
                  sessionStorage.setItem("listingScrollY",String(window.scrollY));
                  sessionStorage.setItem("listingPage",String(listPage));
                  trackEvent("project_click",{projectName:p.name});
                  setSelected(p);
                  setTab("detail");
                }}
              >
                <div className="cimg"><img src={p.image} alt={p.name} onError={e=>{e.target.onerror=null;e.target.src=FALLBACK_IMG;}}/><div className="ctag" style={{background:p.tagColor}}>{p.tag}</div><div className="cstat">{p.status}</div><button className={`cbtn${cmpIds.includes(p.id)?" on":""}`} onClick={e=>toggleCmp(e,p.id)} title="Compare">{cmpIds.includes(p.id)?"✓":"+"}</button></div>
                <div className="cbody">
                  <div className="ctype">{p.type}</div><div className="cname">{p.name}</div><div className="cdev">by {p.developer}</div>
                  <div className="cloc"><IPin/> {p.location}</div>
                  <div className="cdiv"/>
                  <div className="crow">
                    <div><div className="cplbl">From</div><div className="cprice">{fmt(p.priceFrom)}</div></div>
                    <div className="cmeta"><span><IBed/>{bLbl(p.bedrooms)} bed</span><span><IArea/>{p.sizeSqft?.[0]?.toLocaleString()}+ sf</span></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {isDesktop && totalPages>1 && (
            <div className="list-pager">
              <button onClick={()=>setListPage(p=>Math.max(1,p-1))} disabled={listPage===1}>Prev</button>
              <div className="page-info">Page {listPage} of {totalPages}</div>
              <button onClick={()=>setListPage(p=>Math.min(totalPages,p+1))} disabled={listPage===totalPages}>Next</button>
            </div>
          )}
        </main>
        <LuxuryFooter onTab={setTab} onRI={openRI}/>
        {/* Back-to-top FAB — mobile only */}
        <button className={`btt-fab${showBackTop?' visible':' hidden'}`} onClick={()=>window.scrollTo({top:0,behavior:'smooth'})} aria-label="Back to top">
          <svg viewBox="0 0 24 24"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <div className={`tray${cmpIds.length>0?" show":""}`}>
          <span className="tray-lbl">Compare ({cmpIds.length}/5)</span>
          <div className="tray-slots">{[...Array(5)].map((_,i)=>{const p=cmpProjects[i];return p?(<div key={i} className="tslot fill"><img src={p.image} alt="" onError={e=>{e.target.onerror=null;e.target.src=FALLBACK_IMG;}}/><div className="tslot-nm">{p.name}</div><button className="tslot-x" onClick={()=>setCmpIds(prev=>prev.filter(x=>x!==p.id))}>✕</button></div>):<div key={i} className="tslot">empty</div>;})}</div>
          {cmpIds.length>=2&&<button className="tray-go" onClick={()=>setTab("compare")}>Compare →</button>}
          <button className="tray-clr" onClick={()=>setCmpIds([])}>Clear</button>
        </div>
      </>}

      {tab==="compare"&&(
        <div className="cmp-pg">
          {pdfFxActive && (
            <div key={pdfFxBurst} className="cmp-pdf-fx on" aria-hidden="true">
              <span className="cmp-pdf-fx-core"/>
              <span className="cmp-pdf-fx-ring r1"/>
              <span className="cmp-pdf-fx-ring r2"/>
              <span className="cmp-pdf-fx-ring r3"/>
              <span className="cmp-pdf-fx-beam b1"/>
              <span className="cmp-pdf-fx-beam b2"/>
              <span className="cmp-pdf-fx-beam b3"/>
              <span className="cmp-pdf-fx-beam b4"/>
              <span className="cmp-pdf-fx-beam b5"/>
              <span className="cmp-pdf-fx-dot d1"/>
              <span className="cmp-pdf-fx-dot d2"/>
              <span className="cmp-pdf-fx-dot d3"/>
              <span className="cmp-pdf-fx-dot d4"/>
              <span className="cmp-pdf-fx-dot d5"/>
              <span className="cmp-pdf-fx-dot d6"/>
            </div>
          )}
          <div className="cmp-hd">
            <div><h2 className="cmp-title">Project <em>Comparison</em></h2><p className="cmp-sub">{cmpProjects.length===0?"Select up to 5 projects.":`Comparing ${cmpProjects.length} project${cmpProjects.length>1?"s":""}.`}</p></div>
            {cmpProjects.length>=2&&(
              <div className="pdf-btn-wrap">
                <button className={`pdf-btn${pdfBusy?" busy":""}`} onClick={handleExportPdf} disabled={pdfBusy}>
                  <span className="pdf-btn-ico"><IPDF/></span>
                  <span className="pdf-btn-txt">{pdfBusy?"Generating…":"Export PDF"}</span>
                  <span className="pdf-btn-spark"/>
                </button>
              </div>
            )}
          </div>
          {cmpProjects.length===0?(<div className="cmp-nil"><div className="cmp-nil-ico">⚖️</div><div className="cmp-nil-h">No projects selected</div><p className="cmp-nil-s">Click + on any listing card.</p><button className="go-btn" onClick={()=>setTab("properties")}>Browse Properties</button></div>):(
            <>
              <div className="ctbl-wrap">
                <table className="ctbl">
                  <thead><tr>
                    <td className="lbl-col"><div className="sec-hd" style={{color:"#fff",fontSize:".72rem",letterSpacing:".04em",textTransform:"none"}}>Project</div></td>
                    {cmpProjects.map(p=>(<td key={p.id} className="proj-col" style={{padding:"0 .5rem .5rem",verticalAlign:"top",borderRight:"1px solid var(--border)"}}><div className="proj-card"><img className="proj-img" src={p.image} alt={p.name} onError={e=>{e.target.onerror=null;e.target.src=FALLBACK_IMG;}}/><div className="proj-info"><div className="proj-type">{p.type}</div><div className="proj-nm">{p.name}</div><div className="proj-dv">by {p.developer}</div></div><button className="proj-rm" onClick={()=>setCmpIds(prev=>prev.filter(x=>x!==p.id))}>✕</button></div></td>))}
                  </tr></thead>
                  <tbody>{(()=>{
                    const vs=p=>(p.visibleSections||{});
                    const sec=(p,k)=>vs(p)[k]!==false;
                    const cv=(p,secKey,val)=>{if(!sec(p,secKey))return"—";if(val===null||val===undefined||val==="")return"—";return val;};
                    const cvArr=(p,secKey,arr)=>{if(!sec(p,secKey))return null;const a=Array.isArray(arr)?arr:[];return a.length?a:null;};
                    const Sec=({l})=>(<tr><td><div className="sec-hd">{l}</div></td>{cmpProjects.map(p=><td key={p.id}><div className="val-cell sec"/></td>)}</tr>);
                    const Row=({l,r,bid})=>(<tr><td><div className="lbl-cell">{l}</div></td>{cmpProjects.map(p=><td key={p.id}><div className={`val-cell${bid===p.id?" best-cell":""}`}>{r(p)}{bid===p.id&&<span className="best-tag">BEST</span>}</div></td>)}</tr>);
                    return(<>
                      <Sec l="OVERVIEW"/>
                      <Row l="Developer" r={p=>cv(p,"overview.basicInfo",p.developer)}/>
                      <Row l="Location" r={p=>cv(p,"overview.basicInfo",p.location)}/>
                      <Row l="Status" r={p=>cv(p,"overview.basicInfo",p.status)}/>
                      <Row l="Completion" r={p=>cv(p,"overview.basicInfo",p.completion)}/>
                      <Row l="Tenure" r={p=>cv(p,"overview.basicInfo",p.tenure)}/>
                      <Row l="Land Size" r={p=>cv(p,"overview.basicInfo",p.landSize)}/>
                      <Row l="Total Units" r={p=>{const v=cv(p,"overview.unitInfo",p.totalUnits);return v==="—"?"—":`${formatNum(v)} units`;}}/>
                      <Sec l="PRICING"/>
                      <Row l="Starting From" r={p=>{if(!sec(p,"overview.financial"))return"—";return p.priceFrom?<strong style={{fontFamily:"var(--serif)",fontSize:"1rem"}}>{fmt(p.priceFrom)}</strong>:"—";}} bid={cheapest}/>
                      <Row l="Price Range" r={p=>{if(!sec(p,"overview.financial"))return"—";return p.priceFrom&&p.priceTo?`${fmt(p.priceFrom)} – ${fmt(p.priceTo)}`:"—";}}/>
                      <Row l="Maintenance" r={p=>cv(p,"overview.financial",p.maintenanceFee)}/>
                      <Sec l="UNIT SPECS"/>
                      <Row l="Bedrooms" r={p=>{if(!sec(p,"overview.unitInfo"))return"—";const b=p.bedrooms;return Array.isArray(b)&&b.length?bLbl(b)+" bed":"—";}}/>
                      <Row l="Bathrooms" r={p=>{if(!sec(p,"overview.unitInfo"))return"—";const b=p.bathrooms;return Array.isArray(b)&&b.length?bLbl(b)+" bath":"—";}}/>
                      <Row l="Built-up" r={p=>{if(!sec(p,"overview.unitInfo"))return"—";const s=p.sizeSqft;return Array.isArray(s)&&s[0]&&s[1]?`${s[0].toLocaleString()} – ${s[1].toLocaleString()} sqft`:"—";}} bid={largest}/>
                      <Row l="Car Parks" r={p=>{const v=cv(p,"overview.parking",p.numberOfCarParks);return v==="—"?"—":formatNum(v);}}/>
                      <Row l="Lifts" r={p=>{const v=cv(p,"overview.facilities",p.numberOfLifts);return v==="—"?"—":formatNum(v);}}/>
                      <Row l="Layout Types" r={p=>{if(!sec(p,"overview.unitInfo"))return"—";const ut=p.unitTypes;return Array.isArray(ut)?`${ut.length} types`:"—";}}/>
                      <Sec l="HIGHLIGHTS"/>
                      <Row l="Highlights" r={p=>{const a=cvArr(p,"overview.highlights",p.highlights);return a?<div className="tw">{a.map(h=><span key={h} className="ctag2">{h}</span>)}</div>:"—";}}/>
                    </>);
                  })()}</tbody>
                </table>
              </div>
              {cmpProjects.length<5&&<div className="add-more"><p>Add {5-cmpProjects.length} more project{5-cmpProjects.length!==1?"s":""}.</p><button className="go-btn" onClick={()=>setTab("properties")}>+ Add More</button></div>}
              {cmpProjects.length>=2&&(
                <div style={{display:"flex",justifyContent:"flex-end",marginTop:"1.5rem"}}>
                  <div className="pdf-btn-wrap">
                    <button className={`pdf-btn${pdfBusy?" busy":""}`} onClick={handleExportPdf} disabled={pdfBusy}>
                      <span className="pdf-btn-ico"><IPDF/></span>
                      <span className="pdf-btn-txt">{pdfBusy?"Generating…":"Export PDF"}</span>
                      <span className="pdf-btn-spark"/>
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab!=="admin" && tab==="compare" && <LuxuryFooter onTab={setTab} onRI={openRI}/>}

      {tab==="detail"&&selected&&<DetailPage p={selected} onClose={()=>{setSelected(null);setTab("properties");}} onRegisterInterest={()=>openRI(selected)} onVisitShowroom={()=>openVS(selected)}/>}

      {/* Register Interest modal */}
      {riProject&&(
        <RegisterInterestModal
          project={riProject==="general"?null:riProject}
          settings={settings}
          onClose={closeRI}
        />
      )}

      {/* Visit Showroom modal */}
      {vsProject&&(
        <VisitShowroomModal
          project={vsProject==="general"?null:vsProject}
          settings={settings}
          onClose={closeVS}
        />
      )}
    </>
  );
}

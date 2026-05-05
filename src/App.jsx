import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { getAllProjects, setProjectById, deleteProjectById, addAnalytic, migrateAnalytics, deleteAllAnalytics } from "./firebase/firestore";
import COUNTRY_CODES from "./data/countryCodes";
// Firebase SDK — reuses the app already initialised by ./firebase/firestore
import { getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, orderBy, serverTimestamp, getDoc, getDocs } from "firebase/firestore";
import { getApp } from "firebase/app";

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
  const body=[sec("PROJECT OVERVIEW"),row("Developer",p=>p.developer),row("Location",p=>p.location),row("Type",p=>p.type),row("Status",p=>p.status),row("Completion",p=>p.completion),row("Tenure",p=>p.tenure),row("Land Size",p=>p.landSize||"-"),row("Total Units",p=>`${p.totalUnits}`),sec("PRICING"),row("From",p=>fmt(p.priceFrom),cheap),row("Range",p=>`${fmt(p.priceFrom)} - ${fmt(p.priceTo)}`),row("Maintenance",p=>p.maintenanceFee||"-"),sec("UNIT SPECS"),row("Bedrooms",p=>bLbl(p.bedrooms)+" bed"),row("Built-up",p=>`${p.sizeSqft[0]?.toLocaleString()} - ${p.sizeSqft[1]?.toLocaleString()} sf`,big),row("Car Parks",p=>p.numberOfCarParks||"-"),row("Lifts",p=>p.numberOfLifts||"-"),sec("HIGHLIGHTS"),row("Highlights",p=>p.highlights.join(" · "))];
  doc.autoTable({startY:38,head,body,margin:{left:14,right:14},styles:{fontSize:8,cellPadding:3.5,overflow:"linebreak",lineColor:[220,212,200],lineWidth:0.18},headStyles:{fillColor:[10,30,48]},columnStyles:{0:{cellWidth:lW},...Object.fromEntries(projects.map((_,i)=>[i+1,{cellWidth:vW}]))},rowPageBreak:"auto"});
  const pages=doc.getNumberOfPages();for(let i=1;i<=pages;i++){doc.setPage(i);doc.setFillColor(10,30,48);doc.rect(0,H-10,W,10,"F");doc.setFontSize(7);doc.setTextColor(90,90,90);doc.text("NB Property · For illustration purposes only.",14,H-3.5);doc.text(`${i} / ${pages}`,W-14,H-3.5,{align:"right"});}
  doc.save(`NB_Comparison_${Date.now()}.pdf`);
}

/* ═══ FORM HELPERS ═══ */
const EMPTY_UNIT_TYPE = { label:"", name:"", beds:2, baths:2, size:"", priceFrom:"", image:"", desc:"" };
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
function p2f(p){ return { ...EMPTY_FORM, name:p.name??"",developer:p.developer??"",location:p.location??"",type:p.type??"Condominium",status:p.status??"New Launch",completion:p.completion??"",tenure:p.tenure??"Freehold",tag:p.tag??"",tagColor:p.tagColor??"#D4B880",priceFrom:String(p.priceFrom??""),priceTo:String(p.priceTo??""),bedrooms:arrStr(p.bedrooms),bathrooms:arrStr(p.bathrooms),sizeSqft:rStr(p.sizeSqft),totalUnits:String(p.totalUnits??""),floors:String(p.floors??""),description:p.description??"",highlights:arrStr(p.highlights),facilities:arrStr(p.facilities),image:p.image??"",gallery:arrStr(p.gallery),landSize:p.landSize??"",constructionStage:p.constructionStage??"",totalBlocks:String(p.totalBlocks??""),totalFloorsPerTower:arrStr(p.totalFloorsPerTower),residentialStartLevel:p.residentialStartLevel??"",unitsBreakdown:p.unitsBreakdown??"",unitsPerTower:p.unitsPerTower??"",carParkLevels:p.carParkLevels??"",numberOfCarParks:p.numberOfCarParks??"",parkingNotes:p.parkingNotes??"",numberOfLifts:p.numberOfLifts??"",unitTypes:JSON.stringify(Array.isArray(p.unitTypes)?p.unitTypes:[]),upgrades:p.upgrades??"",maintenanceFee:p.maintenanceFee??"",sinkingFund:p.sinkingFund??"",showroom:p.showroom??"",scaleModel:p.scaleModel??"",nearbyAmenities:typeof p.nearbyAmenities==="string"?p.nearbyAmenities:JSON.stringify(p.nearbyAmenities??[]),coordinateLat:String(p.coordinates?.lat??""),coordinateLng:String(p.coordinates?.lng??"") }; }
function f2p(f,id){ return { id, name:f.name.trim(),developer:f.developer.trim(),location:f.location.trim(),type:f.type,status:f.status,completion:f.completion.trim(),tenure:f.tenure,tag:f.tag.trim(),tagColor:f.tagColor,priceFrom:Number(f.priceFrom)||0,priceTo:Number(f.priceTo)||0,bedrooms:strArr(f.bedrooms).map(Number),bathrooms:strArr(f.bathrooms).map(Number),sizeSqft:strR(f.sizeSqft),totalUnits:Number(f.totalUnits)||0,floors:Number(f.floors)||0,description:f.description.trim(),highlights:strArr(f.highlights),facilities:strArr(f.facilities),image:f.image.trim(),gallery:strArr(f.gallery),landSize:f.landSize.trim(),constructionStage:f.constructionStage.trim(),totalBlocks:Number(f.totalBlocks)||0,totalFloorsPerTower:strArr(f.totalFloorsPerTower),residentialStartLevel:f.residentialStartLevel.trim(),unitsBreakdown:f.unitsBreakdown.trim(),unitsPerTower:f.unitsPerTower.trim(),carParkLevels:f.carParkLevels.trim(),numberOfCarParks:f.numberOfCarParks.trim(),parkingNotes:f.parkingNotes.trim(),numberOfLifts:f.numberOfLifts.trim(),unitTypes:safeJson(f.unitTypes,[]),upgrades:f.upgrades.trim(),maintenanceFee:f.maintenanceFee.trim(),sinkingFund:f.sinkingFund.trim(),showroom:f.showroom.trim(),scaleModel:f.scaleModel.trim(),nearbyAmenities:safeJson(f.nearbyAmenities,[]),coordinates:{lat:parseFloat(f.coordinateLat)||0,lng:parseFloat(f.coordinateLng)||0} }; }

/* ═══ CSS ═══ */
const css=`
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --ink:#0D0D18;--parchment:#FAF8F3;--warm:#F0ECE4;
  --gold:#BF9B4E;--gold-l:#D4B880;--muted:#8E8A84;
  --border:#E0DAD0;--card:#FFFFFF;
  --cta:#0D0D18;--cta-l:#141428;
  --r-sm:10px;--r-md:16px;--r-lg:22px;
  --serif:'Cormorant Garamond',Georgia,serif;
  --sans:'DM Sans',system-ui,sans-serif;
  --a-bg:#0D0D18;--a-surface:#141426;--a-surface2:#1C1C30;
  --a-border:#2C2A3E;--a-muted:#9090A8;--a-text:#FAF8F3;
  --a-gold:#BF9B4E;--a-red:#C4543E;--a-green:#4E9A72;--a-blue:#5E8FD0;
  --a-cta:#BF9B4E;
}
html{scroll-behavior:smooth;}
body{font-family:var(--sans);background:linear-gradient(180deg,#FAF8F3 0%,#F2EDE4 100%);color:var(--ink);}

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
.h-eye{position:relative;font-size:.72rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);margin-bottom:1.2rem;font-weight:500;}
.h-ttl{position:relative;font-family:var(--serif);font-size:clamp(2.4rem,5vw,4rem);font-weight:300;color:var(--ink);line-height:1.15;margin-bottom:1rem;}
.h-ttl em{font-style:italic;color:var(--gold);}
.h-sub{position:relative;color:var(--muted);font-size:1rem;max-width:480px;margin:0 auto 2.5rem;line-height:1.6;}
.s-wrap{position:relative;max-width:560px;margin:0 auto;}
.s-inp{width:100%;padding:1rem 3.5rem 1rem 1.5rem;background:rgba(255,255,255,.94);border:1px solid rgba(13,13,24,.12);color:var(--ink);font-family:var(--sans);font-size:.95rem;outline:none;transition:border-color .2s,box-shadow .2s;backdrop-filter:blur(10px);box-shadow:0 10px 28px rgba(13,13,24,.1);}
.s-inp::placeholder{color:#8E8A84;}
.s-inp:focus{border-color:var(--gold);}
.s-ico{position:absolute;right:1.2rem;top:50%;transform:translateY(-50%);color:var(--gold);pointer-events:none;}

.main{max-width:1280px;margin:0 auto;padding:3rem 2rem;}
/* ── Filter Panel ── */
.filter-panel{background:var(--card);border:1px solid var(--border);margin-bottom:2.5rem;}
.filter-top{display:flex;gap:.7rem;flex-wrap:wrap;align-items:center;padding:.9rem 1.2rem;border-bottom:1px solid var(--border);}
.filter-row2{display:flex;gap:.75rem;flex-wrap:wrap;align-items:flex-end;padding:.75rem 1.2rem;border-bottom:1px solid var(--border);background:var(--warm);animation:fadeIn .2s ease;}
.filter-group{display:flex;flex-direction:column;gap:.3rem;}
.filter-group .flbl{font-size:.6rem;}
.fmore-btn{background:transparent;border:1px solid var(--border);color:var(--muted);font-family:var(--sans);font-size:.72rem;padding:.4rem .8rem;cursor:pointer;transition:all .18s;white-space:nowrap;letter-spacing:.04em;}
.fmore-btn:hover{border-color:var(--gold);color:var(--gold);}
.fsize-range{display:flex;align-items:center;gap:.3rem;}
.fsize-inp{width:80px;padding:.44rem .6rem;border:1px solid var(--border);background:var(--parchment);color:var(--ink);font-family:var(--sans);font-size:.8rem;outline:none;transition:border-color .18s;}
.fsize-inp:focus{border-color:var(--gold);}
.fsize-inp::placeholder{color:var(--muted);font-size:.75rem;}
.fsize-sep{color:var(--muted);font-size:.8rem;}
.fclear-btn{background:transparent;border:1px solid var(--border);color:var(--muted);font-family:var(--sans);font-size:.68rem;padding:.42rem .75rem;cursor:pointer;letter-spacing:.06em;text-transform:uppercase;transition:all .18s;align-self:flex-end;margin-left:auto;white-space:nowrap;}
.fclear-btn:hover{border-color:var(--a-red);color:var(--a-red);}
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
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;}
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
@media(max-width:768px){
  /* Nav — show hamburger, hide desktop tabs & CTA */
  .nav{padding:0 1rem;gap:.5rem;}
  .nav-logo{font-size:1.2rem;}
  .nav-tabs{display:none;}
  .nav-admin{display:none;}
  .nav-cta{display:none;}
  .nav-hamburger{display:flex;}

  /* Hero */
  .hero{padding:3rem 1.25rem 2.5rem;}
  .h-sub{font-size:.88rem;}
  .hero-grid{background-size:48px 48px;opacity:.42;}

  /* Main / Grid — single column on mobile */
  .main{padding:2rem 1rem;}
  .grid{grid-template-columns:1fr;gap:1rem;}

  /* Filter */
  .filter-top{padding:.75rem;gap:.5rem;}
  .fsel{font-size:.78rem;padding:.42rem 1.8rem .42rem .75rem;}
  .filter-divider{display:none;}
  .filter-row2{padding:.65rem .75rem;gap:.5rem;}
  .fsize-inp{width:70px;font-size:.76rem;}
  .price-panel{padding:.85rem;}
  .ps-thumb{width:26px;height:26px;}

  /* Compare tray */
  .tray{padding:.6rem 1rem;gap:.65rem;}
  .tray-lbl{display:none;}
  .tslot{width:100px;height:44px;}

  /* Compare page */
  .cmp-pg{padding:1.5rem 1rem 5rem;}
  .cmp-title{font-size:1.7rem;}

  /* Detail page — mobile */
  .det{height:auto;max-height:none;min-height:calc(100vh - 64px);}
  .det-hero{height:30vh;max-height:220px;flex-shrink:0;}
  .det-hc{left:1rem;right:1rem;bottom:.75rem;}
  .det-title{font-size:1.35rem;}
  .det-tag-pill{margin-bottom:.3rem;}
  .det-tabs{overflow-x:auto;-webkit-overflow-scrolling:touch;flex-shrink:0;}
  .det-tab{flex:0 0 auto;padding:.85rem .8rem;font-size:.72rem;white-space:nowrap;}
  .gal-strip{display:none;}

  /* Overview tab */
  .ov-body{padding:1.4rem 1rem;overflow-y:auto;}
  .ov-desc-row{grid-template-columns:1fr;}
  .spec-grid{grid-template-columns:1fr;}
  .spec-key{min-width:115px;}

  /* Layouts tab */
  .layouts-body{padding:1.2rem 1rem;}
  .ut-card{grid-template-columns:1fr !important;}
  .ut-img-panel{min-height:180px;height:180px;width:100%;}
  .ut-info-panel{padding:1.2rem 1rem;width:100%;box-sizing:border-box;}
  .ut-header{flex-direction:column;gap:.6rem;}
  .ut-price-badge{align-self:flex-start;}
  .ut-desc{word-break:break-word;}

  /* Location tab */
  .loc-body{padding:1.2rem 1rem;}
  .map-embed{height:240px;}

  /* Price bar — mobile left-right */
  .price-bar{flex-direction:row;align-items:center;gap:.75rem;padding:1rem 1.2rem;flex-wrap:nowrap;}
  .pb-left{flex:0 0 auto;min-width:0;}
  .pb-left .pb-lbl{margin-bottom:.1rem;}
  .pb-price{font-size:1.3rem;white-space:nowrap;}
  .pb-price span{font-size:.72rem;}
  .pb-btns{display:flex;flex-direction:column;gap:.4rem;flex:1;min-width:0;}
  .pb-btn1,.pb-btn2{width:100%;text-align:center;padding:.65rem .5rem;font-size:.72rem;min-height:44px;display:flex;align-items:center;justify-content:center;}

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
  .nav{padding:0 .75rem;}

  /* Hero */
  .hero{padding:2.5rem 1rem 2rem;}
  .hero-line{display:none;}
  .hero-orb.o1{width:160px;height:160px;left:-50px;top:18px;}
  .hero-orb.o2{width:180px;height:180px;right:-60px;top:20px;}
  .hero-orb.o3{display:none;}

  /* Main / Grid */
  .main{padding:1.25rem .75rem;}

  /* Filter — stack vertically */
  .filter-top{flex-direction:column;align-items:stretch;}
  .fsel{width:100%;}
  .rcnt{margin-left:0;text-align:center;padding:.2rem 0;}
  .filter-row2{flex-direction:column;align-items:stretch;}
  .filter-group{width:100%;}
  .filter-group .fsel{width:100%;}
  .fsize-range{width:100%;}
  .fsize-inp{flex:1;width:auto;}
  .fmore-btn{width:100%;text-align:center;}
  .fclear-btn{margin-left:0;width:100%;text-align:center;}

  /* Card image shorter */
  .cimg{height:200px;}

  /* Compare tray */
  .tray{padding:.5rem .75rem;gap:.5rem;}
  .tslot{width:80px;height:40px;}
  .tslot-nm{font-size:.52rem;}
  .tray-go{padding:.45rem 1rem;font-size:.7rem;}
  .tray-clr{padding:.42rem .7rem;font-size:.68rem;}

  /* Compare page */
  .cmp-pg{padding:1rem .75rem 5rem;}
  .cmp-title{font-size:1.4rem;}

  /* Detail modal — full-screen */
  .ov{padding:0;}
  .det{height:100svh;max-height:100svh;border-radius:0;}
  .det-hero{height:28vh;max-height:180px;min-height:140px;}
  .det-hc{left:.85rem;right:.85rem;bottom:.6rem;}
  .det-title{font-size:1.15rem;}
  .det-dv{font-size:.72rem;}
  .det-tag-pill{font-size:.55rem;padding:.15rem .5rem;margin-bottom:.2rem;}
  .det-dev{font-size:.76rem;}
  .det-tab{padding:.8rem .65rem;font-size:.68rem;}
  .gal-strip{padding:.15rem;gap:.15rem;}
  .gal-t{height:40px;}

  /* Spec rows */
  .spec-key{min-width:100px;font-size:.7rem;}
  .spec-val{font-size:.74rem;}

  /* Unit type card */
  .ut-card{grid-template-columns:1fr !important;}
  .ut-img-panel{height:160px;min-height:160px;width:100%;}
  .ut-info-panel{padding:1rem .85rem;width:100%;box-sizing:border-box;}
  .ut-name{font-size:1.2rem;}
  .ut-price-badge{font-size:.95rem;align-self:flex-start;}
  .ut-header{flex-direction:column;gap:.5rem;}
  .ut-stats{gap:.35rem;}
  .ut-desc{word-break:break-word;font-size:.78rem;}

  /* Price bar */
  .pb-price{font-size:1.15rem;}
  .pb-price span{font-size:.65rem;}
  .price-bar{padding:.85rem .9rem;gap:.6rem;}
  .pb-btn1,.pb-btn2{padding:.6rem .4rem;font-size:.68rem;}

  /* RI / VS modals — full-screen */
  .ri-ov{padding:0;align-items:flex-end;}
  .ri-box{max-height:96svh;border-radius:0;width:100%;max-width:100%;}
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
.crm-drawer-body{flex:1;overflow-y:auto;padding:1.2rem 1.4rem;display:flex;flex-direction:column;gap:1.2rem;}
.crm-drawer-name{font-family:var(--serif);font-size:1.3rem;font-weight:600;color:#fff;flex:1;}
.crm-drawer-sec{background:var(--a-surface);border:1px solid var(--a-border);border-radius:8px;overflow:hidden;}
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
  .crm-drawer{width:100vw;}
}

.card{background:var(--card);border:1px solid var(--border);cursor:pointer;overflow:hidden;transition:transform .25s,box-shadow .25s;position:relative;}
.card:hover{transform:translateY(-4px);box-shadow:0 18px 44px rgba(0,0,0,.1);}
.card.sel{outline:2.5px solid var(--gold);}
.cimg{position:relative;height:220px;overflow:hidden;}
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

.cmp-pg{max-width:1280px;margin:0 auto;padding:2.5rem 2rem 5rem;}
.cmp-hd{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:2rem;flex-wrap:wrap;gap:1rem;}
.cmp-title{font-family:var(--serif);font-size:2.2rem;font-weight:300;}
.cmp-title em{font-style:italic;color:var(--gold);}
.cmp-sub{color:var(--muted);font-size:.84rem;margin-top:.3rem;}
.pdf-btn{display:flex;align-items:center;gap:.5rem;background:var(--ink);color:#fff;border:1px solid rgba(255,255,255,.2);padding:.6rem 1.4rem;font-family:var(--sans);font-size:.78rem;font-weight:500;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:border-color .2s;}
.pdf-btn:hover{border-color:var(--gold);}
.pdf-btn:disabled{opacity:.5;cursor:not-allowed;}
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
/* ── Register Interest Modal ── */
.ri-ov{position:fixed;inset:0;z-index:500;background:rgba(36,60,76,.75);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:1.5rem;animation:fadeIn .22s ease;}
.ri-box{background:#fff;width:100%;max-width:480px;max-height:80vh;box-shadow:0 24px 64px rgba(15,42,69,.25);animation:slideUp .28s ease;overflow:hidden;display:flex;flex-direction:column;}
.ri-hd{flex-shrink:0;background:var(--ink);padding:1.4rem 1.6rem;display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;}
.ri-hd-left{}
.ri-hd-eyebrow{font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gold-l);opacity:.8;margin-bottom:.3rem;}
.ri-hd-title{font-family:var(--serif);font-size:1.3rem;font-weight:600;color:#fff;line-height:1.2;}
.ri-hd-proj{font-size:.78rem;color:rgba(255,255,255,.55);margin-top:.25rem;}
.ri-x{background:rgba(255,255,255,.08);border:none;color:rgba(255,255,255,.6);width:30px;height:30px;cursor:pointer;font-size:.9rem;display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:2px;transition:background .15s;}
.ri-x:hover{background:rgba(255,255,255,.18);color:#fff;}
.ri-options{flex-shrink:0;display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid var(--border);}
.ri-opt-btn{padding:.85rem;font-family:var(--sans);font-size:.78rem;font-weight:600;letter-spacing:.04em;cursor:pointer;border:none;border-bottom:2px solid transparent;transition:all .18s;background:#FAF8F3;color:var(--muted);}
.ri-opt-btn.on{background:#fff;color:var(--ink);border-bottom-color:var(--gold);}
.ri-opt-btn:hover:not(.on){background:#FAF8F3;}
.ri-body{padding:1.5rem 1.6rem;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0;}
.ri-field{margin-bottom:1rem;}
.ri-label{display:block;font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600;margin-bottom:.4rem;}
.ri-inp{width:100%;padding:.65rem .9rem;border:1px solid var(--border);background:#FAF8F3;color:var(--ink);font-family:var(--sans);font-size:.88rem;outline:none;transition:border-color .18s,background .18s;}
.ri-inp:focus{border-color:var(--gold);background:#fff;}
.ri-inp::placeholder{color:#D4B880;}
.ri-submit{width:100%;background:var(--cta);color:#fff;border:none;padding:.8rem;font-family:var(--sans);font-size:.84rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:opacity .2s,background .2s;margin-top:.4rem;}
.ri-submit:hover{opacity:.9;}
.ri-submit:disabled{opacity:.5;cursor:not-allowed;}
.ri-wa-body{padding:1.5rem 1.6rem;text-align:center;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0;}
.ri-wa-icon{font-size:3rem;margin-bottom:.75rem;}
.ri-wa-title{font-family:var(--serif);font-size:1.3rem;color:var(--ink);margin-bottom:.4rem;}
.ri-wa-sub{font-size:.82rem;color:var(--muted);line-height:1.6;margin-bottom:1.4rem;}
.ri-wa-btn{display:inline-flex;align-items:center;gap:.6rem;background:#D4B880;color:#fff;border:none;padding:.85rem 2rem;font-family:var(--sans);font-size:.9rem;font-weight:700;letter-spacing:.04em;cursor:pointer;transition:opacity .2s;border-radius:3px;}
.ri-wa-btn:hover{opacity:.88;}
.ri-wa-btn svg{flex-shrink:0;}
.ri-success{padding:2rem 1.6rem;text-align:center;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0;}
.ri-success-ico{font-size:2.5rem;margin-bottom:.75rem;}
.ri-success-title{font-family:var(--serif);font-size:1.4rem;color:var(--ink);margin-bottom:.4rem;}
.ri-success-sub{font-size:.82rem;color:var(--muted);line-height:1.6;}
.ri-divider{display:flex;align-items:center;gap:.75rem;margin:.5rem 0 1rem;font-size:.72rem;color:var(--muted);}
.ri-divider::before,.ri-divider::after{content:'';flex:1;height:1px;background:var(--border);}
.ri-err{background:#FAF8F3;border:1px solid rgba(196,84,62,.3);color:#C4543E;font-size:.76rem;padding:.5rem .8rem;margin-bottom:.8rem;}

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
.a-modal-body{padding:1.8rem 2rem;overflow-y:auto;-webkit-overflow-scrolling:touch;flex:1;min-height:0;}

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

.a-form-tabs{display:flex;border-bottom:1px solid var(--a-border);margin-bottom:1.5rem;}
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
@media(max-width:480px){.map-picker-overlay{padding:0;}.map-picker-modal{max-height:100vh;border-radius:0;}.map-picker-modal-body{min-height:250px;height:45vh;}.map-picker-actions{flex-direction:column;align-items:flex-start;}}
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
.ai-zone-icon{width:30px;height:30px;background:linear-gradient(135deg,#0D0D18,#0D0D18);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0;}
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

.del-modal{background:var(--a-surface);border:1px solid var(--a-border);width:100%;max-width:420px;max-height:80vh;padding:2rem;animation:slideUp .2s ease;overflow-y:auto;}
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
.an-range-btn{background:transparent;border:1px solid var(--a-border);color:var(--a-muted);padding:.38rem .85rem;font-family:var(--sans);font-size:.72rem;cursor:pointer;transition:all .15s;}
.an-range-btn:hover{border-color:var(--a-gold);color:var(--a-gold);}
.an-range-btn.on{background:var(--a-gold);color:var(--a-bg);border-color:var(--a-gold);}
.an-clear-btn{background:transparent;border:1px solid rgba(196,84,62,.3);color:#D4B880;padding:.38rem .85rem;font-family:var(--sans);font-size:.72rem;cursor:pointer;transition:all .15s;}
.an-clear-btn:hover{background:rgba(196,84,62,.1);}
@media(max-width:768px){.an-stats{grid-template-columns:1fr 1fr;}.an-row{flex-direction:column;}}

/* (layout overrides already handled in the 768px/480px blocks above) */
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
                    onClick={()=>{setTime(t);setFormErr("");}}
                    style={{
                      padding:".55rem .4rem",
                      background: time===t ? "var(--gold)" : "rgba(0,0,0,.04)",
                      color: time===t ? "#000" : "#333",
                      border:`1px solid ${time===t?"var(--gold)":"#bbb"}`,
                      fontFamily:"var(--sans)",
                      fontSize:".72rem",
                      letterSpacing:".04em",
                      cursor:"pointer",
                      transition:"all .15s",
                      fontWeight: time===t?700:500,
                    }}
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
            <div style={{fontSize:".68rem",color:"var(--muted)",marginTop:".65rem",textAlign:"center",lineHeight:1.5}}>
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
   DETAIL MODAL
═══════════════════════════════════════ */
function DetailPage({p, onClose, onRegisterInterest, onVisitShowroom}){
  const [activeImg, setActiveImg] = useState(0);
  useEffect(()=>{ window.scrollTo(0,0); },[]);
  const vt = p.visibleTabs || {};
  const ALL_DET_TABS = [
    { k:"overview", l:"📊 Project Info",  show: vt.overview  !== false },
    { k:"location", l:"📍 Location",      show: vt.location  !== false },
    { k:"layouts",  l:"📐 Unit Layouts",  show: vt.layouts   !== false },
  ];
  const visDetTabs = ALL_DET_TABS.filter(t=>t.show);
  const [detTab, setDetTab] = useState(()=>visDetTabs[0]?.k || "overview");
  // If active tab got hidden, switch to first visible
  const activeTab = visDetTabs.find(t=>t.k===detTab) ? detTab : (visDetTabs[0]?.k || "overview");
  const allImgs = [p.image,...(p.gallery||[])];
  const amenities = Array.isArray(p.nearbyAmenities) ? p.nearbyAmenities : [];
  const unitTypes = Array.isArray(p.unitTypes) ? p.unitTypes : [];
  const mapSrc = p.coordinates?.lat
    ? `https://maps.google.com/maps?q=${p.coordinates.lat},${p.coordinates.lng}&z=15&output=embed`
    : null;
  // Section visibility helper — defaults to true when not set
  const vs = p.visibleSections || {};
  const sec = (tabKey, secKey) => vs[`${tabKey}.${secKey}`] !== false;

  const SpecSection=({icon,title,rows})=>(
    <div className="spec-section">
      <div className="spec-sec-hd"><span>{icon}</span>{title}</div>
      {rows.map(([k,v],i)=>v?(<div key={i} className="spec-row"><div className="spec-key">{k}</div><div className="spec-val">{v}</div></div>):null)}
    </div>
  );

  return (
    <div className="det-pg">
      <div className="det det-pg-inner">
        <div className="det-split">
          {/* ── LEFT: image + gallery ── */}
          <div className="det-left">
            <div className="det-hero">
              <img src={allImgs[activeImg]} alt={p.name}/>
              <div className="det-hero-ov"/>
              {/* Back button — icon overlay on image top-left */}
              <button className="det-back-btn" onClick={onClose} aria-label="Back to listings">&#8592;</button>
              <div className="det-hc">
                <div className="det-tag-pill" style={{background:p.tagColor}}>{p.tag}</div>
                <h2 className="det-title">{p.name}</h2>
                <div className="det-dv"><IPin/>{p.developer}&nbsp;·&nbsp;<IPin/>{p.location}</div>
                <div className="det-hero-meta">
                  {p.type && <span className="det-meta-chip">{p.type}</span>}
                  {p.tenure && <span className="det-meta-chip">{p.tenure}</span>}
                  {p.completion && <span className="det-meta-chip">📅 {p.completion}</span>}
                  {p.priceFrom && <span className="det-meta-chip primary">From {fmt(p.priceFrom)}</span>}
                </div>
              </div>
              {allImgs.length>1&&<>
                <button className="det-hero-nav prev" onClick={()=>setActiveImg(i=>(i-1+allImgs.length)%allImgs.length)} aria-label="Previous image">‹</button>
                <button className="det-hero-nav next" onClick={()=>setActiveImg(i=>(i+1)%allImgs.length)} aria-label="Next image">›</button>
                <div className="det-hero-dots">{allImgs.map((_,i)=><button key={i} className={`det-hero-dot${activeImg===i?" on":""}`} onClick={()=>setActiveImg(i)}/>)}</div>
              </>}
            </div>
            {allImgs.length>1&&(
              <div className="gal-strip">
                {allImgs.map((img,i)=>(
                  <div key={i} className={`gal-t${activeImg===i?" on":""}`} onClick={()=>setActiveImg(i)}>
                    <img src={img} alt=""/>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* ── RIGHT: tabs + content + sticky price bar ── */}
          <div className="det-right">
            {visDetTabs.length > 1 && (
              <div className="det-tabs">
                {visDetTabs.map(({k,l})=>(
                  <button key={k} className={`det-tab${activeTab===k?" on":""}`} onClick={()=>setDetTab(k)}>{l}</button>
                ))}
              </div>
            )}

            <div className="det-content">
        {/* ── OVERVIEW ── */}
        {activeTab==="overview"&&(
          <div>
            <div className="ov-body">
              {/* Description + Highlights row — each independently gated */}
              {(sec("overview","description")||sec("overview","highlights"))&&(
                <div className="ov-desc-row" style={{gridTemplateColumns:sec("overview","description")&&sec("overview","highlights")?"1.2fr 1fr":"1fr"}}>
                  {sec("overview","description")&&(
                    <div className="spec-section">
                      <div className="spec-sec-hd"><span>📝</span>Description</div>
                      <p className="det-desc-p">{p.description||"—"}</p>
                    </div>
                  )}
                  {sec("overview","highlights")&&(
                    <div className="spec-section">
                      <div className="spec-sec-hd"><span>✨</span>Key Highlights</div>
                      <div className="hi-list">
                        {(p.highlights||[]).map(h=><div key={h} className="hi-item"><div className="hi-dot"/>{h}</div>)}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="spec-grid">
                {sec("overview","basicInfo")&&<SpecSection icon="🏢" title="Basic Project Info" rows={[["Project Name",p.name],["Location",p.location],["Developer",p.developer],["Property Type",p.type],["Land Size",p.landSize],["Construction Stage",p.constructionStage],["Completion Date",p.completion],["Tenure",p.tenure]]}/>}
                {sec("overview","development")&&<SpecSection icon="🏗" title="Development Details" rows={[["Total Blocks",p.totalBlocks],["Floors / Levels",(p.totalFloorsPerTower||[]).join(" | ")],["Residential Start",p.residentialStartLevel],["Total Floors",`${p.floors} floors`]]}/>}
                {sec("overview","unitInfo")&&<SpecSection icon="🏠" title="Unit Information" rows={[["Total Units",`${p.totalUnits} units`],["Public / Bumi",p.unitsBreakdown],["Units per Tower",p.unitsPerTower],["Bedrooms",bLbl(p.bedrooms)+" bed"],["Bathrooms",bLbl(p.bathrooms)+" bath"],["Size Range",`${p.sizeSqft?.[0]?.toLocaleString()}–${p.sizeSqft?.[1]?.toLocaleString()} sf`]]}/>}
                {sec("overview","parking")&&<SpecSection icon="🚗" title="Parking" rows={[["Car Park Levels",p.carParkLevels],["Number of Bays",p.numberOfCarParks],["Notes",p.parkingNotes]]}/>}
                {sec("overview","facilities")&&<SpecSection icon="🛗" title="Facilities & Access" rows={[["Lifts per Tower",p.numberOfLifts],["Facilities",(p.facilities||[]).join(", ")]]}/>}
                {sec("overview","financial")&&<SpecSection icon="💰" title="Financial Info" rows={[["Price Range",`${fmt(p.priceFrom)} – ${fmt(p.priceTo)}`],["Starting Price",fmt(p.priceFrom)],["Maintenance Fee",p.maintenanceFee],["Sinking Fund",p.sinkingFund]]}/>}
                {sec("overview","sales")&&<SpecSection icon="🏢" title="Sales & Marketing" rows={[["Showroom",p.showroom],["Scale Model",p.scaleModel]]}/>}
              </div>
              {sec("overview","facList")&&(
                <div className="spec-section full" style={{marginTop:"1rem"}}>
                  <div className="spec-sec-hd"><span>🏊</span>Full Facilities List</div>
                  <div className="fac-chips">{(p.facilities||[]).map(f=><span key={f} className="fac-chip">{f}</span>)}</div>
                </div>
              )}
            </div>
            </div>
        )}

        {/* ── LOCATION ── */}
        {activeTab==="location"&&(
          <div className="loc-body">
            <div style={{display:"flex",alignItems:"center",gap:".6rem",fontSize:".82rem",color:"var(--muted)",marginBottom:"1.2rem"}}><IMapPin/><strong style={{color:"var(--ink)"}}>{p.name}</strong> — {p.location}</div>
            {sec("location","map")&&(
              <div className="map-embed">
                {mapSrc
                  ? <iframe src={mapSrc} title="Location Map" loading="lazy" referrerPolicy="no-referrer-when-downgrade" allowFullScreen/>
                  : <div className="map-placeholder"><IMapPin/><span>Map not available</span><small style={{opacity:.6}}>{p.location}</small></div>
                }
              </div>
            )}
            {sec("location","amenities")&&amenities.length>0&&(
              <>
                <div style={{fontSize:".65rem",letterSpacing:".14em",textTransform:"uppercase",color:"var(--gold)",fontWeight:700,marginBottom:"1rem"}}>Nearby Amenities</div>
                <div className="amenities-grid">
                  {amenities.map((cat,i)=>(
                    <div key={i} className="amenity-cat">
                      <div className="amenity-hd">
                        <span>{cat.category==="Education"?"🎓":cat.category==="Healthcare"?"🏥":cat.category==="Shopping & Dining"?"🛍":cat.category==="Transport"?"🚌":cat.category==="Beach & Leisure"?"🏖":cat.category==="Heritage & Tourism"?"🏛":cat.category==="Business & Industry"?"🏭":cat.category==="Dining & Nightlife"?"🍜":"📍"}</span>
                        {cat.category}
                      </div>
                      {(cat.items||[]).map((item,j)=>(
                        <div key={j} className="amenity-item"><div className="amenity-dot"/>{item}</div>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── UNIT LAYOUTS ── */}
        {activeTab==="layouts"&&(
          <div className="layouts-body">
            {sec("layouts","unitTypes")&&(
              unitTypes.length===0 ? (
                <div className="ut-empty"><span>📐</span>No unit layouts available for this project.</div>
              ) : (
                <>
                  <div className="layouts-intro">📐 Unit Types — {unitTypes.length} layout{unitTypes.length>1?"s":""} available</div>
                  {unitTypes.map((ut, i) => (
                    <div key={i} className="ut-card">
                      <div className="ut-img-panel">
                        {ut.image
                          ? <img src={ut.image} alt={ut.name||ut.label}/>
                          : <div style={{width:"100%",height:"100%",background:"var(--warm)",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--muted)",fontSize:"1.5rem"}}>📐</div>
                        }
                        <div className="ut-img-label">{ut.label||`Type ${String.fromCharCode(65+i)}`}</div>
                      </div>
                      <div className="ut-info-panel">
                        <div>
                          <div className="ut-header">
                            <div className="ut-name-group">
                              <div className="ut-label-badge">{ut.label||`Unit Type ${String.fromCharCode(65+i)}`}</div>
                              <div className="ut-name">{ut.name||"Unit Layout"}</div>
                            </div>
                            {ut.priceFrom&&<div className="ut-price-badge">{ut.priceFrom}</div>}
                          </div>
                          <div className="ut-stats" style={{marginTop:".9rem"}}>
                            {ut.beds&&<div className="ut-stat"><IBed/>{ut.beds} Bed{ut.beds>1?"":"room"}</div>}
                            {ut.baths&&<div className="ut-stat"><IBath/>{ut.baths} Bath</div>}
                            {ut.size&&<div className="ut-stat"><IArea/>{ut.size}</div>}
                          </div>
                        </div>
                        {ut.desc&&<div className="ut-desc">{ut.desc}</div>}
                      </div>
                    </div>
                  ))}
                </>
              )
            )}
            {sec("layouts","upgrades")&&p.upgrades&&(
              <div className="layouts-upgrades">
                <div className="lu-hd"><span>🔧</span>Upgrade Specifications</div>
                <div className="lu-body">{p.upgrades}</div>
              </div>
            )}
            {!sec("layouts","unitTypes")&&!sec("layouts","upgrades")&&(
              <div className="ut-empty"><span>🔒</span>Content hidden by admin settings.</div>
            )}
          </div>
        )}
            </div>
            {sec("overview","priceBar")&&(
              <div className="price-bar det-sticky-bar">
                <div className="pb-left">
                  <div className="pb-lbl">Price starting from</div>
                  <div className="pb-price">{fmt(p.priceFrom)}<span> – {fmt(p.priceTo)}</span></div>
                </div>
                <div className="pb-btns">
                  <button className="pb-btn1" onClick={onRegisterInterest}>Register Interest</button>
                  {p.showroom && p.showroom.trim().toLowerCase()!=="no" && p.showroom.trim()!=="" && (
                    <button className="pb-btn2" onClick={onVisitShowroom}>Visit Showroom</button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
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
            <div className="a-ff"><label className="a-flbl">Size (sqft)</label><input className="a-inp" value={ut.size||""} placeholder="e.g. 900 sf" onChange={e=>update(i,"size",e.target.value)}/></div>
          </div>
          <div className="a-ff" style={{marginBottom:".6rem"}}>
            <label className="a-flbl">Layout Image URL</label>
            <input className="a-inp" value={ut.image||""} placeholder="https://..." onChange={e=>update(i,"image",e.target.value)}/>
            {ut.image&&<img className="ut-img-mini" src={ut.image} alt="" onError={e=>e.target.style.display="none"} onLoad={e=>e.target.style.display="block"}/>}
          </div>
          <div className="a-ff">
            <label className="a-flbl">Description</label>
            <textarea className="a-txt" rows={2} value={ut.desc||""} placeholder="Describe this unit layout..." onChange={e=>update(i,"desc",e.target.value)}/>
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
  const ff=(label,k,ph="",type="text",hint)=>(<div className={`a-ff${highlightedFields[k]?" ai-field-flash":""}`}><label className="a-flbl">{label}{hint&&<small> — {hint}</small>}{highlightedFields[k]&&<span className="ai-autofill-badge">✨ AI</span>}</label><input className={`a-inp ${hl(k)}`} type={type} value={form[k]??""} placeholder={ph} onChange={e=>set(k,e.target.value)}/></div>);
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
  useEffect(() => {
    try { const raw = localStorage.getItem(ANALYTICS_KEY); setEvents(raw ? JSON.parse(raw) : []); }
    catch { setEvents([]); }
  }, []);
  const now = Date.now();
  const cutoff = range==="today" ? new Date(new Date().setHours(0,0,0,0)).getTime()
               : range==="7d"   ? now - 7*86400000
               : range==="30d"  ? now - 30*86400000 : 0;
  const filtered = events.filter(e => e.t >= cutoff);
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
    const evs = events.filter(e=>e.t>=s&&e.t<s+86400000);
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
  return (
    <div>
      <div style={{display:"flex",alignItems:"flex-end",justifyContent:"space-between",marginBottom:"1.5rem",flexWrap:"wrap",gap:"1rem"}}>
        <div>
          <div className="a-pg-title">Analytics <em>Dashboard</em></div>
          <div className="a-pg-sub">Track views, clicks, and inquiries from visitors.</div>
        </div>
        <div style={{display:"flex",gap:".4rem",flexWrap:"wrap",alignItems:"center"}}>
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
        <div className="an-chart-card" style={{flex:"0 0 260px"}}>
          <div className="an-card-title">Inquiry Breakdown</div>
          {(() => {
            const em=filtered.filter(e=>e.type==="inquiry_email").length;
            const wa=filtered.filter(e=>e.type==="inquiry_wa").length;
            const sr=filtered.filter(e=>e.type==="showroom_book").length;
            const tot=em+wa+sr||1;
            return (
              <div style={{display:"flex",flexDirection:"column",gap:".9rem",marginTop:"1rem"}}>
                {[["✉️ Email Enquiry",em,"#D4B880"],["💬 WhatsApp",wa,"#5E8FD0"],["🏢 Showroom",sr,"#BF9B4E"]].map(([lbl,cnt,clr])=>(
                  <div key={lbl}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:".78rem",color:"var(--a-text)",marginBottom:".3rem"}}><span>{lbl}</span><span style={{color:"var(--a-muted)"}}>{cnt}</span></div>
                    <div style={{height:4,background:"var(--a-border)",borderRadius:2}}><div style={{height:"100%",width:`${(cnt/tot)*100}%`,background:clr,borderRadius:2,transition:"width .4s"}}/></div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
        <div className="an-chart-card" style={{flex:1,minWidth:0}}>
          <div className="an-card-title">Top Projects by Engagement</div>
          {projRows.length===0
            ? <div style={{color:"var(--a-muted)",fontSize:".8rem",padding:"1.5rem 0",textAlign:"center"}}>No project activity recorded yet.</div>
            : <table style={{width:"100%",borderCollapse:"collapse",marginTop:".75rem",fontSize:".78rem"}}>
                <thead><tr style={{borderBottom:"1px solid var(--a-border)"}}>
                  {["Project","Clicks","Inquiries","Conv %"].map(h=><th key={h} style={{textAlign:h==="Project"?"left":"center",padding:".4rem .6rem",color:"var(--a-muted)",fontWeight:600,fontSize:".65rem",letterSpacing:".08em",textTransform:"uppercase"}}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {projRows.slice(0,8).map(([name,d])=>(
                    <tr key={name} style={{borderBottom:"1px solid var(--a-border)"}}>
                      <td style={{padding:".5rem .6rem",color:"var(--a-text)"}}>{name}</td>
                      <td style={{textAlign:"center",padding:".5rem .6rem",color:"var(--a-gold)"}}>{d.clicks}</td>
                      <td style={{textAlign:"center",padding:".5rem .6rem",color:"#D4B880"}}>{d.inquiries}</td>
                      <td style={{textAlign:"center",padding:".5rem .6rem",color:"var(--a-muted)"}}>{d.clicks>0?((d.inquiries/d.clicks)*100).toFixed(0):0}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
          }
        </div>
      </div>
      {events.length===0&&(
        <div style={{background:"rgba(13,13,24,.06)",border:"1px solid rgba(13,13,24,.12)",padding:"2rem",textAlign:"center",marginTop:"1rem"}}>
          <div style={{fontSize:"2rem",marginBottom:".5rem"}}>📊</div>
          <div style={{color:"var(--a-text)",fontSize:".88rem",marginBottom:".25rem"}}>No data recorded yet</div>
          <div style={{color:"var(--a-muted)",fontSize:".76rem"}}>Analytics will populate as visitors browse and interact with listings.</div>
        </div>
      )}
    </div>
  );
}

/* ═══ CRM / LEAD MANAGEMENT ═══ */
const crmScore=(lead)=>{let s=0;if(lead.email)s+=15;if(lead.phone)s+=20;if(lead.budget&&Number(lead.budget)>0)s+=20;if(lead.propertyInterest)s+=10;if(lead.assignedAgent)s+=15;if(lead.nextFollowUpDate)s+=10;if(lead.notes&&lead.notes.length>20)s+=10;const age=lead.createdAt&&lead.createdAt.toMillis?(Date.now()-lead.createdAt.toMillis())/86400000:0;if(age<3)s+=5;else if(age>14)s=Math.max(0,s-15);return Math.min(100,s);};
const crmFmtDate=(ts)=>{if(!ts)return"—";const d=ts.toDate?ts.toDate():new Date(ts);const diff=(Date.now()-d)/1000;if(diff<60)return"just now";if(diff<3600)return`${Math.floor(diff/60)}m ago`;if(diff<86400)return`${Math.floor(diff/3600)}h ago`;if(diff<604800)return`${Math.floor(diff/86400)}d ago`;return d.toLocaleDateString("en-MY",{day:"numeric",month:"short",year:"2-digit"});};
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
    setPwBusy(true);
    const ok = await verifyPassword(curPw, settings);
    if (!ok) { setPwMsg("Current password is incorrect."); setPwBusy(false); return; }
    const salt = genSalt();
    const hash = await hashPassword(newPw, salt);
    const updated = { ...sett, adminPasswordHash: hash, adminPasswordSalt: salt };
    setSett(updated);
    try { await onSaveSettings(updated); showToast("Password changed.","success"); setCurPw(""); setNewPw(""); setNewPw2(""); }
    catch { showToast("Failed to save password.","error"); }
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
                  <img className="a-card-img" src={p.image} alt={p.name}/>
                  <div className="a-card-status"><SChip s={p.status}/></div>
                  <div className={`a-card-vis-badge${p.visible===false?" hidden":""}`}>{p.visible!==false?"Live":"Hidden"}</div>
                </div>
                <div className="a-card-body">
                  <div className="a-card-name">{p.name}</div>
                  <div className="a-card-dev">{p.developer} · {p.location}</div>
                  <div className="a-card-meta">
                    <span>{p.type}</span>
                    <span className="a-card-meta-sep">·</span>
                    <span>{p.totalUnits} units</span>
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
              <div className="set-note" style={{marginTop:".6rem"}}>The password is stored securely (hashed) in settings.</div>
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
function AdminLogin({onLogin, settings}){
  const [pw,setPw]=useState("");
  const [err,setErr]=useState(false);
  const [checking,setChecking]=useState(false);
  const go=async()=>{
    setChecking(true);
    const ok = await verifyPassword(pw, settings);
    setChecking(false);
    if(ok) onLogin(); else { setErr(true); setTimeout(()=>setErr(false),2000); }
  };
  return(
    <div className="a-login">
      <div className="a-login-box">
        <div className="a-login-logo">NB<span>Property</span></div>
        <div className="a-login-sub">Admin Portal — Restricted Access</div>
        {err&&<div className="a-login-err">Incorrect password.</div>}
        <label className="a-login-lbl">Password</label>
        <input className="a-login-inp" type="password" placeholder="Enter admin password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&go()}/>
        <button className="a-login-btn" onClick={go} disabled={checking}>{checking?"Checking…":"Sign In"}</button>
      </div>
    </div>
  );
}

/* ═══ MAIN APP ═══ */
export default function App(){
  const [projects,setProjects]=useState([]);
  const [settings,setSettings]=useState(DEFAULT_SETTINGS);
  const [ready,setReady]=useState(false);
  useEffect(()=>{(async()=>{
    try{
      const docs = await getAllProjects();
      if (Array.isArray(docs) && docs.length>0) setProjects(docs);
      else setProjects(DEFAULT_PROJECTS);
    }catch(err){
      console.error('Failed to load projects from Firestore', err);
      setProjects(DEFAULT_PROJECTS);
    }
    try{const s=await window.storage.get(SETTINGS_KEY);setSettings({...DEFAULT_SETTINGS,...JSON.parse(s.value)});}catch{}

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
  const saveSettings=useCallback(async updated=>{setSettings(updated);try{await window.storage.set(SETTINGS_KEY,JSON.stringify(updated));}catch{}},[]);

  const [tab,setTab]=useState("listings");
  const [adminTab,setAdminTab]=useState("projects");
  const [adminSubOpen,setAdminSubOpen]=useState(false);
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
  const [selected,setSelected]=useState(null);
  const [cmpIds,setCmpIds]=useState([]);
  const [pdfBusy,setPdfBusy]=useState(false);
  const [adminAuthed,setAdminAuthed]=useState(false);
  const [riProject,setRiProject]=useState(null);  // project for Register Interest modal
  const openRI = useCallback((proj=null) => setRiProject(proj||"general"), []);
  const closeRI = useCallback(()=>setRiProject(null),[]);
  const [vsProject,setVsProject]=useState(null);  // project for Visit Showroom modal
  const openVS = useCallback((proj=null) => setVsProject(proj||"general"), []);
  const closeVS = useCallback(()=>setVsProject(null),[]);
  const [mobileNavOpen,setMobileNavOpen]=useState(false);

  // Track page view whenever the listings tab is shown
  useEffect(()=>{ if(tab==="listings") trackEvent("page_view"); },[tab]);

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
    if(tab!=="listings")return;
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
  const toggleCmp=useCallback((e,id)=>{e.stopPropagation();setCmpIds(prev=>prev.includes(id)?prev.filter(x=>x!==id):prev.length>=5?prev:[...prev,id]);},[]);
  const cheapest=cmpProjects.length?cmpProjects.reduce((a,b)=>a.priceFrom<b.priceFrom?a:b).id:null;
  const largest =cmpProjects.length?cmpProjects.reduce((a,b)=>a.sizeSqft[1]>b.sizeSqft[1]?a:b).id:null;

  if(!ready) return (<><style>{css}</style><div style={{minHeight:"100vh",background:"var(--ink)",display:"flex",alignItems:"center",justifyContent:"center",color:"#555",fontFamily:"var(--sans)"}}>Loading…</div></>);

  return (
    <>
      <style>{css}</style>

      {/* ── Mobile side-nav overlay — hidden on detail page ── */}
      {tab!=="detail"&&<div className={`mob-drawer-ov${mobileNavOpen?" open":""}`} onClick={()=>setMobileNavOpen(false)}/>}

      {/* ── Mobile side-nav drawer — hidden on detail page ── */}
      {tab!=="detail"&&<div className={`mob-drawer${mobileNavOpen?" open":""}`}>
        <div className="mob-drawer-hd">
          <div className="mob-drawer-logo" onClick={()=>{setTab("listings");setMobileNavOpen(false);}}>NB<span>Property</span></div>
          <button className="mob-drawer-x" onClick={()=>setMobileNavOpen(false)}>✕</button>
        </div>
        <div className="mob-drawer-nav">
          <button className={`mob-nav-item${tab==="listings"?" on":""}`} onClick={()=>{setTab("listings");setAdminSubOpen(false);setMobileNavOpen(false);}}>🏠 Listings</button>
          <button className={`mob-nav-item${tab==="compare"?" on":""}`} onClick={()=>{setTab("compare");setAdminSubOpen(false);setMobileNavOpen(false);}}>⚖️ Compare{cmpIds.length>0&&<span className="mob-badge" style={{marginLeft:".5rem"}}>{cmpIds.length}</span>}</button>
          <button className={`mob-nav-item${tab==="admin"?" on":""}`} onClick={()=>{if(tab==="admin"){setAdminSubOpen(v=>!v);}else{setTab("admin");setAdminSubOpen(true);}}}>🔒 Admin<span className={`mob-admin-chevron${adminSubOpen&&tab==="admin"?" open":""}`}>▼</span></button>
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
        <div className="nav-logo" onClick={()=>setTab("listings")}>NB<span>Property</span></div>
        {/* Desktop tabs (centered) */}
        <div className="nav-tabs">
          <button className={`ntab${tab==="listings"?" on":""}`} onClick={()=>setTab("listings")}><span>Listings</span></button>
          <button className={`ntab${tab==="compare"?" on":""}`} onClick={()=>setTab("compare")}><span>Compare</span>{cmpIds.length>0&&<span className="badge">{cmpIds.length}</span>}</button>
        </div>

        {/* Right-side controls: admin icon + mobile hamburger */}
        <div className="nav-right">
          <button className={`nav-admin${tab==="admin"?" on":""}`} onClick={()=>setTab("admin")} aria-label="Admin">
            <IPerson/>
          </button>
          <button className={`nav-hamburger${mobileNavOpen?" open":""}`} onClick={()=>setMobileNavOpen(v=>!v)} aria-label="Menu">
            <span/><span/><span/>
          </button>
        </div>
      </nav>

      {tab==="admin"&&(adminAuthed
        ? <AdminPanel projects={projects} onSave={saveProjects} settings={settings} onSaveSettings={saveSettings} onLogout={()=>setAdminAuthed(false)} aTab={adminTab} setATab={setAdminTab}/>
        : <AdminLogin settings={settings} onLogin={()=>setAdminAuthed(true)}/>
      )}

      {tab==="listings"&&<>
        <section className="hero">
          <div className="hero-art" aria-hidden="true">
            <div className="hero-grid"/>
            <div className="hero-orb o1"/>
            <div className="hero-orb o2"/>
            <div className="hero-orb o3"/>
            <div className="hero-line l1"/>
            <div className="hero-line l2"/>
          </div>
          <div className="h-eye">✦ Penang's Premier New Launches</div>
          <h1 className="h-ttl">Discover Your<br/><em>Dream Property</em></h1>
          <p className="h-sub">Explore curated new development projects across Penang Island and Seberang Perai.</p>
          <div className="s-wrap"><input className="s-inp" placeholder="Search by project name, area, or developer…" value={search} onChange={e=>setSearch(e.target.value)}/><span className="s-ico"><ISearch/></span></div>
        </section>
        <main className="main">
          <div className="filter-panel">
            {/* Row 1: primary filters */}
            <div className="filter-top">
              <span className="flbl">Filter by</span>
              <div className="filter-divider"/>
              <select className="fsel" value={type} onChange={e=>setType(e.target.value)}>{TYPES.map(t=><option key={t}>{t}</option>)}</select>
              <select className="fsel" value={loc} onChange={e=>setLoc(e.target.value)}>{LOCS.map(l=><option key={l}>{l}</option>)}</select>
              <select className="fsel" value={stat} onChange={e=>setStat(e.target.value)}>{STATS.map(s=><option key={s}>{s}</option>)}</select>
              <button className="fmore-btn" onClick={()=>setShowMoreFilters(v=>!v)}>{showMoreFilters?"▲ Less Filters":"▼ More Filters"}</button>
              <div className="rcnt">Showing <strong>{filtered.length}</strong> project{filtered.length!==1?"s":""}</div>
            </div>
            {/* Row 2: expanded filters */}
            {showMoreFilters&&(
              <div className="filter-row2">
                <div className="filter-group">
                  <span className="flbl">Bedrooms</span>
                  <select className="fsel" value={fBed} onChange={e=>setFBed(e.target.value)}>{BEDS.map(b=><option key={b}>{b}</option>)}</select>
                </div>
                <div className="filter-group">
                  <span className="flbl">Bathrooms</span>
                  <select className="fsel" value={fBath} onChange={e=>setFBath(e.target.value)}>{BATHS.map(b=><option key={b}>{b}</option>)}</select>
                </div>
                <div className="filter-group">
                  <span className="flbl">Tenure</span>
                  <select className="fsel" value={fTenure} onChange={e=>setFTenure(e.target.value)}>{TENURE_OPTS.map(t=><option key={t}>{t}</option>)}</select>
                </div>
                <div className="filter-group">
                  <span className="flbl">Completion</span>
                  <select className="fsel" value={fCompletion} onChange={e=>setFCompletion(e.target.value)}>{COMPLETION_OPTS.map(c=><option key={c}>{c}</option>)}</select>
                </div>
                <div className="filter-group">
                  <span className="flbl">Built-up (sqft)</span>
                  <div className="fsize-range">
                    <input className="fsize-inp" type="number" placeholder="Min" value={fSizeMin} onChange={e=>setFSizeMin(e.target.value)} min="0"/>
                    <span className="fsize-sep">–</span>
                    <input className="fsize-inp" type="number" placeholder="Max" value={fSizeMax} onChange={e=>setFSizeMax(e.target.value)} min="0"/>
                  </div>
                </div>
                <button className="fclear-btn" onClick={()=>{setSearch("");setType("All Types");setLoc("All Areas");setStat("All Status");setPriceMin(PRICE_SLIDER_MIN);setPriceMax(PRICE_SLIDER_MAX);setFBed("All Beds");setFBath("All Baths");setFTenure("All Tenure");setFCompletion("All Completion");setFSizeMin("");setFSizeMax("");}}>Clear Filters</button>
              </div>
            )}
            {/* Price slider — full width */}
            <PriceRangeSlider minVal={priceMin} maxVal={priceMax} onChange={(mn,mx)=>{setPriceMin(mn);setPriceMax(mx);}}/>
          </div>
          <div className="grid">
            {filtered.length===0 ? <div className="empty"><div className="empty-ico">🔍</div><div className="empty-h">No projects found</div><p className="empty-s">Try adjusting filters.</p></div>
            : visibleProjects.map(p => (
              <div key={p.id} className={`card${cmpIds.includes(p.id)?" sel":""}`} onClick={()=>{
                // Save scroll position and current page before entering detail
                sessionStorage.setItem("listingScrollY",String(window.scrollY));
                sessionStorage.setItem("listingPage",String(listPage));
                trackEvent("project_click",{projectName:p.name});
                setSelected(p);
                setTab("detail");
              }}>
                <div className="cimg"><img src={p.image} alt={p.name}/><div className="ctag" style={{background:p.tagColor}}>{p.tag}</div><div className="cstat">{p.status}</div><button className={`cbtn${cmpIds.includes(p.id)?" on":""}`} onClick={e=>toggleCmp(e,p.id)} title="Compare">{cmpIds.includes(p.id)?"✓":"+"}</button></div>
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
        <footer className="ft"><div>© 2025 <span>NB Property</span> · All rights reserved · Penang, Malaysia</div></footer>
        <div className={`tray${cmpIds.length>0?" show":""}`}>
          <span className="tray-lbl">Compare ({cmpIds.length}/5)</span>
          <div className="tray-slots">{[...Array(5)].map((_,i)=>{const p=cmpProjects[i];return p?(<div key={p.id} className="tslot fill"><img src={p.image} alt=""/><div className="tslot-nm">{p.name}</div><button className="tslot-x" onClick={()=>setCmpIds(prev=>prev.filter(x=>x!==p.id))}>✕</button></div>):<div key={i} className="tslot">empty</div>;})}</div>
          {cmpIds.length>=2&&<button className="tray-go" onClick={()=>setTab("compare")}>Compare →</button>}
          <button className="tray-clr" onClick={()=>setCmpIds([])}>Clear</button>
        </div>
      </>}

      {tab==="compare"&&(
        <div className="cmp-pg">
          <div className="cmp-hd">
            <div><h2 className="cmp-title">Project <em>Comparison</em></h2><p className="cmp-sub">{cmpProjects.length===0?"Select up to 5 projects.":`Comparing ${cmpProjects.length} project${cmpProjects.length>1?"s":""}.`}</p></div>
            {cmpProjects.length>=2&&<button className="pdf-btn" onClick={async()=>{setPdfBusy(true);try{await exportPDF(cmpProjects);}catch{alert("PDF failed.");}finally{setPdfBusy(false);}}} disabled={pdfBusy}><IPDF/>{pdfBusy?"…":"Export PDF"}</button>}
          </div>
          {cmpProjects.length===0?(<div className="cmp-nil"><div className="cmp-nil-ico">⚖️</div><div className="cmp-nil-h">No projects selected</div><p className="cmp-nil-s">Click + on any listing card.</p><button className="go-btn" onClick={()=>setTab("listings")}>Browse Listings</button></div>):(
            <>
              <div className="ctbl-wrap">
                <table className="ctbl">
                  <thead><tr>
                    <td className="lbl-col"><div className="sec-hd" style={{color:"#fff",fontSize:".72rem",letterSpacing:".04em",textTransform:"none"}}>Project</div></td>
                    {cmpProjects.map(p=>(<td key={p.id} className="proj-col" style={{padding:"0 .5rem .5rem",verticalAlign:"top",borderRight:"1px solid var(--border)"}}><div className="proj-card"><img className="proj-img" src={p.image} alt={p.name}/><div className="proj-info"><div className="proj-type">{p.type}</div><div className="proj-nm">{p.name}</div><div className="proj-dv">by {p.developer}</div></div><button className="proj-rm" onClick={()=>setCmpIds(prev=>prev.filter(x=>x!==p.id))}>✕</button></div></td>))}
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
                      <Row l="Total Units" r={p=>{const v=cv(p,"overview.unitInfo",p.totalUnits);return v==="—"?"—":`${v} units`;}}/>
                      <Sec l="PRICING"/>
                      <Row l="Starting From" r={p=>{if(!sec(p,"overview.financial"))return"—";return p.priceFrom?<strong style={{fontFamily:"var(--serif)",fontSize:"1rem"}}>{fmt(p.priceFrom)}</strong>:"—";}} bid={cheapest}/>
                      <Row l="Price Range" r={p=>{if(!sec(p,"overview.financial"))return"—";return p.priceFrom&&p.priceTo?`${fmt(p.priceFrom)} – ${fmt(p.priceTo)}`:"—";}}/>
                      <Row l="Maintenance" r={p=>cv(p,"overview.financial",p.maintenanceFee)}/>
                      <Sec l="UNIT SPECS"/>
                      <Row l="Bedrooms" r={p=>{if(!sec(p,"overview.unitInfo"))return"—";const b=p.bedrooms;return Array.isArray(b)&&b.length?bLbl(b)+" bed":"—";}}/>
                      <Row l="Bathrooms" r={p=>{if(!sec(p,"overview.unitInfo"))return"—";const b=p.bathrooms;return Array.isArray(b)&&b.length?bLbl(b)+" bath":"—";}}/>
                      <Row l="Built-up" r={p=>{if(!sec(p,"overview.unitInfo"))return"—";const s=p.sizeSqft;return Array.isArray(s)&&s[0]&&s[1]?`${s[0].toLocaleString()} – ${s[1].toLocaleString()} sf`:"—";}} bid={largest}/>
                      <Row l="Car Parks" r={p=>cv(p,"overview.parking",p.numberOfCarParks)}/>
                      <Row l="Lifts" r={p=>cv(p,"overview.facilities",p.numberOfLifts)}/>
                      <Row l="Layout Types" r={p=>{if(!sec(p,"overview.unitInfo"))return"—";const ut=p.unitTypes;return Array.isArray(ut)?`${ut.length} types`:"—";}}/>
                      <Sec l="HIGHLIGHTS"/>
                      <Row l="Highlights" r={p=>{const a=cvArr(p,"overview.highlights",p.highlights);return a?<div className="tw">{a.map(h=><span key={h} className="ctag2">{h}</span>)}</div>:"—";}}/>
                    </>);
                  })()}</tbody>
                </table>
              </div>
              {cmpProjects.length<5&&<div className="add-more"><p>Add {5-cmpProjects.length} more project{5-cmpProjects.length!==1?"s":""}.</p><button className="go-btn" onClick={()=>setTab("listings")}>+ Add More</button></div>}
              {cmpProjects.length>=2&&<div style={{display:"flex",justifyContent:"flex-end",marginTop:"1.5rem"}}><button className="pdf-btn" onClick={async()=>{setPdfBusy(true);try{await exportPDF(cmpProjects);}catch{alert("PDF failed.");}finally{setPdfBusy(false);}}} disabled={pdfBusy}><IPDF/>{pdfBusy?"…":"Export PDF"}</button></div>}
            </>
          )}
        </div>
      )}

      {tab==="detail"&&selected&&<DetailPage p={selected} onClose={()=>{setSelected(null);setTab("listings");}} onRegisterInterest={()=>openRI(selected)} onVisitShowroom={()=>openVS(selected)}/>}

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

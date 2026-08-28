// Firestore helpers for Hauszy
import { getFirestore, collection, doc, writeBatch, setDoc, addDoc, getDocs, deleteDoc, getDoc } from "firebase/firestore";
import app from "./config";

const db = getFirestore(app);

async function seedProjects(projects = []) {
  if (!Array.isArray(projects) || projects.length === 0) return { ok: false, message: "No projects provided" };
  const batch = writeBatch(db);
  projects.forEach((p) => {
    const ref = doc(collection(db, "projects"), String(p.id ?? Date.now()));
    batch.set(ref, p);
  });
  await batch.commit();
  return { ok: true, count: projects.length };
}

async function addProject(project = {}) {
  const ref = await addDoc(collection(db, "projects"), project);
  return { ok: true, id: ref.id };
}

async function setProjectById(id, project = {}) {
  await setDoc(doc(db, "projects", String(id)), project, { merge: true });
  return { ok: true, id: String(id) };
}

async function getAllProjects() {
  const snap = await getDocs(collection(db, "projects"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function addAnalytic(entry = {}){
  const ref = await addDoc(collection(db, "analytic"), entry);
  return { ok: true, id: ref.id };
}

async function getAllAnalytics(){
  const snap = await getDocs(collection(db, "analytic"));
  return snap.docs.map(d=>({ id: d.id, ...d.data() }));
}

async function migrateAnalytics(entries = []){
  if (!Array.isArray(entries) || entries.length===0) return { ok:false, message: 'no entries' };
  const batch = writeBatch(db);
  entries.forEach((e, i) => {
    const id = String(e.t ?? Date.now()) + "-" + i;
    const ref = doc(collection(db, "analytic"), id);
    batch.set(ref, e);
  });
  await batch.commit();
  return { ok:true, count: entries.length };
}

async function deleteAllAnalytics(){
  const snap = await getDocs(collection(db, "analytic"));
  if (snap.empty) return { ok: true, count: 0 };
  const batch = writeBatch(db);
  snap.docs.forEach(d => batch.delete(doc(db, "analytic", d.id)));
  await batch.commit();
  return { ok: true, count: snap.size };
}

async function deleteProjectById(id){
  await deleteDoc(doc(db, "projects", String(id)));
  return { ok: true, id: String(id) };
}

async function getSettings() {
  const snap = await getDoc(doc(db, "settings", "main"));
  return snap.exists() ? snap.data() : null;
}

async function saveSettings(data = {}) {
  await setDoc(doc(db, "settings", "main"), data);
  return { ok: true };
}

export { db, seedProjects, addProject, setProjectById, getAllProjects, deleteProjectById, addAnalytic, getAllAnalytics, migrateAnalytics, deleteAllAnalytics, getSettings, saveSettings };

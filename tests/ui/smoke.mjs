// Render + interaction smoke test for the examination screens.
// Real pages (bundled by esbuild) run in jsdom against the REAL routers backed by the in-memory database.
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, baseSeed } from '../helpers/harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const h = await boot(baseSeed());

const stubFirebase = {
  name: 'stub-firebase',
  setup(b) {
    b.onResolve({ filter: /\/firebase$/ }, () => ({ path: 'fb', namespace: 'stub' }));
    b.onResolve({ filter: /context\/AuthContext(\.jsx)?$/ }, () => ({ path: 'auth', namespace: 'stub' }));
    b.onLoad({ filter: /^fb$/, namespace: 'stub' }, () => ({ contents: 'export const auth={get currentUser(){return {getIdToken:async()=>"uid:"+globalThis.__uid}}};', loader: 'js' }));
    b.onLoad({ filter: /^auth$/, namespace: 'stub' }, () => ({ contents: 'export const useAuth=()=>({profile:globalThis.__profile});export const isOwnerRole=r=>r==="institute_owner"||r==="institute_admin";', loader: 'js' }));
  },
};
const out = await build({
  entryPoints: [path.join(here, 'entry.jsx')], bundle: true, write: false, format: 'iife', globalName: 'Smoke', platform: 'browser', jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx' }, plugins: [stubFirebase], define: { 'import.meta.env.VITE_API_URL': JSON.stringify(h.apiUrl), 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' }, logLevel: 'error',
});
const code = out.outputFiles[0].text;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function open(uid, profile, route) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = (u, o) => fetch(u, o); w.__uid = uid; w.__profile = { uid, ...profile };
  w.confirm = () => true; w.IS_REACT_ACT_ENVIRONMENT = false;
  w.eval(code);
  const app = w.Smoke.mount(route);
  const text = async (until, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (until(w.document.body.textContent)) break; await sleep(60); } return w.document.body.textContent; };
  return { w, doc: w.document, text, close: () => { app.unmount(); w.close(); } };
}
const owner = { role: 'institute_owner', instituteId: 'i1' };
const student = { role: 'student', instituteId: 'i1', admissionStatus: 'approved' };
const now = Date.now(), iso = ms => new Date(ms).toISOString();
const paper = (name, subjectId, qids, startOffsetMin) => ({ paperName: name, subjectId, questionIds: qids, questionMarks: Object.fromEntries(qids.map(q => [q, 5])), durationMinutes: 60, startAt: iso(now + startOffsetMin * 60000), endAt: iso(now + (startOffsetMin + 120) * 60000), passingMarks: 4, maxAttempts: 1 });

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log('ok   -', name); } catch (e) { failures++; console.log('FAIL -', name, '\n      ', e.message.split('\n')[0]); } };

const created = await h.call('owner1', 'POST', '/examinations', { name: 'Final Examination 2026', examType: 'final', courseId: 'c1', papers: [paper('Mathematics', 's1', ['q1', 'q2'], -30), paper('Physics', 's2', ['q3', 'q4'], 180)] });
assert.equal(created.status, 201);
const examId = created.body.item.id; await h.call('owner1', 'POST', `/examinations/${examId}/publish`);
const mathId = created.body.item.papers[0].id;

await check('Owner list shows ONE row with "2 Papers" and parent-level actions', async () => {
  const s = await open('owner1', owner, '/app/exams');
  const t = await s.text(x => x.includes('Final Examination 2026'));
  assert.ok(t.includes('Final Examination 2026')); assert.ok(t.includes('2 Papers'));
  assert.equal(s.doc.querySelectorAll('tbody tr').length, 1);
  for (const label of ['View Papers', 'Edit', 'Unpublish', 'Delete']) assert.ok(t.includes(label), `missing action ${label}`);
  assert.ok(t.includes('Mathematics · Physics'), 'paper names are summarised inside the single row');
  s.close();
});
await check('Owner detail lists both papers with schedule and status', async () => {
  const s = await open('owner1', owner, `/app/exams/${examId}`);
  const t = await s.text(x => x.includes('Physics'));
  assert.ok(t.includes('Mathematics') && t.includes('Physics') && t.includes('2 papers'));
  s.close();
});
const setVal = (w, el, v) => {
  const proto = el.tagName === 'SELECT' ? w.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new w.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
};
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const btn = (doc, label) => [...doc.querySelectorAll('button')].find(b => b.textContent.trim().includes(label));
const localInput = ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

await check('Create wizard: build ONE examination with TWO papers through the UI', async () => {
  const before = Object.keys(h.mem.dump().institutes.i1.examinations || {}).length;
  const s = await open('owner1', owner, '/app/exams/new');
  await s.text(x => x.includes('Examination information'));
  setVal(s.w, s.doc.querySelector('input[placeholder^="e.g. Final"]'), 'Wizard Examination');
  click(s.w, btn(s.doc, 'Next: Papers'));
  await s.text(x => x.includes('No papers yet'));
  for (const [name, subjectId, startMin] of [['UI Maths', 's1', 0], ['UI Physics', 's2', 240]]) {
    click(s.w, btn(s.doc, 'Add paper'));
    await s.text(x => x.includes('Paper-specific instructions'));
    const modal = s.doc.querySelector('form.modal');
    setVal(s.w, modal.querySelector('input[placeholder^="e.g. Paper"]'), name);
    setVal(s.w, modal.querySelector('select'), subjectId);
    await sleep(50);
    modal.querySelectorAll('input[type=datetime-local]')[0] && setVal(s.w, modal.querySelectorAll('input[type=datetime-local]')[0], localInput(Date.now() + startMin * 60000));
    await sleep(50);
    click(s.w, modal.querySelector('.exam-question-row input[type=checkbox]'));
    await sleep(50);
    click(s.w, [...modal.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add paper'));
    await s.text(x => x.includes(name) && !x.includes('Paper-specific instructions'));
  }
  const t = s.doc.body.textContent;
  assert.ok(t.includes('2 papers'), 'wizard shows paper count'); assert.ok(t.includes('UI Maths') && t.includes('UI Physics'));
  click(s.w, btn(s.doc, 'Save examination with 2 papers'));
  await s.text(() => Object.keys(h.mem.dump().institutes.i1.examinations).length > before, 4000);
  const d = h.mem.dump().institutes.i1;
  const parents = Object.entries(d.examinations).filter(([, p]) => p.name === 'Wizard Examination');
  assert.equal(parents.length, 1, 'exactly one parent examination was created');
  const kids = Object.values(d.exams).filter(p => p.examinationId === parents[0][0]);
  assert.deepEqual(kids.map(k => k.paperName).sort(), ['UI Maths', 'UI Physics']);
  assert.equal(kids.every(k => k.status === 'draft' && k.questionIds.length === 1), true);
  s.close();
});
await check('Student list shows ONE examination card', async () => {
  const s = await open('stu1', student, '/student/exams');
  const t = await s.text(x => x.includes('View examination'));
  assert.equal(s.doc.querySelectorAll('.exm-card').length, 1); assert.ok(t.includes('Final Examination 2026')); assert.ok(t.includes('Papers'));
  s.close();
});
await check('Student examination page shows both papers with independent states', async () => {
  const s = await open('stu1', student, `/student/exams/${examId}`);
  const t = await s.text(x => x.includes('Physics'));
  assert.equal(s.doc.querySelectorAll('.exm-paper').length, 2);
  assert.ok(t.includes('Start paper')); assert.ok(t.includes('Not available yet')); assert.ok(t.includes('Available now') && t.includes('Upcoming'));
  assert.ok(/Opens in/.test(t), 'countdown for the upcoming paper');
  s.close();
});
await check('Runner: start paper, answer, mark for review, submit, land back on the examination', async () => {
  const s = await open('stu1', student, `/student/exams/${examId}/papers/${mathId}/attempt`);
  let t = await s.text(x => x.includes('QUESTION 1 OF 2'));
  assert.ok(t.includes('Question 1')); assert.ok(t.includes('Mathematics'));
  s.doc.querySelector('.runner-option').dispatchEvent(new s.w.MouseEvent('click', { bubbles: true }));
  await s.text(x => x.includes('1 of 2 answered'));
  s.doc.querySelector('.exm-review-btn').dispatchEvent(new s.w.MouseEvent('click', { bubbles: true }));
  t = await s.text(x => x.includes('Marked for review'));
  assert.ok(t.includes('1 marked for review'));
  const attempts = Object.values(h.mem.dump().institutes.i1.examAttempts);
  assert.equal(attempts.length, 1); assert.equal(attempts[0].review && Object.keys(attempts[0].review).length, 1, 'review flag persisted server-side');
  s.doc.querySelector('.submit-exam').dispatchEvent(new s.w.MouseEvent('click', { bubbles: true }));
  t = await s.text(x => x.includes('submitted'));
  assert.ok(t.includes('Mathematics submitted'));
  assert.ok(t.includes('Back to examination'));
  s.close();
});
await check('Student examination page now shows Mathematics completed and history grouped under one parent', async () => {
  const s = await open('stu1', student, `/student/exams/${examId}`);
  let t = await s.text(x => x.includes('Completed'));
  assert.ok(t.includes('Completed') && t.includes('View attempt history'));
  s.close();
  const hs = await open('stu1', student, '/student/history');
  t = await hs.text(x => x.includes('Final Examination 2026'));
  assert.equal(hs.doc.querySelectorAll('.exm-history-group').length, 1); assert.ok(t.includes('Attempt 1'));
  hs.close();
});
await check('Results page groups published results with overall totals', async () => {
  await h.call('owner1', 'POST', `/examinations/${examId}/results/publish`);
  const s = await open('stu1', student, '/student/results');
  const t = await s.text(x => x.includes('Final Examination 2026'));
  assert.ok(t.includes('Overall') && t.includes('Mathematics') && t.includes('Marksheet'));
  s.close();
});

await h.close();
console.log(failures ? `\n${failures} UI smoke check(s) FAILED` : '\nAll UI smoke checks passed');
process.exit(failures ? 1 : 0);

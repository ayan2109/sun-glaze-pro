import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeOverallResult, computePaperAccess, normalizePaperInput, planExaminationMigration, scoreAttempt,
  summarizeExaminationStates, validatePaperForPublish,
} from '../services/examEngine.js';

const T = Date.parse('2026-11-17T09:30:00Z');
const parent = { id: 'p', status: 'published' };
const paper = (o = {}) => ({ id: 'a', status: 'published', examMode: 'online', startAt: new Date(T - 1800e3).toISOString(), endAt: new Date(T + 3600e3).toISOString(), maxAttempts: 1, ...o });

test('paper availability states are computed from server time and attempts', () => {
  assert.equal(computePaperAccess({ parent, paper: paper(), now: T }).state, 'available');
  assert.equal(computePaperAccess({ parent, paper: paper({ startAt: new Date(T + 1e3).toISOString() }), now: T }).state, 'upcoming');
  assert.equal(computePaperAccess({ parent, paper: paper({ endAt: new Date(T - 1e3).toISOString() }), now: T }).state, 'expired');
  assert.equal(computePaperAccess({ parent, paper: paper({ status: 'draft' }), now: T }).state, 'not_published');
  assert.equal(computePaperAccess({ parent: { status: 'draft' }, paper: paper(), now: T }).state, 'not_published');
  assert.equal(computePaperAccess({ parent, paper: paper({ locked: true }), now: T }).state, 'locked');
  assert.equal(computePaperAccess({ parent, paper: paper({ examMode: 'offline' }), now: T }).canStart, false);
  const active = { id: 'x', status: 'in_progress', expiresAt: T + 1e3 };
  const inProg = computePaperAccess({ parent, paper: paper(), attempts: [active], now: T });
  assert.equal(inProg.state, 'in_progress'); assert.equal(inProg.activeAttemptId, 'x');
  assert.equal(computePaperAccess({ parent, paper: paper(), attempts: [{ id: 'y', status: 'submitted' }], now: T }).state, 'completed');
  // a second attempt remains available while attempts and window allow it
  assert.equal(computePaperAccess({ parent, paper: paper({ maxAttempts: 2 }), attempts: [{ id: 'y', status: 'submitted' }], now: T }).state, 'available');
  assert.equal(computePaperAccess({ parent, paper: paper({ maxAttempts: 'unlimited' }), attempts: [{}, {}, {}], now: T }).state, 'available');
  // boundaries are inclusive
  assert.equal(computePaperAccess({ parent, paper: paper(), now: Date.parse(paper().startAt) }).state, 'available');
  assert.equal(computePaperAccess({ parent, paper: paper(), now: Date.parse(paper().endAt) }).state, 'available');
  assert.equal(computePaperAccess({ parent, paper: paper(), now: Date.parse(paper().endAt) + 1 }).state, 'expired');
});

test('examination roll-up status prioritises actionable papers', () => {
  assert.equal(summarizeExaminationStates(['completed', 'upcoming', 'available']).status, 'available');
  assert.equal(summarizeExaminationStates(['completed', 'in_progress']).status, 'in_progress');
  assert.equal(summarizeExaminationStates(['completed', 'completed']).status, 'completed');
  assert.equal(summarizeExaminationStates(['expired', 'expired']).status, 'expired');
  assert.equal(summarizeExaminationStates(['upcoming']).status, 'upcoming');
});

test('paper input validation', () => {
  const ok = { paperName: 'Maths', subjectId: 's1', questionIds: ['q1'], questionMarks: { q1: 5 }, durationMinutes: 90, startAt: '2026-11-17T09:00:00Z', endAt: '2026-11-17T10:30:00Z', passingMarks: 2, maxAttempts: 1 };
  assert.deepEqual(normalizePaperInput(ok).errors, []);
  assert.ok(normalizePaperInput({ ...ok, endAt: '2026-11-17T09:30:00Z' }).errors.some(e => /shorter than its duration/.test(e)));
  assert.ok(normalizePaperInput({ ...ok, endAt: '2026-11-17T08:00:00Z' }).errors.some(e => /after its start/.test(e)));
  assert.ok(normalizePaperInput({ ...ok, startAt: 'nope' }).errors.length);
  assert.ok(normalizePaperInput({ ...ok, negativeMarking: 0.7 }).errors.some(e => /Negative/.test(e)));
  assert.ok(normalizePaperInput({ ...ok, maxAttempts: 0 }).errors.length);
  assert.ok(normalizePaperInput({ ...ok, subjectId: '' }).errors.length);
  assert.ok(normalizePaperInput({ ...ok, questionMarks: { q1: -1 } }).errors.length);
  assert.equal(normalizePaperInput({ ...ok, endAt: undefined }).value.endAt, '2026-11-17T10:30:00.000Z');
});

test('publish validation protects marks, passing marks and questions', () => {
  const q = { name: 'Q', questionType: 'mcq', optionA: 'a', optionB: 'b', correctOption: 'A', marks: 5 };
  const base = { examMode: 'online', questionIds: ['q1'], questionMarks: { q1: 5 }, durationMinutes: 60, startAt: new Date(T).toISOString(), endAt: new Date(T + 7200e3).toISOString(), passingMarks: 3 };
  assert.deepEqual(validatePaperForPublish(base, { q1: q }, { now: T }).errors, []);
  assert.ok(validatePaperForPublish({ ...base, passingMarks: 9 }, { q1: q }, { now: T }).errors.some(e => /Passing/.test(e)));
  assert.ok(validatePaperForPublish({ ...base, questionIds: [] }, {}, { now: T }).errors.length);
  assert.ok(validatePaperForPublish(base, { q1: { ...q, correctOption: 'C' } }, { now: T }).errors.length);
  assert.ok(validatePaperForPublish(base, {}, { now: T }).errors.some(e => /no longer exists/.test(e)));
  assert.ok(validatePaperForPublish({ ...base, endAt: new Date(T - 1).toISOString() }, { q1: q }, { now: T }).errors.length);
});

test('MCQ scoring with negative marking never goes below zero', () => {
  const snap = { totalMarks: 10, negativeMarking: 0.5, questions: [{ id: 'a', questionType: 'mcq', marks: 5, correctOption: 'X', text: 'a' }, { id: 'b', questionType: 'mcq', marks: 5, correctOption: 'Y', text: 'b' }] };
  assert.equal(scoreAttempt(snap, { a: 'X', b: 'Y' }).score, 10);
  assert.equal(scoreAttempt(snap, { a: 'X', b: 'Z' }).score, 2.5);
  assert.equal(scoreAttempt(snap, { a: 'Q', b: 'Z' }).score, 0);
});

const papers = [{ id: 'm', paperName: 'Maths', totalMarks: 100 }, { id: 'p', paperName: 'Physics', totalMarks: 100 }, { id: 'c', paperName: 'Chem', totalMarks: 100 }];
const r = (id, score, pass) => ({ id: `r${id}`, examId: id, score, totalMarks: 100, passStatus: pass, submittedAt: 1 });

test('overall result: per-paper policy fails when any paper fails', () => {
  const o = computeOverallResult({ parent: {}, papers, resultsByPaper: { m: [r('m', 85, 'pass')], p: [r('p', 72, 'pass')], c: [r('c', 35, 'fail')] } });
  assert.equal(o.totalMaximumMarks, 300); assert.equal(o.totalObtainedMarks, 192); assert.equal(o.percentage, 64);
  assert.equal(o.status, 'fail'); assert.equal(o.complete, true);
  assert.deepEqual(o.rows.map(x => x.passStatus), ['pass', 'pass', 'fail']);
});

test('overall result: aggregate policy, incomplete and none', () => {
  const all = { m: [r('m', 85, 'pass')], p: [r('p', 72, 'pass')], c: [r('c', 35, 'fail')] };
  assert.equal(computeOverallResult({ parent: { resultPolicy: { mode: 'aggregate', overallPassPercentage: 60 } }, papers, resultsByPaper: all }).status, 'pass');
  assert.equal(computeOverallResult({ parent: { resultPolicy: { mode: 'aggregate', overallPassPercentage: 70 } }, papers, resultsByPaper: all }).status, 'fail');
  assert.equal(computeOverallResult({ parent: {}, papers, resultsByPaper: { m: all.m } }).status, 'incomplete');
  assert.equal(computeOverallResult({ parent: { resultPolicy: { mode: 'none' } }, papers, resultsByPaper: all }).status, 'not_applicable');
  // best attempt is selected by default, latest on request
  const two = { m: [{ ...r('m', 40, 'fail'), submittedAt: 5 }, { ...r('m', 90, 'pass'), id: 'r2', submittedAt: 3 }] };
  assert.equal(computeOverallResult({ parent: {}, papers: [papers[0]], resultsByPaper: two }).rows[0].obtainedMarks, 90);
  assert.equal(computeOverallResult({ parent: { resultPolicy: { attemptSelection: 'latest' } }, papers: [papers[0]], resultsByPaper: two }).rows[0].obtainedMarks, 40);
  // passing one paper does not pass the examination
  assert.equal(computeOverallResult({ parent: {}, papers, resultsByPaper: { m: all.m, p: all.p, c: [r('c', 0, 'fail')] } }).status, 'fail');
});

test('migration plan: groups explicit legacy groups, never guesses, is idempotent', () => {
  const t = { departmentId: 'd', courseId: 'c' };
  const exams = {
    a1: { name: 'Final — Maths', examGroupId: 'g1', examGroupName: 'Final', paperOrder: 1, status: 'published', createdAt: 1, ...t },
    a2: { name: 'Final — Physics', examGroupId: 'g1', examGroupName: 'Final', paperOrder: 2, status: 'draft', createdAt: 2, ...t },
    s1: { name: 'Quiz', status: 'draft', createdAt: 3, ...t },
    b1: { name: 'Mock — Maths', examGroupId: 'g2', examGroupName: 'Mock', paperOrder: 1, createdAt: 4, ...t },
    b2: { name: 'Mock — Physics', examGroupId: 'g2', examGroupName: 'Mock', paperOrder: 2, createdAt: 5, departmentId: 'OTHER', courseId: 'c' },
    n1: { name: 'Unit — Maths', createdAt: 6, ...t }, n2: { name: 'Unit — Physics', createdAt: 7, ...t },
  };
  const plan = planExaminationMigration(exams, {});
  assert.equal(plan.parents.g1.paperIds.length, 2);
  assert.equal(plan.parents.g1.status, 'published', 'publication status of legacy papers is preserved');
  assert.deepEqual(plan.paperUpdates.a2.examinationId, 'g1'); assert.equal(plan.paperUpdates.a2.paperOrder, 2);
  assert.equal(plan.parents.exm_s1.paperIds[0], 's1');
  assert.equal(plan.report.ambiguous.length, 1, 'group with conflicting targets is not merged');
  assert.ok(plan.parents.exm_b1 && plan.parents.exm_b2 && !plan.parents.g2);
  assert.equal(plan.report.suggestions.length, 1, 'similar names are suggested, never merged');
  assert.ok(plan.parents.exm_n1 && plan.parents.exm_n2);
  // re-running against already-migrated data plans nothing
  const migrated = Object.fromEntries(Object.entries(exams).map(([id, e]) => [id, { ...e, ...plan.paperUpdates[id] }]));
  const again = planExaminationMigration(migrated, plan.parents);
  assert.equal(Object.keys(again.parents).length, 0); assert.equal(Object.keys(again.paperUpdates).length, 0);
});

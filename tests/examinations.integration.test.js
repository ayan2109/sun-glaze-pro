import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { boot, baseSeed } from './helpers/harness.js';

// Simulated clock: 17 Nov 2026, 09:00 UTC is "9 AM".
const T0 = Date.parse('2026-11-17T09:00:00Z');
const at = (h, m = 0) => T0 + ((h - 9) * 60 + m) * 60000;
const iso = ms => new Date(ms).toISOString();
const setClock = ms => mock.timers.setTime(ms);

const mathPaper = (o = {}) => ({ paperName: 'Mathematics', subjectId: 's1', questionIds: ['q1', 'q2'], questionMarks: { q1: 5, q2: 5 }, durationMinutes: 90, startAt: iso(at(9)), endAt: iso(at(10, 30)), passingMarks: 4, maxAttempts: 1, ...o });
const physPaper = (o = {}) => ({ paperName: 'Physics', subjectId: 's2', questionIds: ['q3', 'q4'], questionMarks: { q3: 5, q4: 5 }, durationMinutes: 90, startAt: iso(at(11)), endAt: iso(at(12, 30)), passingMarks: 4, maxAttempts: 1, ...o });

test('Examination parent/paper architecture — scenarios A to E', async t => {
  mock.timers.enable({ apis: ['Date'], now: at(9, 30) });
  const h = await boot(baseSeed());
  t.after(async () => { mock.timers.reset(); await h.close(); });
  const { call } = h;
  let examId, mathId, physId, mathAttempt, physAttempt;

  await t.test('A: one parent examination containing two papers', async () => {
    const created = await call('owner1', 'POST', '/examinations', { name: 'Final Examination 2026', examType: 'final', courseId: 'c1', departmentId: 'd1', instructions: 'Be on time', papers: [mathPaper(), physPaper()] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    examId = created.body.item.id;
    const list = await call('owner1', 'GET', '/examinations');
    assert.equal(list.body.items.length, 1, 'exactly one examination row');
    const row = list.body.items[0];
    assert.equal(row.name, 'Final Examination 2026'); assert.equal(row.paperCount, 2); assert.equal(row.totalMarks, 20);
    assert.deepEqual(row.papers.map(p => p.paperName), ['Mathematics', 'Physics']);
    assert.equal(row.status, 'draft');
    const detail = await call('owner1', 'GET', `/examinations/${examId}`);
    assert.equal(detail.body.examination.papers.length, 2);
    [mathId, physId] = detail.body.examination.papers.map(p => p.id);
    assert.notEqual(mathId, physId);
    // papers reference their parent and the parent indexes its papers
    const dump = h.mem.dump().institutes.i1;
    assert.equal(dump.exams[mathId].examinationId, examId); assert.deepEqual(dump.examinations[examId].paperIds, [mathId, physId]);
    // the generic paper-creation route can no longer create stand-alone examinations
    assert.equal((await call('owner1', 'POST', '/institutes/exams', { name: 'x' })).status, 410);
    assert.equal(Object.keys(dump.examinations).length, 1);
  });

  await t.test('A: paper management (add, edit, reorder, remove) stays inside the same examination', async () => {
    const added = await call('owner1', 'POST', `/examinations/${examId}/papers`, mathPaper({ paperName: 'Extra', subjectId: 's1', questionIds: ['q1'], questionMarks: { q1: 2 }, passingMarks: 1 }));
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal((await call('owner1', 'GET', '/examinations')).body.items.length, 1);
    const extraId = added.body.paper.id;
    assert.equal((await call('owner1', 'PATCH', `/examinations/${examId}/papers/${extraId}`, { paperName: 'Extra Renamed', passingMarks: 2 })).status, 200);
    assert.equal((await call('owner1', 'PUT', `/examinations/${examId}/papers-order`, { paperIds: [extraId, mathId, physId] })).status, 200);
    let detail = await call('owner1', 'GET', `/examinations/${examId}`);
    assert.deepEqual(detail.body.examination.papers.map(p => p.paperName), ['Extra Renamed', 'Mathematics', 'Physics']);
    assert.equal((await call('owner1', 'PUT', `/examinations/${examId}/papers-order`, { paperIds: [mathId] })).status, 400);
    assert.equal((await call('owner1', 'DELETE', `/examinations/${examId}/papers/${extraId}`)).status, 200);
    detail = await call('owner1', 'GET', `/examinations/${examId}`);
    assert.deepEqual(detail.body.examination.papers.map(p => [p.paperName, p.paperOrder]), [['Mathematics', 1], ['Physics', 2]]);
    assert.equal((await call('owner1', 'GET', '/examinations')).body.items.length, 1);
  });

  await t.test('A: publish validation rejects bad papers and prevents partial publication', async () => {
    const bad = await call('owner1', 'POST', '/examinations', { name: 'Broken', courseId: 'c1', papers: [mathPaper({ passingMarks: 99 }), physPaper({ paperName: 'Empty', questionIds: [], questionMarks: {} })] });
    assert.equal(bad.status, 201);
    const pub = await call('owner1', 'POST', `/examinations/${bad.body.item.id}/publish`);
    assert.equal(pub.status, 400); assert.equal(pub.body.details.length, 2);
    const after = h.mem.dump().institutes.i1;
    assert.equal(Object.values(after.exams).filter(p => p.examinationId === bad.body.item.id && p.status === 'published').length, 0);
    assert.equal((await call('owner1', 'POST', '/examinations', { name: 'x', papers: [mathPaper({ subjectId: 'nope' })] })).status, 400);
    assert.equal((await call('owner1', 'POST', '/examinations', { name: 'x', papers: [mathPaper({ questionIds: ['q3'], questionMarks: { q3: 1 } })] })).status, 400, 'question from another subject');
    // clean up the broken draft (no history => real delete)
    assert.equal((await call('owner1', 'DELETE', `/examinations/${bad.body.item.id}`)).body.deleted, true);
  });

  await t.test('A: students cannot see drafts; parent-level publish releases all papers once', async () => {
    assert.equal((await call('stu1', 'GET', '/student/examinations')).body.items.length, 0);
    const pub = await call('owner1', 'POST', `/examinations/${examId}/publish`);
    assert.equal(pub.status, 200, JSON.stringify(pub.body)); assert.equal(pub.body.papers, 2);
    const again = await call('owner1', 'POST', `/examinations/${examId}/publish`);
    assert.equal(again.body.alreadyPublished, true);
    const papers = h.mem.dump().institutes.i1.exams;
    assert.equal(papers[mathId].status, 'published'); assert.equal(papers[physId].status, 'published');
    // legacy per-paper publish endpoint routes to the parent
    assert.equal((await call('owner1', 'POST', `/exams/${mathId}/publish`)).body.alreadyPublished, true);
  });

  await t.test('B: student sees ONE examination, opens it and sees both papers', async () => {
    const list = await call('stu1', 'GET', '/student/examinations');
    assert.equal(list.body.items.length, 1); assert.equal(list.body.items[0].paperCount, 2); assert.equal(list.body.items[0].status, 'available');
    assert.equal((await call('stu1', 'GET', '/student/exams')).body.items.length, 1, 'legacy listing endpoint also returns the parent');
    const detail = await call('stu1', 'GET', `/student/examinations/${examId}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.papers.map(p => p.paperName), ['Mathematics', 'Physics']);
    assert.ok(JSON.stringify(detail.body).indexOf('correctOption') === -1, 'no answers leak');
    assert.equal((await call('stuPending', 'GET', '/student/examinations')).body.items.length, 0);
    assert.equal((await call('stuOther', 'GET', '/student/examinations')).body.items.length, 0);
    assert.equal((await call('stuOther', 'GET', `/student/examinations/${examId}`)).status, 404);
  });

  await t.test('C: independent schedules (9:30 Maths open, Physics upcoming; 11:00 Physics opens)', async () => {
    let d = (await call('stu1', 'GET', `/student/examinations/${examId}`)).body;
    const state = () => Object.fromEntries(d.papers.map(p => [p.paperName, p.state]));
    assert.deepEqual(state(), { Mathematics: 'available', Physics: 'upcoming' });
    assert.ok(d.papers[1].startsInMs > 0);
    assert.equal((await call('stu1', 'POST', `/student/examinations/${examId}/papers/${physId}/start`)).status, 403, 'cannot start early');
    setClock(at(10, 31));
    d = (await call('stu1', 'GET', `/student/examinations/${examId}`)).body;
    assert.deepEqual(state(), { Mathematics: 'expired', Physics: 'upcoming' }, 'each paper closes on its own schedule');
    setClock(at(11));
    d = (await call('stu1', 'GET', `/student/examinations/${examId}`)).body;
    assert.deepEqual(state(), { Mathematics: 'expired', Physics: 'available' }, 'Physics opens automatically at 11:00');
    assert.equal((await call('stu1', 'POST', `/student/examinations/${examId}/papers/${mathId}/start`)).status, 403, 'cannot start after the window closes');
    setClock(at(9, 30));
  });

  await t.test('D: Mathematics attempt — start, resume after refresh, save, submit', async () => {
    const s = await call('stu1', 'POST', `/student/examinations/${examId}/papers/${mathId}/start`);
    assert.equal(s.status, 201, JSON.stringify(s.body));
    mathAttempt = s.body.attemptId;
    assert.equal(s.body.attemptNumber, 1); assert.equal(s.body.resumed, false);
    assert.equal(s.body.expiresAt, at(10, 30), 'deadline is the paper end, not now+90min');
    assert.ok(!JSON.stringify(s.body).includes('correctOption'));
    // "refresh": same attempt, timer not reset
    setClock(at(9, 40));
    const resumed = await call('stu1', 'POST', `/student/examinations/${examId}/papers/${mathId}/start`);
    assert.equal(resumed.body.attemptId, mathAttempt); assert.equal(resumed.body.resumed, true); assert.equal(resumed.body.expiresAt, s.body.expiresAt);
    assert.equal((await call('stu1', 'GET', `/student/attempts/${mathAttempt}`)).body.attemptId, mathAttempt);
    // answers + mark for review
    const saved = await call('stu1', 'PUT', `/student/attempts/${mathAttempt}/answers`, { answers: { q1: 'Right', q2: 'Right' }, review: { q2: true } });
    assert.equal(saved.status, 200);
    assert.equal((await call('stu1', 'GET', `/student/attempts/${mathAttempt}`)).body.review.q2, true);
    assert.equal((await call('stu1', 'PUT', `/student/attempts/${mathAttempt}/answers`, { answers: { q1: 'Not an option' } })).body.answers.q1, 'Right', 'invalid options are ignored');
    // tenant / student isolation
    assert.equal((await call('stu2', 'GET', `/student/attempts/${mathAttempt}`)).status, 404);
    assert.equal((await call('stu2', 'PUT', `/student/attempts/${mathAttempt}/answers`, { answers: { q1: 'Wrong 1' } })).status, 404);
    assert.equal((await call('stu2', 'POST', `/student/attempts/${mathAttempt}/submit`)).status, 404);
    assert.equal((await call('stuOther', 'GET', `/student/attempts/${mathAttempt}`)).status, 404);
    const sub = await call('stu1', 'POST', `/student/attempts/${mathAttempt}/submit`);
    assert.equal(sub.status, 200); assert.equal(sub.body.examinationId, examId);
    assert.equal((await call('stu1', 'POST', `/student/attempts/${mathAttempt}/submit`)).status, 200, 'double submit is idempotent');
    assert.equal((await call('stu1', 'PUT', `/student/attempts/${mathAttempt}/answers`, { answers: { q1: 'Wrong 1' } })).status, 409, 'submitted answers are immutable');
    const result = h.mem.dump().institutes.i1.results[mathAttempt];
    assert.equal(result.examinationId, examId); assert.equal(result.paperId, mathId); assert.equal(result.score, 5); assert.equal(result.publicationStatus, 'unpublished');
    assert.equal(Object.keys(h.mem.dump().institutes.i1.results).length, 1);
  });

  await t.test('D: Mathematics completed, Physics independent, attempts separate', async () => {
    const d = (await call('stu1', 'GET', `/student/examinations/${examId}`)).body;
    const m = d.papers.find(p => p.id === mathId), p = d.papers.find(p => p.id === physId);
    assert.equal(m.state, 'completed'); assert.equal(m.attempts.length, 1); assert.equal(m.result, null, 'no marks before publication');
    assert.equal(p.state, 'upcoming'); assert.equal(p.attempts.length, 0);
    assert.equal((await call('stu1', 'POST', `/student/examinations/${examId}/papers/${mathId}/start`)).status, 409, 'attempt limit enforced');
    setClock(at(11, 5));
    const s = await call('stu1', 'POST', `/student/examinations/${examId}/papers/${physId}/start`);
    assert.equal(s.status, 201, JSON.stringify(s.body));
    physAttempt = s.body.attemptId; assert.notEqual(physAttempt, mathAttempt);
    await call('stu1', 'PUT', `/student/attempts/${physAttempt}/answers`, { answers: { q3: 'Right' } });
    // wrong paper/parent combos are rejected
    assert.equal((await call('stu2', 'POST', `/student/examinations/${examId}/papers/nonexistent/start`)).status, 404);
    assert.equal((await call('stu2', 'POST', `/student/examinations/wrongparent/papers/${physId}/start`)).status, 404);
  });

  await t.test('E: expiry triggers automatic submission and blocks late writes', async () => {
    setClock(at(12, 31));
    const late = await call('stu1', 'PUT', `/student/attempts/${physAttempt}/answers`, { answers: { q4: 'Right' } });
    assert.equal(late.status, 409);
    const d = (await call('stu1', 'GET', `/student/examinations/${examId}`)).body;
    const p = d.papers.find(x => x.id === physId);
    assert.equal(p.state, 'completed');
    const dump = h.mem.dump().institutes.i1;
    assert.equal(dump.examAttempts[physAttempt].status, 'submitted'); assert.equal(dump.examAttempts[physAttempt].autoSubmitted, true);
    assert.equal(dump.examAttempts[physAttempt].submittedAt, at(12, 30), 'recorded at the deadline, not later');
    assert.equal(dump.results[physAttempt].score, 5);
    assert.equal((await call('stu1', 'POST', `/student/examinations/${examId}/papers/${physId}/start`)).status, 409);
    setClock(at(9, 30));
  });

  await t.test('E: multiple attempts, unpublished access, cross-institute access', async () => {
    setClock(at(9, 30));
    const ex = await call('owner1', 'POST', '/examinations', { name: 'Quiz', courseId: 'c1', papers: [mathPaper({ paperName: 'Quiz Maths', maxAttempts: 2, startAt: iso(at(9)), endAt: iso(at(23)), durationMinutes: 30 })] });
    const id = ex.body.item.id, pid = ex.body.item.papers[0].id;
    assert.equal((await call('stu1', 'POST', `/student/examinations/${id}/papers/${pid}/start`)).status, 404, 'unpublished');
    assert.equal((await call('owner1', 'POST', `/examinations/${id}/publish`)).status, 200);
    const s1 = await call('stu1', 'POST', `/student/examinations/${id}/papers/${pid}/start`);
    assert.equal(s1.body.attemptNumber, 1);
    await call('stu1', 'POST', `/student/attempts/${s1.body.attemptId}/submit`);
    let d = (await call('stu1', 'GET', `/student/examinations/${id}`)).body.papers[0];
    assert.equal(d.state, 'available'); assert.equal(d.attemptsRemaining, 1);
    const s2 = await call('stu1', 'POST', `/student/examinations/${id}/papers/${pid}/start`);
    assert.equal(s2.body.attemptNumber, 2);
    await call('stu1', 'POST', `/student/attempts/${s2.body.attemptId}/submit`);
    assert.equal((await call('stu1', 'POST', `/student/examinations/${id}/papers/${pid}/start`)).status, 409);
    assert.equal((await call('stuOther', 'POST', `/student/examinations/${id}/papers/${pid}/start`)).status, 404, 'another institute never learns the paper exists');
    assert.equal((await call('stuPending', 'POST', `/student/examinations/${id}/papers/${pid}/start`)).status, 403);
    // owners of another institute cannot read or change it
    assert.equal((await call('owner2', 'GET', `/examinations/${id}`)).status, 404);
    assert.equal((await call('owner2', 'POST', `/examinations/${id}/publish`)).status, 404);
    // changing questions after attempts exist is blocked, schedule edits are allowed
    assert.equal((await call('owner1', 'PATCH', `/examinations/${id}/papers/${pid}`, { questionIds: ['q1'], questionMarks: { q1: 5 } })).status, 409);
    assert.equal((await call('owner1', 'PATCH', `/examinations/${id}/papers/${pid}`, { passingMarks: 3 })).status, 200);
    // removal / deletion preserve history
    assert.equal((await call('owner1', 'DELETE', `/examinations/${id}/papers/${pid}`)).status, 409);
    {
      const del = await call('owner1', 'DELETE', `/examinations/${id}`);
      assert.equal(del.body.archived, true);
      const dump = h.mem.dump().institutes.i1;
      assert.equal(Object.values(dump.examAttempts).filter(a => a.examId === pid).length, 2, 'attempts untouched');
      assert.equal(dump.exams[pid].status, 'archived');
      assert.equal((await call('owner1', 'GET', '/examinations')).body.items.some(x => x.id === id), false, 'archived hidden from the list');
      assert.equal((await call('stu1', 'GET', '/student/examinations')).body.items.some(x => x.id === id), false);
    }
  });

  await t.test('E: unpublish blocks new starts but keeps history', async () => {
    setClock(at(9, 30));
    assert.equal((await call('owner1', 'POST', `/examinations/${examId}/unpublish`)).status, 200);
    assert.equal((await call('stu1', 'GET', '/student/examinations')).body.items.length, 0);
    assert.equal((await call('stu1', 'POST', `/student/examinations/${examId}/papers/${mathId}/start`)).status, 404, 'unpublished papers cannot be started');
    // republish while the windows are still valid
    assert.equal((await call('owner1', 'POST', `/examinations/${examId}/publish`)).status, 200);
    assert.equal((await call('stu1', 'GET', '/student/examinations')).body.items.length, 1);
    // once the schedule has passed, publication is refused with a clear reason
    setClock(at(13));
    assert.equal((await call('owner1', 'POST', `/examinations/${examId}/unpublish`)).status, 200);
    const late = await call('owner1', 'POST', `/examinations/${examId}/publish`);
    assert.equal(late.status, 400); assert.match(JSON.stringify(late.body.details), /already passed/);
    setClock(at(9, 30));
    assert.equal((await call('owner1', 'POST', `/examinations/${examId}/publish`)).status, 200);
  });

  await t.test('Results: paper-wise and overall result, publication gating', async () => {
    setClock(at(9, 30));
    const res = await call('owner1', 'GET', `/examinations/${examId}/results`);
    assert.equal(res.status, 200);
    const row = res.body.items.find(x => x.studentUid === 'stu1');
    assert.equal(row.rows.length, 2); assert.equal(row.totalMaximumMarks, 20); assert.equal(row.totalObtainedMarks, 10); assert.equal(row.status, 'pass');
    assert.equal(row.allPublished, false);
    // student sees nothing until published
    let sr = await call('stu1', 'GET', `/student/examinations/${examId}/results`);
    assert.equal(sr.body.status, 'incomplete'); assert.ok(sr.body.rows.every(r => r.passStatus === 'result_pending'));
    assert.equal((await call('stu1', 'GET', '/student/results')).body.items.length, 0);
    const bulk = await call('owner1', 'POST', `/examinations/${examId}/results/publish`);
    assert.equal(bulk.body.published >= 2, true);
    sr = await call('stu1', 'GET', `/student/examinations/${examId}/results`);
    assert.equal(sr.body.status, 'pass'); assert.equal(sr.body.percentage, 50);
    const list = await call('stu1', 'GET', '/student/results');
    assert.equal(list.body.items.length >= 2, true); assert.ok(list.body.items.every(x => x.examinationId));
    // student history grouped under the single parent
    const hist = await call('stu1', 'GET', '/student/history');
    const g = hist.body.examinations.find(x => x.examinationId === examId);
    assert.equal(g.papers.length, 2); assert.equal(g.overall.status, 'pass');
    assert.ok(g.papers.every(p => p.attempts.length === 1));
  });

  await t.test('Reports: no double counting of papers as examinations', async () => {
    const s = (await call('owner1', 'GET', '/examinations/summary')).body.summary;
    assert.equal(s.totalExaminations, 1); assert.equal(s.totalPapers, 2); assert.equal(s.participatingStudents, 1);
    assert.equal(s.perExamination[0].completedAttempts, 2); assert.equal(s.pendingAttempts, 0);
    const dash = await call('owner1', 'GET', '/dashboard');
    assert.equal(dash.body.stats.exams, 1); assert.equal(dash.body.stats.examPapers, 2);
    assert.equal(dash.body.recentExams.length, 1); assert.equal(dash.body.recentExams[0].paperCount, 2);
  });

  await t.test('Permissions: teacher scope and ownership', async () => {
    const mine = await call('teacher1', 'POST', '/examinations', { name: 'Teacher Test', courseId: 'c1', papers: [mathPaper({ paperName: 'T Maths', endAt: iso(at(23)) })] });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    const tid = mine.body.item.id;
    assert.equal((await call('teacher1', 'GET', '/examinations')).body.items.length >= 2, true);
    // another teacher without scope neither sees nor manages it
    assert.equal((await call('teacher2', 'GET', '/examinations')).body.items.some(x => x.id === tid), false);
    assert.equal((await call('teacher2', 'GET', `/examinations/${tid}`)).status, 403);
    assert.equal((await call('teacher2', 'POST', `/examinations/${tid}/publish`)).status, 403);
    // teachers cannot manage the owner's examination or use subjects outside their scope
    assert.equal((await call('teacher1', 'PATCH', `/examinations/${examId}`, { name: 'Hijack' })).status, 403);
    assert.equal((await call('teacher1', 'POST', '/examinations', { name: 'Out of scope', papers: [mathPaper({ subjectId: 's3' })] })).status, 403);
    assert.equal((await call('teacher1', 'POST', `/examinations/${tid}/publish`)).status, 200);
    assert.equal((await call('stu1', 'POST', '/examinations', { name: 'x' })).status, 403);
    // delete of a teacher exam without history is a real delete
    assert.equal((await call('teacher1', 'DELETE', `/examinations/${tid}`)).body.deleted, true);
  });
});

test('Scenario F: legacy multi-record data is migrated safely and historical data is untouched', async t => {
  mock.timers.enable({ apis: ['Date'], now: at(9, 30) });
  const seed = baseSeed();
  const target = { courseId: 'c1', departmentId: 'd1' };
  const legacy = (name, group, order, extra = {}) => ({ name, subjectId: 's1', subjectName: 'Mathematics', examMode: 'online', questionIds: ['q1', 'q2'], questionMarks: { q1: 5, q2: 5 }, totalMarks: 10, passingMarks: 4, durationMinutes: 60, startAt: iso(at(9)), endAt: iso(at(10)), maxAttempts: 1, status: 'published', createdBy: 'owner1', createdAt: 1000 + order, ...(group ? { examGroupId: group, examGroupName: 'Mid Term', paperOrder: order, paperCount: 2 } : {}), ...target, ...extra });
  seed.institutes.i1.exams = {
    L1: legacy('Mid Term — Mathematics', 'examgroup_1', 1),
    L2: legacy('Mid Term — Physics', 'examgroup_1', 2, { subjectId: 's2', subjectName: 'Physics', questionIds: ['q3', 'q4'], questionMarks: { q3: 5, q4: 5 } }),
    L3: legacy('Old Standalone Quiz', null, 1, { status: 'draft' }),
  };
  const attempt = { id: 'A1', examId: 'L1', studentUid: 'stu1', studentRecordId: 'st1', studentName: 'Student A', status: 'submitted', startedAt: 5, submittedAt: 9, expiresAt: 99, snapshot: { examName: 'Mid Term — Mathematics', totalMarks: 10, passingMarks: 4, questions: [] }, answers: {}, result: { score: 10 } };
  const result = { id: 'A1', examId: 'L1', examName: 'Mid Term — Mathematics', studentUid: 'stu1', studentRecordId: 'st1', score: 10, totalMarks: 10, percentage: 100, passStatus: 'pass', publicationStatus: 'published', publishedAt: 50 };
  seed.institutes.i1.examAttempts = { A1: attempt }; seed.institutes.i1.results = { A1: result };
  seed.institutes.i1.attemptCounts = { L1: { stu1: 1 } };
  const h = await boot(seed);
  t.after(async () => { mock.timers.reset(); await h.close(); });

  const beforeHistory = JSON.stringify({ a: h.mem.dump().institutes.i1.examAttempts, r: h.mem.dump().institutes.i1.results, c: h.mem.dump().institutes.i1.attemptCounts });

  const list = await h.call('owner1', 'GET', '/examinations');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.items.length, 2, 'two legacy papers collapse into one parent; the standalone stays its own');
  const mid = list.body.items.find(x => x.name === 'Mid Term');
  assert.equal(mid.id, 'examgroup_1', 'group id reused as the parent id'); assert.equal(mid.paperCount, 2); assert.equal(mid.status, 'published');
  assert.deepEqual(mid.papers.map(p => p.id), ['L1', 'L2'], 'paper ids are preserved');
  assert.equal(list.body.items.find(x => x.name === 'Old Standalone Quiz').paperCount, 1);

  const afterHistory = JSON.stringify({ a: h.mem.dump().institutes.i1.examAttempts, r: h.mem.dump().institutes.i1.results, c: h.mem.dump().institutes.i1.attemptCounts });
  assert.equal(afterHistory, beforeHistory, 'historical attempts, results and counters are byte-for-byte unchanged');

  // idempotent: running the migration again changes nothing
  const snap1 = JSON.stringify(h.mem.dump().institutes.i1);
  const { examStore } = await import('../routes/examinations.js');
  const again = await examStore.migrateInstitute('i1');
  assert.equal(again.parentsCreated, 0); assert.equal(again.papersLinked, 0);
  const snap2 = JSON.parse(JSON.stringify(h.mem.dump().institutes.i1)); delete snap2.examinationMigration;
  const snap1o = JSON.parse(snap1); delete snap1o.examinationMigration;
  assert.deepEqual(snap2, snap1o);

  // existing student still works: sees ONE examination for the two published papers, history intact
  const sl = await h.call('stu1', 'GET', '/student/examinations');
  assert.equal(sl.body.items.length, 1); assert.equal(sl.body.items[0].paperCount, 2);
  const sd = await h.call('stu1', 'GET', '/student/examinations/examgroup_1');
  assert.equal(sd.body.papers.find(p => p.id === 'L1').state, 'completed');
  assert.equal(sd.body.papers.find(p => p.id === 'L1').result.score, 10, 'published historical result remains visible');
  assert.equal(sd.body.papers.find(p => p.id === 'L2').state, 'available');
  const sr = await h.call('stu1', 'GET', '/student/results');
  assert.equal(sr.body.items.length, 1); assert.equal(sr.body.items[0].examinationId, 'examgroup_1', 'legacy result resolved to its parent without rewriting it');
  const resultsBefore = await h.call('stu1', 'POST', '/student/exams/L2/start');
  assert.equal(resultsBefore.status, 201, 'legacy paper-id start endpoint keeps working');

  // opt-in history backfill adds references only
  const back = await examStore.migrateInstitute('i1', { backfillHistory: true });
  assert.equal(back.historyRecordsLinked >= 2, true);
  const d = h.mem.dump().institutes.i1;
  assert.equal(d.results.A1.examinationId, 'examgroup_1'); assert.equal(d.results.A1.score, 10); assert.equal(d.examAttempts.A1.status, 'submitted');
});

test('Scenario F2: ambiguous legacy groups are never merged; manual reconciliation merges explicitly', async t => {
  mock.timers.enable({ apis: ['Date'], now: at(9, 30) });
  const seed = baseSeed();
  const mk = (name, extra) => ({ name, subjectId: 's1', subjectName: 'Mathematics', examMode: 'online', questionIds: ['q1'], questionMarks: { q1: 5 }, totalMarks: 5, passingMarks: 1, durationMinutes: 60, startAt: iso(at(9)), endAt: iso(at(10)), maxAttempts: 1, status: 'draft', createdBy: 'owner1', createdAt: 1, courseId: 'c1', ...extra });
  seed.institutes.i1.exams = {
    X1: mk('Group — Maths', { examGroupId: 'gx', examGroupName: 'Group', paperOrder: 1 }),
    X2: mk('Group — Physics', { examGroupId: 'gx', examGroupName: 'Group', paperOrder: 2, courseId: 'c2' }),
    Y1: mk('Final — Maths'), Y2: mk('Final — Physics'),
  };
  const h = await boot(seed);
  t.after(async () => { mock.timers.reset(); await h.close(); });
  const list = (await h.call('owner1', 'GET', '/examinations')).body.items;
  assert.equal(list.length, 4, 'nothing was merged automatically');
  const y1 = list.find(x => x.papers[0].id === 'Y1'), y2 = list.find(x => x.papers[0].id === 'Y2');
  const merged = await h.call('owner1', 'POST', `/examinations/${y1.id}/absorb`, { sourceExaminationIds: [y2.id] });
  assert.equal(merged.status, 200, JSON.stringify(merged.body)); assert.equal(merged.body.movedPapers, 1);
  const after = (await h.call('owner1', 'GET', '/examinations')).body.items;
  assert.equal(after.length, 3); assert.equal(after.find(x => x.id === y1.id).paperCount, 2);
  const x1 = list.find(x => x.papers[0].id === 'X1'), x2 = list.find(x => x.papers[0].id === 'X2');
  assert.equal((await h.call('owner1', 'POST', `/examinations/${x1.id}/absorb`, { sourceExaminationIds: [x2.id] })).status, 409, 'mismatched academic targets cannot be merged');
  assert.equal((await h.call('teacher1', 'POST', `/examinations/${y1.id}/absorb`, { sourceExaminationIds: [] })).status, 403);
});

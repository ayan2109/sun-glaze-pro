import {
  LEGACY_TARGET_FIELDS, TARGET_FIELDS, buildResultRecord, planExaminationMigration, scoreAttempt, toMs,
} from './examEngine.js';

export const base = (iid, c, id) => `institutes/${iid}/${c}/${id}`;

// `db` must expose get/set/update/remove/transaction/key (see config/firebase.js).
export function createExamStore(db) {
  const migrated = new Set();

  async function getStudentIdentity(user) {
    const uid = user.uid, iid = user.instituteId;
    const ids = new Set([uid, user.studentRecordId, user.studentRecord?.id].filter(Boolean).map(String));
    if (iid && !user.studentRecordId && !user.studentRecord?.id) {
      const ref = db.ref(`institutes/${iid}/students`);
      const snapshot = await ref.get();
      if (snapshot.exists()) {
        for (const [id, s] of Object.entries(snapshot.val())) {
          if (s?.linkedUid === String(uid) || s?.uid === String(uid)) ids.add(String(id));
        }
      }
    }
    return { uid, recordIds: ids };
  }

  const isApprovedStudent = user => user?.role === 'student' && !!user.instituteId
    && (user.admissionStatus === 'approved' || user.studentRecord?.admissionStatus === 'approved' || user.status === 'approved');

  async function matchesStudentTarget(iid, target, student, fields) {
    if (!student) return false;
    for (const key of fields) if (target?.[key] && String(target[key]) !== String(student[key] || '')) return false;
    if (target?.subjectId) {
      if (student.subjectId && String(target.subjectId) !== String(student.subjectId)) return false;
      if (!student.subjectId) {
        const subject = await db.get(`institutes/${iid}/subjects/${target.subjectId}`);
        if (!subject) return false;
        if (subject.courseId && String(subject.courseId) !== String(student.courseId || '')) return false;
        if (subject.departmentId && student.departmentId && String(subject.departmentId) !== String(student.departmentId)) return false;
        if (subject.semesterId && student.semesterId && String(subject.semesterId) !== String(student.semesterId)) return false;
      }
    }
    return true;
  }

  // Parent-level eligibility: explicit student list wins, otherwise academic target match.
  async function studentEligible(iid, parent, paper, student, recordIds) {
    if (!student) return false;
    const explicit = Array.isArray(parent.eligibleStudentIds) ? parent.eligibleStudentIds.map(String) : [];
    if (explicit.length) {
      if (![...recordIds].some(id => explicit.includes(String(id)))) return false;
      return true;
    }
    const fields = parent.legacy ? LEGACY_TARGET_FIELDS : TARGET_FIELDS;
    if (!(await matchesStudentTarget(iid, parent, student, fields))) return false;
    return matchesStudentTarget(iid, { subjectId: paper?.subjectId }, student, []);
  }

  // ----- migration -----
  async function migrateInstitute(iid, { dryRun = false, backfillHistory = false } = {}) {
    const [exams, parents] = await Promise.all([db.get(`institutes/${iid}/exams`), db.get(`institutes/${iid}/examinations`)]);
    const plan = planExaminationMigration(exams || {}, parents || {});
    const updates = {};
    for (const [id, p] of Object.entries(plan.parents)) {
      if (parents?.[id]) continue; // never overwrite an existing parent
      updates[base(iid, 'examinations', id)] = p;
    }
    for (const [pid, patch] of Object.entries(plan.paperUpdates)) {
      for (const [k, v] of Object.entries(patch)) updates[`${base(iid, 'exams', pid)}/${k}`] = v;
    }
    let history = 0;
    if (backfillHistory) {
      const [attempts, results] = await Promise.all([db.get(`institutes/${iid}/examAttempts`), db.get(`institutes/${iid}/results`)]);
      const parentOf = pid => plan.paperUpdates[pid]?.examinationId || exams?.[pid]?.examinationId;
      for (const [coll, rows] of [['examAttempts', attempts], ['results', results]]) {
        for (const [id, r] of Object.entries(rows || {})) {
          const parentId = parentOf(r.examId);
          if (parentId && (!r.examinationId || !r.paperId)) {
            updates[`${base(iid, coll, id)}/examinationId`] = parentId;
            updates[`${base(iid, coll, id)}/paperId`] = r.examId;
            history++;
          }
        }
      }
    }
    const summary = { parentsCreated: Object.keys(plan.parents).filter(id => !parents?.[id]).length, papersLinked: Object.keys(plan.paperUpdates).length, historyRecordsLinked: history, report: plan.report, dryRun };
    if (!dryRun && Object.keys(updates).length) {
      updates[`institutes/${iid}/examinationMigration`] = { version: 2, at: Date.now(), parentsCreated: summary.parentsCreated, papersLinked: summary.papersLinked, ambiguousGroups: plan.report.ambiguous.length };
      await db.update(updates);
    } else if (!dryRun) {
      await db.set(`institutes/${iid}/examinationMigration`, { version: 2, at: Date.now(), parentsCreated: 0, papersLinked: 0, ambiguousGroups: 0 });
    }
    return summary;
  }

  async function ensureMigrated(iid) {
    if (!iid || migrated.has(iid)) return;
    const exams = (await db.get(`institutes/${iid}/exams`)) || {};
    if (Object.values(exams).some(e => e && typeof e === 'object' && !e.examinationId)) await migrateInstitute(iid);
    migrated.add(iid);
  }

  // ----- data loading -----
  async function loadExamination(iid, id) {
    if (!id) return null;
    const parent = await db.get(base(iid, 'examinations', id));
    return parent ? { ...parent, id } : null;
  }
  async function loadPapers(iid, examinationId, allExams) {
    const all = allExams || (await db.get(`institutes/${iid}/exams`)) || {};
    return Object.entries(all)
      .filter(([, p]) => p && p.examinationId === examinationId)
      .map(([id, p]) => ({ ...p, id }))
      .sort((a, b) => (Number(a.paperOrder) || 999) - (Number(b.paperOrder) || 999) || (a.createdAt || 0) - (b.createdAt || 0));
  }


  // Student-facing screens must not download an institute's complete attempt/result
  // history. Only records owned by the authenticated student are returned.
  async function loadStudentCollection(iid, collection, identity) {
    const ref = db.ref(`institutes/${iid}/${collection}`);
    const recordIds = new Set([...(identity?.recordIds || [])].map(String));
    const snapshot = await ref.get();
    const rows = {};
    if (snapshot?.exists()) {
      for (const [key, row] of Object.entries(snapshot.val())) {
        if ((identity?.uid && row?.studentUid === String(identity.uid))
          || (typeof row?.studentRecordId === 'string' && recordIds.has(row.studentRecordId))) rows[key] = row;
      }
    }
    return rows;
  }

  async function loadStudentAttempts(iid, identity) {
    return loadStudentCollection(iid, 'examAttempts', identity);
  }

  async function loadStudentResults(iid, identity) {
    return loadStudentCollection(iid, 'results', identity);
  }

  async function sweepExpiredForStudent(iid, identity, now = Date.now()) {
    const attempts = await loadStudentAttempts(iid, identity);
    let swept = 0;
    for (const [id, attempt] of Object.entries(attempts)) {
      attempt.id = attempt.id || id;
      if (attempt.status === 'in_progress' && toMs(attempt.expiresAt) <= now) {
        await finalizeAttempt(iid, attempt, { now });
        attempt.status = 'submitted';
        swept++;
      }
    }
    return { attempts, swept };
  }

  // ----- attempts -----
  async function finalizeAttempt(iid, attempt, { now = Date.now() } = {}) {
    const path = base(iid, 'examAttempts', attempt.id);
    const claim = await db.transaction(`${path}/status`, cur => (cur === 'in_progress' ? 'submitted' : undefined));
    if (!claim?.committed) return { alreadySubmitted: true };
    const expired = toMs(attempt.expiresAt) <= now;
    const submittedAt = expired ? toMs(attempt.expiresAt) : now;
    const paper = await db.get(base(iid, 'exams', attempt.examId));
    const parent = paper?.examinationId ? await db.get(base(iid, 'examinations', paper.examinationId)) : null;
    const evaluated = scoreAttempt(attempt.snapshot, attempt.answers || {});
    const record = buildResultRecord({ attempt, evaluated, paper, parent, submittedAt });
    await db.update({
      [`${path}/submittedAt`]: submittedAt,
      [`${path}/result`]: evaluated,
      ...(expired ? { [`${path}/autoSubmitted`]: true } : {}),
      [base(iid, 'results', attempt.id)]: record,
    });
    return { submitted: true, autoSubmitted: expired, record };
  }

  // Repair: attempt marked submitted but its result record is missing (crash between the two writes).
  async function repairMissingResult(iid, attempt) {
    if (attempt.status !== 'submitted') return false;
    if (await db.get(base(iid, 'results', attempt.id))) return false;
    const paper = await db.get(base(iid, 'exams', attempt.examId));
    const parent = paper?.examinationId ? await db.get(base(iid, 'examinations', paper.examinationId)) : null;
    const evaluated = attempt.result || scoreAttempt(attempt.snapshot, attempt.answers || {});
    await db.set(base(iid, 'results', attempt.id), buildResultRecord({ attempt, evaluated, paper, parent, submittedAt: attempt.submittedAt || Date.now() }));
    return true;
  }

  // Auto-submit every in-progress attempt whose server deadline has passed. Optional filter by predicate.
  async function sweepExpired(iid, filter = () => true, now = Date.now()) {
    const attempts = (await db.get(`institutes/${iid}/examAttempts`)) || {};
    let swept = 0;
    for (const [id, a] of Object.entries(attempts)) {
      a.id = a.id || id;
      if (a.status === 'in_progress' && toMs(a.expiresAt) <= now && filter(a)) { await finalizeAttempt(iid, a, { now }); a.status = 'submitted'; swept++; }
    }
    return { attempts, swept };
  }

  return { resetMigrationCache: () => migrated.clear(), getStudentIdentity, isApprovedStudent, studentEligible, matchesStudentTarget, migrateInstitute, ensureMigrated, loadExamination, loadPapers, loadStudentAttempts, loadStudentResults, sweepExpiredForStudent, finalizeAttempt, repairMissingResult, sweepExpired };
}

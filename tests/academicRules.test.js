import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStudentAcademicRelationships } from '../services/academicRules.js';

const valid = {
  academicYearId: 'year-1', departmentId: 'dept-1', courseId: 'course-1',
  semesterId: 'sem-1', classId: 'class-1', sectionId: 'section-a', batchId: 'batch-1'
};
const refs = {
  academicYear: { id: 'year-1' },
  department: { id: 'dept-1' },
  course: { id: 'course-1', departmentId: 'dept-1' },
  semester: { id: 'sem-1', courseId: 'course-1' },
  classRecord: { id: 'class-1', departmentId: 'dept-1', courseId: 'course-1', academicYearId: 'year-1' },
  section: { id: 'section-a', classId: 'class-1' },
  batch: { id: 'batch-1', departmentId: 'dept-1', courseId: 'course-1', classId: 'class-1', academicYearId: 'year-1' }
};

test('accepts a fully consistent student academic assignment', () => {
  assert.equal(validateStudentAcademicRelationships(valid, refs), true);
});

for (const [label, changedRefs, message] of [
  ['course/department', { course: { ...refs.course, departmentId: 'dept-2' } }, /course does not belong to the selected department/],
  ['semester/course', { semester: { ...refs.semester, courseId: 'course-2' } }, /semester does not belong to the selected course/],
  ['class/course', { classRecord: { ...refs.classRecord, courseId: 'course-2' } }, /class does not belong to the selected course/],
  ['class/year', { classRecord: { ...refs.classRecord, academicYearId: 'year-2' } }, /class does not belong to the selected academic year/],
  ['section/class', { section: { ...refs.section, classId: 'class-2' } }, /section does not belong to the selected class/],
  ['batch/class', { batch: { ...refs.batch, classId: 'class-2' } }, /batch does not belong to the selected class/]
]) {
  test(`rejects mismatched ${label} relationship`, () => {
    assert.throws(() => validateStudentAcademicRelationships(valid, { ...refs, ...changedRefs }), message);
  });
}

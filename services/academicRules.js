export function validateStudentAcademicRelationships(assignment = {}, refs = {}) {
  const mismatch = (message) => {
    const error = new Error(message);
    error.status = 400;
    throw error;
  };
  const { department, course, semester, academicYear, classRecord, section, batch } = refs;
  if (course?.departmentId && assignment.departmentId && String(course.departmentId) !== String(assignment.departmentId)) {
    mismatch('Selected course does not belong to the selected department.');
  }
  if (semester?.courseId && assignment.courseId && String(semester.courseId) !== String(assignment.courseId)) {
    mismatch('Selected semester does not belong to the selected course.');
  }
  if (classRecord?.departmentId && assignment.departmentId && String(classRecord.departmentId) !== String(assignment.departmentId)) {
    mismatch('Selected class does not belong to the selected department.');
  }
  if (classRecord?.courseId && assignment.courseId && String(classRecord.courseId) !== String(assignment.courseId)) {
    mismatch('Selected class does not belong to the selected course.');
  }
  if (classRecord?.academicYearId && assignment.academicYearId && String(classRecord.academicYearId) !== String(assignment.academicYearId)) {
    mismatch('Selected class does not belong to the selected academic year.');
  }
  if (section && (!assignment.classId || String(section.classId) !== String(assignment.classId))) {
    mismatch('Selected section does not belong to the selected class.');
  }
  if (batch?.departmentId && assignment.departmentId && String(batch.departmentId) !== String(assignment.departmentId)) {
    mismatch('Selected batch does not belong to the selected department.');
  }
  if (batch?.courseId && assignment.courseId && String(batch.courseId) !== String(assignment.courseId)) {
    mismatch('Selected batch does not belong to the selected course.');
  }
  if (batch?.classId && assignment.classId && String(batch.classId) !== String(assignment.classId)) {
    mismatch('Selected batch does not belong to the selected class.');
  }
  if (batch?.academicYearId && assignment.academicYearId && String(batch.academicYearId) !== String(assignment.academicYearId)) {
    mismatch('Selected batch does not belong to the selected academic year.');
  }
  return true;
}

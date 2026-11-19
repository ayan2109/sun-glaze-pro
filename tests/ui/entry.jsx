import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import StudentExams from '../../../src/pages/StudentExams.jsx';
import StudentExamDetail from '../../../src/pages/StudentExamDetail.jsx';
import StudentExamHistory from '../../../src/pages/StudentExamHistory.jsx';
import StudentResults from '../../../src/pages/StudentResults.jsx';
import ExamRunner from '../../../src/pages/ExamRunner.jsx';
import ExaminationsPage from '../../../src/pages/ExaminationsPage.jsx';
import ExaminationDetail from '../../../src/pages/ExaminationDetail.jsx';
import ExaminationEditor from '../../../src/pages/ExaminationEditor.jsx';

export function mount(path) {
  const el = document.createElement('div'); document.body.appendChild(el);
  const root = createRoot(el);
  root.render(<MemoryRouter initialEntries={[path]}><Routes>
    <Route path="/student/exams" element={<StudentExams />} />
    <Route path="/student/exams/:examId" element={<StudentExamDetail />} />
    <Route path="/student/exams/:examId/papers/:paperId/attempt" element={<ExamRunner />} />
    <Route path="/student/history" element={<StudentExamHistory />} />
    <Route path="/student/results" element={<StudentResults />} />
    <Route path="/app/exams" element={<ExaminationsPage />} />
    <Route path="/app/exams/new" element={<ExaminationEditor />} />
    <Route path="/app/exams/:id" element={<ExaminationDetail />} />
    <Route path="/app/exams/:id/edit" element={<ExaminationEditor />} />
  </Routes></MemoryRouter>);
  return { el, unmount: () => { root.unmount(); el.remove(); } };
}

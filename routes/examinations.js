import { db } from '../config/firebase.js';
import { requireAuth, allow, isInstituteOwner } from '../middleware/auth.js';
import { can, assertScope, inTeacherScope } from '../services/teacherPermissions.js';
import { createExamStore } from '../services/examStore.js';
import { createExaminationsRouter } from './examinationsRouter.js';

export const examStore = createExamStore(db);
export default createExaminationsRouter({ db, store: examStore, requireAuth, allow, can, assertScope, inTeacherScope, isInstituteOwner });

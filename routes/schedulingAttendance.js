import { db } from '../config/firebase.js';
import { requireAuth, isInstituteOwner } from '../middleware/auth.js';
import { createSchedulingAttendanceRouter } from './schedulingAttendanceRouter.js';

export default createSchedulingAttendanceRouter({
  db,
  requireAuth,
  isInstituteOwner,
});

// Safe, idempotent migration of legacy per-paper examination records into parent examinations.
//   npm run migrate:examinations -- --all --dry-run
//   npm run migrate:examinations -- --institute <instituteId> [--backfill-history]
// Never deletes or rewrites historical attempts/results content. --backfill-history only ADDS
// examinationId/paperId reference fields to attempts/results that lack them.
import { db } from '../config/firebase.js';
import { createExamStore } from '../services/examStore.js';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const store = createExamStore(db);

const ids = flag('all') ? Object.keys((await db.get('institutes')) || {}) : value('institute') ? [value('institute')] : [];
if (!ids.length) { console.error('Usage: --all | --institute <id> [--dry-run] [--backfill-history]'); process.exit(1); }
for (const id of ids) {
  const s = await store.migrateInstitute(id, { dryRun: flag('dry-run'), backfillHistory: flag('backfill-history') });
  console.info(`\n[${id}] ${s.dryRun ? 'DRY RUN — ' : ''}parents to create: ${s.parentsCreated}, papers to link: ${s.papersLinked}, history refs: ${s.historyRecordsLinked}`);
  const r = s.report;
  console.info(`  already migrated: ${r.alreadyMigrated}, grouped: ${r.grouped.length}, standalone: ${r.single.length}`);
  for (const a of r.ambiguous) console.warn(`  AMBIGUOUS group ${a.groupId}: ${a.reason} Papers kept separate: ${a.paperIds.join(', ')}`);
  for (const x of r.suggestions) console.warn(`  SUGGESTION (manual merge via POST /api/examinations/:id/absorb): ${x.paperIds.join(', ')}`);
  for (const o of r.orphans) console.warn(`  ORPHAN paper ${o.paperId} references missing examination ${o.examinationId}`);
}
process.exit(0);

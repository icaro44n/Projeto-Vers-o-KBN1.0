/*
Migration script for Kanban Peças (Realtime Database)

- Adds/normalizes idOS for tasks that don't have it
- Ensures idOS uniqueness per user (appends suffix if necessary)

Usage:
  npm install firebase-admin
  node scripts/migrate_tasks.js --serviceAccount=./serviceAccountKey.json --databaseURL=https://<PROJECT>.firebaseio.com

CAUTION: Run only with admin credentials on a backup / non-prod first.
*/

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function usageAndExit() {
  console.log('Usage: node migrate_tasks.js --serviceAccount=./serviceAccountKey.json --databaseURL=https://<PROJECT>.firebaseio.com');
  process.exit(1);
}

const args = process.argv.slice(2);
const opts = {};
args.forEach(a => {
  if (a.startsWith('--serviceAccount=')) opts.serviceAccount = a.split('=')[1];
  else if (a.startsWith('--databaseURL=')) opts.databaseURL = a.split('=')[1];
});
if (!opts.serviceAccount || !opts.databaseURL) usageAndExit();

if (!fs.existsSync(opts.serviceAccount)) {
  console.error('serviceAccount file not found:', opts.serviceAccount);
  process.exit(1);
}

const serviceAccount = require(path.resolve(opts.serviceAccount));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: opts.databaseURL
});

const db = admin.database();

function normalizeIdOS(raw) {
  if (!raw) return null;
  // trim, uppercase, replace spaces with '-', remove duplicate '-'
  let s = String(raw).trim().toUpperCase();
  s = s.replace(/\s+/g, '-');
  // Remove characters not allowed (keep letters, numbers, dash and underscore)
  s = s.replace(/[^A-Z0-9-_]/g, '');
  s = s.replace(/-+/g, '-');
  return s;
}

async function run() {
  const usersSnap = await db.ref('users').once('value');
  if (!usersSnap.exists()) {
    console.log('No users found under /users');
    return;
  }

  const users = usersSnap.val();
  for (const uid of Object.keys(users)) {
    console.log('Processing user', uid);
    const tasksRef = db.ref(`users/${uid}/tasks`);
    const tasksSnap = await tasksRef.once('value');
    if (!tasksSnap.exists()) {
      console.log('  no tasks for', uid);
      continue;
    }
    const tasks = tasksSnap.val();

    // Build a map of existing idOS to detect conflicts
    const existingIdOS = {};
    for (const [taskKey, taskObj] of Object.entries(tasks)) {
      if (taskObj && taskObj.idOS) {
        const norm = normalizeIdOS(taskObj.idOS) || taskObj.idOS;
        existingIdOS[norm] = existingIdOS[norm] || [];
        existingIdOS[norm].push(taskKey);
      }
    }

    for (const [taskKey, taskObj] of Object.entries(tasks)) {
      let changed = false;
      let updates = {};

      if (!taskObj) continue;

      // If there's no idOS, try to derive from fields: prefer existing 'id' field, otherwise use key
      if (!taskObj.idOS) {
        const src = taskObj.id || taskKey;
        const norm = normalizeIdOS(src) || (`TASK-${taskKey.substring(0,6).toUpperCase()}`);

        // Ensure uniqueness: if norm already exists in existingIdOS, append suffix
        let candidate = norm;
        let suffix = 1;
        while (existingIdOS[candidate]) {
          candidate = `${norm}-${suffix}`;
          suffix += 1;
        }

        updates.idOS = candidate;
        existingIdOS[candidate] = [taskKey];
        changed = true;
        console.log(`  task ${taskKey}: adding idOS = ${candidate}`);
      } else {
        // Normalize existing idOS and update if differs
        const norm = normalizeIdOS(taskObj.idOS);
        if (norm && norm !== taskObj.idOS) {
          // ensure uniqueness
          let candidate = norm;
          let suffix = 1;
          while (existingIdOS[candidate] && existingIdOS[candidate].indexOf(taskKey) === -1) {
            candidate = `${norm}-${suffix}`;
            suffix += 1;
          }
          updates.idOS = candidate;
          existingIdOS[candidate] = existingIdOS[candidate] || [];
          existingIdOS[candidate].push(taskKey);
          changed = true;
          console.log(`  task ${taskKey}: normalizing idOS ${taskObj.idOS} -> ${candidate}`);
        }
      }

      if (changed) {
        try {
          await tasksRef.child(taskKey).update(updates);
        } catch (err) {
          console.error('    failed to update', taskKey, err.message);
        }
      }
    }
  }

  console.log('Migration finished');
  process.exit(0);
}

run().catch(err => {
  console.error('Migration error', err);
  process.exit(2);
});

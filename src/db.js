import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDatabase(directory) {
  if (directory !== ':memory:') mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(directory === ':memory:' ? directory : join(directory, 'manta.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, user_id TEXT NOT NULL, actor_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS activity (day TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, messages INTEGER NOT NULL DEFAULT 0, voice_seconds INTEGER NOT NULL DEFAULT 0, social_seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day,user_id,channel_id));
    CREATE TABLE IF NOT EXISTS members (user_id TEXT PRIMARY KEY, joined INTEGER NOT NULL, departed INTEGER);
    CREATE TABLE IF NOT EXISTS movements (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, time INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS processed (id TEXT PRIMARY KEY, time INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS records_kind ON records(kind,status);
    CREATE INDEX IF NOT EXISTS activity_day ON activity(day);
    CREATE INDEX IF NOT EXISTS movement_time ON movements(time);`);
  const defaults = { logChannel: '', welcomeChannel: '', ticketCategory: '', supportRole: '', digestChannel: '', digestDay: 1, excludedChannels: [], selfRoles: [], onboardingText: 'Welcome! Read the rules and choose your roles.', reminders: true, retentionDays: 90, joinAlertCount: 10, joinAlertMinutes: 5 };
  db.prepare('INSERT OR IGNORE INTO settings VALUES (1,?)').run(JSON.stringify(defaults));
  db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('tracking_since', String(Date.now()));
  const settings = () => ({ ...defaults, ...JSON.parse(db.prepare('SELECT value FROM settings WHERE id=1').get().value) });
  const record = (kind, user, actor, data, status = 'open') => Number(db.prepare('INSERT INTO records(kind,user_id,actor_id,status,data,created,updated) VALUES (?,?,?,?,?,?,?)').run(kind,user,actor,status,JSON.stringify(data),Date.now(),Date.now()).lastInsertRowid);
  const get = id => {
    const row = db.prepare('SELECT * FROM records WHERE id=?').get(id);
    return row ? { ...row, data: JSON.parse(row.data) } : null;
  };
  const list = (kind, limit = 200) => db.prepare('SELECT * FROM records WHERE kind=? ORDER BY id DESC LIMIT ?').all(kind,limit).map(r => ({ ...r, data: JSON.parse(r.data) }));
  function update(id, status, data) { db.prepare('UPDATE records SET status=?,data=?,updated=? WHERE id=?').run(status,JSON.stringify(data),Date.now(),id); }
  function activity(user, channel, messages = 0, voice = 0, social = 0, at = Date.now()) {
    db.prepare(`INSERT INTO activity VALUES (?,?,?,?,?,?) ON CONFLICT(day,user_id,channel_id) DO UPDATE SET messages=messages+excluded.messages,voice_seconds=voice_seconds+excluded.voice_seconds,social_seconds=social_seconds+excluded.social_seconds`).run(new Date(at).toISOString().slice(0,10),user,channel,messages,voice,social);
  }
  function once(id) { return db.prepare('INSERT OR IGNORE INTO processed VALUES (?,?)').run(id,Date.now()).changes === 1; }
  function stats(days = 7, user = null) {
    const since = new Date(Date.now() - (days-1)*86400000).toISOString().slice(0,10);
    const rows = db.prepare('SELECT * FROM activity WHERE day>=? AND (? IS NULL OR user_id=?)').all(since,user,user).filter(r=>!settings().excludedChannels.includes(r.channel_id));
    const grouped = (key) => Object.values(rows.reduce((a,r)=> { const id=r[key]; a[id]??={name:id,messages:0,voice_seconds:0,social_seconds:0,users:new Set()}; a[id].messages+=r.messages; a[id].voice_seconds+=r.voice_seconds; a[id].social_seconds+=r.social_seconds; a[id].users.add(r.user_id); return a; },{})).map(r=>({...r,users:r.users.size}));
    const start = Date.parse(since);
    const movement = db.prepare('SELECT kind,COUNT(*) AS count FROM movements WHERE time>=? GROUP BY kind').all(start);
    const joins = movement.find(r=>r.kind==='join')?.count||0, leaves=movement.find(r=>r.kind==='leave')?.count||0;
    const cohort = db.prepare('SELECT * FROM members WHERE joined>=? AND joined<=?').all(start,Date.now()-7*86400000);
    const participated = (m, low, high) => db.prepare('SELECT 1 FROM activity WHERE user_id=? AND day>=? AND day<? AND (messages>0 OR voice_seconds>0) LIMIT 1').get(m.user_id,new Date(m.joined+low*86400000).toISOString().slice(0,10),new Date(m.joined+high*86400000).toISOString().slice(0,10));
    const returningCohort=cohort.filter(m=>m.joined<=Date.now()-14*86400000);
    return { days, since, trackingSince:Number(db.prepare('SELECT value FROM meta WHERE key=?').get('tracking_since').value), activeMembers:new Set(rows.map(r=>r.user_id)).size, messages:rows.reduce((n,r)=>n+r.messages,0), voiceSeconds:rows.reduce((n,r)=>n+r.voice_seconds,0), socialSeconds:rows.reduce((n,r)=>n+r.social_seconds,0), joins, leaves, netGrowth:joins-leaves, daily:grouped('day'), channels:grouped('channel_id'), members:grouped('user_id'), activation:{eligible:cohort.length,active:cohort.filter(m=>participated(m,0,7)).length}, returning:{eligible:returningCohort.length,active:returningCohort.filter(m=>participated(m,7,14)).length} };
  }
  function cleanup() {
    const cutoff = Date.now()-settings().retentionDays*86400000;
    db.prepare('DELETE FROM activity WHERE day<?').run(new Date(cutoff).toISOString().slice(0,10));
    db.prepare("DELETE FROM records WHERE updated<? AND NOT (kind='incident' AND status IN ('active','failed','applying')) AND NOT (kind='job' AND status IN ('scheduled','sending','review_required'))").run(cutoff);
    for(const table of ['movements','processed']) db.prepare(`DELETE FROM ${table} WHERE time<?`).run(cutoff);
    db.prepare('DELETE FROM members WHERE departed IS NOT NULL AND departed<?').run(cutoff);
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  }
  return { db, settings, saveSettings:s=>db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(s)), record, get, list, update, activity, stats, once, cleanup };
}

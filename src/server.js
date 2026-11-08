import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { openDatabase } from './db.js';
import { createBot } from './bot.js';
import { settingsSchema, actionSchema, jobSchema, snowflake, reason, canManage } from './validation.js';

export function createApp({store,bot,config}) {
  const app=express(), production=config.production;
  app.disable('x-powered-by');
  app.set('trust proxy',config.proxyHops||false);
  app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'","data:"],connectSrc:["'self'"],frameAncestors:["'none'"],upgradeInsecureRequests:production?[]:null}},strictTransportSecurity:production?{maxAge:15552000,includeSubDomains:false}:false}));
  app.use('/api',rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false}));
  app.use('/auth',rateLimit({windowMs:60000,limit:20,standardHeaders:'draft-8',legacyHeaders:false}));
  app.use(express.json({limit:'24kb'}));
  class SQLiteSession extends session.Store {
    get(sid,cb){try {const r=store.db.prepare('SELECT value FROM sessions WHERE sid=? AND expires>?').get(sid,Date.now());cb(null,r?JSON.parse(r.value):null);}catch(e){cb(e);}}
    set(sid,value,cb){try {store.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?)').run(sid,JSON.stringify(value),Date.now()+8*3600000);cb?.();}catch(e){cb?.(e);}}
    destroy(sid,cb){try {store.db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);cb?.();}catch(e){cb?.(e);}}
  }
  app.use(session({name:'manta.sid',secret:config.sessionSecret,store:new SQLiteSession(),resave:false,saveUninitialized:false,cookie:{httpOnly:true,secure:production,sameSite:'lax',maxAge:8*3600000}}));
  app.use('/api',(req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(!req.session.csrf)req.session.csrf=randomBytes(32).toString('hex');
    if(!['GET','HEAD'].includes(req.method)) {
      const token=req.get('X-CSRF-Token')||'';
      if(req.get('Origin')!==config.publicUrl||!/^[a-f0-9]{64}$/.test(token)||!timingSafeEqual(Buffer.from(token),Buffer.from(req.session.csrf)))return res.status(403).json({error:'Request verification failed. Reload the page.'});
      if(!req.is('application/json'))return res.status(415).json({error:'JSON is required.'});
    }
    next();
  });
  const logged=(req,res,next)=>req.session.user?next():res.status(401).json({error:'Sign in with Discord.'});
  const staff=async(req,res,next)=>{try {req.actor=await bot.actor(req.session.user.id);next();}catch{res.status(403).json({error:'Current Manage Server permission and server membership are required.'});}};
  const member=async(req,res,next)=>{try {await bot.guild().members.fetch({user:req.session.user.id,force:true});next();}catch{res.status(403).json({error:'Current server membership is required.'});}};
  const mutation=(req,res,next)=>{const id=req.get('X-Request-ID');if(!z.string().uuid().safeParse(id).success)return res.status(400).json({error:'A unique request ID is required.'});if(!store.once(`request:${req.session.user.id}:${id}`))return res.status(409).json({error:'Request already received. Check the record before trying again.'});next();};
  async function discord(path,options={}) { const r=await fetch(`https://discord.com/api/v10${path}`,{...options,signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('Discord sign-in could not be completed. Please try again.');return r.json(); }
  app.get('/auth/login',(req,res)=>{
    if(!config.configured)return res.status(503).send('Configure the cloud environment variables first.');
    req.session.oauthState=randomBytes(32).toString('hex');req.session.oauthAt=Date.now();
    const url=new URL('https://discord.com/oauth2/authorize');url.search=new URLSearchParams({client_id:config.clientId,redirect_uri:`${config.publicUrl}/auth/callback`,response_type:'code',scope:'identify',state:req.session.oauthState}).toString();
    req.session.save(e=>e?res.status(500).send('Could not start sign-in.'):res.redirect(url.href));
  });
  app.get('/auth/callback',async(req,res,next)=>{
    try {
      if(typeof req.query.state!=='string'||req.query.state!==req.session.oauthState||Date.now()-req.session.oauthAt>600000||typeof req.query.code!=='string')return res.status(400).send('Sign-in expired or invalid. Start again.');
      delete req.session.oauthState;
      const token=await discord('/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,grant_type:'authorization_code',code:req.query.code,redirect_uri:`${config.publicUrl}/auth/callback`})});
      const user=await discord('/users/@me',{headers:{Authorization:`Bearer ${token.access_token}`}});
      await new Promise((resolve,reject)=>req.session.regenerate(e=>e?reject(e):resolve()));
      req.session.user={id:user.id,name:user.global_name||user.username};req.session.csrf=randomBytes(32).toString('hex');
      req.session.save(e=>e?next(e):res.redirect('/'));
    } catch(e){next(e);}
  });
  app.get('/healthz',(req,res)=>res.status(config.configured&&!bot?.client.isReady()?503:200).json({service:'manta',configured:config.configured,connected:bot?.client.isReady()||false}));
  app.get('/api/me',async(req,res)=>{
    let manage=false;if(req.session.user&&bot?.client.isReady())try{manage=canManage(await bot.guild().members.fetch({user:req.session.user.id,force:true}),bot.guild());}catch{}
    res.json({user:req.session.user||null,manage,csrf:req.session.csrf,configured:config.configured,connected:bot?.client.isReady()||false,trackingSince:Number(store.db.prepare('SELECT value FROM meta WHERE key=?').get('tracking_since').value)});
  });
  app.post('/api/logout',logged,(req,res,next)=>req.session.destroy(e=>{if(e)return next(e);res.clearCookie('manta.sid',{httpOnly:true,secure:production,sameSite:'lax'});res.json({ok:true});}));
  app.use('/api/member',logged);
  app.get('/api/member/stats',member,(req,res)=>res.json(store.stats(30,req.session.user.id)));
  app.get('/api/member/records',(req,res)=>res.json(['case','report','appeal','ticket'].flatMap(k=>store.list(k,10000)).filter(r=>r.user_id===req.session.user.id&&r.data.type!=='note').map(r=>({id:r.id,kind:r.kind,status:r.status,created:r.created,data:r.kind==='case'?{type:r.data.type,reason:r.data.reason}: {subject:r.data.subject,details:r.data.details,reason:r.data.reason,case:r.data.case}}))));
  app.post('/api/member/report',member,mutation,async(req,res)=>{const body=z.object({details:reason}).strict().parse(req.body);res.json(await bot.report(req.session.user.id,body));});
  app.post('/api/member/appeal',mutation,async(req,res)=>{const body=z.object({case:z.number().int().positive(),reason}).strict().parse(req.body);const c=store.get(body.case);if(c?.kind!=='case'||c.user_id!==req.session.user.id)return res.status(404).json({error:'Case not found.'});res.json(await bot.report(req.session.user.id,body,'appeal'));});
  app.post('/api/member/ticket',member,mutation,async(req,res)=>{const {subject}=z.object({subject:z.string().trim().min(3).max(500)}).strict().parse(req.body);res.json(await bot.ticket(req.session.user.id,subject));});
  app.post('/api/member/role',member,mutation,async(req,res)=>{const {role}=z.object({role:snowflake}).strict().parse(req.body);res.json(await bot.role(req.session.user.id,role));});
  app.use('/api/admin',logged,staff);
  app.use('/api/admin',(req,res,next)=>req.method==='POST'?mutation(req,res,next):next());
  app.get('/api/admin/reference',async(req,res)=>res.json(await bot.reference()));
  app.get('/api/admin/settings',(req,res)=>res.json(store.settings()));
  app.post('/api/admin/settings',async(req,res)=>{
    const s=settingsSchema.parse(req.body), ref=await bot.reference();
    for(const id of [s.logChannel,s.welcomeChannel,s.digestChannel,...s.excludedChannels].filter(Boolean))if(!ref.channels.some(c=>c.id===id))throw new Error('A selected channel does not belong to this server.');
    for(const id of s.selfRoles)if(!ref.roles.some(r=>r.id===id&&r.selfServiceSafe))throw new Error('Self-service roles must have no permissions.');
    if(s.supportRole&&!ref.roles.some(r=>r.id===s.supportRole&&r.id!==ref.id))throw new Error('Choose a staff support role.');
    if(s.ticketCategory&&!ref.channels.some(c=>c.id===s.ticketCategory&&c.type===4))throw new Error('Choose a channel category for tickets.');
    const old=store.settings();store.saveSettings(s);await bot.log('Settings updated',{actor:req.actor.id,changed:Object.keys(s).filter(k=>JSON.stringify(s[k])!==JSON.stringify(old[k]))}).catch(()=>{});res.json(s);
  });
  app.get('/api/admin/stats',(req,res)=>{const days=z.coerce.number().int().min(1).max(365).parse(req.query.days||7);const stats=store.stats(days);const reports=store.list('report',10000);const answered=reports.filter(r=>r.data.firstResponse);const resolved=reports.filter(r=>r.status==='resolved');res.json({...stats,openReports:reports.filter(r=>!['resolved','dismissed'].includes(r.status)).length,avgFirstResponseMinutes:answered.length?answered.reduce((a,r)=>a+(r.data.firstResponse-r.created)/60000,0)/answered.length:null,avgResolutionMinutes:resolved.length?resolved.reduce((a,r)=>a+(r.updated-r.created)/60000,0)/resolved.length:null});});
  app.get('/api/admin/records/:kind',(req,res)=>{const kind=z.enum(['case','report','appeal','ticket','log','job','incident']).parse(req.params.kind);res.json(store.list(kind,1000));});
  app.post('/api/admin/moderate',async(req,res)=>res.json(await bot.moderate(req.actor.id,actionSchema.parse(req.body))));
  app.post('/api/admin/records/:id',async(req,res)=>{const id=z.coerce.number().int().positive().parse(req.params.id);const b=z.object({status:z.enum(['open','claimed','resolved','escalated','dismissed']),note:reason}).strict().parse(req.body);res.json(await bot.manageRecord(req.actor.id,id,b.status,b.note));});
  app.get('/api/admin/tickets/:id/transcript',async(req,res)=>{const id=z.coerce.number().int().positive().parse(req.params.id);const data=await bot.transcript(req.actor.id,id);res.set('Content-Disposition',`attachment; filename="ticket-${id}.json"`).json(data);});
  app.get('/api/admin/audit',async(req,res)=>res.json(await bot.audit()));
  app.post('/api/admin/role-panel',async(req,res)=>{const b=z.object({channel:snowflake}).strict().parse(req.body);await bot.rolePanel(req.actor.id,b.channel);res.json({ok:true});});
  app.post('/api/admin/incidents',async(req,res)=>{const b=z.object({mode:z.enum(['lock','slowmode']),channels:z.array(snowflake).min(1).max(20),seconds:z.number().int().min(0).max(21600),reason}).strict().parse(req.body);res.json(await bot.incident(req.actor.id,b.mode,[...new Set(b.channels)],b.seconds,b.reason));});
  app.post('/api/admin/incidents/:id/restore',async(req,res)=>res.json(await bot.restore(req.actor.id,z.coerce.number().int().positive().parse(req.params.id))));
  app.post('/api/admin/jobs',(req,res)=>{if(!req.actor.permissions.has('ManageMessages'))return res.status(403).json({error:'Manage Messages is required.'});const b=jobSchema.parse(req.body);const id=store.record('job','',req.actor.id,b,'scheduled');res.json(store.get(id));});
  app.post('/api/admin/jobs/:id/cancel',(req,res)=>{const r=store.get(z.coerce.number().int().positive().parse(req.params.id));if(r?.kind!=='job'||r.status!=='scheduled')return res.status(409).json({error:'Only scheduled announcements can be cancelled.'});store.update(r.id,'cancelled',r.data);res.json({ok:true});});
  app.get('/api/admin/housekeeping',(req,res)=>{
    const rows=store.db.prepare('SELECT channel_id,MAX(day) AS last_day FROM activity GROUP BY channel_id').all();
    res.json(rows.filter(r=>r.last_day<new Date(Date.now()-30*86400000).toISOString().slice(0,10)).map(r=>({...r,suggestion:'Review for archival; no automatic deletion.'})));
  });
  app.use('/api',(req,res)=>res.status(404).json({error:'Endpoint not found.'}));
  app.get('/vendor/bootstrap.css',(req,res)=>res.sendFile(fileURLToPath(new URL('../node_modules/bootstrap/dist/css/bootstrap.min.css',import.meta.url))));
  app.use(express.static(config.webDir||fileURLToPath(new URL('../public',import.meta.url))));
  app.use((error,req,res,next)=>{console.error('Request failed:',error.code||error.name);const validation=error instanceof z.ZodError;res.status(validation?400:error.status===413?413:400).json({error:validation?error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '):error.message?.slice(0,500)||'Request failed.'});});
  return app;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const env=process.env, configured=['DISCORD_CLIENT_ID','DISCORD_CLIENT_SECRET','DISCORD_TOKEN','DISCORD_GUILD_ID'].every(k=>env[k]);
  const publicUrl=(env.PUBLIC_URL||'http://localhost:3000').replace(/\/$/,'');
  const config={configured,production:env.NODE_ENV==='production',publicUrl,clientId:env.DISCORD_CLIENT_ID,clientSecret:env.DISCORD_CLIENT_SECRET,token:env.DISCORD_TOKEN,guildId:env.DISCORD_GUILD_ID,messageContent:env.MESSAGE_CONTENT_ENABLED==='true',sessionSecret:env.SESSION_SECRET||randomBytes(32).toString('hex'),proxyHops:Number(env.TRUST_PROXY_HOPS||0),webDir:env.WEB_DIR};
  if(config.production&&(!env.SESSION_SECRET||env.SESSION_SECRET.length<32||!publicUrl.startsWith('https://')))throw new Error('Production requires HTTPS PUBLIC_URL and a SESSION_SECRET of at least 32 characters.');
  if(!Number.isInteger(config.proxyHops)||config.proxyHops<0||config.proxyHops>3)throw new Error('Invalid TRUST_PROXY_HOPS.');
  const store=openDatabase(env.DATA_DIR||'data');
  const bound=store.db.prepare('SELECT value FROM meta WHERE key=?').get('guild_id')?.value;
  if(bound&&configured&&bound!==config.guildId)throw new Error('This database belongs to another server. Use a separate data volume.');
  if(configured)store.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('guild_id',config.guildId);
  // Pending sends are never retried automatically after a crash; staff must review for duplicates.
  store.db.prepare("UPDATE records SET status='review_required' WHERE kind IN ('job','case') AND status IN ('sending','pending')").run();
  const bot=configured?createBot(store,config):null;
  const server=createApp({store,bot,config}).listen(Number(env.PORT||3000),'0.0.0.0',()=>console.log('Manta HTTP service started. Discord configured:',Boolean(configured)));
  if(bot)bot.start().catch(e=>{console.error('Bot login failed:',e.code||e.name);bot.close();server.close();process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{bot?.close();server.close(()=>{store.db.close();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();});
}

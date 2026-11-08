import { Client, GatewayIntentBits as I, PermissionFlagsBits as P, ChannelType, MessageFlags, ApplicationCommandType, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { canManage, checkHierarchy, actionSchema } from './validation.js';
import { createIntegrations } from './integrations.js';

export function createBot(store, config) {
  const client = new Client({ intents:[I.Guilds,I.GuildMembers,I.GuildMessages,I.GuildVoiceStates,I.GuildModeration,I.GuildWebhooks,...(config.messageContent?[I.MessageContent]:[])], allowedMentions:{parse:[]} });
  const guild = () => { const g=client.guilds.cache.get(config.guildId); if(!g || !client.isReady()) throw new Error('Bot is not connected to the configured server.'); return g; };
  const safe = fn => (...args)=>Promise.resolve(fn(...args)).catch(e=>console.error('Discord operation failed:',e.code||e.name));
  const channel = async id => { const c=await guild().channels.fetch(id); if(!c || !c.isTextBased() || !c.send) throw new Error('Choose a text channel in this server.'); return c; };
  async function notify(text) { const id=store.settings().logChannel; if(id) await (await channel(id)).send({content:text.slice(0,1950),allowedMentions:{parse:[]}}); }
  async function log(type, data) { store.record('log','',client.user?.id||'system',{type,...data},'recorded'); await notify(`**${type}**\n${JSON.stringify(data).slice(0,1700)}`); }
  async function actor(id) { const m=await guild().members.fetch({user:id,force:true}); if(!canManage(m,guild())) throw new Error('Manage Server permission is required.'); return m; }
  const integrations=createIntegrations(store,{actor,channel},{secret:config.sessionSecret,twitchId:config.twitchId,twitchSecret:config.twitchSecret});
  function requirePermission(member, flag) { if(!member.permissions.has(flag)) throw new Error('Your Discord permissions do not allow this action.'); }
  async function moderate(actorId, input) {
    const data=actionSchema.parse(input), g=guild(), a=await actor(actorId);
    const flags={warn:P.ModerateMembers, note:P.ModerateMembers, timeout:P.ModerateMembers, untimeout:P.ModerateMembers,kick:P.KickMembers,ban:P.BanMembers,unban:P.BanMembers};
    requirePermission(a,flags[data.type]);
    const target=data.type==='unban'?null:await g.members.fetch({user:data.user,force:true});
    if(target) checkHierarchy(a,target,g);
    const id=store.record('case',data.user,actorId,data,'pending');
    try {
      const why=`Case #${id} by ${actorId}: ${data.reason}`.slice(0,500);
      if(data.type==='timeout' || data.type==='untimeout') { if(!target.moderatable) throw new Error('Bot cannot timeout this member. Check its role and permissions.'); await target.timeout(data.type==='timeout'?data.minutes*60000:null,why); }
      if(data.type==='kick') { if(!target.kickable) throw new Error('Bot cannot kick this member.'); await target.kick(why); }
      if(data.type==='ban') { if(!target.bannable) throw new Error('Bot cannot ban this member.'); await target.ban({reason:why,deleteMessageSeconds:0}); }
      if(data.type==='unban') await g.bans.remove(data.user,why);
      store.update(id,'completed',data);
    } catch(e) { store.update(id,'failed',{...data,error:e.message}); throw e; }
    if(data.type==='warn') await target.send(`Warning in ${g.name}, case #${id}: ${data.reason}`).catch(()=>store.record('log',data.user,actorId,{type:'Warning DM could not be delivered',case:id},'recorded'));
    await notify(`Case #${id}: ${data.type} for ${data.user}. Reason: ${data.reason}`).catch(()=>{});
    return store.get(id);
  }
  async function report(userId, data, kind='report') {
    const id=store.record(kind,userId,userId,data);
    await notify(`New ${kind} #${id} from ${userId}`).catch(()=>{});
    return store.get(id);
  }
  async function manageRecord(actorId,id,status,note) {
    await actor(actorId);
    const r=store.get(id); if(!r || !['report','appeal','ticket'].includes(r.kind)) throw new Error('Record not found.');
    const closed = ['resolved','dismissed'];
    if(r.kind==='ticket' && r.data.channel && (closed.includes(status)||closed.includes(r.status))) {
      const c=await channel(r.data.channel);
      const closing=closed.includes(status);
      await c.permissionOverwrites.edit(r.user_id,{SendMessages:!closing}, {reason:`Ticket #${id} updated by ${actorId}`});
      await c.send(closing?'This ticket is closed. Staff can still review its history.':'This ticket has been reopened.');
    }
    const history=[...(r.data.history||[]),{actor:actorId,status,note,at:Date.now()}];
    const firstResponse=r.data.firstResponse||Date.now();
    store.update(id,status,{...r.data,assigned:status==='claimed'?actorId:r.data.assigned,firstResponse,history});
    return store.get(id);
  }
  async function ticket(userId,subject) {
    const g=guild(), s=store.settings();
    if(!s.supportRole) throw new Error('Staff must configure a support role first.');
    const existing=store.list('ticket',10000).find(r=>r.user_id===userId && !['resolved','dismissed','failed'].includes(r.status));
    if(existing) throw new Error(`You already have ticket #${existing.id}.`);
    const id=store.record('ticket',userId,userId,{subject},'creating');
    try {
      const c=await g.channels.create({name:`ticket-${id}`,type:ChannelType.GuildText,parent:s.ticketCategory||undefined,permissionOverwrites:[{id:g.id,deny:[P.ViewChannel]},{id:userId,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory]},{id:s.supportRole,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory]},{id:client.user.id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.ManageChannels]}]});
      store.update(id,'open',{subject,channel:c.id});
      await c.send({content:`Ticket #${id}\n${subject}`,allowedMentions:{parse:[]}});
      return store.get(id);
    } catch(e) { const r=store.get(id); if(r.data.channel) store.update(id,'open',{...r.data,noticeFailed:true}); else store.update(id,'failed',{subject}); throw e; }
  }
  async function transcript(actorId,id) {
    await actor(actorId); const r=store.get(id); if(r?.kind!=='ticket' || !r.data.channel) throw new Error('Ticket not found.');
    const c=await channel(r.data.channel); let before, all=[];
    // shortcut: exports cap at 5,000 messages; add streaming exports for larger support histories.
    for(let i=0;i<50;i++) { const batch=await c.messages.fetch({limit:100,...(before?{before}:{})}); if(!batch.size) break; all.push(...batch.values()); before=batch.last().id; if(batch.size<100) break; }
    return {notice:'Up to 5,000 available messages. Message text may be unavailable without the Message Content intent; attachments are linked, not archived.',messages:all.reverse().map(m=>({id:m.id,author:m.author.id,at:m.createdAt,content:m.content,attachments:[...m.attachments.values()].map(a=>a.url)}))};
  }
  async function role(userId,roleId) {
    const g=guild(), r=await g.roles.fetch(roleId), me=await g.members.fetchMe();
    await g.channels.fetch();
    if(!store.settings().selfRoles.includes(roleId)||!r||r.managed||r.id===g.id||r.permissions.bitfield!==0n||r.comparePositionTo(me.roles.highest)>=0||g.channels.cache.some(c=>(c.permissionOverwrites?.cache.get(roleId)?.allow.bitfield||0n)!==0n)) throw new Error('Self-service roles must have no server or channel permission grants and sit below the bot.');
    const m=await g.members.fetch({user:userId,force:true});
    if(m.roles.cache.has(r.id)) await m.roles.remove(r); else await m.roles.add(r);
    return {assigned:m.roles.cache.has(r.id)};
  }
  async function rolePanel(actorId,channelId) {
    const a=await actor(actorId); requirePermission(a,P.ManageRoles);
    const roles=(await guild().roles.fetch()).filter(r=>store.settings().selfRoles.includes(r.id)&&r.permissions.bitfield===0n&&!r.managed);
    if(!roles.size) throw new Error('Configure at least one permission-free self-service role.');
    await (await channel(channelId)).send({content:store.settings().onboardingText,components:[new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('selfrole').setPlaceholder('Choose a role to toggle').addOptions(roles.map(r=>({label:r.name.slice(0,100),value:r.id}))))]});
  }
  async function incident(actorId,mode,ids,seconds,reason) {
    const a=await actor(actorId); requirePermission(a,P.ManageChannels);
    const g=guild(), id=store.record('incident','',actorId,{mode,reason,channels:[]},'applying');
    let snapshots=[];
    try {
      for(const channelId of ids) {
        if(store.list('incident',10000).some(r=>r.id!==id&&['active','failed','applying'].includes(r.status)&&r.data.channels?.some(c=>c.id===channelId&&!c.restored))) throw new Error('A selected channel already has an incident snapshot. Restore it first.');
        const c=await channel(channelId);
        if(c.type!==ChannelType.GuildText) throw new Error('Incident controls require standard text channels.');
        const old=c.permissionOverwrites.cache.get(g.id);
        const snapshot={id:c.id,slowmode:c.rateLimitPerUser,send:old?.allow.has(P.SendMessages)?true:old?.deny.has(P.SendMessages)?false:null};
        snapshots.push(snapshot); store.update(id,'applying',{mode,reason,channels:snapshots});
        if(mode==='lock') await c.permissionOverwrites.edit(g.id,{SendMessages:false},{reason});
        else await c.setRateLimitPerUser(seconds,reason);
      }
      store.update(id,'active',{mode,reason,channels:snapshots});
    } catch(e) { store.update(id,'failed',{mode,reason,channels:snapshots,error:e.message}); throw e; }
    return store.get(id);
  }
  async function restore(actorId,id) {
    const a=await actor(actorId); requirePermission(a,P.ManageChannels);
    const r=store.get(id); if(r?.kind!=='incident'||!['active','failed','applying'].includes(r.status)) throw new Error('No active incident found.');
    for(const s of r.data.channels) {
      if(s.restored) continue;
      const c=await channel(s.id);
      if(r.data.mode==='lock') await c.permissionOverwrites.edit(guild().id,{SendMessages:s.send},{reason:`Restore incident #${id}`});
      else await c.setRateLimitPerUser(s.slowmode,`Restore incident #${id}`);
      s.restored=true; store.update(id,r.status,r.data);
    }
    store.update(id,'restored',r.data); return store.get(id);
  }
  async function audit() {
    const g=guild(); await g.roles.fetch(); await g.channels.fetch();
    const risks=[];
    for(const r of g.roles.cache.values()) if([P.Administrator,P.ManageGuild,P.ManageRoles,P.ManageWebhooks,P.BanMembers].some(p=>r.permissions.has(p,false))) risks.push({type:'Privileged role',id:r.id,name:r.name,detail:r.permissions.toArray().join(', ')});
    for(const c of g.channels.cache.values()) {
      if(c.parentId&&!c.permissionsLocked) risks.push({type:'Category permissions differ',id:c.id,name:c.name});
      if(c.permissionsFor(g.roles.everyone)?.has(P.ViewChannel)) risks.push({type:'Visible to @everyone',id:c.id,name:c.name});
    }
    return risks;
  }
  function eligible(c) { return c && c.id!==c.guild.afkChannelId&&!store.settings().excludedChannels.includes(c.id)&&c.permissionsFor(c.guild.roles.everyone)?.has(P.ViewChannel); }
  const voice=new Map(); let voiceLast=Date.now();
  function flushVoice() {
    const now=Date.now();
    const from=voiceLast; voiceLast=now;
    if(!client.isReady()||now-from>90000) return;
    for(const [user,c] of voice) {
      if(!eligible(c)) continue;
      let start=from;
      while(start<now) { const end=Math.min(now,Date.parse(new Date(start).toISOString().slice(0,10))+86400000); const seconds=(end-start)/1000; store.activity(user,c.id,0,seconds,c.members.filter(m=>!m.user.bot).size>=2?seconds:0,start); start=end; }
    }
  }
  function seedVoice() { voice.clear(); voiceLast=Date.now(); for(const v of guild().voiceStates.cache.values()) if(v.channel&&!v.member?.user.bot) voice.set(v.id,v.channel); }
  client.on('voiceStateUpdate',safe(async(old,v)=>{ if(v.guild.id!==config.guildId||v.member?.user.bot)return; flushVoice(); voice.delete(v.id); if(v.channel)voice.set(v.id,v.channel); }));
  client.on('messageCreate',safe(async m=>{ if(m.guildId===config.guildId&&!m.author.bot&&eligible(m.channel)&&store.once(m.id)) store.activity(m.author.id,m.channelId,1); }));
  client.on('guildMemberAdd',safe(async m=>{
    if(m.guild.id!==config.guildId||m.user.bot)return;
    const now=Date.now(); store.db.prepare('INSERT INTO members VALUES (?,?,NULL) ON CONFLICT(user_id) DO UPDATE SET joined=excluded.joined,departed=NULL').run(m.id,now);
    store.db.prepare('INSERT INTO movements(user_id,kind,time) VALUES (?,?,?)').run(m.id,'join',now);
    const s=store.settings(); if(s.welcomeChannel) await (await channel(s.welcomeChannel)).send({content:`Welcome <@${m.id}>!\n${s.onboardingText}`,allowedMentions:{users:[m.id]}});
    const count=store.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE kind='join' AND time>?").get(now-s.joinAlertMinutes*60000).n;
    if(count>=s.joinAlertCount) { const last=Number(store.db.prepare('SELECT value FROM meta WHERE key=?').get('join_alert')?.value||0); if(now-last>s.joinAlertMinutes*60000) { store.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('join_alert',String(now)); await log('Join spike',{count,minutes:s.joinAlertMinutes}); } }
  }));
  client.on('guildMemberRemove',safe(async m=>{ if(m.guild.id!==config.guildId||m.user.bot)return; store.db.prepare('UPDATE members SET departed=? WHERE user_id=?').run(Date.now(),m.id); store.db.prepare('INSERT INTO movements(user_id,kind,time) VALUES (?,?,?)').run(m.id,'leave',Date.now()); }));
  client.on('guildAuditLogEntryCreate',safe(async(entry,g)=>{ if(g.id===config.guildId&&store.once(`audit:${entry.id}`)) await log('Server change',{action:entry.action,actor:entry.executorId,target:entry.targetId,reason:entry.reason,changes:entry.changes}); }));
  client.on('shardDisconnect',()=>{voice.clear();store.record('log','','system',{type:'Gateway disconnected; tracking gap begins'},'recorded');});
  client.on('shardResume',safe(async()=>{seedVoice();await log('Gateway reconnected',{note:'Events during the disconnect may be incomplete.'});}));
  client.on('error',e=>console.error('Discord client:',e.code||e.name));
  client.on('clientReady',safe(async()=>{
    const g=guild(); seedVoice();
    await g.commands.set([
      {name:'Report message',type:ApplicationCommandType.Message},
      {name:'stats',description:'Your activity statistics'},
      {name:'report',description:'Send a private report to staff',options:[{name:'details',description:'What happened?',type:3,required:true,max_length:1000}]},
      {name:'appeal',description:'Appeal a moderation case',options:[{name:'case',description:'Case number',type:4,required:true},{name:'reason',description:'Why should staff reconsider?',type:3,required:true,max_length:1000}]},
      {name:'ticket',description:'Open a private support ticket',options:[{name:'subject',description:'What do you need help with?',type:3,required:true,max_length:500}]},
      {name:'role',description:'Toggle an approved self-service role',options:[{name:'role',description:'Role to toggle',type:8,required:true}]},
      {name:'manage',description:'Moderate a member',default_member_permissions:String(P.ManageGuild),options:[{name:'action',description:'Action',type:3,required:true,choices:['warn','timeout','untimeout','kick','ban','note'].map(v=>({name:v,value:v}))},{name:'member',description:'Member',type:6,required:true},{name:'reason',description:'Reason',type:3,required:true,min_length:3,max_length:1000},{name:'minutes',description:'Timeout duration',type:4,min_value:1,max_value:40320}]},
      {name:'cases',description:'View member moderation history',default_member_permissions:String(P.ManageGuild),options:[{name:'member',description:'Member',type:6,required:true}]}
    ]);
    await log('Bot connected',{note:'Tracking is live. No message text is stored for activity statistics.'});
  }));
  client.on('interactionCreate',safe(async i=>{
    if(i.guildId!==config.guildId)return;
    if(!i.isChatInputCommand()&&!i.isMessageContextMenuCommand()&&!i.isStringSelectMenu())return;
    await i.deferReply({flags:MessageFlags.Ephemeral});
    try {
      if(!store.once(`interaction:${i.id}`))return await i.editReply('This request was already processed.');
      let output='Done.';
      if(i.isStringSelectMenu()&&i.customId==='selfrole') await role(i.user.id,i.values[0]);
      else if(i.commandName==='Report message') { const m=i.targetMessage; const r=await report(i.user.id,{message:m.url,author:m.author.id,details:'Reported using the message context menu'}); output=`Report #${r.id} sent to staff.`; }
      else if(i.commandName==='report') { const r=await report(i.user.id,{details:i.options.getString('details')}); output=`Report #${r.id} sent to staff.`; }
      else if(i.commandName==='appeal') { const c=store.get(i.options.getInteger('case')); if(c?.kind!=='case'||c.user_id!==i.user.id)throw new Error('Case not found.'); const r=await report(i.user.id,{case:c.id,reason:i.options.getString('reason')},'appeal'); output=`Appeal #${r.id} submitted.`; }
      else if(i.commandName==='ticket') { const r=await ticket(i.user.id,i.options.getString('subject')); output=`Ticket #${r.id}: <#${r.data.channel}>`; }
      else if(i.commandName==='role') await role(i.user.id,i.options.getRole('role').id);
      else if(i.commandName==='manage') { const r=await moderate(i.user.id,{type:i.options.getString('action'),user:i.options.getUser('member').id,reason:i.options.getString('reason'),minutes:i.options.getInteger('minutes')||60}); output=`Case #${r.id}: ${r.status}`; }
      else if(i.commandName==='cases') { await actor(i.user.id); const rows=store.list('case',10000).filter(r=>r.user_id===i.options.getUser('member').id); output=rows.slice(0,10).map(r=>`#${r.id} ${r.data.type}: ${r.data.reason}`).join('\n')||'No recorded cases.'; }
      else if(i.commandName==='stats') { const s=store.stats(30,i.user.id); output=`Your last 30 days: ${s.messages} messages; ${(s.voiceSeconds/3600).toFixed(1)} voice hours. Activity is counted only in eligible public channels while the bot is connected.`; }
      await i.editReply({content:output.slice(0,1950),allowedMentions:{parse:[]}});
    } catch(e) { await i.editReply({content:e.message.slice(0,1900),allowedMentions:{parse:[]}}); }
  }));
  let ticking=false;
  async function tick() {
    if(ticking||!client.isReady())return; ticking=true;
    try {
      flushVoice(); const now=Date.now(), s=store.settings();
      for(const r of store.list('job',10000).filter(r=>r.status==='scheduled'&&r.data.at<=now)) {
        store.update(r.id,'sending',r.data);
        try { const a=await actor(r.actor_id); requirePermission(a,P.ManageMessages); await (await channel(r.data.channel)).send({content:r.data.content,allowedMentions:{parse:[]}}); store.update(r.id,'sent',r.data); }
        catch(e) {store.update(r.id,'failed',{...r.data,error:e.message});}
      }
      const today=new Date().toISOString().slice(0,10);
      const last=store.db.prepare('SELECT value FROM meta WHERE key=?').get('digest_date')?.value;
      if(s.digestChannel&&new Date().getUTCDay()===s.digestDay&&last!==today) {
        const st=store.stats(7); await (await channel(s.digestChannel)).send(`Weekly server digest (UTC)\n${st.activeMembers} active members · ${st.messages} messages · ${(st.voiceSeconds/3600).toFixed(1)} voice hours\n${st.joins} joins · ${st.leaves} leaves\n${store.list('report',10000).filter(r=>!['resolved','dismissed'].includes(r.status)).length} open reports`);
        store.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('digest_date',today);
      }
      if(s.reminders) for(const r of store.list('ticket',10000).filter(r=>!['resolved','dismissed','failed','creating'].includes(r.status)&&now-r.updated>48*3600000&&!r.data.reminded)) { await notify(`Ticket #${r.id} has waited 48 hours without a staff update.`); store.update(r.id,r.status,{...r.data,reminded:true}); }
      store.cleanup();
      await integrations.tick();
    } finally { ticking=false; }
  }
  const timer=setInterval(safe(tick),60000); timer.unref();
  return {client,guild,actor,moderate,manageRecord,ticket,transcript,role,rolePanel,incident,restore,audit,log,channel,report, tick,integrations,
    start:()=>client.login(config.token), close:()=>{clearInterval(timer);flushVoice();client.destroy();},
    async reference(){const g=guild();await g.channels.fetch();await g.roles.fetch();return {name:g.name,id:g.id,memberCount:g.memberCount,channels:g.channels.cache.map(c=>({id:c.id,name:c.name,type:c.type,private:!c.permissionsFor(g.roles.everyone)?.has(P.ViewChannel)})),roles:g.roles.cache.map(r=>({id:r.id,name:r.name,selfServiceSafe:!r.managed&&r.id!==g.id&&r.permissions.bitfield===0n&&!g.channels.cache.some(c=>(c.permissionOverwrites?.cache.get(r.id)?.allow.bitfield||0n)!==0n)}))};}
  };
}

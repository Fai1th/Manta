import { z } from 'zod';
export const snowflake = z.string().regex(/^\d{17,20}$/,'Enter a Discord ID (17–20 digits)');
const optionalId = z.union([snowflake,z.literal('')]);
export const reason = z.string().trim().min(3).max(1000);
export const settingsSchema = z.object({ logChannel:optionalId, welcomeChannel:optionalId, ticketCategory:optionalId, supportRole:optionalId, digestChannel:optionalId, digestDay:z.number().int().min(0).max(6), excludedChannels:z.array(snowflake).max(100), selfRoles:z.array(snowflake).max(25), onboardingText:z.string().min(1).max(1500), reminders:z.boolean(), retentionDays:z.number().int().min(30).max(365), joinAlertCount:z.number().int().min(3).max(100), joinAlertMinutes:z.number().int().min(1).max(60) }).strict();
export const actionSchema = z.object({ type:z.enum(['warn','timeout','untimeout','kick','ban','unban','note']), user:snowflake, reason, minutes:z.number().int().min(1).max(40320).default(60), evidence:z.string().url().regex(/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/).optional() }).strict();
export const jobSchema = z.object({ channel:snowflake, content:z.string().trim().min(1).max(1900), at:z.number().int().refine(v=>v>Date.now()+1000 && v<Date.now()+365*86400000,'Choose a future date within one year') }).strict();
export function canManage(member, guild) { return member.id===guild.ownerId || member.permissions.has('Administrator') || member.permissions.has('ManageGuild'); }
export function checkHierarchy(actor, target, guild) {
  if(target.id===actor.id || target.id===guild.ownerId || target.user?.bot) throw new Error('You cannot moderate yourself, the owner, or a bot.');
  if(actor.id!==guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest)<=0) throw new Error('Your role must be above the target member.');
}

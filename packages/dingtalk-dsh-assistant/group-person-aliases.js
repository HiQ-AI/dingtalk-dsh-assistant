import { z } from 'zod'

// Confirmed group-local identities, maintained through the existing group config API.
// Identity facts help interpret addressing; they never confer ownership or authority.
export const personAliasesSchema = z.array(z.object({
  alias: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(80),
}).strict()).max(32)
  .refine(items => new Set(items.map(item => item.alias)).size === items.length, 'group_person_alias_duplicate')
  .refine(items => Buffer.byteLength(JSON.stringify(items), 'utf8') <= 2048, 'group_person_alias_context_too_large')

export function referencedPersonAliases(group, messages) {
  const texts = messages.flatMap(message => [message.text, message.content, message._sourceMessageText, message.quotedMessage?.content]).filter(text => typeof text === 'string')
  return (group.personAliases ?? []).filter(person => texts.some(text => text.includes(person.alias)))
}

export const personAliasInstructions = 'personAliases 是本群已确认的人员别名与组织姓名映射，只用于解释当前原文或引用中命中的称呼，不是助手别名、派工或操作授权。结合正文点名、原生 @、引用、近期上下文及已有任务判断：引用某人信息、通知收件人、明确指定负责人和同时请求本助手参与是不同语义。仅提到人名不等于指定负责人；身份歧义不得按相似字或助手昵称自动承接，也不得猜测未提供的人际关系。'

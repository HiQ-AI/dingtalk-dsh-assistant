import { executionError } from './execution-artifacts.js'
export const authorizationTool = 'execution_request_authorization'
const gates = { 'task-production-release': 'execute-approval-gate', 'task-data-change': 'approval-gate', 'task-data-change-approval-resume': 'approval-gate' }
export const isAuthorizationSession = node => node.authorizationNode === true && node.executor === 'agent'
  && node.allowedTools?.includes(authorizationTool) && typeof node.authorizationExecute === 'function'
export function withAuthorizationSessions(workflow, model) {
  const gate = gates[workflow.id]
  if (!gate || !workflow.nodes.some(node => node.id === gate)) return workflow
  if (!model?.provider || !model?.model) throw executionError('AUTHORIZATION_SESSION_MODEL_REQUIRED')
  return { ...workflow, version: workflow.version + '-authorization-session', nodes: workflow.nodes.map(node => node.id !== gate ? node : {
    ...node, executor: 'agent', execute: undefined, authorizationNode: true, authorizationExecute: node.execute,
    provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    allowedTools: [authorizationTool], prompt: 'You are the execution session for this visible business authorization step. Read the original task instructions and actual prepared action. Decide whether business authorization is needed and explain your reasoning. Initiate an application only by calling execution_request_authorization with that reasoning; the orchestrator does not initiate it. Never claim a user approved an action yourself. Submit only the actual result returned by that tool. A missing or pending result is not approval. Respect existing scope and external tool safety checks.',
  }) }
}

import { createDeveloperMessage } from '@deepseek-ai/dsh-llm'

// alpha.2 derives no model message from an empty developer node. Replace only
// the Host-owned node: tool evidence and the append-only original stay intact.
// Call from agent/request: JSONL replay requires an open turn and step, and the
// new inbox input has not yet entered the surface at this public SDK boundary.
export function retireHostContext(session, event, { turn, step }) {
  session.append('developer/message', { turn, step, message: createDeveloperMessage({
    source: { kind: 'dingtalk-host-context', form: 'snapshot', sections: [] }, content: [],
  }) }, { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] })
}

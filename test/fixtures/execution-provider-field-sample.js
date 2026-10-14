// Anonymous field evidence: preserve native error text/shape only. IDs replaced.
// phase/status are NOT raw upstream fields; the plugin derives them.
export const fieldV12Error = Object.freeze({ code: 'PI_AI_ERROR', message: `Codex error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 00000000-0000-4000-8000-000000000012 in your message.
[Codex diagnostics: {"clientRequestId":"00000000-0000-4000-8000-000000000013","httpStatus":200}]` })
export const fieldV12NativeEnd = Object.freeze({ seq: 1247, time: 1791988575954, type: 'turn/end',
  data: { turn: 12, reason: { kind: 'error', error: fieldV12Error } } })

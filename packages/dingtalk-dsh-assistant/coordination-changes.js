const fail = code => { throw Object.assign(new Error(code), { code }) }

/** Source offsets refer to the immutable source-unit original (UTF-16 indices),
 * never to the candidate summary or a subsequently regenerated task directory. */
export function freezeCoordinationSourceOrder(entries, source, members, pending) {
  if (entries === undefined) return undefined
  if (!Array.isArray(entries) || entries.length !== members.length + pending.length || entries.length > 200)
    fail('COORDINATION_SOURCE_ORDER_INVALID')
  const targets = new Set(), result = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('COORDINATION_SOURCE_ORDER_INVALID')
    const {ordinal,start,end,quote,memberIndex,clarificationId} = entry
    if (!Number.isSafeInteger(ordinal) || ordinal < 1 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end <= start || end > source.original.length || typeof quote !== 'string' || source.original.slice(start,end) !== quote
      || (memberIndex !== undefined) === (clarificationId !== undefined)) fail('COORDINATION_SOURCE_ORDER_INVALID')
    const member = memberIndex === undefined ? null : members[memberIndex]
    if (memberIndex !== undefined && (!Number.isSafeInteger(memberIndex) || memberIndex < 0 || !member)
      || clarificationId !== undefined && !pending.some(item => item.clarificationId === clarificationId)) fail('COORDINATION_SOURCE_ORDER_INVALID')
    const target = member ? `member:${member.id ?? member.instructionId}` : `pending:${clarificationId}`
    if (targets.has(target)) fail('COORDINATION_SOURCE_ORDER_INVALID')
    targets.add(target)
    result.push({ordinal,start,end,quote,coordinateSpace:'source-unit-original:utf16',sourceId:source.id,unitId:source.unitId,unitRevision:source.revision,
      ...(source.sourceMessageId ? {sourceMessageId:source.sourceMessageId} : {}),sourceRefs:source.sourceRefs ?? [],
      instructionIds: member ? [member.id ?? member.instructionId] : [], ...(clarificationId ? {clarificationId} : {})})
  }
  result.sort((a,b)=>a.ordinal-b.ordinal)
  if (result.some((entry,index)=>entry.ordinal !== index+1 || index > 0 && entry.start < result[index-1].end))
    fail('COORDINATION_SOURCE_ORDER_INVALID')
  return result
}

/** Select against the persisted original member order, never a current task list. */
export function coordinationOrdinalInstructionIds(state) {
  const members = new Map((state.members ?? []).map(member=>[member.id,member]))
  return state.coordination.memberIds.filter(id=>{
    const member=members.get(id)
    return !member?.recurringOccurrenceId && !member?.templateInstructionId
  })
}

export function selectCoordinationInstructions(state, selectors = []) {
  const ids = state.coordination.memberIds
  if (!Array.isArray(selectors) || selectors.length > 100) fail('COORDINATION_CHANGE_SELECTOR_INVALID')
  const selected = selectors.length ? selectors.map(selector => {
    if (typeof selector?.instructionId === 'string' && Object.keys(selector).length === 1) {
      if (!ids.includes(selector.instructionId)) fail('COORDINATION_CHANGE_MEMBER_MISSING')
      return selector.instructionId
    }
    if (Number.isSafeInteger(selector?.ordinal) && selector.ordinal >= 1 && Object.keys(selector).length === 1) {
      if (state.coordination.sourceOrder) {
        const slot = state.coordination.sourceOrder.find(item => item.ordinal === selector.ordinal)
        if (!slot && state.coordination.sourceOrderAppendGap) fail('COORDINATION_CHANGE_ORDINAL_NEEDS_CLARIFICATION')
        if (!slot) fail('COORDINATION_CHANGE_MEMBER_MISSING')
        if (slot.instructionIds.length !== 1) fail('COORDINATION_CHANGE_ORDINAL_NEEDS_CLARIFICATION')
        const id = slot.instructionIds[0]
        if (!ids.includes(id)) fail('COORDINATION_CHANGE_MEMBER_MISSING')
        return id
      }
      if (state.coordination.hadPartialClarifications || state.coordination.pendingClarifications?.length)
        fail('COORDINATION_CHANGE_ORDINAL_NEEDS_CLARIFICATION')
      const id = coordinationOrdinalInstructionIds(state)[selector.ordinal - 1]
      if (!id) fail('COORDINATION_CHANGE_MEMBER_MISSING')
      return id
    }
    fail('COORDINATION_CHANGE_SELECTOR_INVALID')
  }) : ids
  if (new Set(selected).size !== selected.length) fail('COORDINATION_CHANGE_MEMBER_DUPLICATE')
  return [...selected]
}

/** This proves identity only after a fresh authoritative ledger read; no timeout
 * or absence of an in-memory command is evidence that effects did not happen. */
export function assertCoordinationHandoffProof(reservation, source, expectedFreezeId) {
  const proof = source?.handoffProof
  if (!source?.frozen || source.state !== 'rejected' || source.dispatchOwner !== 'coordination'
    || !proof || proof.kind !== 'coordination.no-commands' || proof.dynamicSourceId !== source.id
    || proof.reservationId !== reservation.reservationId || proof.generation !== reservation.generation
    || source.reservationGeneration !== reservation.generation || proof.unitId !== reservation.unitId
    || proof.unitRevision !== reservation.unitRevision || proof.freezeId !== expectedFreezeId
    || proof.commandCount !== 0 || proof.unknownCount !== 0 || !Number.isFinite(Date.parse(proof.checkedAt))) fail('COORDINATION_HANDOFF_UNSAFE')
  return proof
}

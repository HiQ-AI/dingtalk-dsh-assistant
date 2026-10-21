const fail = code => { throw Object.assign(new Error(code), { code }) }

/** Select against the persisted original member order, never a current task list. */
export function selectCoordinationInstructions(state, selectors = []) {
  const ids = state.coordination.memberIds
  if (!Array.isArray(selectors) || selectors.length > 100) fail('COORDINATION_CHANGE_SELECTOR_INVALID')
  const selected = selectors.length ? selectors.map(selector => {
    if (typeof selector?.instructionId === 'string' && Object.keys(selector).length === 1) {
      if (!ids.includes(selector.instructionId)) fail('COORDINATION_CHANGE_MEMBER_MISSING')
      return selector.instructionId
    }
    if (Number.isSafeInteger(selector?.ordinal) && selector.ordinal >= 1 && Object.keys(selector).length === 1) {
      const id = ids[selector.ordinal - 1]
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

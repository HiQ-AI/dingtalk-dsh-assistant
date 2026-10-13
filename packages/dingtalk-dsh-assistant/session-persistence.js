// Read-only handles do not claim the resident Agent's write ownership.
// Always close them, including when validation or storage reads fail.
export async function inspectSession(persistence, sessionId, options) {
  const handle = await persistence.open(sessionId, 'read', options)
  try {
    const { events } = await handle.read(undefined, undefined, options)
    return { meta: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
  } finally {
    await handle.close()
  }
}

export function inboxHasPending(inbox) {
  return inbox.nextTurn.length > 0 || inbox.nextStep.length > 0
}

/**
 * A synchronous caller may omit an expected owner to request ordinary global
 * deactivation. Asynchronous callers must pass the captured session ID; null
 * means no editor belonged to that earlier transition.
 */
export function textEditDeactivationOwnsSession(activeSessionId, expectedSessionId) {
  if (expectedSessionId === undefined) return true;
  return (activeSessionId == null ? null : String(activeSessionId))
    === (expectedSessionId == null ? null : String(expectedSessionId));
}

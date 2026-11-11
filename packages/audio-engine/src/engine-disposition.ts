// What an engine runtime did with one request, so a caller never counts a request as installed that was not.
//   applied    the request changed the engine
//   joined     an equal request was already in flight; this caller shares its outcome, failure included
//   skipped    the engine already holds the request and its resources are healthy
//   superseded a newer request replaced this one before it could commit; it installed nothing
//   dropped    nothing was installed and no newer request replaced it (no AudioContext, or the worklet budget refused it)
export type EngineDisposition = 'applied' | 'joined' | 'skipped' | 'superseded' | 'dropped'
